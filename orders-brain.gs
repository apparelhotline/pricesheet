/**
 * ORDERS brain — single Apps Script that owns the ORDERS tab.
 * Paste this into your "ORDERS auto-mover" project (replace Code.gs entirely).
 *
 * Responsibilities:
 *   - onSheetChange  -> processNewRows(): formats NEW rows (TYPE classify, order-ID
 *                       hyperlink, DETAILS rebuild) and removes duplicates. (your old logic,
 *                       MINUS the hard 5/20 date-delete that was deleting synced orders)
 *   - runMaintenance -> reconcileWithEtsy() + buildDashboard(), on a 30-min time trigger:
 *       reconcileWithEtsy(): moves orders NO LONGER OPEN on Etsy to COMPLETED, so ORDERS
 *                            matches Etsy's open set. Driven by the RECON tab (Make keeps it
 *                            fresh every 2h with "#<receipt_id>" of every open Etsy order).
 *       buildDashboard():    rewrites the DASHBOARD tab + the mobile HTML cell (DASHBOARD!Z1).
 *
 * SAFETY: reconcile skips entirely if RECON looks empty/short (MIN_OPEN), never archives
 * orders newer than RECENT_DAYS, and MOVES rows to COMPLETED (never hard-deletes data).
 *
 * TRIGGERS (set once under the clock icon):
 *   - From spreadsheet -> On change  -> processNewRows
 *   - Time-driven -> Every 30 minutes -> runMaintenance
 */

var SHEET_ID = '1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys';
var SHEET_NAME = 'ORDERS';
var RECON_NAME = 'RECON';
var COMPLETED_NAME = 'COMPLETED';
var DASH_NAME = 'DASHBOARD';
var COLS = 17;
var MIN_OPEN = 40;     // skip reconcile if RECON has fewer open ids than this (safety)
var RECENT_DAYS = 2;   // never archive orders newer than this many days (protect fresh syncs)

var BOLD_LABELS = ['FRONT:','BACK:','LEFT:','RIGHT:','L SLEEVE:','R SLEEVE:','SHIRT:','SHORTS:','FONT:','THREAD:','ADDITIONAL NOTES:'];
var ETSY_MSG_REGEX = /(ETSY\s+MESSAGES?|IN\s+MESSAGES?|VIA\s+MESSAGES?|ETSY\s+CHAT|SEE\s+ETSY\s+MESSAGES|ETSY\s+DM)/g;
var OUR_LINK_MARKER = 'search_query=';
var HEADERS = ['STATUS','ORDER ID','ORDERED','ITEM NAME','TYPE','SKU','QTY','COLOR',
  'SIZE','DETAILS','DIGITIZE FOLDER','VENDOR','SHIP BY','TRACKING NUMBER',
  'CUSTOMER NAME','SHIP TO','ADDED'];

// ─── entry points ────────────────────────────────────────────────────────────

function onSheetChange(e) { processNewRows(); }

function runMaintenance() {
  reconcileWithEtsy();
  buildDashboard();
}

// ─── format + dedupe new rows (your logic; date-delete removed) ───────────────

function processNewRows() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  var processedKeys = {};
  for (var r = 2; r <= lastRow; r++) {
    if (isProcessed(sh, r)) processedKeys[rowKey(sh, r)] = true;
  }

  var seenUnprocessed = {}, rowsToDelete = [], changed = false;
  for (var i = 2; i <= lastRow; i++) {
    if (isProcessed(sh, i)) continue;
    var orderIdRaw = String(sh.getRange(i, 2).getValue() || '').trim();
    if (!orderIdRaw) continue;
    var receiptId = orderIdRaw.replace(/^#/, '');
    if (!/^\d{6,}$/.test(receiptId)) continue;

    var key = rowKey(sh, i);
    if (processedKeys[key] || seenUnprocessed[key]) { rowsToDelete.push(i); continue; } // duplicate
    seenUnprocessed[key] = true;
    if (formatRow(sh, i)) changed = true;
  }

  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (r) { sh.deleteRow(r); });
  if (changed || rowsToDelete.length > 0) sortByOrdered(sh);
}

