import { useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeftRight, ArrowUpRight, BadgeCheck, Bell, Boxes,
  Building2, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Download, FileClock, Filter, Gauge, ArrowDownToLine, LayoutDashboard, ListChecks, LockKeyhole, Menu,
  MoreHorizontal, Package, Plus, RefreshCw, ScanLine, Search, ShieldCheck,
  Smartphone, Sparkles, Users, UserRound, UserRoundPlus, Wrench, X,
} from 'lucide-react';
import './operations-workspace.css';

const cx = (...v) => v.filter(Boolean).join(' ');
const fmt = (v) => new Intl.NumberFormat('en-IN').format(v);
const nowLabel = () => new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const INITIAL_USERS = [
  { id: 'USR-001', employeeId: 'OPS1001', username: 'ops1001', name: 'Aarav Mehta', email: 'aarav.mehta@company.com', role: 'Operations SPOC', designation: 'Operations SPOC', site: 'DEL-01', process: 'Operations', status: 'Active', lastLogin: 'Today, 09:42' },
  { id: 'USR-002', employeeId: 'SL1024', username: 'sl1024', name: 'Neha Verma', email: 'neha.verma@company.com', role: 'Site Lead', designation: 'Site Lead', site: 'DEL-01', process: 'Inbound', status: 'Active', lastLogin: 'Today, 08:15' },
  { id: 'USR-003', employeeId: 'EMP1048', username: 'emp1048', name: 'Rahul Kumar', email: 'rahul.kumar@company.com', role: 'Assigned Employee', designation: 'AM', site: 'DEL-01', process: 'Inbound', status: 'Active', lastLogin: 'Yesterday' },
  { id: 'USR-004', employeeId: 'EMP1091', username: 'emp1091', name: 'Amit Singh', email: 'amit.singh@company.com', role: 'Assigned Employee', designation: 'Sr. Lead', site: 'DEL-01', process: 'Outbound', status: 'Active', lastLogin: 'Today, 10:04' },
  { id: 'USR-005', employeeId: 'OPS2002', username: 'ops2002', name: 'Priya Nair', email: 'priya.nair@company.com', role: 'Operations SPOC', designation: 'Operations SPOC', site: 'BLR-02', process: 'Operations', status: 'Active', lastLogin: 'Today, 07:58' },
  { id: 'USR-006', employeeId: 'EMP1187', username: 'emp1187', name: 'Karan Das', email: 'karan.das@company.com', role: 'Assigned Employee', designation: 'Lead', site: 'DEL-01', process: 'Processing', status: 'Inactive', lastLogin: '18 Nov 2026' },
  { id: 'USR-007', employeeId: 'EMP1142', username: 'emp1142', name: 'Priya Sharma', email: 'priya.sharma@company.com', role: 'Assigned Employee', designation: 'Lead', site: 'DEL-01', process: 'Processing', status: 'Active', lastLogin: 'Today, 09:02' },
  { id: 'USR-008', employeeId: 'EMP1211', username: 'emp1211', name: 'Neha Gupta', email: 'neha.gupta@company.com', role: 'Assigned Employee', designation: 'AM', site: 'DEL-01', process: 'Exception', status: 'Active', lastLogin: 'Today, 08:47' },
  { id: 'USR-009', employeeId: 'EMP1230', username: 'emp1230', name: 'Rohit Das', email: 'rohit.das@company.com', role: 'Assigned Employee', designation: 'Lead', site: 'BLR-02', process: 'Inbound', status: 'Active', lastLogin: 'Yesterday, 15:03' },
];

const INITIAL_ROLES = [
  { id: 'admin', name: 'Administrator', users: 2, scope: 'All sites', description: 'Full system administration and governed overrides' },
  { id: 'it', name: 'Site IT', users: 8, scope: 'Assigned site(s)', description: 'IT inventory, STO dispatch and receipt acknowledgement' },
  { id: 'ops_spoc', name: 'Operations SPOC', users: 14, scope: 'Assigned site', description: 'Operations stock, STO receipt, HOTO and return to IT' },
  { id: 'site_lead', name: 'Site Lead', users: 32, scope: 'Assigned site', description: 'Employee-wise quantity allocation and reconciliation' },
  { id: 'assigned', name: 'Assigned Employee', users: 186, scope: 'Own records', description: 'Collect and view personally assigned HHD devices' },
];

const MODULES = [
  { id: 'dashboard', name: 'Dashboard', actions: ['View', 'Export'] },
  { id: 'sto', name: 'STO Receiving', actions: ['View', 'Create', 'Receive', 'Dispatch', 'Close'] },
  { id: 'stock', name: 'Operations Stock', actions: ['View', 'Adjust', 'Quarantine', 'Export'] },
  { id: 'allocation', name: 'Quantity Allocation', actions: ['View', 'Create', 'Edit', 'Revoke', 'Approve'] },
  { id: 'collection', name: 'IMEI Collection', actions: ['View', 'Scan', 'Assign', 'Return'] },
  { id: 'hoto', name: 'Shift HOTO', actions: ['View', 'Handover', 'Takeover', 'Swap', 'Close'] },
  { id: 'hr', name: 'HR Worker Master', actions: ['View', 'Sync', 'Export'] },
  { id: 'users', name: 'User & ID Management', actions: ['View', 'Create', 'Edit', 'Deactivate', 'Reset Access'] },
  { id: 'roles', name: 'Roles & Permissions', actions: ['View', 'Create', 'Edit', 'Assign'] },
  { id: 'audit', name: 'Audit & Reports', actions: ['View', 'Export', 'Reconcile'] },
];

const DEFAULT_PERMISSION_MATRIX = {
  admin: Object.fromEntries(MODULES.map((m) => [m.id, Object.fromEntries(m.actions.map((a) => [a, true]))])),
  ops_spoc: {
    dashboard: { View: true, Export: true }, sto: { View: true, Receive: true, Dispatch: true, Close: true },
    stock: { View: true, Quarantine: true, Export: true }, allocation: { View: true },
    collection: { View: true, Return: true }, hoto: { View: true, Handover: true, Takeover: true, Swap: true, Close: true },
    hr: { View: true }, users: { View: true }, roles: { View: true }, audit: { View: true, Export: true },
  },
  site_lead: {
    dashboard: { View: true }, stock: { View: true }, allocation: { View: true, Create: true, Edit: true, Revoke: true },
    collection: { View: true }, audit: { View: true },
  },
  assigned: { dashboard: { View: true }, allocation: { View: true }, collection: { View: true, Scan: true, Assign: true, Return: true }, hoto: { View: true } },
  it: { dashboard: { View: true }, sto: { View: true, Create: true, Dispatch: true, Receive: true, Close: true }, stock: { View: true, Adjust: true, Quarantine: true }, audit: { View: true, Export: true } },
};

const INITIAL_ALLOCATIONS = [
  { id: 'ALC-00241', employeeId: 'EMP1048', employee: 'Rahul Kumar', designation: 'AM', process: 'Inbound', site: 'DEL-01', authorized: 5, collected: 3, serials: ['HHD-0008', 'HHD-0014', 'HHD-0027'], status: 'Partially collected', updated: 'Today, 10:14' },
  { id: 'ALC-00240', employeeId: 'EMP1091', employee: 'Amit Singh', designation: 'Sr. Lead', process: 'Outbound', site: 'DEL-01', authorized: 8, collected: 8, serials: ['HHD-0032', 'HHD-0033', 'HHD-0034', 'HHD-0035', 'HHD-0036', 'HHD-0037', 'HHD-0038', 'HHD-0039'], status: 'Fully collected', updated: 'Today, 09:32' },
  { id: 'ALC-00239', employeeId: 'EMP1142', employee: 'Priya Sharma', designation: 'Lead', process: 'Processing', site: 'DEL-01', authorized: 10, collected: 7, serials: ['HHD-0041', 'HHD-0042', 'HHD-0043', 'HHD-0044', 'HHD-0045', 'HHD-0046', 'HHD-0047'], status: 'Partially collected', updated: 'Yesterday, 18:12' },
  { id: 'ALC-00238', employeeId: 'EMP1211', employee: 'Neha Gupta', designation: 'AM', process: 'Exception', site: 'DEL-01', authorized: 4, collected: 0, serials: [], status: 'Pending collection', updated: 'Yesterday, 16:28' },
  { id: 'ALC-00237', employeeId: 'EMP1230', employee: 'Rohit Das', designation: 'Lead', process: 'Inbound', site: 'BLR-02', authorized: 6, collected: 6, serials: ['HHD-1021', 'HHD-1022', 'HHD-1023', 'HHD-1024', 'HHD-1025', 'HHD-1026'], status: 'Fully collected', updated: 'Yesterday, 15:03' },
];

