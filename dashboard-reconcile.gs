/**
 * Orders reconciliation + dashboard — Google Apps Script
 *
 * Runs entirely inside Google Sheets. Does NOT touch Etsy (Make handles all
 * Etsy ingestion). This script reads two tabs that Make keeps fresh:
 *   - ORDERS : the working order list (Make appends new Etsy orders here)
 *   - RECON  : column A = "#<receipt_id>" for every order currently OPEN on Etsy
 *              (Make refreshes this every 2 hours)
 *
 * What runReconcile() does, in order:
 *   1. dedupeOrders()   – removes duplicate ORDER IDs and blank/junk rows
 *   2. archiveStale()   – moves orders that are no longer open on Etsy into the
 *                         COMPLETED tab, so ORDERS matches the Etsy open list.
 *                         Protected by safety guards (see below).
 *   3. buildDashboard() – rewrites the DASHBOARD tab metrics/tables AND the
 *                         mobile-dashboard HTML cell (DASHBOARD!Z1) the webhook serves.
 *
 * SAFETY GUARDS (so we never wrongly delete real orders):
 *   - Archiving is skipped entirely if RECON has fewer than MIN_OPEN ids
 *     (protects against an empty/half-written snapshot).
 *   - Orders placed within RECENT_DAYS are never archived (protects brand-new
 *     orders that Make synced before the RECON snapshot refreshed).
 *   - "Archive" = MOVE to COMPLETED tab, never a hard delete. Nothing is lost.
 *
 * SETUP (one time):
 *   1. Extensions -> Apps Script, add this file, Save.
 *   2. Run `runReconcile` once from the dropdown, approve permissions.
 *   3. Triggers (clock icon) -> Add trigger -> function `runReconcile`,
 *      time-driven, every 30 minutes (or hourly).  Done.
 */

var SS_ID = '1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys';
var COLS = 17;                 // A..Q
var MIN_OPEN = 50;             // don't archive if RECON snapshot smaller than this
var RECENT_DAYS = 3;           // never archive orders newer than this

var HEADERS = ['STATUS','ORDER ID','ORDERED','ITEM NAME','TYPE','SKU','QTY','COLOR',
  'SIZE','DETAILS','DIGITIZE FOLDER','VENDOR','SHIP BY','TRACKING NUMBER',
  'CUSTOMER NAME','SHIP TO','ADDED'];

function runReconcile() {
  dedupeOrders();
  archiveStale();
  buildDashboard();
}

function _ss() { return SpreadsheetApp.openById(SS_ID); }

// ─── 1. De-duplicate ─────────────────────────────────────────────────────────

function dedupeOrders() {
  var sh = _ss().getSheetByName('ORDERS');
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, COLS).getValues();
  var seen = {}, keep = [], dropped = 0;
  vals.forEach(function (row) {
    var id = (row[1] || '').toString().trim();
    if (!id) { dropped++; return; }            // blank ORDER ID (probe/junk row)
    if (seen[id]) { dropped++; return; }        // duplicate
    seen[id] = true;
    keep.push(row);
  });
  if (dropped > 0) {
    sh.getRange(2, 1, vals.length, COLS).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, COLS).setValues(keep);
    Logger.log('dedupeOrders: removed ' + dropped + ' row(s)');
  }
}

// ─── 2. Archive stale (closed-on-Etsy) orders ───────────────────────────────

