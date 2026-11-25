-- HHD Operations Foundation v0.2
-- Additive migration. Does not alter or delete the legacy public.users/custom-token login,
-- existing devices/tickets/custody records, or historical logs.
-- Apply only after taking a fresh database backup and reviewing the live schema.

begin;

-- -----------------------------------------------------------------------------
-- 1. Application identities, roles and permission catalogue
-- -----------------------------------------------------------------------------
create table if not exists public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login_id text not null,
  employee_id text,
  full_name text not null,
  email text not null,
  department text,
  designation text,
  process text,
  account_status text not null default 'invited'
    check (account_status in ('invited','active','suspended','deactivated')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists app_users_login_id_uq on public.app_users (lower(login_id));
create unique index if not exists app_users_employee_id_uq on public.app_users (upper(employee_id)) where employee_id is not null;
create index if not exists app_users_status_idx on public.app_users (account_status, created_at desc);

create table if not exists public.app_roles (
  role_code text primary key,
  role_name text not null,
  description text,
  scope_type text not null default 'assigned_sites'
    check (scope_type in ('all_sites','assigned_sites','own_records')),
  is_system_role boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_permissions (
  permission_code text primary key,
  module_code text not null,
  module_name text not null,
  action_code text not null,
  action_name text not null,
  description text,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  unique (module_code, action_code)
);

create table if not exists public.role_permissions (
  role_code text not null references public.app_roles(role_code) on delete cascade,
  permission_code text not null references public.app_permissions(permission_code) on delete cascade,
  is_allowed boolean not null default false,
  data_scope text not null default 'assigned_sites'
    check (data_scope in ('own','assigned_sites','all_sites')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (role_code, permission_code)
);

create table if not exists public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  role_code text not null references public.app_roles(role_code) on delete restrict,
  site_code text not null,
  is_active boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (site_code = '*' or length(trim(site_code)) > 0),
  check (valid_until is null or valid_until > valid_from),
  unique (user_id, role_code, site_code)
);
create index if not exists user_role_assignments_user_idx on public.user_role_assignments (user_id, is_active);
create index if not exists user_role_assignments_site_idx on public.user_role_assignments (site_code, role_code) where is_active;

-- -----------------------------------------------------------------------------
-- 2. Employee and HR-owned off-roll worker masters
-- -----------------------------------------------------------------------------
create table if not exists public.onroll_employee_master (
  employee_id text primary key,
  employee_name text not null,
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  designation text not null,
  process text,
  email text,
  employment_status text not null default 'active'
    check (employment_status in ('active','inactive','on_leave','exited')),
  linked_user_id uuid unique references public.app_users(user_id) on delete set null,
  source text not null default 'admin_managed',
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists onroll_employee_site_status_idx on public.onroll_employee_master (site_code, employment_status);
create index if not exists onroll_employee_name_idx on public.onroll_employee_master (lower(employee_name));

create table if not exists public.offroll_worker_master (
  employee_id text primary key,
  worker_type text not null check (worker_type in ('TL','GC')),
  employee_name text not null,
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  process text,
  employment_status text not null check (employment_status in ('active','inactive')),
  source text not null default 'HR_GOOGLE_SHEET' check (source = 'HR_GOOGLE_SHEET'),
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  source_row_hash text,
  updated_at timestamptz not null default now()
);
create index if not exists offroll_worker_site_status_idx on public.offroll_worker_master (site_code, employment_status, worker_type);
create index if not exists offroll_worker_name_idx on public.offroll_worker_master (lower(employee_name));

create table if not exists public.hr_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'HR_GOOGLE_SHEET',
  status text not null check (status in ('running','success','partial','failed')),
  received_rows integer not null default 0,
  inserted_rows integer not null default 0,
  updated_rows integer not null default 0,
  deactivated_rows integer not null default 0,
  error_count integer not null default 0,
  snapshot_complete boolean not null default false,
  checksum text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  initiated_by text,
  message text,
  errors jsonb not null default '[]'::jsonb
);
create index if not exists hr_sync_runs_started_idx on public.hr_sync_runs (started_at desc);

-- -----------------------------------------------------------------------------
-- 3. Operational inventory position, quantity allocation and IMEI assignment
-- -----------------------------------------------------------------------------
create table if not exists public.device_stock_positions (
  device_serial text primary key references public.devices("Serial") on update cascade on delete restrict,
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  owner_department text not null check (owner_department in ('superstore','it','operations','in_transit','vendor')),
  stock_state text not null check (stock_state in ('available','assigned','in_transit','quarantined','maintenance','lost','retired')),
  physical_condition text not null default 'unknown' check (physical_condition in ('good','damaged','unknown')),
  functional_condition text not null default 'unknown' check (functional_condition in ('working','not_working','unknown')),
  current_holder_employee_id text,
  current_holder_type text check (current_holder_type in ('onroll','offroll')),
  location_code text,
  last_reference_type text,
  last_reference_id text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((stock_state = 'assigned' and current_holder_employee_id is not null and current_holder_type is not null) or (stock_state <> 'assigned' and current_holder_type is null))
);
create index if not exists device_stock_site_owner_state_idx on public.device_stock_positions (site_code, owner_department, stock_state);
create index if not exists device_stock_conditions_idx on public.device_stock_positions (site_code, physical_condition, functional_condition);
create index if not exists device_stock_holder_idx on public.device_stock_positions (current_holder_employee_id) where current_holder_employee_id is not null;

create table if not exists public.allocation_entitlements (
  id uuid primary key default gen_random_uuid(),
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  employee_id text not null references public.onroll_employee_master(employee_id) on update cascade on delete restrict,
  process text not null,
  designation_snapshot text not null,
  authorized_quantity integer not null check (authorized_quantity > 0),
  status text not null default 'active' check (status in ('active','cancelled','closed','suspended')),
  reason text,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index if not exists allocation_one_active_employee_process_uq
  on public.allocation_entitlements (site_code, employee_id, lower(process)) where status = 'active';
create index if not exists allocation_site_status_idx on public.allocation_entitlements (site_code, status, updated_at desc);
create index if not exists allocation_employee_idx on public.allocation_entitlements (employee_id, status);

create table if not exists public.device_assignments (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references public.allocation_entitlements(id) on delete restrict,
  device_serial text not null references public.devices("Serial") on update cascade on delete restrict,
  employee_id text not null references public.onroll_employee_master(employee_id) on update cascade on delete restrict,
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  status text not null default 'active' check (status in ('active','returned','cancelled')),
  assigned_by uuid not null references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  returned_by uuid references auth.users(id) on delete set null,
  returned_at timestamptz,
  return_physical_condition text check (return_physical_condition in ('good','damaged')),
  return_functional_condition text check (return_functional_condition in ('working','not_working')),
  return_notes text,
  check ((status = 'active' and returned_at is null) or (status <> 'active' and returned_at is not null))
);
create unique index if not exists device_assignment_one_active_serial_uq on public.device_assignments (device_serial) where status = 'active';
create index if not exists device_assignments_employee_status_idx on public.device_assignments (employee_id, status, assigned_at desc);
create index if not exists device_assignments_allocation_idx on public.device_assignments (allocation_id, status);

create table if not exists public.allocation_events (
  id bigint generated always as identity primary key,
  allocation_id uuid not null references public.allocation_entitlements(id) on delete restrict,
  event_type text not null check (event_type in ('created','quantity_increased','quantity_reduced','cancelled','suspended','reopened')),
  old_quantity integer,
  new_quantity integer,
  collected_quantity_at_event integer not null default 0,
  reason text not null,
  performed_by uuid not null references auth.users(id) on delete restrict,
  performed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists allocation_events_allocation_idx on public.allocation_events (allocation_id, performed_at desc);

create table if not exists public.device_movement_ledger (
  id bigint generated always as identity primary key,
  device_serial text not null references public.devices("Serial") on update cascade on delete restrict,
  event_type text not null,
  from_department text,
  to_department text,
  from_holder_type text,
  from_holder_id text,
  to_holder_type text,
  to_holder_id text,
  site_code text,
  reference_type text,
  reference_id text,
  physical_condition text,
  functional_condition text,
  notes text,
  performed_by uuid references auth.users(id) on delete set null,
  performed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists device_movement_serial_time_idx on public.device_movement_ledger (device_serial, performed_at desc);
create index if not exists device_movement_site_time_idx on public.device_movement_ledger (site_code, performed_at desc);

-- A primary on-roll employee assignment remains intact while an off-roll TL/GC temporarily holds the HHD for a shift.
create table if not exists public.hoto_transactions (
  id uuid primary key default gen_random_uuid(),
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  device_serial text not null references public.devices("Serial") on update cascade on delete restrict,
  primary_assignment_id uuid not null references public.device_assignments(id) on delete restrict,
  shift_date date not null default current_date,
  shift_code text not null check (shift_code in ('A','B','C')),
  transaction_type text not null check (transaction_type in ('handover','takeover','mid_shift_swap','return_to_primary')),
  from_holder_type text not null check (from_holder_type in ('onroll','offroll')),
  from_holder_employee_id text not null,
  to_holder_type text not null check (to_holder_type in ('onroll','offroll')),
  to_holder_employee_id text not null,
  offroll_worker_type text check (offroll_worker_type in ('TL','GC')),
  physical_condition text not null check (physical_condition in ('good','damaged')),
  functional_condition text not null check (functional_condition in ('working','not_working')),
  notes text,
  performed_by uuid not null references auth.users(id) on delete restrict,
  performed_at timestamptz not null default now()
);
create index if not exists hoto_site_shift_time_idx on public.hoto_transactions (site_code, shift_date desc, shift_code, performed_at desc);
create index if not exists hoto_device_time_idx on public.hoto_transactions (device_serial, performed_at desc);
create index if not exists hoto_target_worker_idx on public.hoto_transactions (to_holder_employee_id, performed_at desc);

create table if not exists public.admin_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action_code text not null,
  entity_type text not null,
  entity_id text,
  site_code text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_entity_idx on public.admin_audit_events (entity_type, entity_id, created_at desc);
create index if not exists admin_audit_actor_idx on public.admin_audit_events (actor_user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. Seed system roles and fine-grained permission catalogue
-- -----------------------------------------------------------------------------
insert into public.app_roles (role_code, role_name, description, scope_type, is_system_role)
values
 ('admin','Administrator','Cross-site administration and system governance.','all_sites',true),
 ('site_it','Site IT','Site-scoped IT inventory and STO operations.','assigned_sites',true),
 ('operations_spoc','Operations SPOC','Site stock receipt, distribution operations, HOTO and returns.','assigned_sites',true),
 ('site_lead','Site Lead','Employee-wise quantity allocation authority; no IMEI selection.','assigned_sites',true),
 ('assigned_employee','Assigned Employee','Personal device collection and own assignment visibility.','own_records',true)
on conflict (role_code) do update set role_name=excluded.role_name, description=excluded.description, scope_type=excluded.scope_type, is_system_role=true, is_active=true, updated_at=now();

insert into public.app_permissions (permission_code,module_code,module_name,action_code,action_name,description,sort_order)
values
 ('dashboard.view','dashboard','Dashboard','view','View','View role-scoped dashboard.',10),
 ('inventory.view','inventory','Inventory','view','View','View site-scoped stock and device states.',20),
 ('inventory.export','inventory','Inventory','export','Export','Export permitted inventory views.',21),
 ('sto.view','sto','Stock Transfer Orders','view','View','View incoming and outgoing STOs.',30),
 ('sto.create','sto','Stock Transfer Orders','create','Create','Create an STO within authorized source/destination rules.',31),
 ('sto.dispatch','sto','Stock Transfer Orders','dispatch','Dispatch','Confirm dispatch of STO device lines.',32),
 ('sto.receive','sto','Stock Transfer Orders','receive','Receive','Scan and acknowledge physically received STO lines.',33),
 ('distribution.view','distribution','Distribution','view','View','View allocations and collection progress.',40),
 ('distribution.create','distribution','Distribution','create','Create allocation','Create quantity-only employee entitlement.',41),
 ('distribution.update','distribution','Distribution','update','Adjust allocation','Increase/reduce quantity with reconciliation and reason.',42),
 ('distribution.receive_return','distribution','Distribution','receive_return','Receive returned device','Receive an on-roll employee device return into Operations stock.',44),
 ('inventory.reconcile','inventory','Inventory','reconcile','Reconcile opening stock','Reconcile an existing device into the operational stock-position ledger.',22),
 ('distribution.cancel','distribution','Distribution','cancel','Cancel allocation','Cancel an allocation subject to device reconciliation.',43),
 ('employee_collection.view','employee_collection','Employee Device Collection','view','View own devices','View own allocation and assigned devices.',50),
 ('employee_collection.scan_assign','employee_collection','Employee Device Collection','scan_assign','Scan and assign','Map an available IMEI/serial to the signed-in employee.',51),
 ('employee_collection.return','employee_collection','Employee Device Collection','return','Return device','Return a primary-assigned device to Operations.',52),
 ('hoto.view','hoto','HOTO','view','View HOTO','View authorized shift handover/takeover history.',60),
 ('hoto.create','hoto','HOTO','create','Create HOTO','Create an authorized TL/GC shift handover.',61),
 ('hoto.acknowledge','hoto','HOTO','acknowledge','Acknowledge HOTO','Acknowledge a shift takeover.',62),
 ('hoto.swap','hoto','HOTO','swap','Mid-shift swap','Perform an authorized same-site swap.',63),
 ('offroll_workers.view','offroll_workers','TL/GC HR Master','view','View HR master','View HR-synchronized off-roll worker identities.',70),
 ('offroll_workers.sync','offroll_workers','TL/GC HR Master','sync','Sync HR master','Trigger or review HR synchronization.',71),
 ('admin_users.view','admin_users','User & ID Management','view','View users','View application accounts.',80),
 ('admin_users.create','admin_users','User & ID Management','create','Create user','Create and invite application users.',81),
 ('admin_users.update','admin_users','User & ID Management','update','Update user','Update account attributes and assignments.',82),
 ('admin_users.deactivate','admin_users','User & ID Management','deactivate','Deactivate user','Suspend/deactivate application access.',83),
 ('admin_roles.view','admin_roles','Role & Permission Management','view','View roles','View roles and permission grants.',90),
 ('admin_roles.create','admin_roles','Role & Permission Management','create','Create role','Create a custom role.',91),
 ('admin_roles.update','admin_roles','Role & Permission Management','update','Update role','Update role metadata.',92),
 ('admin_roles.manage_permissions','admin_roles','Role & Permission Management','manage_permissions','Manage permissions','Grant/revoke module and action permissions.',93),
 ('admin_employees.view','admin_employees','On-roll Employee Master','view','View employees','View on-roll employee records.',100),
 ('admin_employees.create','admin_employees','On-roll Employee Master','create','Create employee','Create an on-roll employee record.',101),
 ('admin_employees.update','admin_employees','On-roll Employee Master','update','Update employee','Update on-roll employee details/status.',102),
 ('admin_audit.view','admin_audit','Audit & Activity','view','View audit','View permission, identity and device audit events.',110),
 ('admin_audit.export','admin_audit','Audit & Activity','export','Export audit','Export permitted audit records.',111)
on conflict (permission_code) do update set module_code=excluded.module_code,module_name=excluded.module_name,action_code=excluded.action_code,action_name=excluded.action_name,description=excluded.description,sort_order=excluded.sort_order,is_active=true;

-- Admin receives every permission. Other system roles receive only their defined baseline.
insert into public.role_permissions (role_code,permission_code,is_allowed,data_scope)
select 'admin', permission_code, true, 'all_sites' from public.app_permissions
on conflict (role_code,permission_code) do update set is_allowed=true,data_scope='all_sites',updated_at=now();

insert into public.role_permissions (role_code,permission_code,is_allowed,data_scope)
select 'site_it', permission_code, true, 'assigned_sites'
from public.app_permissions where permission_code in (
 'dashboard.view','inventory.view','inventory.export','sto.view','sto.create','sto.dispatch','sto.receive','admin_audit.view'
)
on conflict (role_code,permission_code) do update set is_allowed=true,data_scope='assigned_sites',updated_at=now();

insert into public.role_permissions (role_code,permission_code,is_allowed,data_scope)
select 'operations_spoc', permission_code, true, 'assigned_sites'
from public.app_permissions where permission_code in (
 'dashboard.view','inventory.view','inventory.export','inventory.reconcile','sto.view','sto.receive','sto.create','sto.dispatch',
 'distribution.view','distribution.receive_return','hoto.view','hoto.create','hoto.acknowledge','hoto.swap','offroll_workers.view','admin_audit.view'
)
on conflict (role_code,permission_code) do update set is_allowed=true,data_scope='assigned_sites',updated_at=now();

insert into public.role_permissions (role_code,permission_code,is_allowed,data_scope)
select 'site_lead', permission_code, true, 'assigned_sites'
from public.app_permissions where permission_code in (
 'dashboard.view','inventory.view','distribution.view','distribution.create','distribution.update','distribution.cancel','admin_employees.view'
)
on conflict (role_code,permission_code) do update set is_allowed=true,data_scope='assigned_sites',updated_at=now();

insert into public.role_permissions (role_code,permission_code,is_allowed,data_scope)
select 'assigned_employee', permission_code, true, 'own'
from public.app_permissions where permission_code in (
 'dashboard.view','employee_collection.view','employee_collection.scan_assign','employee_collection.return'
)
on conflict (role_code,permission_code) do update set is_allowed=true,data_scope='own',updated_at=now();

-- -----------------------------------------------------------------------------
-- 5. Authorization helper and read APIs
-- -----------------------------------------------------------------------------
create or replace function public.hhd_permission_scope(p_module_code text,p_action_code text,p_site_code text)
returns text
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  -- Effective scope is the narrowest of the user assignment, role ceiling and permission grant.
  -- A site-scoped user can never become global merely because a permission row says all_sites.
  select case max(least(
      case
        when ura.site_code='*' and ar.scope_type='all_sites' then 3
        when ar.scope_type='own_records' then 1
        else 2
      end,
      case rp.data_scope when 'all_sites' then 3 when 'assigned_sites' then 2 else 1 end
    ))
    when 3 then 'all_sites' when 2 then 'assigned_sites' when 1 then 'own' else null end
  from public.app_users au
  join public.user_role_assignments ura on ura.user_id=au.user_id and ura.is_active and (ura.valid_until is null or ura.valid_until>now())
  join public.app_roles ar on ar.role_code=ura.role_code and ar.is_active
  join public.role_permissions rp on rp.role_code=ar.role_code and rp.is_allowed
  join public.app_permissions ap on ap.permission_code=rp.permission_code and ap.is_active
  where au.user_id=auth.uid() and au.account_status='active'
    and ap.module_code=p_module_code and ap.action_code=p_action_code
    and (ura.site_code='*' or lower(trim(ura.site_code))=lower(trim(coalesce(p_site_code,''))))
    and (p_site_code is not null or ura.site_code='*');
$$;

create or replace function public.hhd_has_permission(p_module_code text, p_action_code text, p_site_code text)
returns boolean
language sql stable security definer
set search_path = public, auth, pg_temp
as $$
  select public.hhd_permission_scope(p_module_code,p_action_code,p_site_code) is not null;
$$;

create or replace function public.hhd_list_sites()
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('site_code',s."Site") order by s."Site"),'[]'::jsonb) into v_rows
  from public.sites s where public.hhd_has_permission('dashboard','view',s."Site");
  return v_rows;
end;
$$;

create or replace function public.hhd_get_my_context()
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_user jsonb; v_roles jsonb; v_permissions jsonb;
begin
  select to_jsonb(au) into v_user from public.app_users au where au.user_id=auth.uid() and au.account_status='active';
  if v_user is null then raise exception 'Application account is missing, inactive or not activated'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('role_code',ura.role_code,'role_name',ar.role_name,'site_code',ura.site_code,'scope_type',ar.scope_type)), '[]'::jsonb)
    into v_roles
    from public.user_role_assignments ura join public.app_roles ar on ar.role_code=ura.role_code
    where ura.user_id=auth.uid() and ura.is_active and ar.is_active and (ura.valid_until is null or ura.valid_until>now());
  select coalesce(jsonb_agg(jsonb_build_object('module_code',ap.module_code,'action_code',ap.action_code,'permission_code',ap.permission_code,'data_scope',rp.data_scope,'site_code',ura.site_code,'role_code',ura.role_code)), '[]'::jsonb)
    into v_permissions
    from public.user_role_assignments ura join public.role_permissions rp on rp.role_code=ura.role_code and rp.is_allowed
    join public.app_permissions ap on ap.permission_code=rp.permission_code and ap.is_active
    join public.app_roles ar on ar.role_code=ura.role_code and ar.is_active
    where ura.user_id=auth.uid() and ura.is_active and (ura.valid_until is null or ura.valid_until>now());
  return jsonb_build_object('user',v_user,'role_assignments',v_roles,'permissions',v_permissions);
end;
$$;

create or replace function public.hhd_get_site_workspace(p_site_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_stock jsonb; v_allocations jsonb; v_summary jsonb; v_inventory_scope text; v_distribution_scope text; v_employee_id text;
begin
  if not public.hhd_has_permission('dashboard','view',p_site_code) then raise exception 'Forbidden: dashboard access denied for this site'; end if;
  v_inventory_scope := public.hhd_permission_scope('inventory','view',p_site_code);
  v_distribution_scope := public.hhd_permission_scope('distribution','view',p_site_code);
  select employee_id into v_employee_id from public.app_users where user_id=auth.uid() and account_status='active';
  if v_inventory_scope is not null and v_inventory_scope<>'own' then
    select jsonb_build_object(
      'available',count(*) filter (where owner_department='operations' and stock_state='available' and physical_condition='good' and functional_condition='working'),
      'assigned',count(*) filter (where owner_department='operations' and stock_state='assigned'),
      'quarantined',count(*) filter (where stock_state in ('quarantined','maintenance')),
      'lost',count(*) filter (where stock_state='lost')
    ) into v_summary from public.device_stock_positions where site_code=p_site_code;
  else
    select jsonb_build_object('available',0,'assigned',count(*) filter (where da.status='active'),'quarantined',0,'lost',0)
      into v_summary from public.device_assignments da where da.site_code=p_site_code and da.employee_id=(select employee_id from public.app_users where user_id=auth.uid());
  end if;
  if v_distribution_scope is not null or public.hhd_has_permission('employee_collection','view',p_site_code) then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]'::jsonb) into v_allocations
    from (
      select a.id,a.site_code,a.employee_id,e.employee_name,e.designation,a.process,a.authorized_quantity,
        (count(da.id) filter (where da.status='active'))::integer as collected_quantity,
        greatest(a.authorized_quantity-(count(da.id) filter (where da.status='active'))::integer,0)::integer as pending_quantity,
        a.status,a.reason,a.created_at,a.updated_at
      from public.allocation_entitlements a
      join public.onroll_employee_master e on e.employee_id=a.employee_id
      left join public.device_assignments da on da.allocation_id=a.id
      where a.site_code=p_site_code and (coalesce(v_distribution_scope,'own')<>'own' or a.employee_id=v_employee_id)
      group by a.id,e.employee_name,e.designation
      order by a.updated_at desc limit 250
    ) x;
  else
    v_allocations := '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('serial',d."Serial",'imei',d.imei_number,'make',d."Make",'model',d."Model",'physical_condition',p.physical_condition,'functional_condition',p.functional_condition,'stock_state',p.stock_state,'holder_employee_id',p.current_holder_employee_id,'holder_type',p.current_holder_type) order by d."Serial"), '[]'::jsonb)
    into v_stock
    from public.device_stock_positions p join public.devices d on d."Serial"=p.device_serial
    where p.site_code=p_site_code and v_inventory_scope is not null
      and (v_inventory_scope<>'own' or (p.current_holder_type='onroll' and p.current_holder_employee_id=v_employee_id));
  return jsonb_build_object('site_code',p_site_code,'summary',coalesce(v_summary,'{}'::jsonb),'allocations',v_allocations,'devices',coalesce(v_stock,'[]'::jsonb),'generated_at',now());
end;
$$;

create or replace function public.hhd_admin_list_roles_permissions()
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_roles jsonb; v_permissions jsonb; v_grants jsonb;
begin
  if not public.hhd_has_permission('admin_roles','view','*') then raise exception 'Forbidden: role administration required'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.is_system_role desc,r.role_name),'[]'::jsonb) into v_roles from public.app_roles r where r.is_active;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.sort_order,p.module_code,p.action_code),'[]'::jsonb) into v_permissions from public.app_permissions p where p.is_active;
  select coalesce(jsonb_agg(jsonb_build_object('role_code',rp.role_code,'permission_code',rp.permission_code,'is_allowed',rp.is_allowed,'data_scope',rp.data_scope)),'[]'::jsonb) into v_grants from public.role_permissions rp;
  return jsonb_build_object('roles',v_roles,'permissions',v_permissions,'role_permissions',v_grants);