// ─── reconcile vs Etsy open set (RECON) → archive closed orders ───────────────

function reconcileWithEtsy() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  var recon = ss.getSheetByName(RECON_NAME);
  if (!sh || !recon) return;

  var open = {}, openCount = 0;
  var rLast = recon.getLastRow();
  if (rLast >= 1) {
    recon.getRange(1, 1, rLast, 1).getValues().forEach(function (row) {
      var v = String(row[0] || '').trim();
      if (v.charAt(0) === '#') { open[v] = true; openCount++; }
    });
  }
  if (openCount < MIN_OPEN) { Logger.log('reconcile: RECON only ' + openCount + ' (<' + MIN_OPEN + '); skip'); return; }

  var last = sh.getLastRow();
  if (last < 2) return;
  var ids = sh.getRange(2, 2, last - 1, 1).getValues();      // ORDER ID (col B)
  var ordered = sh.getRange(2, 3, last - 1, 1).getValues();  // ORDERED (col C)
  var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - RECENT_DAYS);

  var toArchive = [];
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0] || '').trim();
    if (!id) continue;
    if (open[id]) continue;                         // still open on Etsy -> keep
    var od = ordered[i][0];
    var d = (od instanceof Date) ? od : (od ? new Date(od) : null);
    if (d && !isNaN(d.getTime()) && d > cutoff) continue;  // too new -> protect
    toArchive.push(i + 2);                          // sheet row number
  }
  if (!toArchive.length) { Logger.log('reconcile: nothing to archive'); return; }

  var completed = ss.getSheetByName(COMPLETED_NAME);
  if (!completed) {
    completed = ss.insertSheet(COMPLETED_NAME);
    completed.getRange(1, 1, 1, COLS).setValues([HEADERS]).setFontWeight('bold');
    completed.setFrozenRows(1);
  }
  toArchive.sort(function (a, b) { return b - a; });   // delete bottom-up
  toArchive.forEach(function (rn) {
    var vals = sh.getRange(rn, 1, 1, COLS).getValues();
    completed.getRange(completed.getLastRow() + 1, 1, 1, COLS).setValues(vals);
    sh.deleteRow(rn);
  });
  Logger.log('reconcile: archived ' + toArchive.length + ' closed order(s)');
}

// ─── dashboard + mobile HTML ──────────────────────────────────────────────────

