import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeftRight, BadgeCheck, Boxes, Building2, CheckCircle2,
  ChevronRight, Clock3, Download, FileClock, LayoutDashboard, ListChecks, LockKeyhole,
  LogOut, Menu, Package, RefreshCw, ScanLine, Search, ShieldCheck, Smartphone,
  Users, UserRoundPlus, Wrench, X,
} from 'lucide-react';
import {
  changeAccountPassword, consumeInviteLink, getStoredSession, operationsApi, requestPasswordReset,
  setAccountPassword, signInWithEmail, signOut,
} from './operationsApi.js';
import './operations-live.css';

const fmt = (v) => v == null ? '—' : new Intl.NumberFormat('en-IN').format(Number(v) || 0);
const when = (v) => v ? new Date(v).toLocaleString('en-IN') : '—';
const human = (v) => String(v || '').replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const code = (v) => String(v || '').toUpperCase();

function Button({ children, onClick, disabled, tone = 'primary', type = 'button' }) {
  return <button type={type} className={`ol-button ol-button-${tone}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Field({ label, children, hint }) {
  return <label className="ol-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Panel({ title, subtitle, action, children, className = '' }) {
  return <section className={`ol-panel ${className}`}><header className="ol-panel-head"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</section>;
}

const ROLE_LABELS = {
  site_lead: 'Allocator',
  assigned_employee: 'Custodian',
  operations_spoc: 'Asset Manager',
};
const roleName = (value) => ROLE_LABELS[value] || human(value);

function ScanInput({ value, onChange, placeholder = 'Scan barcode or type value', required = false, listId, listOptions = [] }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let active = true;
    let stream = null;
    let frame = null;

    const close = () => {
      if (frame) cancelAnimationFrame(frame);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const start = async () => {
      try {
        if (!('BarcodeDetector' in window)) throw new Error('Camera scanning is not supported in this browser. Use a USB/Bluetooth barcode scanner or type the value.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires a secure HTTPS connection.');
        const detector = new window.BarcodeDetector({
          formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e', 'itf'],
        });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        if (!active) { stream.getTracks().forEach((track) => track.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const scan = async () => {
          if (!active || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found?.length && found[0]?.rawValue) {
              onChangeRef.current(found[0].rawValue);
              setCameraOpen(false);
              return;
            }
          } catch (scanError) {
            setCameraError(scanError.message || 'Unable to read this barcode.');
          }
          if (active) frame = requestAnimationFrame(scan);
        };
        scan();
      } catch (scanError) {
        setCameraError(scanError.message || 'Camera could not be started.');
        setCameraOpen(false);
      }
    };

    start();
    return () => { active = false; close(); };
  }, [cameraOpen]);

  return (
    <div className="ol-scan-control">
      <div className="ol-scan-input-wrap">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          autoComplete="off" required={required} list={listId}/>
        <button type="button" className="ol-scan-camera-btn" onClick={() => { setCameraError(''); setCameraOpen((v) => !v); }}
          title={cameraOpen ? 'Close camera scanner' : 'Open camera scanner'}><ScanLine size={17}/></button>
      </div>
      {listId && <datalist id={listId}>{listOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>}
      {cameraOpen && <div className="ol-camera-panel"><video ref={videoRef} muted playsInline/><small>Align the barcode inside the camera frame</small><button type="button" onClick={() => setCameraOpen(false)}>Close scanner</button></div>}
      {cameraError && <small className="ol-scan-error">{cameraError}</small>}
    </div>
  );
}

function Pill({ children, tone = 'neutral' }) { return <span className={`ol-pill ol-pill-${tone}`}>{children}</span>; }
function Metric({ title, value, note, icon: Icon, tone = 'blue' }) {
  return <div className="ol-metric"><div className={`ol-metric-icon ol-metric-${tone}`}><Icon size={18}/></div><span>{title}</span><strong>{value}</strong><small>{note}</small></div>;
}
function Empty({ title, detail }) { return <div className="ol-empty"><Package size={25}/><strong>{title}</strong><span>{detail}</span></div>; }

export default function OperationsLiveWorkspace() {
  const [session, setSession] = useState(() => getStoredSession());
  const [context, setContext] = useState(null);
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState('');
  const [page, setPage] = useState('overview');
  const [workspace, setWorkspace] = useState(null);
  const [allocations, setAllocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [offrollWorkers, setOffrollWorkers] = useState([]);
  const [myDevices, setMyDevices] = useState([]);
  const [hotoRows, setHotoRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [roleData, setRoleData] = useState({ roles: [], permissions: [], role_permissions: [] });
  const [hrRuns, setHrRuns] = useState([]);
  const [auditRows, setAuditRows] = useState([]);
  const [movementRows, setMovementRows] = useState([]);
  const [stoRows, setStoRows] = useState([]);
  const [stoScans, setStoScans] = useState([]);
  const [stoForm, setStoForm] = useState({ to_site_code: '', scan_value: '', notes: '' });
  const [stoReceiveForm, setStoReceiveForm] = useState({ sto_id: '', scan_value: '', department: 'operations', notes: '' });
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState({ user_id: '', full_name: '', email: '', login_id: '', employee_id: '', designation: '', process: '', password: '' });
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' });
  const [forgotPasswordSent, setForgotPasswordSent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [creatingUserPassword, setCreatingUserPassword] = useState('');
  const [creatingUserPasswordConfirm, setCreatingUserPasswordConfirm] = useState('');
  const [inviteMode, setInviteMode] = useState(false);
  const [invitePassword, setInvitePassword] = useState('');
  const [invitePasswordConfirm, setInvitePasswordConfirm] = useState('');
  const [search, setSearch] = useState('');
  const [allocationForm, setAllocationForm] = useState({ employee_id: '', process: '', quantity: 1, reason: '' });
  const [scanForm, setScanForm] = useState({ allocation_id: '', scan_value: '' });
  const [hotoForm, setHotoForm] = useState({ serial: '', worker_id: '', shift: 'A', date: new Date().toISOString().slice(0, 10), type: 'handover', physical: 'good', functional: 'working', notes: '' });
  const [hotoReturnForm, setHotoReturnForm] = useState({ serial: '', physical: 'good', functional: 'working', shift: 'A', date: new Date().toISOString().slice(0, 10), notes: '' });
  const [userForm, setUserForm] = useState({ email: '', login_id: '', employee_id: '', full_name: '', role_code: 'assigned_employee', site_code: '', site_codes: [], designation: 'Lead', process: '', password: '' });
  const [roleForm, setRoleForm] = useState({ role_name: '', role_code: '', description: '', scope_type: 'assigned_sites' });
  const [selectedRole, setSelectedRole] = useState('site_lead');
  const [roleAssignmentForm, setRoleAssignmentForm] = useState({ user_id: '', role_code: 'assigned_employee', site_code: '', site_codes: [] });
  const [employeeForm, setEmployeeForm] = useState({ employee_id: '', employee_name: '', site_code: '', designation: 'Lead', process: '', email: '', employment_status: 'active' });
  const [reconcileForm, setReconcileForm] = useState({ device_serial: '', site_code: '', owner_department: 'operations', stock_state: 'available', physical_condition: 'good', functional_condition: 'working', reason: '' });

  const profile = context?.user || null;
  const roleAssignments = context?.role_assignments || [];
  const permissionRows = context?.permissions || [];
  const currentRoles = roleAssignments.filter((r) => r.site_code === '*' || r.site_code === site);
  const primaryRole = currentRoles[0]?.role_code || '';
  const can = useCallback((moduleCode, actionCode) => permissionRows.some((p) => p.module_code === moduleCode && p.action_code === actionCode && (p.site_code === '*' || p.site_code === site)), [permissionRows, site]);
  const isAdmin = currentRoles.some((r) => r.role_code === 'admin');
  const siteOptions = sites.map((s) => s.site_code);
  const selectedEmployee = employees.find((e) => e.employee_id === allocationForm.employee_id);
  const allocatableEmployees = employees.filter((e) => ['lead','srlead','seniorlead','am'].includes(String(e.designation || '').toLowerCase().replace(/[^a-z]/g, '')));
  const activeAllocation = allocations.find((a) => a.id === scanForm.allocation_id) || allocations.find((a) => a.status === 'active');
  const selectedRoleGrants = useMemo(() => Object.fromEntries(roleData.role_permissions.filter((g) => g.role_code === selectedRole).map((g) => [g.permission_code, g])), [roleData, selectedRole]);

  const flash = (message, kind = 'success') => {
    if (kind === 'error') setError(message); else { setError(''); setNotice(message); }
  };

  const loadContext = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [me, siteList] = await Promise.all([operationsApi.getMyContext(), operationsApi.listSites()]);
      setContext(me);
      setSites(Array.isArray(siteList) ? siteList : []);
      const preferred = me.role_assignments?.find((r) => r.site_code !== '*')?.site_code || siteList?.[0]?.site_code || '';
      setSite((current) => current || preferred);
      setInviteMode(false);
    } catch (e) {
      setError(e.message || 'Unable to load application profile.');
      setContext(null);
    } finally {
      setBusy(false);
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const invite = await consumeInviteLink();
        if (!alive) return;
        if (invite) {
          setSession(invite.session);
          setInviteMode(true);
        } else if (getStoredSession()) {
          setSession(getStoredSession());
        }
      } catch (e) {
        if (alive) setError(e.message || 'Password link verification failed.');
      } finally {
        if (alive) setInitializing(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (session && !inviteMode && !context) loadContext();
  }, [session, inviteMode, context, loadContext]);

  const loadSiteData = useCallback(async (siteCode) => {
    if (!context || !siteCode) return;
    setBusy(true);
    setError('');
    const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };
    try {
      const ws = await safe(() => operationsApi.getSiteWorkspace(siteCode), null);
      setWorkspace(ws);
      const alloc = await safe(() => operationsApi.listAllocations(siteCode), []);
      setAllocations(Array.isArray(alloc) ? alloc : []);
      if (can('admin_employees', 'view')) {
        const emp = await safe(() => operationsApi.listEmployees(siteCode), []);
        setEmployees(Array.isArray(emp) ? emp : []);
      } else if (can('distribution', 'view')) {
        const emp = await safe(() => operationsApi.listAllocatableEmployees(siteCode), []);
        setEmployees(Array.isArray(emp) ? emp : []);
      } else setEmployees([]);
      if (can('hoto', 'view') || can('hoto', 'create')) {
        const [workers, hoto] = await Promise.all([
          safe(() => operationsApi.listOffrollWorkers(siteCode), []),
          safe(() => operationsApi.listHotoTransactions(siteCode, 150), []),
        ]);
        setOffrollWorkers(Array.isArray(workers) ? workers : []);
        setHotoRows(Array.isArray(hoto) ? hoto : []);
      } else { setOffrollWorkers([]); setHotoRows([]); }
      if (can('employee_collection', 'view')) {
        const my = await safe(() => operationsApi.listMyDevices(), []);
        setMyDevices(Array.isArray(my) ? my : []);
      } else setMyDevices([]);
      if (isAdmin || can('admin_users', 'view')) {
        const u = await safe(() => operationsApi.listUsers(isAdmin ? '*' : siteCode), []);
        setUsers(Array.isArray(u) ? u : []);
      } else setUsers([]);
      if (isAdmin || can('admin_roles', 'view')) {
        const r = await safe(() => operationsApi.listRolesAndPermissions(), { roles: [], permissions: [], role_permissions: [] });
        setRoleData(r || { roles: [], permissions: [], role_permissions: [] });
      }
      if (isAdmin || can('offroll_workers', 'sync')) {
        const runs = await safe(() => operationsApi.getHrSyncRuns(20), []);
        setHrRuns(Array.isArray(runs) ? runs : []);
      }
      if (isAdmin || can('admin_audit', 'view')) {
        const audit = await safe(() => operationsApi.listAuditEvents(isAdmin ? '*' : siteCode, 150), []);
        setAuditRows(Array.isArray(audit) ? audit : []);
      } else setAuditRows([]);
      if (can('inventory', 'view') || can('admin_audit', 'view')) {
        const movements = await safe(() => operationsApi.listDeviceMovements(siteCode, '', 200), []);
        setMovementRows(Array.isArray(movements) ? movements : []);
      } else setMovementRows([]);
      if (can('sto', 'view') || can('sto', 'receive') || can('sto', 'dispatch') || can('sto', 'create')) {
        const sto = await safe(() => operationsApi.listSto(siteCode, 100), []);
        setStoRows(Array.isArray(sto) ? sto : []);
      } else setStoRows([]);
    } catch (e) {
      setError(e.message || 'Unable to load site workspace.');
    } finally {
      setBusy(false);
    }
  }, [context, can, isAdmin]);

  useEffect(() => { if (context && site) loadSiteData(site); }, [context, site, loadSiteData]);

  const login = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const s = await signInWithEmail(loginForm.email, loginForm.password);
      setSession(s);
      setNotice('Signed in. Loading role and site permissions…');
    } catch (e2) { setError(e2.message || 'Sign in failed.'); }
    finally { setBusy(false); }
  };

  const completeInvite = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (invitePassword.length < 6) throw new Error('Use a password with at least 6 characters.');
      if (invitePassword !== invitePasswordConfirm) throw new Error('Passwords do not match.');
      await setAccountPassword(invitePassword);
      setInviteMode(false);
      setInvitePassword(''); setInvitePasswordConfirm('');
      await loadContext();
      setNotice('Password set successfully. You can now sign in.');
    } catch (e2) { setError(e2.message || 'Unable to set password.'); }
    finally { setBusy(false); }
  };

  const forgotPassword = async () => {
    if (!loginForm.email.trim()) return flash('Enter your work email first.', 'error');
    try {
      setBusy(true);
      await requestPasswordReset(loginForm.email);
      setForgotPasswordSent(true);
      flash('If the account exists, a password reset link has been sent to its registered email address.');
    } catch (e) { flash(e.message || 'Password recovery could not be requested.', 'error'); }
    finally { setBusy(false); }
  };

  const savePasswordChange = async (e) => {
    e.preventDefault();
    if (passwordForm.next.length < 6 || passwordForm.next.length > 72) return flash('New password must contain 6 to 72 characters.', 'error');
    if (passwordForm.next !== passwordForm.confirm) return flash('New passwords do not match.', 'error');
    try {
      setBusy(true);
      await changeAccountPassword(passwordForm.current, passwordForm.next);
      setPasswordForm({ current: '', next: '', confirm: '' });
      flash('Password changed successfully.');
    } catch (e2) { flash(e2.message || 'Password change failed.', 'error'); }
    finally { setBusy(false); }
  };

  const startEditUser = (user) => {
    setEditingUser(user.user_id);
    setEditUserForm({
      user_id: user.user_id, full_name: user.full_name || '', email: user.email || '',
      login_id: user.login_id || '', employee_id: user.employee_id || '',
      designation: user.designation || '', process: user.process || '',
      password: '', password_confirm: '',
    });
  };

  const saveUserChanges = async (e) => {
    e.preventDefault();
    if (editUserForm.password && editUserForm.password.length < 6) return flash('Password must contain at least 6 characters.', 'error');
    if (editUserForm.password !== editUserForm.password_confirm) return flash('Password fields do not match.', 'error');
    try {
      setBusy(true);
      await operationsApi.updateUser(editUserForm);
      setEditingUser(null);
      flash(`Account updated for ${editUserForm.full_name}. ${editUserForm.password ? 'Password reset too.' : ''}`);
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Account update failed.', 'error'); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    await signOut();
    setSession(null); setContext(null); setWorkspace(null); setAllocations([]); setPage('overview');
    setNotice('Signed out.'); setError('');
  };

  const refresh = () => loadSiteData(site);

  const saveAllocation = async (e) => {
    e.preventDefault();
    if (!selectedEmployee) return flash('Select an active on-roll employee at this site.', 'error');
    try {
      const existing = allocations.find((a) => a.employee_id === selectedEmployee.employee_id && a.process?.toLowerCase() === allocationForm.process.trim().toLowerCase() && a.status === 'active');
      const result = await operationsApi.createOrAdjustAllocation({
        site_code: site, employee_id: selectedEmployee.employee_id, process: allocationForm.process.trim(),
        authorized_quantity: Number(allocationForm.quantity), reason: allocationForm.reason,
        expected_version: existing?.version ?? null,
      });
      flash(`Allocation saved. ${result.pending_quantity} device collection(s) pending.`);
      setAllocationForm({ employee_id: '', process: '', quantity: 1, reason: '' });
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Allocation could not be saved.', 'error'); }
  };

  const scanAssign = async (e) => {
    e.preventDefault();
    if (!activeAllocation) return flash('No active employee allocation found.', 'error');
    try {
      const result = await operationsApi.scanAssignDevice(site, activeAllocation.id, scanForm.scan_value.trim());
      flash(`${result.serial} assigned to ${result.employee_id}. ${result.pending_quantity} collection(s) remaining.`);
      setScanForm((x) => ({ ...x, scan_value: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Device assignment failed.', 'error'); }
  };

  const returnDevice = async (serial) => {
    const physical = window.prompt('Physical condition: enter Good or Damaged', 'Good');
    if (!physical) return;
    const functional = window.prompt('Functional condition: enter Working or Not Working', 'Working');
    if (!functional) return;
    const map = (v, allowed) => allowed.find((x) => x.toLowerCase() === v.trim().toLowerCase());
    const p = map(physical, ['good', 'damaged']); const f = map(functional, ['working', 'not_working']);
    if (!p || !f) return flash('Condition not recognized. Use Good/Damaged and Working/Not Working.', 'error');
    const notes = window.prompt('Return note (optional)', '') || '';
    try {
      const result = await operationsApi.returnAssignedDevice(serial, p, f, notes);
      flash(`${serial} returned. New stock state: ${result.stock_state}.`);
      await loadSiteData(site);
    } catch (e) { flash(e.message || 'Device return failed.', 'error'); }
  };

  const submitHoto = async (e) => {
    e.preventDefault();
    try {
      const result = await operationsApi.recordHotoTransfer({
        device_serial: hotoForm.serial, offroll_employee_id: hotoForm.worker_id,
        shift_code: hotoForm.shift, shift_date: hotoForm.date, transaction_type: hotoForm.type, notes: hotoForm.notes,
        physical_condition: hotoForm.physical, functional_condition: hotoForm.functional,
      });
      flash(`${result.serial} moved to ${result.worker_name} (${result.worker_type}).`);
      setHotoForm((x) => ({ ...x, serial: '', worker_id: '', notes: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'HOTO transaction failed.', 'error'); }
  };

  const submitHotoReturn = async (e) => {
    e.preventDefault();
    try {
      const result = await operationsApi.returnHotoToPrimary({
        device_serial: hotoReturnForm.serial, physical_condition: hotoReturnForm.physical,
        functional_condition: hotoReturnForm.functional, shift_code: hotoReturnForm.shift,
        shift_date: hotoReturnForm.date, notes: hotoReturnForm.notes,
      });
      flash(`${result.serial} returned to primary employee ${result.primary_employee_id}.`);
      setHotoReturnForm((x) => ({ ...x, serial: '', notes: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'HOTO return failed.', 'error'); }
  };

  const createUser = async (e) => {
    e.preventDefault();
    try {
      if (userForm.password.length < 6 || userForm.password.length > 72) throw new Error('Initial password must contain 6 to 72 characters.');
      if (userForm.password !== creatingUserPasswordConfirm) throw new Error('Initial password fields do not match.');
      const siteCodes = userForm.site_codes.length ? userForm.site_codes : [userForm.site_code || site];
      await operationsApi.createUser({ ...userForm, site_codes: siteCodes, site_code: siteCodes[0] });
      flash(`Account created for ${userForm.full_name}. No email was sent.`);
      setUserForm((x) => ({ ...x, email: '', login_id: '', employee_id: '', full_name: '', process: '', password: '', site_codes: [] }));
      setCreatingUserPasswordConfirm('');
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'User account creation failed.', 'error'); }
  };

  const assignAdditionalRole = async (e) => {
    e.preventDefault();
    try {
      const siteCodes = roleAssignmentForm.site_codes.length ? roleAssignmentForm.site_codes : [roleAssignmentForm.site_code || site];
      await operationsApi.assignRoleSites(roleAssignmentForm.user_id, roleAssignmentForm.role_code, siteCodes);
      flash('Role assignment saved for the selected site(s).');
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Role assignment failed.', 'error'); }
  };

  const deactivateAccount = async (userId, userName) => {
    const reason = window.prompt(`Reason for deactivating ${userName}:`, 'Employment / access change');
    if (!reason || !reason.trim()) return;
    try {
      await operationsApi.deactivateUser(userId, reason.trim());
      flash(`Account deactivated for ${userName}.`);
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Account deactivation failed.', 'error'); }
  };

  const revokeUserRole = async (userId, roleCode, siteCode, userName) => {
    const reason = window.prompt(`Reason for removing ${human(roleCode)} at ${siteCode} from ${userName}:`, 'Role / site access change');
    if (!reason || !reason.trim()) return;
    try {
      await operationsApi.revokeRole(userId, roleCode, siteCode, reason.trim());
      flash(`${human(roleCode)} access removed for ${userName} at ${siteCode}.`);
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Role removal failed.', 'error'); }
  };

  const createRole = async (e) => {
    e.preventDefault();
    try {
      const result = await operationsApi.createRole(roleForm);
      flash(`Role ${result.role_name} created.`);
      setRoleForm({ role_name: '', role_code: '', description: '', scope_type: 'assigned_sites' });
      const data = await operationsApi.listRolesAndPermissions();
      setRoleData(data); setSelectedRole(result.role_code);
    } catch (e2) { flash(e2.message || 'Role creation failed.', 'error'); }
  };

  const savePermission = async (grant, isAllowed, scope) => {
    try {
      await operationsApi.setRolePermission({ role_code: selectedRole, permission_code: grant.permission_code, is_allowed: isAllowed, data_scope: scope || grant.data_scope || 'assigned_sites' });
      const data = await operationsApi.listRolesAndPermissions();
      setRoleData(data);
      flash(`${grant.permission_code} updated for ${selectedRole}.`);
    } catch (e) { flash(e.message || 'Permission update failed.', 'error'); }
  };

  const createEmployee = async (e) => {
    e.preventDefault();
    try {
      await operationsApi.saveEmployee(employeeForm);
      flash(`Employee ${employeeForm.employee_id} saved.`);
      setEmployeeForm((x) => ({ ...x, employee_id: '', employee_name: '', email: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Employee record could not be saved.', 'error'); }
  };

  const reconcilePosition = async (e) => {
    e.preventDefault();
    try {
      await operationsApi.reconcileOpeningPosition(reconcileForm);
      flash(`Opening position recorded for ${reconcileForm.device_serial}.`);
      setReconcileForm((x) => ({ ...x, device_serial: '', reason: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'Reconciliation failed.', 'error'); }
  };


  const addStoScan = (e) => {
    e.preventDefault();
    const scan = stoForm.scan_value.trim();
    if (!scan) return;
    if (stoScans.some((value) => value.toLowerCase() === scan.toLowerCase())) return flash('This device is already in the STO scan list.', 'error');
    setStoScans((rows) => [...rows, scan]);
    setStoForm((x) => ({ ...x, scan_value: '' }));
  };

  const createAndDispatchSto = async () => {
    if (!stoForm.to_site_code) return flash('Select a destination site.', 'error');
    if (!stoScans.length) return flash('Scan at least one HHD before dispatch.', 'error');
    try {
      const result = await operationsApi.createAndDispatchSto(site, stoForm.to_site_code, stoScans, stoForm.notes);
      flash(`${result.sto_number} dispatched with ${result.device_count} HHD(s).`);
      setStoScans([]);
      setStoForm({ to_site_code: '', scan_value: '', notes: '' });
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'STO dispatch failed.', 'error'); }
  };

  const receiveStoDevice = async (e) => {
    e.preventDefault();
    if (!stoReceiveForm.sto_id || !stoReceiveForm.scan_value.trim()) return flash('Select an open STO and scan its HHD.', 'error');
    try {
      const result = await operationsApi.receiveStoDevice(
        stoReceiveForm.sto_id, stoReceiveForm.scan_value.trim(),
        stoReceiveForm.department, stoReceiveForm.notes,
      );
      flash(`${result.device_serial} received against ${result.sto_number}. ${result.remaining_devices} device(s) pending.`);
      setStoReceiveForm((x) => ({ ...x, scan_value: '', notes: '' }));
      await loadSiteData(site);
    } catch (e2) { flash(e2.message || 'STO receipt failed.', 'error'); }
  };

  const nav = useMemo(() => {
    const items = [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'account', label: 'Account & Password', icon: LockKeyhole }];
    if (can('inventory', 'view')) items.push({ id: 'inventory', label: 'Inventory', icon: Boxes });
    if (can('distribution', 'view') || can('distribution', 'create') || can('employee_collection', 'view')) items.push({ id: 'allocations', label: 'Quantity allocations', icon: ListChecks });
    if (can('employee_collection', 'view') || can('employee_collection', 'scan_assign')) items.push({ id: 'my-devices', label: 'My devices & collection', icon: Smartphone });
    if (can('hoto', 'view') || can('hoto', 'create')) items.push({ id: 'hoto', label: 'Shift HOTO', icon: ArrowLeftRight });
    if (can('admin_employees', 'view')) items.push({ id: 'employees', label: 'On-roll employees', icon: Users });
    if (can('admin_users', 'view') || can('admin_users', 'create')) items.push({ id: 'users', label: 'Users & IDs', icon: UserRoundPlus });
    if (can('admin_roles', 'view')) items.push({ id: 'roles', label: 'Roles & permissions', icon: ShieldCheck });
    if (can('offroll_workers', 'view') || can('offroll_workers', 'sync')) items.push({ id: 'hr', label: 'HR TL/GC master', icon: FileClock });
    if (can('inventory', 'reconcile')) items.push({ id: 'reconcile', label: 'Opening stock reconciliation', icon: Wrench });
    if (can('sto', 'view') || can('sto', 'create') || can('sto', 'dispatch') || can('sto', 'receive')) items.push({ id: 'sto', label: 'STO workflow', icon: Package });
    if (can('inventory', 'view') || can('admin_audit', 'view')) items.push({ id: 'movement', label: 'IMEI movement ledger', icon: Activity });
    return items;
  }, [can]);

  useEffect(() => { if (!nav.some((n) => n.id === page)) setPage('overview'); }, [nav, page]);

  const filteredAllocations = allocations.filter((a) => `${a.employee_name} ${a.employee_id} ${a.process} ${a.id}`.toLowerCase().includes(search.toLowerCase()));
  const summary = workspace?.summary || {};
  const primaryRoleName = roleName(primaryRole || roleAssignments[0]?.role_code);

  if (initializing) return <div className="ol-auth-shell"><div className="ol-auth-card">Checking secure session…</div></div>;

  if (inviteMode) return (
    <div className="ol-auth-shell"><form className="ol-auth-card" onSubmit={completeInvite}>
      <div className="ol-brand"><div className="ol-brand-mark"><Boxes size={21}/></div><div><strong>HHD<span>•</span>Control</strong><small>ACCOUNT ACTIVATION</small></div></div>
      <h1>Set or reset your password</h1><p className="ol-muted">Your secure account link has been verified. Set a new password to continue.</p>
      <Field label="New password"><input type="password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} minLength={6} maxLength={72} autoComplete="new-password" required/></Field>
      <Field label="Confirm password"><input type="password" value={invitePasswordConfirm} onChange={(e) => setInvitePasswordConfirm(e.target.value)} minLength={6} maxLength={72} autoComplete="new-password" required/></Field>
      {error && <div className="ol-alert ol-alert-error">{error}</div>}
      <Button type="submit" disabled={busy || !invitePassword || !invitePasswordConfirm}>{busy ? 'Saving…' : 'Set password and continue'}</Button>
    </form></div>
  );

  if (!session || !context) return (
    <div className="ol-auth-shell"><form className="ol-auth-card" onSubmit={login}>
      <div className="ol-brand"><div className="ol-brand-mark"><Boxes size={21}/></div><div><strong>HHD<span>•</span>Control</strong><small>ASSET OPERATIONS PLATFORM</small></div></div>
      <h1>Sign in to Operations</h1><p className="ol-muted">Use the application account created by your administrator.</p>
      <Field label="Work email"><input type="email" autoComplete="username" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} required/></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} required/></Field>
      {error && <div className="ol-alert ol-alert-error">{error}</div>}
      {notice && <div className="ol-alert ol-alert-info">{notice}</div>}
      <Button type="submit" disabled={busy || !loginForm.email || !loginForm.password}>{busy ? 'Signing in…' : 'Sign in securely'}</Button>
      <button type="button" className="ol-text-button" onClick={forgotPassword} disabled={busy || !loginForm.email}>Forgot password?</button>
      {forgotPasswordSent && <div className="ol-alert ol-alert-info">Check your registered inbox for the password recovery link.</div>}
      <small className="ol-auth-foot">Supabase Auth · Role and site permissions are checked by the server.</small>
    </form></div>
  );

  return <div className="ol-app-shell">
    <aside className="ol-sidebar">
      <div className="ol-brand"><div className="ol-brand-mark"><Boxes size={20}/></div><div><strong>HHD<span>•</span>Control</strong><small>ASSET OPERATIONS</small></div></div>
      <div className="ol-sidebar-site"><span>ACTIVE SITE</span><select value={site} onChange={(e) => setSite(e.target.value)}>{siteOptions.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
      <nav className="ol-nav">{nav.map((item) => { const Icon = item.icon; return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><Icon size={17}/><span>{item.label}</span><ChevronRight size={15}/></button>; })}</nav>
      <div className="ol-sidebar-user"><div className="ol-avatar">{(profile?.full_name || 'U').split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase()}</div><div><strong>{profile?.full_name}</strong><small>{primaryRoleName} · {profile?.employee_id || 'Admin account'}</small></div></div>
      <button className="ol-logout" onClick={logout}><LogOut size={16}/> Sign out</button>
    </aside>

    <main className="ol-main">
      <header className="ol-topbar"><div><span className="ol-eyebrow">OPERATIONS CONTROL CENTRE</span><h1>{nav.find((n) => n.id === page)?.label || 'Overview'}</h1></div><div className="ol-top-actions"><Pill tone="success">Live backend</Pill><span className="ol-top-user">{profile?.full_name}</span><button className="ol-icon-btn" onClick={refresh} disabled={busy} title="Refresh"><RefreshCw size={17} className={busy ? 'ol-spin' : ''}/></button></div></header>
      {(error || notice) && <div className={`ol-banner ${error ? 'ol-banner-error' : 'ol-banner-success'}`}><span>{error || notice}</span><button onClick={() => { setError(''); setNotice(''); }}><X size={15}/></button></div>}
      {busy && <div className="ol-loading"><span/></div>}

 
      {page === 'account' && <Panel title="My account & password" subtitle="All application roles can update their own password. Passwords are never visible to administrators or stored in the business database.">
        <div className="ol-account-summary">
          <div><span>ACCOUNT HOLDER</span><strong>{profile?.full_name}</strong><small>{profile?.employee_id || 'Admin account'} · {primaryRoleName}</small></div>
          <div><span>REGISTERED EMAIL</span><strong>{profile?.email || '—'}</strong><small>Used for password recovery</small></div>
          <div><span>ACTIVE SITE</span><strong>{site || '—'}</strong><small>{roleAssignments.map((r) => r.site_code === '*' ? 'All sites' : r.site_code).filter((x, i, arr) => arr.indexOf(x) === i).join(', ')}</small></div>
        </div>
        <form className="ol-form-grid ol-password-form" onSubmit={savePasswordChange}>
          <Field label="Current password"><input type="password" autoComplete="current-password" value={passwordForm.current} onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })} required/></Field>
          <Field label="New password (minimum 6 characters)"><input type="password" autoComplete="new-password" minLength={6} maxLength={72} value={passwordForm.next} onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })} required/></Field>
          <Field label="Confirm new password"><input type="password" autoComplete="new-password" minLength={6} maxLength={72} value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} required/></Field>
          <div className="ol-form-actions"><Button type="submit" disabled={busy}>Change my password</Button></div>
        </form>
        <div className="ol-form-note">Forgot your password? Sign out and use “Forgot password?” on the login screen. A recovery link is sent only to your registered email.</div>
      </Panel>}

      {page === 'overview' && <>
        <div className="ol-welcome"><div><span className="ol-eyebrow">SITE WORKSPACE</span><h2>{site || 'No site assigned'}</h2><p>Authenticated as {primaryRoleName}. Only assigned site and record permissions are available.</p></div><Pill tone="info">{currentRoles.map((r) => roleName(r.role_code)).join(' / ') || 'No role'}</Pill></div>
        <div className="ol-metric-grid">
          <Metric title="Available Ops stock" value={fmt(summary.available)} note="Good + working + unallocated" icon={Boxes} tone="blue"/>
          <Metric title="Assigned devices" value={fmt(summary.assigned)} note="Primary on-roll assignments" icon={Smartphone} tone="violet"/>
          <Metric title="Quarantined / maintenance" value={fmt(summary.quarantined)} note="Not eligible for collection" icon={Wrench} tone="amber"/>
          <Metric title="Lost devices" value={fmt(summary.lost)} note="Removed from available stock" icon={AlertTriangle} tone="red"/>
        </div>
        <div className="ol-two-col">
          <Panel title="Allocation progress" subtitle="Authorized quantity versus physically collected IMEIs">
            <div className="ol-simple-table"><table><thead><tr><th>Employee</th><th>Process</th><th>Authorized</th><th>Collected</th><th>Pending</th></tr></thead><tbody>{(workspace?.allocations || []).slice(0, 8).map((a) => <tr key={a.id}><td><strong>{a.employee_name}</strong><small>{a.employee_id}</small></td><td>{a.process}</td><td>{a.authorized_quantity}</td><td>{a.collected_quantity}</td><td><Pill tone={a.pending_quantity ? 'warning' : 'success'}>{a.pending_quantity}</Pill></td></tr>)}</tbody></table>{!(workspace?.allocations || []).length && <Empty title="No allocations found" detail="Site allocations will appear here once created."/>}</div>
          </Panel>
          <Panel title="Site controls" subtitle="Fast access to common operations">
            <div className="ol-shortcuts">{nav.filter((n) => n.id !== 'overview').slice(0, 6).map((n) => { const Icon = n.icon; return <button key={n.id} onClick={() => setPage(n.id)}><Icon size={18}/><span>{n.label}</span><ChevronRight size={15}/></button>; })}</div>
          </Panel>
        </div>
      </>}

      {page === 'inventory' && <>
        <Panel title="Operations device stock" subtitle={`Current device positions recorded for ${site}. Primary assignment and temporary HOTO holder are separate.`} action={<Pill tone="info">{(workspace?.devices || []).length} records</Pill>}>
          <div className="ol-toolbar"><Search size={16}/><ScanInput value={search} onChange={setSearch} placeholder="Scan or search Serial / IMEI / holder / model"/></div>
          <div className="ol-simple-table"><table><thead><tr><th>Asset serial</th><th>IMEI</th><th>Device</th><th>Stock state</th><th>Condition</th><th>Current holder</th></tr></thead><tbody>{(workspace?.devices || []).filter((d) => `${d.serial} ${d.imei} ${d.make} ${d.model} ${d.holder_employee_id}`.toLowerCase().includes(search.toLowerCase())).map((d) => <tr key={d.serial}><td className="ol-mono">{d.serial}</td><td className="ol-mono">{d.imei || '—'}</td><td>{d.make} {d.model}</td><td><Pill tone={d.stock_state === 'available' ? 'success' : d.stock_state === 'assigned' ? 'info' : 'warning'}>{human(d.stock_state)}</Pill></td><td>{human(d.physical_condition)} / {human(d.functional_condition)}</td><td>{d.holder_employee_id || 'Operations stock'} {d.holder_type === 'offroll' && <Pill tone="violet">TL/GC</Pill>}</td></tr>)}</tbody></table>{!(workspace?.devices || []).length && <Empty title="No stock positions" detail="Opening stock must be reconciled before this screen shows inventory."/>}</div>
        </Panel>
      </>}

      {page === 'allocations' && <>
        {can('distribution', 'create') && <Panel title="Create quantity entitlement" subtitle="Allocator authorizes quantity only. IMEIs are selected later by the assigned employee at physical collection.">
          <form className="ol-form-grid" onSubmit={saveAllocation}>
            <Field label="On-roll employee"><select value={allocationForm.employee_id} onChange={(e) => { const emp = employees.find((x) => x.employee_id === e.target.value); setAllocationForm((f) => ({ ...f, employee_id: e.target.value, process: emp?.process || f.process })); }} required><option value="">Select active employee</option>{allocatableEmployees.map((e) => <option key={e.employee_id} value={e.employee_id}>{e.employee_name} · {e.employee_id} · {e.designation}</option>)}</select></Field>
            <Field label="Process"><input value={allocationForm.process} onChange={(e) => setAllocationForm({ ...allocationForm, process: e.target.value })} placeholder="Inbound / Outbound / Processing" required/></Field>
            <Field label="Authorized quantity"><input type="number" min="1" step="1" value={allocationForm.quantity} onChange={(e) => setAllocationForm({ ...allocationForm, quantity: e.target.value })} required/></Field>
            <Field label="Adjustment reason (mandatory for reduction)"><input value={allocationForm.reason} onChange={(e) => setAllocationForm({ ...allocationForm, reason: e.target.value })} placeholder="Operational requirement / reduction reason"/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy || !allocationForm.employee_id}>Save quantity allocation</Button></div>
          </form>
          {selectedEmployee && <div className="ol-form-note">Selected: {selectedEmployee.employee_name} · {selectedEmployee.designation} · {selectedEmployee.site_code}. The Allocator does not choose IMEI numbers.</div>}
        </Panel>}
        <Panel title="Site allocation register" subtitle="Allocated quantity, collected IMEIs and pending collection count.">
          <div className="ol-toolbar"><Search size={16}/><input placeholder="Search employee, ID or process" value={search} onChange={(e) => setSearch(e.target.value)}/></div>
          <div className="ol-simple-table"><table><thead><tr><th>Employee</th><th>Employee ID</th><th>Designation</th><th>Process</th><th>Authorized</th><th>Collected</th><th>Pending</th><th>Version</th></tr></thead><tbody>{filteredAllocations.map((a) => <tr key={a.id}><td><strong>{a.employee_name}</strong></td><td className="ol-mono">{a.employee_id}</td><td>{a.designation}</td><td>{a.process}</td><td>{a.authorized_quantity}</td><td>{a.collected_quantity}</td><td><Pill tone={a.pending_quantity ? 'warning' : 'success'}>{a.pending_quantity}</Pill></td><td>{a.version}</td></tr>)}</tbody></table>{!filteredAllocations.length && <Empty title="No allocations" detail="No allocation records match this site or search."/>}</div>
        </Panel>
      </>}

      {page === 'my-devices' && <>
        {can('employee_collection', 'scan_assign') && <Panel title="Physical device collection" subtitle={`Signed in as ${profile?.full_name} · Employee ID ${profile?.employee_id || 'not linked'}. Your login identity is the employee validation.`}>
          <form className="ol-scan-row" onSubmit={scanAssign}>
            <Field label="Your active allocation"><select value={scanForm.allocation_id || activeAllocation?.id || ''} onChange={(e) => setScanForm({ ...scanForm, allocation_id: e.target.value })}><option value="">Select allocation</option>{allocations.filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.process} · {a.collected_quantity}/{a.authorized_quantity} collected</option>)}</select></Field>
            <Field label="Scan HHD IMEI or asset serial"><ScanInput value={scanForm.scan_value} onChange={(value) => setScanForm((x) => ({ ...x, scan_value: value }))} placeholder="Scan barcode or type Serial / IMEI" required/></Field>
            <Button type="submit" disabled={busy || !scanForm.scan_value.trim() || !(scanForm.allocation_id || activeAllocation?.id)}><ScanLine size={16}/> Assign scanned HHD</Button>
          </form>
          <div className="ol-form-note">The server checks your active login, site, allocation limit, asset position, condition and duplicate assignment in one database transaction.</div>
        </Panel>}
        <Panel title="My assigned HHDs" subtitle="Your primary employee assignments. A temporary TL/GC shift holder does not overwrite your primary assignment.">
          <div className="ol-simple-table"><table><thead><tr><th>Asset serial</th><th>IMEI</th><th>Model</th><th>Current shift holder</th><th>Condition</th><th>Return</th></tr></thead><tbody>{myDevices.map((d) => <tr key={d.assignment_id}><td className="ol-mono">{d.serial}</td><td className="ol-mono">{d.imei || '—'}</td><td>{d.make} {d.model}</td><td>{d.current_holder_type === 'offroll' ? <Pill tone="violet">TL/GC: {d.current_holder_employee_id}</Pill> : 'Primary custodian'}</td><td>{human(d.physical_condition)} / {human(d.functional_condition)}</td><td><Button tone="secondary" onClick={() => returnDevice(d.serial)} disabled={d.current_holder_type === 'offroll'}>Return</Button></td></tr>)}</tbody></table>{!myDevices.length && <Empty title="No assigned devices" detail="Your scanned IMEI assignments will appear here."/>}</div>
        </Panel>
      </>}

      {page === 'hoto' && <>
        <Panel title="TL / GC shift handover" subtitle="Off-roll worker identity is validated against the HR-synchronized master. TL/GC do not sign in to the application.">
          <form className="ol-form-grid" onSubmit={submitHoto}>
            <Field label="HHD asset Serial / IMEI"><ScanInput value={hotoForm.serial} onChange={(value) => setHotoForm((x) => ({ ...x, serial: value }))} required placeholder="Scan HHD barcode"/></Field>
            <Field label="Scan TL / GC Employee ID"><ScanInput value={hotoForm.worker_id} onChange={(value) => setHotoForm((x) => ({ ...x, worker_id: value.toUpperCase() }))} required placeholder="Scan or enter GC / TL ID" listId="hoto-worker-ids" listOptions={offrollWorkers.filter((w) => w.employment_status === 'active').map((w) => ({ value: w.employee_id, label: `${w.employee_name} · ${w.worker_type}` }))}/></Field>
            <Field label="HOTO action"><select value={hotoForm.type} onChange={(e) => setHotoForm({ ...hotoForm, type: e.target.value })}><option value="handover">Initial handover from on-roll custodian</option><option value="takeover">Shift takeover by next TL/GC</option><option value="mid_shift_swap">Mid-shift swap</option></select></Field>
            <Field label="Shift"><select value={hotoForm.shift} onChange={(e) => setHotoForm({ ...hotoForm, shift: e.target.value })}><option value="A">Shift A</option><option value="B">Shift B</option><option value="C">Shift C</option></select></Field>
            <Field label="Shift date"><input type="date" value={hotoForm.date} onChange={(e) => setHotoForm({ ...hotoForm, date: e.target.value })} required/></Field>
            <Field label="Physical condition"><select value={hotoForm.physical} onChange={(e) => setHotoForm({ ...hotoForm, physical: e.target.value })}><option value="good">Good</option><option value="damaged" disabled>Damaged — cannot hand over</option></select></Field>
            <Field label="Functional condition"><select value={hotoForm.functional} onChange={(e) => setHotoForm({ ...hotoForm, functional: e.target.value })}><option value="working">Working</option><option value="not_working" disabled>Not Working — cannot hand over</option></select></Field>
            <Field label="Notes"><input value={hotoForm.notes} onChange={(e) => setHotoForm({ ...hotoForm, notes: e.target.value })}/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy || !hotoForm.serial || !hotoForm.worker_id}>Validate HR ID and record HOTO</Button></div>
          </form>
        </Panel>
        <Panel title="Return from TL/GC to primary custodian" subtitle="Record the physical and functional condition when the worker returns the HHD.">
          <form className="ol-form-grid" onSubmit={submitHotoReturn}>
            <Field label="Scan asset Serial / IMEI"><ScanInput value={hotoReturnForm.serial} onChange={(value) => setHotoReturnForm((x) => ({ ...x, serial: value }))} required/></Field>
            <Field label="Physical condition"><select value={hotoReturnForm.physical} onChange={(e) => setHotoReturnForm({ ...hotoReturnForm, physical: e.target.value })}><option value="good">Good</option><option value="damaged">Damaged</option></select></Field>
            <Field label="Functional condition"><select value={hotoReturnForm.functional} onChange={(e) => setHotoReturnForm({ ...hotoReturnForm, functional: e.target.value })}><option value="working">Working</option><option value="not_working">Not Working</option></select></Field>
            <Field label="Shift"><select value={hotoReturnForm.shift} onChange={(e) => setHotoReturnForm({ ...hotoReturnForm, shift: e.target.value })}><option value="A">Shift A</option><option value="B">Shift B</option><option value="C">Shift C</option></select></Field>
            <Field label="Shift date"><input type="date" value={hotoReturnForm.date} onChange={(e) => setHotoReturnForm({ ...hotoReturnForm, date: e.target.value })}/></Field>
            <Field label="Notes"><input value={hotoReturnForm.notes} onChange={(e) => setHotoReturnForm({ ...hotoReturnForm, notes: e.target.value })}/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy || !hotoReturnForm.serial}>Record return to primary custodian</Button></div>
          </form>
          <div className="ol-form-note">If the returned device is damaged or not working, Asset Manager must subsequently close the primary assignment through the device return action so it moves to quarantine.</div>
        </Panel>
        <Panel title="Recent HOTO history" subtitle="Each line records the current holder transition and the operator who performed the transaction.">
          <div className="ol-simple-table"><table><thead><tr><th>Date/time</th><th>Device</th><th>Shift</th><th>Action</th><th>From</th><th>To</th><th>Worker type</th></tr></thead><tbody>{hotoRows.slice(0, 100).map((h) => <tr key={h.id}><td>{when(h.performed_at)}</td><td className="ol-mono">{h.device_serial}</td><td>{h.shift_code}</td><td>{human(h.transaction_type)}</td><td>{h.from_holder_employee_id}</td><td>{h.to_holder_employee_id}</td><td>{h.offroll_worker_type || 'On-roll'}</td></tr>)}</tbody></table>{!hotoRows.length && <Empty title="No HOTO transactions" detail="Handover and takeover records will appear after the first transaction."/>}</div>
        </Panel>
      </>}

      {page === 'employees' && can('admin_employees', 'view') && <Panel title="On-roll employee master" subtitle="Only active employees with an individual application login can receive allocations.">
        {can('admin_employees', 'create') && <form className="ol-form-grid ol-form-compact" onSubmit={createEmployee}>
          <Field label="Employee ID"><input value={employeeForm.employee_id} onChange={(e) => setEmployeeForm({ ...employeeForm, employee_id: e.target.value.toUpperCase() })} required/></Field>
          <Field label="Employee name"><input value={employeeForm.employee_name} onChange={(e) => setEmployeeForm({ ...employeeForm, employee_name: e.target.value })} required/></Field>
          <Field label="Site"><select value={employeeForm.site_code || site} onChange={(e) => setEmployeeForm({ ...employeeForm, site_code: e.target.value })}>{siteOptions.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Designation"><select value={employeeForm.designation} onChange={(e) => setEmployeeForm({ ...employeeForm, designation: e.target.value })}><option>Lead</option><option>Sr. Lead</option><option>AM</option><option>Asset Manager</option><option>Allocator</option></select></Field>
          <Field label="Process"><input value={employeeForm.process} onChange={(e) => setEmployeeForm({ ...employeeForm, process: e.target.value })}/></Field>
          <Field label="Work email"><input type="email" value={employeeForm.email} onChange={(e) => setEmployeeForm({ ...employeeForm, email: e.target.value })}/></Field>
          <div className="ol-form-actions"><Button type="submit">Save employee master</Button></div>
        </form>}
        <div className="ol-simple-table"><table><thead><tr><th>Employee ID</th><th>Name</th><th>Designation</th><th>Process</th><th>Site</th><th>Status</th><th>Login linked</th></tr></thead><tbody>{employees.map((e) => <tr key={e.employee_id}><td className="ol-mono">{e.employee_id}</td><td>{e.employee_name}</td><td>{e.designation}</td><td>{e.process || '—'}</td><td>{e.site_code}</td><td><Pill tone={e.employment_status === 'active' ? 'success' : 'warning'}>{human(e.employment_status)}</Pill></td><td>{e.linked_user_id ? 'Yes' : 'No'}</td></tr>)}</tbody></table>{!employees.length && <Empty title="No employee records" detail="Add or provision an on-roll employee account to start allocation."/>}</div>
      </Panel>}

      {page === 'users' && (can('admin_users', 'view') || can('admin_users', 'create') || can('admin_users', 'update')) && <>
        {can('admin_users', 'create') && <Panel title="Create application login ID" subtitle="Only on-roll application users receive individual logins. TL/GC are not provisioned here.">
          <form className="ol-form-grid" onSubmit={createUser}>
            <Field label="Full name"><input value={userForm.full_name} onChange={(e) => setUserForm({ ...userForm, full_name: e.target.value })} required/></Field>
            <Field label="Work email"><input type="email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} required/></Field>
            <Field label="Login ID"><input value={userForm.login_id} onChange={(e) => setUserForm({ ...userForm, login_id: e.target.value })} required/></Field>
            <Field label="Employee ID"><input value={userForm.employee_id} onChange={(e) => setUserForm({ ...userForm, employee_id: e.target.value.toUpperCase() })} placeholder="Required for Operations roles"/></Field>
            <Field label="Role"><select value={userForm.role_code} onChange={(e) => setUserForm({ ...userForm, role_code: e.target.value, site_codes: [], site_code: e.target.value === 'admin' ? '*' : site })}>{roleData.roles.filter((r) => isAdmin || r.role_code !== 'admin').map((r) => <option key={r.role_code} value={r.role_code}>{roleName(r.role_code)}</option>)}</select></Field>
            <Field label="Assigned site(s)" hint={userForm.role_code === 'assigned_employee' ? 'Custodian accounts use one On-roll Employee Master site.' : 'Select one or more sites. All sites is reserved for Admin.'}><select multiple={userForm.role_code !== 'assigned_employee'} size={Math.min(6, Math.max(3, siteOptions.length))} value={userForm.role_code === 'assigned_employee' ? (userForm.site_codes[0] || userForm.site_code || site) : (userForm.site_codes.length ? userForm.site_codes : [userForm.site_code || site])} onChange={(e) => { const selected = Array.from(e.target.selectedOptions).map((o) => o.value); setUserForm({ ...userForm, site_codes: selected, site_code: selected[0] || '' }); }} required>
              {(userForm.role_code === 'admin' ? ['*'] : siteOptions).map((s) => <option key={s} value={s}>{s === '*' ? 'All sites' : s}</option>)}
            </select></Field>
            <Field label="Designation"><input value={userForm.designation} onChange={(e) => setUserForm({ ...userForm, designation: e.target.value })} placeholder="Lead / Sr. Lead / AM"/></Field>
            <Field label="Process"><input value={userForm.process} onChange={(e) => setUserForm({ ...userForm, process: e.target.value })}/></Field>
            <Field label="Initial password (minimum 6 characters)"><input type="password" minLength={6} maxLength={72} autoComplete="new-password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} required/></Field>
            <Field label="Confirm initial password"><input type="password" minLength={6} maxLength={72} autoComplete="new-password" value={creatingUserPasswordConfirm} onChange={(e) => setCreatingUserPasswordConfirm(e.target.value)} required/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy}>Create account — no email sent</Button></div>
          </form>
          <div className="ol-form-note">Admin creates and activates this account directly. Share the initial password with the employee through your approved secure channel; the application never stores or displays it.</div>
        </Panel>}
        {editingUser && can('admin_users', 'update') && <Panel title="Edit application account" subtitle="Updates the profile and Auth identity. A new password is optional and will be reset through Supabase Auth.">
          <form className="ol-form-grid" onSubmit={saveUserChanges}>
            <Field label="Full name"><input value={editUserForm.full_name} onChange={(e) => setEditUserForm({ ...editUserForm, full_name: e.target.value })} required/></Field>
            <Field label="Employee ID"><input value={editUserForm.employee_id} onChange={(e) => setEditUserForm({ ...editUserForm, employee_id: e.target.value.toUpperCase() })}/></Field>
            <Field label="Login ID"><input value={editUserForm.login_id} onChange={(e) => setEditUserForm({ ...editUserForm, login_id: e.target.value })} required/></Field>
            <Field label="Email"><input type="email" value={editUserForm.email} onChange={(e) => setEditUserForm({ ...editUserForm, email: e.target.value })} required/></Field>
            <Field label="Designation"><input value={editUserForm.designation} onChange={(e) => setEditUserForm({ ...editUserForm, designation: e.target.value })}/></Field>
            <Field label="Process"><input value={editUserForm.process} onChange={(e) => setEditUserForm({ ...editUserForm, process: e.target.value })}/></Field>
            <Field label="New password (optional, minimum 6 characters)"><input type="password" minLength={6} maxLength={72} autoComplete="new-password" value={editUserForm.password} onChange={(e) => setEditUserForm({ ...editUserForm, password: e.target.value })}/></Field>
            <Field label="Confirm new password"><input type="password" minLength={6} maxLength={72} autoComplete="new-password" value={editUserForm.password_confirm} onChange={(e) => setEditUserForm({ ...editUserForm, password_confirm: e.target.value })}/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy}>Save account changes</Button><Button type="button" tone="secondary" onClick={() => setEditingUser(null)}>Cancel</Button></div>
          </form>
          <div className="ol-form-note">Passwords are write-only. Admins can set a new password, but cannot retrieve the current password.</div>
        </Panel>}
        <Panel title="Application account register" subtitle="Account access and role assignments. HR off-roll workers are stored separately.">
          <div className="ol-simple-table"><table><thead><tr><th>Name</th><th>Employee ID</th><th>Login ID</th><th>Email</th><th>Roles / site</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>{users.map((u) => <tr key={u.user_id}><td><strong>{u.full_name}</strong></td><td>{u.employee_id || '—'}</td><td className="ol-mono">{u.login_id}</td><td>{u.email}</td><td><div className="ol-role-chip-list">{(u.roles || []).map((r) => <span className="ol-role-chip" key={`${r.role_code}:${r.site_code}`}><span>{r.role_name} · {r.site_code}</span>{can('admin_users', 'update') && r.is_active && <button type="button" title="Remove role assignment" onClick={() => revokeUserRole(u.user_id, r.role_code, r.site_code, u.full_name)}>×</button>}</span>)}</div></td><td><Pill tone={u.account_status === 'active' ? 'success' : 'warning'}>{human(u.account_status)}</Pill></td><td>{when(u.last_login_at)}</td><td><div className="ol-actions-inline">{can('admin_users', 'update') && <Button tone="secondary" onClick={() => startEditUser(u)}>Edit</Button>}{can('admin_users', 'deactivate') && u.account_status !== 'deactivated' ? <Button tone="danger" onClick={() => deactivateAccount(u.user_id, u.full_name)}>Deactivate</Button> : null}</div></td></tr>)}</tbody></table>{!users.length && <Empty title="No application users returned" detail="User records will appear once provisioned."/>}</div>
        </Panel>
      </>}

      {page === 'roles' && can('admin_roles', 'view') && <>
        {can('admin_roles', 'create') && <Panel title="Create role" subtitle="Custom roles combine the available permissions and data scopes.">
          <form className="ol-form-grid" onSubmit={createRole}>
            <Field label="Role name"><input value={roleForm.role_name} onChange={(e) => setRoleForm({ ...roleForm, role_name: e.target.value, role_code: e.target.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} required/></Field>
            <Field label="Role code"><input value={roleForm.role_code} onChange={(e) => setRoleForm({ ...roleForm, role_code: e.target.value })} required/></Field>
            <Field label="Scope type"><select value={roleForm.scope_type} onChange={(e) => setRoleForm({ ...roleForm, scope_type: e.target.value })}><option value="assigned_sites">Assigned sites</option><option value="own_records">Own records</option></select></Field>
            <Field label="Description"><input value={roleForm.description} onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}/></Field>
            <div className="ol-form-actions"><Button type="submit">Create role</Button></div>
          </form>
        </Panel>}
        {can('admin_users', 'update') && <Panel title="Assign an additional role" subtitle="Role assignments are site-scoped. Admin is the only role permitted to have global (*) scope.">
          <form className="ol-form-grid ol-form-compact" onSubmit={assignAdditionalRole}>
            <Field label="Application user"><select value={roleAssignmentForm.user_id} onChange={(e) => setRoleAssignmentForm({ ...roleAssignmentForm, user_id: e.target.value })} required><option value="">Select account</option>{users.filter((u) => u.account_status !== 'deactivated').map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} · {u.login_id}</option>)}</select></Field>
            <Field label="Role"><select value={roleAssignmentForm.role_code} onChange={(e) => setRoleAssignmentForm({ ...roleAssignmentForm, role_code: e.target.value, site_codes: [], site_code: e.target.value === 'admin' ? '*' : site })}>{roleData.roles.filter((r) => isAdmin || r.role_code !== 'admin').map((r) => <option key={r.role_code} value={r.role_code}>{roleName(r.role_code)}</option>)}</select></Field>
            <Field label="Assigned site(s)" hint={roleAssignmentForm.role_code === 'assigned_employee' ? 'Custodian is tied to one On-roll Employee Master site.' : 'Select one or more sites. All sites is only available for Admin.'}><select multiple={roleAssignmentForm.role_code !== 'assigned_employee'} size={Math.min(6, Math.max(3, siteOptions.length))} value={roleAssignmentForm.role_code === 'assigned_employee' ? (roleAssignmentForm.site_codes[0] || roleAssignmentForm.site_code || site) : (roleAssignmentForm.site_codes.length ? roleAssignmentForm.site_codes : [roleAssignmentForm.site_code || site])} onChange={(e) => { const selected = Array.from(e.target.selectedOptions).map((o) => o.value); setRoleAssignmentForm({ ...roleAssignmentForm, site_codes: selected, site_code: selected[0] || '' }); }} required>{(isAdmin && roleAssignmentForm.role_code === 'admin' ? ['*'] : siteOptions).map((s) => <option key={s} value={s}>{s === '*' ? 'All sites' : s}</option>)}</select></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy || !roleAssignmentForm.user_id}>Assign role to selected sites</Button></div>
          </form>
        </Panel>}
        <Panel title="Detailed permission matrix" subtitle="Permission changes are saved to PostgreSQL and enforced again by database functions.">
          <div className="ol-toolbar"><label>Role<select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)}>{roleData.roles.filter((r) => isAdmin || r.role_code !== 'admin').map((r) => <option key={r.role_code} value={r.role_code}>{roleName(r.role_code)}</option>)}</select></label></div>
          <div className="ol-permission-groups">{roleData.permissions.map((p) => {
            const grant = selectedRoleGrants[p.permission_code] || { permission_code: p.permission_code, is_allowed: false, data_scope: 'assigned_sites' };
            return <div className="ol-permission-row" key={p.permission_code}><div><strong>{p.module_name} · {p.action_name}</strong><small>{p.permission_code} — {p.description}</small></div><label className="ol-toggle"><input type="checkbox" checked={!!grant.is_allowed} onChange={(e) => savePermission(grant, e.target.checked, grant.data_scope)} disabled={!can('admin_roles', 'manage_permissions')}/><span/></label><select value={grant.data_scope || 'assigned_sites'} onChange={(e) => savePermission(grant, !!grant.is_allowed, e.target.value)} disabled={!grant.is_allowed || !can('admin_roles', 'manage_permissions')}><option value="own">Own records</option><option value="assigned_sites">Assigned sites</option><option value="all_sites">All sites</option></select></div>;
          })}</div>
        </Panel>
      </>}

      {page === 'hr' && <>
        <div className="ol-hr-status"><FileClock size={21}/><div><strong>HR Google Sheet · Source of truth</strong><span>TL/GC identities are read-only in this application. No off-roll login accounts are created.</span></div><Pill tone="info">Scheduled Apps Script sync</Pill></div>
        <Panel title="TL / GC master" subtitle="Only active and site-matched HR rows are eligible for new HOTO.">
          <div className="ol-simple-table"><table><thead><tr><th>Employee ID</th><th>Name</th><th>Type</th><th>Site</th><th>Process</th><th>Status</th><th>Last sync</th></tr></thead><tbody>{offrollWorkers.map((w) => <tr key={w.employee_id}><td className="ol-mono">{w.employee_id}</td><td>{w.employee_name}</td><td><Pill tone={w.worker_type === 'TL' ? 'violet' : 'info'}>{w.worker_type}</Pill></td><td>{w.site_code}</td><td>{w.process || '—'}</td><td><Pill tone={w.employment_status === 'active' ? 'success' : 'warning'}>{human(w.employment_status)}</Pill></td><td>{when(w.last_synced_at)}</td></tr>)}</tbody></table>{!offrollWorkers.length && <Empty title="No HR workers synchronized" detail="Run the Apps Script HR sync after configuring the HR spreadsheet and webhook secret."/>}</div>
        </Panel>
        {isAdmin && <Panel title="HR synchronization runs" subtitle="Last sync results and row counts."><div className="ol-simple-table"><table><thead><tr><th>Started</th><th>Status</th><th>Received</th><th>Inserted</th><th>Updated</th><th>Deactivated</th><th>Message</th></tr></thead><tbody>{hrRuns.map((r) => <tr key={r.id}><td>{when(r.started_at)}</td><td><Pill tone={r.status === 'success' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{human(r.status)}</Pill></td><td>{r.received_rows}</td><td>{r.inserted_rows}</td><td>{r.updated_rows}</td><td>{r.deactivated_rows}</td><td>{r.message}</td></tr>)}</tbody></table>{!hrRuns.length && <Empty title="No sync history" detail="A successful HR Sheet synchronization will be logged here."/>}</div></Panel>}
      </>}

      {page === 'audit' && <Panel title="Audit & activity" subtitle="Administrative, identity, allocation and inventory changes. Records are read-only and retained for traceability." action={<Pill tone="info">{auditRows.length} events</Pill>}>
        <div className="ol-toolbar"><Search size={16}/><input placeholder="Search action, entity, ID or reason" value={search} onChange={(e) => setSearch(e.target.value)}/></div>
        <div className="ol-simple-table"><table><thead><tr><th>Date/time</th><th>Action</th><th>Entity</th><th>Entity ID</th><th>Site</th><th>Reason</th><th>Actor</th></tr></thead><tbody>{auditRows.filter((a) => `${a.action_code} ${a.entity_type} ${a.entity_id} ${a.reason} ${a.site_code}`.toLowerCase().includes(search.toLowerCase())).map((a) => <tr key={a.id}><td>{when(a.created_at)}</td><td><Pill tone="info">{a.action_code}</Pill></td><td>{a.entity_type}</td><td className="ol-mono">{a.entity_id || '—'}</td><td>{a.site_code || 'All sites'}</td><td>{a.reason || '—'}</td><td className="ol-mono">{String(a.actor_user_id || '').slice(0, 8) || 'System'}</td></tr>)}</tbody></table>{!auditRows.length && <Empty title="No audit events returned" detail="Events will appear as users, allocations, reconciliations and HOTO transactions are recorded."/>}</div>
      </Panel>}

      {page === 'reconcile' && <Panel title="Opening stock reconciliation" subtitle="Use this only during a controlled physical opening-stock count. It writes an audited position and movement event.">
        <form className="ol-form-grid" onSubmit={reconcilePosition}>
          <Field label="Scan device Serial / unique IMEI"><ScanInput value={reconcileForm.device_serial} onChange={(value) => setReconcileForm((x) => ({ ...x, device_serial: value }))} required/></Field>
          <Field label="Site"><select value={reconcileForm.site_code || site} onChange={(e) => setReconcileForm({ ...reconcileForm, site_code: e.target.value })}>{siteOptions.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Current owner department"><select value={reconcileForm.owner_department} onChange={(e) => setReconcileForm({ ...reconcileForm, owner_department: e.target.value })}>{['operations','it','superstore','in_transit','vendor'].map((v) => <option key={v}>{v}</option>)}</select></Field>
          <Field label="Stock state"><select value={reconcileForm.stock_state} onChange={(e) => setReconcileForm({ ...reconcileForm, stock_state: e.target.value })}>{['available','in_transit','quarantined','maintenance','lost','retired'].map((v) => <option key={v}>{v}</option>)}</select></Field>
          <Field label="Physical condition"><select value={reconcileForm.physical_condition} onChange={(e) => setReconcileForm({ ...reconcileForm, physical_condition: e.target.value })}><option value="good">Good</option><option value="damaged">Damaged</option><option value="unknown">Unknown</option></select></Field>
          <Field label="Functional condition"><select value={reconcileForm.functional_condition} onChange={(e) => setReconcileForm({ ...reconcileForm, functional_condition: e.target.value })}><option value="working">Working</option><option value="not_working">Not Working</option><option value="unknown">Unknown</option></select></Field>
          <Field label="Reconciliation reason"><input value={reconcileForm.reason} onChange={(e) => setReconcileForm({ ...reconcileForm, reason: e.target.value })} required/></Field>
          <div className="ol-form-actions"><Button type="submit" disabled={busy}>Save audited opening position</Button></div>
        </form>
        <div className="ol-form-note">The form refuses to overwrite an asset with an active employee assignment. Scan duplicates and unknown serials must be resolved before reconciliation.</div>
      </Panel>}


      {page === 'sto' && <>
        {(can('sto', 'create') && can('sto', 'dispatch')) && <Panel title="Create & dispatch Stock Transfer Order" subtitle={`Scan each HHD at the source site. Dispatch is recorded against the canonical Serial and IMEI.`}>
          <form className="ol-form-grid" onSubmit={addStoScan}>
            <Field label="Source site"><input value={site} disabled/></Field>
            <Field label="Destination site"><select value={stoForm.to_site_code} onChange={(e) => setStoForm({ ...stoForm, to_site_code: e.target.value })} required><option value="">Select destination</option>{siteOptions.filter((s) => s !== site).map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Scan HHD Serial / IMEI"><ScanInput value={stoForm.scan_value} onChange={(value) => setStoForm((x) => ({ ...x, scan_value: value }))} required placeholder="Scan device barcode"/></Field>
            <Field label="Dispatch notes"><input value={stoForm.notes} onChange={(e) => setStoForm({ ...stoForm, notes: e.target.value })} placeholder="Reason / reference / vehicle details"/></Field>
            <div className="ol-form-actions"><Button type="submit" tone="secondary" disabled={busy || !stoForm.scan_value.trim()}>Add scanned device</Button></div>
          </form>
          <div className="ol-sto-scan-list">
            <div className="ol-sto-scan-heading"><strong>Scanned devices</strong><Pill tone="info">{stoScans.length} HHD(s)</Pill></div>
            {stoScans.map((scan, index) => <div className="ol-sto-scan-item" key={`${scan}:${index}`}><span>{index + 1}. {scan}</span><button type="button" onClick={() => setStoScans((rows) => rows.filter((_, i) => i !== index))}>Remove</button></div>)}
            {!stoScans.length && <small>No devices added yet. Each barcode must be unique and reconciled at this source site.</small>}
          </div>
          <div className="ol-form-actions"><Button type="button" disabled={busy || !stoForm.to_site_code || !stoScans.length} onClick={createAndDispatchSto}>Create STO & dispatch {stoScans.length ? `(${stoScans.length})` : ''}</Button></div>
          <div className="ol-form-note">The backend validates every serial/IMEI, source site, ownership, stock state, condition, assignments and open transfers in one transaction.</div>
        </Panel>}
        {(can('sto', 'receive')) && <Panel title="Receive HHD against an STO" subtitle="Scan each physical HHD at the destination. Partial receipts are supported.">
          <form className="ol-form-grid" onSubmit={receiveStoDevice}>
            <Field label="Incoming STO"><select value={stoReceiveForm.sto_id} onChange={(e) => setStoReceiveForm({ ...stoReceiveForm, sto_id: e.target.value })} required><option value="">Select open incoming STO</option>{stoRows.filter((r) => r.to_site_code === site && ['dispatched','partially_received'].includes(r.status)).map((r) => <option key={r.id} value={r.id}>{r.sto_number} · {r.received_count}/{r.device_count} received · From {r.from_site_code}</option>)}</select></Field>
            <Field label="Scan received HHD Serial / IMEI"><ScanInput value={stoReceiveForm.scan_value} onChange={(value) => setStoReceiveForm((x) => ({ ...x, scan_value: value }))} required placeholder="Scan physical HHD barcode"/></Field>
            <Field label="Receiving department"><select value={stoReceiveForm.department} onChange={(e) => setStoReceiveForm({ ...stoReceiveForm, department: e.target.value })}><option value="operations">Operations</option><option value="it">IT</option><option value="superstore">Superstore</option></select></Field>
            <Field label="Receipt notes"><input value={stoReceiveForm.notes} onChange={(e) => setStoReceiveForm({ ...stoReceiveForm, notes: e.target.value })}/></Field>
            <div className="ol-form-actions"><Button type="submit" disabled={busy || !stoReceiveForm.sto_id || !stoReceiveForm.scan_value.trim()}>Confirm scanned receipt</Button></div>
          </form>
        </Panel>}
        <Panel title="Stock transfer register" subtitle="Dispatch and receipt status across the active site.">
          <div className="ol-simple-table"><table><thead><tr><th>STO number</th><th>From</th><th>To</th><th>Status</th><th>Devices</th><th>Received</th><th>Dispatched</th></tr></thead><tbody>{stoRows.map((r) => <tr key={r.id}><td className="ol-mono">{r.sto_number}</td><td>{r.from_site_code}</td><td>{r.to_site_code}</td><td><Pill tone={r.status === 'received' ? 'success' : r.status === 'cancelled' ? 'danger' : 'warning'}>{human(r.status)}</Pill></td><td>{r.device_count}</td><td>{r.received_count}</td><td>{when(r.dispatched_at)}</td></tr>)}</tbody></table>{!stoRows.length && <Empty title="No STO records" detail="Created and incoming Stock Transfer Orders will appear here."/>}</div>
        </Panel>
      </>}

      {page === 'movement' && <Panel title="IMEI-level device movement ledger" subtitle="Chronological, append-only movement and condition history for each device.">
        <div className="ol-toolbar"><Search size={16}/><ScanInput value={search} onChange={setSearch} placeholder="Scan or search Serial / IMEI / event / reference"/><Button tone="secondary" onClick={async () => { const rows = await operationsApi.listDeviceMovements(site, search, 300); setMovementRows(Array.isArray(rows) ? rows : []); }} disabled={busy}>Search ledger</Button></div>
        <div className="ol-simple-table"><table><thead><tr><th>Date/time</th><th>Asset Serial</th><th>IMEI</th><th>Event</th><th>From</th><th>To</th><th>Condition</th><th>Change details</th><th>Reference</th><th>Performed by</th></tr></thead><tbody>{movementRows.filter((m) => `${m.device_serial} ${m.imei_number} ${m.event_type} ${m.reference_id} ${m.notes}`.toLowerCase().includes(search.toLowerCase())).map((m) => <tr key={m.id}><td>{when(m.performed_at)}</td><td className="ol-mono">{m.device_serial}</td><td className="ol-mono">{m.imei_number || '—'}</td><td><Pill tone="info">{human(m.event_type)}</Pill></td><td>{m.from_department || m.from_holder_id || '—'}</td><td>{m.to_department || m.to_holder_id || '—'}</td><td>{human(m.physical_condition)} / {human(m.functional_condition)}</td><td className="ol-change-detail">{Object.entries(m.metadata || {}).map(([key, value]) => `${human(key)}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ') || m.notes || '—'}</td><td>{m.reference_type || '—'} {m.reference_id || ''}</td><td>{m.performed_by_name || (m.performed_by ? String(m.performed_by).slice(0, 8) : 'System')}</td></tr>)}</tbody></table>{!movementRows.length && <Empty title="No movement history" detail="Device movements will appear after reconciliation, allocation, return, HOTO or STO transactions."/>}</div>
      </Panel>}

      <footer className="ol-footer"><span>HHD Control · Release 2</span><span>Backend authorization active · {site}</span></footer>
    </main>
  </div>;
}