end;
$$;

create or replace function public.hhd_admin_create_role(p_role_code text,p_role_name text,p_description text,p_scope_type text default 'assigned_sites')
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_code text;
begin
  if not public.hhd_has_permission('admin_roles','create','*') then raise exception 'Forbidden: role creation requires Admin access'; end if;
  v_code := lower(regexp_replace(trim(coalesce(p_role_code,'')),'[^a-zA-Z0-9]+','_','g'));
  if v_code='' or length(v_code)>60 then raise exception 'Invalid role code'; end if;
  if lower(trim(coalesce(p_role_name,'')))='' then raise exception 'Role name is required'; end if;
  if p_scope_type not in ('assigned_sites','own_records') then raise exception 'Custom roles must use assigned-site or own-record scope; global scope is reserved for Admin assignments'; end if;
  insert into public.app_roles(role_code,role_name,description,scope_type,is_system_role,created_by)
  values(v_code,trim(p_role_name),nullif(trim(p_description),''),p_scope_type,false,auth.uid());
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,after_data)
  values(auth.uid(),'admin_roles.create','role',v_code,jsonb_build_object('role_name',trim(p_role_name),'scope_type',p_scope_type));
  return jsonb_build_object('role_code',v_code,'role_name',trim(p_role_name),'scope_type',p_scope_type);
