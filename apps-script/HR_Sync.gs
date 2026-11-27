/**
 * HHD HR TL/GC Worker Master Synchronization
 * Add this as a NEW .gs file in the existing Apps Script project.
 * It does not replace or modify the current Code.gs web-app backend.
 *
 * Required Script Properties:
 *   HR_SPREADSHEET_ID     Google Sheet ID (from the HR-owned spreadsheet URL)
 *   HR_SHEET_NAME         Exact tab name containing the current TL/GC master
 *   HR_SYNC_ENDPOINT      https://<project-ref>.supabase.co/functions/v1/hr-sync-workers
 *   HR_SYNC_SECRET_KEY    Dedicated Supabase secret key named `hr_sync` (sent only as apikey header)
 *
 * Optional Script Properties:
 *   HR_SYNC_FULL_SNAPSHOT  true only when this tab is the complete HR TL/GC population
 *   HR_SYNC_MIN_ROWS       This must also be configured as Supabase Edge Function secret HR_SYNC_MIN_ROWS
 *   HR_SYNC_HEADER_ROW     Header row number; default 1
 *
 * Required headers (aliases are accepted):
 *   EmployeeID | Name | WorkerType (TL/GC) | Site | Process | Status | UpdatedAt
 */

function syncHrWorkersToSupabase() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('HR_SPREADSHEET_ID');
  const sheetName = props.getProperty('HR_SHEET_NAME');
  const endpoint = props.getProperty('HR_SYNC_ENDPOINT');
  const secretKey = props.getProperty('HR_SYNC_SECRET_KEY');
  const headerRow = Math.max(1, Number(props.getProperty('HR_SYNC_HEADER_ROW') || 1));
  const fullSnapshot = String(props.getProperty('HR_SYNC_FULL_SNAPSHOT') || 'false').toLowerCase() === 'true';

  if (!spreadsheetId || !sheetName || !endpoint || !secretKey) {
    throw new Error('Set HR_SPREADSHEET_ID, HR_SHEET_NAME, HR_SYNC_ENDPOINT and HR_SYNC_SECRET_KEY in Script Properties.');
  }

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('HR worker sheet tab not found: ' + sheetName);

  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < headerRow + 1) throw new Error('HR sheet has no worker rows. Empty snapshot was not sent.');

  const headers = values[headerRow - 1].map(h => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const index = {};
  headers.forEach((h, i) => { if (h) index[h] = i; });

  const col = (aliases, required) => {
    for (const alias of aliases) {
      const key = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (index[key] !== undefined) return index[key];
    }
    if (required) throw new Error('Missing required HR sheet column. Accepted header: ' + aliases[0]);
    return -1;
  };

  const cEmployee = col(['EmployeeID', 'Employee ID', 'Employee Id', 'Worker ID'], true);
  const cName = col(['Name', 'Employee Name', 'Full Name', 'Worker Name'], true);
  const cType = col(['WorkerType', 'Worker Type', 'Type', 'Category'], true);
  const cSite = col(['Site', 'Site Name', 'Location', 'Branch'], true);
  const cProcess = col(['Process', 'Function', 'Department'], false);
  const cStatus = col(['Status', 'CurrentStatus', 'Employment Status', 'Worker Status'], true);
  const cUpdated = col(['UpdatedAt', 'Updated At', 'Last Updated', 'Modified At'], false);
  // Read the date column as native cell values once. Display strings vary by locale and are not
  // safe to cast to timestamptz in PostgreSQL. Native Date values are serialized as ISO-8601.
  const updatedValues = cUpdated >= 0
    ? sheet.getRange(headerRow + 1, cUpdated + 1, values.length - headerRow, 1).getValues()
    : null;

  const rows = [];
  const seen = {};
  const errors = [];
  for (let r = headerRow; r < values.length; r++) {
    const line = values[r];
    if (!line.some(v => String(v || '').trim())) continue;

    const employeeId = String(line[cEmployee] || '').trim().toUpperCase();
    const name = String(line[cName] || '').trim();
    const workerType = String(line[cType] || '').trim().toUpperCase();
    const site = String(line[cSite] || '').trim();
    const process = cProcess >= 0 ? String(line[cProcess] || '').trim() : '';
    const statusRaw = String(line[cStatus] || '').trim().toUpperCase();
    const updatedRaw = cUpdated >= 0 ? updatedValues[r - headerRow][0] : null;
    let updatedAt = null;
    if (updatedRaw instanceof Date && !isNaN(updatedRaw.getTime())) {
      updatedAt = updatedRaw.toISOString();
    } else if (updatedRaw !== null && updatedRaw !== undefined && String(updatedRaw).trim() !== '') {
      const parsedDate = new Date(String(updatedRaw));
      if (!isNaN(parsedDate.getTime())) updatedAt = parsedDate.toISOString();
    }

    if (!employeeId || !name || !site) {
      errors.push('Row ' + (r + 1) + ': Employee ID, Name and Site are required.');
      continue;
    }
    if (workerType !== 'TL' && workerType !== 'GC') {
      errors.push('Row ' + (r + 1) + ': Worker Type must be TL or GC.');
      continue;
    }
    let status;
    if (['ACTIVE', 'LIVE', 'YES', '1', 'WORKING'].includes(statusRaw)) status = 'active';
    else if (['INACTIVE', 'LEFT', 'EXITED', 'DISABLED', 'NO', '0'].includes(statusRaw)) status = 'inactive';
    else {
      errors.push('Row ' + (r + 1) + ': Status must be Active/Live or Inactive/Left.');
      continue;
    }
    if (seen[employeeId]) {
      errors.push('Duplicate Employee ID ' + employeeId + ' at rows ' + seen[employeeId] + ' and ' + (r + 1) + '.');
      continue;
    }
    seen[employeeId] = r + 1;
    rows.push({
      employee_id: employeeId,
      worker_type: workerType,
      employee_name: name,
      site_code: site,
      process: process || null,
      employment_status: status,
      source_updated_at: updatedAt,
    });
  }

  if (errors.length) throw new Error('HR sync blocked. Fix the sheet before sending:\n' + errors.slice(0, 30).join('\n'));
  if (!rows.length) throw new Error('No valid TL/GC worker records found. Empty sync blocked.');

  const checksum = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(rows),
    Utilities.Charset.UTF_8
  ).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');

  const payload = {
    rows: rows,
    snapshot_complete: fullSnapshot,
    checksum: checksum,
  };

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: secretKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    console.error('HHD HR sync failed (' + code + '): ' + body);
    throw new Error('HHD HR sync failed (' + code + '): ' + body.slice(0, 1000));
  }

  const result = JSON.parse(body);
  console.log('HHD HR sync completed: ' + JSON.stringify(result));
  return result;
}

/** Run manually once to create an hourly sync trigger. */
function setupHrWorkerSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncHrWorkersToSupabase') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncHrWorkersToSupabase').timeBased().everyHours(1).create();
  console.log('Hourly HR worker sync trigger created.');
}

/** Optional helper to remove the hourly trigger. */
function removeHrWorkerSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncHrWorkersToSupabase') ScriptApp.deleteTrigger(trigger);
  });
}
