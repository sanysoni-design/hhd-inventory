import { useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, BadgeCheck, Boxes, ChevronRight, CircleHelp, Clock3,
  HardDrive, LayoutDashboard, Package, RefreshCw, Search, ShieldCheck, Smartphone,
  Truck, Users, UserRound, Wrench, X,
} from 'lucide-react';
import './overview-preview.css';

const fmt = (n) => new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));
const pct = (n) => (Number(n) || 0).toFixed(1) + '%';

const SITES = [
  { site: 'ONE NCR DC', total: 486, gc: 212, tl: 64, ops: 133, it: 54, quarantine: 17, lost: 6, transit: 4, shiftA: 96, shiftB: 91, shiftC: 89, workers: 205, coverage: 96.8, overdueHoto: 9, stoApproval: 2, stoDispatch: 1, stoReceipt: 2, itRepair: 5, itExceptions: 4, auditFresh: 98.2, sync: '08 min ago' },
  { site: 'BANGALORE DC', total: 421, gc: 198, tl: 58, ops: 102, it: 47, quarantine: 12, lost: 4, transit: 3, shiftA: 88, shiftB: 85, shiftC: 83, workers: 183, coverage: 97.1, overdueHoto: 8, stoApproval: 1, stoDispatch: 1, stoReceipt: 1, itRepair: 4, itExceptions: 3, auditFresh: 97.4, sync: '11 min ago' },
  { site: 'MUMBAI DC', total: 392, gc: 184, tl: 53, ops: 98, it: 42, quarantine: 10, lost: 5, transit: 2, shiftA: 82, shiftB: 79, shiftC: 76, workers: 171, coverage: 94.7, overdueHoto: 7, stoApproval: 2, stoDispatch: 0, stoReceipt: 1, itRepair: 3, itExceptions: 4, auditFresh: 95.8, sync: '15 min ago' },
  { site: 'CHENNAI DC', total: 268, gc: 121, tl: 36, ops: 72, it: 29, quarantine: 8, lost: 2, transit: 1, shiftA: 55, shiftB: 53, shiftC: 49, workers: 112, coverage: 95.4, overdueHoto: 5, stoApproval: 1, stoDispatch: 0, stoReceipt: 0, itRepair: 2, itExceptions: 2, auditFresh: 96.5, sync: '09 min ago' },
  { site: 'KOLKATA DC', total: 241, gc: 98, tl: 32, ops: 67, it: 34, quarantine: 8, lost: 2, transit: 2, shiftA: 46, shiftB: 44, shiftC: 40, workers: 101, coverage: 93.9, overdueHoto: 6, stoApproval: 0, stoDispatch: 1, stoReceipt: 1, itRepair: 3, itExceptions: 3, auditFresh: 94.6, sync: '22 min ago' },
  { site: 'HYDERABAD DC', total: 289, gc: 115, tl: 36, ops: 82, it: 44, quarantine: 9, lost: 3, transit: 3, shiftA: 53, shiftB: 50, shiftC: 48, workers: 124, coverage: 96.1, overdueHoto: 4, stoApproval: 1, stoDispatch: 1, stoReceipt: 0, itRepair: 3, itExceptions: 2, auditFresh: 97.7, sync: '12 min ago' },
  { site: 'PUNE XD', total: 305, gc: 134, tl: 41, ops: 79, it: 39, quarantine: 9, lost: 3, transit: 4, shiftA: 60, shiftB: 59, shiftC: 56, workers: 132, coverage: 95.8, overdueHoto: 6, stoApproval: 1, stoDispatch: 0, stoReceipt: 1, itRepair: 2, itExceptions: 3, auditFresh: 96.1, sync: '17 min ago' },
  { site: 'NCR BILASPUR DC', total: 514, gc: 224, tl: 74, ops: 135, it: 58, quarantine: 17, lost: 6, transit: 5, shiftA: 104, shiftB: 100, shiftC: 94, workers: 228, coverage: 97.6, overdueHoto: 12, stoApproval: 2, stoDispatch: 1, stoReceipt: 2, itRepair: 6, itExceptions: 5, auditFresh: 98.5, sync: '06 min ago' },
];

const ROLE_SCOPE = {
  admin: { label: 'Administrator', scope: SITES.map((s) => s.site), description: 'Network-wide control · all authorised sites', kind: 'network' },
  operations_spoc: { label: 'Asset Manager', scope: ['ONE NCR DC', 'BANGALORE DC'], description: 'Asset distribution, stock movement and site accountability', kind: 'site' },
  site_lead: { label: 'Allocator', scope: ['ONE NCR DC', 'NCR BILASPUR DC', 'BANGALORE DC'], description: 'GC/TL allocation, custody coverage and shift closure', kind: 'allocation' },
  assigned_employee: { label: 'Custodian', scope: ['ONE NCR DC'], description: 'Own virtual accountability and devices deployed to GC/TL', kind: 'own' },
  site_it: { label: 'Site IT', scope: ['ONE NCR DC'], description: 'IT-owned inventory, STO receipts and repair queue', kind: 'it' },
};

const ROLE_STATS = {
  assigned_employee: { accountability: 18, withWorkers: 15, hotoOpen: 2, condition: 1 },
};

const PROCESS_ROWS = [
  { process: 'Inbound', gc: 168, tl: 42, devices: 210, coverage: 97.2, hoto: 5 },
  { process: 'Outbound', gc: 142, tl: 38, devices: 180, coverage: 95.8, hoto: 4 },
  { process: 'Sortation', gc: 112, tl: 29, devices: 141, coverage: 96.5, hoto: 3 },
  { process: 'Returns', gc: 43, tl: 11, devices: 54, coverage: 92.6, hoto: 2 },
];

