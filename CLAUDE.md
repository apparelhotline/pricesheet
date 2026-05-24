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

- **ALWAYS reconcile** the ORDERS sheet against Etsy when syncing or when asked about order counts. Reconciliation = pull current Etsy orders, then report (a) sheet orders not present/open on Etsy (stale → archive) and (b) Etsy orders missing from the sheet (→ add). The sheet count will drift higher than Etsy's "open orders" view because the sync only adds and never removes closed/canceled orders.
- New orders synced from Etsy are tagged STATUS = `NEW`.
- Quantities: the QTY column is usually blank, so "qty to order" = count of line items per item/color/size.

## Make.com gotchas learned the hard way

- The `google-sheets:addRow` module silently fails for API-created scenarios (missing header metadata). Use `makeAPICall` POST to `…/values/ORDERS!A1:append` instead.
- `filterRows` / range strings can't handle sheet names with spaces unless single-quoted AND passed as a `ranges` query param via `values:batchGet`.
- QUERY `contains` mis-detects column types; use `SEARCH()` inside `ARRAYFORMULA` for text matching.
- Referencing a cell that holds `#ERROR!` propagates the error — keep dashboard metric cells error-free.
- Deeply-escaped `""` (empty-string literals) inside a formula written through Make's JSON body often break; prefer `LEN(x)>0` over `x<>""`.
