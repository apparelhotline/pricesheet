/**
 * Orders Mobile Dashboard — Google Apps Script Web App
 *
 * Serves a mobile-first (iPhone-friendly) dashboard that mirrors the DASHBOARD tab,
 * reading live from the ORDERS tab.
 *
 * HOW TO DEPLOY (one-time, ~1 min):
 *   1. Open your Google Sheet → Extensions → Apps Script
 *   2. Add a new script file (＋ → Script), name it "MobileDashboard", paste this whole file
 *   3. Click Save (floppy disk)
 *   4. Click "Deploy" (top-right) → "New deployment"
 *   5. Gear icon → select type "Web app"
 *   6. Description: "Orders Mobile Dashboard"
 *      Execute as:  Me
 *      Who has access:  Anyone with the link  (or "Anyone in <your org>")
 *   7. Click "Deploy" → authorize when asked (click Allow)
 *   8. Copy the "Web app" URL — that's your iPhone link.
 *
 * ON IPHONE: open the link in Safari → Share → "Add to Home Screen" for an app icon.
 * To refresh the numbers, just reload the page (it also auto-refreshes every 2 min).
 */

var SPREADSHEET_ID = '1ysZPOFHIwNATn8rrUwiy9Y-G3-nbDwcUxMxoMUXTTys';

function doGet() {
  var data = getDashboardData();
  return HtmlService.createHtmlOutput(renderHtml(data))
    .setTitle('Orders Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-status-bar-style', 'black-translucent');
}

// ─── Data ────────────────────────────────────────────────────────────────────

function getDashboardData() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('ORDERS');
  var values = sheet.getDataRange().getValues();
  var headers = values.shift().map(function (h) { return h.toString().trim().toUpperCase(); });

  function col(name) { return headers.indexOf(name); }
  var iStatus = col('STATUS') >= 0 ? col('STATUS') : 0;
  var iOrder  = col('ORDER ID') >= 0 ? col('ORDER ID') : 1;
  var iItem   = col('ITEM NAME') >= 0 ? col('ITEM NAME') : 3;
  var iColor  = col('COLOR') >= 0 ? col('COLOR') : 7;
  var iSize   = col('SIZE') >= 0 ? col('SIZE') : 8;
  var iAdded  = col('ADDED') >= 0 ? col('ADDED') : 16;

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var lineItems = 0, mockneck = 0, addedToday = 0;
  var orderCounts = {};        // orderId -> count
  var byStatus = {};           // status -> line items
  var mockByCombo = {};        // "SIZE|COLOR" -> qty
  var blankStatusIds = [];     // order ids with no status

  values.forEach(function (row) {
    var orderId = (row[iOrder] || '').toString().trim();
    if (!orderId) return;       // skip rows without an order id (e.g. blank / probe rows)
    lineItems++;

    orderCounts[orderId] = (orderCounts[orderId] || 0) + 1;

    var status = (row[iStatus] || '').toString().trim();
    var statusKey = status === '' ? '(no status)' : status.toUpperCase();
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
    if (status === '') blankStatusIds.push(orderId);

    var item = (row[iItem] || '').toString().toUpperCase();
    if (item.indexOf('MOCK') >= 0) {
      mockneck++;
      var size = (row[iSize] || '—').toString().trim().toUpperCase() || '—';
      var color = (row[iColor] || '—').toString().trim().toUpperCase() || '—';
      var key = size + '|' + color;
      mockByCombo[key] = (mockByCombo[key] || 0) + 1;
    }

    var added = (row[iAdded] || '').toString();
    if (added.indexOf(today) === 0) addedToday++;
  });

  var uniqueOrders = Object.keys(orderCounts).length;
  var multiOrders = Object.keys(orderCounts).filter(function (k) { return orderCounts[k] > 1; }).length;

  var statusList = Object.keys(byStatus).map(function (k) {
    return { status: k, count: byStatus[k] };
  }).sort(function (a, b) { return b.count - a.count; });

  var mockList = Object.keys(mockByCombo).map(function (k) {
    var parts = k.split('|');
    return { size: parts[0], color: parts[1], qty: mockByCombo[k] };
  }).sort(function (a, b) { return b.qty - a.qty; });

  var openLineItems = lineItems - (byStatus['COMPLETED'] || 0);

  return {
    lineItems: lineItems,
    uniqueOrders: uniqueOrders,
    multiOrders: multiOrders,
    mockneck: mockneck,
    addedToday: addedToday,
    openLineItems: openLineItems,
    completed: byStatus['COMPLETED'] || 0,
    blankStatus: blankStatusIds.length,
    statusList: statusList,
    mockList: mockList,
    refreshed: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, h:mm a')
  };
}

// ─── View ──────────────────────────────────────────────────────────────────

