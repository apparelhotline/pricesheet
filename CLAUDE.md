# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo holds **two unrelated systems** that happen to share a folder. Know which one a task is about before touching anything:

1. **Convention Price Sheet** — a single-file, editable static web app (`index.html` + `image-slot.js` + `assets/`), deployed to GitHub Pages. This is the repo's namesake and the only thing that gets *deployed from git*.
2. **Etsy → Google Sheets order pipeline** — Google Apps Script files (`*.gs`) plus Make.com scenarios. These are **not deployed from git**; the `.gs` files are pasted by hand into the Google Apps Script editor, and the automation lives in Make.com. The repo copy is the source of truth / backup.

There is no build, lint, or test tooling — everything is static HTML/JS or pasted-in Apps Script.

---

## 1. Convention Price Sheet (web app)

A self-contained, client-side price sheet for trade-show/convention products. Vanilla JS, no framework, no build step. Edited live in the browser.

- **`index.html`** (~98 KB, single file): the whole app — multi-page layout (`<section class="page" data-screen-label="...">`), inline edit mode (add/edit/rearrange products, undo/redo), font-combo theming via `body.font-*` classes + a "tweaks panel", and a thumbnail bundler template. Product grids (`data-grid="sacred|bevbros|flower|gummies|pufftuff"`) are populated from `assets/<group>/index.json` manifests. All logic is inline `<script>`.
- **`image-slot.js`**: a `<image-slot>` custom element — a user-fillable image placeholder filled by drag-drop or click. Drops persist to a **`.image-slots.state.json`** sidecar (read via `fetch`, written via the `window.omelette` host bridge; read-only outside that runtime). Slots **require a unique `id`** to persist. `cover` slots support double-click reframe (drag/scale, crop saved in the sidecar). See the file header for the full attribute list (`shape`, `mask`, `fit`, etc.).
- **Cross-visitor sync**: `index.html` sets `window.IMAGE_SLOT_SYNC_URL` to a Cloudflare Worker (`pricesheet-edits.matt-c61.workers.dev/images`) so image drops/clears made by any visitor show for everyone.
- **`assets/`**: product images per group plus an `index.json` manifest in each subfolder.
- **`.image-slots.state.json`**: large committed state file holding persisted slot images — expect big diffs when slots change.

### Deploying the price sheet

```bash
./push.sh                 # commits everything as "update", pushes to main
./push.sh "what changed"  # custom commit message
```

`push.sh` pushes to **`main`**; the live site updates ~30–60s later at `https://apparelhotline.github.io/pricesheet/` (GitHub Pages, `.nojekyll`). Note this commits to `main` directly — distinct from the Etsy-pipeline feature-branch workflow.

---

## 2. Etsy → Google Sheets order pipeline

An Etsy order-management workflow built on **Make.com + a Google Sheet**. The `.gs` files here are pasted into Google Apps Script; Make.com holds the Etsy OAuth and feeds data in.

- **Spreadsheet ID:** `1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys` (titled "ETSY ORDERS"; tabs: `ORDERS`, `DASHBOARD`, `Backup`, `RECON`, `COMPLETED`).
- **`ORDERS` tab** (cols A–Q): STATUS, ORDER ID, ORDERED, ITEM NAME, TYPE, SKU, QTY, COLOR, SIZE, DETAILS, DIGITIZE FOLDER, VENDOR, SHIP BY, TRACKING NUMBER, CUSTOMER NAME, SHIP TO, ADDED. ORDER ID is always `#<receipt_id>`.
- **Make team ID:** 454843 · **Google Sheets connection:** 4725483 · **Etsy connection:** 4725481

### The `.gs` files
- **`orders-brain.gs`** — THE active manager. Paste into the "ORDERS auto-mover" Apps Script project, replacing `Code.gs`. Triggers: `processNewRows` on spreadsheet change; `runMaintenance` on a 30-min timer. Functions: `processNewRows` (format + dedupe new rows), `archiveShipped` (move any row with a tracking number → COMPLETED), `buildDashboard` (rewrite DASHBOARD + the mobile-HTML cell `Z1`), `enforceBaseline` (one-time: keep only `BASELINE_OPEN_IDS`).
- **`mobile-dashboard.gs`** — standalone web-app version of the mobile dashboard (alternative to the Make-webhook approach; not the primary path).
- **`sheets-order-manager.gs`** — legacy archive/import helper (`archiveCompleted`, `importFromBackup`). Superseded by `orders-brain.gs`.

