const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const SESSION_KEY = 'hhd_operations_auth_v1';

function config() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the frontend environment.');
  }
}

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return value && value.access_token && value.refresh_token ? value : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (!session) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const message = data.msg || data.message || data.error_description || data.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function authRequest(path, body) {
  config();
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export async function signInWithEmail(email, password) {
  const data = await authRequest('token?grant_type=password', { email: email.trim().toLowerCase(), password });
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    user: data.user,
  };
  saveSession(session);
  return session;
}

/** Consume an invite link. Configure the Supabase Invite User email template to redirect
 * to the app with token_hash and type=invite, or use the implicit-flow access token hash.
 */
export async function consumeInviteLink() {
  if (typeof window === 'undefined') return null;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const tokenHash = query.get('token_hash');
  const type = query.get('type') || hash.get('type') || '';
  let session = null;

  if (tokenHash && ['invite', 'recovery', 'signup', 'magiclink'].includes(type)) {
    const verified = await authRequest('verify', { token_hash: tokenHash, type });
    session = {
      access_token: verified.access_token,
      refresh_token: verified.refresh_token,
      token_type: verified.token_type,
      expires_at: verified.expires_at || Math.floor(Date.now() / 1000) + Number(verified.expires_in || 3600),
      user: verified.user,
    };
    saveSession(session);
  } else if (hash.get('access_token') && hash.get('refresh_token')) {
    session = {
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
      token_type: hash.get('token_type') || 'bearer',
      expires_at: Number(hash.get('expires_at') || 0) || Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || 3600),
      user: null,
    };
    saveSession(session);
  }

  if (session || tokenHash) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('token_hash');
    cleanUrl.searchParams.delete('type');
    cleanUrl.hash = '';
    window.history.replaceState({}, document.title, cleanUrl.pathname + cleanUrl.search);
  }
  return session ? { session, type: type || 'invite' } : null;
}

