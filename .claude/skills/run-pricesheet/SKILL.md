---
name: run-pricesheet
description: Run, serve, preview, or screenshot the Convention Price Sheet web app (index.html + image-slot.js). Use when asked to launch, start, smoke-test, or capture a screenshot of the price sheet / pricesheet site.
---

# Run the Convention Price Sheet

`index.html` is a single-file static web app (vanilla JS, **no build step**) with a
`<image-slot>` custom element (`image-slot.js`) and product images under `assets/`.
You drive it by serving the folder over HTTP and pointing the Playwright driver at it.

The driver is **`.claude/skills/run-pricesheet/driver.mjs`** — it launches headless
Chromium, runs smoke checks (custom element upgraded, grids populated from
`assets/<group>/index.json`, edit FAB present), and writes a screenshot.

> Paths below are relative to the repo root (`<unit>/`).
> **Not** runnable here: the Etsy `*.gs` files are Google Apps Script + Make.com automation — they don't run in a container. This skill is only for the web app.

## Prerequisites

Already present in this container (global npm + Playwright browsers at `/opt/pw-browsers`):
`node` 22, `playwright` 1.56, `http-server`. On a bare machine:

```bash
npm i -g playwright http-server
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright install chromium
```

## Run (agent path)

1. Serve the folder in the background:

```bash
npx http-server -p 8089 -c-1 --silent > /tmp/httpd.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8089/index.html
```

2. Drive it + screenshot (exit 0 = smoke checks passed):

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node .claude/skills/run-pricesheet/driver.mjs http://localhost:8089/index.html --out /tmp/pricesheet.png
```

Then **look at** `/tmp/pricesheet.png`. Expected: a black-and-white price sheet with
filled product photos (Sacred 7, Bev Bros / Papa's cans) and pricing tables.

Driver flags:
- `--out FILE` — screenshot path (default `/tmp/pricesheet.png`)
- `--full` — full-page screenshot instead of the 1280×1600 viewport
- `--edit` — click the **+ Add / Edit** FAB first, so the screenshot shows the inline
  edit UI ("ADD PRODUCT" placeholders + per-card delete buttons)

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node .claude/skills/run-pricesheet/driver.mjs http://localhost:8089/index.html --out /tmp/pricesheet-edit.png --edit
```

## Run (human path)

Serve and open in a browser — useless headless, but fine on a desktop:

```bash
npx serve -l 8089 .      # or: npx http-server -p 8089
# open http://localhost:8089/index.html
```

## Deploy

```bash
./push.sh "what changed"   # commits all, pushes to main → GitHub Pages
```

Live ~30–60s later at `https://apparelhotline.github.io/pricesheet/` (`.nojekyll`).
Note `push.sh` commits to **`main`** directly.

## Gotchas

- **Playwright is installed globally, so a bare `import 'playwright'` in an `.mjs` fails**
  (`ERR_MODULE_NOT_FOUND`). The driver works around this by resolving it via
  `npm root -g`. Keep that shim if you edit the driver.
- **`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` is required** — without it Playwright
  looks in `~/.cache/ms-playwright` (empty here) and fails to find Chromium.
- **External-resource errors are expected and harmless.** Google Fonts and the
  cross-visitor sync Cloudflare Worker (`window.IMAGE_SLOT_SYNC_URL`,
  `pricesheet-edits.matt-c61.workers.dev`) are blocked by the sandbox network →
  `ERR_CERT_AUTHORITY_INVALID` / `ERR_NAME_NOT_RESOLVED`. The driver buckets these as
  "network noise" and ignores them; only real JS/page errors fail the run.
- **Image drops won't persist headless.** Slots load their saved images from the
  committed `.image-slots.state.json`, but *writing* a new drop needs the `window.omelette`
  host bridge; outside that runtime slots are effectively read-only. So the screenshot
  shows existing images, but you can't add one via the driver and have it save.
- **Serve from the repo root**, not a subdir — `image-slot.js`, `assets/`, and the
  `.image-slots.state.json` sidecar are all resolved relative to `/`.

## Troubleshooting

- `ERR_MODULE_NOT_FOUND: playwright` → you ran the driver without the global resolver, or
  on a machine where playwright isn't global. Confirm with `npm ls -g playwright`.
- Driver hangs at `goto` → the static server isn't up. Check `/tmp/httpd.log` and that
  `curl http://localhost:8089/index.html` returns 200.
- Screenshot is blank / `image-slot customElement defined: false` → `image-slot.js`
  didn't load; confirm you're serving the repo root and the file is reachable
  (`curl -I http://localhost:8089/image-slot.js`).
