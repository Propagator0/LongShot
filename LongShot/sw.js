// LongShot service worker. Owns the debugger sessions, runs the capture
// engines, hands image segments to the offscreen document for stitching,
// and saves the result.

import { getSettings, MIME, EXT } from './shared/settings.js';
import {
  pageProbe, pageScrollTo, pagePreload, pagePrep, pageHideFixed, pageRestore, pageToast,
} from './shared/page.js';

const SEG_DEVICE_PX = 4096;     // max height of one render segment, in device pixels
const MAX_UNFOLD_CSS = 60000;   // inner-scroller pages taller than this go to stitch mode
const PRELOAD_MS = 8000;

const attached = new Set();     // tabs with our debugger attached
const railTabs = new Set();     // tabs with an open rail
const busy = new Set();         // tabs mid-capture
const blobDownloads = new Map(); // downloadId -> blob URL living in the offscreen doc

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// ---------- debugger ----------

async function attach(tabId) {
  if (attached.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // After a service-worker restart our own session may still be live.
    if (!/already attached/i.test(e.message)) throw e;
    attached.add(tabId);
    return false;
  }
  attached.add(tabId);
  return true;
}

async function detach(tabId) {
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function evalIn(tabId, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Page script failed');
  }
  return r.result.value;
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  // Usually means the user hit Cancel on the debugging bar.
  if (railTabs.has(tabId) && !busy.has(tabId)) {
    railTabs.delete(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'rail-close' }).catch(() => {});
  }
});

// ---------- offscreen document (stitching, encoding, blob URLs) ----------

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return;
  } else if (await chrome.offscreen.hasDocument?.()) {
    return;
  }
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Stitch screenshot segments and hold the finished image while it downloads.',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function off(msg) {
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!r) throw new Error('Stitcher did not respond');
  if (r.error) throw new Error(r.error);
  return r;
}

async function newJob() {
  await ensureOffscreen();
  const jobId = crypto.randomUUID();
  await off({ type: 'job-begin', jobId });
  return jobId;
}

// ---------- engine 1: render (one tall pass, beyond the viewport) ----------
// Returns null when the page can't be unfolded; the caller falls back to stitch.

async function renderEngine(tabId, probe, range, s, jobId) {
  let p = probe;
  if (!range && s.preload) {
    await evalIn(tabId, pagePreload, PRELOAD_MS);
    p = await evalIn(tabId, pageProbe);
  }
  await evalIn(tabId, pagePrep);
  await evalIn(tabId, pageScrollTo, 0, 60);

  if (p.inner) {
    // App-shell layout: make the viewport tall enough that the inner
    // scroller stops scrolling and lays out at full height.
    if (p.extra > MAX_UNFOLD_CSS) return null;
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: p.vw, height: p.vh + p.extra, deviceScaleFactor: 0, mobile: false,
    });
    await sleep(350);
    const q = await evalIn(tabId, pageProbe);
    if (q.inner && q.extra > 4) {
      await cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
      await evalIn(tabId, pageProbe); // re-mark the scroller for stitch mode
      return null;
    }
  }

  const m = await cdp(tabId, 'Page.getLayoutMetrics');
  const content = m.cssContentSize || m.contentSize;
  const lv = m.cssLayoutViewport || m.layoutViewport;
  const width = Math.max(1, Math.floor(lv.clientWidth));
  const pageH = Math.max(1, Math.ceil(content.height));

  let y0 = 0, y1 = pageH;
  if (range) {
    const offset = p.inner ? p.docTop : 0;
    y0 = clamp(Math.floor(offset + range.top), 0, pageH - 1);
    y1 = clamp(Math.ceil(offset + range.bottom), y0 + 1, pageH);
  }

  const scale = s.resolution === '1x' ? 1 / p.dpr : 1;
  const pxPerCss = p.dpr * scale;
  // Multiples of 8 CSS px keep segment edges on whole device pixels at 1.25x, 1.5x, 1.75x.
  const seg = Math.max(8, Math.floor(SEG_DEVICE_PX / pxPerCss / 8) * 8);

  for (let y = y0; y < y1; y += seg) {
    const h = Math.min(seg, y1 - y);
    const { data } = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y, width, height: h, scale },
    });
    await off({ type: 'job-add', jobId, data });
  }
  return { outScale: 1 };
}