end;
$$;

create or replace function public.hhd_admin_set_role_permission(p_role_code text,p_permission_code text,p_is_allowed boolean,p_data_scope text default 'assigned_sites')
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_before jsonb;
begin
  if not public.hhd_has_permission('admin_roles','manage_permissions','*') then raise exception 'Forbidden: permission administration required'; end if;
  if p_data_scope not in ('own','assigned_sites','all_sites') then raise exception 'Invalid data scope'; end if;
  if p_role_code='admin' and p_is_allowed=false then raise exception 'Built-in Admin permissions cannot be disabled'; end if;
  if not exists(select 1 from public.app_roles where role_code=p_role_code and is_active) then raise exception 'Role not found'; end if;
  if not exists(select 1 from public.app_permissions where permission_code=p_permission_code and is_active) then raise exception 'Permission not found'; end if;
  select to_jsonb(rp) into v_before from public.role_permissions rp where rp.role_code=p_role_code and rp.permission_code=p_permission_code;
  insert into public.role_permissions(role_code,permission_code,is_allowed,data_scope,updated_by,updated_at)
  values(p_role_code,p_permission_code,p_is_allowed,p_data_scope,auth.uid(),now())
  on conflict(role_code,permission_code) do update set is_allowed=excluded.is_allowed,data_scope=excluded.data_scope,updated_by=auth.uid(),updated_at=now();
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,before_data,after_data)
  values(auth.uid(),'admin_roles.manage_permissions','role_permission',p_role_code||':'||p_permission_code,v_before,jsonb_build_object('is_allowed',p_is_allowed,'data_scope',p_data_scope));
  return jsonb_build_object('role_code',p_role_code,'permission_code',p_permission_code,'is_allowed',p_is_allowed,'data_scope',p_data_scope);
end;
$$;

create or replace function public.hhd_admin_upsert_onroll_employee(
  p_employee_id text,p_employee_name text,p_site_code text,p_designation text,p_process text default null,p_email text default null,p_status text default 'active'
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_id text; v_before jsonb;
begin
  v_id := upper(trim(coalesce(p_employee_id,'')));
  if v_id='' or trim(coalesce(p_employee_name,''))='' or trim(coalesce(p_designation,''))='' then raise exception 'Employee ID, name and designation are required'; end if;
  if p_status not in ('active','inactive','on_leave','exited') then raise exception 'Invalid employment status'; end if;
  if not exists(select 1 from public.sites where "Site"=p_site_code) then raise exception 'Unknown site'; end if;
  if exists(select 1 from public.onroll_employee_master where employee_id=v_id) then
    if not public.hhd_has_permission('admin_employees','update',p_site_code) then raise exception 'Forbidden: employee update permission required'; end if;
  else
    if not public.hhd_has_permission('admin_employees','create',p_site_code) then raise exception 'Forbidden: employee creation permission required'; end if;
  end if;
  select to_jsonb(e) into v_before from public.onroll_employee_master e where employee_id=v_id;
  if v_before is not null and v_before->>'site_code' is distinct from p_site_code and (
    exists(select 1 from public.device_assignments da where da.employee_id=v_id and da.status='active')
    or exists(select 1 from public.allocation_entitlements a where a.employee_id=v_id and a.status='active')
  ) then
    raise exception 'Employee site cannot be changed while active HHD assignments or allocation entitlements exist. Reconcile devices and close allocations first';
  end if;
  if p_status <> 'active' and exists(select 1 from public.device_assignments da where da.employee_id=v_id and da.status='active') then
    raise exception 'Employee status cannot be changed while HHDs remain assigned. Collect and return all devices first';
  end if;
  if p_status <> 'active' then
    insert into public.allocation_events(allocation_id,event_type,old_quantity,new_quantity,collected_quantity_at_event,reason,performed_by,metadata)
    select a.id,'cancelled',a.authorized_quantity,a.authorized_quantity,0,'Employee status changed to '||p_status||'; uncollected entitlement closed',auth.uid(),jsonb_build_object('employee_id',v_id,'site_code',a.site_code)
    from public.allocation_entitlements a where a.employee_id=v_id and a.status='active';
    update public.allocation_entitlements set status='cancelled',updated_by=auth.uid(),updated_at=now(),version=version+1
    where employee_id=v_id and status='active';
  end if;
  insert into public.onroll_employee_master(employee_id,employee_name,site_code,designation,process,email,employment_status,source_updated_at,updated_at)
  values(v_id,trim(p_employee_name),p_site_code,trim(p_designation),nullif(trim(p_process),''),nullif(lower(trim(p_email)),''),p_status,now(),now())
  on conflict(employee_id) do update set employee_name=excluded.employee_name,site_code=excluded.site_code,designation=excluded.designation,process=excluded.process,email=excluded.email,employment_status=excluded.employment_status,source_updated_at=excluded.source_updated_at,updated_at=now();
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data)
  values(auth.uid(),'admin_employees.upsert','onroll_employee',v_id,p_site_code,v_before,jsonb_build_object('employee_name',trim(p_employee_name),'site_code',p_site_code,'designation',trim(p_designation),'process',p_process,'employment_status',p_status));
  return jsonb_build_object('employee_id',v_id,'employee_name',trim(p_employee_name),'site_code',p_site_code,'designation',trim(p_designation),'process',p_process,'employment_status',p_status);
end;
$$;

create or replace function public.hhd_admin_list_onroll_employees(p_site_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb; v_scope text; v_employee text;
begin
  v_scope := coalesce(public.hhd_permission_scope('admin_employees','view',p_site_code),public.hhd_permission_scope('distribution','view',p_site_code));
  if v_scope is null then raise exception 'Forbidden: employee master access denied'; end if;
  select employee_id into v_employee from public.app_users where user_id=auth.uid();
  select coalesce(jsonb_agg(to_jsonb(e) order by e.employee_name),'[]'::jsonb) into v_rows
  from public.onroll_employee_master e where e.site_code=p_site_code and e.employment_status='active'
    and (v_scope<>'own' or e.employee_id=v_employee);
  return v_rows;
end;
$$;

create or replace function public.hhd_list_offroll_workers(p_site_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb;
begin
  if not public.hhd_has_permission('offroll_workers','view',p_site_code) and not public.hhd_has_permission('hoto','view',p_site_code) then
    raise exception 'Forbidden: TL/GC HR master access denied';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('employee_id',w.employee_id,'worker_type',w.worker_type,'employee_name',w.employee_name,'site_code',w.site_code,'process',w.process,'employment_status',w.employment_status,'last_synced_at',w.last_synced_at) order by w.employee_name),'[]'::jsonb)
  into v_rows from public.offroll_worker_master w where w.site_code=p_site_code;
  return v_rows;
end;
$$;