function buildDashboard() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  var last = sh.getLastRow();
  var data = last >= 2 ? sh.getRange(2, 1, last - 1, COLS).getValues() : [];

  var lineItems = 0, mockneck = 0, addedToday = 0;
  var orderCounts = {}, byStatus = {}, byCombo = {};
  var today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');

  data.forEach(function (row) {
    var id = String(row[1] || '').trim();
    if (!id) return;
    lineItems++;
    orderCounts[id] = (orderCounts[id] || 0) + 1;
    var status = String(row[0] || '').trim() || '(no status)';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (String(row[3] || '').toUpperCase().indexOf('MOCK') >= 0) mockneck++;
    var color = String(row[7] || '').trim() || '-';
    var size = String(row[8] || '').trim() || '-';
    var key = _trim(row[3], 28) + ' / ' + color + (size !== '-' ? ' / ' + size : '');
    byCombo[key] = (byCombo[key] || 0) + 1;
    if (String(row[16] || '').indexOf(today) === 0) addedToday++;
  });

  var unique = Object.keys(orderCounts).length;
  var multi = Object.keys(orderCounts).filter(function (k) { return orderCounts[k] > 1; }).length;
  var openItems = lineItems - (byStatus['COMPLETED'] || 0);
  var statusList = Object.keys(byStatus).map(function (k) { return [k, byStatus[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  var comboList = Object.keys(byCombo).map(function (k) { return [k, byCombo[k]]; }).sort(function (a, b) { return b[1] - a[1]; });

  var dash = ss.getSheetByName(DASH_NAME) || ss.insertSheet(DASH_NAME);
  dash.getRange(1, 1, 250, 6).clearContent();
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
  var n = Math.max(statusList.length, comboList.length);
  for (var i = 0; i < n; i++) {
    rows.push([
      statusList[i] ? statusList[i][0] : '', statusList[i] ? statusList[i][1] : '', '',
      comboList[i] ? comboList[i][0] : '', comboList[i] ? comboList[i][1] : '', ''
    ]);
  }
  dash.getRange(1, 1, rows.length, 6).setValues(rows);

  dash.getRange('Z1').setValue(_mobileHtml({
    openItems: openItems, unique: unique, multi: multi, mockneck: mockneck,
    statusList: statusList, comboList: comboList,
    updated: Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, h:mm a')
  }));
}

// ─── your existing helpers (unchanged) ───────────────────────────────────────

function etsyOrderUrl(receiptId) {
  return 'https://www.etsy.com/your/orders/sold?search_query=' + receiptId + '&order_id=' + receiptId;
}

function classifyType(itemName, sku) {
  var name = String(itemName || '').toUpperCase();
  var skuStr = String(sku || '').toUpperCase();
  if (/EMBROIDERY SHORT SET|^SHORT SET|LOUNGE/.test(skuStr)) return 'SHORT SET';
  if (/MOCKNECK[\s-]/.test(skuStr)) return 'MOCKNECK';
  if (/JERSEY/.test(skuStr)) return 'JERSEY';
  if (/VISOR/.test(skuStr)) return 'VISOR';
  if (/OTTO|YUPOONG|31-069|6606|6007|PANEL/.test(skuStr)) return 'HAT';
  if (/3023CL|1717|TSHIRT|T-SHIRT|CROP/.test(skuStr)) return 'T-SHIRT';
  if (/\bMOCKNECK\b|\bMOCK NECK\b/.test(name)) return 'MOCKNECK';
  if (/\bSHORT SET\b|\bLOUNGE\b/.test(name)) return 'SHORT SET';
  if (/\bJERSEY\b/.test(name)) return 'JERSEY';
  if (/\bVISOR\b/.test(name)) return 'VISOR';
  if (/\bHAT\b|\bTRUCKER\b|\bSNAPBACK\b|\bBEANIE\b/.test(name)) return 'HAT';
  if (/\bT[\s-]?SHIRT\b|\bCROP TOP\b|\bTEE\b/.test(name)) return 'T-SHIRT';
  return '';
}

function rowKey(sh, rowNum) {
  var orderId = String(sh.getRange(rowNum, 2).getValue() || '').replace(/^#/, '').trim();
  var itemName = String(sh.getRange(rowNum, 4).getValue() || '').trim();
  return orderId + '|' + itemName;
}

function isProcessed(sh, rowNum) {
  var rt = sh.getRange(rowNum, 2).getRichTextValue();
  if (!rt) return false;
  return rt.getRuns().some(function (run) {
    return run.getLinkUrl() && run.getLinkUrl().indexOf(OUR_LINK_MARKER) >= 0;
  });
}

function formatRow(sh, rowNum) {
  var orderIdRaw = String(sh.getRange(rowNum, 2).getValue() || '').trim();
  var receiptId = orderIdRaw.replace(/^#/, '');
  var url = etsyOrderUrl(receiptId);

  sh.getRange(rowNum, 2).setRichTextValue(
    SpreadsheetApp.newRichTextValue().setText(orderIdRaw).setLinkUrl(0, orderIdRaw.length, url).build()
  );

  var typeCell = sh.getRange(rowNum, 5);
  var type = String(typeCell.getValue() || '').trim();
  if (!type) {
    var classified = classifyType(String(sh.getRange(rowNum, 4).getValue() || ''), String(sh.getRange(rowNum, 6).getValue() || ''));
    if (classified) { typeCell.setValue(classified); type = classified; }
  }

  var embRich = sh.getRange(rowNum, 10).getRichTextValue();
  var embText = embRich ? embRich.getText() : '';
  if (embText) {
    var rebuilt = rebuildEmbeddedCell(embText, type);
    var b = SpreadsheetApp.newRichTextValue().setText(rebuilt.text);
    var bold = SpreadsheetApp.newTextStyle().setBold(true).build();
    BOLD_LABELS.forEach(function (label) {
      var idx = rebuilt.text.indexOf(label);
      while (idx >= 0) { b.setTextStyle(idx, idx + label.length, bold); idx = rebuilt.text.indexOf(label, idx + label.length); }
    });
    rebuilt.urls.forEach(function (url2, k) {
      var label = 'IMAGE ' + (k + 1);
      var re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)', 'g');
      var m; while ((m = re.exec(rebuilt.text)) !== null) { b.setLinkUrl(m.index, m.index + label.length, url2); }
    });
    var mm; ETSY_MSG_REGEX.lastIndex = 0;
    while ((mm = ETSY_MSG_REGEX.exec(rebuilt.text)) !== null) { b.setLinkUrl(mm.index, mm.index + mm[0].length, url); }
    sh.getRange(rowNum, 10).setRichTextValue(b.build());
  }
  return true;
}

function rebuildEmbeddedCell(raw, type) {
  raw = String(raw || '');
  var urls = [], urlMap = {};
  var processed = raw.replace(/https?:\/\/[^\s|,]+/g, function (url) {
    if (!(url in urlMap)) { urls.push(url); urlMap[url] = urls.length; }
    return 'IMAGE ' + urlMap[url];
  });
  var notesIdx = processed.indexOf('ADDITIONAL NOTES:');
  var bodyText, notesText;
  if (notesIdx >= 0) {
    bodyText = processed.substring(0, notesIdx).trim();
    notesText = processed.substring(notesIdx + 'ADDITIONAL NOTES:'.length).trim();
  } else { bodyText = processed.trim(); notesText = ''; }
  var frontText = bodyText.toUpperCase();
  var lines = [];
  if (type === 'HAT') { lines.push('FRONT: ' + frontText); lines.push('BACK:'); lines.push('LEFT:'); lines.push('RIGHT:'); }
  else if (type === 'JERSEY') { lines.push('FRONT: ' + frontText); lines.push('BACK:'); lines.push('L SLEEVE:'); lines.push('R SLEEVE:'); }
  else if (type === 'SHORT SET') { lines.push('SHIRT: ' + frontText); lines.push('SHORTS:'); }
  else { lines.push('FRONT: ' + frontText); }
  lines = lines.map(function (l) { return l.replace(/: $/, ':'); });
  lines.push(''); lines.push('ADDITIONAL NOTES:'); lines.push(notesText ? notesText.toUpperCase() : '');
  return { text: lines.join('\n'), urls: urls };
}

function sortByOrdered(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 3) return;
  sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).sort({ column: 3, ascending: false });
}

// ─── dashboard helpers ────────────────────────────────────────────────────────

function _trim(s, n) { s = String(s || ''); return s.length > n ? s.substring(0, n) : s; }
function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _mobileHtml(d) {
  function card(v, label, accent) {
    return "<div style='background:#fff;border-radius:16px;padding:16px;text-align:center'>" +
      "<div style='font-size:38px;font-weight:800;line-height:1" + (accent ? ";color:#0a84ff" : "") + "'>" + v + "</div>" +
      "<div style='font-size:11px;color:#8e8e93;margin-top:4px'>" + label + "</div></div>";
  }
  var statusRows = d.statusList.map(function (s) {
    return "<div style='display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px'><span>" +
      _esc(s[0]) + "</span><span style='font-weight:700;color:#0a84ff'>" + s[1] + "</span></div>";
  }).join('');
  var comboRows = d.comboList.map(function (c) {
    return "<div style='display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px'><span>" +
      _esc(c[0]) + "</span><span style='font-weight:700;color:#0a84ff;padding-left:8px'>x" + c[1] + "</span></div>";
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
    "<div style='font-size:11px;color:#8e8e93;margin:12px 0 6px'>NEED TO ORDER - ALL PRODUCTS</div>" + comboRows + "</div></body>";
}