// ---------- engine 2: stitch (scroll screen by screen) ----------
// Slower, but works on feeds and virtual lists that unload what's off-screen.

async function stitchEngine(tabId, probe, range, s, jobId) {
  await evalIn(tabId, pagePrep);
  const { dpr, frame: f } = probe;
  const y0 = range ? Math.max(0, Math.floor(range.top)) : 0;
  const y1 = range ? Math.min(probe.scrollHeight, Math.ceil(range.bottom)) : probe.scrollHeight;
  const dev = (v) => Math.round(v * dpr);

  let row = y0, first = true, guard = 0;
  while (row < y1 && guard++ < 4000) {
    const actual = await evalIn(tabId, pageScrollTo, row, s.stepDelay);
    const start = Math.max(row, actual);
    const end = Math.min(y1, actual + f.height);
    if (end <= start) break;
    const { data } = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
    await off({
      type: 'job-add', jobId, data,
      crop: {
        sx: dev(f.left), sy: dev(f.top + start - actual), sw: dev(f.width),
        sh: dev(end - y0) - dev(start - y0),
      },
      dy: dev(start - y0),
    });
    row = end;
    if (first) { first = false; await evalIn(tabId, pageHideFixed); }
  }
  return { outScale: s.resolution === '1x' ? 1 / dpr : 1 };
}

// ---------- saving ----------