create or replace function public.hhd_lookup_offroll_worker(p_employee_id text,p_site_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_worker public.offroll_worker_master%rowtype;
begin
  if not public.hhd_has_permission('hoto','create',p_site_code) then raise exception 'Forbidden: HOTO worker validation is not permitted'; end if;
  select * into v_worker from public.offroll_worker_master
  where upper(employee_id)=upper(trim(p_employee_id)) and site_code=p_site_code and employment_status='active';
  if not found then raise exception 'TL/GC ID is not active in the HR master for this site'; end if;
  return jsonb_build_object('employee_id',v_worker.employee_id,'worker_type',v_worker.worker_type,'employee_name',v_worker.employee_name,'site_code',v_worker.site_code,'process',v_worker.process,'employment_status',v_worker.employment_status,'last_synced_at',v_worker.last_synced_at);
end;
$$;

create or replace function public.hhd_get_hr_sync_runs(p_limit integer default 20)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb;
begin
  if not public.hhd_has_permission('offroll_workers','sync','*') then raise exception 'Forbidden: HR sync monitoring requires Admin access'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc),'[]'::jsonb) into v_rows
  from (select * from public.hr_sync_runs order by started_at desc limit greatest(1,least(coalesce(p_limit,20),100))) r;
  return v_rows;
end;
$$;

create or replace function public.hhd_list_my_devices()
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_employee_id text; v_site_code text; v_rows jsonb;
begin
  select e.employee_id,e.site_code into v_employee_id,v_site_code
  from public.app_users u join public.onroll_employee_master e on e.employee_id=u.employee_id and e.linked_user_id=u.user_id
  where u.user_id=auth.uid() and u.account_status='active' and e.employment_status='active';
  if v_employee_id is null then raise exception 'Application account is not linked to an active on-roll Employee ID'; end if;
  if v_site_code is null or not public.hhd_has_permission('employee_collection','view',v_site_code) then raise exception 'Forbidden: own device access required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('assignment_id',da.id,'serial',d."Serial",'imei',d.imei_number,'make',d."Make",'model',d."Model",'assigned_at',da.assigned_at,'current_holder_type',p.current_holder_type,'current_holder_employee_id',p.current_holder_employee_id,'stock_state',p.stock_state,'physical_condition',p.physical_condition,'functional_condition',p.functional_condition) order by da.assigned_at desc),'[]'::jsonb)
  into v_rows from public.device_assignments da join public.devices d on d."Serial"=da.device_serial join public.device_stock_positions p on p.device_serial=da.device_serial
  where da.employee_id=v_employee_id and da.status='active';
  return v_rows;
end;
$$;

create or replace function public.hhd_list_allocations(p_site_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb; v_employee text; v_scope text;
begin
  v_scope := public.hhd_permission_scope('distribution','view',p_site_code);
  if v_scope is null and not public.hhd_has_permission('employee_collection','view',p_site_code) then raise exception 'Forbidden: allocation access denied'; end if;
  select employee_id into v_employee from public.app_users where user_id=auth.uid();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]'::jsonb) into v_rows
  from (
    select a.id,a.site_code,a.employee_id,e.employee_name,e.designation,a.process,a.authorized_quantity,
      (count(da.id) filter (where da.status='active'))::integer as collected_quantity,
      greatest(a.authorized_quantity-(count(da.id) filter (where da.status='active'))::integer,0) as pending_quantity,
      a.status,a.reason,a.created_at,a.updated_at,a.version
    from public.allocation_entitlements a
    join public.onroll_employee_master e on e.employee_id=a.employee_id
    left join public.device_assignments da on da.allocation_id=a.id
    where a.site_code=p_site_code and (coalesce(v_scope,'own')<>'own' or a.employee_id=v_employee)
    group by a.id,e.employee_name,e.designation
  ) x;
  return v_rows;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Quantity allocation transaction. No IMEI is selected or reserved here.
-- -----------------------------------------------------------------------------
create or replace function public.hhd_create_or_adjust_allocation(
  p_site_code text,p_employee_id text,p_process text,p_authorized_quantity integer,p_reason text default null,p_expected_version integer default null
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_employee public.onroll_employee_master%rowtype; v_alloc public.allocation_entitlements%rowtype;
  v_exists boolean := false; v_collected integer := 0; v_available integer := 0; v_reserved_other integer := 0;
  v_old integer; v_event text; v_reason text := trim(coalesce(p_reason,''));
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_site_code is null or trim(p_site_code)='' then raise exception 'Site is required'; end if;
  if p_process is null or trim(p_process)='' then raise exception 'Process is required'; end if;
  if p_authorized_quantity is null or p_authorized_quantity < 1 then raise exception 'Quantity must be a positive whole number'; end if;
  if not public.hhd_has_permission('distribution','view',p_site_code) then raise exception 'Forbidden: site allocation access denied'; end if;

  -- Serialize allocation reservations per site to prevent two concurrent allocations consuming the same stock.
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_site_code)), 71023));

  select * into v_employee from public.onroll_employee_master
  where upper(employee_id)=upper(trim(p_employee_id)) and site_code=p_site_code and employment_status='active' for update;
  if not found then raise exception 'Employee is not active at this site'; end if;
  if regexp_replace(lower(trim(v_employee.designation)),'[^a-z]','','g') not in ('lead','srlead','seniorlead','am') then
    raise exception 'Quantity allocation is limited to on-roll Lead, Sr. Lead and AM employees';
  end if;
  if v_employee.linked_user_id is null or not exists(select 1 from public.app_users u where u.user_id=v_employee.linked_user_id and u.account_status='active') then
    raise exception 'Employee must have an active individual application login before receiving a device allocation';
  end if;

  select * into v_alloc from public.allocation_entitlements
  where site_code=p_site_code and employee_id=v_employee.employee_id and lower(process)=lower(trim(p_process)) and status='active'
  for update;
  v_exists := found;
  if v_exists then
    if not public.hhd_has_permission('distribution','update',p_site_code) then raise exception 'Forbidden: allocation adjustment permission required'; end if;
    if p_expected_version is not null and p_expected_version <> v_alloc.version then raise exception 'Allocation changed since it was opened. Refresh and retry'; end if;
    v_old := v_alloc.authorized_quantity;
    if p_authorized_quantity=v_old then raise exception 'Allocation quantity is unchanged'; end if;
    select count(*)::integer into v_collected from public.device_assignments where allocation_id=v_alloc.id and status='active';
    if p_authorized_quantity < v_collected then raise exception 'Cannot reduce below % active assigned device(s). Reconcile physical returns first, then submit the reduction with a reason',v_collected; end if;
    if p_authorized_quantity < v_old and v_reason='' then raise exception 'A reason is mandatory for reducing an allocation'; end if;
  else
    if not public.hhd_has_permission('distribution','create',p_site_code) then raise exception 'Forbidden: allocation creation permission required'; end if;
    v_old := null;
    v_collected := 0;
  end if;

  select count(*)::integer into v_available from public.device_stock_positions
  where site_code=p_site_code and owner_department='operations' and stock_state='available'
    and physical_condition='good' and functional_condition='working';

  select coalesce(sum(greatest(a.authorized_quantity-coalesce(c.collected,0),0)),0)::integer into v_reserved_other
  from public.allocation_entitlements a
  left join lateral (select count(*)::integer as collected from public.device_assignments da where da.allocation_id=a.id and da.status='active') c on true
  where a.site_code=p_site_code and a.status='active' and (not v_exists or a.id<>v_alloc.id);

  if (p_authorized_quantity-v_collected) > greatest(v_available-v_reserved_other,0) then
    raise exception 'Insufficient unreserved working stock. Available stock: %, already reserved for other employees: %, current employee has collected: %',v_available,v_reserved_other,v_collected;
  end if;

  if v_exists then
    update public.allocation_entitlements set authorized_quantity=p_authorized_quantity,reason=case when v_reason<>'' then v_reason else reason end,
      updated_by=v_actor,updated_at=now(),version=version+1
    where id=v_alloc.id returning * into v_alloc;
    v_event := case when p_authorized_quantity < v_old then 'quantity_reduced' when p_authorized_quantity > v_old then 'quantity_increased' else 'quantity_increased' end;
  else
    insert into public.allocation_entitlements(site_code,employee_id,process,designation_snapshot,authorized_quantity,status,reason,created_by,updated_by)
    values(p_site_code,v_employee.employee_id,trim(p_process),v_employee.designation,p_authorized_quantity,'active',nullif(v_reason,''),v_actor,v_actor)
    returning * into v_alloc;
    v_event := 'created';
  end if;

  insert into public.allocation_events(allocation_id,event_type,old_quantity,new_quantity,collected_quantity_at_event,reason,performed_by,metadata)
  values(v_alloc.id,v_event,v_old,p_authorized_quantity,v_collected,coalesce(nullif(v_reason,''),case when v_event='created' then 'Initial quantity allocation' else 'Quantity adjusted without reduction' end),v_actor,
    jsonb_build_object('site_code',p_site_code,'employee_id',v_employee.employee_id,'process',trim(p_process),'designation',v_employee.designation));
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data,reason)
  values(v_actor,'distribution.'||v_event,'allocation',v_alloc.id::text,p_site_code,
    case when v_old is null then null else jsonb_build_object('authorized_quantity',v_old,'collected_quantity',v_collected) end,
    jsonb_build_object('authorized_quantity',p_authorized_quantity,'collected_quantity',v_collected),coalesce(nullif(v_reason,''),'Allocation created/updated'));

  return jsonb_build_object('allocation_id',v_alloc.id,'site_code',v_alloc.site_code,'employee_id',v_alloc.employee_id,'process',v_alloc.process,
    'designation',v_alloc.designation_snapshot,'authorized_quantity',v_alloc.authorized_quantity,'collected_quantity',v_collected,
    'pending_quantity',greatest(v_alloc.authorized_quantity-v_collected,0),'status',v_alloc.status,'version',v_alloc.version,'event',v_event);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Assigned employee scans and maps a real device IMEI/serial.