const MY_DEVICES = [
  { serial: 'HHD-01842', holder: 'R. Kumar', type: 'GC', process: 'Inbound', shift: 'A', model: 'tc22', physical: 'Good', functional: 'Working', state: 'With GC', last: '13:42' },
  { serial: 'HHD-01877', holder: 'A. Singh', type: 'TL', process: 'Outbound', shift: 'B', model: 'ct45', physical: 'Good', functional: 'Working', state: 'With TL', last: '12:58' },
  { serial: 'HHD-01901', holder: 'S. Yadav', type: 'GC', process: 'Sortation', shift: 'A', model: 'tc26', physical: 'Damaged', functional: 'Working', state: 'With GC', last: '12:31' },
  { serial: 'HHD-01916', holder: 'M. Das', type: 'GC', process: 'Inbound', shift: 'C', model: 'tc22', physical: 'Good', functional: 'Working', state: 'With GC', last: '11:46' },
  { serial: 'HHD-01940', holder: 'P. Verma', type: 'TL', process: 'Returns', shift: 'B', model: 'ct45', physical: 'Good', functional: 'Working', state: 'HOTO due', last: '10:22' },
];

const IT_STOS = [
  { sto: 'STO-261128-018', devices: 3, from: 'Operations', status: 'Awaiting receipt', age: '03h 24m', priority: 'High' },
  { sto: 'STO-261128-015', devices: 2, from: 'Operations', status: 'In transit', age: '01h 12m', priority: 'Normal' },
  { sto: 'STO-261127-094', devices: 1, from: 'Operations', status: 'Awaiting receipt', age: '21h 08m', priority: 'Critical' },
];

function sumRows(rows) {
  return rows.reduce((a, s) => {
    ['total', 'gc', 'tl', 'ops', 'it', 'quarantine', 'lost', 'transit', 'shiftA', 'shiftB', 'shiftC', 'workers', 'overdueHoto', 'stoApproval', 'stoDispatch', 'stoReceipt', 'itRepair', 'itExceptions'].forEach((k) => { a[k] = (a[k] || 0) + (Number(s[k]) || 0); });
    a.coverageWeighted = (a.coverageWeighted || 0) + s.coverage * s.workers;
    a.auditWeighted = (a.auditWeighted || 0) + s.auditFresh * s.total;
    a.weight = (a.weight || 0) + s.workers;
    a.totalWeight = (a.totalWeight || 0) + s.total;
    return a;
  }, {});
}

function Metric({ label, value, note, icon: Icon, tone = 'teal', delta, onClick }) {
  return (
    <button className={'ovp-metric ovp-metric-' + tone} onClick={onClick} type="button">
      <span className="ovp-metric-top"><span>{label}</span><i><Icon size={17}/></i></span>
      <strong>{value}</strong>
      <span className="ovp-metric-bottom"><small>{note}</small>{delta && <b>{delta}</b>}</span>
    </button>
  );
}

function Panel({ title, subtitle, action, children, className = '' }) {
  return <section className={'ovp-panel ' + className}><div className="ovp-panel-head"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>;
}

function Badge({ children, tone = 'slate' }) {
  return <span className={'ovp-badge ovp-badge-' + tone}>{children}</span>;
}

function Select({ label, value, onChange, options, disabled = false }) {
  return <label className="ovp-filter"><span>{label}</span><select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
}

function StackedBar({ rows }) {
  const total = Math.max(1, rows.reduce((a, r) => a + r.value, 0));
  return <div className="ovp-stacked-track" aria-label="Inventory distribution">
    {rows.map((r) => <span key={r.label} title={r.label + ': ' + fmt(r.value)} style={{ width: (r.value / total * 100) + '%', background: r.color }}/>)}
  </div>;
}

function MiniBars({ data }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return <div className="ovp-mini-chart">{data.map((d) => <div className="ovp-mini-col" key={d.label}>
    <div className="ovp-mini-bar-wrap"><span style={{ height: (d.value / max * 100) + '%' }}/></div>
    <small>{d.label}</small><b>{d.value}</b>
  </div>)}</div>;
}

