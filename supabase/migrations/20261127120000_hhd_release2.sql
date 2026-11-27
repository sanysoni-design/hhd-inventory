begin;

-- ---------------------------------------------------------------------------
-- HHD Release 2 additive migration
-- Apply only after reviewing against the existing Phase 1 database.
-- ---------------------------------------------------------------------------

alter table public.device_movement_ledger
  add column if not exists imei_number text;

update public.device_movement_ledger l
set imei_number = d.imei_number
from public.devices d
where d."Serial" = l.device_serial
  and l.imei_number is null;

create index if not exists device_movement_imei_idx
  on public.device_movement_ledger (imei_number, performed_at desc);

-- Nomenclature is presentation-only: preserve immutable role codes and existing
-- permission assignments so deployed accounts do not lose access.
update public.app_roles set role_name = 'Allocator', updated_at = now()
where role_code = 'site_lead';
update public.app_roles set role_name = 'Custodian', updated_at = now()
where role_code = 'assigned_employee';
update public.app_roles set role_name = 'Asset Manager', updated_at = now()
where role_code = 'operations_spoc';

-- Admin-created user accounts are active immediately; all existing invited users
-- remain unchanged. Passwords continue to be held only by Supabase Auth.

-- STO header and line tables. Device Serial remains the canonical asset key;
-- IMEI is captured as an immutable point-in-time scan snapshot.
create table if not exists public.sto_headers (
  id uuid primary key default gen_random_uuid(),
  sto_number text not null unique,
  from_site_code text not null references public.sites("Site") on update cascade on delete restrict,
  to_site_code text not null references public.sites("Site") on update cascade on delete restrict,
  status text not null default 'dispatched'
    check (status in ('dispatched','partially_received','received','cancelled')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  dispatched_by uuid references auth.users(id) on delete set null,
  dispatched_at timestamptz not null default now(),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_site_code <> to_site_code)
);

create table if not exists public.sto_lines (
  id uuid primary key default gen_random_uuid(),
  sto_id uuid not null references public.sto_headers(id) on delete restrict,
  device_serial text not null references public.devices("Serial") on update cascade on delete restrict,
  imei_number text,
  status text not null default 'dispatched'
    check (status in ('dispatched','received')),
  received_department text
    check (received_department is null or received_department in ('it','operations','superstore')),
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz,
  received_notes text,
  created_at timestamptz not null default now(),
  unique (sto_id, device_serial)
);

create index if not exists sto_headers_from_site_idx
  on public.sto_headers (from_site_code, dispatched_at desc);
create index if not exists sto_headers_to_site_idx
  on public.sto_headers (to_site_code, dispatched_at desc);
create index if not exists sto_lines_device_idx
  on public.sto_lines (device_serial, status);
alter table public.sto_headers enable row level security;
alter table public.sto_lines enable row level security;
revoke all on public.sto_headers, public.sto_lines from anon, authenticated;
grant all on public.sto_headers, public.sto_lines to service_role;

-- Ledger rows always capture the current IMEI from the canonical device master.
create or replace function public.hhd_stamp_movement_imei()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.imei_number is null then
    select d.imei_number into new.imei_number
    from public.devices d
    where d."Serial" = new.device_serial;
  end if;
  return new;
end;
$$;

drop trigger if exists hhd_movement_imei_snapshot on public.device_movement_ledger;
create trigger hhd_movement_imei_snapshot
before insert on public.device_movement_ledger
for each row execute function public.hhd_stamp_movement_imei();

-- Capture legacy device-master Status / FaultReason changes, including edits that
-- do not pass through the new Operations UI.
create or replace function public.hhd_audit_device_master_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_site text;
  v_actor uuid := auth.uid();