-- -----------------------------------------------------------------------------
create or replace function public.hhd_scan_assign_device(p_site_code text,p_allocation_id uuid,p_scan_value text)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_employee_id text; v_alloc public.allocation_entitlements%rowtype;
  v_serial text; v_match_count integer; v_pos public.device_stock_positions%rowtype;
  v_collected integer; v_assignment uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not public.hhd_has_permission('employee_collection','scan_assign',p_site_code) then raise exception 'Forbidden: employee device collection access denied'; end if;
  select e.employee_id into v_employee_id
  from public.app_users u join public.onroll_employee_master e on e.employee_id=u.employee_id and e.linked_user_id=u.user_id
  where u.user_id=v_actor and u.account_status='active' and e.employment_status='active' and e.site_code=p_site_code;
  if v_employee_id is null then raise exception 'Your active application account is not linked to an active on-roll Employee ID at this site'; end if;
  if trim(coalesce(p_scan_value,''))='' then raise exception 'Scan an IMEI or asset serial'; end if;
  if p_site_code is null or trim(p_site_code)='' then raise exception 'Site is required'; end if;
  -- Use the same per-site lock as allocation creation/adjustment to avoid a stock reservation race.
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_site_code)), 71023));

  select * into v_alloc from public.allocation_entitlements
  where id=p_allocation_id and site_code=p_site_code and employee_id=v_employee_id and status='active' for update;
  if not found then raise exception 'No active allocation found for your Employee ID at this site'; end if;

  select count(*)::integer into v_collected from public.device_assignments where allocation_id=v_alloc.id and status='active';
  if v_collected >= v_alloc.authorized_quantity then raise exception 'Authorized quantity already collected. Request a Site Lead allocation adjustment'; end if;

  -- Serial is the primary asset key. IMEI is not unique in the legacy schema, so ambiguous IMEIs are rejected.
  select d."Serial" into v_serial from public.devices d where upper(d."Serial")=upper(trim(p_scan_value)) limit 1;
  if v_serial is null then
    select count(*)::integer into v_match_count from public.devices d where d.imei_number=trim(p_scan_value);
    if v_match_count=0 then raise exception 'Device IMEI/serial not found'; end if;
    if v_match_count>1 then raise exception 'IMEI is mapped to multiple device records. Use the unique asset serial or resolve the duplicate master records'; end if;
    select d."Serial" into v_serial from public.devices d where d.imei_number=trim(p_scan_value) limit 1;
  end if;

  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found then raise exception 'Device stock position is not reconciled. Ask Operations SPOC to reconcile this asset before collection'; end if;
  if v_pos.site_code<>p_site_code or v_pos.owner_department<>'operations' or v_pos.stock_state<>'available'
     or v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
    raise exception 'Device is not eligible. Current position: site %, owner %, state %, physical %, functional %',v_pos.site_code,v_pos.owner_department,v_pos.stock_state,v_pos.physical_condition,v_pos.functional_condition;
  end if;
  if exists(select 1 from public.device_assignments where device_serial=v_serial and status='active') then raise exception 'Device already has an active employee assignment'; end if;

  insert into public.device_assignments(allocation_id,device_serial,employee_id,site_code,status,assigned_by)
  values(v_alloc.id,v_serial,v_employee_id,p_site_code,'active',v_actor) returning id into v_assignment;
  update public.device_stock_positions set stock_state='assigned',current_holder_employee_id=v_employee_id,current_holder_type='onroll',updated_by=v_actor,updated_at=now(),last_reference_type='device_assignment',last_reference_id=v_assignment::text
  where device_serial=v_serial;
  insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,reference_type,reference_id,physical_condition,functional_condition,performed_by)
  values(v_serial,'employee_device_assigned','operations','operations','operations_stock',p_site_code,'onroll_employee',v_employee_id,p_site_code,'device_assignment',v_assignment::text,'good','working',v_actor);
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data)
  values(v_actor,'employee_collection.scan_assign','device_assignment',v_assignment::text,p_site_code,jsonb_build_object('serial',v_serial,'allocation_id',v_alloc.id,'employee_id',v_employee_id));
  return jsonb_build_object('assignment_id',v_assignment,'serial',v_serial,'employee_id',v_employee_id,'allocation_id',v_alloc.id,'collected_quantity',v_collected+1,'authorized_quantity',v_alloc.authorized_quantity,'pending_quantity',greatest(v_alloc.authorized_quantity-v_collected-1,0));
end;
$$;

create or replace function public.hhd_return_assigned_device(
  p_device_serial text,p_physical_condition text,p_functional_condition text,p_notes text default null
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_assignment public.device_assignments%rowtype; v_pos public.device_stock_positions%rowtype; v_site text; v_employee_id text; v_new_state text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if coalesce(p_physical_condition,'') not in ('good','damaged') or coalesce(p_functional_condition,'') not in ('working','not_working') then raise exception 'Select both physical and functional condition'; end if;
  select employee_id into v_employee_id from public.app_users where user_id=v_actor and account_status='active';
  select * into v_assignment from public.device_assignments where device_serial=trim(p_device_serial) and status='active' for update;
  if not found then raise exception 'No active employee assignment exists for this device'; end if;
  v_site := v_assignment.site_code;
  select * into v_pos from public.device_stock_positions where device_serial=v_assignment.device_serial for update;
  if not found then raise exception 'Device stock position is missing; reconcile before return'; end if;
  if v_pos.current_holder_type<>'onroll' or v_pos.current_holder_employee_id<>v_assignment.employee_id then raise exception 'Device is currently held in a shift HOTO or other custody state. Collect/reconcile the current holder before ending the primary assignment'; end if;
  if v_assignment.employee_id<>v_employee_id
     and not (public.hhd_has_permission('distribution','update',v_site) or public.hhd_has_permission('distribution','receive_return',v_site)) then
    raise exception 'Forbidden: only the assigned employee or authorized Operations role can return this device';
  end if;
  if v_assignment.employee_id=v_employee_id then
    if not public.hhd_has_permission('employee_collection','return',v_site) then raise exception 'Forbidden: device return not permitted'; end if;
  elsif not public.hhd_has_permission('distribution','receive_return',v_site) then
    raise exception 'Forbidden: Operations return permission required';
  end if;
  v_new_state := case when p_physical_condition='good' and p_functional_condition='working' then 'available' else 'quarantined' end;
  update public.device_assignments set status='returned',returned_by=v_actor,returned_at=now(),return_physical_condition=p_physical_condition,return_functional_condition=p_functional_condition,return_notes=nullif(trim(p_notes),'') where id=v_assignment.id;
  update public.device_stock_positions set stock_state=v_new_state,physical_condition=p_physical_condition,functional_condition=p_functional_condition,current_holder_employee_id=null,current_holder_type=null,updated_by=v_actor,updated_at=now(),last_reference_type='device_assignment_return',last_reference_id=v_assignment.id::text where device_serial=v_assignment.device_serial;
  insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,reference_type,reference_id,physical_condition,functional_condition,notes,performed_by)
  values(v_assignment.device_serial,'employee_device_returned','operations','operations','onroll_employee',v_assignment.employee_id,'operations_stock',v_site,v_site,'device_assignment',v_assignment.id::text,p_physical_condition,p_functional_condition,p_notes,v_actor);
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
  values(v_actor,'employee_collection.return','device_assignment',v_assignment.id::text,v_site,jsonb_build_object('serial',v_assignment.device_serial,'new_stock_state',v_new_state,'physical_condition',p_physical_condition,'functional_condition',p_functional_condition),coalesce(nullif(trim(p_notes),''),'Employee device returned'));
  return jsonb_build_object('assignment_id',v_assignment.id,'serial',v_assignment.device_serial,'stock_state',v_new_state,'site_code',v_site);
end;
$$;