function fileBase(url) {
  let host = 'page';
  try { host = new URL(url).hostname.replace(/^www\./, '') || 'page'; } catch { /* keep default */ }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${host}_${stamp}`.replace(/[^\w.-]+/g, '_');
}

function folderPrefix(s) {
  const clean = String(s.folder || '').replace(/\\/g, '/').split('/')
    .map((x) => x.trim().replace(/[<>:"|?*\u0000-\u001f]+/g, '_'))
    .filter((x) => x && x !== '.' && x !== '..')
    .join('/');
  return clean ? `${clean}/` : '';
}

async function download(url, filename, saveAs) {
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
    blobDownloads.set(id, url);
    return id;
  } catch (e) {
    // Fallback if this browser refuses the blob URL: hand over a data URL instead.
    const { dataUrl } = await off({ type: 'data-url', url });
    const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs, conflictAction: 'uniquify' });
    off({ type: 'revoke', url }).catch(() => {});
    return id;
  }
}

chrome.downloads.onChanged.addListener((d) => {
  const state = d.state?.current;
  if ((state === 'complete' || state === 'interrupted') && blobDownloads.has(d.id)) {
    off({ type: 'revoke', url: blobDownloads.get(d.id) }).catch(() => {});
    blobDownloads.delete(d.id);
  }
});

async function finishAndSave(jobId, tab, s, outScale) {
  const res = await off({
    type: 'job-finish', jobId, mime: MIME[s.format], quality: s.quality, scale: outScale,
  });
  const base = folderPrefix(s) + fileBase(tab.url);
  const n = res.parts.length;
  for (let k = 0; k < n; k++) {
    const suffix = n > 1 ? `_${k + 1}-of-${n}` : '';
    await download(res.parts[k].url, `${base}${suffix}.${EXT[s.format]}`, s.saveAs);
  }
  return { width: res.width, height: res.height, ext: EXT[s.format], parts: n };
}

// ---------- feedback ----------

async function setBadge(tabId, text, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: text === '!' ? '#C8102E' : '#FFB000' });
    chrome.action.setBadgeTextColor?.({ tabId, color: text === '!' ? '#FFFFFF' : '#000000' });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title: title ? `LongShot: ${title}` : 'LongShot' });
  } catch { /* tab closed */ }
}

async function report(tabId, outcome) {
  const text = outcome.error
    ? `Capture failed: ${outcome.error.message}`
    : `Saved ${fmt(outcome.width)} × ${fmt(outcome.height)} ${outcome.ext.toUpperCase()}`
      + (outcome.parts > 1 ? `, split into ${outcome.parts} files (format size limit)` : '');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageToast, args: [text, outcome.error ? 'error' : 'ok'] });
  } catch {
    if (outcome.error) await setBadge(tabId, '!', outcome.error.message);
  }
}

// ---------- the three modes ----------

async function capturePage(tabId, range = null) {
  if (busy.has(tabId)) return;
  busy.add(tabId);
  const s = await getSettings();
  let probe = null, jobId = null, outcome;
  try {
    await setBadge(tabId, 'REC');
    const tab = await chrome.tabs.get(tabId);
    const fresh = await attach(tabId);
    if (fresh) await sleep(300); // let the debugging bar push the layout before measuring
    probe = await evalIn(tabId, pageProbe);
    jobId = await newJob();
    let job = null;
    if (s.method === 'render') job = await renderEngine(tabId, probe, range, s, jobId);
    if (!job) {
      await off({ type: 'job-reset', jobId });
      job = await stitchEngine(tabId, probe, range, s, jobId);
    }
    outcome = await finishAndSave(jobId, tab, s, job.outScale);
    jobId = null;
  } catch (e) {
    outcome = { error: e };
    if (jobId) off({ type: 'job-abort', jobId }).catch(() => {});
  } finally {
    await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    if (probe) await evalIn(tabId, pageRestore, probe).catch(() => {});
    await detach(tabId);
    railTabs.delete(tabId);
    busy.delete(tabId);
    await setBadge(tabId, outcome?.error ? '!' : '', outcome?.error?.message);
  }
  await report(tabId, outcome);
}

async function captureVisible(tab) {
  if (busy.has(tab.id)) return;
  busy.add(tab.id);
  const s = await getSettings();
  let outcome;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const jobId = await newJob();
    await off({ type: 'job-add', jobId, data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    outcome = await finishAndSave(jobId, tab, s, 1);
  } catch (e) {
    outcome = { error: e };
  } finally {
    busy.delete(tab.id);
  }
  await report(tab.id, outcome);
}

async function openRail(tab) {
  const tabId = tab.id;
  if (busy.has(tabId)) return;
  if (railTabs.has(tabId)) {
    // Second press closes it.
    try { await chrome.tabs.sendMessage(tabId, { type: 'rail-close' }); return; } catch { await endRail(tabId); }
  }
  const s = await getSettings();
  await attach(tabId); // the debugging bar appears now, not mid-shot
  railTabs.add(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/rail.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'rail-open', settings: s });
}

async function endRail(tabId) {
  railTabs.delete(tabId);
  if (!busy.has(tabId)) await detach(tabId);
}

// ---------- entry points ----------

const RESTRICTED = /^(chrome|brave|edge|about|devtools|view-source|chrome-extension|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

async function dispatch(mode, tab) {
  if (!tab?.id) return;
  if (tab.url && RESTRICTED.test(tab.url)) {
    await setBadge(tab.id, '!', 'browser pages and the Web Store cannot be captured');
    return;
  }
  try {
    if (mode === 'page') await capturePage(tab.id);
    else if (mode === 'visible') await captureVisible(tab);
    else if (mode === 'rail') await openRail(tab);
  } catch (e) {
    railTabs.delete(tab.id);
    await detach(tab.id);
    await setBadge(tab.id, '!', e.message);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  dispatch(command.replace('shoot-', ''), tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === 'offscreen') return;

  if (msg.type === 'shoot') {
    chrome.tabs.get(msg.tabId).then((tab) => dispatch(msg.mode, tab));
    reply({ ok: true });
    return;
  }
  if (msg.type === 'rail-shoot' && sender.tab) {
    capturePage(sender.tab.id, msg.region).then(() => reply({ ok: true }));
    return true; // reply after the capture finishes
  }
  if (msg.type === 'rail-ended' && sender.tab) {
    endRail(sender.tab.id);
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && railTabs.has(tabId) && !busy.has(tabId)) endRail(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId); railTabs.delete(tabId); busy.delete(tabId);
});
