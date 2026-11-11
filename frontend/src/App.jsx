import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  LayoutDashboard, Inbox, ScanLine, Boxes, ClipboardList, Settings, RefreshCw, ShieldCheck,
  X, Search, Truck, CheckCircle2, AlertTriangle, User, MapPin, Trash2, Send, LogOut, Lock, Upload,
  ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown, History, ClipboardCheck, FileDown, ScrollText, Repeat, Undo2, ArrowRightLeft, Flag, ListChecks,
} from 'lucide-react';

// @csv-start (pure helpers; tested by csv.test.mjs)
const STATUSES = ['Working', 'Not-Working', 'In-Transit', 'Handed Over to SS', 'Replacement Received from SS', 'Yet-to-be-find', 'Cannot_be_repaired'];
const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.toLowerCase().replace(/[^a-z]/g, ''), s]));
const normStatus = (s) => STATUS_BY_KEY[String(s).toLowerCase().replace(/[^a-z]/g, '')];

// Small RFC-4180 parser: handles quotes, "" escapes and newlines inside quoted cells.
function parseCSV(text) {
  const rows = []; let r = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; r.push(f); f = ''; rows.push(r); r = []; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows.filter((x) => x.some((v) => v.trim()));
}

// Accepts (a) Serial,Make,Model,Status,Location[,LastUpdated]  or (b) aggregated Site,HHD Make,HHD Model,status,Quantity
// (b) generates serials HHD-<n> continuing after the highest existing one.
function toDevices(rows, existing = []) {
  const [h = [], ...body] = rows;
  const col = Object.fromEntries(h.map((x, i) => [x.trim().toLowerCase(), i]));
  const get = (r, ...names) => { for (const n of names) if (col[n] !== undefined) return (r[col[n]] || '').trim(); return ''; };
  const out = [], errors = [], seen = new Set(), now = new Date().toISOString();
  const place = (r) => get(r, 'location', 'site').split('\n')[0].trim();
  const push = (d, line) => {
    const bad = !d.Serial ? 'missing serial' : seen.has(d.Serial) ? `duplicate serial ${d.Serial}` : !d.Make || !d.Model ? 'missing make/model'
      : !d.Status ? `unknown status "${d.raw}"` : !d.Location ? 'missing location' : '';
    if (bad) { errors.push(`Row ${line}: ${bad}`); return; }
    seen.add(d.Serial); delete d.raw; out.push(d);
  };
  if (col.serial !== undefined) {
    body.forEach((r, i) => {
      const raw = get(r, 'status'), imei = get(r, 'imei_number', 'imei', 'imei number');
      push({ Serial: get(r, 'serial').toUpperCase(), ...(imei && { imei_number: imei }), Make: get(r, 'make', 'hhd make'), Model: get(r, 'model', 'hhd model'), Status: normStatus(raw), Location: place(r), LastUpdated: get(r, 'lastupdated') || now, raw }, i + 2);
    });
  } else if (col.quantity !== undefined) {
    let n = existing.reduce((m, d) => Math.max(m, Number((/^HHD-(\d+)$/.exec(d.Serial) || [])[1] || 0)), 1000);
    body.forEach((r, i) => {
      const q = parseInt(get(r, 'quantity'), 10), raw = get(r, 'status');
      if (!(q > 0)) { errors.push(`Row ${i + 2}: bad quantity`); return; }
      for (let k = 0; k < q; k++) push({ Serial: `HHD-${++n}`, Make: get(r, 'make', 'hhd make'), Model: get(r, 'model', 'hhd model'), Status: normStatus(raw), Location: place(r), LastUpdated: now, raw }, i + 2);
    });
  } else errors.push('Unrecognised header. Need Serial,Make,Model,Status,Location  or  Site,HHD Make,HHD Model,status,Quantity');
  return { out, errors };
}
// @csv-end

// Backend URL: baked in at build time (Vercel env var VITE_API_URL). Admins may override it in the Config tab.
const DEFAULT_URL = import.meta.env.VITE_API_URL || '';
const ACTIONS = ['Inter-Site Transfer', 'Handover to Service Support', 'Replacement Return from Service Support'];
const BADGE = {
  Working: 'bg-green-100 text-green-800',
  'Not-Working': 'bg-red-100 text-red-800',
  'In-Transit': 'bg-amber-100 text-amber-800',
  'Handed Over to SS': 'bg-purple-100 text-purple-800',
  'Replacement Received from SS': 'bg-blue-100 text-blue-800',
  'Yet-to-be-find': 'bg-gray-200 text-gray-800',
  'Pending Receipt': 'bg-amber-100 text-amber-800',
  'Cannot_be_repaired': 'bg-orange-100 text-orange-800',
  Acknowledged: 'bg-green-100 text-green-800',
};
const TABS = [
  ['dash', 'Dashboard Matrix', LayoutDashboard],
  ['pending', 'Pending Receipts', Inbox],
  ['dispatch', 'Batch Dispatch & Issue', ScanLine],
  ['master', 'Master Inventory', Boxes],
  ['audit', 'Ticket Audit Trail', ClipboardList],
  ['log', 'Status Log', History],
  ['hhdaudit', 'HHD Audit', ClipboardCheck],
  ['auditlog', 'Audit Log', ScrollText],
  ['shift', 'Shift Handover', Repeat],
];
const ADMIN_TABS = [['config', 'Config', Settings], ['admin', 'Admin', ShieldCheck]];

const ls = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const fmt = (s) => (s ? new Date(s).toLocaleString() : '—');
const inTransit = (d) => d.Status === 'In-Transit';
const uniq = (a) => [...new Set(a)].filter(Boolean).sort();
const serialsOf = (t) => String(t.Devices || '').split(',').map((s) => s.trim()).filter(Boolean);
const rowKey = (d) => (inTransit(d) ? 'In-Transit' : d.Location); // in-transit devices share one matrix row
const siteList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const hasSite = (u, s) => u.role === 'admin' || u.site.trim() === '*' || siteList(u.site).includes(s);
const avail = (c) => c.Working + c['Not-Working'] + c['Replacement Received from SS'];
const EDITABLE = STATUSES.filter((s) => s !== 'In-Transit'); // In-Transit is only set by tickets
const STATUS_CHOICES = EDITABLE.filter((s) => s !== 'Yet-to-be-find'); // what an auditor picks for a found device
const OTHER = 'Other (Requires Note)';
const FAULTS = [
  'Cracked / Shattered Screen', 'Unresponsive Touchscreen / Keypad', 'Scratched / Damaged Scan Lens Window', 'Broken/damaged Casing',
  'Battery Failure (Not Charging / Swollen / Rapid Drain)', 'Charging Port / Dock Pin Damage', 'Loose / Broken Scan Trigger',
  'Liquid / Water Ingress', 'Wi-Fi / Connectivity Issue', 'Software / WMS App Freeze', 'Crush Damage',
  'Faded / Patchy Print Quality', 'White Lines on Print (Burned-out Printhead)', 'Scratched / Damaged Thermal Printhead',
  'Label Jam / Paper Wrapped Around Platen Roller', 'Worn / Grooved Platen Roller', 'Gap / Sensor Failure (Continuous Blank Labels Feeding)',
  'Broken Media Cover Latch / Door Handle', 'Bluetooth Disconnection / Loss of Pairing', 'Print Job Frozen / Stalled Transmission',
  'Battery Failure (Rapid Drain / Swollen / Loose)', 'Charging Port / DC Barrel Jack Damaged', 'Cracked / Shattered Outer Housing',
  'Missing / Broken Belt Clip or Shoulder Strap', OTHER,
];
const faultText = (f, note) => (f === OTHER ? `Other: ${note.trim()}` : f);

// text/plain avoids the CORS preflight that Apps Script cannot answer
async function api(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

const Badge = ({ s }) => <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${BADGE[s] || 'bg-gray-100'}`}>{s}</span>;
const Card = ({ children, className = '' }) => <div className={`bg-white rounded-xl shadow-sm border border-slate-200 ${className}`}>{children}</div>;
const Input = (p) => <input {...p} className={`border border-slate-300 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400 ${p.className || ''}`} />;
const Select = ({ children, ...p }) => <select {...p} className={`border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white ${p.className || ''}`}>{children}</select>;
const Btn = ({ className = '', ...p }) => <button {...p} className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 ${className}`} />;

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Auth shell ---------- */
const session = {
  get: () => { try { const a = JSON.parse(sessionStorage.getItem('hhd_auth')); return a && a.exp > Date.now() ? a : null; } catch { return null; } },
  set: (a) => { try { a ? sessionStorage.setItem('hhd_auth', JSON.stringify(a)) : sessionStorage.removeItem('hhd_auth'); } catch {} },
};

export default function App() {
  const [url, setUrl] = useState(() => ls('hhd_url') || DEFAULT_URL);
  const [auth, setAuth] = useState(session.get);
  const [notice, setNotice] = useState('');
  const login = (a) => { session.set(a); setAuth(a); setNotice(''); };
  const logout = useCallback((why = '') => { session.set(null); setNotice(why); setAuth(null); }, []);
  if (!auth) return <Login url={url} onLogin={login} notice={notice} />;
  return <Main url={url} setUrl={setUrl} auth={auth} logout={logout} />;
}

// No server URL field here: only admins can see/change it (Config tab).
function Login({ url, onLogin, notice }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState(notice);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { onLogin((await api(url, { action: 'login', username: u, password: p })).profile); return; }
    catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow border w-full max-w-sm p-6 space-y-3">
        <h1 className="text-lg font-bold flex items-center gap-2 text-indigo-700"><Boxes size={22} /> HHD Inventory</h1>
        <Input placeholder="Username" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        <Input type="password" placeholder="Password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} />
        {!url && <div className="text-sm text-amber-700 bg-amber-50 rounded-lg p-2">Backend is not configured. Contact your administrator.</div>}
        {err && <div className="text-sm text-red-700 bg-red-50 rounded-lg p-2 flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{err}</div>}
        <Btn type="submit" disabled={busy || !u || !p || !url} className="w-full"><Lock size={16} /> {busy ? 'Signing in…' : 'Sign in'}</Btn>
      </form>
    </div>
  );
}

/* ---------- Searchable multi-select (tags + type-to-filter). value = array of selected strings ---------- */
function MultiSelect({ label, options, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const shown = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (o) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div ref={ref} className="relative flex-1 min-w-[180px]">
      <div className="flex flex-wrap items-center gap-1 border border-slate-300 rounded-lg bg-white px-2 py-1.5 min-h-[38px] focus-within:ring-2 focus-within:ring-indigo-400" onClick={() => setOpen(true)}>
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-800 rounded px-2 py-0.5 text-xs">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={(e) => { e.stopPropagation(); toggle(v); }}><X size={12} /></button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[70px] outline-none text-sm bg-transparent"
          placeholder={value.length ? '' : `All ${label}`} aria-label={`${label} filter`}
          value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') { e.preventDefault(); if (shown.length) { toggle(shown[0]); setQ(''); } }
          }}
        />
      </div>
      {open && (
        <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto bg-white border border-slate-200 rounded-lg shadow-lg text-sm">
          {shown.length > 0 && (
            <li>
              <button type="button" className="w-full text-left px-3 py-1.5 text-indigo-700 font-medium hover:bg-indigo-50"
                onMouseDown={(e) => e.preventDefault()} onClick={() => onChange([...new Set([...value, ...shown])])}>
                Select all {shown.length}
              </button>
            </li>
          )}
          {shown.map((o) => (
            <li key={o}>
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} /> {o}
              </label>
            </li>
          ))}
          {!shown.length && <li className="px-3 py-2 text-slate-400">No match</li>}
        </ul>
      )}
    </div>
  );
}