-- Bulk opening stock reconciliation for a controlled, audited site pilot.
create or replace function public.hhd_admin_reconcile_device_positions(p_rows jsonb,p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_row jsonb; v_serial text; v_site text; v_owner text; v_state text; v_physical text; v_functional text; v_count integer := 0; v_errors jsonb := '[]'::jsonb; v_before jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(jsonb_typeof(p_rows),'')<>'array' or jsonb_array_length(p_rows)=0 then raise exception 'A non-empty rows array is required'; end if;
  if jsonb_array_length(p_rows)>1000 then raise exception 'Opening reconciliation batch is limited to 1,000 rows'; end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Reconciliation reason is mandatory'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) as x(value) group by upper(trim(x.value->>'device_serial')) having count(*)>1) then raise exception 'Duplicate asset serial in reconciliation batch'; end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_serial := trim(coalesce(v_row->>'device_serial','')); v_site := trim(coalesce(v_row->>'site_code',''));
    v_owner := lower(trim(coalesce(v_row->>'owner_department',''))); v_state := lower(trim(coalesce(v_row->>'stock_state','')));
    v_physical := lower(trim(coalesce(v_row->>'physical_condition',''))); v_functional := lower(trim(coalesce(v_row->>'functional_condition','')));
    if v_serial='' or v_site='' then raise exception 'Every row requires device_serial and site_code'; end if;
    if public.hhd_permission_scope('inventory','reconcile',v_site) is null or public.hhd_permission_scope('inventory','reconcile',v_site)='own' then raise exception 'Forbidden: reconciliation access denied for site %',v_site; end if;
    if not exists(select 1 from public.devices where "Serial"=v_serial) then raise exception 'Unknown asset serial: %',v_serial; end if;
    if exists(select 1 from public.device_assignments where device_serial=v_serial and status='active') then raise exception 'Asset % has an active assignment; reconcile HOTO/return first',v_serial; end if;
    if not exists(select 1 from public.sites where "Site"=v_site) then raise exception 'Unknown site: %',v_site; end if;
    if v_owner not in ('superstore','it','operations','in_transit','vendor') then raise exception 'Invalid owner department for %',v_serial; end if;
    if v_state not in ('available','in_transit','quarantined','maintenance','lost','retired') then raise exception 'Invalid stock state for %',v_serial; end if;
    if v_physical not in ('good','damaged','unknown') or v_functional not in ('working','not_working','unknown') then raise exception 'Invalid condition for %',v_serial; end if;
    select to_jsonb(p) into v_before from public.device_stock_positions p where device_serial=v_serial for update;
    insert into public.device_stock_positions(device_serial,site_code,owner_department,stock_state,physical_condition,functional_condition,updated_by,updated_at,last_reference_type)
    values(v_serial,v_site,v_owner,v_state,v_physical,v_functional,auth.uid(),now(),'opening_reconciliation')
    on conflict(device_serial) do update set site_code=excluded.site_code,owner_department=excluded.owner_department,stock_state=excluded.stock_state,physical_condition=excluded.physical_condition,functional_condition=excluded.functional_condition,current_holder_employee_id=null,current_holder_type=null,updated_by=auth.uid(),updated_at=now(),last_reference_type='opening_reconciliation',last_reference_id=null;
    insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,site_code,reference_type,physical_condition,functional_condition,notes,performed_by,metadata)
    values(v_serial,'opening_stock_reconciliation',coalesce(v_before->>'owner_department','unknown'),v_owner,v_site,'opening_reconciliation',v_physical,v_functional,p_reason,auth.uid(),jsonb_build_object('previous_position',v_before));
    insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data,reason)
    values(auth.uid(),'inventory.reconcile','device_stock_position',v_serial,v_site,v_before,jsonb_build_object('owner_department',v_owner,'stock_state',v_state,'physical_condition',v_physical,'functional_condition',v_functional),p_reason);
    v_count := v_count+1;
  end loop;
  return jsonb_build_object('reconciled_count',v_count,'reason',p_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7A. Shift HOTO: primary on-roll assignment is retained; TL/GC is the temporary holder.
-- -----------------------------------------------------------------------------
create or replace function public.hhd_record_hoto_transfer(
  p_device_serial text,
  p_offroll_employee_id text,
  p_shift_code text,
  p_shift_date date default current_date,
  p_transaction_type text default 'handover',
  p_notes text default null,
  p_physical_condition text default 'good',
  p_functional_condition text default 'working'
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_site text; v_serial text; v_assignment public.device_assignments%rowtype;
  v_pos public.device_stock_positions%rowtype; v_worker public.offroll_worker_master%rowtype; v_hoto_id uuid;
  v_permission text; v_from_type text; v_from_id text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_transaction_type not in ('handover','takeover','mid_shift_swap') then raise exception 'Unsupported HOTO transaction type'; end if;
  if p_shift_code not in ('A','B','C') then raise exception 'Shift must be A, B or C'; end if;
  if p_physical_condition not in ('good') or p_functional_condition not in ('working') then raise exception 'Only Good + Working HHDs can be handed to a TL/GC'; end if;
  if p_offroll_employee_id is null or trim(p_offroll_employee_id)='' then raise exception 'Scan or enter the TL/GC Employee ID'; end if;
  v_permission := case when p_transaction_type='mid_shift_swap' then 'swap' when p_transaction_type='takeover' then 'acknowledge' else 'create' end;

  -- Asset Serial is canonical. IMEI is accepted only when it resolves to exactly one device.
  select d."Serial" into v_serial from public.devices d where upper(d."Serial")=upper(trim(p_device_serial)) limit 1;
  if v_serial is null then
    if (select count(*) from public.devices d where d.imei_number=trim(p_device_serial))<>1 then
      raise exception 'IMEI does not resolve to exactly one device. Scan the unique asset Serial or resolve the duplicate IMEI master records';
    end if;
    select d."Serial" into v_serial from public.devices d where d.imei_number=trim(p_device_serial) limit 1;
  end if;

  select * into v_assignment from public.device_assignments where device_serial=v_serial and status='active' for update;
  if not found then raise exception 'Device has no active primary on-roll employee assignment'; end if;
  v_site := v_assignment.site_code;
  if public.hhd_permission_scope('hoto',v_permission,v_site) is null or public.hhd_permission_scope('hoto',v_permission,v_site)='own' then
    raise exception 'Forbidden: HOTO action requires site-level Operations or Admin scope';
  end if;
  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.site_code<>v_site or v_pos.owner_department<>'operations' or v_pos.stock_state<>'assigned' then
    raise exception 'Device is not in assigned Operations custody';
  end if;
  if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
    raise exception 'Damaged or non-working HHD cannot be handed to a TL/GC';
  end if;
  select * into v_worker from public.offroll_worker_master
  where upper(employee_id)=upper(trim(p_offroll_employee_id)) and site_code=v_site and employment_status='active';
  if not found then raise exception 'TL/GC Employee ID is not active in the HR master for this site'; end if;
  if v_worker.last_synced_at < now() - interval '26 hours' then raise exception 'HR worker master is stale. Run HR Sheet synchronization before HOTO'; end if;
  v_from_type := v_pos.current_holder_type;
  v_from_id := v_pos.current_holder_employee_id;
  if v_from_type not in ('onroll','offroll') or v_from_id is null then raise exception 'Current device holder is not recorded'; end if;
  if v_from_type='offroll' and upper(v_from_id)=upper(v_worker.employee_id) then raise exception 'This TL/GC is already the current holder of the device'; end if;
  if p_transaction_type='handover' and v_from_type<>'onroll' then raise exception 'Handover must start from the primary on-roll custodian'; end if;
  if p_transaction_type in ('takeover','mid_shift_swap') and v_from_type<>'offroll' then raise exception 'Takeover/swap requires a currently active off-roll holder'; end if;

  update public.device_stock_positions set current_holder_employee_id=v_worker.employee_id,current_holder_type='offroll',physical_condition=p_physical_condition,functional_condition=p_functional_condition,updated_by=v_actor,updated_at=now(),last_reference_type='hoto',last_reference_id=null
  where device_serial=v_serial;
  insert into public.hoto_transactions(site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,offroll_worker_type,physical_condition,functional_condition,notes,performed_by)
  values(v_site,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,p_transaction_type,v_from_type,v_from_id,'offroll',v_worker.employee_id,v_worker.worker_type,p_physical_condition,p_functional_condition,nullif(trim(p_notes),''),v_actor)
  returning id into v_hoto_id;
  update public.device_stock_positions set last_reference_id=v_hoto_id::text where device_serial=v_serial;
  insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,reference_type,reference_id,physical_condition,functional_condition,notes,performed_by)
  values(v_serial,'hoto_'||p_transaction_type,'operations','operations',v_from_type,v_from_id,'offroll',v_worker.employee_id,v_site,'hoto',v_hoto_id::text,p_physical_condition,p_functional_condition,p_notes,v_actor);
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
  values(v_actor,'hoto.'||p_transaction_type,'hoto_transaction',v_hoto_id::text,v_site,jsonb_build_object('serial',v_serial,'from_holder_type',v_from_type,'from_holder_id',v_from_id,'to_holder_type','offroll','to_holder_id',v_worker.employee_id,'worker_type',v_worker.worker_type,'shift_code',p_shift_code),coalesce(nullif(trim(p_notes),''),'Shift HOTO recorded'));
  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'site_code',v_site,'from_holder_type',v_from_type,'from_holder_id',v_from_id,'to_holder_type','offroll','to_holder_id',v_worker.employee_id,'worker_name',v_worker.employee_name,'worker_type',v_worker.worker_type,'shift_code',p_shift_code,'transaction_type',p_transaction_type);
end;
$$;

create or replace function public.hhd_return_hoto_to_primary(p_device_serial text,p_physical_condition text,p_functional_condition text,p_shift_code text,p_shift_date date default current_date,p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_serial text; v_assignment public.device_assignments%rowtype; v_pos public.device_stock_positions%rowtype; v_hoto_id uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if coalesce(p_physical_condition,'') not in ('good','damaged') or coalesce(p_functional_condition,'') not in ('working','not_working') then raise exception 'Select physical and functional condition'; end if;
  if p_shift_code not in ('A','B','C') then raise exception 'Shift must be A, B or C'; end if;
  select d."Serial" into v_serial from public.devices d where upper(d."Serial")=upper(trim(p_device_serial)) limit 1;
  if v_serial is null then
    if (select count(*) from public.devices d where d.imei_number=trim(p_device_serial))<>1 then raise exception 'IMEI does not resolve to exactly one device. Use the unique asset Serial'; end if;
    select d."Serial" into v_serial from public.devices d where d.imei_number=trim(p_device_serial) limit 1;
  end if;
  select * into v_assignment from public.device_assignments where device_serial=v_serial and status='active' for update;
  if not found then raise exception 'No active primary assignment exists'; end if;
  if not public.hhd_has_permission('hoto','acknowledge',v_assignment.site_code) then raise exception 'Forbidden: HOTO return acknowledgement denied'; end if;
  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.current_holder_type<>'offroll' then raise exception 'Device is not currently with a TL/GC worker'; end if;
  update public.device_stock_positions set current_holder_employee_id=v_assignment.employee_id,current_holder_type='onroll',physical_condition=p_physical_condition,functional_condition=p_functional_condition,updated_by=v_actor,updated_at=now(),last_reference_type='hoto_return_to_primary',last_reference_id=null where device_serial=v_serial;
  insert into public.hoto_transactions(site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,physical_condition,functional_condition,notes,performed_by)
  values(v_assignment.site_code,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,'return_to_primary','offroll',v_pos.current_holder_employee_id,'onroll',v_assignment.employee_id,p_physical_condition,p_functional_condition,nullif(trim(p_notes),''),v_actor)
  returning id into v_hoto_id;
  update public.device_stock_positions set last_reference_id=v_hoto_id::text where device_serial=v_serial;
  insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,reference_type,reference_id,physical_condition,functional_condition,notes,performed_by)
  values(v_serial,'hoto_return_to_primary','operations','operations','offroll',v_pos.current_holder_employee_id,'onroll',v_assignment.employee_id,v_assignment.site_code,'hoto',v_hoto_id::text,p_physical_condition,p_functional_condition,p_notes,v_actor);
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
  values(v_actor,'hoto.return_to_primary','hoto_transaction',v_hoto_id::text,v_assignment.site_code,jsonb_build_object('serial',v_serial,'from_holder',v_pos.current_holder_employee_id,'to_holder',v_assignment.employee_id),coalesce(nullif(trim(p_notes),''),'HHD returned to primary on-roll custodian'));
  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'primary_employee_id',v_assignment.employee_id,'site_code',v_assignment.site_code);
end;
$$;

create or replace function public.hhd_list_hoto_transactions(p_site_code text,p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb;
begin
  if not public.hhd_has_permission('hoto','view',p_site_code) then raise exception 'Forbidden: HOTO history access denied'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.performed_at desc),'[]'::jsonb) into v_rows
  from (
    select id,site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,
      from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,offroll_worker_type,
      physical_condition,functional_condition,notes,performed_by,performed_at
    from public.hoto_transactions where site_code=p_site_code order by performed_at desc limit greatest(1,least(coalesce(p_limit,100),500))
  ) x;
  return v_rows;
end;
$$;

create or replace function public.hhd_admin_list_users(p_site_code text default '*')
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_rows jsonb; v_scope text;
begin
  v_scope := public.hhd_permission_scope('admin_users','view',p_site_code);
  if v_scope is null then raise exception 'Forbidden: user administration required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',u.user_id,'login_id',u.login_id,'employee_id',u.employee_id,'full_name',u.full_name,'email',u.email,
    'department',u.department,'designation',u.designation,'process',u.process,'account_status',u.account_status,
    'roles',coalesce((select jsonb_agg(jsonb_build_object('role_code',ura.role_code,'role_name',r.role_name,'site_code',ura.site_code,'is_active',ura.is_active))
      from public.user_role_assignments ura join public.app_roles r on r.role_code=ura.role_code where ura.user_id=u.user_id and ura.is_active
        and (p_site_code='*' or ura.site_code='*' or ura.site_code=p_site_code)),'[]'::jsonb),
    'created_at',u.created_at,'last_login_at',u.last_login_at
  ) order by u.created_at desc),'[]'::jsonb) into v_rows
  from public.app_users u
  where (p_site_code='*' or exists(select 1 from public.user_role_assignments ura where ura.user_id=u.user_id and ura.is_active and (ura.site_code='*' or ura.site_code=p_site_code)))
    and (v_scope<>'own' or u.user_id=auth.uid());
  return v_rows;
end;
$$;

create or replace function public.hhd_admin_assign_role(p_user_id uuid,p_role_code text,p_site_code text)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.hhd_has_permission('admin_users','update',p_site_code) then raise exception 'Forbidden: user role assignment requires Admin access'; end if;
  if not exists(select 1 from public.app_users where user_id=p_user_id and account_status<>'deactivated') then raise exception 'Active application user not found'; end if;
  if not exists(select 1 from public.app_roles where role_code=p_role_code and is_active) then raise exception 'Active role not found'; end if;
  if p_site_code<>'*' and not exists(select 1 from public.sites where "Site"=p_site_code) then raise exception 'Unknown site'; end if;
  if p_role_code<>'admin' and p_site_code='*' then raise exception 'Only Admin can receive global site scope'; end if;
  insert into public.user_role_assignments(user_id,role_code,site_code,is_active,assigned_by)
  values(p_user_id,p_role_code,p_site_code,true,auth.uid())
  on conflict(user_id,role_code,site_code) do update set is_active=true,valid_until=null,assigned_by=auth.uid();
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data)
  values(auth.uid(),'admin_users.assign_role','user_role',p_user_id::text,p_site_code,jsonb_build_object('role_code',p_role_code,'site_code',p_site_code));
  return jsonb_build_object('user_id',p_user_id,'role_code',p_role_code,'site_code',p_site_code,'is_active',true);
