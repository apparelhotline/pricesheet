/**
 * ORDERS brain — single Apps Script that owns the ORDERS tab.
 * Paste this into your "ORDERS auto-mover" project (replace Code.gs entirely).
 *
 * THE RULE (from Matt): an order is OPEN until it gets a TRACKING NUMBER. Once tracking
 * appears, the order is done and should leave ORDERS (move to COMPLETED). That's the only
 * signal we trust — no guessing Etsy's "open" count.
 *
 * Responsibilities:
 *   - onSheetChange  -> processNewRows(): formats NEW rows (TYPE classify, order-ID
 *                       hyperlink, DETAILS rebuild) and removes duplicates.
 *   - runMaintenance -> archiveShipped() + archiveCancelled() + buildDashboard(), 30-min trigger:
 *       archiveShipped():  moves any ORDERS row that has a TRACKING NUMBER to COMPLETED.
 *                          Tracking comes from the row itself OR from the RECON tab, which
 *                          Make refreshes every 2h ("ETSY tracking snapshot" writes
 *                          "#<receipt_id> | <tracking_code>" for every Etsy order that has
 *                          a tracking number).
 *       archiveCancelled(): moves any ORDERS row whose id is in RECON col D to COMPLETED
 *                          (STATUS set to CANCELLED). Make's "ETSY cancelled snapshot (6h)"
 *                          writes "#<receipt_id>" to RECON!D for every Etsy order with
 *                          status=canceled. (Cancellations never get tracking, so this is
 *                          the only way they leave ORDERS.)
 *       buildDashboard():  rewrites the DASHBOARD tab + the mobile HTML cell (DASHBOARD!Z1).
 *   - enforceBaseline(): ONE-TIME reset — archives every ORDERS row whose order id is NOT in
 *                        BASELINE_OPEN_IDS (Matt's authoritative open list). Run it once.
 *
 * SAFETY: everything MOVES rows to COMPLETED (never hard-deletes order data).
 *
 * TRIGGERS (set once under the clock icon):
 *   - From spreadsheet -> On change  -> processNewRows
 *   - Time-driven -> Every 30 minutes -> runMaintenance
 */

var SHEET_ID = '1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys';
var SHEET_NAME = 'ORDERS';
var RECON_NAME = 'RECON';   // col A = "#<receipt_id>", col B = tracking_code (shipped); col D = "#<receipt_id>" (cancelled)
var COMPLETED_NAME = 'COMPLETED';
var DASH_NAME = 'DASHBOARD';
var COLS = 17;
var TRACKING_COL = 14;      // ORDERS column N = TRACKING NUMBER (1-indexed)

// Matt's authoritative OPEN order ids (no "#"). enforceBaseline() keeps ONLY these on ORDERS.
var BASELINE_OPEN_IDS = [
  '4045577683','4069227121','4063439494','4069465673','4064348090','4064350962','4070237529',
  '4070578707','4064941130','4070743459','4070775337','4070801185','4065059854','4065102302',
  '4070948509','4065464016','4065476462','4071203671','4071302743','4071408039','4071533731',
  '4065967318','4066040764','4066046314','4033631855','4057814692','4063334863','4058900066',
  '4060625276','4052224754','4055016994','4062443129','4057104846','4058509066','4064727187',
  '4059217178','4065336757','4059774174','4060498302','4067172945','4061575796','4067754001',
  '4062014798','4067780193','4067787513','4062940408','4068717157','4063141150','4063988204',
  '4070556053','4070784409','4021780193','4030658698','4042939743','4047382911','4048987702',
  '4049203716','4052122678','4059475133','4060814509','4061232307','4057081922','4066657771',
  '4068665001','4042985289','4044176323','4049149995','4047587142','4054939447','4050574662',
  '4057396911','4058556797','4058652119','4054041360','4059583143','4055058078','4060346405',
  '4055253480','4061402313','4056792786','4062146099','4062313847','4062602451','4062851107',
  '4062876917','4057512656','4063284829','4063353671','4057969332','4059215434','4065171735',
  '4065434369','4065997931','4060377810','4066058367','4066331201','4066487539','4066886485',
  '4067088807','4061595360','4061677934','4062070534','4067920207','4062495300','4062544590',
  '4063237742','4063261980','4069152611','4070120771','4017426432','4047280571','4049069419',
  '4044461256','4049924665','4053907369','4064497307','4061002356','4068149013','4069976015'
];

var BOLD_LABELS = ['FRONT:','BACK:','LEFT:','RIGHT:','L SLEEVE:','R SLEEVE:','SHIRT:','SHORTS:','FONT:','THREAD:','ADDITIONAL NOTES:'];
var ETSY_MSG_REGEX = /(ETSY\s+MESSAGES?|IN\s+MESSAGES?|VIA\s+MESSAGES?|ETSY\s+CHAT|SEE\s+ETSY\s+MESSAGES|ETSY\s+DM)/g;
var OUR_LINK_MARKER = 'search_query=';
var HEADERS = ['STATUS','ORDER ID','ORDERED','ITEM NAME','TYPE','SKU','QTY','COLOR',
  'SIZE','DETAILS','DIGITIZE FOLDER','VENDOR','SHIP BY','TRACKING NUMBER',
  'CUSTOMER NAME','SHIP TO','ADDED'];

