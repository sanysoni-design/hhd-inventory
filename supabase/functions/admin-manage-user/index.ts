import { withSupabase } from 'npm:@supabase/server@^1';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72;
const OPERATIONS_ROLES = new Set(['operations_spoc', 'site_lead', 'assigned_employee']);

function clean(value: unknown) {
  return String(value ?? '').trim();
}
function cleanEmail(value: unknown) {
  return clean(value).toLowerCase();
}
function cleanSites(value: unknown, fallback: unknown) {
  const source = Array.isArray(value) ? value : [fallback];
  return [...new Set(source.map((item) => clean(item)).filter(Boolean))];
}

/**
 * Admin-managed identities. User creation is confirmed directly through Auth Admin
 * and does not send an invitation or notification email. Passwords are never
 * written to application tables, audit rows, logs, or returned to the browser.
 */
export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const { supabase, supabaseAdmin, userClaims } = ctx;
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Request body must be valid JSON' }, 400);
    }

    const action = clean(body.action || 'create');
    if (!['create', 'update', 'reset_password'].includes(action)) {
      return json({ error: 'Unsupported account action' }, 400);
    }

    const requiredAction = action === 'create' ? 'create' : 'update';
    const { data: allowed, error: permissionError } = await supabase.rpc('hhd_has_permission', {
      p_module_code: 'admin_users',
      p_action_code: requiredAction,
      p_site_code: '*',
    });
    if (permissionError) return json({ error: permissionError.message }, 403);
    if (allowed !== true) return json({ error: 'Forbidden: globally scoped Admin access is required' }, 403);

    const userId = clean(body.user_id);
    const password = String(body.password ?? '');
    if (action === 'reset_password') {
      if (!userId) return json({ error: 'User ID is required' }, 400);
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return json({ error: 'Password must contain 6 to 72 characters' }, 400);
      }
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      const { error: auditError } = await supabaseAdmin.from('admin_audit_events').insert({
        actor_user_id: userClaims.id,
        action_code: 'admin_users.reset_password',
        entity_type: 'app_user',
        entity_id: userId,
        after_data: { password_reset: true, reset_by_admin: true },
        reason: 'Password reset by authorized Admin. Password value is intentionally not stored.',
      });
      if (auditError) return json({ error: `Password was reset but audit logging failed: ${auditError.message}` }, 500);
      return json({ ok: true, user_id: userId, password_reset: true });
    }

    const email = cleanEmail(body.email);
    const loginId = clean(body.login_id);
    const employeeId = clean(body.employee_id).toUpperCase() || null;
    const fullName = clean(body.full_name);
    const designation = clean(body.designation) || null;
    const process = clean(body.process) || null;

    if (!EMAIL_RE.test(email)) return json({ error: 'A valid work email is required' }, 400);
    if (!loginId || !fullName) return json({ error: 'Full name and Login ID are required' }, 400);
    if (password && (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH)) {
      return json({ error: 'Password must contain 6 to 72 characters' }, 400);
    }

    if (action === 'create') {
      const roleCode = clean(body.role_code);
      const siteCodes = cleanSites(body.site_codes, body.site_code);
      if (!roleCode || !siteCodes.length) return json({ error: 'Role and at least one site are required' }, 400);
      if (roleCode === 'assigned_employee' && siteCodes.length > 1) return json({ error: 'Custodian accounts are tied to one On-roll Employee Master site. Assign a single site.' }, 400);
      if (!password) return json({ error: 'Set an initial password for the new account' }, 400);
      if (OPERATIONS_ROLES.has(roleCode) && (!employeeId || !designation)) {
        return json({ error: 'Employee ID and designation are required for this Operations role' }, 400);
      }
      if (roleCode === 'admin') {
        if (siteCodes.length !== 1 || siteCodes[0] !== '*') return json({ error: 'Admin accounts must use the All sites scope' }, 400);
      } else if (siteCodes.includes('*')) {
        return json({ error: 'Only the Admin role may be assigned All sites scope' }, 400);
      }

      const { data: roleRow, error: roleError } = await supabaseAdmin
        .from('app_roles').select('role_code,is_active').eq('role_code', roleCode).eq('is_active', true).maybeSingle();
      if (roleError) return json({ error: roleError.message }, 400);
      if (!roleRow) return json({ error: 'Selected role is not active' }, 400);

      if (!siteCodes.includes('*')) {
        for (const siteCode of siteCodes) {
          const { data: siteRow, error: siteError } = await supabaseAdmin
            .from('sites').select('Site').eq('Site', siteCode).maybeSingle();
          if (siteError) return json({ error: siteError.message }, 400);
          if (!siteRow) return json({ error: `Unknown site: ${siteCode}` }, 400);
        }
      }

      const { data: duplicateEmail } = await supabaseAdmin
        .from('app_users').select('user_id').eq('email', email).maybeSingle();
      if (duplicateEmail) return json({ error: 'This email is already linked to an application account' }, 409);
      const { data: duplicateLogin } = await supabaseAdmin
        .from('app_users').select('user_id').ilike('login_id', loginId).maybeSingle();
      if (duplicateLogin) return json({ error: 'This Login ID is already in use' }, 409);

      const primarySite = siteCodes[0];
      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
          login_id: loginId,
          employee_id: employeeId,
          role_code: roleCode,
          site_code: primarySite,
        },
      });
      if (createError || !created.user) return json({ error: createError?.message ?? 'Unable to create Auth account' }, 400);

      const { data: profile, error: profileError } = await supabaseAdmin.rpc('hhd_admin_attach_new_user', {
        p_user_id: created.user.id,
        p_login_id: loginId,
        p_employee_id: employeeId,
        p_full_name: fullName,
        p_email: email,
        p_role_code: roleCode,
        p_site_code: primarySite,
        p_designation: designation,
        p_process: process,
        p_created_by: userClaims.id,
      });
      if (profileError) {
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return json({ error: `Account creation rolled back: ${profileError.message}` }, 400);
      }

      const { error: activateError } = await supabaseAdmin.from('app_users')
        .update({ account_status: 'active', updated_at: new Date().toISOString() })
        .eq('user_id', created.user.id);
      if (activateError) {
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return json({ error: `Account activation failed and Auth user was rolled back: ${activateError.message}` }, 400);
      }

      const additionalSites = siteCodes.slice(1);
      if (additionalSites.length) {
        const rows = additionalSites.map((siteCode) => ({
          user_id: created.user.id,
          role_code: roleCode,
          site_code: siteCode,
          is_active: true,
          assigned_by: userClaims.id,
        }));
        const { error: assignmentError } = await supabaseAdmin.from('user_role_assignments').insert(rows);
        if (assignmentError) {
          await supabaseAdmin.auth.admin.deleteUser(created.user.id);
          return json({ error: `Multi-site assignment failed; account creation was rolled back: ${assignmentError.message}` }, 400);
        }
      }

      const { error: auditError } = await supabaseAdmin.from('admin_audit_events').insert({
        actor_user_id: userClaims.id,
        action_code: 'admin_users.create',
        entity_type: 'app_user',
        entity_id: created.user.id,
        site_code: primarySite,
        after_data: {
          login_id: loginId,
          employee_id: employeeId,
          full_name: fullName,
          email,
          role_code: roleCode,
          site_codes: siteCodes,
          account_status: 'active',
          email_sent: false,
        },
        reason: 'Account created and email confirmed directly by Admin. No email sent.',
      });
      if (auditError) {
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return json({ error: `Audit logging failed; account creation was rolled back: ${auditError.message}` }, 500);
      }

      return json({
        ok: true,
        user_id: created.user.id,
        email_sent: false,
        profile: { ...profile, account_status: 'active', email, site_codes: siteCodes },
      });
    }

    if (!userId) return json({ error: 'User ID is required for account updates' }, 400);
    const { data: before, error: beforeError } = await supabaseAdmin
      .from('app_users')
      .select('user_id,login_id,employee_id,full_name,email,designation,process,account_status')
      .eq('user_id', userId).maybeSingle();
    if (beforeError) return json({ error: beforeError.message }, 400);
    if (!before) return json({ error: 'Application user not found' }, 404);

    const { data: currentRoles, error: rolesError } = await supabaseAdmin
      .from('user_role_assignments').select('role_code').eq('user_id', userId).eq('is_active', true);
    if (rolesError) return json({ error: rolesError.message }, 400);
    const roleCodes = new Set((currentRoles || []).map((row: { role_code: string }) => row.role_code));
    if ([...roleCodes].some((role) => OPERATIONS_ROLES.has(role)) && (!employeeId || !designation)) {
      return json({ error: 'Employee ID and designation are required while an Operations role is assigned' }, 400);
    }

    const { data: duplicateEmail } = await supabaseAdmin
      .from('app_users').select('user_id').eq('email', email).neq('user_id', userId).maybeSingle();
    if (duplicateEmail) return json({ error: 'This email is already linked to another application account' }, 409);
    const { data: duplicateLogin } = await supabaseAdmin
      .from('app_users').select('user_id').ilike('login_id', loginId).neq('user_id', userId).maybeSingle();
    if (duplicateLogin) return json({ error: 'This Login ID is already in use' }, 409);

    if (before.employee_id !== employeeId) {
      if (before.employee_id) {
        const [{ data: activeAssignments }, { data: activeAllocations }] = await Promise.all([
          supabaseAdmin.from('device_assignments').select('id').eq('employee_id', before.employee_id).eq('status', 'active').limit(1),
          supabaseAdmin.from('allocation_entitlements').select('id').eq('employee_id', before.employee_id).eq('status', 'active').limit(1),
        ]);
        if (activeAssignments?.length || activeAllocations?.length) {
          return json({ error: 'Employee ID cannot be changed while active HHD assignments or allocations exist. Close or reassign them first.' }, 409);
        }
      }
      if (employeeId) {
        const { data: employeeRow, error: employeeError } = await supabaseAdmin
          .from('onroll_employee_master')
          .select('employee_id,linked_user_id,employment_status')
          .eq('employee_id', employeeId).maybeSingle();
        if (employeeError) return json({ error: employeeError.message }, 400);
        if (!employeeRow || employeeRow.employment_status !== 'active') {
          return json({ error: 'The new Employee ID must exist as an active on-roll employee master record first' }, 400);
        }
        if (employeeRow.linked_user_id && employeeRow.linked_user_id !== userId) {
          return json({ error: 'The new Employee ID is already linked to another application account' }, 409);
        }
      }
    }

    const patch = {
      login_id: loginId,
      employee_id: employeeId,
      full_name: fullName,
      email,
      designation,
      process,
      updated_at: new Date().toISOString(),
    };
    const { error: appUpdateError } = await supabaseAdmin.from('app_users').update(patch).eq('user_id', userId);
    if (appUpdateError) return json({ error: appUpdateError.message }, 400);

    const authPatch: Record<string, unknown> = {
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName, login_id: loginId, employee_id: employeeId },
    };
    if (password) authPatch.password = password;
    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(userId, authPatch);
    if (authUpdateError) {
      await supabaseAdmin.from('app_users').update({
        login_id: before.login_id,
        employee_id: before.employee_id,
        full_name: before.full_name,
        email: before.email,
        designation: before.designation,
        process: before.process,
      }).eq('user_id', userId);
      return json({ error: authUpdateError.message }, 400);
    }

    if (before.employee_id && before.employee_id !== employeeId) {
      await supabaseAdmin.from('onroll_employee_master').update({ linked_user_id: null, updated_at: new Date().toISOString() })
        .eq('employee_id', before.employee_id).eq('linked_user_id', userId);
    }
    if (employeeId) {
      await supabaseAdmin.from('onroll_employee_master').update({
        linked_user_id: userId,
        employee_name: fullName,
        email,
        designation,
        process,
        updated_at: new Date().toISOString(),
      }).eq('employee_id', employeeId);
    }

    const { error: auditError } = await supabaseAdmin.from('admin_audit_events').insert({
      actor_user_id: userClaims.id,
      action_code: password ? 'admin_users.update_and_reset_password' : 'admin_users.update',
      entity_type: 'app_user',
      entity_id: userId,
      before_data: before,
      after_data: { ...patch, password_reset: Boolean(password) },
      reason: password ? 'Application account details updated and password reset by Admin. Password value is not stored.' : 'Application account details updated by Admin.',
    });
    if (auditError) return json({ error: `Account updated but audit logging failed: ${auditError.message}` }, 500);
    return json({ ok: true, user_id: userId, updated: true, password_reset: Boolean(password) });
  }),
};
