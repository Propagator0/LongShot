// Offscreen document: decodes segments, stitches them on canvases, encodes
// the final image and keeps it alive as a blob URL until the download ends.

const jobs = new Map();   // jobId -> [{ bmp, dy }]
const blobs = new Map();  // blob URL -> Blob

// Canvas and encoder ceilings. WebP can't exceed 16383 px on a side;
// Chromium canvases cap around 32767 px and ~268M pixels of area.
const DIM_CAP = { 'image/webp': 16383, 'image/jpeg': 32767, 'image/png': 32767 };
const AREA_CAP = 250_000_000;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'job-begin':
      jobs.set(msg.jobId, []);
      return { ok: true };

    case 'job-reset':
    case 'job-abort': {
      for (const { bmp } of jobs.get(msg.jobId) || []) bmp.close();
      if (msg.type === 'job-reset') jobs.set(msg.jobId, []); else jobs.delete(msg.jobId);
      return { ok: true };
    }

    case 'job-add': {
      const list = jobs.get(msg.jobId);
      if (!list) throw new Error('Unknown capture job');
      const blob = await (await fetch(`data:image/png;base64,${msg.data}`)).blob();
      let bmp = await createImageBitmap(blob);
      if (msg.crop) {
        const { sx, sw } = msg.crop;
        const sy = Math.max(0, msg.crop.sy);
        const sh = Math.min(msg.crop.sh, bmp.height - sy);
        if (sh <= 0 || sw <= 0) { bmp.close(); return { ok: true, skipped: true }; }
        const full = bmp;
        bmp = await createImageBitmap(full, sx, sy, Math.min(sw, full.width - sx), sh);
        full.close();
      }
      const prev = list[list.length - 1];
      const dy = msg.dy ?? (prev ? prev.dy + prev.bmp.height : 0);
      list.push({ bmp, dy });
      return { ok: true };
    }

    case 'job-finish':
      return finish(msg);

    case 'data-url': {
      const blob = blobs.get(msg.url);
      if (!blob) throw new Error('Image is no longer available');
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
      });
      return { dataUrl };
    }

    case 'revoke':
      URL.revokeObjectURL(msg.url);
      blobs.delete(msg.url);
      return { ok: true };

    default:
      throw new Error(`Unknown request: ${msg.type}`);
  }
}

async function finish({ jobId, mime, quality, scale = 1 }) {
  const list = jobs.get(jobId);
  if (!list || !list.length) throw new Error('Nothing was captured');
  jobs.delete(jobId);

  const srcW = Math.max(...list.map((s) => s.bmp.width));
  const srcH = Math.max(...list.map((s) => s.dy + s.bmp.height));
  const W = Math.max(1, Math.round(srcW * scale));
  const H = Math.max(1, Math.round(srcH * scale));

  // Split into several files only when one would exceed what the format allows.
  const maxH = Math.max(1, Math.min(DIM_CAP[mime] || 32767, Math.floor(AREA_CAP / W)));
  const nParts = Math.ceil(H / maxH);
  const parts = [];

  try {
    for (let p = 0; p < nParts; p++) {
      const top = p * maxH;
      const h = Math.min(maxH, H - top);
      const canvas = new OffscreenCanvas(W, h);
      const g = canvas.getContext('2d');
      if (mime === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, W, h); }
      g.imageSmoothingQuality = 'high';
      for (const { bmp, dy } of list) {
        const y = Math.round(dy * scale) - top;
        const bh = Math.round(bmp.height * scale);
        if (y + bh <= 0 || y >= h) continue;
        g.drawImage(bmp, 0, y, Math.round(bmp.width * scale), bh);
      }
      const blob = await canvas.convertToBlob({ type: mime, quality });
      const url = URL.createObjectURL(blob);
      blobs.set(url, blob);
      parts.push({ url, width: W, height: h, bytes: blob.size });
    }
  } finally {
    for (const { bmp } of list) bmp.close();
  }
  return { parts, width: W, height: H };
}
