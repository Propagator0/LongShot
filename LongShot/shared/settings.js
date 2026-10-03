// Settings shared by the service worker and the popup.

export const DEFAULTS = Object.freeze({
  format: 'png',        // png | jpeg | webp
  quality: 0.92,        // jpeg / webp only
  method: 'render',     // render: one tall pass | stitch: scroll screen by screen
  resolution: 'native', // native: device pixels | 1x: CSS pixels
  preload: true,        // scroll through once first so lazy images load (render, whole page)
  dwellMs: 1200,        // rail: how long to hold still before the shot fires
  railOpacity: 0.6,     // rail at rest; full opacity on hover and drag
  saveAs: false,
  folder: 'LongShot',   // subfolder inside Downloads, empty for none
  stepDelay: 220,       // stitch: settle time after each scroll step
});

export const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
