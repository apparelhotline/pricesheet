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

## Final architecture (stable split)

Make is unreliable for sheet logic (silent `addRow` drops, JSON-escaping breaks on
special chars, opaque per-run behavior, webhook bindings break on edit). So:

- **Make = Etsy bridge ONLY** (it holds the Etsy OAuth):
  - `ETSY -> ORDERS live sync (15-min, append)` (id 4749764): pulls last 45 min of Etsy
    orders, `:append`s new ones to ORDERS (deduped, tagged NEW).
  - `RECON: refresh Etsy open snapshot (2h)` (id 4749776): clears RECON!A then writes
    `#<receipt_id>` for every currently-open Etsy order.
  - `Mobile Dashboard - serve HTML` (id 4749749, hook 2725745): webhook returns
    DASHBOARD!Z1 as the mobile page. URL: https://hook.us1.make.com/q3wdjh2el239v8qjzi2nvqbtb8uqvqhy
- **Apps Script = ALL sheet logic** (`dashboard-reconcile.gs`, `runReconcile` on a 30-min
  time trigger): dedupe ORDERS, archive stale orders (not in RECON) to COMPLETED with
  safety guards, and rebuild the DASHBOARD tab + the mobile HTML cell (Z1). No Etsy calls.

Reconciliation loop: Make adds (live sync) + Make snapshots open orders (RECON) +
Apps Script archives the rest → ORDERS stays equal to Etsy's open set.

## Make.com gotchas learned the hard way

- The `google-sheets:addRow` module silently fails for API-created scenarios (missing header metadata). Use `makeAPICall` POST to `…/values/ORDERS!A1:append` instead.
- `filterRows` / range strings can't handle sheet names with spaces unless single-quoted AND passed as a `ranges` query param via `values:batchGet`.
- QUERY `contains` mis-detects column types; use `SEARCH()` inside `ARRAYFORMULA` for text matching.
- Referencing a cell that holds `#ERROR!` propagates the error — keep dashboard metric cells error-free.
- Deeply-escaped `""` (empty-string literals) inside a formula written through Make's JSON body often break; prefer `LEN(x)>0` over `x<>""`.