// ─── entry points ────────────────────────────────────────────────────────────

// Run this ONCE by hand to (re)install the triggers. Safe to re-run — it clears
// duplicates first. Without these, nothing runs automatically.
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onSheetChange' || fn === 'runMaintenance') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(SpreadsheetApp.openById(SHEET_ID)).onChange().create();
  ScriptApp.newTrigger('runMaintenance').timeBased().everyMinutes(30).create();
  runMaintenance();   // run once now so the sheet + dashboard are current immediately
}

function onSheetChange(e) { processNewRows(); }

function runMaintenance() {
  processNewRows();   // format + sort rows Make appended via API (onChange doesn't fire for API writes)
  archiveShipped();
  archiveCancelled();
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

// ─── archive shipped orders (anything with a tracking number) → COMPLETED ─────

function archiveShipped() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return;

  // shipped set from the RECON snapshot. The snapshot's filter only writes orders that
  // HAVE a tracking number, so presence of the id in RECON col A == shipped. Col B holds
  // the tracking_code when available (used to fill ORDERS col N), but is NOT required.
  var shippedSet = {}, trackMap = {};
  var recon = ss.getSheetByName(RECON_NAME);
  if (recon && recon.getLastRow() >= 1) {
    recon.getRange(1, 1, recon.getLastRow(), 2).getValues().forEach(function (row) {
      var id = String(row[0] || '').trim();
      if (id.charAt(0) !== '#') return;
      shippedSet[id] = true;
      var trk = String(row[1] || '').trim();
      if (trk) trackMap[id] = trk;
    });
  }

  var last = sh.getLastRow();
  if (last < 2) return;
  var data = sh.getRange(2, 1, last - 1, COLS).getValues();

  var toArchive = [];   // { row, vals }
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][1] || '').trim();
    if (!id) continue;
    var trk = String(data[i][TRACKING_COL - 1] || '').trim();
    if (trk || shippedSet[id]) {
      if (!trk && trackMap[id]) data[i][TRACKING_COL - 1] = trackMap[id]; // fill tracking if we have it
      toArchive.push({ row: i + 2, vals: data[i] });
    }
  }
  if (!toArchive.length) { Logger.log('archiveShipped: nothing to archive'); return; }

  var completed = ss.getSheetByName(COMPLETED_NAME);
  if (!completed) {
    completed = ss.insertSheet(COMPLETED_NAME);
    completed.getRange(1, 1, 1, COLS).setValues([HEADERS]).setFontWeight('bold');
    completed.setFrozenRows(1);
  }
  toArchive.sort(function (a, b) { return b.row - a.row; });   // delete bottom-up
  toArchive.forEach(function (item) {
    completed.getRange(completed.getLastRow() + 1, 1, 1, COLS).setValues([item.vals]);
    sh.deleteRow(item.row);
  });
  Logger.log('archiveShipped: archived ' + toArchive.length + ' shipped line item(s)');
}

// ─── archive cancelled orders (Etsy status=canceled, from RECON col D) → COMPLETED ─

function archiveCancelled() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return;

  // cancelled-id set from the RECON snapshot (col D), if present
  var cancelSet = {};
  var recon = ss.getSheetByName(RECON_NAME);
  if (recon && recon.getLastRow() >= 1) {
    recon.getRange(1, 4, recon.getLastRow(), 1).getValues().forEach(function (row) {  // col D
      var id = String(row[0] || '').trim();
      if (id.charAt(0) === '#') cancelSet[id] = true;
    });
  }
  if (!Object.keys(cancelSet).length) return;

  var last = sh.getLastRow();
  if (last < 2) return;
  var data = sh.getRange(2, 1, last - 1, COLS).getValues();

  var toArchive = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][1] || '').trim();
    if (id && cancelSet[id]) { data[i][0] = 'CANCELLED'; toArchive.push({ row: i + 2, vals: data[i] }); }
  }
  if (!toArchive.length) { Logger.log('archiveCancelled: nothing to archive'); return; }

  var completed = ss.getSheetByName(COMPLETED_NAME);
  if (!completed) {
    completed = ss.insertSheet(COMPLETED_NAME);
    completed.getRange(1, 1, 1, COLS).setValues([HEADERS]).setFontWeight('bold');
    completed.setFrozenRows(1);
  }
  toArchive.sort(function (a, b) { return b.row - a.row; });   // delete bottom-up
  toArchive.forEach(function (item) {
    completed.getRange(completed.getLastRow() + 1, 1, 1, COLS).setValues([item.vals]);
    sh.deleteRow(item.row);
  });
  Logger.log('archiveCancelled: archived ' + toArchive.length + ' cancelled line item(s)');
}

// ─── ONE-TIME baseline reset: keep ONLY the authoritative open ids on ORDERS ───

