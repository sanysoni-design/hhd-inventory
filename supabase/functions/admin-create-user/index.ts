import { withSupabase } from 'npm:@supabase/server@^1';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export default {
  // User JWT is verified by @supabase/server. The browser publishable key is not a bearer token.
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
    const loginId = String(body.login_id ?? '').trim();
    const employeeId = String(body.employee_id ?? '').trim().toUpperCase() || null;
    const fullName = String(body.full_name ?? '').trim();
    const roleCode = String(body.role_code ?? '').trim();
    const siteCode = String(body.site_code ?? '').trim();
    const designation = String(body.designation ?? '').trim() || null;
    const process = String(body.process ?? '').trim() || null;

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'A valid work email is required for the login invitation' }, 400);
    if (!loginId || !fullName || !roleCode || !siteCode) return json({ error: 'Login ID, full name, role and site are required' }, 400);
    if (['operations_spoc', 'site_lead', 'assigned_employee'].includes(roleCode) && (!employeeId || !designation)) {
      return json({ error: 'Employee ID and designation are required for Operations accounts' }, 400);
    }
    if (roleCode !== 'admin' && siteCode === '*') return json({ error: 'Only the built-in Admin role can have global site scope' }, 400);

    const { data: allowed, error: permissionError } = await supabase.rpc('hhd_has_permission', {
      p_module_code: 'admin_users',
      p_action_code: 'create',
      p_site_code: siteCode,
    });
    if (permissionError) return json({ error: permissionError.message }, 403);
    if (allowed !== true) return json({ error: 'Forbidden: user creation permission required' }, 403);

    const { data: invited, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { login_id: loginId, employee_id: employeeId, full_name: fullName, role_code: roleCode, site_code: siteCode },
      ...(Deno.env.get('APP_INVITE_REDIRECT_URL') ? { redirectTo: Deno.env.get('APP_INVITE_REDIRECT_URL')! } : {}),
    });
    if (inviteError || !invited.user) {
      return json({ error: inviteError?.message ?? 'Unable to create invitation. Check Supabase Auth SMTP configuration.' }, 400);
    }

    const { data: profile, error: profileError } = await supabaseAdmin.rpc('hhd_admin_attach_new_user', {
      p_user_id: invited.user.id,
      p_login_id: loginId,
      p_employee_id: employeeId,
      p_full_name: fullName,
      p_email: email,
      p_role_code: roleCode,
      p_site_code: siteCode,
      p_designation: designation,
      p_process: process,
      p_created_by: userClaims.id,
    });

    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(invited.user.id);
      return json({ error: `Invitation rolled back because profile provisioning failed: ${profileError.message}` }, 400);
    }
    return json({ ok: true, user_id: invited.user.id, profile });
  }),
};