const INITIAL_DEVICES = Array.from({ length: 50 }, (_, i) => {
  const n = i + 1;
  const serial = `HHD-${String(n).padStart(4, '0')}`;
  const assignedTo = n === 8 || n === 14 || n === 27 ? 'Rahul Kumar'
    : n >= 32 && n <= 39 ? 'Amit Singh'
      : n >= 41 && n <= 47 ? 'Priya Sharma' : '';
  const maintenance = [5, 11].includes(n);
  return {
    serial,
    imei: `860123456789${String(n).padStart(3, '0')}`,
    model: n % 2 ? 'Zebra TC21' : 'Honeywell EDA52',
    site: 'DEL-01',
    physical: maintenance && n === 5 ? 'Damaged' : 'Good',
    functional: maintenance ? 'Not Working' : 'Working',
    location: maintenance ? 'Maintenance' : assignedTo ? 'Assigned employee' : 'Operations stock',
    holder: assignedTo || '—',
  };
}).concat(Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  return {
    serial: `HHD-${String(1020 + n).padStart(4, '0')}`,
    imei: `860123456790${String(n).padStart(3, '0')}`,
    model: n % 2 ? 'Zebra TC21' : 'Honeywell EDA52',
    site: 'BLR-02', physical: 'Good', functional: 'Working',
    location: n <= 6 ? 'Assigned employee' : 'Operations stock',
    holder: n <= 6 ? 'Rohit Das' : '—',
  };
}));

const HR_WORKERS = [
  { id: 'GC00125', name: 'Sanjay Yadav', type: 'GC', site: 'DEL-01', process: 'Inbound', status: 'Active', synced: 'Today, 07:30' },
  { id: 'TL00418', name: 'Manish Raj', type: 'TL', site: 'DEL-01', process: 'Outbound', status: 'Active', synced: 'Today, 07:30' },
  { id: 'GC00146', name: 'Deepak Kumar', type: 'GC', site: 'DEL-01', process: 'Processing', status: 'Active', synced: 'Today, 07:30' },
  { id: 'TL00431', name: 'Vivek Sharma', type: 'TL', site: 'BLR-02', process: 'Exception', status: 'Active', synced: 'Today, 07:30' },
  { id: 'GC00088', name: 'Ramesh Pal', type: 'GC', site: 'DEL-01', process: 'Inbound', status: 'Inactive', synced: 'Today, 07:30' },
];

const NAV_BY_ROLE = {
  Admin: [
    { group: 'Workspace', items: [['overview', 'Overview', LayoutDashboard], ['inventory', 'Device inventory', Smartphone], ['allocations', 'Quantity allocations', ListChecks], ['collection', 'IMEI collection', ScanLine], ['hoto', 'Shift HOTO', ArrowLeftRight]] },
    { group: 'Administration', items: [['users', 'Users & IDs', UserRoundPlus], ['permissions', 'Roles & permissions', ShieldCheck], ['hr', 'HR worker master', Users], ['audit', 'Audit & activity', FileClock]] },
  ],
  'Site IT': [
    { group: 'IT Operations', items: [['overview', 'Overview', LayoutDashboard], ['inventory', 'IT inventory', Boxes], ['sto', 'STO dispatch & receipts', Package], ['audit', 'Device inspection history', FileClock]] },
  ],
  'Operations SPOC': [
    { group: 'Operations', items: [['overview', 'Overview', LayoutDashboard], ['inventory', 'Operations stock', Boxes], ['sto', 'Incoming STO', Package], ['hoto', 'Shift HOTO', ArrowLeftRight], ['audit', 'Movement history', FileClock]] },
  ],
  'Site Lead': [
    { group: 'Operations', items: [['overview', 'Overview', LayoutDashboard], ['allocations', 'Quantity allocations', ListChecks], ['collection', 'Collection status', ScanLine], ['audit', 'Allocation history', FileClock]] },
  ],
  'Assigned Employee': [
    { group: 'My workspace', items: [['overview', 'My dashboard', LayoutDashboard], ['collection', 'Collect HHDs', ScanLine], ['mydevices', 'My devices', Smartphone]] },
  ],
};

