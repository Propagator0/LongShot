// LongShot rail. Injected on demand. Draws a bar along the right edge:
// the amber frame is your screen, the green band is what will be captured.
// Drag the frame (or just scroll) to stretch the band; hold still and the
// three triangles fill, then the shot fires. Release, Enter, or the Shoot
// button fires it at once. Esc cancels.

(() => {
  if (window.__longshotRail) return;
  window.__longshotRail = true;

  let current = null;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'rail-open') {
      if (!current) current = mount(msg.settings || {});
      reply({ ok: true });
    } else if (msg?.type === 'rail-close') {
      current?.close();
      reply({ ok: true });
    }
  });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  // Same rule the service worker uses, so both agree on what scrolls.
  function findScroller() {
    const se = document.scrollingElement || document.documentElement;
    const std = document.compatMode === 'CSS1Compat';
    const clientH = std ? document.documentElement.clientHeight : window.innerHeight;
    document.querySelectorAll('[data-longshot-scroller]')
      .forEach((e) => e.removeAttribute('data-longshot-scroller'));
    if (se.scrollHeight > clientH + 2) return null;
    let el = null, best = 2;
    for (const c of document.querySelectorAll('body *')) {
      const extra = c.scrollHeight - c.clientHeight;
      if (extra <= best || c.clientHeight < clientH * 0.4) continue;
      if (c.closest('[data-longshot-ui]')) continue;
      const oy = getComputedStyle(c).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      el = c; best = extra;
    }
    if (el) el.setAttribute('data-longshot-scroller', '');
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui {
      --amber: #FFB000; --green: #1FB57A; --red: #C8102E; --ink: #000; --text: #ECECEC; --dim: #8E8E8E;
      --mono: "Berkeley Mono", "TX-02", "JetBrains Mono", "IBM Plex Mono", "DejaVu Sans Mono", ui-monospace, monospace;
      font-family: var(--mono);
    }
    .rail {
      position: fixed; top: 10px; bottom: 10px; right: 3px; width: 18px;
      pointer-events: auto; cursor: ns-resize; touch-action: none;
      background: rgba(0,0,0,.78); outline: 1px solid rgba(255,255,255,.14);
      opacity: var(--rest); transition: opacity .15s ease;
    }
    .rail:hover, .ui.live .rail { opacity: 1; }
    .track { position: absolute; top: 0; bottom: 0; left: 8px; width: 2px; background: #333; }
    .band { position: absolute; left: 6px; width: 6px; background: var(--green); }
    .thumb {
      position: absolute; left: 1px; right: 1px; min-height: 6px;
      border: 2px solid var(--amber); background: rgba(255,176,0,.12);
    }
    .thumb::before { content: ""; position: absolute; inset: -8px -2px; } /* bigger grab area */

    .chip {
      position: fixed; right: 30px; pointer-events: auto;
      background: var(--ink); color: var(--text); padding: 10px 12px 10px;
      min-width: 236px; font-size: 12px; line-height: 1.45;
      border: 1px solid #2A2A2A; box-shadow: 0 10px 30px rgba(0,0,0,.4);
      opacity: var(--rest); transition: opacity .15s ease;
      background-image:
        linear-gradient(#555,#555), linear-gradient(#555,#555), linear-gradient(#555,#555), linear-gradient(#555,#555),
        linear-gradient(#555,#555), linear-gradient(#555,#555), linear-gradient(#555,#555), linear-gradient(#555,#555);
      background-repeat: no-repeat;
      background-size: 8px 1px, 1px 8px, 8px 1px, 1px 8px, 8px 1px, 1px 8px, 8px 1px, 1px 8px;
      background-position: 4px 4px, 4px 4px, right 4px top 4px, right 4px top 4px,
                           4px bottom 4px, 4px bottom 4px, right 4px bottom 4px, right 4px bottom 4px;
    }
    .chip:hover, .ui.live .chip { opacity: 1; }
    .size { display: flex; align-items: baseline; gap: 10px; }
    .size b { color: var(--amber); font-size: 20px; font-weight: 600; letter-spacing: .01em; }
    .size span { color: var(--dim); }
    .range { color: var(--green); }
    .tri { display: block; width: 54px; height: 16px; margin-left: auto; overflow: visible; }
    .tri path { fill: var(--red); fill-opacity: 0; stroke: var(--red); stroke-width: 2; stroke-linejoin: miter; }
    .hint { color: var(--dim); margin-top: 4px; }
    .btns { display: flex; gap: 6px; margin-top: 9px; }
    button {
      font: inherit; font-size: 12px; color: var(--text); background: transparent;
      border: 1px solid #3A3A3A; padding: 3px 9px; cursor: pointer;
    }
    button:hover { border-color: var(--amber); }
    button:focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
    button.go { color: var(--ink); background: var(--amber); border-color: var(--amber); }
  `;

  function mount(settings) {
    const dwellMs = clamp(Number(settings.dwellMs) || 1200, 300, 5000);
    const rest = clamp(Number(settings.railOpacity) || 0.6, 0.15, 1);

    const scroller = findScroller();
    const se = document.scrollingElement || document.documentElement;
    const target = scroller || window;
    const getTop = () => (scroller ? scroller.scrollTop : window.scrollY);
    const setTop = (y) => (scroller
      ? scroller.scrollTo({ top: y, behavior: 'instant' })
      : window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' }));
    const getView = () => (scroller
      ? scroller.clientHeight
      : (document.compatMode === 'CSS1Compat' ? document.documentElement.clientHeight : window.innerHeight));
    const getHeight = () => Math.max(1, scroller ? scroller.scrollHeight : se.scrollHeight);

    let anchor = getTop();
    let moved = false, dragging = false, shooting = false, closed = false, paused = false;
    let grab = 0, dwellStart = 0, raf = 0;

    const host = document.createElement('div');
    host.setAttribute('data-longshot-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="ui" style="--rest:${rest}">
        <div class="rail" aria-label="Capture length">
          <div class="track"></div>
          <div class="band"></div>
          <div class="thumb"></div>
        </div>
        <div class="chip" role="dialog" aria-label="LongShot rail">
          <div class="size">
            <b class="len">0 px</b>
            <svg class="tri" viewBox="0 0 54 16" aria-hidden="true">
              <path d="M1 15 L8 1 L15 15 Z"/><path d="M20 15 L27 1 L34 15 Z"/><path d="M39 15 L46 1 L53 15 Z"/>
            </svg>
          </div>
          <div class="range"></div>
          <div class="hint">Drag the frame or scroll. Hold still to shoot.</div>
          <div class="btns">
            <button data-act="top" title="Start the capture at the top of the page">From top</button>
            <button data-act="shoot" class="go" title="Enter">Shoot</button>
            <button data-act="cancel" title="Esc">Cancel</button>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const ui = root.querySelector('.ui');
    const rail = root.querySelector('.rail');
    const band = root.querySelector('.band');
    const thumb = root.querySelector('.thumb');
    const chip = root.querySelector('.chip');
    const len = root.querySelector('.len');
    const rangeEl = root.querySelector('.range');
    const tris = Array.from(root.querySelectorAll('.tri path'));

    function region() {
      const t = getTop(), v = getView();
      return { top: Math.min(anchor, t), bottom: Math.min(getHeight(), Math.max(anchor + v, t + v)) };
    }

    function render() {
      if (closed) return;
      const H = getHeight(), v = getView(), t = getTop();
      const trackH = rail.clientHeight;
      const k = trackH / H;
      thumb.style.top = `${t * k}px`;
      thumb.style.height = `${Math.max(6, v * k)}px`;
      const r = region();
      band.style.top = `${r.top * k}px`;
      band.style.height = `${Math.max(2, (r.bottom - r.top) * k)}px`;
      len.textContent = `${fmt(r.bottom - r.top)} px`;
      rangeEl.textContent = `y ${fmt(r.top)} to ${fmt(r.bottom)} of ${fmt(H)}`;
      const railTop = rail.getBoundingClientRect().top;
      const y = railTop + r.bottom * k - chip.offsetHeight / 2;
      chip.style.top = `${clamp(y, 8, window.innerHeight - chip.offsetHeight - 8)}px`;
    }

    function setTriangles(p) {
      tris.forEach((tri, i) => { tri.style.fillOpacity = String(clamp(p * 3 - i, 0, 1)); });
    }

    function stopDwell() { cancelAnimationFrame(raf); raf = 0; setTriangles(0); }
    function restartDwell() {
      stopDwell();
      if (!moved || paused || shooting) return;
      dwellStart = performance.now();
      const tick = () => {
        const p = (performance.now() - dwellStart) / dwellMs;
        setTriangles(p);
        if (p >= 1) shoot(); else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function onScroll() {
      if (!moved && Math.abs(getTop() - anchor) > 4) moved = true;
      render();
      restartDwell();
    }

    function moveTo(clientY) {
      const rr = rail.getBoundingClientRect();
      const H = getHeight();
      const y = ((clientY - rr.top - grab) / rr.height) * H;
      setTop(clamp(y, 0, Math.max(0, H - getView())));
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      const tr = thumb.getBoundingClientRect();
      grab = (e.target === thumb) ? e.clientY - tr.top : tr.height / 2;
      dragging = true;
      ui.classList.add('live');
      rail.setPointerCapture(e.pointerId);
      moveTo(e.clientY);
    }
    function onPointerMove(e) { if (dragging) moveTo(e.clientY); }
    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      ui.classList.remove('live');
      if (moved) shoot();
    }

    function onKey(e) {
      if (shooting) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && !e.isComposing) {
        const a = document.activeElement;
        const typing = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
        if (!typing) { e.preventDefault(); e.stopPropagation(); shoot(); }
      }
    }

    function onChipClick(e) {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'top') { anchor = 0; moved = true; render(); }
      else if (act === 'shoot') shoot();
      else if (act === 'cancel') close();
    }

    // Moving the pointer onto the chip pauses the countdown so the buttons can be reached.
    const onChipEnter = () => { paused = true; stopDwell(); };
    const onChipLeave = () => { paused = false; restartDwell(); };

    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', render);
    window.addEventListener('keydown', onKey, true);
    rail.addEventListener('pointerdown', onPointerDown);
    rail.addEventListener('pointermove', onPointerMove);
    rail.addEventListener('pointerup', onPointerUp);
    rail.addEventListener('pointercancel', onPointerUp);
    chip.addEventListener('click', onChipClick);
    chip.addEventListener('pointerenter', onChipEnter);
    chip.addEventListener('pointerleave', onChipLeave);

    render();
    requestAnimationFrame(render); // chip height is known after first layout

    function teardown() {
      closed = true;
      stopDwell();
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', render);
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      document.querySelectorAll('[data-longshot-scroller]')
        .forEach((e) => e.removeAttribute('data-longshot-scroller'));
      current = null;
    }

    async function shoot() {
      if (shooting || closed) return;
      shooting = true;
      stopDwell();
      const r = region();
      host.style.display = 'none';
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      try {
        await chrome.runtime.sendMessage({
          type: 'rail-shoot',
          region: { top: Math.floor(r.top), bottom: Math.ceil(r.bottom) },
        });
      } catch { /* the service worker reports failures itself */ }
      teardown();
    }

    function close() {
      if (closed || shooting) return;
      teardown();
      chrome.runtime.sendMessage({ type: 'rail-ended' }).catch(() => {});
    }

    return { close };
  }
})();
