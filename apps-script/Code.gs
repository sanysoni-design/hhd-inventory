// HHD Inventory backend v3.4 (v3.3 + auditComplete / audits table / LastAudited): Supabase (PostgreSQL). Columns are CapitalCase (Serial, TicketID, ...).
// Secret key lives in Script Properties (Project Settings > Script properties > SUPABASE_KEY), never in code.
// v3.2: Parallel batch requests for 10x speedup on dispatch/ack operations

const SUPABASE_URL = 'https://johvbodujwcnzgyvwndx.supabase.co';
const SUPABASE_KEY = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
const TOKEN_HOURS = 8, MAX_FAILS = 5, LOCK_SECONDS = 900;
const now_ = () => new Date().toISOString();

function api_(table, method = 'GET', body = null, filter = '') {
  const url = SUPABASE_URL + '/rest/v1/' + table + filter;
  const opts = {
    method, headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    }
  };
  if (body) opts.payload = JSON.stringify(body);
  const r = UrlFetchApp.fetch(url, opts);
  return JSON.parse(r.getContentText());
}

// ponytail: parallel batch requests using UrlFetchApp.fetchAll(). ~10x faster than serial forEach loops.
function apiBatch_(requests) {
  if (!requests || !requests.length) return [];
  const responses = UrlFetchApp.fetchAll(requests);
  return responses.map(r => JSON.parse(r.getContentText()));
}

const usr_ = r => ({ user: String(r.Username).toLowerCase(), name: r.Name, role: String(r.Role).toLowerCase(), site: r.Site, email: r.Email || '' });
const users_ = () => api_('users').map(usr_);
const siteOk_ = (u, s) => u.role === 'admin' || u.site?.trim() === '*' || u.site?.split(',').map(x => x.trim()).includes(s);

/* -------- email templates -------- */
const esc_ = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when_ = s => s ? Utilities.formatDate(new Date(s), 'Asia/Kolkata', 'dd MMM yyyy, HH:mm') : '—';
const TONE_ = { red: 'background:#fee2e2;color:#991b1b;font-weight:600', blue: 'background:#dbeafe;color:#1e40af;font-weight:600', orange: 'background:#ffedd5;color:#9a3412;font-weight:600' };

const mailWrap_ = (title, inner) => `
<div style="background:#f1f5f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
 <div style="max-width:720px;margin:auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
  <div style="background:#4338ca;color:#ffffff;padding:18px 24px">
   <div style="font-size:11px;opacity:.8;letter-spacing:1px">HHD INVENTORY &amp; TICKETING</div>
   <div style="font-size:20px;font-weight:bold;margin-top:4px">${esc_(title)}</div>
  </div>
  <div style="padding:24px;color:#1e293b;font-size:14px">${inner}</div>
  <div style="padding:12px 24px;background:#f8fafc;font-size:11px;color:#64748b">Automated message. Please do not reply.</div>
 </div>
</div>`;
const section_ = (t, inner) => `<h3 style="margin:24px 0 8px;font-size:15px;color:#312e81">${esc_(t)}</h3>${inner}`;
const kv_ = pairs => `<table style="width:100%;border-collapse:collapse">${pairs.map(([k, v]) =>
  `<tr><td style="padding:5px 0;width:150px;color:#64748b">${esc_(k)}</td><td style="padding:5px 0;font-weight:600">${esc_(v)}</td></tr>`).join('')}</table>`;
// rows: [tone, cells]; tone '' = plain, 'red' = missing, 'blue' = new
const grid_ = (heads, rows) => `<table style="width:100%;border-collapse:collapse;font-size:13px">
 <tr>${heads.map(h => `<th style="text-align:left;padding:8px;background:#f1f5f9;color:#475569;font-size:12px;border-bottom:2px solid #cbd5e1">${esc_(h)}</th>`).join('')}</tr>
 ${rows.map(([tone, cells]) => `<tr style="${TONE_[tone] || ''}">${cells.map(c => `<td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc_(c)}</td>`).join('')}</tr>`).join('')}
</table>`;
const stats_ = pairs => `<table style="width:100%;border-collapse:separate;border-spacing:6px 0"><tr>${pairs.map(([k, v, c]) =>
  `<td style="background:#f8fafc;border-radius:8px;padding:12px 4px;text-align:center"><div style="font-size:22px;font-weight:bold;color:${c}">${v}</div><div style="font-size:11px;color:#64748b">${esc_(k)}</div></td>`).join('')}</tr></table>`;
const devRow_ = (devs, s, tone = '') => { const d = devs.find(x => x.Serial === s) || {}; return [tone, [s, d.imei_number || '', `${d.Make || ''} ${d.Model || ''}`.trim()]]; };
const DEV_HEADS = ['Serial', 'IMEI / S.No', 'Make / Model'];
const plain_ = h => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Addresses that receive every HHD mail, whatever the site. Add or remove entries here and redeploy.
const ALWAYS_CC_ = ['sany.soni@shadowfax.in', 'mohd.faizan@shadowfax.in'];

// Emails every user with an address who can access any of the given sites, plus ALWAYS_CC_. Never throws.
function notify_(sites, subject, html) {
  try {
    const to = [...new Set([...ALWAYS_CC_, ...users_().filter(x => x.email && sites.some(s => siteOk_(x, s))).map(x => x.email)])];
    if (to.length) MailApp.sendEmail({ to: to.join(','), subject: '[HHD] ' + subject, htmlBody: html, body: plain_(html) });
  } catch (err) { console.error('notify failed: ' + err); }
}