begin
  if old."Status" is distinct from new."Status"
     or old."FaultReason" is distinct from new."FaultReason"
     or old.imei_number is distinct from new.imei_number then
    select p.site_code into v_site
    from public.device_stock_positions p
    where p.device_serial = new."Serial";

    insert into public.device_movement_ledger(
      device_serial, imei_number, event_type, site_code,
      notes, performed_by, metadata
    )
    values (
      new."Serial", new.imei_number,
      case when old.imei_number is distinct from new.imei_number
        then 'device_imei_changed' else 'device_master_status_changed' end,
      v_site,
      'Device master IMEI, status or fault reason changed', v_actor,
      jsonb_build_object(
        'old_imei', old.imei_number,
        'new_imei', new.imei_number,
        'old_status', old."Status",
        'new_status', new."Status",
        'old_fault_reason', old."FaultReason",
        'new_fault_reason', new."FaultReason"
      )
    );

    insert into public.admin_audit_events(
      actor_user_id, action_code, entity_type, entity_id, site_code,
      before_data, after_data, reason
    )
    values (
      v_actor, 'inventory.device_master_status_changed', 'device', new."Serial", v_site,
      jsonb_build_object('imei', old.imei_number, 'status', old."Status", 'fault_reason', old."FaultReason"),
      jsonb_build_object('imei', new.imei_number, 'status', new."Status", 'fault_reason', new."FaultReason"),
      'Device master IMEI / Status / FaultReason field changed'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists hhd_device_master_status_change on public.devices;
create trigger hhd_device_master_status_change
after update of "Status", "FaultReason", imei_number on public.devices
for each row execute function public.hhd_audit_device_master_status_change();

-- Capture every stock owner, stock-state and working-condition transition separately
-- from the primary transaction event. Holder-only HOTO edits do not generate noise.
create or replace function public.hhd_audit_device_position_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := coalesce(auth.uid(), new.updated_by);
begin
  if old.owner_department is distinct from new.owner_department
     or old.stock_state is distinct from new.stock_state
     or old.physical_condition is distinct from new.physical_condition
     or old.functional_condition is distinct from new.functional_condition then
    insert into public.device_movement_ledger(
      device_serial, event_type, from_department, to_department,
      site_code, reference_type, reference_id, physical_condition,
      functional_condition, notes, performed_by, metadata
    )
    values (
      new.device_serial, 'device_status_condition_changed',
      old.owner_department, new.owner_department,
      new.site_code, new.last_reference_type, new.last_reference_id,
      new.physical_condition, new.functional_condition,
      'Device stock status / condition changed', v_actor,
      jsonb_build_object(
        'old_owner_department', old.owner_department,
        'new_owner_department', new.owner_department,
        'old_stock_state', old.stock_state,
        'new_stock_state', new.stock_state,
        'old_physical_condition', old.physical_condition,
        'new_physical_condition', new.physical_condition,
        'old_functional_condition', old.functional_condition,
        'new_functional_condition', new.functional_condition,
        'old_holder_type', old.current_holder_type,
        'old_holder_id', old.current_holder_employee_id,
        'new_holder_type', new.current_holder_type,
        'new_holder_id', new.current_holder_employee_id
      )
    );

    insert into public.admin_audit_events(
      actor_user_id, action_code, entity_type, entity_id, site_code,
      before_data, after_data, reason
    )
    values (
      v_actor, 'inventory.status_condition_changed', 'device_stock_position',
      new.device_serial, new.site_code,
      jsonb_build_object(
        'owner_department', old.owner_department,
        'stock_state', old.stock_state,
        'physical_condition', old.physical_condition,
        'functional_condition', old.functional_condition
      ),
      jsonb_build_object(
        'owner_department', new.owner_department,
        'stock_state', new.stock_state,
        'physical_condition', new.physical_condition,
        'functional_condition', new.functional_condition
      ),
      'Device position status or working condition changed'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists hhd_device_position_change_audit on public.device_stock_positions;
create trigger hhd_device_position_change_audit
after update on public.device_stock_positions
for each row execute function public.hhd_audit_device_position_change();

-- The employee master is a privileged module. Distribution workflows receive only
-- a minimal picker view through hhd_list_allocatable_employees.
create or replace function public.hhd_admin_list_onroll_employees(p_site_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_scope text;
  v_rows jsonb;
begin
  v_scope := public.hhd_permission_scope('admin_employees','view',p_site_code);
  if v_scope is null then
    raise exception 'Forbidden: explicit On-roll Employee Master view permission is required';
  end if;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.employee_name),'[]'::jsonb)
  into v_rows
  from public.onroll_employee_master e
  where e.site_code = p_site_code
    and (e.employment_status = 'active' or public.hhd_has_permission('admin_employees','update',p_site_code))
    and (v_scope <> 'own' or e.employee_id = (
      select u.employee_id from public.app_users u where u.user_id = auth.uid()
    ));
  return v_rows;
end;
$$;

create or replace function public.hhd_list_allocatable_employees(p_site_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_scope text;
  v_rows jsonb;
begin
  v_scope := public.hhd_permission_scope('distribution','view',p_site_code);
  if v_scope is null then
    raise exception 'Forbidden: distribution employee lookup permission required';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id', e.employee_id,
    'employee_name', e.employee_name,
    'designation', e.designation,
    'process', e.process,
    'site_code', e.site_code
  ) order by e.employee_name),'[]'::jsonb)
  into v_rows
  from public.onroll_employee_master e
  where e.site_code = p_site_code
    and e.employment_status = 'active'
    and e.linked_user_id is not null
    and (v_scope <> 'own' or e.employee_id = (
      select u.employee_id from public.app_users u where u.user_id = auth.uid()
    ));
  return v_rows;