function enforceBaseline() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return;

  var keep = {};
  BASELINE_OPEN_IDS.forEach(function (id) { keep['#' + String(id).replace(/^#/, '').trim()] = true; });

  var last = sh.getLastRow();
  if (last < 2) return;
  var data = sh.getRange(2, 1, last - 1, COLS).getValues();

  var present = {}, toArchive = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][1] || '').trim();
    if (!id) continue;
    present[id] = true;
    if (!keep[id]) toArchive.push({ row: i + 2, vals: data[i] });
  }

  var missing = Object.keys(keep).filter(function (k) { return !present[k]; });
  if (missing.length) Logger.log('enforceBaseline: WARNING ' + missing.length + ' baseline id(s) NOT on ORDERS: ' + missing.join(', '));

  if (toArchive.length) {
    var completed = ss.getSheetByName(COMPLETED_NAME);
    if (!completed) {
      completed = ss.insertSheet(COMPLETED_NAME);
      completed.getRange(1, 1, 1, COLS).setValues([HEADERS]).setFontWeight('bold');
      completed.setFrozenRows(1);
    }
    toArchive.sort(function (a, b) { return b.row - a.row; });
    toArchive.forEach(function (item) {
      completed.getRange(completed.getLastRow() + 1, 1, 1, COLS).setValues([item.vals]);
      sh.deleteRow(item.row);
    });
  }

  buildDashboard();
  Logger.log('enforceBaseline: archived ' + toArchive.length + ' non-baseline row(s); ' +
             missing.length + ' baseline id(s) missing from sheet');
  ss.toast('Baseline set. Archived ' + toArchive.length + ' non-open row(s). ' +
           (missing.length ? missing.length + ' baseline id(s) MISSING — see log.' : 'All 119 present.'),
           'enforceBaseline', 8);
}

// ─── dashboard + mobile HTML ──────────────────────────────────────────────────

function buildDashboard() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  var last = sh.getLastRow();
  var data = last >= 2 ? sh.getRange(2, 1, last - 1, COLS).getValues() : [];

  var lineItems = 0;
  var orderCounts = {}, byStatus = {}, byCombo = {};

  data.forEach(function (row) {
    var id = String(row[1] || '').trim();
    if (!id) return;
    lineItems++;
    orderCounts[id] = (orderCounts[id] || 0) + 1;
    var status = String(row[0] || '').trim() || '(no status)';
    byStatus[status] = (byStatus[status] || 0) + 1;
    var color = String(row[7] || '').trim() || '-';
    var size = String(row[8] || '').trim() || '-';
    var key = _trim(row[3], 30) + ' / ' + color + (size !== '-' ? ' / ' + size : '');
    byCombo[key] = (byCombo[key] || 0) + 1;
  });

  var unique = Object.keys(orderCounts).length;
  var statusList = Object.keys(byStatus).map(function (k) { return [k, byStatus[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  var comboList = Object.keys(byCombo).map(function (k) { return [k, byCombo[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  var updated = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MMM d, h:mm a');

  var dash = ss.getSheetByName(DASH_NAME) || ss.insertSheet(DASH_NAME);
  dash.getRange(1, 1, 1000, 26).clearContent();   // wipe whole tab (clears stale columns from old layouts)

  var rows = [];
  rows.push(['ORDERS DASHBOARD', '']);
  rows.push(['Updated ' + updated, '']);
  rows.push(['', '']);
  rows.push(['Open orders', unique]);
  rows.push(['Open line items', lineItems]);
  rows.push(['', '']);
  var statusHdr = rows.length + 1;
  rows.push(['OPEN ORDERS BY STATUS', 'LINE ITEMS']);
  statusList.forEach(function (s) { rows.push([s[0], s[1]]); });
  rows.push(['', '']);
  var needHdr = rows.length + 1;
  rows.push(['NEED TO ORDER  (item / color / size)', 'QTY']);
  comboList.forEach(function (c) { rows.push([c[0], c[1]]); });

  dash.getRange(1, 1, rows.length, 2).setValues(rows);
  dash.getRange('A1').setFontWeight('bold').setFontSize(14);
  dash.getRange(statusHdr, 1, 1, 2).setFontWeight('bold');
  dash.getRange(needHdr, 1, 1, 2).setFontWeight('bold');
  dash.setColumnWidth(1, 320);

  dash.getRange('Z1').setValue(_mobileHtml({
    openItems: lineItems, unique: unique,
    statusList: statusList, comboList: comboList, updated: updated
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
    card(d.unique, 'OPEN ORDERS', true) + card(d.openItems, 'OPEN LINE ITEMS') + "</div>" +
    "<div style='background:#fff;border-radius:16px;padding:6px 16px;margin-top:14px'>" +
    "<div style='font-size:11px;color:#8e8e93;margin:12px 0 6px'>OPEN ORDERS BY STATUS</div>" + statusRows + "</div>" +
    "<div style='background:#fff;border-radius:16px;padding:6px 16px;margin-top:14px'>" +
    "<div style='font-size:11px;color:#8e8e93;margin:12px 0 6px'>NEED TO ORDER - ALL PRODUCTS</div>" + comboRows + "</div></body>";
}