// j = { id, site, auditor, at, items, missing }
function auditMail_(j) {
  const n = t => j.items.filter(i => i.Type === t).length;
  const age = m => { const s = m.LastAudited || m.LastUpdated; return s ? Math.floor((new Date(j.at) - new Date(s)) / 864e5) : ''; };
  const sec = (t, heads, rows) => rows.length ? section_(t, grid_(heads, rows)) : '';
  const missing = j.missing.map(m => ['red', [m.Serial, m.imei_number || '', `${m.Make} ${m.Model}`, when_(m.LastAudited || m.LastUpdated), age(m)]]);
  const news = j.items.filter(i => i.Type === 'New').map(i => ['blue', [i.Serial, i.imei || '', `${i.Make} ${i.Model}`]]);
  const moved = j.items.filter(i => i.Type === 'Transferred').map(i => ['', [i.Serial, i.imei || '', `${i.Make} ${i.Model}`, i.From]]);
  const found = j.items.map(i => [i.Type === 'New' ? 'blue' : '', [i.Serial, i.imei || '', `${i.Make} ${i.Model}`, i.Type]]);
  return mailWrap_(`Audit ${j.id} completed at ${j.site}`,
    section_('Audit details', kv_([['Location', j.site], ['Auditor', j.auditor], ['Completed', when_(j.at)], ['Audit ID', j.id]])) +
    section_('Summary', stats_([['Scanned', j.items.length, '#312e81'], ['Reconciled', n('Reconciled'), '#166534'], ['New', n('New'), '#1e40af'],
      ['Transferred', n('Transferred'), '#334155'], ['Missing', j.missing.length, '#991b1b'], ['Not working', (j.notWorking || []).length, '#9a3412']])) +
    sec('Missing devices', ['Serial', 'IMEI / S.No', 'Make / Model', 'Last seen', 'Days since'], missing) +
    sec('New devices', DEV_HEADS, news) +
    sec('Transferred in', ['Serial', 'IMEI / S.No', 'Make / Model', 'Came from'], moved) +
    sec('Not-working devices (with fault reason)', ['Serial', 'IMEI / S.No', 'Make / Model', 'Status', 'Fault reason'],
      (j.notWorking || []).map(d => ['orange', [d.Serial, d.imei || '', `${d.Make} ${d.Model}`, d.Status, d.fault || '']])) +
    sec('Reconciled devices', ['Serial', 'IMEI / S.No', 'Make / Model', 'Status', 'Fault reason'],
      j.items.filter(i => i.Type === 'Reconciled').map(i => [i.Status === 'Not-Working' ? 'orange' : '', [i.Serial, i.imei || '', `${i.Make} ${i.Model}`, i.Status, i.fault || '']])) +
    (j.remarks ? section_('Auditor remarks', `<div style="background:#f8fafc;border-left:4px solid #4338ca;padding:12px;white-space:pre-wrap">${esc_(j.remarks)}</div>`) : '') +
    sec('All devices found', ['Serial', 'IMEI / S.No', 'Make / Model', 'Result'], found));
}

function hex_(bytes) { return bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function hash_(salt, pw) {
  let h = salt + pw;
  for (let i = 0; i < 1000; i++) h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt));
  return h;
}

function secret_() {
  const P = PropertiesService.getScriptProperties();
  let s = P.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); P.setProperty('SECRET', s); }
  return s;
}
const sig_ = body => Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_()));

function sign_(o) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(o), Utilities.Charset.UTF_8);
  return body + '.' + sig_(body);
}

function verify_(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || sig_(body) !== sig) return null;
  const t = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
  if (!(t.exp > Date.now())) return null;
  const u = api_('users', 'GET', null, `?Username=eq.${encodeURIComponent(t.user)}`)[0];
  return u ? Object.assign(usr_(u), { exp: t.exp }) : null;
}