end;
$$;

-- Batch site assignments stay as individual site rows so revocation and audit retain
-- their existing semantics. Only the built-in Admin role can use the '*' wildcard.
create or replace function public.hhd_admin_assign_role_sites(
  p_user_id uuid, p_role_code text, p_site_codes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_site text;
  v_sites text[] := array(
    select distinct trim(u.site_code)
    from unnest(coalesce(p_site_codes, array[]::text[])) as u(site_code)
    where trim(u.site_code) <> ''
  );
begin
  if not public.hhd_has_permission('admin_users','update','*') then
    raise exception 'Forbidden: global user administration permission required';
  end if;
  if not exists(select 1 from public.app_users where user_id=p_user_id and account_status <> 'deactivated') then
    raise exception 'Active application user not found';
  end if;
  if not exists(select 1 from public.app_roles where role_code=p_role_code and is_active) then
    raise exception 'Active role not found';
  end if;
  if cardinality(v_sites)=0 then raise exception 'Select at least one site'; end if;
  if p_role_code='assigned_employee' and cardinality(v_sites)>1 then
    raise exception 'Custodian accounts are site-bound to their On-roll Employee Master record';
  end if;
  if '*' = any(v_sites) and (p_role_code <> 'admin' or cardinality(v_sites) <> 1) then
    raise exception 'All sites is reserved for the Admin role';
  end if;
  foreach v_site in array v_sites loop
    if v_site <> '*' and not exists(select 1 from public.sites where "Site"=v_site) then
      raise exception 'Unknown site: %', v_site;
    end if;
  end loop;

  insert into public.user_role_assignments(user_id,role_code,site_code,is_active,assigned_by)
  select p_user_id,p_role_code,s,true,auth.uid() from unnest(v_sites) s
  on conflict(user_id,role_code,site_code)
  do update set is_active=true,valid_until=null,assigned_by=auth.uid();

  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,after_data,reason
  )
  values(
    auth.uid(),'admin_users.assign_role_sites','user_role',p_user_id::text,
    jsonb_build_object('role_code',p_role_code,'site_codes',to_jsonb(v_sites)),
    'Role assigned across selected sites'
  );
  return jsonb_build_object('user_id',p_user_id,'role_code',p_role_code,'site_codes',to_jsonb(v_sites));
end;
$$;

