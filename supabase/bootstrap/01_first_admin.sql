-- HHD Operations Phase 1 — first Admin bootstrap
-- Run only after:
--   1) The foundation migration has completed successfully.
--   2) You created the first user in Supabase Auth and marked its email as confirmed.
-- Replace the placeholder email below before running.
-- This script does not create an Auth identity or set a password.

do $$
declare
  v_email text := lower(trim('REPLACE_WITH_FIRST_ADMIN_EMAIL'));
  v_user_id uuid;
  v_name text;
begin
  if v_email = '' or v_email = 'replace_with_first_admin_email' then
    raise exception 'Replace REPLACE_WITH_FIRST_ADMIN_EMAIL before running this bootstrap.';
  end if;

  select id,
         coalesce(nullif(raw_user_meta_data->>'full_name',''), nullif(raw_user_meta_data->>'name',''), email)
    into v_user_id, v_name
  from auth.users
  where lower(email) = v_email
    and email_confirmed_at is not null
  order by created_at asc
  limit 1;

  if v_user_id is null then
    raise exception 'No confirmed Supabase Auth user found for %. Create/confirm the Auth user first.', v_email;
  end if;

  if not exists (select 1 from public.app_roles where role_code='admin' and is_active and scope_type='all_sites') then
    raise exception 'Built-in Admin role is missing. Confirm the Phase 1 migration completed.';
  end if;

  insert into public.app_users(user_id, login_id, full_name, email, account_status, created_by, updated_at)
  values(v_user_id, v_email, v_name, v_email, 'active', v_user_id, now())
  on conflict(user_id) do update
    set login_id=excluded.login_id,
        full_name=excluded.full_name,
        email=excluded.email,
        account_status='active',
        updated_at=now();

  insert into public.user_role_assignments(user_id, role_code, site_code, is_active, assigned_by)
  values(v_user_id, 'admin', '*', true, v_user_id)
  on conflict(user_id, role_code, site_code) do update
    set is_active=true, valid_until=null, assigned_by=v_user_id;

  insert into public.admin_audit_events(actor_user_id, action_code, entity_type, entity_id, site_code, after_data, reason)
  values(v_user_id, 'admin.bootstrap', 'app_user', v_user_id::text, '*',
         jsonb_build_object('email', v_email, 'role_code', 'admin', 'site_scope', '*'),
         'First HHD Operations administrator bootstrap');
end $$;

-- Verify the resulting account. Expected: account_status=active, role_code=admin, site_code=*.
select au.login_id, au.email, au.account_status, ura.role_code, ura.site_code, ura.is_active
from public.app_users au
join public.user_role_assignments ura on ura.user_id=au.user_id
where lower(au.email)=lower('REPLACE_WITH_FIRST_ADMIN_EMAIL')
  and ura.role_code='admin';