function statusColor(status) {
  var map = {
    'NEW': '#0a84ff',
    'IN PRODUCTION': '#ff9f0a',
    'ART & STITCH': '#bf5af2',
    'RAUL EMBROIDERY': '#30d158',
    'ALFREDO DTG': '#64d2ff',
    'SEND MOCKUP': '#ff375f',
    'COMPLETED': '#8e8e93',
    '(NO STATUS)': '#ff453a'
  };
  return map[status] || '#636366';
}

function esc(s) {
  return s.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(d) {
  var statusRows = d.statusList.map(function (s) {
    var c = statusColor(s.status);
    return '<div class="row">' +
      '<span class="pill" style="background:' + c + '1f;color:' + c + '">' + esc(s.status) + '</span>' +
      '<span class="num">' + s.count + '</span>' +
      '</div>';
  }).join('');

  var mockRows = d.mockList.map(function (m) {
    return '<div class="row">' +
      '<span class="lbl">' + esc(m.size) + ' &middot; ' + esc(m.color) + '</span>' +
      '<span class="num">' + m.qty + '</span>' +
      '</div>';
  }).join('') || '<div class="empty">No mockneck items</div>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<style>' +
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}' +
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;' +
    'background:#f2f2f7;color:#1c1c1e;padding:0 0 40px;-webkit-font-smoothing:antialiased}' +
  '.hdr{padding:54px 20px 16px;background:linear-gradient(135deg,#0a84ff,#5e5ce6);color:#fff;' +
    'border-radius:0 0 24px 24px;position:sticky;top:0;z-index:5}' +
  '.hdr h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.4px}' +
  '.hdr p{margin:4px 0 0;font-size:13px;opacity:.85}' +
  '.wrap{padding:16px}' +
  '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}' +
  '.card{background:#fff;border-radius:18px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}' +
  '.card .big{font-size:34px;font-weight:700;letter-spacing:-1px;line-height:1}' +
  '.card .cap{font-size:12px;color:#8e8e93;margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}' +
  '.card.full{grid-column:1 / -1}' +
  '.accent .big{color:#0a84ff}' +
  '.warn .big{color:#ff9f0a}' +
  '.alert .big{color:#ff453a}' +
  '.section{background:#fff;border-radius:18px;padding:6px 16px;margin-top:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}' +
  '.section h2{font-size:13px;color:#8e8e93;text-transform:uppercase;letter-spacing:.4px;margin:14px 0 6px}' +
  '.row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #f2f2f7}' +
  '.row:last-child{border-bottom:none}' +
  '.pill{font-size:13px;font-weight:600;padding:5px 11px;border-radius:20px}' +
  '.lbl{font-size:15px;color:#1c1c1e}' +
  '.num{font-size:17px;font-weight:700}' +
  '.empty{padding:14px 0;color:#8e8e93;font-size:14px}' +
  '.foot{text-align:center;color:#aeaeb2;font-size:12px;margin-top:24px}' +
  '.refresh{display:block;margin:18px auto 0;background:#0a84ff;color:#fff;border:none;' +
    'font-size:16px;font-weight:600;padding:13px 0;width:calc(100% - 32px);border-radius:14px}' +
  '</style>' +
  '<div class="hdr"><h1>Orders Dashboard</h1><p>Updated ' + esc(d.refreshed) + '</p></div>' +
  '<div class="wrap">' +
    '<div class="grid">' +
      '<div class="card accent"><div class="big">' + d.openLineItems + '</div><div class="cap">Open line items</div></div>' +
      '<div class="card"><div class="big">' + d.uniqueOrders + '</div><div class="cap">Unique orders</div></div>' +
      '<div class="card"><div class="big">' + d.lineItems + '</div><div class="cap">Total line items</div></div>' +
      '<div class="card"><div class="big">' + d.multiOrders + '</div><div class="cap">Multi-item orders</div></div>' +
      '<div class="card"><div class="big">' + d.mockneck + '</div><div class="cap">Mockneck items</div></div>' +
      '<div class="card warn"><div class="big">' + d.addedToday + '</div><div class="cap">Added today</div></div>' +
    '</div>' +
    (d.blankStatus > 0 ? '<div class="card alert full" style="margin-top:8px"><div class="big">' + d.blankStatus +
      '</div><div class="cap">Line items with no status — need triage</div></div>' : '') +
    '<div class="section"><h2>Open orders by status</h2>' + statusRows + '</div>' +
    '<div class="section"><h2>Mocknecks by size &amp; color</h2>' + mockRows + '</div>' +
    '<button class="refresh" onclick="location.reload()">↻ Refresh</button>' +
    '<div class="foot">Live from the ORDERS tab</div>' +
  '</div>' +
  '<script>setTimeout(function(){location.reload()},120000);</script>' +
  '</body></html>';
}
