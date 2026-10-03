import { getSettings, setSettings } from '../shared/settings.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const RESTRICTED = /^(chrome|brave|edge|about|devtools|view-source|chrome-extension|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

const METHOD_TEXT = {
  render: 'Lays the page out tall and shoots it in one pass. Cleanest result; fixed headers appear once.',
  stitch: 'Scrolls screen by screen and joins the frames. Use it for feeds and infinite lists that unload what scrolls away.',
};

let tab = null;

async function shoot(mode) {
  if (!tab || $(`.mode[data-mode="${mode}"]`).disabled) return;
  await chrome.runtime.sendMessage({ type: 'shoot', mode, tabId: tab.id });
  window.close();
}

function radio(name, value) {
  const el = $(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function showQuality(format) {
  $('#qualityRow').hidden = format === 'png';
}

async function init() {
  const s = await getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.url && RESTRICTED.test(tab.url)) {
    $('#notice').hidden = false;
    $$('.mode').forEach((b) => { b.disabled = true; });
  }

  // Shortcuts as actually bound, not as suggested.
  const cmds = await chrome.commands.getAll();
  for (const c of cmds) {
    const kbd = $(`kbd[data-cmd="${c.name}"]`);
    if (kbd) kbd.textContent = c.shortcut || 'unset';
  }

  radio('format', s.format);
  radio('method', s.method);
  radio('resolution', s.resolution);
  showQuality(s.format);
  $('#methodExplain').textContent = METHOD_TEXT[s.method];
  $('#nativeLabel').textContent = `Screen ${+(window.devicePixelRatio || 1).toFixed(2)}×`;

  $('#quality').value = Math.round(s.quality * 100);
  $('#qualityOut').value = `${Math.round(s.quality * 100)}`;
  $('#preload').checked = s.preload;
  $('#dwell').value = s.dwellMs;
  $('#dwellOut').value = `${(s.dwellMs / 1000).toFixed(1)} s`;
  $('#opacity').value = Math.round(s.railOpacity * 100);
  $('#opacityOut').value = `${Math.round(s.railOpacity * 100)}%`;
  $('#saveAs').checked = s.saveAs;
  $('#folder').value = s.folder;

  $$('.mode').forEach((b) => b.addEventListener('click', () => shoot(b.dataset.mode)));

  $$('input[name="format"]').forEach((r) => r.addEventListener('change', () => {
    showQuality(r.value);
    setSettings({ format: r.value });
  }));
  $$('input[name="method"]').forEach((r) => r.addEventListener('change', () => {
    $('#methodExplain').textContent = METHOD_TEXT[r.value];
    setSettings({ method: r.value });
  }));
  $$('input[name="resolution"]').forEach((r) => r.addEventListener('change', () => setSettings({ resolution: r.value })));

  $('#quality').addEventListener('input', (e) => {
    $('#qualityOut').value = e.target.value;
    setSettings({ quality: Number(e.target.value) / 100 });
  });
  $('#preload').addEventListener('change', (e) => setSettings({ preload: e.target.checked }));
  $('#dwell').addEventListener('input', (e) => {
    $('#dwellOut').value = `${(Number(e.target.value) / 1000).toFixed(1)} s`;
    setSettings({ dwellMs: Number(e.target.value) });
  });
  $('#opacity').addEventListener('input', (e) => {
    $('#opacityOut').value = `${e.target.value}%`;
    setSettings({ railOpacity: Number(e.target.value) / 100 });
  });
  $('#saveAs').addEventListener('change', (e) => setSettings({ saveAs: e.target.checked }));
  $('#folder').addEventListener('change', (e) => setSettings({ folder: e.target.value.trim() }));

  $('#shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });

  // F, R, V shoot straight from the popup.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const mode = { f: 'page', r: 'rail', v: 'visible' }[e.key.toLowerCase()];
    if (mode) { e.preventDefault(); shoot(mode); }
  });
}

init();
