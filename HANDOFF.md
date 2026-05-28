# HANDOFF — Etsy → Google Sheets order pipeline

Snapshot of where this work stands so anyone can pick it up. Scope: the **Etsy
order pipeline** (Make.com + Google Apps Script + the ORDERS sheet). The
Convention Price Sheet web app is unrelated and untouched here.

Branch: `claude/etsy-oauth-integration-pqGOu` · PR: #1 (draft)

---

## ⏳ The one open step (do this first)

The Apps Script "brain" fix is committed but **not yet live** (the `.gs` is
pasted by hand, not deployed from git):

1. Open the **ETSY ORDERS** Google Sheet → Extensions → Apps Script.
2. Replace all of `Code.gs` with the latest `orders-brain.gs` from this branch.
3. Save, then run **`installTriggers`** once (approve the auth prompt).
   - This installs the 30-min `runMaintenance` trigger + the on-change trigger
     **and** runs maintenance immediately.
4. Check the execution log — you should see **`archiveShipped: archived N
   shipped line item(s)`** (not "nothing to archive").

Expected result: ORDERS drops from ~150 to **~131 open**, matching Etsy's ~130
(±1 is a completed-without-tracking edge). Confirm on the GitHub-hosted mobile
dashboard and the in-sheet DASHBOARD tab.

---

## System overview

- **Spreadsheet:** `1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys` ("ETSY ORDERS").
  Tabs: `ORDERS`, `DASHBOARD`, `COMPLETED`, `RECON`, `Backup`.
- **Definition of OPEN (authoritative):** an order is open until it has a
  **tracking number**; once tracking appears → archive to COMPLETED. Cancelled
  orders never get tracking, so they're handled separately (see below).
- **Make team:** 454843 · **Google Sheets connection:** 4725483 · **Etsy
  connection:** 4725481.

### Make scenarios (the feeders — all active)
- **`ETSY -> ORDERS live sync (15-min)` (4749764):** appends NEW open orders.
  Free-text fields are sanitized (backslash/quote stripped via `replace()`
  using helper chars in `RECON!P1:P2`) because Make has no `toJSON()` and a raw
  `\` or `"` corrupts the append JSON and silently drops the order.
- **`ETSY tracking snapshot (2h)` (4749776):** clears `RECON!A:B`, writes
  `#<receipt_id>` to col A for every on-sheet order that **has tracking**.
  ⚠️ Col B (tracking_code) often lands blank — see KNOWN ISSUES.
- **`ETSY cancelled snapshot (6h)` (4754917):** writes `#<receipt_id>` to
  `RECON!D` for every Etsy order with status `canceled`.
- **`Mobile Dashboard - serve HTML` (4749749):** webhook returns `DASHBOARD!Z1`.
  URL: https://hook.us1.make.com/q3wdjh2el239v8qjzi2nvqbtb8uqvqhy

### Apps Script brain (`orders-brain.gs`)
- `installTriggers()` — run once; creates the triggers + runs maintenance.
- `runMaintenance()` (30-min) → `processNewRows()` + `archiveShipped()` +
  `archiveCancelled()` + `buildDashboard()`.
- `archiveShipped()` — archives any ORDERS row whose id is in **`RECON!A`**
  (col A membership = shipped, since the snapshot only writes tracked orders).
  Col B is used only to fill the tracking value when present.
- `archiveCancelled()` — moves rows whose id is in `RECON!D` → COMPLETED,
  STATUS set to `CANCELLED` (dedupes; the snapshot can write duplicate ids).
- `buildDashboard()` — wipes the whole DASHBOARD tab each run and renders a
  slim layout: Open orders / Open line items / by-status / need-to-order
  (item/color/size + qty), plus the mobile HTML in `Z1`.

### RECON tab column map
- `A` / `B` — shipped: `#receipt_id` / tracking_code (tracking snapshot, 2h)
- `D` — cancelled: `#receipt_id` (cancelled snapshot, 6h)
- `P1` / `P2` — helper chars `=CHAR(92)` (`\`) and `=CHAR(34)` (`"`) used by the
  live-sync sanitizer. **Leave these in place.**

---

## What was fixed this session
- Live-sync silently dropped orders containing `\` or `"` → now sanitized.
- Recovered the dropped orders.
- Apps Script had **zero triggers** (nothing ran automatically) → added
  `installTriggers()`.
- Cancelled orders never left ORDERS → added cancelled snapshot +
  `archiveCancelled()`.
- DASHBOARD tab had stale frozen columns from an old layout → `buildDashboard`
  now wipes the whole tab and renders a slim view.
- `archiveShipped` required `RECON!B` (often blank) → changed to key off
  `RECON!A` membership so shipped orders actually archive.

## Known issues / watch-outs
- **`RECON!B` (tracking_code) frequently writes blank** even though the
  snapshot filter confirms tracking exists. Not yet root-caused; `archiveShipped`
  now works around it by using col A. If you want the actual tracking codes in
  COMPLETED, debug the snapshot's body expression
  `first(map(3.shipments; "tracking_code"))` (scenario 4749776, module 4).
- Tracking snapshot clears `RECON!A:B` then rewrites over ~40s every 2h; a
  `runMaintenance` that lands in that window sees an empty map and archives
  nothing that cycle. Self-heals on the next 30-min run.
- Reconciliation residual of ~1 is a completed-but-no-tracking order.
- There is a separate **GitHub-hosted "Etsy Orders" dashboard** on
  `apparelhotline.github.io` (a different repo) that reads the sheet live — it
  reflects whatever is in ORDERS, so it's only correct once archiving runs.