function login_(p) {
  const name = String(p.username || '').trim().toLowerCase(), cache = CacheService.getScriptCache(), k = 'fail:' + name;
  if (Number(cache.get(k) || 0) >= MAX_FAILS) return { ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' };
  const r = api_('users', 'GET', null, `?Username=eq.${encodeURIComponent(name)}`)[0];
  const [salt, h] = r ? String(r.PasswordHash).split(':') : ['', ''];
  if (!r || !h || hash_(salt, String(p.password || '')) !== h) {
    cache.put(k, String(Number(cache.get(k) || 0) + 1), LOCK_SECONDS);
    return { ok: false, error: 'Invalid username or password' };
  }
  cache.remove(k);
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  return { ok: true, profile: Object.assign(usr_(r), { token: sign_({ user: name, exp }), exp }) };
}

/* -------- actions -------- */
const need_ = (c, m) => { if (!c) throw new Error(m); };
const admin_ = u => need_(u.role === 'admin', 'Forbidden: admin only');
const STATUSES = ['Working', 'Not-Working', 'In-Transit', 'Handed Over to SS', 'Replacement Received from SS', 'Yet-to-be-find', 'Cannot_be_repaired'];

const ACTIONS = {
  dispatch(p, u) {
    const t = p.ticket || {};
    const serials = [...new Set(String(t.Devices || '').split(',').map(s => s.trim()).filter(Boolean))];
    need_(serials.length, 'No devices in batch');
    need_(t.SenderSite && t.ReceiverSite && t.SenderSite !== t.ReceiverSite, 'Sender and receiver sites must differ');
    need_(siteOk_(u, t.SenderSite), 'Forbidden: not your sender site');
    const rr = api_('users', 'GET', null, `?Username=eq.${encodeURIComponent(String(t.RecipientUser || '').toLowerCase())}`)[0];
    need_(rr, 'Unknown recipient');
    const rcpt = usr_(rr);
    need_(siteOk_(rcpt, t.ReceiverSite), rcpt.name + ' has no access to ' + t.ReceiverSite);

    const devs = getIn_('devices', serials);
    serials.forEach(s => {
      need_(devs.find(x => x.Serial === s), s + ': not in master stock');
      need_(devs.find(x => x.Serial === s).Status !== 'In-Transit', s + ': is already in transit');
      need_(devs.find(x => x.Serial === s).Location === t.SenderSite, s + ': is at "' + devs.find(x => x.Serial === s).Location + '", not ' + t.SenderSite);
    });

    let id;
    do { id = 'TKT-' + ('0000000' + Math.floor(Math.random() * 1e8)).slice(-8); }
    while (api_('tickets', 'GET', null, `?TicketID=eq.${id}`).length);

    const now = now_();
    api_('tickets', 'POST', {
      TicketID: id, SenderSite: t.SenderSite, ReceiverSite: t.ReceiverSite, SenderName: u.name + ' (' + u.user + ')',
      RecipientName: rcpt.name, Action: t.Action || 'Inter-Site Transfer', Devices: serials.join(', '),
      Status: 'Pending Receipt', DispatchDate: now, AckDate: null, AckBy: '', Remarks: t.Remarks || '', RecipientUser: rcpt.user,
    });
    // OPTIMIZED: Parallel batch PATCH requests instead of serial forEach loop
    const batchRequests = serials.map(s => {
      const dev = devs.find(x => x.Serial === s);
      return {
        url: SUPABASE_URL + '/rest/v1/devices?Serial=eq.' + encodeURIComponent(s),
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        payload: JSON.stringify({ Status: 'In-Transit', PrevStatus: dev.Status, Location: 'In-Transit (To: ' + t.ReceiverSite + ')', LastUpdated: now })
      };
    });
    apiBatch_(batchRequests);
    notify_([t.SenderSite, t.ReceiverSite], `Transfer ${id} dispatched (${serials.length} device(s))`,
      mailWrap_(`Transfer ${id} dispatched`,
        section_('Transfer details', kv_([['From', t.SenderSite], ['To', t.ReceiverSite], ['Issued to', `${rcpt.name} (${rcpt.user})`],
          ['Dispatched by', u.name], ['Action', t.Action || 'Inter-Site Transfer'], ['Remarks', t.Remarks || '-']])) +
        section_(`Devices in transit (${serials.length})`, grid_(DEV_HEADS, serials.map(s => devRow_(devs, s)))) +
        '<p style="margin-top:20px;color:#64748b;font-size:12px">The receiving user must acknowledge this transfer in the Pending Receipts tab.</p>'));
    return { ticketId: id, count: serials.length };
  },

  ack(p, u) {
    const o = api_('tickets', 'GET', null, `?TicketID=eq.${encodeURIComponent(p.ticketId)}`)[0];
    need_(o, 'Ticket not found');
    need_(o.Status === 'Pending Receipt', o.TicketID + ' is not pending');
    need_(String(o.RecipientUser).toLowerCase() === u.user, 'Only ' + o.RecipientName + ' (' + o.RecipientUser + ') can acknowledge this ticket');
    need_(siteOk_(u, o.ReceiverSite), 'Forbidden: no access to ' + o.ReceiverSite);

    const now = now_();
    api_('tickets', 'PATCH', { Status: 'Acknowledged', AckDate: now, AckBy: u.name + ' (' + u.user + ')' }, `?TicketID=eq.${encodeURIComponent(o.TicketID)}`);
    const serials = String(o.Devices).split(',').map(s => s.trim()).filter(Boolean);
    const devs = getIn_('devices', serials);
    // OPTIMIZED: Parallel batch PATCH requests instead of serial forEach loop
    const batchRequests = serials.map(s => {
      const dev = devs.find(x => x.Serial === s);
      return {
        url: SUPABASE_URL + '/rest/v1/devices?Serial=eq.' + encodeURIComponent(s),
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        payload: JSON.stringify({ Status: dev?.PrevStatus || 'Working', PrevStatus: null, Location: o.ReceiverSite, LastUpdated: now })
      };
    });
    apiBatch_(batchRequests);
    notify_([o.SenderSite, o.ReceiverSite], `Transfer ${o.TicketID} acknowledged`,
      mailWrap_(`Transfer ${o.TicketID} acknowledged`,
        section_('Transfer details', kv_([['From', o.SenderSite], ['To', o.ReceiverSite], ['Acknowledged by', `${u.name} (${u.user})`],
          ['Acknowledged at', when_(now)], ['Dispatched', when_(o.DispatchDate)]])) +
        section_(`Devices received (${serials.length})`, grid_(DEV_HEADS, serials.map(s => devRow_(devs, s))))));
    return { ticketId: o.TicketID };
  },

  // Manual status change by a user with access to the device's site. Logged to status_log.
  changeStatus(p, u) {
    const s = String(p.serial || '').trim(), st = p.status;
    need_(STATUSES.includes(st) && st !== 'In-Transit', 'Invalid status');
    need_(st !== 'Not-Working' || String(p.fault || '').trim(), 'Fault reason required for Not-Working');
    const d = api_('devices', 'GET', null, `?Serial=eq.${encodeURIComponent(s)}`)[0];
    need_(d, s + ': not found');
    need_(d.Status !== 'In-Transit', s + ' is in transit; it is updated by ticket acknowledgement');
    need_(siteOk_(u, d.Location), 'Forbidden: no access to ' + d.Location);
    need_(d.Status !== st, s + ' is already ' + st);

    const now = now_();
    // log first: a change can never exist without its audit row
    api_('status_log', 'POST', {
      Serial: s, Location: d.Location, OldStatus: d.Status, NewStatus: st, ChangedAt: now, ChangedBy: u.name + ' (' + u.user + ')',
    });
    api_('devices', 'PATCH', { Status: st, FaultReason: st === 'Not-Working' ? String(p.fault).trim() : null, LastUpdated: now }, `?Serial=eq.${encodeURIComponent(s)}`);
    notify_([d.Location], `Status changed: ${s}`,
      mailWrap_(`Status changed: ${s}`,
        section_('Device', kv_([['Serial', s], ['IMEI / S.No', d.imei_number || '-'], ['Make / Model', `${d.Make} ${d.Model}`], ['Site', d.Location]])) +
        section_('Status change', grid_(['Old status', 'New status', 'Fault reason', 'Changed by', 'Changed at'],
          [[st === 'Not-Working' ? 'red' : '', [d.Status, st, st === 'Not-Working' ? String(p.fault).trim() : '-', `${u.name} (${u.user})`, when_(now)]]]))));
    return { serial: s };
  },

  changeStatusBulk(p, u) {
    const sers = [...new Set((p.serials || []).map(s => String(s).trim()).filter(Boolean))], st = p.status;
    need_(sers.length, 'Nothing selected');
    need_(STATUSES.includes(st) && st !== 'In-Transit', 'Invalid status');
    need_(st !== 'Not-Working' || String(p.fault || '').trim(), 'Fault reason required for Not-Working');
    const inList = ss => '?Serial=in.' + encodeURIComponent('(' + ss.map(s => '"' + s + '"').join(',') + ')');
    const devs = getIn_('devices', sers);
    // validate everything first: all-or-nothing
    sers.forEach(s => {
      const d = devs.find(x => x.Serial === s);
      need_(d, s + ': not found');
      need_(d.Status !== 'In-Transit', s + ' is in transit; it is updated by ticket acknowledgement');
      need_(siteOk_(u, d.Location), 'Forbidden: no access to ' + d.Location);
    });
    const todo = devs.filter(d => d.Status !== st), now = now_();
    if (todo.length) {
      // log first (one POST for all rows), then one PATCH for all devices
      api_('status_log', 'POST', todo.map(d => ({ Serial: d.Serial, Location: d.Location, OldStatus: d.Status, NewStatus: st, ChangedAt: now, ChangedBy: u.name + ' (' + u.user + ')' })));
      // PATCH in batches of 40 serials: one URL with hundreds of serials breaks the Apps Script URL limit
      const ts = todo.map(d => d.Serial);
      for (let i = 0; i < ts.length; i += 15) api_('devices', 'PATCH', { Status: st, FaultReason: st === 'Not-Working' ? String(p.fault).trim() : null, LastUpdated: now }, inList(ts.slice(i, i + 15)));
    }
    if (todo.length) notify_([...new Set(todo.map(d => d.Location))], `${todo.length} device(s) status changed to ${st}`,
      mailWrap_(`${todo.length} device(s) status changed to ${st}`,
        section_('Change', kv_([['New status', st], ['Changed by', `${u.name} (${u.user})`], ['Changed at', when_(now)]])) +
        section_('Devices', grid_(['Serial', 'IMEI / S.No', 'Make / Model', 'Location', 'Old status', 'New status', 'Fault reason'],
          todo.map(d => [st === 'Not-Working' ? 'red' : '', [d.Serial, d.imei_number || '-', `${d.Make} ${d.Model}`, d.Location, d.Status, st, st === 'Not-Working' ? String(p.fault).trim() : '-']])))));
    return { count: todo.length };
  },

  // HHD audit: scans are classified client-side; this re-derives each result from the DB, applies it, saves the audit.
  auditComplete(p, u) {
    const site = String(p.site || '').trim();
    need_(site, 'Location required');
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const scanned = [...new Set((p.serials || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
    need_(scanned.length, 'Nothing scanned');
    const inList = ss => '?Serial=in.' + encodeURIComponent('(' + ss.map(s => '"' + s + '"').join(',') + ')');
    const chunk = a => { const o = []; for (let i = 0; i < a.length; i += 15) o.push(a.slice(i, i + 15)); return o; };
    const devs = [].concat(...chunk(scanned).map(c => api_('devices', 'GET', null, inList(c))));
    const by = Object.fromEntries(devs.map(d => [d.Serial, d]));

    // validate everything first: all-or-nothing
    // per-device choices made on the client: status and fault reason (reconciled devices keep theirs unless changed)
    const upd = p.updates || {}, nd = p.newDevices || {};
    const items = scanned.map(s => {
      const d = by[s], c = upd[s] || {};
      need_(!d || d.Status !== 'In-Transit', s + ' is in transit; acknowledge its ticket first');
      need_(d || (nd[s] && nd[s].Make && nd[s].Model), s + ': make and model required for a new device');
      const status = c.status || (d ? d.Status : 'Working');
      need_(STATUSES.includes(status) && status !== 'In-Transit', s + ': invalid status');
      need_(!(d && d.Status === 'Yet-to-be-find') || (c.status && c.status !== 'Yet-to-be-find'), s + ': select the status of this found device');
      const fault = status === 'Not-Working' ? (c.fault || (d && d.Status === 'Not-Working' ? d.FaultReason : '') || '') : '';
      need_(status !== 'Not-Working' || fault, s + ': fault reason required for Not-Working');
      return {
        Serial: s, Make: d ? d.Make : nd[s].Make, Model: d ? d.Model : nd[s].Model, Status: status, prev: d ? d.Status : '',
        oldFault: d ? (d.FaultReason || '') : '', fault,
        From: d && d.Location !== site ? d.Location : '', imei: d ? (d.imei_number || '') : (nd[s].imei || ''),
        Type: !d ? 'New' : d.Location === site ? 'Reconciled' : 'Transferred',
      };
    });
    const of = t => items.filter(i => i.Type === t);
    const now = now_();
    const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' }; // apiBatch_ JSON-parses every reply, so a body is required
    const patch = (ss, body) => chunk(ss).map(c => ({ url: SUPABASE_URL + '/rest/v1/devices' + inList(c), method: 'PATCH', headers: H, payload: JSON.stringify(body) }));

    if (of('New').length) api_('devices', 'POST', of('New').map(i => ({ Serial: i.Serial, imei_number: i.imei || null, Make: i.Make, Model: i.Model, Status: i.Status, FaultReason: i.fault || null, Location: site, LastUpdated: now, LastAudited: now })));
    apiBatch_([
      ...patch(of('Reconciled').map(i => i.Serial), { LastAudited: now }),
      ...patch(of('Transferred').map(i => i.Serial), { Location: site, LastUpdated: now, LastAudited: now }),
    ]);

    // missing = registered at this site (in-transit devices have a different Location string) but not scanned
    const seen = new Set(scanned);
    const missing = api_('devices', 'GET', null, '?select=Serial,imei_number,Make,Model,Status,FaultReason,LastUpdated,LastAudited&Location=eq.' + encodeURIComponent(site)).filter(d => !seen.has(d.Serial));
    const auditor = u.name + ' (' + u.user + ')', id = 'AUD-' + Utilities.getUuid().slice(0, 8).toUpperCase();
    // missing devices become Yet-to-be-find; logged like any other status change (log first)
    const toFind = missing.filter(d => d.Status !== 'Yet-to-be-find');
    if (toFind.length) {
      api_('status_log', 'POST', toFind.map(d => ({ Serial: d.Serial, Location: site, OldStatus: d.Status, NewStatus: 'Yet-to-be-find', ChangedAt: now, ChangedBy: auditor })));
      apiBatch_(patch(toFind.map(d => d.Serial), { Status: 'Yet-to-be-find', LastUpdated: now }));
    }
    // status / fault changes chosen during the audit: status changes are logged first, then all are applied
    const changes = items.filter(i => i.Type !== 'New' && (i.Status !== i.prev || i.fault !== i.oldFault));
    const statusChanges = changes.filter(i => i.Status !== i.prev);
    if (statusChanges.length) api_('status_log', 'POST', statusChanges.map(i => ({ Serial: i.Serial, Location: site, OldStatus: i.prev, NewStatus: i.Status, ChangedAt: now, ChangedBy: auditor })));
    if (changes.length) apiBatch_(changes.map(i => ({
      url: SUPABASE_URL + '/rest/v1/devices?Serial=eq.' + encodeURIComponent(i.Serial), method: 'PATCH', headers: H,
      payload: JSON.stringify({ Status: i.Status, FaultReason: i.Status === 'Not-Working' ? i.fault : null, LastUpdated: now }),
    })));
    // missing devices are stored in the audit too, so the Audit Log can list them
    const missingItems = missing.map(m => ({ Serial: m.Serial, Make: m.Make, Model: m.Model, Status: m.Status, Type: 'Missing', From: '', imei: m.imei_number || '', LastScanned: m.LastAudited || m.LastUpdated || null }));
    api_('audits', 'POST', {
      AuditID: id, Location: site, Auditor: auditor, CompletedAt: now, Items: [...items, ...missingItems],
      Summary: { total: items.length, reconciled: of('Reconciled').length, excess: of('New').length, transferred: of('Transferred').length, missing: missing.length, remarks: String(p.remarks || '').trim() },
    });
    // every not-working device at the site after this audit: scanned ones and missing ones
    const notWorking = [
      ...items.filter(i => i.Status === 'Not-Working').map(i => ({ Serial: i.Serial, imei: i.imei, Make: i.Make, Model: i.Model, Status: i.Status, fault: i.fault })),
      ...missing.filter(m => m.Status === 'Not-Working').map(m => ({ Serial: m.Serial, imei: m.imei_number || '', Make: m.Make, Model: m.Model, Status: m.Status, fault: m.FaultReason || '' })),
    ];
    notify_([site], `Audit ${id} completed at ${site}`, auditMail_({ id, site, auditor, at: now, items, missing, notWorking, remarks: String(p.remarks || '').trim() }));
    return { auditId: id, site, auditor, at: now, items, missing };
  },

  importDevices(p, u) {
    admin_(u);
    const items = p.devices || [];
    need_(items.length, 'Nothing to import');
    const seen = {};
    items.forEach((d, i) => {
      const bad = !d.Serial ? 'missing Serial' : seen[d.Serial] ? 'duplicate Serial' : !d.Make || !d.Model ? 'missing Make/Model'
        : STATUSES.indexOf(d.Status) < 0 ? 'bad Status' : !d.Location ? 'missing Location' : '';
      need_(!bad, 'Row ' + (i + 1) + ' (' + d.Serial + '): ' + bad);
      seen[d.Serial] = 1;
      d.LastUpdated = d.LastUpdated || now_();
    });
    // upsert by Serial: existing devices are updated (Make/Model only when overwrite is set), new ones inserted
    const existing = new Set(api_('devices', 'GET', null, '?select=Serial').map(x => x.Serial));
    const ow = !!p.overwrite;
    const reqs = items.map(d => {
      const fault = d.Status === 'Not-Working' ? (String(d.FaultReason || '').trim() || null) : null;
      const imei = String(d.imei_number || '').trim() || null;
      if (!existing.has(d.Serial)) return { url: SUPABASE_URL + '/rest/v1/devices', method: 'POST', headers: authH_, payload: JSON.stringify({ Serial: d.Serial, imei_number: imei, Make: d.Make, Model: d.Model, Status: d.Status, FaultReason: fault, Location: d.Location, LastUpdated: d.LastUpdated }) };
      const body = { Status: d.Status, FaultReason: fault, Location: d.Location, LastUpdated: d.LastUpdated };
      if (imei) body.imei_number = imei;
      if (ow) { body.Make = d.Make; body.Model = d.Model; }
      return { url: SUPABASE_URL + '/rest/v1/devices?Serial=eq.' + encodeURIComponent(d.Serial), method: 'PATCH', headers: authH_, payload: JSON.stringify(body) };
    });
    apiBatch_(reqs);
    return { count: items.length };
  },

  saveUser(p, u) {
    admin_(u);
    const un = String(p.username || '').trim().toLowerCase(), role = String(p.role || '').toLowerCase();
    need_(/^[a-z0-9._-]{3,32}$/.test(un), 'Username: 3-32 chars, letters/digits . _ -');
    need_(role === 'admin' || role === 'user', 'Role must be admin or user');
    need_(String(p.name || '').trim() && String(p.site || '').trim(), 'Name and Site are required');
    need_(!(un === u.user && role !== 'admin'), 'You cannot remove your own admin role');
    const old = api_('users', 'GET', null, `?Username=eq.${encodeURIComponent(un)}`)[0];
    let stored = old ? old.PasswordHash : '';
    if (p.password) {
      need_(String(p.password).length >= 10, 'Password must be at least 10 characters');
      const salt = Utilities.getUuid().slice(0, 8);
      stored = salt + ':' + hash_(salt, String(p.password));
    }
    need_(stored, 'Password required for a new user');
    const email = String(p.email || '').trim();
    if (old) api_('users', 'PATCH', { Name: p.name.trim(), Role: role, Site: p.site.trim(), PasswordHash: stored, Email: email },
      `?Username=eq.${encodeURIComponent(un)}`);
    else api_('users', 'POST', { Username: un, Name: p.name.trim(), Role: role, Site: p.site.trim(), PasswordHash: stored, Email: email });
    return { user: un };
  },

  addSite(p, u) {
    admin_(u);
    const s = String(p.site || '').trim();
    need_(s, 'Site name required');
    api_('sites', 'POST', { Site: s });
    return { site: s };
  },
};

/* ===== Shift Handover & Custody: backend =====
   Two pastes into Code.gs:
   1. Paste this whole block directly AFTER the closing "};" of const ACTIONS.
   2. In doGet, add these keys to the returned object:
        custody:   api_('device_custody'),
        shifts:    api_('shifts'),
        incidents: api_('incidents', 'GET', null, '?order=OpenedAt.desc&limit=500'),
   Then run setupShiftTrigger() once (Apps Script editor) to start the 5-minute overdue check.
*/

const GRACE_MIN = 15;                 // minutes after shift end before a device is Overdue
const HELD_ = ['issued', 'overdue', 'missing'];
const authH_ = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };

const inListS_ = ss => '?Serial=in.' + encodeURIComponent('(' + ss.map(s => '"' + s + '"').join(',') + ')');
// Apps Script caps URL length (~2 KB); big serial lists are fetched in batches of 40.
const getIn_ = (table, ss) => { const out = []; for (let i = 0; i < ss.length; i += 15) out.push(...api_(table, 'GET', null, inListS_(ss.slice(i, i + 15)))); return out; };
const uniqS_ = a => [...new Set((a || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
const userRow_ = un => { const r = api_('users', 'GET', null, `?Username=eq.${encodeURIComponent(String(un || '').toLowerCase())}`)[0]; return r ? usr_(r) : null; };
// Fixed, location-independent shifts: code -> [label, end time (IST, 24h)].
const SHIFTS_ = { A: ['Shift A', '15:00'], B: ['Shift B', '23:00'], C: ['Shift C', '07:00'], G: ['General', '19:00'] };
// Next occurrence of the shift end after now (IST). Issue happens at shift start, so this is the current shift's end.
const shiftEnd_ = code => {
  const [hh, mm] = SHIFTS_[code][1].split(':');
  const day = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  let end = new Date(day + 'T' + hh + ':' + mm + ':00+05:30');
  if (end <= new Date()) end = new Date(end.getTime() + 864e5);
  return end.toISOString();
};
// Upserts the fixed shift row so FK references from custody, sessions and logs resolve. Returns the row.
const shiftRow_ = code => {
  need_(SHIFTS_[code], 'Invalid shift');
  const row = { Id: code, Site: 'ALL', Name: SHIFTS_[code][0], EndsAt: shiftEnd_(code) };
  const r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/shifts?on_conflict=Id', {
    method: 'POST', muteHttpExceptions: true,
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify(row),
  });
  need_(r.getResponseCode() < 300, 'shift save failed: ' + r.getContentText());
  return row;
};
const newSid_ = () => 'SH-' + Utilities.getUuid().slice(0, 8).toUpperCase();
// Throws on any Supabase error so a failed parent insert stops the save instead of failing later on a foreign key.
const insert_ = (table, rows) => {
  if (!rows.length) return;
  const r = api_(table, 'POST', rows);
  if (r && r.code) throw new Error(table + ': ' + (r.message || r.code) + (r.details ? ' (' + r.details + ')' : ''));
};
const patchDev_ = (serials, body) => serials.map(s => ({ url: SUPABASE_URL + '/rest/v1/devices?Serial=eq.' + encodeURIComponent(s), method: 'PATCH', headers: authH_, payload: JSON.stringify(body) }));

// Upsert on Serial: only the columns given are changed on existing rows.
function upsertCustody_(rows) {
  if (!rows.length) return;
  const r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/device_custody?on_conflict=Serial', {
    method: 'POST', muteHttpExceptions: true,
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify(rows),
  });
  need_(r.getResponseCode() < 300, 'custody save failed: ' + r.getContentText());
}

const SHIFT_ACTIONS_ = {
  // Shift start: issue many devices in one save. assignments: {serial: workerUser}. Each device needs a passing pre-issue inspection.
  shiftIssue(p, u) {
    const site = String(p.site || '').trim();
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const sh = shiftRow_(p.shiftId);
    const who = {};
    Object.entries(p.assignments || {}).forEach(([k, v]) => { who[String(k).trim().toUpperCase()] = String(v || '').trim().toLowerCase(); });
    const serials = uniqS_(Object.keys(who));
    need_(serials.length, 'No devices selected');
    serials.forEach(s => need_(who[s], s + ': pick a worker'));
    const holders = {};
    [...new Set(serials.map(s => who[s]))].forEach(un => {
      const h = userRow_(un);
      need_(h && siteOk_(h, site), 'Worker has no access to ' + site + ': ' + un);
      holders[un] = h;
    });
    const devs = getIn_('devices', serials);
    const cust = getIn_('device_custody', serials);
    const insp = p.inspections || {};
    serials.forEach(s => {
      const d = devs.find(x => x.Serial === s), c = cust.find(x => x.Serial === s);
      if (!d) need_((p.newDevices || {})[s] && (p.newDevices || {})[s].Make && (p.newDevices || {})[s].Model, s + ': not in master list, enter make and model');
      else need_(d.Status === 'Working', s + ': is ' + d.Status + ', cannot issue');
      if (c && HELD_.includes(c.Status)) throw new Error(s + ': still held by ' + c.HolderName + ' (use swap)');
      need_(insp[s] && insp[s].result === 'ok', s + ': pre-issue inspection must pass (red-tag damaged devices)');
    });
    const now = now_(), sess = {};
    // brand-new devices enter the master list at this site; devices from elsewhere move here
    const fresh = serials.filter(s => !devs.find(x => x.Serial === s));
    if (fresh.length) api_('devices', 'POST', fresh.map(s => { const n = p.newDevices[s]; return { Serial: s, imei_number: String(n.imei || '').trim() || null, Make: n.Make, Model: n.Model, Status: 'Working', Location: site, LastUpdated: now }; }));
    const moved = devs.filter(d => d.Location !== site);
    if (moved.length) apiBatch_(patchDev_(moved.map(d => d.Serial), { Location: site, LastUpdated: now }));
    Object.keys(holders).forEach(un => { sess[un] = newSid_(); });
    insert_('handover_sessions', Object.keys(holders).map(un => ({ Id: sess[un], Site: site, ShiftId: sh.Id, Type: 'checkout', WorkerUser: holders[un].user, WorkerName: holders[un].name, SupervisorUser: u.user, Status: 'closed', OpenedAt: now, ClosedAt: now })));
    insert_('device_inspections', serials.map(s => ({ Serial: s, SessionId: sess[who[s]], Phase: 'pre_issue', Result: 'ok', Notes: insp[s].notes || '', InspectedBy: u.user, InspectedAt: now })));
    upsertCustody_(serials.map(s => { const h = holders[who[s]]; return { Serial: s, Site: site, HolderUser: h.user, HolderName: h.name, ShiftId: sh.Id, IssuedAt: now, DueAt: sh.EndsAt, ReturnedAt: null, Status: 'issued' }; }));
    insert_('device_logs', serials.map(s => ({ Serial: s, SessionId: sess[who[s]], Event: 'issued', FromUser: null, ToUser: who[s], Location: site, ShiftId: sh.Id, At: now, ByUser: u.user })));
    return { count: serials.length, workers: Object.keys(holders).length };
  },

  // Shift end: check devices back in. Damaged devices go to maintenance and raise a red-tag incident.
  shiftReturn(p, u) {
    const site = String(p.site || '').trim();
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const serials = uniqS_(p.serials);
    need_(serials.length, 'No devices selected');
    const cust = getIn_('device_custody', serials);
    const devs = getIn_('devices', serials);
    const insp = p.inspections || {};
    serials.forEach(s => {
      const c = cust.find(x => x.Serial === s);
      if (!c || !HELD_.includes(c.Status)) throw new Error(s + ': not issued to anyone');
      need_(insp[s] && insp[s].result, s + ': post-return inspection required');
      need_(insp[s].result !== 'damaged' || String(insp[s].fault || '').trim(), s + ': fault reason required for damaged devices');
    });
    const now = now_(), sid = newSid_();
    const damaged = serials.filter(s => insp[s].result === 'damaged');
    insert_('handover_sessions', [{ Id: sid, Site: site, ShiftId: p.shiftId ? shiftRow_(p.shiftId).Id : null, Type: 'checkin', WorkerUser: null, WorkerName: null, SupervisorUser: u.user, Status: 'closed', OpenedAt: now, ClosedAt: now }]);
    insert_('device_inspections', serials.map(s => ({ Serial: s, SessionId: sid, Phase: 'post_return', Result: insp[s].result, Notes: [insp[s].fault, insp[s].notes].filter(Boolean).join(' - '), InspectedBy: u.user, InspectedAt: now })));
    upsertCustody_(serials.map(s => {
      const c = cust.find(x => x.Serial === s);
      return { Serial: s, Site: site, HolderUser: c.HolderUser, HolderName: c.HolderName, ReturnedAt: now, Status: insp[s].result === 'damaged' ? 'maintenance' : 'returned' };
    }));
    insert_('device_logs', serials.map(s => {
      const c = cust.find(x => x.Serial === s);
      const ev = insp[s].result === 'damaged' ? 'returned_damaged' : ['overdue', 'missing'].includes(c.Status) ? 'returned_late' : 'returned';
      return { Serial: s, SessionId: sid, Event: ev, FromUser: c.HolderUser, ToUser: null, Location: site, ShiftId: c.ShiftId, At: now, ByUser: u.user };
    }));
    if (damaged.length) {
      insert_('status_log', damaged.map(s => ({ Serial: s, Location: site, OldStatus: devs.find(x => x.Serial === s).Status, NewStatus: 'Not-Working', ChangedAt: now, ChangedBy: u.name + ' (' + u.user + ')' })));
      apiBatch_(damaged.flatMap(s => patchDev_([s], { Status: 'Not-Working', FaultReason: insp[s].fault, LastUpdated: now })));
      insert_('incidents', damaged.map(s => ({ Serial: s, Site: site, Type: 'damaged', Severity: 'L2', Status: 'open', OpenedAt: now, RaisedBy: u.user, Notes: insp[s].fault + (insp[s].notes ? ' - ' + insp[s].notes : '') })));
      notify_([site], `${damaged.length} device(s) returned damaged at ${site}`,
        mailWrap_(`Damaged on return: ${site}`, section_('Red-tagged devices', grid_(['Serial', 'Make / Model', 'Fault reason'],
          damaged.map(s => ['red', [s, `${devs.find(x => x.Serial === s).Make} ${devs.find(x => x.Serial === s).Model}`, insp[s].fault]])))));
    }
    return { sessionId: sid, count: serials.length, damaged: damaged.length };
  },

  // Mid-shift: move custody from one worker to another. Due time is unchanged.
  shiftSwap(p, u) {
    const site = String(p.site || '').trim();
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const to = userRow_(p.toUser);
    need_(to && siteOk_(to, site), 'Receiver has no access to ' + site);
    const serials = uniqS_(p.serials);
    need_(serials.length, 'No devices selected');
    const cust = getIn_('device_custody', serials);
    const holders = new Set(serials.map(s => { const c = cust.find(x => x.Serial === s); return c && HELD_.includes(c.Status) ? c.HolderUser : ''; }));
    need_(holders.size === 1 && !holders.has(''), 'Swap needs devices held by one worker');
    const from = [...holders][0];
    need_(from !== to.user, 'Receiver already holds these devices');
    const now = now_(), sid = newSid_();
    insert_('handover_sessions', [{ Id: sid, Site: site, ShiftId: p.shiftId ? shiftRow_(p.shiftId).Id : null, Type: 'swap', WorkerUser: to.user, WorkerName: to.name, SupervisorUser: u.user, Status: 'closed', OpenedAt: now, ClosedAt: now }]);
    upsertCustody_(serials.map(s => { const c = cust.find(x => x.Serial === s); return { Serial: s, Site: site, HolderUser: to.user, HolderName: to.name, Status: c.Status }; }));
    insert_('device_logs', serials.flatMap(s => {
      const c = cust.find(x => x.Serial === s);
      return [
        { Serial: s, SessionId: sid, Event: 'swap_out', FromUser: from, ToUser: to.user, Location: site, ShiftId: c.ShiftId, At: now, ByUser: u.user },
        { Serial: s, SessionId: sid, Event: 'swap_in', FromUser: from, ToUser: to.user, Location: site, ShiftId: c.ShiftId, At: now, ByUser: u.user },
      ];
    }));
    return { sessionId: sid, count: serials.length };
  },

  // Red-tag: any time a device is found damaged. Marks Not-Working with fault and opens an incident.
  flagRedTag(p, u) {
    const site = String(p.site || '').trim();
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const serials = uniqS_(p.serials);
    need_(serials.length, 'No devices selected');
    const devs = getIn_('devices', serials);
    const cust = getIn_('device_custody', serials);
    const insp = p.inspections || {};
    serials.forEach(s => {
      need_(devs.find(x => x.Serial === s), s + ': not in master stock');
      need_(insp[s] && String(insp[s].fault || '').trim(), s + ': fault reason required');
    });
    const now = now_(), sid = newSid_();
    insert_('status_log', serials.filter(s => devs.find(x => x.Serial === s).Status !== 'Not-Working').map(s => ({ Serial: s, Location: site, OldStatus: devs.find(x => x.Serial === s).Status, NewStatus: 'Not-Working', ChangedAt: now, ChangedBy: u.name + ' (' + u.user + ')' })));
    apiBatch_(serials.flatMap(s => patchDev_([s], { Status: 'Not-Working', FaultReason: insp[s].fault, LastUpdated: now })));
    upsertCustody_(cust.filter(c => HELD_.includes(c.Status)).map(c => ({ Serial: c.Serial, Site: site, Status: 'maintenance' })));
    insert_('device_logs', serials.map(s => { const c = cust.find(x => x.Serial === s); return { Serial: s, SessionId: sid, Event: 'flagged', FromUser: c ? c.HolderUser : null, ToUser: null, Location: site, ShiftId: c ? c.ShiftId : null, At: now, ByUser: u.user }; }));
    insert_('incidents', serials.map(s => ({ Serial: s, Site: site, Type: 'red_tag', Severity: 'L2', Status: 'open', OpenedAt: now, RaisedBy: u.user, Notes: insp[s].fault + (insp[s].notes ? ' - ' + insp[s].notes : '') })));
    notify_([site], `${serials.length} device(s) red-tagged at ${site}`,
      mailWrap_(`Red tag: ${site}`, section_('Red-tagged devices', grid_(['Serial', 'Make / Model', 'Fault reason'],
        serials.map(s => ['red', [s, `${devs.find(x => x.Serial === s).Make} ${devs.find(x => x.Serial === s).Model}`, insp[s].fault]])))));
    return { sessionId: sid, count: serials.length };
  },

  // Live reconciliation for one site. "Live" treats issued-but-past-shift-end as overdue without waiting for the trigger.
  shiftReconcile(p, u) {
    const site = String(p.site || '').trim();
    need_(siteOk_(u, site), 'Forbidden: no access to ' + site);
    const now = Date.now();
    const rows = api_('device_custody', 'GET', null, '?Site=eq.' + encodeURIComponent(site) + '&order=DueAt.asc')
      .map(c => ({ ...c, Live: c.Status === 'issued' && new Date(c.DueAt) < now ? 'overdue' : c.Status }));
    const n = (...k) => rows.filter(r => k.includes(r.Live)).length;
    return {
      counts: { issued: n('issued'), returned: n('returned'), overdue: n('overdue', 'missing'), maintenance: n('maintenance') },
      rows,
    };
  },
};
Object.assign(ACTIONS, SHIFT_ACTIONS_);

// Time trigger (every 5 min): issued past shift end + grace becomes Overdue (L1, supervisors).
// Overdue for 60 min more becomes Missing (L2, operations). Emails are sent per site.
function checkOverdue_() {
  const minsPast = c => (Date.now() - new Date(c.DueAt)) / 60000;
  const cust = api_('device_custody', 'GET', null, '?Status=in.(issued,overdue)');
  const toOverdue = cust.filter(c => c.Status === 'issued' && minsPast(c) > GRACE_MIN);
  const toMissing = cust.filter(c => c.Status === 'overdue' && minsPast(c) > 60);
  const now = now_();
  if (toOverdue.length) {
    upsertCustody_(toOverdue.map(c => ({ Serial: c.Serial, Site: c.Site, Status: 'overdue' })));
    insert_('incidents', toOverdue.map(c => ({ Serial: c.Serial, Site: c.Site, Type: 'unreturned', Severity: 'L1', Status: 'open', OpenedAt: now, RaisedBy: 'system', Notes: `Not returned ${Math.round(minsPast(c))} min after shift end (${c.HolderName})` })));
  }
  if (toMissing.length) {
    upsertCustody_(toMissing.map(c => ({ Serial: c.Serial, Site: c.Site, Status: 'missing' })));
    insert_('incidents', toMissing.map(c => ({ Serial: c.Serial, Site: c.Site, Type: 'lost', Severity: 'L2', Status: 'open', OpenedAt: now, RaisedBy: 'system', Notes: `Missing ${Math.round(minsPast(c))} min after shift end (${c.HolderName})` })));
  }
  const changed = [...toOverdue, ...toMissing];
  [...new Set(changed.map(c => c.Site))].forEach(site => {
    const rows = changed.filter(c => c.Site === site).map(c => [c.Status === 'missing' ? 'red' : '', [c.Serial, c.HolderName, c.HolderUser, when_(c.DueAt), c.Status === 'missing' ? 'Missing (L2)' : 'Overdue (L1)']]);
    notify_([site], `${rows.length} device(s) not returned at ${site}`,
      mailWrap_(`Unreturned devices: ${site}`, section_('Not returned after shift end + grace', grid_(['Serial', 'Holder', 'User', 'Shift end', 'Level'], rows))));
  });
}

// Run once from the Apps Script editor.
function setupShiftTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'checkOverdue_').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkOverdue_').timeBased().everyMinutes(5).create();
}

