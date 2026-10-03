// Functions that run INSIDE the captured page (via Runtime.evaluate or
// scripting.executeScript). Each one is serialized with toString(), so it
// must be fully self-contained: no imports, no module-level helpers.

// Measure the page and decide what scrolls. Most pages scroll the document;
// app-style layouts (height: 100vh; overflow: auto on an inner div) scroll an
// element instead. That element gets marked so later calls find it.
export function pageProbe() {
  const se = document.scrollingElement || document.documentElement;
  const de = document.documentElement;
  const std = document.compatMode === 'CSS1Compat';
  const vw = window.innerWidth, vh = window.innerHeight;
  const clientW = std ? de.clientWidth : vw;
  const clientH = std ? de.clientHeight : vh;

  document.querySelectorAll('[data-longshot-scroller]')
    .forEach((e) => e.removeAttribute('data-longshot-scroller'));

  let el = null;
  if (se.scrollHeight <= clientH + 2) {
    let best = 2;
    for (const c of document.querySelectorAll('body *')) {
      const extra = c.scrollHeight - c.clientHeight;
      if (extra <= best || c.clientHeight < clientH * 0.4) continue;
      if (c.closest('[data-longshot-ui]')) continue;
      const oy = getComputedStyle(c).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      el = c; best = extra;
    }
  }

  const base = { dpr: window.devicePixelRatio || 1, vw, vh, winX: window.scrollX, winY: window.scrollY };
  if (el) {
    el.setAttribute('data-longshot-scroller', '');
    const r = el.getBoundingClientRect();
    return {
      ...base, inner: true,
      scrollTop: el.scrollTop, scrollHeight: el.scrollHeight,
      extra: el.scrollHeight - el.clientHeight,
      docTop: r.top + el.clientTop + window.scrollY,
      frame: { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight },
    };
  }
  return {
    ...base, inner: false,
    scrollTop: window.scrollY, scrollHeight: se.scrollHeight, extra: 0, docTop: 0,
    frame: { left: 0, top: 0, width: clientW, height: clientH },
  };
}

// Scroll the marked scroller (or the window) and wait for paint.
// Returns the scroll position the page actually landed on.
export async function pageScrollTo(y, delay = 0) {
  const el = document.querySelector('[data-longshot-scroller]');
  if (el) el.scrollTo({ top: y, behavior: 'instant' });
  else window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' });
  // rAF stalls in background tabs, so the timeout is the safety net.
  await new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 120);
  });
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return el ? el.scrollTop : window.scrollY;
}

// Walk the page once so lazy-loaded images and sections exist before the
// render pass. Capped by time so infinite feeds can't hold it forever.
export async function pagePreload(maxMs) {
  const el = document.querySelector('[data-longshot-scroller]');
  const se = document.scrollingElement || document.documentElement;
  const view = () => (el ? el.clientHeight : window.innerHeight);
  const height = () => (el ? el.scrollHeight : se.scrollHeight);
  const go = (y) => (el
    ? el.scrollTo({ top: y, behavior: 'instant' })
    : window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const t0 = performance.now();
  let y = 0;
  go(0); await wait(60);
  while (performance.now() - t0 < maxMs) {
    y += Math.max(200, view() * 0.85);
    go(y); await wait(120);
    if (y >= height() - view()) {
      await wait(300);
      if (y >= height() - view()) break;
    }
  }
  const pending = Array.from(document.images).filter((i) => !i.complete);
  if (pending.length) {
    await Promise.race([Promise.allSettled(pending.map((i) => i.decode())), wait(2000)]);
  }
  go(0); await wait(100);
  return height();
}

// Switch off scroll snapping and smooth scrolling for the duration.
export function pagePrep() {
  if (window.__longshotPrep) return true;
  const els = [document.documentElement, document.body, document.querySelector('[data-longshot-scroller]')]
    .filter(Boolean);
  window.__longshotPrep = els.map((el) => [
    el,
    el.style.getPropertyValue('scroll-snap-type'), el.style.getPropertyPriority('scroll-snap-type'),
    el.style.getPropertyValue('scroll-behavior'), el.style.getPropertyPriority('scroll-behavior'),
  ]);
  for (const el of els) {
    el.style.setProperty('scroll-snap-type', 'none', 'important');
    el.style.setProperty('scroll-behavior', 'auto', 'important');
  }
  return true;
}

// Stitch mode: after the first screen, hide fixed and sticky elements so
// headers and cookie bars don't repeat down the whole image.
export function pageHideFixed() {
  const list = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[data-longshot-ui]')) continue;
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    list.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  window.__longshotHidden = (window.__longshotHidden || []).concat(list);
  return list.length;
}

// Put everything back the way the user had it.
export function pageRestore(state) {
  const put = (el, prop, v, p) => (v ? el.style.setProperty(prop, v, p) : el.style.removeProperty(prop));
  for (const [el, v, p] of window.__longshotHidden || []) put(el, 'visibility', v, p);
  window.__longshotHidden = null;
  for (const [el, snap, snapP, beh, behP] of window.__longshotPrep || []) {
    put(el, 'scroll-snap-type', snap, snapP);
    put(el, 'scroll-behavior', beh, behP);
  }
  window.__longshotPrep = null;
  const el = document.querySelector('[data-longshot-scroller]');
  if (el && state && state.inner) el.scrollTo({ top: state.scrollTop, behavior: 'instant' });
  if (state) window.scrollTo({ top: state.winY, left: state.winX, behavior: 'instant' });
  document.querySelectorAll('[data-longshot-scroller]')
    .forEach((e) => e.removeAttribute('data-longshot-scroller'));
  return true;
}

// Small confirmation in the bottom-left corner of the page.
export function pageToast(text, kind) {
  const id = 'longshot-toast';
  const old = document.getElementById(id);
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = id;
  host.setAttribute('data-longshot-ui', '');
  host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  const edge = kind === 'error' ? '#C8102E' : '#1FB57A';
  root.innerHTML = `<style>
    .t{font:500 13px/1.4 "Berkeley Mono","TX-02","JetBrains Mono","IBM Plex Mono","DejaVu Sans Mono",ui-monospace,monospace;
       color:#ECECEC;background:#000;border:1px solid #2A2A2A;border-left:3px solid ${edge};
       padding:9px 12px 9px 10px;max-width:min(480px,80vw);box-shadow:0 8px 28px rgba(0,0,0,.35);
       transition:opacity .3s ease, transform .3s ease}
    .t.out{opacity:0;transform:translateY(6px)}
    @media (prefers-reduced-motion: reduce){.t{transition:none}}
  </style><div class="t" role="status"></div>`;
  const t = root.querySelector('.t');
  t.textContent = text;
  document.documentElement.appendChild(host);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => host.remove(), 3600);
  return true;
}