-- STO: create and dispatch is a single atomic operation. Only reconciled, unassigned,
-- good/working devices can leave a source site. Receipt is scanned one device at a time.
create or replace function public.hhd_sto_create_dispatch(
  p_from_site_code text,
  p_to_site_code text,
  p_scans text[],
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_sto_id uuid;
  v_sto_number text;
  v_scan text;
  v_serial text;
  v_imei text;
  v_pos public.device_stock_positions%rowtype;
  v_count integer := 0;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_from_site_code = p_to_site_code then raise exception 'Source and destination sites must be different'; end if;
  if not exists(select 1 from public.sites where "Site"=p_from_site_code)
     or not exists(select 1 from public.sites where "Site"=p_to_site_code) then
    raise exception 'Unknown source or destination site';
  end if;
  if public.hhd_permission_scope('sto','create',p_from_site_code) is null
     or public.hhd_permission_scope('sto','create',p_from_site_code)='own'
     or public.hhd_permission_scope('sto','dispatch',p_from_site_code) is null
     or public.hhd_permission_scope('sto','dispatch',p_from_site_code)='own' then
    raise exception 'Forbidden: site-level STO create and dispatch permissions are required';
  end if;
  if coalesce(array_length(p_scans,1),0)=0 or array_length(p_scans,1)>100 then
    raise exception 'Scan between 1 and 100 devices before dispatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_from_site_code)), 71023));
  v_sto_number := 'STO-' || to_char(now(),'YYYYMMDD') || '-' ||
    upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.sto_headers(
    sto_number,from_site_code,to_site_code,status,notes,created_by,dispatched_by
  )
  values(
    v_sto_number,p_from_site_code,p_to_site_code,'dispatched',
    nullif(trim(p_notes),''),v_actor,v_actor
  )
  returning id into v_sto_id;

  foreach v_scan in array p_scans loop
    if trim(coalesce(v_scan,''))='' then raise exception 'Blank device scan is not allowed'; end if;

    select d."Serial",d.imei_number into v_serial,v_imei
    from public.devices d
    where upper(d."Serial")=upper(trim(v_scan))
    limit 1;

    if v_serial is null then
      select count(*) into v_count
      from public.devices d where d.imei_number=trim(v_scan);
      if v_count=0 then raise exception 'Device Serial / IMEI not found: %',v_scan; end if;
      if v_count>1 then raise exception 'IMEI is not unique: %. Resolve the device master first.',v_scan; end if;
      select d."Serial",d.imei_number into v_serial,v_imei
      from public.devices d where d.imei_number=trim(v_scan);
    end if;

    if exists(select 1 from public.sto_lines sl join public.sto_headers sh on sh.id=sl.sto_id
      where sl.device_serial=v_serial and sl.status='dispatched') then
      raise exception 'Device % is already in an open STO',v_serial;
    end if;

    select * into v_pos from public.device_stock_positions
    where device_serial=v_serial for update;
    if not found then raise exception 'Device % has no reconciled stock position',v_serial; end if;
    if v_pos.site_code<>p_from_site_code
       or v_pos.owner_department not in ('it','operations','superstore')
       or v_pos.stock_state<>'available'
       or v_pos.physical_condition<>'good'
       or v_pos.functional_condition<>'working'
       or v_pos.current_holder_employee_id is not null then
      raise exception 'Device % is not eligible for STO. Check source site, department, state, condition and current holder.',v_serial;
    end if;
    if exists(select 1 from public.device_assignments da where da.device_serial=v_serial and da.status='active') then
      raise exception 'Device % has an active employee assignment and cannot be transferred',v_serial;
    end if;

    insert into public.sto_lines(sto_id,device_serial,imei_number,status)
    values(v_sto_id,v_serial,v_imei,'dispatched');

    update public.device_stock_positions
    set owner_department='in_transit',stock_state='in_transit',
        location_code=p_to_site_code,last_reference_type='sto',
        last_reference_id=v_sto_id::text,updated_by=v_actor,updated_at=now()
    where device_serial=v_serial;

    insert into public.device_movement_ledger(
      device_serial,imei_number,event_type,from_department,to_department,
      from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,
      reference_type,reference_id,physical_condition,functional_condition,
      notes,performed_by,metadata
    )
    values(
      v_serial,v_imei,'sto_dispatched',v_pos.owner_department,'in_transit',
      null,null,null,null,p_from_site_code,'sto',v_sto_id::text,
      v_pos.physical_condition,v_pos.functional_condition,p_notes,v_actor,
      jsonb_build_object('sto_number',v_sto_number,'destination_site',p_to_site_code)
    );
  end loop;

  update public.sto_headers set updated_at=now() where id=v_sto_id;
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  )
  values(
    v_actor,'sto.dispatch','sto',v_sto_id::text,p_from_site_code,
    jsonb_build_object('sto_number',v_sto_number,'from_site',p_from_site_code,
      'to_site',p_to_site_code,'device_count',cardinality(p_scans)),
    coalesce(nullif(trim(p_notes),''),'STO created and dispatched')
  );

  return jsonb_build_object(
    'sto_id',v_sto_id,'sto_number',v_sto_number,'status','dispatched',
    'from_site_code',p_from_site_code,'to_site_code',p_to_site_code,
    'device_count',cardinality(p_scans)
  );
end;
$$;

