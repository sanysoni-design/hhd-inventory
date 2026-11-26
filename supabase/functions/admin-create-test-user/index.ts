import { withSupabase } from 'npm:@supabase/server@^1';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

/**
 * Creates an isolated test-only application account without sending email.
 * Security controls:
 * - Requires a valid signed-in Admin JWT and admin_users.create at global scope.
 * - Only permits the four non-admin built-in roles.
 * - Only permits reserved example.com test addresses and TEST-prefixed IDs.
 * - Requires a strong password supplied by the Admin.
 * - Uses Auth Admin API server-side; no service key reaches the browser.
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

    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const loginId = String(body.login_id ?? '').trim().toUpperCase();
    const employeeId = String(body.employee_id ?? '').trim().toUpperCase() || null;
    const fullName = String(body.full_name ?? '').trim();
    const roleCode = String(body.role_code ?? '').trim();
    const siteCode = String(body.site_code ?? '').trim();
    const designation = String(body.designation ?? '').trim() || null;
    const process = String(body.process ?? '').trim() || null;

    const allowedRoles = new Set(['site_it', 'operations_spoc', 'site_lead', 'assigned_employee']);
    if (!allowedRoles.has(roleCode)) return json({ error: 'Test provisioning is limited to Site IT, Operations SPOC, Site Lead and Assigned Employee. Use the existing Admin account for Admin testing.' }, 400);
    if (!email || !/^\S+@example\.com$/.test(email)) return json({ error: 'Use a reserved test address ending in @example.com. No email will be sent.' }, 400);
    if (!/^TEST-[A-Z0-9_-]+$/.test(loginId)) return json({ error: 'Login ID must start with TEST-.' }, 400);
    if (!fullName.startsWith('[TEST] ')) return json({ error: 'Full name must start with [TEST] so the account is clearly identifiable.' }, 400);
    if (!siteCode || siteCode === '*') return json({ error: 'Select one approved site. Test accounts cannot have global site scope.' }, 400);
    if (password.length < 12) return json({ error: 'Temporary test password must contain at least 12 characters.' }, 400);
    if (password.length > 72) return json({ error: 'Password must not exceed 72 characters.' }, 400);
    if (roleCode !== 'site_it' && (!employeeId || !/^TEST-[A-Z0-9_-]+$/.test(employeeId) || !designation)) {
      return json({ error: 'Operations test accounts require a TEST-prefixed Employee ID and designation.' }, 400);
    }

    const { data: allowed, error: permissionError } = await supabase.rpc('hhd_has_permission', {
      p_module_code: 'admin_users',
      p_action_code: 'create',
      p_site_code: '*',
    });
    if (permissionError) return json({ error: permissionError.message }, 403);
    if (allowed !== true) return json({ error: 'Forbidden: only a globally scoped Admin can create test accounts.' }, 403);

    const { data: siteRow, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('Site')
      .eq('Site', siteCode)
      .maybeSingle();
    if (siteError) return json({ error: siteError.message }, 400);
    if (!siteRow) return json({ error: `Unknown approved site: ${siteCode}` }, 400);

    const { data: roleRow, error: roleError } = await supabaseAdmin
      .from('app_roles')
      .select('role_code,is_active')
      .eq('role_code', roleCode)
      .eq('is_active', true)
      .maybeSingle();
    if (roleError) return json({ error: roleError.message }, 400);
    if (!roleRow) return json({ error: 'Selected system role is not active.' }, 400);

    // Auth Admin createUser does not send a confirmation email. We explicitly confirm
    // the reserved test identity and set the password supplied by the Admin.
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        login_id: loginId,
        employee_id: employeeId,
        role_code: roleCode,
        site_code: siteCode,
        hhd_test_account: true,
      },
    });
    if (createError || !created.user) return json({ error: createError?.message ?? 'Unable to create test Auth account.' }, 400);

    const actorId = userClaims.id;
    const { data: profile, error: profileError } = await supabaseAdmin.rpc('hhd_admin_attach_new_user', {
      p_user_id: created.user.id,
      p_login_id: loginId,
      p_employee_id: employeeId,
      p_full_name: fullName,
      p_email: email,
      p_role_code: roleCode,
      p_site_code: siteCode,
      p_designation: designation,
      p_process: process,
      p_created_by: actorId,
    });

    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      return json({ error: `Test Auth account rolled back because application profile provisioning failed: ${profileError.message}` }, 400);
    }

    // hhd_admin_attach_new_user intentionally creates invited users. For this
    // no-email test-only route, activate the already-confirmed Auth identity.
    const { data: activated, error: activationError } = await supabaseAdmin
      .from('app_users')
      .update({ account_status: 'active', updated_at: new Date().toISOString() })
      .eq('user_id', created.user.id)
      .select('user_id,account_status')
      .single();

    if (activationError || !activated) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      if (employeeId && roleCode !== 'site_it') {
        await supabaseAdmin.from('onroll_employee_master')
          .delete()
          .eq('employee_id', employeeId)
          .eq('source', 'admin_managed')
          .is('linked_user_id', null);
      }
      return json({ error: `Test account activation failed and Auth user was rolled back: ${activationError?.message ?? 'Profile activation returned no row'}` }, 400);
    }

    await supabaseAdmin.from('admin_audit_events').insert({
      actor_user_id: actorId,
      action_code: 'admin_users.create_test',
      entity_type: 'app_user',
      entity_id: created.user.id,
      site_code: siteCode,
      after_data: {
        login_id: loginId,
        employee_id: employeeId,
        email,
        role_code: roleCode,
        account_status: 'active',
        test_account: true,
        email_sent: false,
      },
      reason: 'Temporary HHD Phase 1 role acceptance testing. TEST-prefixed identity; no email sent.',
    });

    return json({
      ok: true,
      test_account: true,
      email_sent: false,
      user_id: created.user.id,
      profile: {
        ...profile,
        account_status: 'active',
        email,
        test_account: true,
      },
      message: 'Test account created and activated without sending email.',
    });
  }),
};