end;
$$;

create or replace function public.hhd_admin_revoke_role(p_user_id uuid,p_role_code text,p_site_code text,p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.hhd_has_permission('admin_users','update',p_site_code) then raise exception 'Forbidden: role assignment update requires Admin access'; end if;
  if p_user_id=auth.uid() and p_role_code='admin' then raise exception 'You cannot revoke your own Admin role'; end if;
  if p_role_code='admin' and not exists(select 1 from public.user_role_assignments where role_code='admin' and is_active and user_id<>p_user_id) then raise exception 'Cannot revoke the last active Admin assignment'; end if;
  update public.user_role_assignments set is_active=false,valid_until=now()
  where user_id=p_user_id and role_code=p_role_code and site_code=p_site_code and is_active;
  if not found then raise exception 'Active role assignment not found'; end if;
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,reason,after_data)
  values(auth.uid(),'admin_users.revoke_role','user_role',p_user_id::text,p_site_code,coalesce(nullif(trim(p_reason),''),'Role revoked'),jsonb_build_object('role_code',p_role_code,'site_code',p_site_code,'is_active',false));
  return jsonb_build_object('user_id',p_user_id,'role_code',p_role_code,'site_code',p_site_code,'is_active',false);
end;
$$;

create or replace function public.hhd_admin_deactivate_user(p_user_id uuid,p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_before jsonb;
begin
  if not public.hhd_has_permission('admin_users','deactivate','*') then raise exception 'Forbidden: user deactivation requires global Admin access'; end if;
  if p_user_id=auth.uid() then raise exception 'You cannot deactivate your own account'; end if;
  if not exists(select 1 from public.app_users where user_id=p_user_id and account_status in ('active','invited','suspended')) then raise exception 'User not found or already deactivated'; end if;
  if exists(select 1 from public.user_role_assignments where user_id=p_user_id and role_code='admin' and is_active)
     and not exists(select 1 from public.user_role_assignments where role_code='admin' and is_active and user_id<>p_user_id) then raise exception 'Cannot deactivate the last active Admin'; end if;
  select to_jsonb(u) into v_before from public.app_users u where user_id=p_user_id;
  update public.app_users set account_status='deactivated',updated_at=now() where user_id=p_user_id;
  update public.user_role_assignments set is_active=false,valid_until=now() where user_id=p_user_id and is_active;
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,before_data,after_data,reason)
  values(auth.uid(),'admin_users.deactivate','app_user',p_user_id::text,v_before,jsonb_build_object('account_status','deactivated'),coalesce(nullif(trim(p_reason),''),'Account deactivated'));
  return jsonb_build_object('user_id',p_user_id,'account_status','deactivated');
end;
$$;

create or replace function public.hhd_admin_list_audit_events(p_site_code text default '*',p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = public, auth, pg_temp
as $$
declare v_scope text; v_rows jsonb;
begin
  v_scope := public.hhd_permission_scope('admin_audit','view',p_site_code);
  if v_scope is null then raise exception 'Forbidden: audit access denied'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into v_rows
  from (
    select id,actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data,reason,created_at
    from public.admin_audit_events
    where (p_site_code='*' or site_code=p_site_code or (site_code is null and v_scope='all_sites'))
      and (v_scope<>'own' or actor_user_id=auth.uid())
    order by created_at desc limit greatest(1,least(coalesce(p_limit,100),500))
  ) x;
  return v_rows;
end;
$$;

create or replace function public.hhd_admin_reconcile_device_position(
  p_device_serial text,p_site_code text,p_owner_department text,p_stock_state text,p_physical_condition text,p_functional_condition text,p_reason text
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_before jsonb;
begin
  if public.hhd_permission_scope('inventory','reconcile',p_site_code) is null or public.hhd_permission_scope('inventory','reconcile',p_site_code)='own' then raise exception 'Forbidden: opening stock reconciliation requires site-level Inventory access'; end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Reconciliation reason is mandatory'; end if;
  if not exists(select 1 from public.devices where "Serial"=trim(p_device_serial)) then raise exception 'Device serial not found in the existing device master'; end if;
  if exists(select 1 from public.device_assignments where device_serial=trim(p_device_serial) and status='active') then raise exception 'Device has an active primary employee assignment. Reconcile its return/HOTO before changing its stock position'; end if;
  if not exists(select 1 from public.sites where "Site"=p_site_code) then raise exception 'Unknown site'; end if;
  if p_owner_department not in ('superstore','it','operations','in_transit','vendor') then raise exception 'Invalid owning department'; end if;
  if p_stock_state not in ('available','in_transit','quarantined','maintenance','lost','retired') then raise exception 'Invalid stock state'; end if;
  if p_physical_condition not in ('good','damaged','unknown') or p_functional_condition not in ('working','not_working','unknown') then raise exception 'Invalid device condition'; end if;
  select to_jsonb(p) into v_before from public.device_stock_positions p where device_serial=trim(p_device_serial);
  insert into public.device_stock_positions(device_serial,site_code,owner_department,stock_state,physical_condition,functional_condition,current_holder_employee_id,current_holder_type,updated_by,updated_at,last_reference_type,last_reference_id)
  values(trim(p_device_serial),p_site_code,p_owner_department,p_stock_state,p_physical_condition,p_functional_condition,null,null,auth.uid(),now(),'opening_reconciliation',null)
  on conflict(device_serial) do update set site_code=excluded.site_code,owner_department=excluded.owner_department,stock_state=excluded.stock_state,physical_condition=excluded.physical_condition,functional_condition=excluded.functional_condition,current_holder_employee_id=null,current_holder_type=null,updated_by=auth.uid(),updated_at=now(),last_reference_type='opening_reconciliation';
  insert into public.device_movement_ledger(device_serial,event_type,from_department,to_department,site_code,reference_type,physical_condition,functional_condition,notes,performed_by,metadata)
  values(trim(p_device_serial),'opening_stock_reconciliation',coalesce(v_before->>'owner_department','unknown'),p_owner_department,p_site_code,'opening_reconciliation',p_physical_condition,p_functional_condition,p_reason,auth.uid(),jsonb_build_object('previous_position',v_before));
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data,reason)
  values(auth.uid(),'inventory.reconcile','device_stock_position',trim(p_device_serial),p_site_code,v_before,jsonb_build_object('owner_department',p_owner_department,'stock_state',p_stock_state,'physical_condition',p_physical_condition,'functional_condition',p_functional_condition),p_reason);
  return jsonb_build_object('device_serial',trim(p_device_serial),'site_code',p_site_code,'owner_department',p_owner_department,'stock_state',p_stock_state);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Service-role-only atomic helpers for Auth provisioning and HR Sheet sync
-- -----------------------------------------------------------------------------
create or replace function public.hhd_admin_attach_new_user(
  p_user_id uuid,p_login_id text,p_employee_id text,p_full_name text,p_email text,p_role_code text,p_site_code text,
  p_designation text default null,p_process text default null,p_created_by uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_role public.app_roles%rowtype; v_employee text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' then raise exception 'Service role required'; end if;
  select * into v_role from public.app_roles where role_code=p_role_code and is_active;
  if not found then raise exception 'Selected role is not active'; end if;
  if p_site_code<>'*' and not exists(select 1 from public.sites where "Site"=p_site_code) then raise exception 'Unknown site'; end if;
  if p_role_code<>'admin' and trim(coalesce(p_site_code,''))='*' then raise exception 'Non-admin users must have an assigned site'; end if;
  v_employee := nullif(upper(trim(coalesce(p_employee_id,''))), '');
  if p_role_code in ('operations_spoc','site_lead','assigned_employee') and v_employee is null then
    raise exception 'Employee ID is required for this Operations role';
  end if;
  if v_employee is not null and exists(select 1 from public.onroll_employee_master e where e.employee_id=v_employee and e.linked_user_id is not null and e.linked_user_id<>p_user_id) then
    raise exception 'This on-roll Employee ID is already linked to another application login';
  end if;
  if v_employee is not null and exists(select 1 from public.onroll_employee_master e where e.employee_id=v_employee and e.employment_status<>'active') then
    raise exception 'Employee is not active in the on-roll master. Reactivate through the approved employee workflow before inviting an account';
  end if;
  if v_employee is not null and exists(
    select 1 from public.onroll_employee_master e where e.employee_id=v_employee and e.site_code<>p_site_code
      and (exists(select 1 from public.device_assignments da where da.employee_id=v_employee and da.status='active')
        or exists(select 1 from public.allocation_entitlements a where a.employee_id=v_employee and a.status='active'))
  ) then
    raise exception 'Employee site cannot be changed while active HHD allocations or assignments exist';
  end if;
  insert into public.app_users(user_id,login_id,employee_id,full_name,email,designation,process,account_status,created_by)
  values(p_user_id,trim(p_login_id),v_employee,trim(p_full_name),lower(trim(p_email)),nullif(trim(p_designation),''),nullif(trim(p_process),''),'invited',p_created_by)
  on conflict(user_id) do update set login_id=excluded.login_id,employee_id=excluded.employee_id,full_name=excluded.full_name,email=excluded.email,designation=excluded.designation,process=excluded.process,updated_at=now();
  insert into public.user_role_assignments(user_id,role_code,site_code,is_active,assigned_by)
  values(p_user_id,p_role_code,p_site_code,true,p_created_by)
  on conflict(user_id,role_code,site_code) do update set is_active=true,valid_until=null;
  if v_employee is not null and p_role_code in ('operations_spoc','site_lead','assigned_employee') then
    if trim(coalesce(p_designation,''))='' then raise exception 'Designation is required for Operations employee accounts'; end if;
    insert into public.onroll_employee_master(employee_id,employee_name,site_code,designation,process,email,employment_status,linked_user_id,source,updated_at)
    values(v_employee,trim(p_full_name),p_site_code,trim(p_designation),nullif(trim(p_process),''),lower(trim(p_email)),'active',p_user_id,'admin_managed',now())
    on conflict(employee_id) do update set employee_name=excluded.employee_name,site_code=excluded.site_code,designation=excluded.designation,process=excluded.process,email=excluded.email,employment_status='active',linked_user_id=p_user_id,updated_at=now();
  end if;
  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data)
  values(p_created_by,'admin_users.create','app_user',p_user_id::text,p_site_code,jsonb_build_object('login_id',p_login_id,'employee_id',v_employee,'role_code',p_role_code,'status','invited'));
  return jsonb_build_object('user_id',p_user_id,'login_id',p_login_id,'employee_id',v_employee,'role_code',p_role_code,'site_code',p_site_code,'account_status','invited');
end;
$$;

create or replace function public.hhd_hr_sync_workers(p_rows jsonb,p_snapshot_complete boolean default false,p_minimum_rows integer default 0,p_checksum text default null)
returns jsonb
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
declare v_count integer; v_inserted integer := 0; v_updated integer := 0; v_deactivated integer := 0; v_run uuid; v_bad integer;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' then raise exception 'Service role required'; end if;
  if coalesce(jsonb_typeof(p_rows),'')<>'array' then raise exception 'Worker payload must be a JSON array'; end if;
  v_count := jsonb_array_length(p_rows);
  if v_count=0 then raise exception 'Empty HR worker snapshot rejected'; end if;
  if p_snapshot_complete and (p_minimum_rows is null or p_minimum_rows<1 or v_count<p_minimum_rows) then raise exception 'Complete snapshot rejected: row count % is below the configured safety minimum %',v_count,coalesce(p_minimum_rows,0); end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) as x(employee_id text) group by upper(trim(employee_id)) having count(*)>1) then raise exception 'Duplicate Employee ID in HR sheet'; end if;
  if exists(
    select 1 from jsonb_to_recordset(p_rows) as x(employee_id text,worker_type text,employee_name text,site_code text,employment_status text)
    where coalesce(trim(employee_id),'')='' or coalesce(trim(employee_name),'')='' or upper(trim(worker_type)) not in ('TL','GC')
      or lower(trim(employment_status)) not in ('active','inactive')
      or not exists(select 1 from public.sites s where lower(s."Site")=lower(trim(x.site_code)))
  ) then raise exception 'HR payload contains missing/invalid fields, invalid TL/GC type/status or unknown Site'; end if;

  create temporary table _hr_incoming on commit drop as
  select upper(trim(x.employee_id)) employee_id,upper(trim(x.worker_type)) worker_type,trim(x.employee_name) employee_name,
    s."Site" site_code,nullif(trim(x.process),'') process,lower(trim(x.employment_status)) employment_status,
    nullif(trim(x.source_updated_at),'')::timestamptz source_updated_at,
    md5(concat_ws('|',upper(trim(x.employee_id)),upper(trim(x.worker_type)),trim(x.employee_name),s."Site",coalesce(x.process,''),lower(trim(x.employment_status)),coalesce(x.source_updated_at,''))) source_row_hash
  from jsonb_to_recordset(p_rows) as x(employee_id text,worker_type text,employee_name text,site_code text,process text,employment_status text,source_updated_at text)
  join public.sites s on lower(s."Site")=lower(trim(x.site_code));

  insert into public.hr_sync_runs(status,received_rows,snapshot_complete,checksum,initiated_by)
  values('running',v_count,coalesce(p_snapshot_complete,false),p_checksum,'Apps Script HR sync') returning id into v_run;

  select count(*) into v_inserted from _hr_incoming i where not exists(select 1 from public.offroll_worker_master o where o.employee_id=i.employee_id);
  select count(*) into v_updated from _hr_incoming i where exists(select 1 from public.offroll_worker_master o where o.employee_id=i.employee_id and o.source_row_hash is distinct from i.source_row_hash);

  insert into public.offroll_worker_master(employee_id,worker_type,employee_name,site_code,process,employment_status,source,source_updated_at,last_synced_at,source_row_hash,updated_at)
  select employee_id,worker_type,employee_name,site_code,process,employment_status,'HR_GOOGLE_SHEET',source_updated_at,now(),source_row_hash,now() from _hr_incoming
  on conflict(employee_id) do update set worker_type=excluded.worker_type,employee_name=excluded.employee_name,site_code=excluded.site_code,process=excluded.process,employment_status=excluded.employment_status,source_updated_at=excluded.source_updated_at,last_synced_at=now(),source_row_hash=excluded.source_row_hash,updated_at=now();

  if p_snapshot_complete and coalesce(p_minimum_rows,0)>0 and v_count>=p_minimum_rows then
    update public.offroll_worker_master o set employment_status='inactive',last_synced_at=now(),updated_at=now()
    where o.source='HR_GOOGLE_SHEET' and o.employment_status='active'
      and not exists(select 1 from _hr_incoming i where i.employee_id=o.employee_id);
    get diagnostics v_deactivated = row_count;
  end if;

  update public.hr_sync_runs set status='success',inserted_rows=v_inserted,updated_rows=v_updated,deactivated_rows=v_deactivated,completed_at=now(),message='HR worker master synchronized' where id=v_run;
  return jsonb_build_object('run_id',v_run,'status','success','received_rows',v_count,'inserted_rows',v_inserted,'updated_rows',v_updated,'deactivated_rows',v_deactivated,'snapshot_complete',coalesce(p_snapshot_complete,false));
