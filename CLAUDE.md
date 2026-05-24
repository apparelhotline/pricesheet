# Project notes for Claude

## Etsy → Google Sheets order pipeline

This repo backs an Etsy order-management workflow built on **Make.com + a Google Sheet**.

- **Spreadsheet ID:** `1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys`
- **Main tab:** `ORDERS` (columns A–Q: STATUS, ORDER ID, ORDERED, ITEM NAME, TYPE, SKU, QTY, COLOR, SIZE, DETAILS, DIGITIZE FOLDER, VENDOR, SHIP BY, TRACKING NUMBER, CUSTOMER NAME, SHIP TO, ADDED)
- ORDER ID format is always `#<receipt_id>`.
- **DASHBOARD tab:** live metric formulas + the mobile-dashboard HTML builder (cells Z1–Z9, query in M11:P).
- **Mobile dashboard:** served via a Make webhook that returns `DASHBOARD!Z1` as HTML. Editing the webhook scenario breaks its synchronous-response binding — if it returns "Accepted", delete and recreate the scenario (reuse the same hook to keep the URL).
- **Make team ID:** 454843 · **Google Sheets connection:** 4725483 · **Etsy connection:** 4725481

## Standing preferences (remember these)

- **ALWAYS reconcile** so the Google Sheet matches the Etsy orders dashboard — both directions, automatically. Add missing open orders; archive (move to COMPLETED) orders that are no longer open on Etsy.
- **Act autonomously — do NOT stop to ask for confirmation or give recommendations mid-task.** Just build it as correct and stable as possible, fix all bugs, then report what was done.
- **NO Etsy API key.** The user does not have / will not create an Etsy developer key (avoiding account flags). Etsy data must come ONLY through the existing authorized Make Etsy connection (conn 4725481). Never build anything that needs a raw Etsy API key.
- New orders synced from Etsy are tagged STATUS = `NEW`.
- Quantities: the QTY column is usually blank, so "qty to order" = count of line items per item/color/size.

## Actual setup (discovered 2026-05-24)

- The Google Sheet is titled **"ETSY ORDERS"** (id 1ysZ…). Its tabs are **ORDERS,
  DASHBOARD, Backup, RECON** — the working tab is `ORDERS` (NOT a tab named "ETSY ORDERS").
- The user has two Apps Script projects:
  - **"ETSY ORDERS" / `untitled.gs`** (`syncEtsySheet`): points at a tab named "ETSY ORDERS"
    that does not exist → throws and does nothing. **Legacy — delete this project.**
  - **"ORDERS auto-mover" / `Code.gs`** (`processNewRows`, on-change trigger): the REAL
    manager of ORDERS. Formats rows (classifyType→TYPE, hyperlinks ORDER ID, rebuilds the
    DETAILS cell with bold labels + image links), dedupes, sorts. It ALSO deleted any order
    dated before `MIN_ORDERED_DATE = 2026-05-20` — **that hard date-delete was silently
    deleting Make-synced orders and caused all the count churn.**
- The ORDERS tab is a Google Sheets **Table object** — this can make appended rows land
  outside the table; prefer a plain range + STATUS data-validation dropdown.

## Final architecture (one brain owns ORDERS)

- **Make = Etsy feeder ONLY** (holds the Etsy OAuth, never deletes):
  - `ETSY -> ORDERS live sync (15-min, append)` (id 4749764): appends new open Etsy orders to ORDERS (tagged NEW).
  - `RECON: refresh Etsy open snapshot (2h)` (id 4749776): clears RECON!A, writes `#<receipt_id>` for every open Etsy order.
  - `RECON: add missing open orders (getReceipt)` (id 4749779, every 2h): self-healing backfill.
    Writes a scalar `TEXTJOIN` of RECON ids not yet in ORDERS to `RECON!H2`, reads it back,
    `split`s it into an array, and for each id calls `etsy:getReceipt` → appends every
    transaction (line item) to ORDERS as STATUS=NEW. Cheap (~6 ops) when nothing is missing.
    This closed the original 50-order gap (ORDERS went 95→145 unique, matching Etsy open=145).
  - `Mobile Dashboard - serve HTML` (id 4749749, hook 2725745): webhook returns DASHBOARD!Z1.
    URL: https://hook.us1.make.com/q3wdjh2el239v8qjzi2nvqbtb8uqvqhy
- **`orders-brain.gs` = the single ORDERS manager** (paste into the "ORDERS auto-mover"
  project, replacing Code.gs):
  - `processNewRows` (on-change): format + dedupe new rows. **The 5/20 date-delete is removed.**
  - `runMaintenance` (30-min time trigger): `reconcileWithEtsy()` moves orders not in RECON
    (closed on Etsy) to COMPLETED with safety guards; `buildDashboard()` rewrites DASHBOARD + Z1.
- Decision taken: **match Etsy's full open set** (no date cutoff) — reconcile via RECON.

Loop: Make appends open Etsy orders + snapshots them in RECON → orders-brain formats &
archives everything no longer open → ORDERS == Etsy's open set. One writer, no tug-of-war.

## Make.com gotchas learned the hard way

- The `google-sheets:addRow` module silently fails for API-created scenarios (missing header metadata). Use `makeAPICall` POST to `…/values/ORDERS!A1:append` instead.
- `filterRows` / range strings can't handle sheet names with spaces unless single-quoted AND passed as a `ranges` query param via `values:batchGet`.
- QUERY `contains` mis-detects column types; use `SEARCH()` inside `ARRAYFORMULA` for text matching.
- Referencing a cell that holds `#ERROR!` propagates the error — keep dashboard metric cells error-free.
- Deeply-escaped `""` (empty-string literals) inside a formula written through Make's JSON body often break; prefer `LEN(x)>0` over `x<>""`.
- **Spill/array formulas (FILTER, etc.) do NOT recalc in time** for an immediate read-back
  in the same Make run — a `:append`-then-GET returns the cell empty. SCALAR formulas
  (`CONCATENATE`, `SUMPRODUCT`, `TEXTJOIN(...,ARRAYFORMULA(...))`) DO compute synchronously
  on read. To pass a computed list to Make, write a scalar `TEXTJOIN(",",TRUE,ARRAYFORMULA(...))`
  to one cell, GET it, then `split(value; ",")` into an array — never rely on a spilled range.
- A `contains(join(flatten(...);"|"); id+"|")` dedup filter proved unreliable (passed ~2 of 50);
  compute the missing set in-sheet with `MATCH`/`ISNA` instead of string-matching in Make.
