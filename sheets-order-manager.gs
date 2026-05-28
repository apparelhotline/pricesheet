/**
 * Etsy Order Manager — Google Apps Script
 *
 * Two operations:
 *   1. archiveCompleted()  — moves completed orders from ORDERS → COMPLETED tab
 *   2. importFromBackup()  — imports orders from "Order backup" tab → ORDERS (no duplicates)
 *   3. runAll()            — runs both in sequence (archive first, then import)
 *
 * HOW TO USE:
 *   1. Open your Google Sheet
 *   2. Extensions → Apps Script
 *   3. Paste this entire file (replace any existing code)
 *   4. Click Save (floppy disk icon)
 *   5. Run "runAll" from the dropdown, or run each function individually
 *   6. First run will ask for permissions — click "Allow"
 *
 * COMPLETED criteria: STATUS column = "COMPLETED"  OR  TRACKING NUMBER column is non-empty
 */

// ─── Main entry points ───────────────────────────────────────────────────────

function runAll() {
  archiveCompleted();
  importFromBackup();
}

// ─── 1. Archive completed orders → COMPLETED tab ─────────────────────────────

function archiveCompleted() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSheet = ss.getSheetByName('ORDERS');
  if (!ordersSheet) {
    SpreadsheetApp.getUi().alert('Could not find "ORDERS" tab.');
    return;
  }

  const lastCol = ordersSheet.getLastColumn();
  const headers = ordersSheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const statusIdx   = headers.findIndex(h => h.toString().trim().toUpperCase() === 'STATUS');
  const trackingIdx = headers.findIndex(h => h.toString().trim().toUpperCase() === 'TRACKING NUMBER');
  const orderIdIdx  = headers.findIndex(h => h.toString().trim().toUpperCase() === 'ORDER ID');

  if (statusIdx < 0 || trackingIdx < 0) {
    SpreadsheetApp.getUi().alert('Could not locate STATUS or TRACKING NUMBER columns in ORDERS.');
    return;
  }

  // Get or create COMPLETED tab
  let completedSheet = ss.getSheetByName('COMPLETED');
  if (!completedSheet) {
    completedSheet = ss.insertSheet('COMPLETED');
    completedSheet.getRange(1, 1, 1, lastCol).setValues([headers]);
    completedSheet.getRange(1, 1, 1, lastCol).setFontWeight('bold');
    completedSheet.setFrozenRows(1);
  }

  // Build a set of ORDER IDs already in COMPLETED (to skip if re-running)
  const completedLastRow = completedSheet.getLastRow();
  const alreadyArchived = new Set();
  if (completedLastRow > 1 && orderIdIdx >= 0) {
    const completedHeaders = completedSheet.getRange(1, 1, 1, completedSheet.getLastColumn()).getValues()[0];
    const completedOrderIdIdx = completedHeaders.findIndex(h => h.toString().trim().toUpperCase() === 'ORDER ID');
    if (completedOrderIdIdx >= 0) {
      completedSheet.getRange(2, completedOrderIdIdx + 1, completedLastRow - 1, 1)
        .getValues()
        .forEach(r => { if (r[0]) alreadyArchived.add(normalizeOrderId(r[0])); });
    }
  }

  const ordersLastRow = ordersSheet.getLastRow();
  if (ordersLastRow < 2) {
    Logger.log('No data rows in ORDERS.');
    return;
  }

  const allData = ordersSheet.getRange(2, 1, ordersLastRow - 1, lastCol).getValues();

  // Find which rows to archive
  const rowsToArchive = []; // 1-indexed sheet row numbers
  allData.forEach((row, i) => {
    const status   = row[statusIdx].toString().trim().toUpperCase();
    const tracking = row[trackingIdx].toString().trim();
    const orderId  = orderIdIdx >= 0 ? normalizeOrderId(row[orderIdIdx]) : '';

    const isComplete = (status === 'COMPLETED') || (tracking !== '');
    const alreadyDone = orderId && alreadyArchived.has(orderId);

    if (isComplete && !alreadyDone) {
      rowsToArchive.push(i + 2); // +2: 1-indexed + header row
    }
  });

  if (rowsToArchive.length === 0) {
    Logger.log('No new completed orders to archive.');
    ss.toast('No completed orders to archive.', 'Archive', 4);
    return;
  }

  // Copy rows to COMPLETED (forward order)
  rowsToArchive.forEach(rowNum => {
    const rowData = ordersSheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
    completedSheet.appendRow(rowData);
  });

  // Delete rows from ORDERS (reverse order to preserve indices)
  for (let i = rowsToArchive.length - 1; i >= 0; i--) {
    ordersSheet.deleteRow(rowsToArchive[i]);
  }

  const msg = `Archived ${rowsToArchive.length} completed order(s) to COMPLETED tab.`;
  Logger.log(msg);
  ss.toast(msg, '✓ Archive complete', 5);
}

// ─── 2. Import from "Order backup" → ORDERS ──────────────────────────────────

