# LongShot

Whole-page screenshots in one click, or a rail down the right edge that you drag to the length you want.

## Load it in Brave

1. Open `brave://extensions`, switch on Developer mode (top right).
2. Load unpacked, pick this `LongShot` folder.
3. Pin it from the puzzle-piece menu so the icon sits in the toolbar.

For local files (`file://`), also switch on "Allow access to file URLs" on the extension's card.

## Modes

| Mode | Shortcut | What happens |
|---|---|---|
| Entire page | Alt+Shift+F | Top to bottom, one file. |
| Rail | Alt+Shift+R | A bar appears on the right edge. The amber frame is your screen, the green band is what gets captured. Drag the frame or scroll normally; the band stretches from where you started. Hold still and three red triangles fill, then it shoots. Releasing the drag, Enter, or Shoot fires at once. Esc or the shortcut again cancels. "From top" moves the start to the top of the page. |
| Visible area | Alt+Shift+V | Just the screen. |

Inside the popup, the F, R and V keys do the same. Rebind at `brave://extensions/shortcuts`.

Files go to `Downloads/LongShot/` as `host_date_time.png` unless you change the folder or turn on "Ask where to save".

## Two capture methods (Settings)

**Render** (default) lays the page out at full height and captures it in segments of 4096 device pixels, stitched into one image. Fixed headers appear once, at the top. Pages that scroll an inner panel instead of the document (app layouts) get their viewport temporarily stretched so the panel unfolds; if it refuses, LongShot falls back to Stitch on its own.

**Stitch** scrolls one screen at a time and joins the frames, hiding fixed and sticky elements after the first screen. Use it on feeds and virtualized lists (X, Reddit, chat logs) that unload content once it scrolls away; Render can't see what those pages haven't kept in the DOM.

## The yellow bar

Captures use the browser's debugger protocol, so Brave shows a "LongShot started debugging this browser" bar while a shot runs (and for as long as the rail is open). Clicking Cancel on it closes the rail. To hide the bar, launch Brave with `--silent-debugger-extension-api`. On Arch-based systems the `brave-bin` launcher reads extra flags from `~/.config/brave-flags.conf`, one per line.

## Limits

- Browser pages (`brave://`, the Web Store, the built-in PDF viewer) are off limits to every extension.
- Very tall images get split into numbered files at the format's ceiling: 16,383 px for WebP, 32,767 px for PNG and JPEG. PNG keeps the most height per file.
- Infinite-scroll pages: the whole-page preload stops after 8 seconds, so you get what loaded by then. The rail is the better tool there.

## Layout

```
manifest.json
sw.js                 service worker: debugger sessions, both engines, saving
shared/settings.js    defaults and storage
shared/page.js        functions that run inside the page (probe, scroll, hide, restore, toast)
content/rail.js       the rail, injected on demand
offscreen/            stitches segments on canvas, encodes, holds the blob for download
popup/                toolbar popup
icons/
```