export default function OverviewDashboardPreview() {
  const [role, setRole] = useState('admin');
  const [site, setSite] = useState('All sites');
  const [period, setPeriod] = useState('7d');
  const [shift, setShift] = useState('all');
  const [process, setProcess] = useState('all');
  const [model, setModel] = useState('all');
  const [condition, setCondition] = useState('all');
  const [siteSearch, setSiteSearch] = useState('');
  const [activeQueue, setActiveQueue] = useState('');
  const [refreshed, setRefreshed] = useState('14:08');

  const roleDef = ROLE_SCOPE[role];
  const allowedSites = roleDef.scope;
  const siteValue = site === 'All sites' || site === 'All assigned sites' ? 'All assigned sites' : site;
  const isAllSites = siteValue === 'All assigned sites';
  const scopedSites = useMemo(() => {
    const inScope = SITES.filter((s) => allowedSites.includes(s.site));
    return isAllSites ? inScope : inScope.filter((s) => s.site === site);
  }, [allowedSites, isAllSites, site]);

  const totals = useMemo(() => sumRows(scopedSites), [scopedSites]);
  const onGround = shift === 'all' ? totals.gc + totals.tl : scopedSites.reduce((a, s) => a + (shift === 'A' ? s.shiftA : shift === 'B' ? s.shiftB : s.shiftC), 0);
  const modelFactor = model === 'tc22' ? 0.46 : model === 'ct45' ? 0.31 : model === 'tc26' ? 0.23 : 1;
  const conditionFactor = condition === 'good' ? 0.91 : condition === 'damaged' ? 0.06 : condition === 'notworking' ? 0.03 : 1;
  const filteredFactor = modelFactor * conditionFactor;
  const inventoryTotal = Math.round((totals.total || 0) * filteredFactor);
  const processFactor = process === 'inbound' ? 0.36 : process === 'outbound' ? 0.31 : process === 'sortation' ? 0.24 : process === 'returns' ? 0.09 : 1;
  const filteredOnGround = Math.round(onGround * filteredFactor * processFactor);
  const filteredOps = Math.round((totals.ops || 0) * filteredFactor);
  const filteredIT = Math.round((totals.it || 0) * filteredFactor);
  const filteredQuarantine = Math.round((totals.quarantine || 0) * filteredFactor);
  const filteredLost = Math.round((totals.lost || 0) * filteredFactor);
  const filteredTransit = Math.round((totals.transit || 0) * modelFactor);
  const processRows = PROCESS_ROWS.filter((r) => process === 'all' || r.process.toLowerCase() === process);
  const averageCoverage = totals.weight ? totals.coverageWeighted / totals.weight : 0;
  const auditFresh = totals.totalWeight ? totals.auditWeighted / totals.totalWeight : 0;
  const pendingSto = (totals.stoApproval || 0) + (totals.stoDispatch || 0) + (totals.stoReceipt || 0);

  const changeRole = (next) => {
    setRole(next);
    const first = ROLE_SCOPE[next].scope[0];
    setSite(next === 'admin' ? 'All sites' : ROLE_SCOPE[next].scope.length > 1 ? 'All assigned sites' : first);
    setShift('all'); setProcess('all'); setModel('all'); setCondition('all'); setActiveQueue('');
  };
  const siteOptions = [
    ...(role === 'admin' ? [{ value: 'All sites', label: 'All sites (network)' }] : roleDef.scope.length > 1 ? [{ value: 'All assigned sites', label: 'All assigned sites' }] : []),
    ...roleDef.scope.map((s) => ({ value: s, label: s })),
  ];
  const resetFilters = () => { setShift('all'); setProcess('all'); setModel('all'); setCondition('all'); setPeriod('7d'); setSiteSearch(''); setActiveQueue(''); };

  const siteRows = scopedSites.filter((s) => !siteSearch || s.site.toLowerCase().includes(siteSearch.toLowerCase()));
  const own = ROLE_STATS.assigned_employee;
  const trend7 = [{ label: 'M', value: 18 }, { label: 'T', value: 26 }, { label: 'W', value: 22 }, { label: 'T', value: 31 }, { label: 'F', value: 28 }, { label: 'S', value: 36 }, { label: 'S', value: 29 }];
  const trend30 = [{ label: 'W1', value: 164 }, { label: 'W2', value: 188 }, { label: 'W3', value: 172 }, { label: 'W4', value: 216 }];
  const trend90 = [{ label: 'Sep', value: 620 }, { label: 'Oct', value: 688 }, { label: 'Nov', value: 731 }];
  const trend = period === '7d' ? trend7 : period === '30d' ? trend30 : trend90;

  const actions = roleDef.kind === 'network' ? [
    { id: 'sto-approval', title: 'STO awaiting approval', count: totals.stoApproval, age: 'Oldest: 05h 18m', tone: 'amber', owner: 'Custodian / Allocator' },
    { id: 'sto-dispatch', title: 'Approved · awaiting dispatch', count: totals.stoDispatch, age: 'Oldest: 03h 42m', tone: 'blue', owner: 'Asset Manager' },
    { id: 'sto-receipt', title: 'Site IT receipt pending', count: totals.stoReceipt, age: '3 lines > 12h', tone: 'red', owner: 'Site IT' },
    { id: 'hoto-overdue', title: 'HOTO open past shift end', count: totals.overdueHoto, age: 'Needs shift closure', tone: 'red', owner: 'Asset Manager / GC / TL' },
    { id: 'audit-stale', title: 'Audit freshness below 95%', count: scopedSites.filter((s) => s.auditFresh < 95).length, age: 'Sites needing reconciliation', tone: 'amber', owner: 'Site operations' },
  ] : roleDef.kind === 'site' ? [
    { id: 'sto-approval', title: 'STO awaiting approval', count: totals.stoApproval, age: 'Approval SLA at risk', tone: 'amber', owner: 'Custodian / Allocator' },
    { id: 'sto-dispatch', title: 'Approved · awaiting dispatch', count: totals.stoDispatch, age: 'Dispatch queue', tone: 'blue', owner: 'Asset Manager' },
    { id: 'sto-receipt', title: 'Site IT receipt pending', count: totals.stoReceipt, age: 'Receipt SLA at risk', tone: 'red', owner: 'Site IT' },
    { id: 'hoto-overdue', title: 'HOTO open past shift end', count: totals.overdueHoto, age: 'Shift accountability', tone: 'red', owner: 'Site operations' },
  ] : roleDef.kind === 'allocation' ? [
    { id: 'hoto-overdue', title: 'HOTO open past shift end', count: totals.overdueHoto, age: 'Close or explain exceptions', tone: 'red', owner: 'GC / TL' },
    { id: 'coverage', title: 'Allocation coverage below 95%', count: scopedSites.filter((s) => s.coverage < 95).length, age: 'Review employee entitlements', tone: 'amber', owner: 'Allocator' },
    { id: 'condition', title: 'Devices with condition exception', count: Math.round((totals.quarantine + totals.itExceptions) * 0.22), age: 'Confirm physical status', tone: 'amber', owner: 'Custodian / Asset Manager' },
  ] : roleDef.kind === 'own' ? [
    { id: 'own-hoto', title: 'Devices awaiting GC/TL HOTO return', count: own.hotoOpen, age: 'Review at shift close', tone: 'amber', owner: 'You / GC / TL' },
    { id: 'own-condition', title: 'Your devices with condition flag', count: own.condition, age: 'Review condition and remarks', tone: 'red', owner: 'You / Asset Manager' },
  ] : [
    { id: 'sto-receipt', title: 'STO awaiting physical receipt', count: totals.stoReceipt, age: 'Scan device IMEI to receive', tone: 'red', owner: 'Site IT' },
    { id: 'it-repair', title: 'IT repair queue', count: totals.itRepair, age: 'Review ageing and vendor SLA', tone: 'amber', owner: 'Site IT' },
    { id: 'it-condition', title: 'IT devices with health exception', count: totals.itExceptions, age: 'Update condition and remarks', tone: 'red', owner: 'Site IT' },
  ];

  const metrics = roleDef.kind === 'network' || roleDef.kind === 'site' ? [
    { label: 'Total site inventory', value: fmt(inventoryTotal), note: isAllSites ? 'Registered across sites in scope' : 'Registered at selected site', icon: Boxes, tone: 'teal', delta: 'BOOK STOCK' },
    { label: 'On ground · GC / TL', value: fmt(filteredOnGround), note: shift === 'all' ? 'Physical holder confirmed on shift' : 'Selected shift only', icon: Users, tone: 'violet', delta: 'PHYSICAL CUSTODY' },
    { label: 'With Asset Manager', value: fmt(filteredOps), note: 'Operations desk · available stock', icon: UserRound, tone: 'blue', delta: 'OPS STOCK' },
    { label: 'With Site IT', value: fmt(filteredIT), note: 'IT department physical inventory', icon: HardDrive, tone: 'dark', delta: 'IT CUSTODY' },
    { label: 'Quarantined / repair', value: fmt(filteredQuarantine), note: 'Not eligible for allocation', icon: Wrench, tone: 'amber', delta: 'CONDITION' },
    { label: 'In transit', value: fmt(filteredTransit), note: 'Separate from on-site total', icon: Truck, tone: 'slate', delta: 'MOVEMENT' },
  ] : roleDef.kind === 'allocation' ? [
    { label: 'GC / TL devices in hand', value: fmt(filteredOnGround), note: 'Live physical custody', icon: Smartphone, tone: 'violet', delta: 'GROUND STOCK' },
    { label: 'Active GC / TL roster', value: fmt(totals.workers), note: 'On-roll allocation recipients', icon: Users, tone: 'teal', delta: 'ACTIVE ROSTER' },
    { label: 'Allocation coverage', value: pct(averageCoverage), note: 'Workers within authorised HHD quantity', icon: BadgeCheck, tone: 'blue', delta: 'CONTROL' },
    { label: 'HOTO overdue', value: fmt(totals.overdueHoto), note: 'Open beyond shift end', icon: Clock3, tone: 'amber', delta: 'SHIFT CONTROL' },
    { label: 'Condition exceptions', value: fmt(Math.round((totals.quarantine + totals.itExceptions) * 0.22)), note: 'Assigned devices flagged for review', icon: AlertTriangle, tone: 'red', delta: 'ACTION' },
  ] : roleDef.kind === 'own' ? [
    { label: 'Devices under my accountability', value: fmt(own.accountability), note: 'Virtual custody · not physical stock', icon: ShieldCheck, tone: 'teal', delta: 'MY SCOPE' },
    { label: 'Currently with GC / TL', value: fmt(own.withWorkers), note: 'Physical holder on shift', icon: Users, tone: 'violet', delta: 'GROUND' },
    { label: 'Awaiting HOTO takeover', value: fmt(own.hotoOpen), note: 'Expected shift-end return', icon: Clock3, tone: 'amber', delta: 'DUE' },
    { label: 'Condition exceptions', value: fmt(own.condition), note: 'Needs condition review', icon: AlertTriangle, tone: 'red', delta: 'HEALTH' },
  ] : [
    { label: 'Site IT physical inventory', value: fmt(filteredIT), note: 'Received against approved STO', icon: HardDrive, tone: 'dark', delta: 'IT STOCK' },
    { label: 'STO receipts pending', value: fmt(totals.stoReceipt), note: 'Awaiting barcode scan / confirmation', icon: Package, tone: 'amber', delta: 'INBOUND' },
    { label: 'Under repair', value: fmt(totals.itRepair), note: 'IT-owned devices in repair queue', icon: Wrench, tone: 'blue', delta: 'REPAIR' },
    { label: 'Health exceptions', value: fmt(totals.itExceptions), note: 'Damaged or non-working IT devices', icon: AlertTriangle, tone: 'red', delta: 'ACTION' },
  ];

  const distribution = roleDef.kind === 'it'
    ? [{ label: 'Site IT', value: filteredIT, color: '#263a53' }, { label: 'Repair / exception', value: totals.itRepair + totals.itExceptions, color: '#e5a43b' }]
    : roleDef.kind === 'own'
      ? [{ label: 'With GC/TL', value: own.withWorkers, color: '#7856b8' }, { label: 'At Operations / return pending', value: own.accountability - own.withWorkers, color: '#0d927e' }]
      : [
        { label: 'GC / TL on ground', value: filteredOnGround, color: '#7856b8' },
        { label: 'Asset Manager / Ops desk', value: filteredOps, color: '#0d927e' },
        { label: 'Site IT', value: filteredIT, color: '#263a53' },
        { label: 'Quarantine / repair', value: filteredQuarantine, color: '#e5a43b' },
        { label: 'Lost / missing', value: filteredLost, color: '#cf5d5d' },
      ];
  const distributionTotal = distribution.reduce((a, x) => a + x.value, 0);

  const trendDesc = period === '7d' ? 'Daily HOTO and asset movement events' : period === '30d' ? 'Weekly HOTO and STO movement events' : 'Monthly movement trend';
  const activeProcesses = processRows.map((r) => ({ ...r, gc: shift === 'all' ? r.gc : Math.round(r.gc * (shift === 'A' ? 0.36 : shift === 'B' ? 0.34 : 0.30)), tl: shift === 'all' ? r.tl : Math.round(r.tl * (shift === 'A' ? 0.36 : shift === 'B' ? 0.34 : 0.30)) }));

  return (
    <div className="ovp-shell">
      <aside className="ovp-sidebar">
        <div className="ovp-brand"><div className="ovp-brand-mark"><Boxes size={21}/></div><div><strong>HHD<span>•</span>Control</strong><small>ASSET OPERATIONS</small></div></div>
        <div className="ovp-sidebar-context"><span>PREVIEW MODE</span><strong>Role-level overview</strong><small>Illustrative interface · no live records</small></div>
        <nav className="ovp-nav">
          <button className="active"><LayoutDashboard size={17}/>Overview dashboard<ChevronRight size={15}/></button>
          <button type="button"><Smartphone size={17}/>Device custody register</button>
          <button type="button"><Package size={17}/>STO & movement control</button>
          <button type="button"><Activity size={17}/>Condition & audit</button>
          <button type="button"><ShieldCheck size={17}/>Admin controls</button>
        </nav>
        <div className="ovp-sidebar-foot"><span className="ovp-sidebar-dot"/><div><strong>Demo workspace</strong><small>Sample values only</small></div></div>
      </aside>

      <main className="ovp-main">
        <header className="ovp-topbar">
          <div><span className="ovp-eyebrow">OPERATIONS CONTROL CENTRE / OVERVIEW</span><h1>Inventory overview</h1><p>One view of physical custody, department stock, asset health and pending control actions.</p></div>
          <div className="ovp-top-actions"><Badge tone="demo">DEMO PREVIEW</Badge><button type="button" className="ovp-refresh" onClick={() => setRefreshed('14:08')}><RefreshCw size={15}/>Refresh preview</button><div className="ovp-avatar">AM</div></div>
        </header>

        <section className="ovp-control-bar">
          <div className="ovp-role-select">
            <label><span>PREVIEW AS ROLE</span><select value={role} onChange={(e) => changeRole(e.target.value)}>{Object.entries(ROLE_SCOPE).map(([key, r]) => <option value={key} key={key}>{r.label}</option>)}</select></label>
            <p>{roleDef.description}</p>
          </div>
          <div className="ovp-filter-grid">
            <Select label="SITE" value={site} onChange={setSite} disabled={roleDef.scope.length === 1} options={siteOptions}/>
            <Select label="ACTIVITY WINDOW" value={period} onChange={setPeriod} options={[{value:'7d',label:'Last 7 days'},{value:'30d',label:'Last 30 days'},{value:'90d',label:'Last 90 days'}]}/>
            <Select label="SHIFT" value={shift} onChange={setShift} options={[{value:'all',label:'All shifts'},{value:'A',label:'Shift A'},{value:'B',label:'Shift B'},{value:'C',label:'Shift C'}]}/>
            <Select label="PROCESS" value={process} onChange={setProcess} options={[{value:'all',label:'All processes'},...PROCESS_ROWS.map((r) => ({value:r.process.toLowerCase(),label:r.process}))]}/>
            <Select label="DEVICE MODEL" value={model} onChange={setModel} options={[{value:'all',label:'All models'},{value:'tc22',label:'Zebra TC22'},{value:'ct45',label:'Honeywell CT45'},{value:'tc26',label:'Zebra TC26'}]}/>
            <Select label="CONDITION" value={condition} onChange={setCondition} options={[{value:'all',label:'All conditions'},{value:'good',label:'Good / Working'},{value:'damaged',label:'Damaged'},{value:'notworking',label:'Not working'}]}/>
          </div>
          <button type="button" className="ovp-reset" onClick={resetFilters}><X size={14}/>Reset</button>
        </section>

        <div className="ovp-data-note"><CircleHelp size={14}/><span>Illustrative data for layout review. Role selection changes the visible scope; it does not grant or change actual application permissions. Model and condition filter inventory counts; shift and process narrow GC/TL custody details.</span><small>Sample refreshed {refreshed}</small></div>

        {roleDef.kind === 'network' && <div className="ovp-network-strip"><div><span>NETWORK SCOPE</span><strong>{scopedSites.length} sites</strong></div><div><span>REGISTERED INVENTORY</span><strong>{fmt(totals.total)} devices</strong></div><div><span>OVERALL ALLOCATION COVERAGE</span><strong>{pct(averageCoverage)}</strong></div><div><span>AUDIT / RECONCILIATION FRESHNESS</span><strong>{pct(auditFresh)}</strong></div></div>}

        <section className="ovp-metrics">
          {metrics.map((m) => <Metric key={m.label} {...m} onClick={() => setActiveQueue(m.label)}/>)}
        </section>

        {roleDef.kind === 'network' || roleDef.kind === 'site' ? (
          <div className="ovp-two-col">
            <Panel title="Where is the inventory?" subtitle={isAllSites ? 'Mutually exclusive physical-position buckets · in-transit is separate' : 'Physical position at ' + site}>
              <div className="ovp-dist-total"><strong>{fmt(inventoryTotal)}</strong><span>{isAllSites ? 'devices across current site scope' : 'registered devices at selected site'}</span></div>
              <StackedBar rows={distribution}/>
              <div className="ovp-legend">{distribution.map((r) => <div key={r.label}><span style={{background:r.color}}/><span>{r.label}</span><b>{fmt(r.value)}</b><small>{pct(distributionTotal ? r.value / distributionTotal * 100 : 0)}</small></div>)}</div>
              <div className="ovp-explain"><ShieldCheck size={15}/><span>GC/TL counts are physical HOTO holders. Asset Manager/Ops desk is stock physically available at Operations. Site IT is separate department stock. Buckets do not overlap. Shift and process filters narrow the GC/TL slice; the site totals remain scope-level.</span></div>
            </Panel>
            <Panel title="Control actions requiring attention" subtitle="Prioritised by approval, dispatch, receipt and shift-close SLA" action={<Badge tone="warning">{fmt(actions.reduce((a, x) => a + (x.count || 0), 0))} open items</Badge>}>
              <div className="ovp-action-list">{actions.map((a) => <button type="button" key={a.id} className={'ovp-action-row ' + (activeQueue === a.id ? 'selected' : '')} onClick={() => setActiveQueue(activeQueue === a.id ? '' : a.id)}>
                <span className={'ovp-action-icon ovp-tone-' + a.tone}>{a.tone === 'red' ? <AlertTriangle size={16}/> : a.tone === 'amber' ? <Clock3 size={16}/> : <Package size={16}/>}</span>
                <span className="ovp-action-copy"><strong>{a.title}</strong><small>{a.age} · Owner: {a.owner}</small></span>
                <b>{fmt(a.count)}</b><ChevronRight size={15}/>
              </button>)}</div>
              <div className="ovp-panel-foot"><span>Click an item to pin it for follow-up.</span><Badge tone="muted">SLA monitored</Badge></div>
            </Panel>
          </div>
        ) : roleDef.kind === 'allocation' ? (
          <div className="ovp-two-col">
            <Panel title="GC / TL custody by process" subtitle="Current physical holder count, grouped by operational process">
              <div className="ovp-process-list">{activeProcesses.map((r) => <div className="ovp-process-row" key={r.process}><div><strong>{r.process}</strong><small>{fmt(r.gc + r.tl)} devices in physical custody</small></div><div className="ovp-process-bars"><span style={{width:(r.gc / Math.max(1,r.gc+r.tl)*100)+'%'}}/><i style={{width:(r.tl / Math.max(1,r.gc+r.tl)*100)+'%'}}/></div><b>{pct(r.coverage)}</b></div>)}</div>
              <div className="ovp-explain"><Users size={15}/><span>Allocator view focuses on entitled employee coverage and physical GC/TL custody. It does not show a tile for unallocated devices.</span></div>
            </Panel>
            <Panel title="Shift closure and allocation controls" subtitle="Exceptions requiring allocator or site-lead action">
              <div className="ovp-action-list">{actions.map((a) => <button type="button" key={a.id} className="ovp-action-row" onClick={() => setActiveQueue(a.id)}><span className={'ovp-action-icon ovp-tone-' + a.tone}><Clock3 size={16}/></span><span className="ovp-action-copy"><strong>{a.title}</strong><small>{a.age} · {a.owner}</small></span><b>{fmt(a.count)}</b><ChevronRight size={15}/></button>)}</div>
            </Panel>
          </div>
        ) : roleDef.kind === 'own' ? (
          <div className="ovp-two-col">
            <Panel title="My virtual accountability" subtitle="Custodian accountability is virtual; physical holder is shown separately">
              <div className="ovp-own-summary"><div><strong>{fmt(own.accountability)}</strong><span>My mapped devices</span></div><div><strong>{fmt(own.withWorkers)}</strong><span>Currently with GC/TL</span></div><div><strong>{fmt(own.accountability - own.withWorkers)}</strong><span>At Operations / return path</span></div></div>
              <div className="ovp-explain"><ShieldCheck size={15}/><span>Do not treat the Custodian as the physical stock location. This view links virtual responsibility to the current GC/TL holder and HOTO state.</span></div>
            </Panel>
            <Panel title="My action queue" subtitle="Items that need personal follow-up"><div className="ovp-action-list">{actions.map((a) => <button type="button" className="ovp-action-row" key={a.id} onClick={() => setActiveQueue(a.id)}><span className={'ovp-action-icon ovp-tone-' + a.tone}><AlertTriangle size={16}/></span><span className="ovp-action-copy"><strong>{a.title}</strong><small>{a.age} · {a.owner}</small></span><b>{fmt(a.count)}</b><ChevronRight size={15}/></button>)}</div></Panel>
          </div>
        ) : (
          <div className="ovp-two-col">
            <Panel title="Site IT inventory position" subtitle="Only devices received into Site IT through an approved STO">
              <div className="ovp-dist-total"><strong>{fmt(filteredIT)}</strong><span>IT-owned devices at selected site</span></div>
              <div className="ovp-it-breakdown"><div><span>Working / serviceable</span><b>{fmt(Math.max(0, filteredIT - totals.itRepair - totals.itExceptions))}</b></div><div><span>Repair queue</span><b>{fmt(totals.itRepair)}</b></div><div><span>Condition exceptions</span><b>{fmt(totals.itExceptions)}</b></div></div>
              <div className="ovp-explain"><Package size={15}/><span>Site IT receives only against an approved STO. Dispatch and receipt events remain separately auditable.</span></div>
            </Panel>
            <Panel title="STO receipt and repair queue" subtitle="Incoming device transfers and IT service follow-up">
              <div className="ovp-action-list">{actions.map((a) => <button type="button" className="ovp-action-row" key={a.id} onClick={() => setActiveQueue(a.id)}><span className={'ovp-action-icon ovp-tone-' + a.tone}><Package size={16}/></span><span className="ovp-action-copy"><strong>{a.title}</strong><small>{a.age} · {a.owner}</small></span><b>{fmt(a.count)}</b><ChevronRight size={15}/></button>)}</div>
            </Panel>
          </div>
        )}

        <section className="ovp-two-col ovp-middle">
          <Panel title={roleDef.kind === 'own' ? 'My device custody ledger' : roleDef.kind === 'it' ? 'STO receipt register' : 'Movement and HOTO trend'} subtitle={roleDef.kind === 'own' ? 'Sample device-level accountability, physical holder and health' : roleDef.kind === 'it' ? 'Device receipt must match an authorised STO line' : trendDesc} action={<Badge tone="muted">{period.toUpperCase()} WINDOW</Badge>}>
            {roleDef.kind === 'own' ? <div className="ovp-table-wrap"><table><thead><tr><th>HHD</th><th>Current physical holder</th><th>Process / shift</th><th>Condition</th><th>Status</th><th>Last scan</th></tr></thead><tbody>{MY_DEVICES.filter((d) => (process === 'all' || d.process.toLowerCase() === process) && (shift === 'all' || d.shift === shift) && (model === 'all' || d.model === model) && (condition === 'all' || (condition === 'good' && d.physical === 'Good' && d.functional === 'Working') || (condition === 'damaged' && d.physical === 'Damaged') || (condition === 'notworking' && d.functional === 'Not working'))).map((d) => <tr key={d.serial}><td><strong>{d.serial}</strong></td><td>{d.holder} <small>{d.type}</small></td><td>{d.process}<small>Shift {d.shift}</small></td><td><Badge tone={d.physical === 'Damaged' ? 'warning' : 'success'}>{d.physical} · {d.functional}</Badge></td><td><Badge tone={d.state === 'HOTO due' ? 'danger' : 'success'}>{d.state}</Badge></td><td>{d.last}</td></tr>)}</tbody></table></div>
              : roleDef.kind === 'it' ? <div className="ovp-table-wrap"><table><thead><tr><th>STO reference</th><th>Lines</th><th>From</th><th>Status</th><th>Age</th><th>Priority</th></tr></thead><tbody>{IT_STOS.map((r) => <tr key={r.sto}><td><strong>{r.sto}</strong></td><td>{r.devices}</td><td>{r.from}</td><td><Badge tone={r.status === 'Awaiting receipt' ? 'warning' : 'info'}>{r.status}</Badge></td><td>{r.age}</td><td><Badge tone={r.priority === 'Critical' ? 'danger' : r.priority === 'High' ? 'warning' : 'muted'}>{r.priority}</Badge></td></tr>)}</tbody></table></div>
              : <><MiniBars data={trend}/><div className="ovp-trend-foot"><span><i className="ovp-dot ovp-dot-teal"/> HOTO / STO movement events</span><span><i className="ovp-dot ovp-dot-violet"/> Includes issues, takeovers and transfers</span></div></>}
          </Panel>
          <Panel title={roleDef.kind === 'network' ? 'Site performance and control health' : roleDef.kind === 'site' ? 'Site health indicators' : roleDef.kind === 'allocation' ? 'Allocation health by process' : roleDef.kind === 'own' ? 'HOTO and condition watch' : 'IT repair ageing'} subtitle={roleDef.kind === 'network' ? 'Inventory position, control exceptions and freshness' : 'Operational measures for this role scope'}>
            {roleDef.kind === 'network' || roleDef.kind === 'site' ? <div className="ovp-health-list">
              <div><span>Allocation coverage</span><strong>{pct(averageCoverage)}</strong><div className="ovp-progress"><i style={{width:averageCoverage+'%'}}/></div></div>
              <div><span>Inventory audit freshness</span><strong>{pct(auditFresh)}</strong><div className="ovp-progress"><i style={{width:auditFresh+'%'}}/></div></div>
              <div><span>Devices quarantined / repair</span><strong>{fmt(totals.quarantine + totals.itRepair)}</strong><small>Excluded from serviceable issue stock</small></div>
              <div><span>Lost / missing asset records</span><strong>{fmt(totals.lost)}</strong><small>Require incident closure and accountability</small></div>
              <div><span>Movement outside approved flow</span><strong>0</strong><small>Expected to remain zero · STO-only into Site IT</small></div>
            </div> : roleDef.kind === 'allocation' ? <div className="ovp-health-list">
              <div><span>Worker coverage against entitlement</span><strong>{pct(averageCoverage)}</strong><div className="ovp-progress"><i style={{width:averageCoverage+'%'}}/></div></div>
              <div><span>HOTO closure after shift end</span><strong>{fmt(totals.overdueHoto)}</strong><small>Open handovers require closure or documented reason</small></div>
              <div><span>Process below 95% coverage</span><strong>{scopedSites.filter((s) => s.coverage < 95).length}</strong><small>Allocator review required</small></div>
            </div> : roleDef.kind === 'own' ? <div className="ovp-health-list">
              <div><span>Devices with active GC/TL holder</span><strong>{fmt(own.withWorkers)}</strong><small>Physical holder confirmed separately</small></div>
              <div><span>HOTO outstanding</span><strong>{fmt(own.hotoOpen)}</strong><small>Verify return at shift close</small></div>
              <div><span>Condition flags</span><strong>{fmt(own.condition)}</strong><small>Update notes before release</small></div>
            </div> : <div className="ovp-health-list">
              <div><span>IT inventory under repair</span><strong>{fmt(totals.itRepair)}</strong><small>Review vendor / internal SLA</small></div>
              <div><span>IT devices with condition flags</span><strong>{fmt(totals.itExceptions)}</strong><small>Close inspection and remark gaps</small></div>
              <div><span>Oldest open STO receipt</span><strong>21h 08m</strong><small>Escalate to Asset Manager</small></div>
            </div>}
          </Panel>
        </section>

        {(roleDef.kind === 'network' || roleDef.kind === 'site') && <Panel title="Site inventory control matrix" subtitle="A site-by-site reconciliation of physical position; select a row to focus the site filter" action={<label className="ovp-search"><Search size={14}/><input value={siteSearch} onChange={(e) => setSiteSearch(e.target.value)} placeholder="Find a site"/></label>}>
          <div className="ovp-table-wrap"><table><thead><tr><th>Site</th><th>Total inventory</th><th>GC / TL</th><th>Asset Manager</th><th>Site IT</th><th>Quarantine</th><th>Lost</th><th>STO open</th><th>HOTO overdue</th><th>Audit freshness</th></tr></thead><tbody>{siteRows.map((s) => <tr key={s.site} onClick={() => setSite(s.site)} className={site === s.site ? 'ovp-row-active' : ''}><td><strong>{s.site}</strong><small>Last sync {s.sync}</small></td><td><b>{fmt(s.total)}</b></td><td>{fmt(s.gc + s.tl)}</td><td>{fmt(s.ops)}</td><td>{fmt(s.it)}</td><td><Badge tone={s.quarantine >= 15 ? 'warning' : 'muted'}>{fmt(s.quarantine)}</Badge></td><td><Badge tone={s.lost ? 'danger' : 'success'}>{fmt(s.lost)}</Badge></td><td>{fmt(s.stoApproval + s.stoDispatch + s.stoReceipt)}</td><td>{fmt(s.overdueHoto)}</td><td><Badge tone={s.auditFresh < 95 ? 'warning' : 'success'}>{pct(s.auditFresh)}</Badge></td></tr>)}</tbody><tfoot><tr><td><strong>Scope total</strong></td><td><strong>{fmt(totals.total)}</strong></td><td>{fmt(totals.gc + totals.tl)}</td><td>{fmt(totals.ops)}</td><td>{fmt(totals.it)}</td><td>{fmt(totals.quarantine)}</td><td>{fmt(totals.lost)}</td><td>{fmt(pendingSto)}</td><td>{fmt(totals.overdueHoto)}</td><td>{pct(auditFresh)}</td></tr></tfoot></table></div>
        </Panel>}

        {roleDef.kind === 'allocation' && <Panel title="GC / TL allocation oversight" subtitle="Cumulative authorised quantities and currently mapped devices; additive allocations remain visible as authorised quantity increases.">
          <div className="ovp-table-wrap"><table><thead><tr><th>Process</th><th>Active GCs</th><th>Active TLs</th><th>Devices in physical custody</th><th>Coverage</th><th>HOTO overdue</th><th>Control</th></tr></thead><tbody>{activeProcesses.map((r) => <tr key={r.process}><td><strong>{r.process}</strong></td><td>{fmt(r.gc)}</td><td>{fmt(r.tl)}</td><td>{fmt(r.gc + r.tl)}</td><td><Badge tone={r.coverage < 95 ? 'warning' : 'success'}>{pct(r.coverage)}</Badge></td><td>{r.hoto}</td><td><Badge tone={r.coverage < 95 ? 'warning' : 'success'}>{r.coverage < 95 ? 'Review' : 'Within control'}</Badge></td></tr>)}</tbody></table></div>
        </Panel>}

        <div className="ovp-footer-note"><ShieldCheck size={15}/><span><strong>Mandatory control logic:</strong> site total = current site inventory positions; GC/TL = physical HOTO holder; Asset Manager = Operations desk stock; Site IT = IT-owned stock received through STO. Custodian responsibility is virtual and must never be added as a separate physical bucket. In-transit is reported separately to avoid inflating site inventory.</span></div>
        <footer className="ovp-footer"><span>HHD Control · Overview dashboard concept</span><span>UI preview only · Not connected to live inventory</span></footer>
      </main>
    </div>
  );
}