function importFromBackup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ordersSheet = ss.getSheetByName('ORDERS');
  if (!ordersSheet) {
    SpreadsheetApp.getUi().alert('Could not find "ORDERS" tab.');
    return;
  }

  // Find the backup tab (try common name variants)
  const candidateNames = ['ORDERS BACKUP', 'Order backup', 'order backup', 'ORDER BACKUP',
                           'Orders Backup', 'Backup', 'BACKUP', 'Order Backup'];
  let backupSheet = null;
  for (const name of candidateNames) {
    backupSheet = ss.getSheetByName(name);
    if (backupSheet) break;
  }

  // If still not found, list all non-ORDERS/COMPLETED sheets for the user
  if (!backupSheet) {
    const allSheets = ss.getSheets()
      .filter(s => !['ORDERS', 'COMPLETED'].includes(s.getName()))
      .map(s => s.getName());
    if (allSheets.length === 0) {
      SpreadsheetApp.getUi().alert('No backup sheet found. Only ORDERS and COMPLETED exist.');
      return;
    }
    // Auto-pick the first non-ORDERS, non-COMPLETED sheet
    backupSheet = ss.getSheetByName(allSheets[0]);
    Logger.log(`Using sheet "${allSheets[0]}" as backup source.`);
  }

  Logger.log(`Backup sheet: "${backupSheet.getName()}"`);

  // ORDERS column headers
  const ordersLastCol = ordersSheet.getLastColumn();
  const ordersHeaders = ordersSheet.getRange(1, 1, 1, ordersLastCol).getValues()[0];
  const ordersOrderIdIdx = ordersHeaders.findIndex(h => h.toString().trim().toUpperCase() === 'ORDER ID');
  if (ordersOrderIdIdx < 0) {
    SpreadsheetApp.getUi().alert('ORDER ID column not found in ORDERS tab.');
    return;
  }

  // Collect existing ORDER IDs already in ORDERS
  const existingIds = new Set();
  const ordersLastRow = ordersSheet.getLastRow();
  if (ordersLastRow > 1) {
    ordersSheet.getRange(2, ordersOrderIdIdx + 1, ordersLastRow - 1, 1)
      .getValues()
      .forEach(r => { if (r[0]) existingIds.add(normalizeOrderId(r[0])); });
  }

  // Also collect IDs already in COMPLETED so we don't re-import shipped orders
  const completedSheet = ss.getSheetByName('COMPLETED');
  if (completedSheet && completedSheet.getLastRow() > 1) {
    const cHeaders = completedSheet.getRange(1, 1, 1, completedSheet.getLastColumn()).getValues()[0];
    const cOrderIdIdx = cHeaders.findIndex(h => h.toString().trim().toUpperCase() === 'ORDER ID');
    if (cOrderIdIdx >= 0) {
      completedSheet.getRange(2, cOrderIdIdx + 1, completedSheet.getLastRow() - 1, 1)
        .getValues()
        .forEach(r => { if (r[0]) existingIds.add(normalizeOrderId(r[0])); });
    }
  }

  Logger.log(`Existing ORDER IDs (ORDERS + COMPLETED): ${existingIds.size}`);

  // Backup tab headers
  const backupLastCol = backupSheet.getLastColumn();
  const backupHeaders = backupSheet.getRange(1, 1, 1, backupLastCol).getValues()[0];
  Logger.log('Backup headers: ' + JSON.stringify(backupHeaders));

  const backupOrderIdIdx = backupHeaders.findIndex(h => h.toString().trim().toUpperCase() === 'ORDER ID');
  if (backupOrderIdIdx < 0) {
    SpreadsheetApp.getUi().alert(`No "ORDER ID" column found in "${backupSheet.getName()}". ` +
      `Headers found: ${backupHeaders.filter(h => h).join(', ')}`);
    return;
  }

  // Map each ORDERS column to its source column in backup (by header name, case-insensitive)
  const colMap = ordersHeaders.map(ordersHeader => {
    const normalized = ordersHeader.toString().trim().toUpperCase();
    return backupHeaders.findIndex(bh => bh.toString().trim().toUpperCase() === normalized);
  });
  Logger.log('Column map (ORDERS→backup): ' + JSON.stringify(colMap));

  // Import backup rows
  const backupLastRow = backupSheet.getLastRow();
  if (backupLastRow < 2) {
    Logger.log('No data in backup sheet.');
    ss.toast('Backup sheet is empty.', 'Import', 4);
    return;
  }

  const backupData = backupSheet.getRange(2, 1, backupLastRow - 1, backupLastCol).getValues();
  let imported = 0;
  let skipped = 0;

  backupData.forEach(row => {
    const rawId = row[backupOrderIdIdx];
    if (!rawId || rawId.toString().trim() === '') { skipped++; return; }

    const orderId = normalizeOrderId(rawId);
    if (existingIds.has(orderId)) { skipped++; return; }

    // Build new row aligned to ORDERS columns
    const newRow = ordersHeaders.map((_, i) => {
      const srcIdx = colMap[i];
      return srcIdx >= 0 ? row[srcIdx] : '';
    });

    ordersSheet.appendRow(newRow);
    existingIds.add(orderId); // prevent within-backup duplicates
    imported++;
  });

  const msg = `Import complete: ${imported} new order(s) added, ${skipped} already existed or skipped.`;
  Logger.log(msg);
  ss.toast(msg, '✓ Import complete', 6);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function normalizeOrderId(id) {
  return id.toString().trim().replace(/^#/, '').trim();
}