function archiveStale() {
  var ss = _ss();
  var orders = ss.getSheetByName('ORDERS');
  var recon = ss.getSheetByName('RECON');
  if (!recon) { Logger.log('No RECON tab; skipping archive'); return; }

  // Build the set of currently-open Etsy IDs from RECON column A
  var rLast = recon.getLastRow();
  var openSet = {}, openCount = 0;
  if (rLast >= 1) {
    recon.getRange(1, 1, rLast, 1).getValues().forEach(function (r) {
      var v = (r[0] || '').toString().trim();
      if (v && v.charAt(0) === '#') { openSet[v] = true; openCount++; }
    });
  }
  if (openCount < MIN_OPEN) {
    Logger.log('archiveStale: RECON only ' + openCount + ' ids (<' + MIN_OPEN + '); skipping for safety');
    return;
  }

  var oLast = orders.getLastRow();
  if (oLast < 2) return;
  var data = orders.getRange(2, 1, oLast - 1, COLS).getValues();

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_DAYS);

  var keep = [], archive = [];
  data.forEach(function (row) {
    var id = (row[1] || '').toString().trim();
    if (!id) return;                                   // drop junk
    var status = (row[0] || '').toString().trim().toUpperCase();
    if (openSet[id]) { keep.push(row); return; }       // still open on Etsy -> keep
    if (status === 'COMPLETED') { archive.push(row); return; } // already done -> archive out
    // Not open on Etsy and not yet completed: archive UNLESS it's a brand-new order
    var ordered = _parseDate(row[2]);
    if (ordered && ordered > cutoff) { keep.push(row); return; } // too new, protect it
    archive.push(row);
  });

  if (archive.length === 0) { Logger.log('archiveStale: nothing to archive'); return; }

  var completed = ss.getSheetByName('COMPLETED');
  if (!completed) {
    completed = ss.insertSheet('COMPLETED');
    completed.getRange(1, 1, 1, COLS).setValues([HEADERS]).setFontWeight('bold');
    completed.setFrozenRows(1);
  }
  completed.getRange(completed.getLastRow() + 1, 1, archive.length, COLS).setValues(archive);

  orders.getRange(2, 1, data.length, COLS).clearContent();
  if (keep.length) orders.getRange(2, 1, keep.length, COLS).setValues(keep);
  Logger.log('archiveStale: archived ' + archive.length + ', kept ' + keep.length);
}