// Bulk users: each row goes through saveUser (upsert by username); failed rows are reported, the rest still save.
Object.assign(ACTIONS, {
  saveUsersBulk(p, u) {
    admin_(u);
    const rows = p.users || [];
    need_(rows.length, 'Nothing to import');
    const errors = [];
    let count = 0;
    rows.forEach((r, i) => {
      try { ACTIONS.saveUser(r, u); count++; }
      catch (err) { errors.push('Row ' + (i + 2) + ' (' + (r.username || '?') + '): ' + err.message); }
    });
    return { count, errors };
  },
});

/* -------- web app -------- */
const out_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

function doGet(e) {
  try {
    const u = verify_(e.parameter.token);
    if (!u) return out_({ ok: false, error: 'auth' });
    return out_({
      ok: true, version: '3.5', devices: api_('devices'), tickets: api_('tickets'),
      users: users_(), sites: api_('sites').map(x => x.Site),
      // admins see every change, others only changes at sites they can access
      audits: api_('audits', 'GET', null, '?select=AuditID,Location,Auditor,CompletedAt,Summary,Items&order=CompletedAt.desc&limit=500'),
      custody: api_('device_custody'),
      shifts: api_('shifts'),
      incidents: api_('incidents', 'GET', null, '?order=OpenedAt.desc&limit=500'),
      logs: api_('device_logs', 'GET', null, '?order=At.desc&limit=2000'),
      statusLog: api_('status_log', 'GET', null, '?order=ChangedAt.desc&limit=1000').filter(l => siteOk_(u, l.Location)),
    });
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.action === 'login') return out_(login_(p));
    const u = verify_(p.token);
    if (!u) return out_({ ok: false, error: 'auth' });
    need_(ACTIONS[p.action], 'Unknown action');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { return out_(Object.assign({ ok: true }, ACTIONS[p.action](p, u))); }
    finally { lock.releaseLock(); }
  } catch (err) { return out_({ ok: false, error: String(err.message || err) }); }
}

// First-time setup only: run once from the Apps Script editor, sign in, change the password, then delete this function.
function seedAdmin() {
  const salt = Utilities.getUuid().slice(0, 8);
  api_('users', 'POST', { Username: 'admin', Name: 'Administrator', Role: 'admin', Site: '*', PasswordHash: salt + ':' + hash_(salt, 'ChangeMe-12345') });
}