end;
$$;

-- Activate an invited app profile only after Supabase Auth confirms the invited email.
create or replace function public.hhd_activate_app_user_after_email_confirmation()
returns trigger
language plpgsql security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.email_confirmed_at is not null and (old.email_confirmed_at is null or old.email_confirmed_at is distinct from new.email_confirmed_at) then
    update public.app_users set account_status='active',updated_at=now() where user_id=new.id and account_status='invited';
  end if;
  return new;
end;
$$;
drop trigger if exists hhd_activate_app_user_after_email_confirmation on auth.users;
create trigger hhd_activate_app_user_after_email_confirmation
  after update of email_confirmed_at on auth.users
  for each row execute function public.hhd_activate_app_user_after_email_confirmation();

-- -----------------------------------------------------------------------------
-- 9. RLS and grants. New tables are accessed through the checked RPC/Edge APIs.
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_users','app_roles','app_permissions','role_permissions','user_role_assignments','onroll_employee_master','offroll_worker_master','hr_sync_runs','device_stock_positions','allocation_entitlements','device_assignments','allocation_events','device_movement_ledger','hoto_transactions','admin_audit_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from anon, authenticated',t);
  end loop;
end $$;

revoke all on function public.hhd_activate_app_user_after_email_confirmation() from public, anon, authenticated;
revoke all on function public.hhd_permission_scope(text,text,text) from public, anon;
revoke all on function public.hhd_has_permission(text,text,text) from public, anon;
revoke all on function public.hhd_get_my_context() from public, anon;
revoke all on function public.hhd_list_sites() from public, anon;
revoke all on function public.hhd_get_site_workspace(text) from public, anon;
revoke all on function public.hhd_admin_list_roles_permissions() from public, anon;
revoke all on function public.hhd_admin_create_role(text,text,text,text) from public, anon;
revoke all on function public.hhd_admin_set_role_permission(text,text,boolean,text) from public, anon;
revoke all on function public.hhd_admin_upsert_onroll_employee(text,text,text,text,text,text,text) from public, anon;
revoke all on function public.hhd_admin_list_onroll_employees(text) from public, anon;
revoke all on function public.hhd_list_offroll_workers(text) from public, anon;
revoke all on function public.hhd_lookup_offroll_worker(text,text) from public, anon;
revoke all on function public.hhd_get_hr_sync_runs(integer) from public, anon;
revoke all on function public.hhd_list_my_devices() from public, anon;
revoke all on function public.hhd_list_allocations(text) from public, anon;
revoke all on function public.hhd_create_or_adjust_allocation(text,text,text,integer,text,integer) from public, anon;
revoke all on function public.hhd_scan_assign_device(text,uuid,text) from public, anon;
revoke all on function public.hhd_return_assigned_device(text,text,text,text) from public, anon;
revoke all on function public.hhd_record_hoto_transfer(text,text,text,date,text,text,text,text) from public, anon;
revoke all on function public.hhd_return_hoto_to_primary(text,text,text,text,date,text) from public, anon;
revoke all on function public.hhd_list_hoto_transactions(text,integer) from public, anon;
revoke all on function public.hhd_admin_reconcile_device_positions(jsonb,text) from public, anon;
revoke all on function public.hhd_admin_list_users(text) from public, anon;
revoke all on function public.hhd_admin_assign_role(uuid,text,text) from public, anon;
revoke all on function public.hhd_admin_revoke_role(uuid,text,text,text) from public, anon;
revoke all on function public.hhd_admin_deactivate_user(uuid,text) from public, anon;
revoke all on function public.hhd_admin_list_audit_events(text,integer) from public, anon;
revoke all on function public.hhd_admin_reconcile_device_position(text,text,text,text,text,text,text) from public, anon;
revoke all on function public.hhd_admin_attach_new_user(uuid,text,text,text,text,text,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.hhd_hr_sync_workers(jsonb,boolean,integer,text) from public, anon, authenticated;

grant execute on function public.hhd_permission_scope(text,text,text) to authenticated;
grant execute on function public.hhd_has_permission(text,text,text) to authenticated;
grant execute on function public.hhd_get_my_context() to authenticated;
grant execute on function public.hhd_list_sites() to authenticated;
grant execute on function public.hhd_get_site_workspace(text) to authenticated;
grant execute on function public.hhd_admin_list_roles_permissions() to authenticated;
grant execute on function public.hhd_admin_create_role(text,text,text,text) to authenticated;
grant execute on function public.hhd_admin_set_role_permission(text,text,boolean,text) to authenticated;
grant execute on function public.hhd_admin_upsert_onroll_employee(text,text,text,text,text,text,text) to authenticated;
grant execute on function public.hhd_admin_list_onroll_employees(text) to authenticated;
grant execute on function public.hhd_list_offroll_workers(text) to authenticated;
grant execute on function public.hhd_lookup_offroll_worker(text,text) to authenticated;
grant execute on function public.hhd_get_hr_sync_runs(integer) to authenticated;
grant execute on function public.hhd_list_my_devices() to authenticated;
grant execute on function public.hhd_list_allocations(text) to authenticated;
grant execute on function public.hhd_create_or_adjust_allocation(text,text,text,integer,text,integer) to authenticated;
grant execute on function public.hhd_scan_assign_device(text,uuid,text) to authenticated;
grant execute on function public.hhd_return_assigned_device(text,text,text,text) to authenticated;
grant execute on function public.hhd_record_hoto_transfer(text,text,text,date,text,text,text,text) to authenticated;
grant execute on function public.hhd_return_hoto_to_primary(text,text,text,text,date,text) to authenticated;
grant execute on function public.hhd_list_hoto_transactions(text,integer) to authenticated;
grant execute on function public.hhd_admin_reconcile_device_positions(jsonb,text) to authenticated;
grant execute on function public.hhd_admin_list_users(text) to authenticated;
grant execute on function public.hhd_admin_assign_role(uuid,text,text) to authenticated;
grant execute on function public.hhd_admin_revoke_role(uuid,text,text,text) to authenticated;
grant execute on function public.hhd_admin_deactivate_user(uuid,text) to authenticated;
grant execute on function public.hhd_admin_list_audit_events(text,integer) to authenticated;
grant execute on function public.hhd_admin_reconcile_device_position(text,text,text,text,text,text,text) to authenticated;
grant execute on function public.hhd_admin_attach_new_user(uuid,text,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.hhd_hr_sync_workers(jsonb,boolean,integer,text) to service_role;

commit;

notify pgrst, 'reload schema';