create or replace function public.hhd_sto_receive_device(
  p_sto_id uuid,
  p_scan_value text,
  p_destination_department text default 'operations',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_header public.sto_headers%rowtype;
  v_line public.sto_lines%rowtype;
  v_serial text;
  v_pos public.device_stock_positions%rowtype;
  v_remaining integer;
  v_stock_state text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_destination_department not in ('it','operations','superstore') then
    raise exception 'Select IT, Operations or Superstore as receiving department';
  end if;

  select * into v_header from public.sto_headers where id=p_sto_id for update;
  if not found then raise exception 'STO not found'; end if;
  if public.hhd_permission_scope('sto','receive',v_header.to_site_code) is null
     or public.hhd_permission_scope('sto','receive',v_header.to_site_code)='own' then
    raise exception 'Forbidden: destination-site STO receive permission required';
  end if;
  if v_header.status not in ('dispatched','partially_received') then
    raise exception 'STO is not open for receipt';
  end if;

  select d."Serial" into v_serial
  from public.devices d
  where upper(d."Serial")=upper(trim(p_scan_value))
  limit 1;

  if v_serial is null then
    if (select count(*) from public.devices d where d.imei_number=trim(p_scan_value))<>1 then
      raise exception 'IMEI does not resolve to exactly one device';
    end if;
    select d."Serial" into v_serial from public.devices d where d.imei_number=trim(p_scan_value);
  end if;

  select * into v_line from public.sto_lines
  where sto_id=p_sto_id and device_serial=v_serial for update;
  if not found then raise exception 'Scanned device is not listed in this STO'; end if;
  if v_line.status='received' then raise exception 'Device has already been received'; end if;

  select * into v_pos from public.device_stock_positions
  where device_serial=v_serial for update;
  if not found or v_pos.owner_department<>'in_transit' or v_pos.stock_state<>'in_transit' then
    raise exception 'Device is not currently in transit';
  end if;

  v_stock_state := case
    when v_pos.physical_condition='good' and v_pos.functional_condition='working' then 'available'
    else 'quarantined'
  end;

  update public.device_stock_positions
  set site_code=v_header.to_site_code,
      owner_department=p_destination_department,
      stock_state=v_stock_state,
      current_holder_employee_id=null,current_holder_type=null,
      location_code=v_header.to_site_code,
      last_reference_type='sto',last_reference_id=v_header.id::text,
      updated_by=v_actor,updated_at=now()
  where device_serial=v_serial;

  update public.sto_lines
  set status='received',received_department=p_destination_department,
      received_by=v_actor,received_at=now(),received_notes=nullif(trim(p_notes),'')
  where id=v_line.id;

  insert into public.device_movement_ledger(
    device_serial,imei_number,event_type,from_department,to_department,
    site_code,reference_type,reference_id,physical_condition,functional_condition,
    notes,performed_by,metadata
  )
  values(
    v_serial,v_line.imei_number,'sto_received','in_transit',p_destination_department,
    v_header.to_site_code,'sto',v_header.id::text,
    v_pos.physical_condition,v_pos.functional_condition,p_notes,v_actor,
    jsonb_build_object('sto_number',v_header.sto_number,'source_site',v_header.from_site_code,
      'destination_site',v_header.to_site_code,'received_stock_state',v_stock_state)
  );

  select count(*) into v_remaining from public.sto_lines
  where sto_id=p_sto_id and status<>'received';
  update public.sto_headers
  set status=case when v_remaining=0 then 'received' else 'partially_received' end,
      received_at=case when v_remaining=0 then now() else received_at end,
      updated_at=now()
  where id=p_sto_id;

  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  )
  values(
    v_actor,'sto.receive_device','sto_line',v_line.id::text,v_header.to_site_code,
    jsonb_build_object('sto_id',v_header.id,'sto_number',v_header.sto_number,
      'device_serial',v_serial,'imei_number',v_line.imei_number,
      'receiving_department',p_destination_department,'stock_state',v_stock_state),
    coalesce(nullif(trim(p_notes),''),'STO device received by scan')
  );

  return jsonb_build_object(
    'sto_id',v_header.id,'sto_number',v_header.sto_number,
    'device_serial',v_serial,'imei_number',v_line.imei_number,
    'status',case when v_remaining=0 then 'received' else 'partially_received' end,
    'remaining_devices',v_remaining
  );
end;
$$;