### Final architecture (one brain owns ORDERS) — tracking-based
- **Make = Etsy feeder ONLY** (holds OAuth, never deletes):
  - `ETSY -> ORDERS live sync (15-min)` (id 4749764): appends NEW open orders (no tracking_code AND not already in ORDERS), tagged `NEW`.
  - `ETSY tracking snapshot (2h)` (id 4749776): clears `RECON!A:B`, writes `#<receipt_id> | <tracking_code>` for **on-sheet** receipts that have tracking. RECON = the shipped/tracking map.
  - `Mobile Dashboard - serve HTML` (id 4749749, hook 2725745): webhook returns `DASHBOARD!Z1`. URL: https://hook.us1.make.com/q3wdjh2el239v8qjzi2nvqbtb8uqvqhy
  - DELETED (do not recreate): `RECON: add missing open orders (getReceipt)` and the old open-set snapshot — both over-counted to 145.
- **`orders-brain.gs` = the single writer.** Loop: Make adds new no-tracking orders + snapshots tracking → orders-brain archives anything with a tracking number → ORDERS == open (untracked) orders.

### Standing preferences (behavioral — honor these)
- **Act autonomously.** Don't stop mid-task for confirmation; build it correct and stable, fix bugs, then report.
- **NO Etsy API key.** The user will not create an Etsy developer key. Etsy data must come ONLY through the Make Etsy connection (4725481). Never build anything needing a raw Etsy key.
- **DEFINITION OF OPEN (authoritative):** an order is OPEN until it gets a **tracking number**; once tracking appears it's done → archive to COMPLETED. This is the only signal trusted. Do NOT use Etsy's `was_shipped` flag (it returned 145 when the dashboard showed 119 open — ~26 had tracking but `was_shipped:false`).
- New orders are tagged STATUS = `NEW`. The QTY column is usually blank, so "qty to order" = count of line items per item/color/size.
- The `ORDERS` tab is a Google Sheets **Table object**, which can make appended rows land outside the table; prefer a plain range + STATUS data-validation dropdown.

### Make.com gotchas (learned the hard way)
- `google-sheets:addRow` silently fails for API-created scenarios (missing header metadata). Use `makeAPICall` POST to `…/values/ORDERS!A1:append`.
- `filterRows` / range strings can't handle sheet names with spaces unless single-quoted AND passed as a `ranges` query param via `values:batchGet`.
- QUERY `contains` mis-detects column types; use `SEARCH()` inside `ARRAYFORMULA` for text matching.
- Referencing a cell holding `#ERROR!` propagates the error — keep dashboard metric cells error-free.
- Deeply-escaped `""` (empty-string literals) in a formula written through Make's JSON body often break; prefer `LEN(x)>0` over `x<>""`.
- **Spill/array formulas (FILTER, etc.) do NOT recalc in time** for an immediate read-back in the same Make run. SCALAR formulas (`CONCATENATE`, `SUMPRODUCT`, `TEXTJOIN(...,ARRAYFORMULA(...))`) DO compute synchronously on read. To pass a computed list to Make: write a scalar `TEXTJOIN(",",TRUE,ARRAYFORMULA(...))` to one cell, GET it, then `split(value; ",")`.
- A `contains(join(flatten(...);"|"); id+"|")` string-match filter is unreliable for large dedup sets; compute the set in-sheet with `MATCH`/`ISNA` when correctness matters.
- **Make filter condition groups are OR'd; conditions WITHIN a group are AND'd.** To require two conditions together, put them in the SAME inner array `[[{a},{b}]]`. Separate groups `[[{a}],[{b}]]` mean `a OR b` — this bug made the tracking snapshot write every shipped receipt (~500 rows → Sheets 429 + credit burn).
- Editing the mobile-dashboard webhook scenario breaks its synchronous-response binding (it returns "Accepted"); delete and recreate the scenario, reusing the same hook to keep the URL.

### Mobile dashboard via Make MCP
There is no `gh` CLI here; use the GitHub MCP tools. Make.com is driven via the Make MCP tools (`mcp__...scenarios_*`, `executions_*`). To read a cell value from a Make run (which only returns status/error), write a value into a cell, GET it, then reference it as a malformed range so the error message echoes the value back.