export async function requestPasswordReset(email) {
  config();
  const redirect = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}?ops-live=1`
    : undefined;
  const suffix = redirect ? `?redirect_to=${encodeURIComponent(redirect)}` : '';
  return authRequest(`recover${suffix}`, { email: email.trim().toLowerCase() });
}

export async function changeAccountPassword(currentPassword, newPassword) {
  if (String(newPassword).length < 6 || String(newPassword).length > 72) {
    throw new Error('Password must contain 6 to 72 characters.');
  }
  const session = readSession();
  const email = session?.user?.email;
  if (!email) throw new Error('Your signed-in email could not be identified. Sign out and sign in again.');
  await signInWithEmail(email, currentPassword);
  return setAccountPassword(newPassword);
}

export async function setAccountPassword(password) {
  config();
  const token = await getAccessToken();
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return parseResponse(response);
}

export async function getAccessToken(forceRefresh = false) {
  config();
  const session = readSession();
  if (!session) throw new Error('Sign in is required.');
  const expiresAt = Number(session.expires_at || 0) * 1000;
  if (!forceRefresh && expiresAt - Date.now() > 60_000) return session.access_token;

  const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
  const next = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    token_type: refreshed.token_type,
    expires_at: refreshed.expires_at || Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600),
    user: refreshed.user || session.user,
  };
  saveSession(next);
  return next.access_token;
}

export async function signOut() {
  const session = readSession();
  try {
    if (session?.access_token && SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
      });
    }
  } finally {
    saveSession(null);
  }
}

export function getStoredSession() {
  return readSession();
}

export async function rpc(functionName, args = {}) {
  config();
  const token = await getAccessToken();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  return parseResponse(response);
}

export async function invoke(functionName, body = {}) {
  config();
  const token = await getAccessToken();
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export const operationsApi = {
  getMyContext: () => rpc('hhd_get_my_context'),
  listSites: () => rpc('hhd_list_sites'),
  getSiteWorkspace: (siteCode) => rpc('hhd_get_site_workspace', { p_site_code: siteCode }),
  listAllocations: (siteCode) => rpc('hhd_list_allocations', { p_site_code: siteCode }),
  listOffrollWorkers: (siteCode) => rpc('hhd_list_offroll_workers', { p_site_code: siteCode }),
  lookupOffrollWorker: (employeeId, siteCode) => rpc('hhd_lookup_offroll_worker', { p_employee_id: employeeId, p_site_code: siteCode }),
  getHrSyncRuns: (limit = 20) => rpc('hhd_get_hr_sync_runs', { p_limit: limit }),
  listMyDevices: () => rpc('hhd_list_my_devices'),
  listEmployees: (siteCode) => rpc('hhd_admin_list_onroll_employees', { p_site_code: siteCode }),
  listAllocatableEmployees: (siteCode) => rpc('hhd_list_allocatable_employees', { p_site_code: siteCode }),
  saveEmployee: (employee) => rpc('hhd_admin_upsert_onroll_employee', {
    p_employee_id: employee.employee_id,
    p_employee_name: employee.employee_name,
    p_site_code: employee.site_code,
    p_designation: employee.designation,
    p_process: employee.process || null,
    p_email: employee.email || null,
    p_status: employee.employment_status || 'active',
  }),
  listRolesAndPermissions: () => rpc('hhd_admin_list_roles_permissions'),
  listUsers: (siteCode = '*') => rpc('hhd_admin_list_users', { p_site_code: siteCode }),
  listAuditEvents: (siteCode = '*', limit = 100) => rpc('hhd_admin_list_audit_events', { p_site_code: siteCode, p_limit: limit }),
  listDeviceMovements: (siteCode, search = '', limit = 200) => rpc('hhd_list_device_movement_ledger', {
    p_site_code: siteCode, p_search: search || null, p_limit: limit,
  }),
  createAndDispatchSto: (fromSite, toSite, scans, notes) => rpc('hhd_sto_create_dispatch', {
    p_from_site_code: fromSite, p_to_site_code: toSite, p_scans: scans, p_notes: notes || null,
  }),
  receiveStoDevice: (stoId, scanValue, department, notes) => rpc('hhd_sto_receive_device', {
    p_sto_id: stoId, p_scan_value: scanValue, p_destination_department: department, p_notes: notes || null,
  }),
  listSto: (siteCode, limit = 100) => rpc('hhd_sto_list', { p_site_code: siteCode, p_limit: limit }),
  createRole: (role) => rpc('hhd_admin_create_role', {
    p_role_code: role.role_code,
    p_role_name: role.role_name,
    p_description: role.description || null,
    p_scope_type: role.scope_type || 'assigned_sites',
  }),
  setRolePermission: (grant) => rpc('hhd_admin_set_role_permission', {
    p_role_code: grant.role_code,
    p_permission_code: grant.permission_code,
    p_is_allowed: Boolean(grant.is_allowed),
    p_data_scope: grant.data_scope || 'assigned_sites',
  }),
  assignRole: (userId, roleCode, siteCode) => rpc('hhd_admin_assign_role', {
    p_user_id: userId, p_role_code: roleCode, p_site_code: siteCode,
  }),
  assignRoleSites: (userId, roleCode, siteCodes) => rpc('hhd_admin_assign_role_sites', {
    p_user_id: userId, p_role_code: roleCode, p_site_codes: siteCodes,
  }),
  revokeRole: (userId, roleCode, siteCode, reason) => rpc('hhd_admin_revoke_role', {
    p_user_id: userId, p_role_code: roleCode, p_site_code: siteCode, p_reason: reason,
  }),
  deactivateUser: (userId, reason) => rpc('hhd_admin_deactivate_user', { p_user_id: userId, p_reason: reason }),
  createUser: (user) => invoke('admin-manage-user', {
    action: 'create',
    email: user.email,
    password: user.password,
    login_id: user.login_id,
    employee_id: user.employee_id || null,
    full_name: user.full_name,
    role_code: user.role_code,
    site_code: user.site_code,
    site_codes: user.site_codes || [user.site_code],
    designation: user.designation || null,
    process: user.process || null,
  }),
  updateUser: (user) => invoke('admin-manage-user', {
    action: 'update',
    user_id: user.user_id,
    email: user.email,
    password: user.password || '',
    login_id: user.login_id,
    employee_id: user.employee_id || null,
    full_name: user.full_name,
    designation: user.designation || null,
    process: user.process || null,
  }),
  resetUserPassword: (userId, password) => invoke('admin-manage-user', {
    action: 'reset_password', user_id: userId, password,
  }),
  createOrAdjustAllocation: (allocation) => rpc('hhd_create_or_adjust_allocation', {
    p_site_code: allocation.site_code,
    p_employee_id: allocation.employee_id,
    p_process: allocation.process,
    p_authorized_quantity: Number(allocation.authorized_quantity),
    p_reason: allocation.reason || null,
    p_expected_version: allocation.expected_version ?? null,
  }),
  scanAssignDevice: (siteCode, allocationId, scanValue) => rpc('hhd_scan_assign_device', {
    p_site_code: siteCode, p_allocation_id: allocationId, p_scan_value: scanValue,
  }),
  returnAssignedDevice: (serial, physicalCondition, functionalCondition, notes) => rpc('hhd_return_assigned_device', {
    p_device_serial: serial,
    p_physical_condition: physicalCondition,
    p_functional_condition: functionalCondition,
    p_notes: notes || null,
  }),
  recordHotoTransfer: (row) => rpc('hhd_record_hoto_transfer', {
    p_device_serial: row.device_serial,
    p_offroll_employee_id: row.offroll_employee_id,
    p_shift_code: row.shift_code,
    p_shift_date: row.shift_date || new Date().toISOString().slice(0, 10),
    p_transaction_type: row.transaction_type || 'handover',
    p_notes: row.notes || null,
    p_physical_condition: row.physical_condition || 'good',
    p_functional_condition: row.functional_condition || 'working',
  }),
  returnHotoToPrimary: (row) => rpc('hhd_return_hoto_to_primary', {
    p_device_serial: row.device_serial,
    p_physical_condition: row.physical_condition,
    p_functional_condition: row.functional_condition,
    p_shift_code: row.shift_code,
    p_shift_date: row.shift_date || new Date().toISOString().slice(0, 10),
    p_notes: row.notes || null,
  }),
  listHotoTransactions: (siteCode, limit = 100) => rpc('hhd_list_hoto_transactions', { p_site_code: siteCode, p_limit: limit }),
  reconcileOpeningPositions: (rows, reason) => rpc('hhd_admin_reconcile_device_positions', { p_rows: rows, p_reason: reason }),
  reconcileOpeningPosition: (row) => rpc('hhd_admin_reconcile_device_position', {
    p_device_serial: row.device_serial,
    p_site_code: row.site_code,
    p_owner_department: row.owner_department,
    p_stock_state: row.stock_state,
    p_physical_condition: row.physical_condition,
    p_functional_condition: row.functional_condition,
    p_reason: row.reason,
  }),
};