function _parseDate(v) {
  if (v instanceof Date) return v;
  var s = (v || '').toString().trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── 3. Build dashboard + mobile HTML ───────────────────────────────────────

function buildDashboard() {
  var ss = _ss();
  var orders = ss.getSheetByName('ORDERS');
  var last = orders.getLastRow();
  var data = last >= 2 ? orders.getRange(2, 1, last - 1, COLS).getValues() : [];

  var lineItems = 0, mockneck = 0, addedToday = 0;
  var orderCounts = {}, byStatus = {}, byCombo = {};
  var today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');

  data.forEach(function (row) {
    var id = (row[1] || '').toString().trim();
    if (!id) return;
    lineItems++;
    orderCounts[id] = (orderCounts[id] || 0) + 1;
    var status = (row[0] || '').toString().trim() || '(no status)';
    byStatus[status] = (byStatus[status] || 0) + 1;
    var item = (row[3] || '').toString();
    if (item.toUpperCase().indexOf('MOCK') >= 0) mockneck++;
    var color = (row[7] || '').toString().trim() || '-';
    var size = (row[8] || '').toString().trim() || '-';
    var key = _trim(item, 28) + ' / ' + color + (size && size !== '-' ? ' / ' + size : '');
    byCombo[key] = (byCombo[key] || 0) + 1;
    if ((row[16] || '').toString().indexOf(today) === 0) addedToday++;
  });

  var unique = Object.keys(orderCounts).length;
  var multi = Object.keys(orderCounts).filter(function (k) { return orderCounts[k] > 1; }).length;
  var completed = byStatus['COMPLETED'] || 0;
  var openItems = lineItems - completed;

  var statusList = Object.keys(byStatus).map(function (k) { return [k, byStatus[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
  var comboList = Object.keys(byCombo).map(function (k) { return [k, byCombo[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });

  // ---- DASHBOARD tab (human view) ----
  var dash = ss.getSheetByName('DASHBOARD') || ss.insertSheet('DASHBOARD');
  dash.getRange(1, 1, 200, 6).clearContent();
  var rows = [
    ['ORDERS DASHBOARD', '', '', '', '', ''],
    ['Updated ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, h:mm a'), '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Open line items', openItems, '', '', '', ''],
    ['Unique orders', unique, '', '', '', ''],
    ['Orders w/ multiple line items', multi, '', '', '', ''],
    ['Mockneck line items', mockneck, '', '', '', ''],
    ['Added today', addedToday, '', '', '', ''],
    ['', '', '', '', '', ''],
    ['OPEN ORDERS BY STATUS', 'LINE ITEMS', '', 'NEED TO ORDER', 'QTY', '']
  ];
  var maxLen = Math.max(statusList.length, comboList.length);
  for (var i = 0; i < maxLen; i++) {
    rows.push([
      statusList[i] ? statusList[i][0] : '',
      statusList[i] ? statusList[i][1] : '',
      '',
      comboList[i] ? comboList[i][0] : '',
      comboList[i] ? comboList[i][1] : '',
      ''
    ]);
  }
  dash.getRange(1, 1, rows.length, 6).setValues(rows);

  // ---- Mobile HTML (DASHBOARD!Z1, served by the Make webhook) ----
  dash.getRange('Z1').setValue(_mobileHtml({
    openItems: openItems, unique: unique, multi: multi, mockneck: mockneck,
    addedToday: addedToday, statusList: statusList, comboList: comboList,
    updated: Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, h:mm a')
  }));
}

function _trim(s, n) { s = (s || '').toString(); return s.length > n ? s.substring(0, n) : s; }

function _esc(s) {
  return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _mobileHtml(d) {
  function card(n, label, accent) {
    return "<div style='background:#fff;border-radius:16px;padding:16px;text-align:center'>" +
      "<div style='font-size:38px;font-weight:800;line-height:1" + (accent ? ";color:#0a84ff" : "") + "'>" + n + "</div>" +
      "<div style='font-size:11px;color:#8e8e93;margin-top:4px'>" + label + "</div></div>";
  }
  var statusRows = d.statusList.map(function (s) {
    return "<div style='display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px'>" +
      "<span>" + _esc(s[0]) + "</span><span style='font-weight:700;color:#0a84ff'>" + s[1] + "</span></div>";
  }).join('');
  var comboRows = d.comboList.map(function (c) {
    return "<div style='display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px'>" +
      "<span>" + _esc(c[0]) + "</span><span style='font-weight:700;color:#0a84ff;padding-left:8px'>x" + c[1] + "</span></div>";
  }).join('');

  return "<!DOCTYPE html><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<body style='font-family:-apple-system,sans-serif;background:#f2f2f7;margin:0;padding:16px;color:#1c1c1e'>" +
    "<div style='background:linear-gradient(135deg,#0a84ff,#5e5ce6);color:#fff;padding:26px 16px;border-radius:18px;text-align:center'>" +
    "<div style='font-size:23px;font-weight:700'>Orders Dashboard</div>" +
    "<div style='font-size:12px;opacity:.85'>Updated " + _esc(d.updated) + "</div></div>" +
    "<div style='display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px'>" +
    card(d.openItems, 'OPEN LINE ITEMS', true) + card(d.unique, 'UNIQUE ORDERS') +
    card(d.multi, 'MULTI-ITEM ORDERS') + card(d.mockneck, 'MOCKNECK ITEMS') + "</div>" +
    "<div style='background:#fff;border-radius:16px;padding:6px 16px;margin-top:14px'>" +
    "<div style='font-size:11px;color:#8e8e93;margin:12px 0 6px'>OPEN ORDERS BY STATUS</div>" + statusRows + "</div>" +
    "<div style='background:#fff;border-radius:16px;padding:6px 16px;margin-top:14px'>" +
    "<div style='font-size:11px;color:#8e8e93;margin:12px 0 6px'>NEED TO ORDER - ALL PRODUCTS</div>" + comboRows + "</div>" +
    "</body>";
}