/* ---------- Tab 1: Dashboard (filters + sortable columns) ---------- */
const NO_FILTER = { make: [], model: [], status: [], loc: [] };
function Dashboard({ devices }) {
  const [f, setF] = useState(NO_FILTER);
  const [sort, setSort] = useState({ key: 'site', dir: 1 });
  const [drill, setDrill] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  // picking makes narrows the model list; drop selected models that no longer apply
  const setMake = (make) => setF((x) => {
    const ok = new Set(devices.filter((d) => !make.length || make.includes(d.Make)).map((d) => d.Model));
    return { ...x, make, model: x.model.filter((m) => ok.has(m)) };
  });

  const makes = uniq(devices.map((d) => d.Make));
  const models = uniq(devices.filter((d) => !f.make.length || f.make.includes(d.Make)).map((d) => d.Model));
  const locations = uniq(devices.map(rowKey));

  // empty array = no filter; otherwise device must match any selected value
  const rows = useMemo(() => devices.filter((d) =>
    (!f.make.length || f.make.includes(d.Make)) && (!f.model.length || f.model.includes(d.Model)) &&
    (!f.status.length || f.status.includes(d.Status)) && (!f.loc.length || f.loc.includes(rowKey(d)))), [devices, f]);

  const matrix = useMemo(() => {
    const m = {};
    rows.forEach((d) => {
      const k = rowKey(d);
      m[k] ||= Object.fromEntries(STATUSES.map((s) => [s, 0]));
      m[k][d.Status] = (m[k][d.Status] || 0) + 1;
    });
    const val = (r) => (sort.key === 'avail' ? avail(r[1]) : r[1][sort.key]);
    return Object.entries(m).sort((a, b) => (sort.key === 'site' ? a[0].localeCompare(b[0]) : val(a) - val(b) || a[0].localeCompare(b[0])) * sort.dir);
  }, [rows, sort]);

  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const th = (key, label, cls = '') => {
    const Icon = sort.key !== key ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <th key={key} className={`p-3 ${cls}`} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => toggle(key)} className={`inline-flex items-center gap-1 uppercase hover:text-indigo-600 ${cls.includes('right') ? 'flex-row-reverse' : ''}`}>
          {label} <Icon size={12} className={sort.key === key ? 'text-indigo-600' : 'opacity-40'} />
        </button>
      </th>
    );
  };

  const count = (s) => rows.filter((d) => d.Status === s).length;
  const grouped = {};
  (drill ? rows.filter((d) => rowKey(d) === drill) : []).forEach((d) => {
    const k = `${d.Make}||${d.Model}`;
    grouped[k] ||= Object.fromEntries(STATUSES.map((s) => [s, 0]));
    grouped[k][d.Status]++;
  });

  return (
    <div className="space-y-4">
      <Card className="p-4 flex flex-wrap gap-3 items-center">
        <MultiSelect label="Makes" options={makes} value={f.make} onChange={setMake} />
        <MultiSelect label="Models" options={models} value={f.model} onChange={set('model')} />
        <MultiSelect label="Statuses" options={STATUSES} value={f.status} onChange={set('status')} />
        <MultiSelect label="Locations" options={locations} value={f.loc} onChange={set('loc')} />
        {Object.values(f).some((a) => a.length) && <button className="text-sm text-indigo-600 hover:underline" onClick={() => setF(NO_FILTER)}>Clear filters</button>}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <Card className="p-3"><div className="text-xs text-slate-500">Total Units</div><div className="text-2xl font-bold">{rows.length}</div></Card>
        {['Working', 'In-Transit', 'Not-Working', 'Handed Over to SS', 'Replacement Received from SS', 'Yet-to-be-find'].map((s) => (
          <Card key={s} className="p-3"><div className="text-xs text-slate-500">{s}</div><div className="text-2xl font-bold">{count(s)}</div></Card>
        ))}
      </div>

      <Card className="overflow-x-auto">
        <div className="p-4 font-semibold">Site-Wise Inventory Stock Matrix</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              {th('site', 'Site')}
              {STATUSES.map((s) => th(s, s, 'text-right'))}
              {th('avail', 'Calculated Available Stock', 'text-right text-indigo-700')}
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {matrix.map(([k, c]) => (
              <tr key={k} className="border-t">
                <td className="p-3 font-medium">{k}</td>
                {STATUSES.map((s) => <td key={s} className="p-3 text-right">{c[s]}</td>)}
                <td className="p-3 text-right font-bold text-indigo-700">{avail(c)}</td>
                <td className="p-3"><button className="text-indigo-600 hover:underline" onClick={() => setDrill(k)}>Drilldown</button></td>
              </tr>
            ))}
            {!matrix.length && <tr><td colSpan={9} className="p-6 text-center text-slate-400">No data</td></tr>}
          </tbody>
        </table>
      </Card>

      {drill && (
        <Modal title={`${drill} — breakdown by Make & Model`} onClose={() => setDrill(null)}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr><th className="p-2">Make</th><th className="p-2">Model</th>{STATUSES.map((s) => <th key={s} className="p-2 text-right">{s}</th>)}<th className="p-2 text-right">Available</th></tr>
            </thead>
            <tbody>
              {Object.entries(grouped).sort().map(([k, c]) => {
                const [mk, md] = k.split('||');
                return (
                  <tr key={k} className="border-t">
                    <td className="p-2">{mk}</td><td className="p-2">{md}</td>
                    {STATUSES.map((s) => <td key={s} className="p-2 text-right">{c[s]}</td>)}
                    <td className="p-2 text-right font-bold">{avail(c)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(() => {
            const nw = rows.filter((d) => rowKey(d) === drill && d.Status === 'Not-Working');
            return nw.length ? (
              <div className="mt-4">
                <div className="font-semibold text-sm mb-2">Not-working devices ({nw.length})</div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr><th className="p-2">Serial</th><th className="p-2">IMEI/Device S.No</th><th className="p-2">Make / Model</th><th className="p-2">Fault reason</th></tr>
                  </thead>
                  <tbody>
                    {nw.map((d) => (
                      <tr key={d.Serial} className="border-t">
                        <td className="p-2 font-mono">{d.Serial}</td><td className="p-2 font-mono">{d.imei_number}</td>
                        <td className="p-2">{d.Make} {d.Model}</td><td className="p-2 text-red-700">{d.FaultReason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null;
          })()}
        </Modal>
      )}
    </div>
  );
}

/* ---------- Main shell (signed in) ---------- */
function Main({ url, setUrl, auth, logout }) {
  const [site, setSite] = useState(() => ls('hhd_site'));
  const [tab, setTab] = useState('dash');
  const [data, setData] = useState({ devices: [], tickets: [], users: [], sites: [], statusLog: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [exportSites, setExportSites] = useState([]); // master-list CSV: sites to include
  useEffect(() => setExportSites(site ? [site] : []), [site]);
  const admin = auth.role === 'admin';

  const flash = useCallback((type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 6000); }, []);
  const fail = useCallback((e) => (e.message === 'auth' ? logout('Session expired. Please sign in again.') : flash('err', e.message)), [logout, flash]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const j = await (await fetch(`${url}?token=${encodeURIComponent(auth.token)}`)).json();
      if (!j.ok) throw new Error(j.error);
      setData(j);
    } catch (e) { fail(e); }
    setBusy(false);
  }, [url, auth.token, fail]);
  useEffect(() => { load(); }, [load]);

  // Status changes patch local state; other actions (dispatch/ack/import/...) reload everything.
  // Freeze bug was here: busy was set true and never reset on the changeStatus path, so every
  // status <select> (disabled={busy}) stayed locked. `finally` always releases it.
  const push = async (action, payload) => {
    setBusy(true);
    try {
      const j = await api(url, { token: auth.token, action, ...payload });
      if (action === 'changeStatus' || action === 'changeStatusBulk') {
        const hit = new Set(action === 'changeStatus' ? [payload.serial] : payload.serials);
        const now = new Date().toISOString();
        setData((d) => ({ ...d, devices: d.devices.map((x) => (hit.has(x.Serial) ? { ...x, Status: payload.status, LastUpdated: now, FaultReason: payload.status === 'Not-Working' ? payload.fault : null } : x)) }));
      } else await load();
      return j;
    } catch (e) { fail(e); return null; }
    finally { setBusy(false); }
  };

  const allSites = useMemo(() => uniq([...data.sites, ...data.devices.filter((d) => !inTransit(d)).map((d) => d.Location)]), [data]);
  const own = admin || auth.site.trim() === '*' ? allSites : siteList(auth.site);
  useEffect(() => { if (!own.includes(site)) setSite(own[0] || ''); }, [own.join('|'), site]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('hhd_site', site); } catch {} }, [site]);

  const incoming = data.tickets.filter((t) => t.ReceiverSite === site && t.Status === 'Pending Receipt');
  const mine = incoming.filter((t) => String(t.RecipientUser).toLowerCase() === auth.user).length;
  const tabs = admin ? [...TABS, ...ADMIN_TABS] : TABS;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="bg-indigo-700 text-white p-4 flex flex-wrap items-center gap-4 justify-between">
        <h1 className="text-lg font-bold flex items-center gap-2"><Boxes size={22} /> HHD Inventory & Ticketing</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><MapPin size={16} />
            <Select value={site} onChange={(e) => setSite(e.target.value)} className="text-slate-800">
              {own.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </label>
          <span className="flex items-center gap-2"><User size={16} /> {auth.name} <span className="bg-indigo-500 rounded px-1.5 text-xs">{auth.role}</span></span>
          <button onClick={load} disabled={busy} className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50" aria-label="Refresh"><RefreshCw size={16} className={busy ? 'animate-spin' : ''} /></button>
          <button onClick={() => logout()} className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500" aria-label="Sign out"><LogOut size={16} /></button>
        </div>
      </header>

      <nav className="bg-white border-b flex overflow-x-auto">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm whitespace-nowrap border-b-2 ${tab === id ? 'border-indigo-600 text-indigo-700 font-semibold' : 'border-transparent text-slate-600'}`}>
            <Icon size={16} /> {label}
            {id === 'pending' && mine > 0 && <span className="bg-red-500 text-white text-xs rounded-full px-1.5">{mine}</span>}
          </button>
        ))}
      </nav>

      {msg && (
        <div className={`mx-4 mt-4 p-3 rounded-lg text-sm flex items-center gap-2 ${msg.type === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {msg.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {msg.text}
        </div>
      )}

      <main className="p-4 max-w-7xl mx-auto">
        {tab === 'dash' && <Dashboard devices={data.devices} />}
        {tab === 'pending' && <Pending list={incoming} site={site} me={auth} push={push} busy={busy} flash={flash} />}
        {tab === 'dispatch' && <Dispatch site={site} sites={allSites} me={auth} users={data.users} devices={data.devices} push={push} busy={busy} flash={flash} />}
        {tab === 'master' && (
          <div className="space-y-3">
            <Card className="p-3 flex flex-wrap gap-3 items-center">
              <MultiSelect label="sites" options={own} value={exportSites} onChange={setExportSites} />
              {admin && <button className="text-sm text-indigo-600 hover:underline" onClick={() => setExportSites(own)}>All sites</button>}
              <Btn onClick={() => saveMaster(data.devices, data.tickets, exportSites)} disabled={!exportSites.length}><FileDown size={16} /> Download master list (CSV)</Btn>
            </Card>
            <DeviceTable devices={data.devices} me={auth} push={push} busy={busy} flash={flash} />
          </div>
        )}
        {tab === 'audit' && <Audit tickets={data.tickets} devices={data.devices} />}
        {tab === 'log' && <StatusLog log={data.statusLog} devices={data.devices} />}
        {tab === 'hhdaudit' && <DeviceAudit sites={own} devices={data.devices} push={push} busy={busy} />}
        {tab === 'auditlog' && <AuditLog audits={data.audits || []} />}
        {tab === 'shift' && <ShiftHandover site={site} users={data.users} devices={data.devices} custody={data.custody || []} logs={data.logs || []} push={push} busy={busy} flash={flash} />}
        {tab === 'config' && admin && <Config url={url} setUrl={setUrl} load={load} data={data} me={auth} flash={flash} />}
        {tab === 'admin' && admin && <Admin data={data} sites={allSites} push={push} busy={busy} flash={flash} />}
      </main>
    </div>
  );
}

/* ---------- Tab 2: Pending Receipts ---------- */
function Pending({ list, site, me, push, busy, flash }) {
  const ack = async (t) => {
    if (await push('ack', { ticketId: t.TicketID })) flash('ok', `${t.TicketID} acknowledged by ${me.name} (${me.user}); devices received at ${site} with their previous status`);
  };
  return (
    <div className="space-y-4">
      <h2 className="font-semibold">Incoming to {site}</h2>
      {!list.length && <Card className="p-8 text-center text-slate-400">No pending receipts for this site.</Card>}
      {list.map((t) => {
        const mine = String(t.RecipientUser).toLowerCase() === me.user;
        return (
          <Card key={t.TicketID} className="p-4 space-y-3">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="font-semibold flex items-center gap-2"><Truck size={16} /> {t.TicketID} <Badge s={t.Status} /></div>
              <div className="text-xs text-slate-500">Dispatched {fmt(t.DispatchDate)}</div>
            </div>
            <div className="text-sm">From <b>{t.SenderSite}</b> · Sender: <b>{t.SenderName}</b> · {t.Action}</div>
            <div className="text-sm">Issued to: <b>{t.RecipientName}</b> ({t.RecipientUser})</div>
            <div className="flex flex-wrap gap-1">{serialsOf(t).map((s) => <span key={s} className="bg-slate-100 rounded px-2 py-0.5 text-xs font-mono">{s}</span>)}</div>
            {t.Remarks && <div className="text-sm text-slate-500">Remarks: {t.Remarks}</div>}
            {mine
              ? <Btn disabled={busy} onClick={() => ack(t)}><CheckCircle2 size={16} /> Acknowledge & Confirm Physical Receipt</Btn>
              : <div className="text-sm text-amber-700 bg-amber-50 rounded-lg p-2 flex gap-2"><Lock size={14} className="mt-0.5" /> Only {t.RecipientName} can acknowledge this ticket.</div>}
          </Card>
        );
      })}
    </div>
  );
}

/* ---------- Tab 3: Batch Dispatch ---------- */
// Pure check: returns an error string or null.
const checkScan = (serial, site, byS, queue) => {
  const d = byS[serial];
  if (!d) return `${serial}: not in master stock`;
  if (inTransit(d)) return `${serial}: already in transit`;
  if (d.Location !== site) return `${serial}: belongs to "${d.Location}", not ${site}`;
  if (queue.includes(serial)) return `${serial}: already in queue`;
  return null;
};

function Dispatch({ site, sites, me, users, devices, push, busy, flash }) {
  const [to, setTo] = useState('');
  const [rcpt, setRcpt] = useState('');
  const [action, setAction] = useState(ACTIONS[0]);
  const [remarks, setRemarks] = useState('');
  const [scan, setScan] = useState('');
  const [queue, setQueue] = useState([]);
  const [errs, setErrs] = useState([]);
  const byS = useMemo(() => Object.fromEntries(devices.map((d) => [d.Serial, d])), [devices]);
  // IMEI is NOT unique: index maps IMEI -> every device carrying it
  const byImei = useMemo(() => {
    const m = {};
    devices.forEach((d) => { const k = String(d.imei_number || '').trim().toUpperCase(); if (k) (m[k] ||= []).push(d); });
    return m;
  }, [devices]);
  const [pick, setPick] = useState(null); // devices sharing a scanned IMEI, awaiting the user's choice
  const [pickSel, setPickSel] = useState(() => new Set());
  const people = users.filter((u) => to && hasSite(u, to));
  const siteDevices = useMemo(() => devices.filter((d) => d.Location === site), [devices, site]);

  useEffect(() => { setQueue([]); setErrs([]); }, [site]); // a queue belongs to one sender site
  useEffect(() => setRcpt(''), [to]);

  const add = () => {
    // scanners send one code + Enter; pasted lists (comma/space/newline) also work
    const codes = scan.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const q = [...queue], e = [], amb = [];
    codes.forEach((c) => {
      const m = byS[c] ? [] : byImei[c] || []; // a serial match always wins over an IMEI match
      if (m.length > 1) { m.forEach((d) => !amb.some((x) => x.Serial === d.Serial) && amb.push(d)); return; }
      const s = m[0]?.Serial || c; // 0 matches: checkScan reports "not in master stock"
      const err = checkScan(s, site, byS, q); err ? e.push(err) : q.push(s);
    });
    setQueue(q); setErrs(e); setScan('');
    if (amb.length) { setPick(amb); setPickSel(new Set()); }
  };
  const togglePick = (s) => setPickSel((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const eligible = (pick || []).filter((d) => !checkScan(d.Serial, site, byS, queue));
  const addPicked = () => { setQueue((q) => [...q, ...[...pickSel].filter((s) => !q.includes(s))]); setPick(null); };

  const dispatch = async () => {
    const ticket = { SenderSite: site, ReceiverSite: to, RecipientUser: rcpt, Action: action, Devices: queue.join(', '), Remarks: remarks };
    const j = await push('dispatch', { ticket });
    if (j) { flash('ok', `Ticket ${j.ticketId} created. ${j.count} device(s) in transit to ${to}`); setQueue([]); setErrs([]); setRemarks(''); }
  };

  const ready = to && rcpt && queue.length > 0 && !busy;
  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h2 className="font-semibold">Dispatch from {site} <span className="text-xs font-normal text-slate-500">as {me.name}</span></h2>
          <Select value={to} onChange={(e) => setTo(e.target.value)} className="w-full">
            <option value="">Select destination site…</option>
            {sites.filter((s) => s !== site).map((s) => <option key={s}>{s}</option>)}
          </Select>
          <Select value={rcpt} onChange={(e) => setRcpt(e.target.value)} className="w-full" disabled={!to}>
            <option value="">{to ? (people.length ? 'Issue to (only this person can accept)…' : 'No user has access to this site yet') : 'Pick a destination first'}</option>
            {people.map((u) => <option key={u.user} value={u.user}>{u.name} ({u.user})</option>)}
          </Select>
          <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-full">{ACTIONS.map((a) => <option key={a}>{a}</option>)}</Select>
          <Input placeholder="Remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          <div className="flex gap-2">
            <Input autoFocus placeholder="Scan or type serial / IMEI, press Enter" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <Btn onClick={add} disabled={!scan.trim()}>Add</Btn>
          </div>
          {errs.length > 0 && (
            <ul className="bg-red-50 text-red-700 text-sm rounded-lg p-3 space-y-1">
              {errs.map((e) => <li key={e} className="flex gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{e}</li>)}
            </ul>
          )}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="font-semibold">Scanned Queue ({queue.length})</h2>
            {queue.length > 0 && <button className="text-xs text-red-600" onClick={() => setQueue([])}>Clear all</button>}
          </div>
          <div className="max-h-80 overflow-auto divide-y">
            {queue.map((s) => (
              <div key={s} className="flex items-center justify-between py-2 text-sm">
                <span><span className="font-mono">{s}</span> <span className="text-slate-500">{byS[s].Make} {byS[s].Model} · {byS[s].imei_number && <>IMEI {byS[s].imei_number} · </>}<Badge s={byS[s].Status} /></span></span>
                <button onClick={() => setQueue(queue.filter((x) => x !== s))} aria-label={`Remove ${s}`}><Trash2 size={16} className="text-red-500" /></button>
              </div>
            ))}
            {!queue.length && <div className="py-8 text-center text-slate-400">Nothing scanned yet.</div>}
          </div>
          <Btn disabled={!ready} onClick={dispatch} className="w-full"><Send size={16} /> Dispatch & Create Ticket</Btn>
        </Card>
      </div>

      <div>
        <h2 className="font-semibold mb-2">Devices at {site}</h2>
        <DeviceTable devices={siteDevices} me={me} push={push} busy={busy} flash={flash} />
      </div>

      {pick && (
        <Modal title={`${pick.length} devices share this IMEI: choose which to add`} onClose={() => setPick(null)}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr><th className="p-2 w-8" /><th className="p-2">Serial</th><th className="p-2">IMEI/Device S.No</th><th className="p-2">Make / Model</th><th className="p-2">Status</th><th className="p-2">Location</th></tr>
            </thead>
            <tbody>
              {pick.map((d) => {
                const why = checkScan(d.Serial, site, byS, queue);
                return (
                  <tr key={d.Serial} className={`border-t ${why ? 'opacity-50' : ''}`}>
                    <td className="p-2"><input type="checkbox" disabled={!!why} checked={pickSel.has(d.Serial)} onChange={() => togglePick(d.Serial)} aria-label={`Select ${d.Serial}`} /></td>
                    <td className="p-2 font-mono">{d.Serial}</td><td className="p-2 font-mono">{d.imei_number}</td><td className="p-2">{d.Make} {d.Model}</td>
                    <td className="p-2"><Badge s={d.Status} /></td>
                    <td className="p-2">{d.Location}{why && <div className="text-xs text-red-600">{why.slice(why.indexOf(': ') + 2)}</div>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Btn onClick={addPicked} disabled={!pickSel.size}>Add {pickSel.size} to queue</Btn>
            <button className="text-sm text-indigo-600 hover:underline" onClick={() => setPickSel(new Set(eligible.map((d) => d.Serial)))} disabled={!eligible.length}>Select all eligible ({eligible.length})</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------- Fault and status pickers (shared by every place a status can change) ---------- */
function FaultPick({ fault, note, onFault, onNote }) {
  return (
    <div className="space-y-2">
      <Select className="w-full" value={fault} onChange={(e) => onFault(e.target.value)} aria-label="Fault reason">
        <option value="">Select fault reason…</option>{FAULTS.map((f) => <option key={f}>{f}</option>)}
      </Select>
      {fault === OTHER && <Input placeholder="Describe the fault *" value={note} onChange={(e) => onNote(e.target.value)} />}
    </div>
  );
}

// Fault reason only: used when a device is marked Not-Working
function FaultModal({ title, onConfirm, onClose }) {
  const [fault, setFault] = useState('');
  const [note, setNote] = useState('');
  const ok = fault && (fault !== OTHER || note.trim());
  return (
    <Modal title={title} onClose={onClose}>
      <FaultPick fault={fault} note={note} onFault={setFault} onNote={setNote} />
      <div className="mt-4 flex gap-3">
        <Btn disabled={!ok} onClick={() => onConfirm(faultText(fault, note))}>Mark Not-Working</Btn>
        <Btn onClick={onClose} className="!bg-slate-500 hover:!bg-slate-600">Cancel</Btn>
      </div>
    </Modal>
  );
}

// Status plus fault reason (when Not-Working): used by the audit
function StatusPrompt({ title, initial, onConfirm, onClose }) {
  const [st, setSt] = useState(initial.status);
  const [fault, setFault] = useState(initial.fault || '');
  const [note, setNote] = useState('');
  const bad = st === 'Not-Working' && !(fault && (fault !== OTHER || note.trim()));
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <Select className="w-full" value={st} onChange={(e) => setSt(e.target.value)} aria-label="Status">
          {STATUS_CHOICES.map((s) => <option key={s}>{s}</option>)}
        </Select>
        {st === 'Not-Working' && <FaultPick fault={fault} note={note} onFault={setFault} onNote={setNote} />}
      </div>
      <div className="mt-4 flex gap-3">
        <Btn disabled={bad} onClick={() => onConfirm({ status: st, fault: st === 'Not-Working' ? faultText(fault, note) : '' })}>Confirm</Btn>
        <Btn onClick={onClose} className="!bg-slate-500 hover:!bg-slate-600">Cancel</Btn>
      </div>
    </Modal>
  );
}

/* ---------- Device table (Master Inventory + site list). Status editable for users with access to the device's site ---------- */
function DeviceTable({ devices, me, push, busy, flash }) {
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [limit, setLimit] = useState(200);
  const rows = useMemo(() => {
    const n = q.toLowerCase();
    return devices.filter((d) => (!st || d.Status === st) &&
      (!n || [d.Serial, d.imei_number ?? '', d.Make, d.Model, d.Location].some((v) => String(v).toLowerCase().includes(n))));
  }, [devices, q, st]);
  const [sel, setSel] = useState(() => new Set()); // selected serials
  const [target, setTarget] = useState('');
  useEffect(() => { setLimit(200); setSel(new Set()); }, [q, st]); // selection never outlives the visible filter

  const canEdit = (d) => !inTransit(d) && hasSite(me, d.Location);
  const editable = useMemo(() => rows.filter(canEdit), [rows, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const allSel = editable.length > 0 && editable.every((d) => sel.has(d.Serial));
  const toggle = (s) => setSel((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(editable.map((d) => d.Serial)));

  const [fp, setFp] = useState(null); // {serials, title}: fault reason needed before marking Not-Working
  const markNotWorking = async (serials, fault) => {
    setFp(null);
    const j = await push('changeStatusBulk', { serials, status: 'Not-Working', fault });
    if (j) { flash('ok', `${j.count ?? serials.length} device(s) → Not-Working (${fault})`); setSel(new Set()); setTarget(''); }
  };

  const change = async (d, status) => {
    if (status === 'Not-Working') return setFp({ serials: [d.Serial], title: `${d.Serial}: fault reason` });
    if (!window.confirm(`Change ${d.Serial} from "${d.Status}" to "${status}"?`)) return;
    if (await push('changeStatus', { serial: d.Serial, status })) flash('ok', `${d.Serial}: ${d.Status} → ${status}`);
  };

  const bulk = async () => {
    const serials = [...sel];
    if (target === 'Not-Working') return setFp({ serials, title: `${serials.length} device(s): fault reason` });
    if (!window.confirm(`Change ${serials.length} device(s) to "${target}"?`)) return;
    const j = await push('changeStatusBulk', { serials, status: target });
    if (j) { flash('ok', `${j.count ?? serials.length} device(s) → ${target}`); setSel(new Set()); setTarget(''); }
  };

  return (
    <Card className="overflow-x-auto">
      <div className="p-4 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <Input className="pl-9" placeholder="Search serial, IMEI, make, model, location" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select value={st} onChange={(e) => setSt(e.target.value)}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>
        <span className="text-sm text-slate-500">{rows.length} devices</span>
      </div>
      {editable.length > 0 && (
        <div className="px-4 pb-4 flex flex-wrap gap-3 items-center">
          <span className="text-sm text-slate-600">{sel.size} selected</span>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target status"><option value="">Set status to…</option>{EDITABLE.map((s) => <option key={s}>{s}</option>)}</Select>
          <Btn onClick={bulk} disabled={busy || !sel.size || !target}>Update Status</Btn>
          {sel.size > 0 && <button className="text-sm text-indigo-600 hover:underline" onClick={() => setSel(new Set())}>Clear selection</button>}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="p-3 w-8"><input type="checkbox" checked={allSel} onChange={toggleAll} disabled={!editable.length} aria-label="Select all" /></th>
            <th className="p-3">Serial</th><th className="p-3">IMEI/Device S.No</th><th className="p-3">Make</th><th className="p-3">Model</th><th className="p-3">Status</th><th className="p-3">Location</th><th className="p-3">Last Updated</th><th className="p-3">Fault</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((d) => (
            <tr key={d.Serial} className={`border-t ${sel.has(d.Serial) ? 'bg-indigo-50' : ''}`}>
              <td className="p-3">{canEdit(d) && <input type="checkbox" checked={sel.has(d.Serial)} onChange={() => toggle(d.Serial)} aria-label={`Select ${d.Serial}`} />}</td>
              <td className="p-3 font-mono">{d.Serial}</td><td className="p-3 font-mono">{d.imei_number}</td><td className="p-3">{d.Make}</td><td className="p-3">{d.Model}</td>
              <td className="p-3">
                {canEdit(d)
                  ? <Select className="!py-1" value={d.Status} disabled={busy} onChange={(e) => change(d, e.target.value)} aria-label={`Status of ${d.Serial}`}>
                    {EDITABLE.map((s) => <option key={s}>{s}</option>)}
                  </Select>
                  : <Badge s={d.Status} />}
              </td>
              <td className="p-3">{d.Location}</td><td className="p-3 text-slate-500">{fmt(d.LastUpdated)}</td><td className="p-3 text-xs text-red-700">{d.FaultReason}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={9} className="p-6 text-center text-slate-400">No devices</td></tr>}
        </tbody>
      </table>
      {rows.length > limit && <div className="p-4 text-center"><Btn onClick={() => setLimit(limit + 500)}>Show more ({rows.length - limit} left)</Btn></div>}
      {fp && <FaultModal title={fp.title} onConfirm={(f) => markNotWorking(fp.serials, f)} onClose={() => setFp(null)} />}
    </Card>
  );
}

/* ---------- Status change log ---------- */
function StatusLog({ log, devices }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(200);
  const rows = useMemo(() => {
    const n = q.toLowerCase(), imei = Object.fromEntries(devices.map((d) => [d.Serial, d.imei_number || '']));
    return (log || []).map((l) => ({ ...l, imei: imei[l.Serial] || '' })).filter((l) => !n || JSON.stringify(l).toLowerCase().includes(n));
  }, [log, devices, q]);
  useEffect(() => setLimit(200), [q]);
  return (
    <Card className="overflow-x-auto">
      <div className="p-4 relative"><Search size={16} className="absolute left-7 top-[1.65rem] text-slate-400" />
        <Input className="pl-9" placeholder="Search by serial, IMEI, user, site, status…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr><th className="p-3">When</th><th className="p-3">Device</th><th className="p-3">IMEI/Device S.No</th><th className="p-3">Site</th><th className="p-3">Old status</th><th className="p-3">New status</th><th className="p-3">Changed by</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((l, i) => (
            <tr key={l.id ?? i} className="border-t">
              <td className="p-3 text-slate-500 whitespace-nowrap">{fmt(l.ChangedAt)}</td><td className="p-3 font-mono">{l.Serial}</td><td className="p-3 font-mono">{l.imei}</td><td className="p-3">{l.Location}</td>
              <td className="p-3"><Badge s={l.OldStatus} /></td><td className="p-3"><Badge s={l.NewStatus} /></td><td className="p-3">{l.ChangedBy}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No status changes yet</td></tr>}
        </tbody>
      </table>
      {rows.length > limit && <div className="p-4 text-center"><Btn onClick={() => setLimit(limit + 500)}>Show more ({rows.length - limit} left)</Btn></div>}
    </Card>
  );
}

/* ---------- Tab 5: Audit Trail (paginated) ---------- */
function Audit({ tickets, devices }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  useEffect(() => setPage(0), [q, size]);

  const imeiOf = useMemo(() => Object.fromEntries(devices.map((d) => [d.Serial, d.imei_number || ''])), [devices]);
  const rows = useMemo(() => tickets
    .filter((t) => !q || (JSON.stringify(t) + ' ' + serialsOf(t).map((s) => imeiOf[s]).join(' ')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(b.DispatchDate).localeCompare(String(a.DispatchDate))), [tickets, imeiOf, q]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(page, pages - 1);
  const view = rows.slice(cur * size, (cur + 1) * size);

  return (
    <Card className="overflow-x-auto">
      <div className="p-4 relative"><Search size={16} className="absolute left-7 top-[1.65rem] text-slate-400" />
        <Input className="pl-9" placeholder="Search tickets (ID, site, name, serial, IMEI…)" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr><th className="p-3">Ticket</th><th className="p-3">From → To</th><th className="p-3">Issued to</th><th className="p-3">Units</th><th className="p-3">Status</th><th className="p-3">Dispatched</th></tr>
        </thead>
        <tbody>
          {view.map((t) => (
            <tr key={t.TicketID} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(t)}>
              <td className="p-3 font-mono">{t.TicketID}</td><td className="p-3">{t.SenderSite} → {t.ReceiverSite}</td><td className="p-3">{t.RecipientName}</td>
              <td className="p-3">{serialsOf(t).length}</td><td className="p-3"><Badge s={t.Status} /></td><td className="p-3 text-slate-500">{fmt(t.DispatchDate)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No tickets</td></tr>}
        </tbody>
      </table>
      <div className="p-3 border-t flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-slate-500">{rows.length ? `${cur * size + 1}–${Math.min((cur + 1) * size, rows.length)} of ${rows.length}` : '0 tickets'}</span>
        <div className="flex items-center gap-2">
          <Select value={size} onChange={(e) => setSize(Number(e.target.value))}>{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}</Select>
          <button className="p-2 rounded-lg border disabled:opacity-40" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span>Page {cur + 1} / {pages}</span>
          <button className="p-2 rounded-lg border disabled:opacity-40" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
        </div>
      </div>
      {open && (
        <Modal title={open.TicketID} onClose={() => setOpen(null)}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[['Status', <Badge s={open.Status} />], ['Action', open.Action], ['Sender site', open.SenderSite], ['Receiver site', open.ReceiverSite],
              ['Sender', open.SenderName], ['Issued to', `${open.RecipientName} (${open.RecipientUser})`], ['Dispatched', fmt(open.DispatchDate)], ['Acknowledged', fmt(open.AckDate)],
              ['Acknowledged by', open.AckBy || '—'], ['Remarks', open.Remarks || '—']].map(([k, v]) => (
              <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          <div className="mt-4 text-xs text-slate-500">Devices ({serialsOf(open).length})</div>
          <div className="flex flex-wrap gap-1 mt-1">{serialsOf(open).map((s) => <span key={s} className="bg-slate-100 rounded px-2 py-0.5 text-xs font-mono">{s}{imeiOf[s] && <span className="text-slate-500"> · IMEI {imeiOf[s]}</span>}</span>)}</div>
        </Modal>
      )}
    </Card>
  );
}

/* ---------- Config (admin only; rendered only when role === admin) ---------- */
function Config({ url, setUrl, load, data, me, flash }) {
  const [v, setV] = useState(url);
  const save = () => {
    try { localStorage.setItem('hhd_url', v.trim()); } catch {}
    setUrl(v.trim());
    flash('ok', 'URL saved in this browser. Set VITE_API_URL in Vercel to change it for everyone.');
  };
  return (
    <Card className="p-4 space-y-3 max-w-2xl">
      <h2 className="font-semibold">Google Apps Script Web App URL</h2>
      <Input placeholder="https://script.google.com/macros/s/…/exec" value={v} onChange={(e) => setV(e.target.value)} />
      <div className="flex gap-2">
        <Btn onClick={save} disabled={!v.trim()}>Save</Btn>
        <Btn onClick={load} className="!bg-slate-600"><RefreshCw size={16} /> Re-sync now</Btn>
      </div>
      <p className="text-sm text-slate-500">
        Signed in as <b>{me.name}</b> ({me.user}, {me.role}, sites: {me.site}). Loaded {data.devices.length} devices, {data.tickets.length} tickets.
        Session ends {fmt(me.exp)}.
      </p>
    </Card>
  );
}

/* ---------- Admin: CSV import, add device / site / user ---------- */
function Admin({ data, sites, push, busy, flash }) {
  const { devices, users } = data;
  const makes = uniq(devices.map((d) => d.Make));
  const models = uniq(devices.map((d) => d.Model));
  return (
    <div className="space-y-4">
      <datalist id="dl-sites">{sites.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="dl-makes">{makes.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="dl-models">{models.map((s) => <option key={s} value={s} />)}</datalist>
      <UserAdmin users={users} push={push} busy={busy} flash={flash} />
      <ImportCsv devices={devices} push={push} busy={busy} flash={flash} />
      <div className="grid lg:grid-cols-2 gap-4">
        <AddDevice devices={devices} push={push} busy={busy} flash={flash} />
        <AddSite push={push} busy={busy} flash={flash} />
      </div>
    </div>
  );
}

function ImportCsv({ devices, push, busy, flash }) {
  const [res, setRes] = useState(null);
  const [overwrite, setOverwrite] = useState(false);
  const exist = useMemo(() => new Set(devices.map((d) => d.Serial)), [devices]);
  const onFile = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setRes({ ...toDevices(parseCSV(await f.text()), devices), name: f.name });
    e.target.value = '';
  };
  const nNew = res ? res.out.filter((d) => !exist.has(d.Serial)).length : 0;
  const go = async () => {
    const j = await push('importDevices', { devices: res.out, overwrite });
    if (j) { flash('ok', `Imported ${j.count} devices (${nNew} new)`); setRes(null); }
  };
  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold flex items-center gap-2"><Upload size={16} /> CSV Import</h2>
      <p className="text-sm text-slate-500">
        Columns <code>Serial, Make, Model, Status, Location</code> (+ optional <code>LastUpdated</code>), or the aggregated
        <code> Site, HHD Make, HHD Model, status, Quantity</code> (serials are generated after the highest existing HHD-number).
      </p>
      <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
      {res && (
        <div className="space-y-2 text-sm">
          <div><b>{res.name}</b>: {res.out.length} valid rows ({nNew} new, {res.out.length - nNew} existing), {res.errors.length} problem(s)</div>
          {res.errors.length > 0 && <ul className="bg-red-50 text-red-700 rounded-lg p-3 max-h-40 overflow-auto">{res.errors.slice(0, 50).map((e) => <li key={e}>{e}</li>)}</ul>}
          {res.out.length > 0 && (
            <div className="overflow-x-auto"><table className="text-xs"><tbody>
              {res.out.slice(0, 5).map((d) => <tr key={d.Serial}><td className="pr-4 font-mono">{d.Serial}</td><td className="pr-4">{d.Make}</td><td className="pr-4">{d.Model}</td><td className="pr-4">{d.Status}</td><td>{d.Location}</td></tr>)}
            </tbody></table></div>
          )}
          <label className="flex items-center gap-2"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Also overwrite Make/Model of existing serials (otherwise only Status/Location are updated)</label>
          <Btn onClick={go} disabled={busy || !res.out.length || res.errors.length > 0}>Import {res.out.length} devices</Btn>
          {res.errors.length > 0 && <div className="text-xs text-slate-500">Fix the listed rows to enable import. Nothing is imported partially.</div>}
        </div>
      )}
    </Card>
  );
}

function AddDevice({ devices, push, busy, flash }) {
  const blank = { Serial: '', imei_number: '', Make: '', Model: '', Status: 'Working', Location: '' };
  const [d, setD] = useState(blank);
  const [fault, setFault] = useState('');
  const [note, setNote] = useState('');
  const [look, setLook] = useState('');
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value });
  const badFault = d.Status === 'Not-Working' && !(fault && (fault !== OTHER || note.trim()));
  // scan or type a serial/IMEI already in the master list: fills the form from it
  const load = () => {
    const k = look.trim().toUpperCase();
    if (!k) return;
    const f = devices.find((x) => x.Serial === k) || devices.find((x) => String(x.imei_number || '').trim().toUpperCase() === k);
    if (!f) return flash('err', `${k}: not in master list`);
    setD({ Serial: f.Serial, imei_number: f.imei_number || '', Make: f.Make, Model: f.Model, Status: f.Status === 'In-Transit' ? 'Working' : f.Status, Location: f.Location });
    const fr = f.FaultReason || '';
    setFault(FAULTS.includes(fr) ? fr : fr ? OTHER : '');
    setNote(fr && !FAULTS.includes(fr) ? fr.replace(/^Other: /, '') : '');
    setLook('');
  };
  const submit = async (e) => {
    e.preventDefault();
    const FaultReason = d.Status === 'Not-Working' ? faultText(fault, note) : null;
    const j = await push('importDevices', { devices: [{ ...d, Serial: d.Serial.trim().toUpperCase(), FaultReason }], overwrite: true });
    if (j) { flash('ok', `${d.Serial} saved`); setD(blank); setFault(''); setNote(''); }
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-2">
        <h2 className="font-semibold">Add / update a device</h2>
        <div className="flex gap-2">
          <Input placeholder="Scan serial or IMEI to load from master list" value={look} onChange={(e) => setLook(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(); } }} />
          <Btn type="button" onClick={load} disabled={!look.trim()}>Load</Btn>
        </div>
        <Input placeholder="Serial (e.g. HHD-7001)" value={d.Serial} onChange={set('Serial')} />
        <Input placeholder="IMEI (optional; may repeat across devices)" value={d.imei_number} onChange={set('imei_number')} />
        <Input placeholder="Make (type a new one to add it)" list="dl-makes" value={d.Make} onChange={set('Make')} />
        <Input placeholder="Model (type a new one to add it)" list="dl-models" value={d.Model} onChange={set('Model')} />
        <Select className="w-full" value={d.Status} onChange={set('Status')}>{EDITABLE.map((s) => <option key={s}>{s}</option>)}</Select>
        {d.Status === 'Not-Working' && <FaultPick fault={fault} note={note} onFault={setFault} onNote={setNote} />}
        <Input placeholder="Location (site)" list="dl-sites" value={d.Location} onChange={set('Location')} />
        <Btn type="submit" disabled={busy || badFault || !d.Serial || !d.Make || !d.Model || !d.Location}>Save device</Btn>
      </form>
    </Card>
  );
}

function AddSite({ push, busy, flash }) {
  const [s, setS] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (await push('addSite', { site: s })) { flash('ok', `Site "${s}" added`); setS(''); }
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-2">
        <h2 className="font-semibold">Add a site</h2>
        <Input placeholder="Site name, e.g. Pune Hub" value={s} onChange={(e) => setS(e.target.value)} />
        <Btn type="submit" disabled={busy || !s.trim()}>Add site</Btn>
        <p className="text-xs text-slate-500">Then create a user for it below, or import devices located there.</p>
      </form>
    </Card>
  );
}

function UserAdmin({ users, push, busy, flash }) {
  const blank = { username: '', name: '', role: 'user', site: '', password: '', email: '' };
  const [u, setU] = useState(blank);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const set = (k) => (e) => setU({ ...u, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (await push('saveUser', u)) { flash('ok', `User ${u.username} saved`); setU(blank); }
  };
  // CSV columns: username, name, role, site, email, password. Existing usernames are updated; blank password keeps the old one.
  const onCsv = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const [h = [], ...body] = parseCSV(await f.text());
    const col = Object.fromEntries(h.map((x, i) => [x.trim().toLowerCase(), i]));
    const v = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] || '').trim());
    const rows = body.map((r) => ({ username: v(r, 'username'), name: v(r, 'name'), role: v(r, 'role') || 'user', site: v(r, 'site'), email: v(r, 'email'), password: v(r, 'password') }));
    const j = await push('saveUsersBulk', { users: rows });
    if (j) flash(j.errors.length ? 'err' : 'ok', `${j.count} user(s) saved${j.errors.length ? `, ${j.errors.length} failed: ${j.errors.slice(0, 3).join('; ')}` : ''}`);
  };

  const COLS = [['user', 'Username'], ['name', 'Name'], ['role', 'Role'], ['site', 'Site(s)'], ['email', 'Email']];
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return users
      .filter((x) => !n || [x.user, x.name, x.role, x.site, x.email].some((v) => String(v || '').toLowerCase().includes(n)))
      .sort((a, b) => String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), undefined, { sensitivity: 'base' }) * sort.dir);
  }, [users, q, sort]);
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const download = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const text = [COLS.map(([, l]) => l), ...rows.map((x) => [x.user, x.name, x.role, x.site, x.email])].map((r) => r.map(esc).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `HHD-Users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold">Add / update user</h2>
      <form onSubmit={submit} className="grid md:grid-cols-3 gap-2">
        <Input placeholder="Username (a-z, 0-9 . _ -)" value={u.username} onChange={set('username')} />
        <Input placeholder="Full name" value={u.name} onChange={set('name')} />
        <Select value={u.role} onChange={set('role')}><option value="user">user</option><option value="admin">admin</option></Select>
        <Input placeholder='Site(s): "*" or "Site A, Site B"' list="dl-sites" value={u.site} onChange={set('site')} />
        <Input type="email" placeholder="Email (for notifications)" value={u.email} onChange={set('email')} />
        <Input type="password" autoComplete="new-password" placeholder="Password (min 10; blank = keep)" value={u.password} onChange={set('password')} />
        <Btn type="submit" disabled={busy || !u.username || !u.name || !u.site}>Save user</Btn>
      </form>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <span className="text-sm text-slate-600">Bulk add / update (CSV):</span>
        <input type="file" accept=".csv,text/csv" onChange={onCsv} disabled={busy} className="text-sm" />
        <span className="text-xs text-slate-500">Columns: username, name, role, site, email, password</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <div className="relative flex-1 min-w-[200px]"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <Input className="pl-9" placeholder="Search name, username, email, site, role…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="text-sm text-slate-500">{rows.length} of {users.length}</span>
        <Btn type="button" onClick={download} disabled={!rows.length}><FileDown size={16} /> Download list (CSV)</Btn>
      </div>
      <div className="max-h-96 overflow-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              {COLS.map(([key, label]) => {
                const Icon = sort.key !== key ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
                return (
                  <th key={key} className="p-2" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 uppercase hover:text-indigo-600">
                      {label} <Icon size={12} className={sort.key === key ? 'text-indigo-600' : 'opacity-40'} />
                    </button>
                  </th>
                );
              })}
              <th />
            </tr>
          </thead>
          <tbody>{rows.map((x) => (
            <tr key={x.user} className="border-t"><td className="p-2 font-mono">{x.user}</td><td className="p-2">{x.name}</td><td className="p-2">{x.role}</td><td className="p-2">{x.site}</td><td className="p-2">{x.email}</td>
              <td className="p-2"><button className="text-indigo-600 hover:underline" onClick={() => setU({ username: x.user, name: x.name, role: x.role, site: x.site, email: x.email || '', password: '' })}>Edit</button></td></tr>
          ))}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No users match</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const HO_MODES = [
  ['checkout', 'Checkout (shift start)', Repeat],
  ['checkin', 'Check-in (shift end)', Undo2],
  ['swap', 'Mid-shift swap', ArrowRightLeft],
  ['redtag', 'Red tag', Flag],
  ['recon', 'Reconciliation', ListChecks],
  ['history', 'Device history', History],
];
const HO_HELD = ['issued', 'overdue', 'missing'];
const HO_EVENT = { issued: 'Issued', returned: 'Returned', returned_late: 'Returned late', returned_damaged: 'Returned damaged', swap_out: 'Swap out', swap_in: 'Swap in', flagged: 'Red-tagged' };
// fixed, location-independent shifts; end times are set by the server
const SHIFT_OPTS = [['A', 'Shift A (ends 15:00)'], ['B', 'Shift B (ends 23:00)'], ['C', 'Shift C (ends 07:00)'], ['G', 'General (ends 19:00)']];

function ShiftHandover({ site, users, devices, custody, logs, push, busy, flash }) {
  const [mode, setMode] = useState('checkout');
  const [shiftId, setShiftId] = useState('');
  const [assign, setAssign] = useState({});   // checkout: serial -> worker user
  const [toUser, setToUser] = useState('');   // swap: receiving worker
  const [scan, setScan] = useState('');
  const [queue, setQueue] = useState([]);     // serials, in scan order
  const [insp, setInsp] = useState({});       // serial -> {result, fault, note}
  const [newDevs, setNewDevs] = useState({}); // serial -> {Make, Model, imei} for devices not yet in master list
  const [newDev, setNewDev] = useState(null); // dialog state for a brand-new device
  const [hq, setHq] = useState('');
  const byS = useMemo(() => Object.fromEntries(devices.map((d) => [d.Serial, d])), [devices]);
  const byC = useMemo(() => Object.fromEntries(custody.map((c) => [c.Serial, c])), [custody]);
  const byImei = useMemo(() => {
    const m = {};
    devices.forEach((d) => { const k = String(d.imei_number || '').trim().toUpperCase(); if (k) (m[k] ||= []).push(d); });
    return m;
  }, [devices]);
  const nameOf = useMemo(() => Object.fromEntries(users.map((u) => [u.user, u.name])), [users]);
  const people = users.filter((u) => hasSite(u, site));
  const now = Date.now();
  const live = (c) => (c.Status === 'issued' && new Date(c.DueAt) < now ? 'overdue' : c.Status);
  const who = (un) => (un ? nameOf[un] || un : '—');

  useEffect(() => { setQueue([]); setInsp({}); setAssign({}); setNewDevs({}); }, [mode, site]);

  // scan a serial or IMEI. An unknown code at checkout opens the new-device dialog; elsewhere it is an error.
  const add = () => {
    const code = scan.trim().toUpperCase();
    setScan('');
    if (!code) return;
    const hits = byS[code] ? [byS[code]] : byImei[code] || [];
    if (hits.length > 1) return flash('err', `${code}: IMEI shared by ${hits.length} devices, scan the serial`);
    if (!hits.length) {
      if (mode !== 'checkout') return flash('err', `${code}: not in master stock`);
      return setNewDev({ Serial: code, Make: '', Model: '', imei: '' });
    }
    const s = hits[0].Serial;
    if (queue.includes(s)) return flash('err', `${s}: already in queue`);
    setQueue((q) => [...q, s]);
  };

  const saveNewDev = () => {
    const s = newDev.Serial;
    setNewDevs((m) => ({ ...m, [s]: { Make: newDev.Make.trim(), Model: newDev.Model.trim(), imei: newDev.imei.trim() } }));
    setQueue((q) => (q.includes(s) ? q : [...q, s]));
    setNewDev(null);
  };

  // red tag is always damaged; check-in is damaged only if the inspector says so
  const isDamaged = (s) => mode === 'redtag' || insp[s]?.result === 'damaged';
  const faultMissing = (s) => isDamaged(s) && !(insp[s]?.fault && (insp[s].fault !== OTHER || insp[s]?.note?.trim()));
  const swapFrom = queue.length ? byC[queue[0]]?.HolderUser || '' : '';
  const ready = !busy && queue.length > 0 && !queue.some(faultMissing)
    && (mode === 'redtag' || shiftId !== '')
    && (mode !== 'checkout' || queue.every((s) => assign[s]))
    && (mode !== 'swap' || toUser !== '')
    && !(mode === 'checkout' && queue.some((s) => insp[s]?.result === 'damaged'));

  // one save for the whole batch; the server issues each device to the worker chosen on its row
  const submit = async () => {
    const inspections = Object.fromEntries(queue.map((s) => {
      const i = insp[s] || {};
      const dmg = isDamaged(s);
      return [s, { result: dmg ? 'damaged' : 'ok', fault: dmg ? faultText(i.fault || '', i.note || '') : '', notes: i.note || '' }];
    }));
    let j = null, msg = '';
    if (mode === 'checkout') {
      const fresh = Object.fromEntries(queue.filter((s) => newDevs[s]).map((s) => [s, newDevs[s]]));
      j = await push('shiftIssue', { site, shiftId, assignments: Object.fromEntries(queue.map((s) => [s, assign[s]])), inspections, newDevices: fresh });
      msg = `Issued ${queue.length} device(s) to ${new Set(queue.map((s) => assign[s])).size} worker(s)`;
    }
    if (mode === 'checkin') { j = await push('shiftReturn', { site, shiftId, serials: queue, inspections }); msg = `Checked in ${queue.length} device(s)`; }
    if (mode === 'swap') { j = await push('shiftSwap', { site, shiftId, toUser, serials: queue }); msg = `Swapped ${queue.length} device(s)`; }
    if (mode === 'redtag') { j = await push('flagRedTag', { site, serials: queue, inspections }); msg = `Red-tagged ${queue.length} device(s)`; }
    if (j) { flash('ok', msg); setQueue([]); setInsp({}); setAssign({}); setNewDevs({}); }
  };

  const setI = (s, patch) => setInsp((x) => ({ ...x, [s]: { ...(x[s] || {}), ...patch } }));
  const applyAll = (u) => setAssign(Object.fromEntries(queue.map((s) => [s, u])));

  const rows = custody.filter((c) => c.Site === site).map((c) => ({ ...c, Live: live(c) }));
  const hRows = useMemo(() => {
    const n = hq.trim().toLowerCase();
    return logs
      .map((l) => ({ ...l, imei: byS[l.Serial]?.imei_number || '' }))
      .filter((l) => !n || [l.Serial, l.imei, l.Location, who(l.FromUser), who(l.ToUser), who(l.ByUser)].some((v) => String(v || '').toLowerCase().includes(n)));
  }, [logs, byS, hq, nameOf]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {HO_MODES.map(([id, label, Icon]) => (
          <button key={id} onClick={() => setMode(id)}
            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border ${mode === id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-300'}`}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {mode === 'history' && (
        <div className="space-y-3">
          <Card className="p-4">
            <div className="relative"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <Input className="pl-9" placeholder="Search serial, IMEI, location or person…" value={hq} onChange={(e) => setHq(e.target.value)} /></div>
          </Card>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr><th className="p-3">When</th><th className="p-3">Device</th><th className="p-3">Event</th><th className="p-3">Location</th><th className="p-3">From</th><th className="p-3">To</th><th className="p-3">By</th></tr>
              </thead>
              <tbody>
                {hRows.slice(0, 300).map((l) => (
                  <tr key={l.Id} className="border-t">
                    <td className="p-3 text-slate-500 whitespace-nowrap">{fmt(l.At)}</td>
                    <td className="p-3"><div className="font-mono">{l.Serial}</div><div className="text-xs text-slate-500 font-mono">{l.imei}</div></td>
                    <td className="p-3">{HO_EVENT[l.Event] || l.Event}</td>
                    <td className="p-3">{l.Location || '—'}</td>
                    <td className="p-3">{who(l.FromUser)}</td>
                    <td className="p-3 font-semibold">{who(l.ToUser)}</td>
                    <td className="p-3 text-slate-500">{who(l.ByUser)}</td>
                  </tr>
                ))}
                {!hRows.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No history</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {mode === 'recon' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-3"><div className="text-xs text-slate-500">Issued</div><div className="text-2xl font-bold">{rows.filter((r) => r.Live === 'issued').length}</div></Card>
            <Card className="p-3"><div className="text-xs text-slate-500">Returned</div><div className="text-2xl font-bold">{rows.filter((r) => r.Live === 'returned').length}</div></Card>
            <Card className="p-3"><div className="text-xs text-slate-500">Overdue / Missing</div><div className="text-2xl font-bold text-red-700">{rows.filter((r) => ['overdue', 'missing'].includes(r.Live)).length}</div></Card>
            <Card className="p-3"><div className="text-xs text-slate-500">Under Maintenance</div><div className="text-2xl font-bold text-orange-700">{rows.filter((r) => r.Live === 'maintenance').length}</div></Card>
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr><th className="p-3">Serial</th><th className="p-3">Location</th><th className="p-3">Holder</th><th className="p-3">Issued</th><th className="p-3">Shift end</th><th className="p-3">Status</th></tr>
              </thead>
              <tbody>
                {rows.filter((r) => r.Live !== 'returned').map((r) => (
                  <tr key={r.Serial} className="border-t">
                    <td className="p-3 font-mono">{r.Serial}</td><td className="p-3">{r.Site}</td>
                    <td className="p-3">{r.HolderName} <span className="text-slate-500">({r.HolderUser})</span></td>
                    <td className="p-3 text-slate-500">{fmt(r.IssuedAt)}</td><td className="p-3 text-slate-500">{fmt(r.DueAt)}</td>
                    <td className="p-3 text-xs font-medium">{r.Live}</td>
                  </tr>
                ))}
                {!rows.some((r) => r.Live !== 'returned') && <tr><td colSpan={6} className="p-6 text-center text-slate-400">Nothing outstanding</td></tr>}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {mode !== 'recon' && mode !== 'history' && (
        <>
          <Card className="p-4 grid md:grid-cols-3 gap-3">
            {mode !== 'redtag' && (
              <Select value={shiftId} onChange={(e) => setShiftId(e.target.value)} aria-label="Shift">
                <option value="">Select shift…</option>
                {SHIFT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            )}
            {mode === 'checkout' && queue.length > 0 && (
              <Select value="" onChange={(e) => e.target.value && applyAll(e.target.value)} aria-label="Issue all to">
                <option value="">Issue all queued to…</option>
                {people.map((u) => <option key={u.user} value={u.user}>{u.name} ({u.user})</option>)}
              </Select>
            )}
            {mode === 'swap' && (
              <Select value={toUser} onChange={(e) => setToUser(e.target.value)} aria-label="Receiving worker">
                <option value="">Receiving worker…</option>
                {people.filter((u) => u.user !== swapFrom).map((u) => <option key={u.user} value={u.user}>{u.name} ({u.user})</option>)}
              </Select>
            )}
            <div className="flex gap-2 md:col-span-3">
              <Input autoFocus placeholder="Scan serial or IMEI, press Enter" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <Btn onClick={add} disabled={!scan.trim()}>Add</Btn>
            </div>
          </Card>

          <Card className="p-4 space-y-3">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold">Queue ({queue.length})</h2>
              {queue.length > 0 && <button className="text-xs text-red-600" onClick={() => { setQueue([]); setInsp({}); setAssign({}); setNewDevs({}); }}>Clear all</button>}
            </div>
            {queue.length > 0 && mode === 'swap' && <div className="text-sm text-slate-600">Holder: <b>{swapFrom || '—'}</b>. Supervisor approval is recorded with this swap.</div>}
            <div className="divide-y">
              {queue.map((s) => {
                const isNew = !byS[s];
                const d = byS[s] || { Make: newDevs[s]?.Make, Model: newDevs[s]?.Model, imei_number: newDevs[s]?.imei };
                const c = byC[s];
                return (
                  <div key={s} className="py-3 grid md:grid-cols-2 gap-3 items-start">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="font-mono font-semibold">{s}{isNew && <span className="ml-2 text-xs bg-blue-100 text-blue-800 rounded px-1.5">new</span>}</span>
                        <button onClick={() => setQueue((q) => q.filter((x) => x !== s))} aria-label={`Remove ${s}`} className="text-red-500 text-xs">Remove</button>
                      </div>
                      <div className="text-slate-600">IMEI/S.No: <span className="font-mono">{d.imei_number || '—'}</span> · {d.Make} {d.Model}</div>
                      {c && HO_HELD.includes(c.Status) && <div className="text-amber-700 text-xs">Currently held by {c.HolderName}{mode === 'checkout' ? ': use swap' : ''}</div>}
                      {!isNew && d.Location && d.Location !== site && <div className="text-blue-700 text-xs">Will move from {d.Location} to {site}</div>}
                      {(mode === 'checkin' || mode === 'checkout') && (
                        <Select value={insp[s]?.result || 'ok'} onChange={(e) => setI(s, { result: e.target.value })} aria-label={`Inspection of ${s}`}>
                          <option value="ok">OK</option>
                          {mode === 'checkin' && <option value="damaged">Damaged</option>}
                        </Select>
                      )}
                      {mode === 'checkout' && <div className="text-xs text-slate-500">Damaged devices cannot be issued: use Red tag.</div>}
                      {isDamaged(s) && mode !== 'swap' && (
                        <FaultPick fault={insp[s]?.fault || ''} note={insp[s]?.note || ''} onFault={(v) => setI(s, { fault: v })} onNote={(v) => setI(s, { note: v })} />
                      )}
                    </div>
                    <div className="text-sm">
                      {mode === 'checkout' && (
                        <Select className="w-full" value={assign[s] || ''} onChange={(e) => setAssign((a) => ({ ...a, [s]: e.target.value }))} aria-label={`Worker for ${s}`}>
                          <option value="">Issue to…</option>
                          {people.map((u) => <option key={u.user} value={u.user}>{u.name} ({u.user})</option>)}
                        </Select>
                      )}
                      {mode === 'swap' && <div className="text-slate-600">From: <b>{c?.HolderName || '—'}</b></div>}
                    </div>
                  </div>
                );
              })}
              {!queue.length && <div className="py-8 text-center text-slate-400">Nothing scanned yet.</div>}
            </div>
            <Btn disabled={!ready} onClick={submit} className="w-full">
              {mode === 'checkout' ? `Issue ${queue.length} device(s)` : mode === 'checkin' ? 'Check in devices' : mode === 'swap' ? 'Record swap' : 'Submit red tag'}
            </Btn>
          </Card>
        </>
      )}

      {newDev && (
        <Modal title="New device: add to master list" onClose={() => setNewDev(null)}>
          <div className="space-y-2">
            <Input value={newDev.Serial} readOnly className="font-mono bg-slate-100" aria-label="Serial" />
            <Input placeholder="Make *" autoFocus value={newDev.Make} onChange={(e) => setNewDev({ ...newDev, Make: e.target.value })} />
            <Input placeholder="Model *" value={newDev.Model} onChange={(e) => setNewDev({ ...newDev, Model: e.target.value })} />
            <Input placeholder="IMEI / Device S.No (optional)" value={newDev.imei} onChange={(e) => setNewDev({ ...newDev, imei: e.target.value })} />
          </div>
          <div className="mt-4 flex gap-3">
            <Btn onClick={saveNewDev} disabled={!newDev.Make.trim() || !newDev.Model.trim()}>Add and queue</Btn>
            <Btn onClick={() => setNewDev(null)} className="!bg-slate-500 hover:!bg-slate-600">Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------- HHD Audit ---------- */
const TYPE_BADGE = { Reconciled: 'bg-green-100 text-green-800', New: 'bg-blue-100 text-blue-800', Transferred: 'bg-red-100 text-red-800', Missing: 'bg-gray-200 text-gray-800' };

// last physical scan; falls back to last status change for devices never audited
const lastSeen = (d) => d.LastAudited || d.LastUpdated || '';
const ageDays = (d, at = Date.now()) => (lastSeen(d) ? Math.floor((new Date(at) - new Date(lastSeen(d))) / 864e5) : '');

// one row per device; the PDF and the CSV both come from here
function auditRows({ items, missing, at }) {
  return [
    ...items.map((i) => ({ Result: i.Type, Serial: i.Serial, IMEI: i.imei || '', Make: i.Make, Model: i.Model, Previous: i.From || '', LastScanned: at, Age: 0 })),
    ...missing.map((m) => ({ Result: 'Missing', Serial: m.Serial, IMEI: m.imei_number || '', Make: m.Make, Model: m.Model, Previous: '', LastScanned: lastSeen(m), Age: ageDays(m, at) })),
  ];
}
const COLS = ['#', 'Result', 'Serial', 'IMEI/Device S.No', 'Make', 'Model', 'Previous location', 'Last scanned', 'Age (days)'];
const cells = (r, k) => [k + 1, r.Result, r.Serial, r.IMEI, r.Make, r.Model, r.Previous, r.LastScanned ? fmt(r.LastScanned) : '', r.Age];

async function makePdf(j) {
  const { site, auditor, at, items, missing } = j;
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const n = (t) => items.filter((i) => i.Type === t).length;
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFontSize(16); doc.text('HHD Device Audit Report', 14, 16);
  doc.setFontSize(10);
  doc.text([
    `Location: ${site}`, `IT Personnel: ${auditor}`, `Date/Time: ${fmt(at)}`,
    `Total scanned: ${items.length}   Reconciled: ${n('Reconciled')}   Excess/New: ${n('New')}   Transferred: ${n('Transferred')}   Missing: ${missing.length}`,
  ], 14, 24);
  autoTable(doc, { startY: 46, head: [COLS], body: auditRows(j).map(cells) });
  doc.save(`HHD-Audit-${site}-${String(at).slice(0, 10)}.pdf`);
}

function downloadCsv(j) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // CSV only: current location goes right after "Previous location" (index 7 after the Result/Serial/... columns)
  const head = [...COLS]; head.splice(7, 0, 'Current location');
  const rows = auditRows(j).map((r, k) => { const c = cells(r, k); c.splice(7, 0, j.site); return c; });
  const text = [head, ...rows].map((row) => row.map(q).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); // BOM so Excel reads UTF-8
  const a = document.createElement('a');
  a.href = url; a.download = `HHD-Audit-${j.site}-${String(j.at).slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}
const exportAudit = (j) => { makePdf(j); downloadCsv(j); };

function AuditSummary({ items, missing, at }) {
  const n = (t) => items.filter((i) => i.Type === t).length;
  const all = [...items, ...missing.map((m) => ({ ...m, Type: 'Missing' }))];
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        {[['Total scanned', items.length], ['Reconciled', n('Reconciled')], ['Excess / New', n('New')], ['Transferred', n('Transferred')], ['Missing', missing.length]].map(([k, v]) => (
          <Card key={k} className="p-3"><div className="text-xs text-slate-500">{k}</div><div className="text-2xl font-bold">{v}</div></Card>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="p-2">Serial</th><th className="p-2">Make / Model</th><th className="p-2">Result</th><th className="p-2">Previous location</th><th className="p-2">Last scanned</th><th className="p-2">Age (days)</th></tr></thead>
        <tbody>
          {all.map((r) => (
            <tr key={r.Serial} className="border-t">
              <td className="p-2 font-mono">{r.Serial}</td><td className="p-2">{r.Make} {r.Model}</td>
              <td className="p-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[r.Type]}`}>{r.Type}</span></td>
              <td className="p-2">{r.From}</td>
              <td className="p-2">{r.Type === 'Missing' ? fmt(lastSeen(r)) : ''}</td>
              <td className="p-2">{r.Type === 'Missing' ? ageDays(r, at) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DeviceAudit({ sites, devices, push, busy }) {
  const [loc, setLoc] = useState('');
  const [q, setQ] = useState(''); // what is typed in the location box; loc only holds an exact site name
  const [scan, setScan] = useState('');
  const [rows, setRows] = useState([]);   // accepted scans: {Serial, Type, From, Make, Model}
  const [warn, setWarn] = useState(null); // device registered elsewhere, awaiting confirm
  const [newDev, setNewDev] = useState(null); // unknown code scanned: details to capture {Serial, Make, Model, imei}
  const [prompt, setPrompt] = useState(null); // status prompt: {serial, title, initial}
  const [note, setNote] = useState('');
  const [review, setReview] = useState(false);
  const [done, setDone] = useState(null);
  const [remarks, setRemarks] = useState(''); // auditor's observations, shown in the audit mail
  const inp = useRef(null);
  const timer = useRef(null); // auto-submit timer for scanned codes
  const byS = useMemo(() => Object.fromEntries(devices.map((d) => [d.Serial, d])), [devices]);
  const byImei = useMemo(() => {
    const m = {};
    devices.forEach((d) => { const k = String(d.imei_number || '').trim().toUpperCase(); if (k) (m[k] ||= []).push(d); });
    return m;
  }, [devices]);
  const focus = () => setTimeout(() => inp.current?.focus(), 0);
  useEffect(() => { setRows([]); setNote(''); setNewDev(null); if (loc) focus(); }, [loc]);

  const add = (raw = scan) => {
    clearTimeout(timer.current);
    const s = String(raw).trim().toUpperCase();
    setScan(''); setNote(''); focus();
    if (!s) return;
    // a serial match always wins over an IMEI match
    const hits = byS[s] ? [byS[s]] : byImei[s] || [];
    const free = hits.filter((x) => !rows.some((r) => r.Serial === x.Serial));
    if (hits.length ? !free.length : rows.some((r) => r.Serial === s)) return setNote(`${s}: already scanned`);
    if (!hits.length) return setNewDev({ Serial: s, Make: '', Model: '', imei: '', Status: 'Working', fault: '', note: '' }); // capture details first
    // ponytail: a shared IMEI takes the first unscanned device at this location; elsewhere only if unambiguous
    const d = free.find((x) => x.Location === loc) || (free.length === 1 ? free[0] : null);
    if (!d) return setNote(`${s}: IMEI shared by ${free.length} devices at other locations, scan the serial instead`);
    if (inTransit(d)) return setNote(`${d.Serial}: in transit, acknowledge its ticket first`);
    if (d.Location !== loc) return setWarn(d);
    addRow(d, 'Reconciled');
  };
  // a known serial/IMEI submits itself shortly after the last character, so scanners need no Enter.
  // Unknown codes still wait for Enter. Enter still works and cancels the timer.
  const onScan = (v) => {
    setScan(v); clearTimeout(timer.current);
    const k = v.trim().toUpperCase();
    if (k && (byS[k] || byImei[k])) timer.current = setTimeout(() => add(v), 250);
  };
  const reassign = () => {
    addRow(warn, 'Transferred');
    setWarn(null); focus();
  };
  const cancel = () => { setWarn(null); focus(); };
  // every scanned device gets a row carrying its current status; a found missing device is prompted for its status
  const addRow = (d, type) => {
    setRows((r) => [{ Serial: d.Serial, imei: d.imei_number, Type: type, From: type === 'Transferred' ? d.Location : '', Make: d.Make, Model: d.Model, Status: d.Status, Fault: d.FaultReason || '' }, ...r]);
    if (d.Status === 'Yet-to-be-find') setPrompt({ serial: d.Serial, title: `${d.Serial} found: select its status`, initial: { status: 'Working', fault: '' } });
  };
  const saveNew = () => {
    const Fault = newDev.Status === 'Not-Working' ? faultText(newDev.fault, newDev.note) : '';
    setRows((r) => [{ Serial: newDev.Serial, imei: newDev.imei.trim(), Type: 'New', Make: newDev.Make.trim(), Model: newDev.Model.trim(), Status: newDev.Status, Fault }, ...r]);
    setNewDev(null); focus();
  };

  const missing = useMemo(() => {
    const seen = new Set(rows.map((r) => r.Serial));
    return devices.filter((d) => d.Location === loc && !seen.has(d.Serial));
  }, [devices, loc, rows]);

  // Nothing is written until here. The server re-derives each result and saves the audit.
  const commit = async () => {
    const newDevices = Object.fromEntries(rows.filter((r) => r.Type === 'New').map((r) => [r.Serial, { Make: r.Make, Model: r.Model, imei: r.imei || '' }]));
    const updates = Object.fromEntries(rows.map((r) => [r.Serial, { status: r.Status, fault: r.Fault }]));
    const j = await push('auditComplete', { site: loc, serials: rows.map((r) => r.Serial), newDevices, updates, remarks: remarks.trim() });
    if (j) { setReview(false); setRows([]); setRemarks(''); setDone(j); exportAudit(j); }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">HHD Device Audit</h2>
        <Input list="dl-audit-sites" value={q} placeholder="Type to search audit location…"
          onChange={(e) => { const v = e.target.value; setQ(v); setLoc(sites.includes(v) ? v : ''); }} />
        <datalist id="dl-audit-sites">{sites.map((s) => <option key={s} value={s} />)}</datalist>
        <div className="flex gap-2">
          <input ref={inp} disabled={!loc || !!warn || !!newDev || !!prompt} value={scan} onChange={(e) => onScan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={loc ? 'Scan serial or IMEI, press Enter' : 'Pick a location first'}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-slate-100" />
          <Btn onClick={() => add()} disabled={!loc || !scan.trim()}>Add</Btn>
        </div>
        {note && <div className="text-sm text-red-700 bg-red-50 rounded-lg p-2 flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" />{note}</div>}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex justify-between items-center">
          <h2 className="font-semibold">Scanned ({rows.length})</h2>
          <Btn disabled={!rows.length || busy || rows.some((r) => r.Status === 'Yet-to-be-find')} onClick={() => setReview(true)}><CheckCircle2 size={16} /> Complete Audit</Btn>
        </div>
        <div className="max-h-96 overflow-auto divide-y">
          {rows.map((r) => (
            <div key={r.Serial} className={`py-2 px-1 text-sm flex justify-between ${r.Type === 'Transferred' ? 'bg-red-50' : ''}`}>
              <span><span className="font-mono">{r.Serial}</span> <span className="text-slate-500">{r.Make} {r.Model}{r.imei && ` · IMEI ${r.imei}`}{r.From && ` · from ${r.From}`}</span></span>
              <span className="flex items-center gap-2">
                {r.Fault && <span className="text-xs text-red-700 max-w-[14rem] truncate" title={r.Fault}>{r.Fault}</span>}
                <Select className="!py-1" value={r.Status} aria-label={`Status of ${r.Serial}`}
                  onChange={(e) => (e.target.value === 'Not-Working'
                    ? setPrompt({ serial: r.Serial, title: `${r.Serial}: fault reason`, initial: { status: 'Not-Working', fault: r.Fault } })
                    : setRows((x) => x.map((y) => (y.Serial === r.Serial ? { ...y, Status: e.target.value, Fault: '' } : y))))}>
                  {EDITABLE.map((s) => <option key={s}>{s}</option>)}
                </Select>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[r.Type]}`}>{r.Type}</span>
                <button onClick={() => setRows((x) => x.filter((y) => y.Serial !== r.Serial))} aria-label={`Remove ${r.Serial}`} className="text-red-500"><Trash2 size={16} /></button>
              </span>
            </div>
          ))}
          {!rows.length && <div className="py-8 text-center text-slate-400">Nothing scanned yet.</div>}
        </div>
      </Card>

      {warn && (
        <Modal title="Location mismatch" onClose={cancel}>
          <div className="bg-red-50 border border-red-300 text-red-800 rounded-lg p-4 flex gap-2">
            <AlertTriangle size={18} className="shrink-0" />
            <span><b className="font-mono">{warn.Serial}</b>: This device belongs to <b>{warn.Location}</b>. Do you want to reassign it here?</span>
          </div>
          <div className="mt-4 flex gap-3">
            <Btn onClick={reassign} className="!bg-red-600 hover:!bg-red-700">Confirm</Btn>
            <Btn onClick={cancel} className="!bg-slate-500 hover:!bg-slate-600">Cancel</Btn>
          </div>
        </Modal>
      )}

      {prompt && (
        <StatusPrompt title={prompt.title} initial={prompt.initial}
          onConfirm={(c) => { setRows((rs) => rs.map((r) => (r.Serial === prompt.serial ? { ...r, Status: c.status, Fault: c.fault } : r))); setPrompt(null); focus(); }}
          onClose={() => { setPrompt(null); focus(); }} />
      )}

      {newDev && (
        <Modal title="New device found: capture details" onClose={() => { setNewDev(null); focus(); }}>
          <div className="space-y-2">
            <Input value={newDev.Serial} readOnly className="font-mono bg-slate-100" aria-label="Serial" />
            <Input placeholder="Make *" autoFocus value={newDev.Make} onChange={(e) => setNewDev({ ...newDev, Make: e.target.value })} />
            <Input placeholder="Model *" value={newDev.Model} onChange={(e) => setNewDev({ ...newDev, Model: e.target.value })} />
            <Input placeholder="IMEI / Device S.No (optional)" value={newDev.imei} onChange={(e) => setNewDev({ ...newDev, imei: e.target.value })} />
            <Select className="w-full" value={newDev.Status} onChange={(e) => setNewDev({ ...newDev, Status: e.target.value })} aria-label="Status">
              {STATUS_CHOICES.map((s) => <option key={s}>{s}</option>)}
            </Select>
            {newDev.Status === 'Not-Working' && (
              <FaultPick fault={newDev.fault} note={newDev.note}
                onFault={(v) => setNewDev({ ...newDev, fault: v })} onNote={(v) => setNewDev({ ...newDev, note: v })} />
            )}
          </div>
          <div className="mt-4 flex gap-3">
            <Btn onClick={saveNew} disabled={!newDev.Make.trim() || !newDev.Model.trim() || (newDev.Status === 'Not-Working' && !(newDev.fault && (newDev.fault !== OTHER || newDev.note.trim())))}>Add to audit</Btn>
            <Btn onClick={() => { setNewDev(null); focus(); }} className="!bg-slate-500 hover:!bg-slate-600">Cancel</Btn>
          </div>
        </Modal>
      )}

      {review && (
        <Modal title={`Audit summary — ${loc}`} onClose={() => setReview(false)}>
          <AuditSummary items={rows} missing={missing} />
          <div className="mt-4">
            <label className="text-sm font-medium" htmlFor="audit-remarks">Auditor remarks (observations)</label>
            <textarea id="audit-remarks" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)}
              placeholder="Anything the audit should record, e.g. condition of the store, pending items…"
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
          <p className="text-sm text-slate-600 mt-3">On confirm: {missing.length} missing device(s) are set to Yet-to-be-find, and {rows.filter((r) => r.Type === 'Transferred').length} transferred device(s) move to {loc}.</p>
          <div className="mt-4"><Btn onClick={commit} disabled={busy}><FileDown size={16} /> Confirm, Save & Download PDF + CSV</Btn></div>
        </Modal>
      )}

      {done && (
        <Modal title={`Audit ${done.auditId} saved — ${done.site}`} onClose={() => setDone(null)}>
          <AuditSummary items={done.items} missing={done.missing} at={done.at} />
          <div className="mt-4"><Btn onClick={() => exportAudit(done)}><FileDown size={16} /> Download PDF + CSV again</Btn></div>
        </Modal>
      )}
    </div>
  );
}

/* ---------- Audit Log (all users): every saved audit, and its missing / moved / new devices ---------- */
function AuditLog({ audits }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [limit, setLimit] = useState(200);
  const byDate = useMemo(() => [...audits].sort((a, b) => String(b.CompletedAt).localeCompare(String(a.CompletedAt))), [audits]);
  const flags = useMemo(() => byDate.flatMap((a) => (a.Items || []).filter((i) => i.Type !== 'Reconciled').map((i) => ({
    ...i, AuditID: a.AuditID, Site: a.Location, CompletedAt: a.CompletedAt,
    Age: i.Type === 'Missing' && i.LastScanned ? Math.floor((new Date(a.CompletedAt) - new Date(i.LastScanned)) / 864e5) : '',
  }))), [byDate]);
  const rows = useMemo(() => flags.filter((r) => (!kind || r.Type === kind) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))), [flags, kind, q]);
  useEffect(() => setLimit(200), [q, kind]);
  const th = 'p-3';
  return (
    <div className="space-y-4">
      <Card className="overflow-x-auto">
        <div className="p-4 font-semibold">Audits ({byDate.length})</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className={th}>Audit</th><th className={th}>Site</th><th className={th}>Auditor</th><th className={th}>Completed</th><th className={`${th} text-right`}>Scanned</th><th className={`${th} text-right`}>Reconciled</th><th className={`${th} text-right`}>New</th><th className={`${th} text-right`}>Transferred</th><th className={`${th} text-right`}>Missing</th></tr>
          </thead>
          <tbody>
            {byDate.map((a) => {
              const s = a.Summary || {};
              return (
                <tr key={a.AuditID} className="border-t">
                  <td className="p-3 font-mono">{a.AuditID}</td><td className="p-3">{a.Location}</td><td className="p-3">{a.Auditor}</td><td className="p-3 text-slate-500 whitespace-nowrap">{fmt(a.CompletedAt)}</td>
                  <td className="p-3 text-right">{s.total ?? '—'}</td><td className="p-3 text-right">{s.reconciled ?? '—'}</td><td className="p-3 text-right">{s.excess ?? '—'}</td><td className="p-3 text-right">{s.transferred ?? '—'}</td><td className="p-3 text-right">{s.missing ?? '—'}</td>
                </tr>
              );
            })}
            {!byDate.length && <tr><td colSpan={9} className="p-6 text-center text-slate-400">No audits yet</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-x-auto">
        <div className="p-4 flex flex-wrap gap-3 items-center">
          <span className="font-semibold">Missing, moved and new devices</span>
          <div className="relative flex-1 min-w-[200px]"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <Input className="pl-9" placeholder="Search serial, IMEI, site, auditor…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Result"><option value="">All results</option><option>Missing</option><option>Transferred</option><option>New</option></Select>
          <span className="text-sm text-slate-500">{rows.length} rows</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className={th}>When</th><th className={th}>Audit</th><th className={th}>Site</th><th className={th}>Serial</th><th className={th}>IMEI/Device S.No</th><th className={th}>Make / Model</th><th className={th}>Result</th><th className={th}>Previous location</th><th className={th}>Last scanned</th><th className={th}>Age (days)</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r, i) => (
              <tr key={`${r.AuditID}-${r.Serial}-${i}`} className="border-t">
                <td className="p-3 text-slate-500 whitespace-nowrap">{fmt(r.CompletedAt)}</td><td className="p-3 font-mono">{r.AuditID}</td><td className="p-3">{r.Site}</td>
                <td className="p-3 font-mono">{r.Serial}</td><td className="p-3 font-mono">{r.imei}</td><td className="p-3">{r.Make} {r.Model}</td>
                <td className="p-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[r.Type]}`}>{r.Type}</span></td>
                <td className="p-3">{r.From}</td><td className="p-3 text-slate-500 whitespace-nowrap">{r.LastScanned ? fmt(r.LastScanned) : ''}</td><td className="p-3">{r.Age}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="p-6 text-center text-slate-400">Nothing flagged</td></tr>}
          </tbody>
        </table>
        {rows.length > limit && <div className="p-4 text-center"><Btn onClick={() => setLimit(limit + 500)}>Show more ({rows.length - limit} left)</Btn></div>}
      </Card>
    </div>
  );
}

/* ---------- Master list CSV for one or more sites (in-transit devices included for sites they were sent from) ---------- */
function saveMaster(devices, tickets, sites) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['Serial', 'IMEI/Device S.No', 'Make', 'Model', 'Status', 'Fault', 'Location', 'Last Updated', 'Last Audited'];
  // in-transit devices keep no origin site, so take them from pending tickets sent from the selected sites
  const leaving = new Set(tickets.filter((t) => sites.includes(t.SenderSite) && t.Status === 'Pending Receipt').flatMap(serialsOf));
  const rows = devices.filter((d) => sites.includes(d.Location) || (inTransit(d) && leaving.has(d.Serial)))
    .sort((a, b) => String(a.Location).localeCompare(String(b.Location)) || String(a.Serial).localeCompare(String(b.Serial)))
    .map((d) => [d.Serial, d.imei_number || '', d.Make, d.Model, d.Status, d.FaultReason || '', d.Location, d.LastUpdated || '', d.LastAudited || '']);
  const text = [cols, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); // BOM so Excel reads UTF-8
  const name = sites.length === 1 ? sites[0] : `${sites.length}-sites`;
  const a = document.createElement('a');
  a.href = url; a.download = `HHD-Master-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}