create or replace function public.hhd_sto_list(p_site_code text, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_scope text;
  v_rows jsonb;
begin
  v_scope := coalesce(
    public.hhd_permission_scope('sto','view',p_site_code),
    public.hhd_permission_scope('sto','receive',p_site_code),
    public.hhd_permission_scope('sto','dispatch',p_site_code),
    public.hhd_permission_scope('sto','create',p_site_code)
  );
  if v_scope is null then raise exception 'Forbidden: STO view, receive or dispatch permission required'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.dispatched_at desc),'[]'::jsonb)
  into v_rows
  from (
    select h.id,h.sto_number,h.from_site_code,h.to_site_code,h.status,h.notes,
      h.dispatched_at,h.received_at,
      (select count(*) from public.sto_lines l where l.sto_id=h.id) as device_count,
      (select count(*) from public.sto_lines l where l.sto_id=h.id and l.status='received') as received_count,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'device_serial',l.device_serial,'imei_number',l.imei_number,'status',l.status,
        'received_department',l.received_department,'received_at',l.received_at
      ) order by l.created_at),'[]'::jsonb) from public.sto_lines l where l.sto_id=h.id) as lines
    from public.sto_headers h
    where (h.from_site_code=p_site_code or h.to_site_code=p_site_code)
      and (v_scope <> 'own' or h.created_by=auth.uid())
    order by h.dispatched_at desc
    limit greatest(1,least(coalesce(p_limit,100),300))
  ) x;
  return v_rows;
end;
$$;


create or replace function public.hhd_list_device_movement_ledger(
  p_site_code text,
  p_search text default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $hhd$
declare
  v_scope text;
  v_rows jsonb;
  v_query text := lower(trim(coalesce(p_search,'')));
begin
  v_scope := coalesce(
    public.hhd_permission_scope('inventory','view',p_site_code),
    public.hhd_permission_scope('admin_audit','view',p_site_code)
  );
  if v_scope is null then raise exception 'Forbidden: device movement history access denied'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.performed_at desc),'[]'::jsonb)
  into v_rows
  from (
    select l.id,l.device_serial,l.imei_number,l.event_type,
      l.from_department,l.to_department,l.from_holder_type,l.from_holder_id,
      l.to_holder_type,l.to_holder_id,l.site_code,l.reference_type,l.reference_id,
      l.physical_condition,l.functional_condition,l.notes,l.performed_by,
      l.performed_at,l.metadata,u.full_name as performed_by_name
    from public.device_movement_ledger l
    left join public.app_users u on u.user_id=l.performed_by
    where l.site_code=p_site_code
      and (v_scope <> 'own' or l.performed_by=auth.uid())
      and (
        v_query = ''
        or lower(coalesce(l.device_serial,'')) like '%'||v_query||'%'
        or lower(coalesce(l.imei_number,'')) like '%'||v_query||'%'
        or lower(coalesce(l.event_type,'')) like '%'||v_query||'%'
        or lower(coalesce(l.reference_id,'')) like '%'||v_query||'%'
        or lower(coalesce(l.notes,'')) like '%'||v_query||'%'
        or lower(coalesce(l.metadata::text,'')) like '%'||v_query||'%'
      )
    order by l.performed_at desc
    limit greatest(1,least(coalesce(p_limit,200),500))
  ) x;
  return v_rows;
end;
$hhd$;

revoke all on function public.hhd_list_allocatable_employees(text) from public, anon;
revoke all on function public.hhd_admin_list_onroll_employees(text) from public, anon;
revoke all on function public.hhd_admin_assign_role_sites(uuid,text,text[]) from public, anon;
revoke all on function public.hhd_sto_create_dispatch(text,text,text[],text) from public, anon;
revoke all on function public.hhd_sto_receive_device(uuid,text,text,text) from public, anon;
revoke all on function public.hhd_sto_list(text,integer) from public, anon;
revoke all on function public.hhd_list_device_movement_ledger(text,text,integer) from public, anon;

grant execute on function public.hhd_list_allocatable_employees(text) to authenticated;
grant execute on function public.hhd_admin_list_onroll_employees(text) to authenticated;
grant execute on function public.hhd_admin_assign_role_sites(uuid,text,text[]) to authenticated;
grant execute on function public.hhd_sto_create_dispatch(text,text,text[],text) to authenticated;
grant execute on function public.hhd_sto_receive_device(uuid,text,text,text) to authenticated;
grant execute on function public.hhd_sto_list(text,integer) to authenticated;
grant execute on function public.hhd_list_device_movement_ledger(text,text,integer) to authenticated;

commit;
notify pgrst, 'reload schema';