function Pill({ children, tone = 'neutral' }) { return <span className={`ow-pill ow-pill-${tone}`}>{children}</span>; }
function Card({ children, className = '' }) { return <section className={`ow-card ${className}`}>{children}</section>; }
function PageTitle({ eyebrow, title, subtitle, actions }) {
  return <div className="ow-page-title"><div><div className="ow-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{actions && <div className="ow-title-actions">{actions}</div>}</div>;
}
function Metric({ label, value, change, icon: Icon, tone = 'blue', foot }) {
  return <Card className="ow-metric"><div className={`ow-metric-icon ow-tone-${tone}`}><Icon size={19}/></div><div className="ow-metric-label">{label}</div><div className="ow-metric-value">{value}</div><div className="ow-metric-foot">{change && <span>{change}</span>}{foot && <small>{foot}</small>}</div></Card>;
}
function SearchBox({ value, onChange, placeholder = 'Search anything…' }) { return <label className="ow-search"><Search size={16}/><input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}/></label>; }
function SelectField({ label, value, onChange, options, placeholder }) { return <label className="ow-field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{placeholder || `Select ${label.toLowerCase()}`}</option>{options.map((o) => <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>{typeof o === 'string' ? o : o.label}</option>)}</select></label>; }
function EmptyState({ title, detail }) { return <div className="ow-empty"><div><Package size={26}/></div><strong>{title}</strong><span>{detail}</span></div>; }

export default function OperationsWorkspace() {
  const [role, setRole] = useState('Admin');
  const [tab, setTab] = useState('overview');
  const [site, setSite] = useState('DEL-01');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState('');
  const [users, setUsers] = useState(INITIAL_USERS);
  const [roles, setRoles] = useState(INITIAL_ROLES);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSION_MATRIX);
  const [allocations, setAllocations] = useState(INITIAL_ALLOCATIONS);
  const [devices, setDevices] = useState(INITIAL_DEVICES);
  const [workers] = useState(HR_WORKERS);
  const [activeModal, setActiveModal] = useState('');
  const [selectedRole, setSelectedRole] = useState('ops_spoc');
  const [selectedAllocation, setSelectedAllocation] = useState(INITIAL_ALLOCATIONS[0].id);
  const [scanEmployeeId] = useState('EMP1048');
  const [imeiInput, setImeiInput] = useState('');
  const [scanMessage, setScanMessage] = useState('');
  const [allocationForm, setAllocationForm] = useState({ employeeId: '', employee: '', designation: '', process: 'Inbound', quantity: 1, reason: '' });
  const [userForm, setUserForm] = useState({ employeeId: '', username: '', name: '', email: '', role: 'Assigned Employee', designation: 'Lead', site: 'DEL-01', process: 'Inbound' });
  const [roleForm, setRoleForm] = useState({ name: '', description: '', scope: 'Assigned site' });
  const [hrLastSync, setHrLastSync] = useState('25 Nov 2026, 07:30');
  const [hotoForm, setHotoForm] = useState({ imei: '', workerId: '', shift: 'Shift A', action: 'Handover' });
  const [hotoRows, setHotoRows] = useState([{ id: 'HOTO-00182', imei: '860123456789008', serial: 'HHD-0008', worker: 'Sanjay Yadav', workerId: 'GC00125', shift: 'Shift A', action: 'Handover', time: 'Today, 08:14', status: 'Completed' }]);
  const [activity, setActivity] = useState([{ id: 'ACT-001', message: 'Rahul Kumar collected 3 HHDs against ALC-00241', time: 'Today, 10:14', tone: 'success' }, { id: 'ACT-002', message: 'STO-2026-00125 partially received: 18 of 20 devices', time: 'Today, 09:42', tone: 'warning' }, { id: 'ACT-003', message: 'HR TL/GC master synchronized successfully', time: 'Today, 07:30', tone: 'info' }]);

  const nav = NAV_BY_ROLE[role] || NAV_BY_ROLE.Admin;
  const current = nav.flatMap((g) => g.items).find((i) => i[0] === tab) || nav[0].items[0];
  const currentTitle = current?.[1] || 'Overview';
  const siteDevices = devices.filter((d) => d.site === site);
  const stockDevices = siteDevices.filter((d) => d.location === 'Operations stock' && d.physical === 'Good' && d.functional === 'Working');
  const assignedDevices = siteDevices.filter((d) => d.location === 'Assigned employee');
  const maintenanceDevices = siteDevices.filter((d) => d.location === 'Maintenance');
  const siteAllocations = allocations.filter((a) => a.site === site);
  const visibleAllocations = role === 'Assigned Employee' ? siteAllocations.filter((a) => a.employeeId === scanEmployeeId) : siteAllocations;
  const totalAuthorized = visibleAllocations.reduce((s, a) => s + a.authorized, 0);
  const totalCollected = visibleAllocations.reduce((s, a) => s + a.collected, 0);
  const completion = totalAuthorized ? Math.round(totalCollected / totalAuthorized * 100) : 0;
  const selectedAlloc = allocations.find((a) => a.id === selectedAllocation);
  const employeeAlloc = allocations.find((a) => a.employeeId.toLowerCase() === scanEmployeeId.trim().toLowerCase() && a.site === site);
  const filteredAllocations = siteAllocations.filter((a) => `${a.employee} ${a.employeeId} ${a.process} ${a.id}`.toLowerCase().includes(search.toLowerCase()));
  const filteredDevices = siteDevices.filter((d) => `${d.serial} ${d.imei} ${d.model} ${d.location} ${d.holder}`.toLowerCase().includes(search.toLowerCase()));
  const employeeForForm = users.find((u) => u.employeeId.toLowerCase() === allocationForm.employeeId.trim().toLowerCase());

  const notify = (message) => { setToast(message); window.clearTimeout(notify.timer); notify.timer = window.setTimeout(() => setToast(''), 3200); };
  const pushActivity = (message, tone = 'success') => setActivity((prev) => [{ id: `ACT-${Date.now()}`, message, time: nowLabel(), tone }, ...prev].slice(0, 8));

  const doScan = () => {
    const code = imeiInput.trim();
    if (!code) return setScanMessage('Scan or enter the device IMEI / serial number.');
    if (!employeeAlloc) return setScanMessage('No active quantity allocation found for this employee at the selected site.');
    if (employeeAlloc.collected >= employeeAlloc.authorized) return setScanMessage('Authorized quantity already collected. Ask the Site Lead to revise the allocation.');
    const device = devices.find((d) => d.site === site && (d.serial.toLowerCase() === code.toLowerCase() || d.imei === code));
    if (!device) return setScanMessage('Device not found in this site inventory. Verify the IMEI / asset serial.');
    if (device.location !== 'Operations stock' || device.physical !== 'Good' || device.functional !== 'Working') return setScanMessage(`Device is not available for allocation. Current state: ${device.location} · ${device.physical} · ${device.functional}.`);
    setDevices((prev) => prev.map((d) => d.serial === device.serial ? { ...d, location: 'Assigned employee', holder: employeeAlloc.employee } : d));
    setAllocations((prev) => prev.map((a) => a.id === employeeAlloc.id ? { ...a, collected: a.collected + 1, serials: [...a.serials, device.serial], status: a.collected + 1 === a.authorized ? 'Fully collected' : 'Partially collected', updated: nowLabel() } : a));
    setScanMessage(`${device.serial} mapped to ${employeeAlloc.employee}. ${employeeAlloc.authorized - employeeAlloc.collected - 1} collection(s) remaining.`);
    pushActivity(`${employeeAlloc.employee} collected ${device.serial} through employee scan`, 'success');
    setImeiInput('');
  };

  const saveAllocation = (e) => {
    e.preventDefault();
    const employee = users.find((u) => u.employeeId.toLowerCase() === allocationForm.employeeId.trim().toLowerCase() && u.site === site && u.status === 'Active');
    if (!employee) return notify('Employee ID is not an active on-roll user at this site.');
    const qty = Number(allocationForm.quantity);
    const existing = allocations.find((a) => a.employeeId === employee.employeeId && a.site === site && a.process === allocationForm.process);
    const reservedOther = siteAllocations.filter((a) => a.id !== existing?.id).reduce((s, a) => s + Math.max(0, a.authorized - a.collected), 0);
    const availableToAllocate = Math.max(0, stockDevices.length - reservedOther);
    if (!Number.isInteger(qty) || qty < 1) return notify('Enter a valid positive whole-number quantity.');
    if (existing && qty < existing.collected) return notify(`Cannot reduce below ${existing.collected} already collected device(s). Reconcile physical returns first.`);
    if (existing && qty < existing.authorized && !allocationForm.reason.trim()) return notify('An adjustment reason is mandatory when reducing an existing allocation.');
    if (qty > availableToAllocate + (existing ? existing.authorized - existing.collected : 0)) return notify('Quantity exceeds unreserved available stock.');
    if (existing) {
      setAllocations((prev) => prev.map((a) => a.id === existing.id ? { ...a, authorized: qty, status: a.collected === qty ? 'Fully collected' : a.collected ? 'Partially collected' : 'Pending collection', updated: nowLabel() } : a));
      pushActivity(`${employee.name} allocation adjusted to ${qty}. Reason: ${allocationForm.reason || 'Operational requirement'}`, 'warning');
      notify('Allocation updated with an audit entry.');
    } else {
      const row = { id: `ALC-${String(Date.now()).slice(-5)}`, employeeId: employee.employeeId, employee: employee.name, designation: employee.designation, process: allocationForm.process, site, authorized: qty, collected: 0, serials: [], status: 'Pending collection', updated: nowLabel() };
      setAllocations((prev) => [row, ...prev]);
      pushActivity(`${employee.name} received a quantity entitlement of ${qty} HHDs`, 'info');
      notify('Quantity allocation created. No IMEI has been reserved or assigned.');
    }
    setActiveModal('');
    setAllocationForm({ employeeId: '', employee: '', designation: '', process: 'Inbound', quantity: 1, reason: '' });
  };

  const saveUser = (e) => {
    e.preventDefault();
    if (users.some((u) => u.employeeId.toLowerCase() === userForm.employeeId.trim().toLowerCase() || u.username?.toLowerCase() === userForm.username.trim().toLowerCase())) return notify('Employee ID or Login ID already exists.');
    if (!userForm.username.trim()) return notify('Login ID is required.');
    const row = { id: `USR-${String(Date.now()).slice(-5)}`, ...userForm, status: 'Active', lastLogin: 'Never' };
    setUsers((prev) => [row, ...prev]);
    pushActivity(`Application login account created for ${row.name} (${row.employeeId})`, 'success');
    setActiveModal(''); setUserForm({ employeeId: '', username: '', name: '', email: '', role: 'Assigned Employee', designation: 'Lead', site, process: 'Inbound' });
    notify('Demo account created locally. Connect identity provisioning before production use.');
  };

  const saveRole = (e) => {
    e.preventDefault();
    if (!roleForm.name.trim()) return notify('Enter a role name.');
    const id = roleForm.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (roles.some((r) => r.id === id)) return notify('A role with this name already exists.');
    setRoles((prev) => [...prev, { id, name: roleForm.name.trim(), users: 0, scope: roleForm.scope, description: roleForm.description }]);
    setPermissions((prev) => ({ ...prev, [id]: {} }));
    setSelectedRole(id); setRoleForm({ name: '', description: '', scope: 'Assigned site' }); setActiveModal('');
    notify('Demo role created. Assign permissions before assigning users.');
  };

  const togglePermission = (roleId, moduleId, action) => setPermissions((prev) => ({ ...prev, [roleId]: { ...prev[roleId], [moduleId]: { ...prev[roleId]?.[moduleId], [action]: !prev[roleId]?.[moduleId]?.[action] } } }));

  const syncHr = () => {
    setHrLastSync(`${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}, ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
    pushActivity('HR TL/GC master sync requested. Preview data refreshed locally.', 'info');
    notify('Preview sync simulated. Live Google Sheets integration is not connected.');
  };

  const submitHoto = (e) => {
    e.preventDefault();
    const worker = workers.find((w) => w.id.toLowerCase() === hotoForm.workerId.trim().toLowerCase() && w.site === site && w.status === 'Active');
    const device = devices.find((d) => d.imei === hotoForm.imei || d.serial === hotoForm.imei);
    if (!worker) return notify('TL/GC not found as active for this site in the synchronized HR master.');
    if (!device || device.site !== site) return notify('Select a valid device from this site.');
    const row = { id: `HOTO-${String(Date.now()).slice(-5)}`, imei: device.imei, serial: device.serial, worker: worker.name, workerId: worker.id, shift: hotoForm.shift, action: hotoForm.action, time: nowLabel(), status: 'Completed' };
    setHotoRows((prev) => [row, ...prev]);
    pushActivity(`${hotoForm.action} recorded: ${device.serial} → ${worker.name} (${worker.type})`, 'success');
    setHotoForm({ imei: '', workerId: '', shift: 'Shift A', action: 'Handover' });
    notify('HOTO preview transaction recorded locally.');
  };

  const changeTab = (id) => { setTab(id); setSearch(''); setSidebarOpen(false); };

  return (
    <div className="ow-shell">
      <aside className={cx('ow-sidebar', sidebarOpen && 'ow-sidebar-open')}>
        <div className="ow-brand"><div className="ow-brand-mark"><Boxes size={19}/></div><div><strong>HHD<span>•</span>Control</strong><small>ASSET OPERATIONS</small></div><button className="ow-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X size={18}/></button></div>
        <div className="ow-workspace-switch"><div className="ow-workspace-avatar">SF</div><div><strong>Shadowfax Operations</strong><small>Workspace · {site}</small></div><ChevronDown size={15}/></div>
        <div className="ow-nav-scroll">
          {nav.map((group) => <div className="ow-nav-group" key={group.group}><div className="ow-nav-label">{group.group}</div>{group.items.map(([id, label, Icon]) => <button key={id} onClick={() => changeTab(id)} className={cx('ow-nav-item', tab === id && 'active')}><Icon size={17}/><span>{label}</span>{id === 'sto' && <i>3</i>}</button>)}</div>)}
        </div>
        <div className="ow-sidebar-footer"><div className="ow-help"><CircleHelp size={17}/><span>Help & documentation</span><ArrowUpRight size={14}/></div><div className="ow-profile"><div className="ow-avatar">{role === 'Admin' ? 'AD' : role === 'Site IT' ? 'IT' : role === 'Site Lead' ? 'SL' : role === 'Assigned Employee' ? 'AE' : 'OS'}</div><div className="ow-profile-copy"><strong>{role === 'Admin' ? 'System Admin' : role === 'Site IT' ? 'Site IT User' : role === 'Site Lead' ? 'Neha Verma' : role === 'Assigned Employee' ? 'Rahul Kumar' : 'Aarav Mehta'}</strong><small>{role}</small></div><MoreHorizontal size={18}/></div></div>
      </aside>
      {sidebarOpen && <button className="ow-mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"/>}
      <main className="ow-main">
        <header className="ow-topbar">
          <button className="ow-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={19}/></button>
          <div className="ow-breadcrumb"><span>Operations</span><ChevronRight size={14}/><strong>{currentTitle}</strong></div>
          <div className="ow-top-actions"><SearchBox value={search} onChange={setSearch} placeholder="Search records…"/><label className="ow-site-select"><Building2 size={15}/><select value={site} disabled={role !== 'Admin'} onChange={(e) => setSite(e.target.value)}><option>DEL-01</option><option>BLR-02</option></select></label><button className="ow-icon-button" aria-label="Notifications"><Bell size={18}/><i/></button><div className="ow-top-avatar">{role === 'Admin' ? 'AD' : role === 'Site IT' ? 'IT' : role === 'Site Lead' ? 'SL' : role === 'Assigned Employee' ? 'AE' : 'OS'}</div></div>
        </header>
        <div className="ow-preview-banner"><Sparkles size={14}/><span><strong>Interactive UI preview</strong> · Sample data only · Changes stay in this browser session</span><span className="ow-preview-right">Live backend not connected</span></div>
        <div className="ow-content">
          <div className="ow-toolbar-row"><div className="ow-role-preview"><span>Preview as</span><select value={role} onChange={(e) => { const nextRole = e.target.value; setRole(nextRole); setTab('overview'); if (nextRole !== 'Admin') setSite('DEL-01'); }}><option>Admin</option><option>Site IT</option><option>Operations SPOC</option><option>Site Lead</option><option>Assigned Employee</option></select></div><div className="ow-toolbar-meta"><span><span className="ow-live-dot"/> System preview</span><span>Last refresh: just now</span></div></div>
          {toast && <div className="ow-toast"><CheckCircle2 size={16}/>{toast}<button onClick={() => setToast('')}><X size={14}/></button></div>}
          {tab === 'overview' && <Overview role={role} site={site} stock={stockDevices.length} assigned={assignedDevices.length} maintenance={maintenanceDevices.length} totalAuthorized={totalAuthorized} totalCollected={totalCollected} completion={completion} allocations={visibleAllocations} activity={activity} onNavigate={changeTab}/>}
          {tab === 'inventory' && <InventoryPage site={site} devices={filteredDevices} stock={stockDevices.length} assigned={assignedDevices.length} maintenance={maintenanceDevices.length} onSearchClear={() => setSearch('')}/>}
          {tab === 'sto' && <StoPage site={site} onCreate={() => notify('STO creation is part of the next integration slice.')}/>}
          {tab === 'allocations' && <AllocationsPage site={site} allocations={filteredAllocations} stock={stockDevices.length} onCreate={() => { setAllocationForm({ employeeId: '', employee: '', designation: '', process: 'Inbound', quantity: 1, reason: '' }); setActiveModal('allocation'); }} onEdit={(row) => { setAllocationForm({ employeeId: row.employeeId, employee: row.employee, designation: row.designation, process: row.process, quantity: row.authorized, reason: '' }); setSelectedAllocation(row.id); setActiveModal('allocation'); }}/>}
          {tab === 'collection' && <CollectionPage role={role} site={site} allocations={visibleAllocations} devices={devices} imeiInput={imeiInput} setImeiInput={setImeiInput} employeeAlloc={employeeAlloc} scanMessage={scanMessage} onScan={doScan} />}
          {tab === 'hoto' && <HotoPage site={site} workers={workers.filter((w) => w.site === site)} devices={siteDevices} hotoForm={hotoForm} setHotoForm={setHotoForm} hotoRows={hotoRows} onSubmit={submitHoto}/>}
          {tab === 'users' && <UsersPage users={users.filter((u) => u.site === site)} onCreate={() => { setUserForm({ employeeId: '', username: '', name: '', email: '', role: 'Assigned Employee', designation: 'Lead', site, process: 'Inbound' }); setActiveModal('user'); }} onDeactivate={(id) => { setUsers((prev) => prev.map((u) => u.id === id ? { ...u, status: u.status === 'Active' ? 'Inactive' : 'Active' } : u)); notify('User status updated in preview.'); }}/ >}
          {tab === 'permissions' && <PermissionsPage roles={roles} modules={MODULES} permissions={permissions} selectedRole={selectedRole} setSelectedRole={setSelectedRole} onToggle={togglePermission} onCreate={() => setActiveModal('role')}/>}
          {tab === 'hr' && <HrPage workers={workers} lastSync={hrLastSync} onSync={syncHr}/>}
          {tab === 'audit' && <AuditPage activity={activity} hotoRows={hotoRows} allocations={allocations}/>}
          {tab === 'mydevices' && <MyDevicesPage allocation={employeeAlloc} devices={devices}/>}
        </div>
        <footer className="ow-footer"><span>HHD Control · Operations workspace</span><span>Preview build 0.1.0 <span>·</span> India Standard Time</span></footer>
      </main>
      {activeModal === 'allocation' && <Modal title={selectedAllocation && allocationForm.employeeId ? 'Update quantity allocation' : 'Create quantity allocation'} onClose={() => setActiveModal('')}><form onSubmit={saveAllocation} className="ow-form-grid">
        <SelectField label="Employee ID" value={allocationForm.employeeId} onChange={(v) => { const u = users.find((x) => x.employeeId === v); setAllocationForm((p) => ({ ...p, employeeId: v, employee: u?.name || '', designation: u?.designation || '' })); }} options={users.filter((u) => u.site === site && u.status === 'Active' && u.role === 'Assigned Employee').map((u) => ({ value: u.employeeId, label: `${u.employeeId} · ${u.name}` }))}/>
        <SelectField label="Process" value={allocationForm.process} onChange={(v) => setAllocationForm((p) => ({ ...p, process: v }))} options={['Inbound', 'Outbound', 'Processing', 'Exception']}/>
        <div className="ow-form-full ow-employee-preview">{employeeForForm ? <><UserRound size={17}/><span><strong>{employeeForForm.name}</strong><small>{employeeForForm.employeeId} · {employeeForForm.site} · {employeeForForm.role}</small></span><Pill tone="success">Active</Pill></> : <><UserRound size={17}/><span>Select an active assigned employee from this site.</span></>}</div>
        <label className="ow-field"><span>Authorized HHD quantity</span><input type="number" min="1" step="1" value={allocationForm.quantity} onChange={(e) => setAllocationForm((p) => ({ ...p, quantity: e.target.value }))}/></label>
        <label className="ow-field"><span>Reason / operational requirement</span><input value={allocationForm.reason} onChange={(e) => setAllocationForm((p) => ({ ...p, reason: e.target.value }))} placeholder="Required for allocation changes"/></label>
        <div className="ow-form-full ow-note"><AlertTriangle size={16}/> This creates a quantity entitlement only. It does not reserve or assign any IMEI. The employee must scan each physical HHD to establish custody.</div>
        <div className="ow-modal-actions ow-form-full"><button type="button" className="ow-button ow-button-ghost" onClick={() => setActiveModal('')}>Cancel</button><button type="submit" className="ow-button ow-button-primary">Save allocation</button></div>
      </form></Modal>}
      {activeModal === 'user' && <Modal title="Create application user" onClose={() => setActiveModal('')}><form onSubmit={saveUser} className="ow-form-grid">
        <label className="ow-field"><span>HR Employee ID</span><input required value={userForm.employeeId} onChange={(e) => setUserForm((p) => ({ ...p, employeeId: e.target.value.toUpperCase(), username: p.username || e.target.value.toLowerCase() }))} placeholder="e.g. EMP1025"/></label>
        <label className="ow-field"><span>Application Login ID</span><input required value={userForm.username} onChange={(e) => setUserForm((p) => ({ ...p, username: e.target.value.toLowerCase().replace(/\s/g, '') }))} placeholder="e.g. emp1025"/></label>
        <label className="ow-field"><span>Employee name</span><input required value={userForm.name} onChange={(e) => setUserForm((p) => ({ ...p, name: e.target.value }))} placeholder="Full name"/></label>
        <label className="ow-field"><span>Work email</span><input type="email" required value={userForm.email} onChange={(e) => setUserForm((p) => ({ ...p, email: e.target.value }))} placeholder="name@company.com"/></label>
        <SelectField label="Application role" value={userForm.role} onChange={(v) => setUserForm((p) => ({ ...p, role: v, designation: v === 'Assigned Employee' ? 'Lead' : v }))} options={['Admin', 'Site IT', 'Operations SPOC', 'Site Lead', 'Assigned Employee']}/>
        {userForm.role === 'Assigned Employee' && <SelectField label="On-roll designation" value={userForm.designation} onChange={(v) => setUserForm((p) => ({ ...p, designation: v }))} options={['Lead', 'Sr. Lead', 'AM']}/>}
        <SelectField label="Site" value={userForm.site} onChange={(v) => setUserForm((p) => ({ ...p, site: v }))} options={['DEL-01', 'BLR-02']}/>
        <SelectField label="Process" value={userForm.process} onChange={(v) => setUserForm((p) => ({ ...p, process: v }))} options={['Operations', 'Inbound', 'Outbound', 'Processing', 'Exception']}/>
        <div className="ow-form-full ow-note"><LockKeyhole size={16}/> This preview adds a local sample account only. Production must provision the Login ID, invite / temporary access, role assignment and site scope on the server. Never store plaintext passwords.</div>
        <div className="ow-modal-actions ow-form-full"><button type="button" className="ow-button ow-button-ghost" onClick={() => setActiveModal('')}>Cancel</button><button type="submit" className="ow-button ow-button-primary">Create user</button></div>
      </form></Modal>}
      {activeModal === 'role' && <Modal title="Create access role" onClose={() => setActiveModal('')}><form onSubmit={saveRole} className="ow-form-grid">
        <label className="ow-field ow-form-full"><span>Role name</span><input required value={roleForm.name} onChange={(e) => setRoleForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Operations Supervisor"/></label>
        <label className="ow-field ow-form-full"><span>Description</span><input value={roleForm.description} onChange={(e) => setRoleForm((p) => ({ ...p, description: e.target.value }))} placeholder="What this role is responsible for"/></label>
        <SelectField label="Default data scope" value={roleForm.scope} onChange={(v) => setRoleForm((p) => ({ ...p, scope: v }))} options={['Own records', 'Assigned site', 'Assigned site(s)', 'All sites']}/>
        <div className="ow-form-full ow-note"><ShieldCheck size={16}/> New roles start with no permissions. Configure feature-level access before assigning users.</div>
        <div className="ow-modal-actions ow-form-full"><button type="button" className="ow-button ow-button-ghost" onClick={() => setActiveModal('')}>Cancel</button><button type="submit" className="ow-button ow-button-primary">Create role</button></div>
      </form></Modal>}
    </div>
  );
}

function Overview({ role, site, stock, assigned, maintenance, totalAuthorized, totalCollected, completion, allocations, activity, onNavigate }) {
  return <>
    <PageTitle eyebrow={`${site} · OPERATIONS`} title={role === 'Assigned Employee' ? 'Your HHD workspace' : 'Operations overview'} subtitle={role === 'Admin' ? 'Control inventory, allocation, access and device accountability across your sites.' : role === 'Site Lead' ? 'Monitor employee entitlements and actual device collection for your site.' : role === 'Assigned Employee' ? 'View your approved quantity, collect HHDs and track your assigned devices.' : 'Monitor site stock, incoming transfers and shift custody from one workspace.'} actions={<><button className="ow-button ow-button-ghost"><Download size={15}/> Export</button><button className="ow-button ow-button-primary" onClick={() => onNavigate(role === 'Site Lead' ? 'allocations' : role === 'Assigned Employee' ? 'collection' : 'inventory')}><Plus size={15}/> {role === 'Site Lead' ? 'New allocation' : role === 'Assigned Employee' ? 'Collect HHD' : 'Manage stock'}</button></>}/>
    <div className="ow-metric-grid"><Metric label="Available working stock" value={fmt(stock)} change="Ready for allocation" icon={Boxes} tone="blue" foot="Good · Working"/><Metric label="Currently assigned" value={fmt(assigned)} change="Mapped to on-roll employees" icon={Smartphone} tone="violet" foot="IMEI-level custody"/><Metric label="In maintenance" value={fmt(maintenance)} change="Blocked from allocation" icon={Wrench} tone="amber" foot="Quarantined devices"/><Metric label="Collection completion" value={`${completion}%`} change={`${fmt(totalCollected)} of ${fmt(totalAuthorized)} authorized`} icon={Gauge} tone="green" foot="Across active allocations"/></div>
    <div className="ow-content-grid ow-grid-main">
      <Card className="ow-panel"><div className="ow-panel-head"><div><h3>Allocation performance</h3><p>Authorized quantity versus physical IMEI collection</p></div><button className="ow-text-button" onClick={() => onNavigate('allocations')}>View allocations <ChevronRight size={14}/></button></div><div className="ow-progress-summary"><div><strong>{fmt(totalCollected)}</strong><span>Collected</span></div><div><strong>{fmt(totalAuthorized - totalCollected)}</strong><span>Pending collection</span></div><div><strong>{fmt(totalAuthorized)}</strong><span>Authorized</span></div></div><div className="ow-progress-track"><span style={{ width: `${completion}%` }}/></div><div className="ow-chart-legend"><span><i className="legend-blue"/> Collected</span><span><i className="legend-grey"/> Pending</span></div><div className="ow-bar-chart">{[{ name: 'Inbound', v: 72 }, { name: 'Outbound', v: 88 }, { name: 'Processing', v: 64 }, { name: 'Exception', v: 48 }].map((x) => <div className="ow-bar-col" key={x.name}><div className="ow-bar-area"><span style={{ height: `${x.v}%` }}/></div><small>{x.name}</small></div>)}</div></Card>
      <Card className="ow-panel"><div className="ow-panel-head"><div><h3>Stock distribution</h3><p>Device state at {site}</p></div><button className="ow-more"><MoreHorizontal size={18}/></button></div><div className="ow-stock-ring-wrap"><div className="ow-stock-ring"><div><strong>{stock + assigned + maintenance}</strong><small>Total devices</small></div></div><div className="ow-stock-legend"><div><i className="dot-blue"/><span>Available</span><strong>{stock}</strong></div><div><i className="dot-violet"/><span>Assigned</span><strong>{assigned}</strong></div><div><i className="dot-amber"/><span>Maintenance</span><strong>{maintenance}</strong></div></div></div><div className="ow-stock-footer"><span><Activity size={14}/> Live inventory position</span><Pill tone="success">Balanced</Pill></div></Card>
    </div>
    <div className="ow-content-grid ow-grid-bottom">
      <Card className="ow-panel"><div className="ow-panel-head"><div><h3>Recent quantity allocations</h3><p>Most recently updated employee entitlements</p></div><button className="ow-text-button" onClick={() => onNavigate('allocations')}>Open module <ChevronRight size={14}/></button></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Employee</th><th>Process</th><th>Authorized</th><th>Collected</th><th>Status</th></tr></thead><tbody>{allocations.slice(0, 4).map((a) => <tr key={a.id}><td><div className="ow-person-cell"><div className="ow-mini-avatar">{a.employee.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div><div><strong>{a.employee}</strong><small>{a.employeeId} · {a.designation}</small></div></div></td><td>{a.process}</td><td>{a.authorized}</td><td>{a.collected} / {a.authorized}</td><td><Pill tone={a.status === 'Fully collected' ? 'success' : a.status === 'Pending collection' ? 'warning' : 'info'}>{a.status}</Pill></td></tr>)}</tbody></table></div></Card>
      <Card className="ow-panel"><div className="ow-panel-head"><div><h3>Recent activity</h3><p>Latest actions across this workspace</p></div><button className="ow-more"><MoreHorizontal size={18}/></button></div><div className="ow-activity-list">{activity.slice(0, 5).map((a) => <div className="ow-activity-item" key={a.id}><span className={`ow-activity-icon ${a.tone}`}><Activity size={14}/></span><div><p>{a.message}</p><small>{a.time}</small></div></div>)}</div></Card>
    </div>
  </>;
}

function InventoryPage({ site, devices, stock, assigned, maintenance, onSearchClear }) {
  return <><PageTitle eyebrow="DEVICE CONTROL" title="Operations stock" subtitle={`Device availability, assignment and condition at ${site}.`} actions={<><button className="ow-button ow-button-ghost" onClick={onSearchClear}><Filter size={15}/> Clear search</button><button className="ow-button ow-button-primary"><ArrowDownToLine size={15}/> Export inventory</button></>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Available" value={stock} icon={Boxes} tone="blue" foot="Eligible for allocation"/><Metric label="Assigned" value={assigned} icon={Smartphone} tone="violet" foot="Mapped to employees"/><Metric label="Maintenance" value={maintenance} icon={Wrench} tone="amber" foot="Not eligible for allocation"/></div><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Device register</h3><p>Search by asset serial, IMEI, model or custodian.</p></div><Pill tone="neutral">{devices.length} records</Pill></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Asset / IMEI</th><th>Device</th><th>Physical</th><th>Functional</th><th>Current holder</th><th>Location</th></tr></thead><tbody>{devices.map((d) => <tr key={d.serial}><td><strong className="ow-mono">{d.serial}</strong><small className="ow-subline">{d.imei}</small></td><td>{d.model}</td><td><Pill tone={d.physical === 'Good' ? 'success' : 'danger'}>{d.physical}</Pill></td><td><Pill tone={d.functional === 'Working' ? 'success' : 'danger'}>{d.functional}</Pill></td><td>{d.holder}</td><td>{d.location}</td></tr>)}</tbody></table>{devices.length === 0 && <EmptyState title="No matching devices" detail="Try a different serial, IMEI or holder."/>}</div></Card></>;
}

function AllocationsPage({ site, allocations, stock, onCreate, onEdit }) {
  return <><PageTitle eyebrow="DISTRIBUTION CONTROL" title="Quantity allocations" subtitle={`Site Lead authorizations at ${site}. IMEIs are mapped only when employees physically scan devices.`} actions={<button className="ow-button ow-button-primary" onClick={onCreate}><Plus size={16}/> Create allocation</button>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Unallocated working stock" value={stock} icon={Boxes} tone="blue" foot="After confirmed assignment"/><Metric label="Active entitlements" value={allocations.length} icon={ListChecks} tone="violet" foot="Employee-wise allocation records"/><Metric label="Pending collection" value={allocations.reduce((s, a) => s + a.authorized - a.collected, 0)} icon={Clock3} tone="amber" foot="Quantity not yet physically collected"/></div><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Employee allocation register</h3><p>One entitlement per employee, process and site. No IMEI selection at this stage.</p></div><button className="ow-button ow-button-ghost"><Download size={15}/> Export</button></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Allocation ID</th><th>Employee</th><th>Process</th><th>Designation</th><th>Authorized</th><th>Collected</th><th>Pending</th><th>Status</th><th/></tr></thead><tbody>{allocations.map((a) => <tr key={a.id}><td className="ow-mono">{a.id}</td><td><div className="ow-person-cell"><div className="ow-mini-avatar">{a.employee.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div><div><strong>{a.employee}</strong><small>{a.employeeId}</small></div></div></td><td>{a.process}</td><td>{a.designation}</td><td><strong>{a.authorized}</strong></td><td>{a.collected}</td><td>{a.authorized - a.collected}</td><td><Pill tone={a.status === 'Fully collected' ? 'success' : a.status === 'Pending collection' ? 'warning' : 'info'}>{a.status}</Pill></td><td><button className="ow-row-action" onClick={() => onEdit(a)}><MoreHorizontal size={17}/></button></td></tr>)}</tbody></table></div></Card><div className="ow-inline-rule"><ShieldCheck size={17}/><div><strong>Control rule</strong><span>Quantity entitlement does not create an IMEI assignment. Each physical device is assigned only after employee validation and an eligible stock scan.</span></div></div></>;
}

function CollectionPage({ role, site, allocations, devices, imeiInput, setImeiInput, employeeAlloc, scanMessage, onScan }) {
  const myDevices = employeeAlloc ? devices.filter((d) => d.holder === employeeAlloc.employee) : [];
  return <><PageTitle eyebrow="PHYSICAL DEVICE ISSUE" title="Employee IMEI collection" subtitle="Authenticate the on-roll employee, then scan each physical HHD. A successful scan maps the IMEI to that employee." actions={<Pill tone="info">{site} · On-roll only</Pill>}/><div className="ow-collection-layout">{role === 'Assigned Employee' ? <Card className="ow-panel ow-scan-panel"><div className="ow-panel-head"><div><h3>Collection station</h3><p>Use a handheld scanner or type an IMEI / asset serial.</p></div><span className="ow-scan-live"><i/> Scanner ready</span></div><div className="ow-field"><span>1. Authenticated application identity</span><div className="ow-employee-auth-card">{employeeAlloc ? <><div className="ow-avatar ow-avatar-blue">{employeeAlloc.employee.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div><div className="ow-employee-auth-copy"><strong>{employeeAlloc.employee}</strong><small>{employeeAlloc.employeeId} · {employeeAlloc.designation} · {employeeAlloc.process}</small></div><Pill tone="success">Signed in</Pill></> : <><div className="ow-avatar ow-avatar-muted"><UserRound size={18}/></div><div className="ow-employee-auth-copy"><strong>Employee allocation unavailable</strong><small>The signed-in account has no active allocation for {site}.</small></div><Pill tone="danger">Not eligible</Pill></>}</div></div><div className="ow-scan-divider"><span>2. Scan HHD device</span></div><label className="ow-field"><span>IMEI / Asset Serial</span><div className="ow-scan-control"><ScanLine size={19}/><input autoFocus value={imeiInput} onChange={(e) => setImeiInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onScan(); }} placeholder="Scan IMEI or HHD serial…"/><button onClick={onScan} disabled={!imeiInput.trim() || !employeeAlloc}><Check size={17}/> Assign</button></div></label><p className="ow-helper">Scanners that emulate keyboard input can send Enter after each scan for rapid collection.</p>{scanMessage && <div className={cx('ow-scan-feedback', scanMessage.includes('mapped') ? 'success' : 'warning')}><AlertTriangle size={16}/>{scanMessage}</div>}</Card> : <Card className="ow-panel ow-scan-panel"><div className="ow-panel-head"><div><h3>Employee collection monitoring</h3><p>Site Lead can monitor progress but cannot scan or map IMEIs on behalf of an employee.</p></div><Pill tone="info">View only</Pill></div><EmptyState title="Employee self-collection" detail="Each assigned employee signs in with their own account to scan and collect devices."/></Card>}<Card className="ow-panel ow-entitlement-panel"><div className="ow-panel-head"><div><h3>{role === 'Site Lead' ? 'Site collection summary' : 'My collection entitlement'}</h3><p>{role === 'Site Lead' ? 'Authorized versus physically collected at this site' : 'Your approved quantity and mapped devices'}</p></div><BadgeCheck size={20} className="ow-success-icon"/></div>{role === 'Site Lead' ? <><div className="ow-entitlement-numbers"><div><strong>{allocations.reduce((s, a) => s + a.authorized, 0)}</strong><small>Authorized</small></div><div><strong>{allocations.reduce((s, a) => s + a.collected, 0)}</strong><small>Collected</small></div><div><strong>{allocations.reduce((s, a) => s + a.authorized - a.collected, 0)}</strong><small>Pending</small></div></div><div className="ow-progress-track"><span style={{ width: `${allocations.reduce((s, a) => s + a.authorized, 0) ? allocations.reduce((s, a) => s + a.collected, 0) / allocations.reduce((s, a) => s + a.authorized, 0) * 100 : 0}%` }}/></div><div className="ow-panel-subhead">Control note</div><div className="ow-inline-rule"><ShieldCheck size={15}/><div><strong>Quantity authority only</strong><span>Site Lead can monitor and adjust entitlements; IMEI mapping is performed by the signed-in employee.</span></div></div></> : employeeAlloc ? <><div className="ow-entitlement-numbers"><div><strong>{employeeAlloc.authorized}</strong><small>Authorized</small></div><div><strong>{employeeAlloc.collected}</strong><small>Collected</small></div><div><strong>{employeeAlloc.authorized - employeeAlloc.collected}</strong><small>Pending</small></div></div><div className="ow-progress-track"><span style={{ width: `${employeeAlloc.authorized ? employeeAlloc.collected / employeeAlloc.authorized * 100 : 0}%` }}/></div><div className="ow-panel-subhead">Mapped device IMEIs</div>{myDevices.length ? myDevices.map((d) => <div className="ow-mapped-row" key={d.serial}><span><Smartphone size={15}/><strong>{d.serial}</strong><small>{d.imei}</small></span><Pill tone="success">Assigned</Pill></div>) : <EmptyState title="No devices collected yet" detail="The first validated scan will appear here."/>}</> : <EmptyState title="Awaiting employee allocation" detail="An active quantity allocation is required before scanning can begin."/>}</Card></div><Card className="ow-panel ow-table-panel"><div className="ow-panel-head"><div><h3>{role === 'Site Lead' ? `Employee collection status · ${site}` : 'My collection history'}</h3><p>{role === 'Site Lead' ? 'Monitor employee-wise authorized and collected quantities.' : 'Only your own allocation and device mappings are displayed.'}</p></div></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Employee</th><th>Process</th><th>Authorized</th><th>Collected</th><th>Pending</th><th>Status</th><th/></tr></thead><tbody>{allocations.map((a) => <tr key={a.id}><td><strong>{a.employee}</strong><small className="ow-subline">{a.employeeId}</small></td><td>{a.process}</td><td>{a.authorized}</td><td>{a.collected}</td><td>{a.authorized - a.collected}</td><td><Pill tone={a.status === 'Fully collected' ? 'success' : 'warning'}>{a.status}</Pill></td><td><span className="ow-muted-small">{role === 'Site Lead' ? 'Monitor' : 'Your allocation'}</span></td></tr>)}</tbody></table></div></Card></>;
}

function HotoPage({ site, workers, devices, hotoForm, setHotoForm, hotoRows, onSubmit }) {
  return <><PageTitle eyebrow="SHIFT CUSTODY" title="Shift handover & takeover" subtitle="Validate off-roll TL/GC identities against the HR-synchronized master. No TL/GC application login is created." actions={<Pill tone="info">HR master validation</Pill>}/><div className="ow-content-grid ow-grid-main"><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Record shift HOTO</h3><p>Scan the HHD and enter the HR worker ID.</p></div><ArrowLeftRight size={20}/></div><form className="ow-form-grid" onSubmit={onSubmit}><SelectField label="HOTO action" value={hotoForm.action} onChange={(v) => setHotoForm((p) => ({ ...p, action: v }))} options={['Handover', 'Takeover']}/><SelectField label="Shift" value={hotoForm.shift} onChange={(v) => setHotoForm((p) => ({ ...p, shift: v }))} options={['Shift A', 'Shift B', 'Shift C']}/><label className="ow-field ow-form-full"><span>TL / GC Employee ID</span><input required value={hotoForm.workerId} onChange={(e) => setHotoForm((p) => ({ ...p, workerId: e.target.value.toUpperCase() }))} placeholder="Scan HR worker ID"/></label><label className="ow-field ow-form-full"><span>Device IMEI / Serial</span><input required value={hotoForm.imei} onChange={(e) => setHotoForm((p) => ({ ...p, imei: e.target.value }))} placeholder="Scan IMEI or asset serial"/></label><div className="ow-form-full ow-hr-validation"><Users size={17}/><div><strong>HR master validation is required</strong><small>Only active TL/GC records mapped to {site} can be selected.</small></div></div><button className="ow-button ow-button-primary ow-form-full" type="submit"><Check size={16}/> Validate & record HOTO</button></form></Card><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Eligible HR workers</h3><p>Read-only snapshot of the synchronized master</p></div><Pill tone="success">{workers.filter((w) => w.status === 'Active').length} active</Pill></div><div className="ow-worker-list">{workers.map((w) => <div className="ow-worker-row" key={w.id}><div className="ow-mini-avatar">{w.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div><div><strong>{w.name}</strong><small>{w.id} · {w.process}</small></div><Pill tone={w.status === 'Active' ? 'success' : 'danger'}>{w.type} · {w.status}</Pill></div>)}</div></Card></div><Card className="ow-panel ow-table-panel"><div className="ow-panel-head"><div><h3>Recent HOTO transactions</h3><p>Shift-level custody history</p></div><button className="ow-button ow-button-ghost"><Download size={15}/> Export</button></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Transaction</th><th>Device</th><th>TL / GC</th><th>Shift</th><th>Action</th><th>Time</th><th>Status</th></tr></thead><tbody>{hotoRows.map((r) => <tr key={r.id}><td className="ow-mono">{r.id}</td><td>{r.serial}<small className="ow-subline">{r.imei}</small></td><td><strong>{r.worker}</strong><small className="ow-subline">{r.workerId}</small></td><td>{r.shift}</td><td>{r.action}</td><td>{r.time}</td><td><Pill tone="success">{r.status}</Pill></td></tr>)}</tbody></table></div></Card></>;
}

function UsersPage({ users, onCreate, onDeactivate }) {
  return <><PageTitle eyebrow="ACCESS ADMINISTRATION" title="Users & ID management" subtitle="Provision named application accounts, assign role and site scope, and control account lifecycle." actions={<button className="ow-button ow-button-primary" onClick={onCreate}><UserRoundPlus size={16}/> Create user</button>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Application users" value={users.length} icon={Users} tone="blue" foot="At selected site"/><Metric label="Active accounts" value={users.filter((u) => u.status === 'Active').length} icon={BadgeCheck} tone="green" foot="Enabled for sign-in"/><Metric label="Inactive accounts" value={users.filter((u) => u.status !== 'Active').length} icon={LockKeyhole} tone="amber" foot="Access disabled"/></div><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Application account register</h3><p>On-roll employees only. TL/GC worker identities are maintained separately from login accounts.</p></div><button className="ow-button ow-button-ghost"><Download size={15}/> Export users</button></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Employee</th><th>Employee ID</th><th>Login ID</th><th>Role</th><th>Process</th><th>Site scope</th><th>Last login</th><th>Status</th><th/></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td><div className="ow-person-cell"><div className="ow-mini-avatar">{u.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}</div><div><strong>{u.name}</strong><small>{u.email}</small></div></div></td><td className="ow-mono">{u.employeeId}</td><td className="ow-mono">{u.username}</td><td>{u.role}</td><td>{u.process}</td><td>{u.site}</td><td>{u.lastLogin}</td><td><Pill tone={u.status === 'Active' ? 'success' : 'danger'}>{u.status}</Pill></td><td><button className="ow-row-action" title="Activate / deactivate" onClick={() => onDeactivate(u.id)}><MoreHorizontal size={17}/></button></td></tr>)}</tbody></table></div></Card><div className="ow-inline-rule"><LockKeyhole size={17}/><div><strong>Identity lifecycle control</strong><span>Application account ID, HR Employee ID and off-roll TL/GC worker ID remain separate identifiers. Account provisioning and password recovery must be handled server-side.</span></div></div></>;
}

function PermissionsPage({ roles, modules, permissions, selectedRole, setSelectedRole, onToggle, onCreate }) {
  const role = roles.find((r) => r.id === selectedRole) || roles[0];
  return <><PageTitle eyebrow="ACCESS GOVERNANCE" title="Roles & permissions" subtitle="Configure access at module, feature and action level, with site and record scope." actions={<button className="ow-button ow-button-primary" onClick={onCreate}><Plus size={16}/> Create role</button>}/><div className="ow-permission-layout"><Card className="ow-panel ow-role-list-panel"><div className="ow-panel-head"><div><h3>System roles</h3><p>{roles.length} roles defined</p></div><ShieldCheck size={19}/></div>{roles.map((r) => <button className={cx('ow-role-option', selectedRole === r.id && 'active')} onClick={() => setSelectedRole(r.id)} key={r.id}><div className="ow-role-option-icon"><ShieldCheck size={17}/></div><div><strong>{r.name}</strong><small>{r.users} users · {r.scope}</small></div><ChevronRight size={16}/></button>)}</Card><Card className="ow-panel ow-permission-panel"><div className="ow-panel-head"><div><h3>{role?.name} permissions</h3><p>{role?.description} · Scope: {role?.scope}</p></div><Pill tone="info">Granular access</Pill></div><div className="ow-permission-warning"><AlertTriangle size={16}/><span>Changes shown here are local preview settings. Production permissions must be enforced by the API and database policies, not only by the UI.</span></div><div className="ow-module-permission-list">{modules.map((m) => <section className="ow-module-permission" key={m.id}><div className="ow-module-permission-head"><div><strong>{m.name}</strong><small>{m.actions.length} actions · module access</small></div><Pill tone={m.actions.some((a) => permissions[selectedRole]?.[m.id]?.[a]) ? 'success' : 'neutral'}>{m.actions.some((a) => permissions[selectedRole]?.[m.id]?.[a]) ? 'Access granted' : 'No access'}</Pill></div><div className="ow-action-permissions">{m.actions.map((action) => <label className="ow-action-permission" key={action}><input type="checkbox" checked={!!permissions[selectedRole]?.[m.id]?.[action]} onChange={() => onToggle(selectedRole, m.id, action)}/><span>{action}</span></label>)}</div></section>)}</div><div className="ow-permission-foot"><span><i className="legend-blue"/> Enabled</span><span><i className="legend-grey"/> Not granted</span><button className="ow-button ow-button-primary" onClick={() => window.alert('Preview only: connect permission save API before production use.')}>Save permission set</button></div></Card></div></>;
}

function HrPage({ workers, lastSync, onSync }) {
  return <><PageTitle eyebrow="PEOPLE DATA INTEGRATION" title="HR worker master" subtitle="TL / GC identities are synchronized from the HR-owned Google Sheet. This master is read-only in the HHD application." actions={<button className="ow-button ow-button-primary" onClick={onSync}><RefreshCw size={15}/> Sync now</button>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Synchronized workers" value={workers.length} icon={Users} tone="blue" foot="Sample HR snapshot"/><Metric label="Active workers" value={workers.filter((w) => w.status === 'Active').length} icon={BadgeCheck} tone="green" foot="Eligible for HOTO validation"/><Metric label="Inactive workers" value={workers.filter((w) => w.status !== 'Active').length} icon={AlertTriangle} tone="amber" foot="Blocked from new HOTO"/></div><Card className="ow-panel ow-hr-source"><div className="ow-hr-source-icon"><FileClock size={21}/></div><div className="ow-hr-source-copy"><strong>HR Google Sheet · Source of truth</strong><span>Last successful sync: {lastSync}</span><small>Worker records are imported to the application for indexed, low-latency validation. No TL/GC login accounts are created.</small></div><Pill tone="warning">Preview connection</Pill></Card><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Off-roll worker register</h3><p>Only active, site-matched TL/GC records can be used for new handover transactions.</p></div><button className="ow-button ow-button-ghost"><Download size={15}/> Export snapshot</button></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Employee ID</th><th>Name</th><th>Worker category</th><th>Site</th><th>Process</th><th>HR status</th><th>Last sync</th></tr></thead><tbody>{workers.map((w) => <tr key={w.id}><td className="ow-mono">{w.id}</td><td><strong>{w.name}</strong></td><td><Pill tone={w.type === 'TL' ? 'violet' : 'info'}>{w.type}</Pill></td><td>{w.site}</td><td>{w.process}</td><td><Pill tone={w.status === 'Active' ? 'success' : 'danger'}>{w.status}</Pill></td><td>{w.synced}</td></tr>)}</tbody></table></div></Card><div className="ow-inline-rule"><ShieldCheck size={17}/><div><strong>HR is the single source of truth</strong><span>Manual creation or editing of TL/GC identities is disabled. Only the synchronization service can update the off-roll worker master.</span></div></div></>;
}

function StoPage({ site, onCreate }) {
  return <><PageTitle eyebrow="INBOUND STOCK CONTROL" title="Incoming stock transfer orders" subtitle={`Track IT-to-Operations transfers and acknowledge physically received devices at ${site}.`} actions={<button className="ow-button ow-button-primary" onClick={onCreate}><Plus size={16}/> Create return STO</button>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Awaiting receipt" value="03" icon={Clock3} tone="amber" foot="Pending physical acknowledgement"/><Metric label="Partially received" value="01" icon={Package} tone="blue" foot="Device-line reconciliation open"/><Metric label="Received today" value="24" icon={CheckCircle2} tone="green" foot="Confirmed IMEIs"/></div><Card className="ow-panel"><div className="ow-panel-head"><div><h3>STO receiving queue</h3><p>Receive each IMEI line individually. Damaged devices count as received but enter quarantine.</p></div><Pill tone="warning">Demo queue</Pill></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>STO number</th><th>Source</th><th>Expected</th><th>Received</th><th>Pending</th><th>Dispatched</th><th>Status</th><th/></tr></thead><tbody>{[['STO-2026-00125','Site IT',20,18,2,'Today, 08:45','Partially received'],['STO-2026-00122','Site IT',12,0,12,'Today, 10:10','Pending receipt'],['STO-2026-00119','Site IT',8,0,8,'Yesterday, 18:15','Pending receipt']].map((r) => <tr key={r[0]}><td className="ow-mono">{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td>{r[4]}</td><td>{r[5]}</td><td><Pill tone={r[6] === 'Partially received' ? 'warning' : 'info'}>{r[6]}</Pill></td><td><button className="ow-button ow-button-small ow-button-ghost">Open STO</button></td></tr>)}</tbody></table></div></Card><div className="ow-inline-rule"><AlertTriangle size={17}/><div><strong>Receipt control</strong><span>Physical receipt acknowledgement is the event that moves custody to Operations. Dispatch alone does not make a device available in Operations stock.</span></div></div></>;
}

function AuditPage({ activity, hotoRows, allocations }) {
  return <><PageTitle eyebrow="GOVERNANCE & TRACEABILITY" title="Audit & activity" subtitle="Track quantity approvals, physical scans, custody changes and HR synchronization events." actions={<button className="ow-button ow-button-ghost"><Download size={15}/> Export log</button>}/><div className="ow-metric-grid ow-metric-grid-3"><Metric label="Allocation events" value={allocations.length} icon={ListChecks} tone="blue" foot="Sample records"/><Metric label="HOTO transactions" value={hotoRows.length} icon={ArrowLeftRight} tone="violet" foot="Shift-level custody"/><Metric label="Recent activity" value={activity.length} icon={Activity} tone="green" foot="Latest workspace events"/></div><Card className="ow-panel"><div className="ow-panel-head"><div><h3>Activity timeline</h3><p>Every write action should capture the actor, site, timestamp, record and reason.</p></div></div><div className="ow-activity-list ow-activity-large">{activity.map((a) => <div className="ow-activity-item" key={a.id}><span className={`ow-activity-icon ${a.tone}`}><Activity size={14}/></span><div><p>{a.message}</p><small>{a.time} · Preview environment</small></div><Pill tone={a.tone === 'warning' ? 'warning' : 'success'}>{a.tone}</Pill></div>)}</div></Card></>;
}

function MyDevicesPage({ allocation, devices }) {
  const mine = allocation ? devices.filter((d) => d.holder === allocation.employee) : [];
  return <><PageTitle eyebrow="MY INVENTORY" title="My assigned HHDs" subtitle="Your physical device assignments, collected against the Site Lead-approved quantity."/><Card className="ow-panel"><div className="ow-entitlement-numbers"><div><strong>{allocation?.authorized ?? 0}</strong><small>Authorized</small></div><div><strong>{allocation?.collected ?? 0}</strong><small>Collected</small></div><div><strong>{(allocation?.authorized ?? 0) - (allocation?.collected ?? 0)}</strong><small>Pending</small></div></div><div className="ow-table-wrap"><table className="ow-table"><thead><tr><th>Asset</th><th>IMEI</th><th>Model</th><th>Physical</th><th>Functional</th><th>Status</th></tr></thead><tbody>{mine.map((d) => <tr key={d.serial}><td className="ow-mono">{d.serial}</td><td className="ow-mono">{d.imei}</td><td>{d.model}</td><td>{d.physical}</td><td>{d.functional}</td><td><Pill tone="success">Assigned</Pill></td></tr>)}</tbody></table></div></Card></>;
}

function Modal({ title, onClose, children }) { return <div className="ow-modal-backdrop" onMouseDown={onClose}><div className="ow-modal" onMouseDown={(e) => e.stopPropagation()}><div className="ow-modal-head"><div><div className="ow-eyebrow">HHD CONTROL</div><h2>{title}</h2></div><button className="ow-icon-button" onClick={onClose}><X size={18}/></button></div><div className="ow-modal-body">{children}</div></div></div>; }
