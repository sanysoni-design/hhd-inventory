begin;

-- HOTO wizard: support a device moving into IT custody and audit controlled
-- manual GC/TL overrides without writing those overrides into the HR master.
alter table public.hoto_transactions
  alter column from_holder_employee_id drop not null,
  alter column to_holder_employee_id drop not null;

alter table public.hoto_transactions
  drop constraint if exists hoto_transactions_from_holder_type_check,
  drop constraint if exists hoto_transactions_to_holder_type_check;

alter table public.hoto_transactions
  add constraint hoto_transactions_from_holder_type_check
    check (from_holder_type = any (array['onroll','offroll','it']::text[])),
  add constraint hoto_transactions_to_holder_type_check
    check (to_holder_type = any (array['onroll','offroll','it']::text[]));

alter table public.hoto_transactions
  add column if not exists from_holder_name text,
  add column if not exists to_holder_name text,
  add column if not exists worker_validation_source text not null default 'hr_master',
  add column if not exists manual_override_reason text,
  add column if not exists manual_override_by uuid references auth.users(id) on delete set null,
  add column if not exists manual_override_at timestamptz;

alter table public.hoto_transactions
  drop constraint if exists hoto_transactions_worker_validation_source_check;

alter table public.hoto_transactions
  add constraint hoto_transactions_worker_validation_source_check
  check (worker_validation_source = any (array['hr_master','manual_override','system']::text[]));

update public.hoto_transactions h
set to_holder_name = coalesce(h.to_holder_name, w.employee_name)
from public.offroll_worker_master w
where h.to_holder_type = 'offroll'
  and upper(h.to_holder_employee_id) = upper(w.employee_id)
  and h.site_code = w.site_code
  and h.to_holder_name is null;

update public.hoto_transactions h
set from_holder_name = coalesce(h.from_holder_name, w.employee_name)
from public.offroll_worker_master w
where h.from_holder_type = 'offroll'
  and upper(h.from_holder_employee_id) = upper(w.employee_id)
  and h.site_code = w.site_code
  and h.from_holder_name is null;

-- A worker must not receive a second active HHD. This RPC is only a pre-check;
-- the transaction RPC below repeats the check while holding row locks.
create or replace function public.hhd_hoto_validate_worker(
  p_employee_id text,
  p_site_code text,
  p_action text default 'handover'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_worker public.offroll_worker_master%rowtype;
  v_active record;
  v_permission text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_action not in ('handover','mid_shift_swap') then raise exception 'Unsupported HOTO worker validation action'; end if;
  v_permission := case when p_action = 'mid_shift_swap' then 'swap' else 'create' end;
  if not public.hhd_has_permission('hoto', v_permission, p_site_code) then
    raise exception 'Forbidden: HOTO worker validation is not permitted for this site';
  end if;
  if nullif(trim(p_employee_id),'') is null then
    return jsonb_build_object('valid',false,'available',false,'reason','Enter or scan a GC / TL ID.');
  end if;

  select * into v_worker
  from public.offroll_worker_master w
  where upper(w.employee_id)=upper(trim(p_employee_id))
    and w.site_code=p_site_code
    and w.employment_status='active'
  order by w.last_synced_at desc
  limit 1;

  if not found then
    return jsonb_build_object('valid',false,'available',false,'reason','GC / TL ID is not active in the HR master for this site.');
  end if;
  if v_worker.last_synced_at is null or v_worker.last_synced_at < now() - interval '26 hours' then
    return jsonb_build_object('valid',false,'available',false,'reason','HR worker master is stale. Verify the worker manually or run HR synchronization.');
  end if;

  select p.device_serial, d.imei_number, d."Model" as model
  into v_active
  from public.device_stock_positions p
  join public.devices d on d."Serial"=p.device_serial
  where p.site_code=p_site_code
    and p.stock_state='assigned'
    and p.current_holder_type='offroll'
    and upper(p.current_holder_employee_id)=upper(v_worker.employee_id)
  order by p.updated_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'valid',true,
      'available',false,
      'reason','This GC / TL already has an HHD.',
      'worker',jsonb_build_object('employee_id',v_worker.employee_id,'employee_name',v_worker.employee_name,'worker_type',v_worker.worker_type,'site_code',v_worker.site_code,'process',v_worker.process),
      'active_device',jsonb_build_object('serial',v_active.device_serial,'imei',v_active.imei_number,'model',v_active.model)
    );
  end if;

  return jsonb_build_object(
    'valid',true,
    'available',true,
    'worker',jsonb_build_object('employee_id',v_worker.employee_id,'employee_name',v_worker.employee_name,'worker_type',v_worker.worker_type,'site_code',v_worker.site_code,'process',v_worker.process)
  );
end;
$function$;

-- Resolve an IMEI or asset Serial and return the current custodian/holder before
-- the UI proceeds. The write RPCs repeat all critical checks transactionally.
create or replace function public.hhd_hoto_resolve_device(
  p_scan_value text,
  p_site_code text,
  p_action text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_serial text;
  v_matches integer;
  v_device public.devices%rowtype;
  v_pos public.device_stock_positions%rowtype;
  v_assignment public.device_assignments%rowtype;
  v_holder_name text;
  v_holder_type text;
  v_worker_type text;
  v_permission text;
  v_reason text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_action not in ('handover','takeover','mid_shift_swap') then raise exception 'Unsupported HOTO action'; end if;
  v_permission := case when p_action='takeover' then 'acknowledge' when p_action='mid_shift_swap' then 'swap' else 'create' end;
  if not public.hhd_has_permission('hoto',v_permission,p_site_code) then
    raise exception 'Forbidden: HOTO action is not permitted for this site';
  end if;
  if nullif(trim(p_scan_value),'') is null then
    return jsonb_build_object('valid',false,'reason','Scan or enter the HHD IMEI / barcode.');
  end if;

  select d."Serial" into v_serial
  from public.devices d
  where upper(d."Serial")=upper(trim(p_scan_value))
  limit 1;

  if v_serial is null then
    select count(*) into v_matches
    from public.devices d
    where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value));
    if v_matches <> 1 then
      return jsonb_build_object('valid',false,'reason',case when v_matches=0 then 'HHD barcode was not found in the device master.' else 'This IMEI matches more than one device. Use the unique HHD Serial or resolve the duplicate IMEI records.' end);
    end if;
    select d."Serial" into v_serial
    from public.devices d
    where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value))
    limit 1;
  end if;

  select * into v_device from public.devices d where d."Serial"=v_serial;
  select * into v_pos from public.device_stock_positions p where p.device_serial=v_serial;
  if not found then
    return jsonb_build_object('valid',false,'reason','No stock position exists for this HHD. Ask IT to reconcile the device before HOTO.');
  end if;
  if v_pos.site_code<>p_site_code then
    return jsonb_build_object('valid',false,'reason','This HHD is not registered at the currently selected site.');
  end if;
  select * into v_assignment
  from public.device_assignments da
  where da.device_serial=v_serial and da.site_code=p_site_code and da.status='active'
  order by da.assigned_at desc
  limit 1;
  if not found then
    return jsonb_build_object('valid',false,'reason','This HHD is not allocated to an active primary custodian. It cannot be handed to a GC / TL.');
  end if;

  if v_pos.current_holder_type='offroll' then
    select coalesce(w.employee_name,h.to_holder_name,v_pos.current_holder_employee_id),
           coalesce(w.worker_type,h.offroll_worker_type)
    into v_holder_name,v_worker_type
    from (select 1) seed
    left join public.offroll_worker_master w
      on upper(w.employee_id)=upper(v_pos.current_holder_employee_id) and w.site_code=p_site_code
    left join lateral (
      select ht.to_holder_name,ht.offroll_worker_type
      from public.hoto_transactions ht
      where ht.site_code=p_site_code and ht.device_serial=v_serial
        and ht.to_holder_type='offroll'
        and upper(ht.to_holder_employee_id)=upper(v_pos.current_holder_employee_id)
      order by ht.performed_at desc limit 1
    ) h on true;
    v_holder_type := 'offroll';
  elsif v_pos.current_holder_type='onroll' then
    select e.employee_name into v_holder_name
    from public.onroll_employee_master e
    where upper(e.employee_id)=upper(v_pos.current_holder_employee_id)
    limit 1;
    v_holder_type := 'onroll';
  elsif v_pos.owner_department='it' and v_pos.stock_state='available' then
    v_holder_name := 'IT Department';
    v_holder_type := 'it';
  else
    v_holder_type := coalesce(v_pos.current_holder_type,'unknown');
    v_holder_name := v_pos.current_holder_employee_id;
  end if;

  if p_action='handover' then
    if v_pos.current_holder_type='offroll' then
      return jsonb_build_object(
        'valid',true,'requires_swap',true,
        'device',jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,'make',v_device."Make",'model',v_device."Model",'physical_condition',v_pos.physical_condition,'functional_condition',v_pos.functional_condition,'primary_employee_id',v_assignment.employee_id),
        'current_holder',jsonb_build_object('employee_id',v_pos.current_holder_employee_id,'employee_name',v_holder_name,'worker_type',v_worker_type)
      );
    end if;
    if not ((v_pos.owner_department='operations' and v_pos.stock_state='assigned' and v_pos.current_holder_type='onroll' and v_pos.current_holder_employee_id=v_assignment.employee_id)
      or (v_pos.owner_department='it' and v_pos.stock_state='available' and v_pos.current_holder_type is null)) then
      return jsonb_build_object('valid',false,'reason','HHD is not in an eligible IT or primary-custodian position for handover.');
    end if;
    if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
      return jsonb_build_object('valid',false,'reason','Damaged or non-working HHD cannot be handed to a GC / TL. Return it to IT for inspection.');
    end if;
  elsif p_action='takeover' then
    if v_pos.current_holder_type is distinct from 'offroll' or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
      return jsonb_build_object('valid',false,'reason','This HHD is not currently held by a GC / TL. A takeover may already have been completed.');
    end if;
  elsif p_action='mid_shift_swap' then
    if v_pos.current_holder_type is distinct from 'offroll' or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
      return jsonb_build_object('valid',false,'reason','Mid-shift swap requires an HHD currently held by a GC / TL.');
    end if;
    if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
      return jsonb_build_object('valid',false,'reason','Damaged or non-working HHD cannot be transferred to another GC / TL.');
    end if;
  end if;

  return jsonb_build_object(
    'valid',true,'requires_swap',false,
    'device',jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,'make',v_device."Make",'model',v_device."Model",'physical_condition',v_pos.physical_condition,'functional_condition',v_pos.functional_condition,'primary_employee_id',v_assignment.employee_id),
    'current_holder',case when v_holder_type is null then null else jsonb_build_object('holder_type',v_holder_type,'employee_id',v_pos.current_holder_employee_id,'employee_name',coalesce(v_holder_name,v_pos.current_holder_employee_id),'worker_type',v_worker_type) end
  );
end;
$function$;

create or replace function public.hhd_hoto_record_transfer(
  p_device_serial text,
  p_offroll_employee_id text,
  p_site_code text,
  p_shift_code text,
  p_shift_date date default current_date,
  p_transaction_type text default 'handover',
  p_notes text default null,
  p_physical_condition text default 'good',
  p_functional_condition text default 'working',
  p_manual_override boolean default false,
  p_manual_worker_name text default null,
  p_manual_worker_type text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_serial text;
  v_assignment public.device_assignments%rowtype;
  v_pos public.device_stock_positions%rowtype;
  v_worker public.offroll_worker_master%rowtype;
  v_worker_id text;
  v_worker_name text;
  v_worker_type text;
  v_validation_source text := 'hr_master';
  v_permission text;
  v_from_type text;
  v_from_id text;
  v_from_name text;
  v_hoto_id uuid;
  v_matches integer;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_transaction_type not in ('handover','mid_shift_swap') then raise exception 'Only handover or mid-shift swap can issue an HHD'; end if;
  if p_shift_code not in ('A','B','C') then raise exception 'Shift must be A, B or C'; end if;
  if p_physical_condition<>'good' or p_functional_condition<>'working' then
    raise exception 'Only Good + Working HHDs can be handed to a TL/GC';
  end if;
  v_permission := case when p_transaction_type='mid_shift_swap' then 'swap' else 'create' end;
  if not public.hhd_has_permission('hoto',v_permission,p_site_code) then
    raise exception 'Forbidden: HOTO action requires site-level Operations or Admin scope';
  end if;
  v_worker_id := upper(trim(coalesce(p_offroll_employee_id,'')));
  if v_worker_id='' then raise exception 'Scan or enter the TL/GC Employee ID'; end if;

  select d."Serial" into v_serial from public.devices d
  where upper(d."Serial")=upper(trim(p_device_serial))
  limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial));
    if v_matches<>1 then raise exception 'IMEI does not resolve to exactly one device. Scan the unique asset Serial or resolve duplicate IMEI master records'; end if;
    select d."Serial" into v_serial from public.devices d where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial)) limit 1;
  end if;

  select * into v_assignment from public.device_assignments
  where device_serial=v_serial and site_code=p_site_code and status='active'
  order by assigned_at desc limit 1 for update;
  if not found then raise exception 'Device has no active primary on-roll employee assignment at this site'; end if;

  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.site_code<>p_site_code then raise exception 'Device is not registered at the selected site'; end if;

  if p_transaction_type='handover' then
    if v_pos.current_holder_type='offroll' then raise exception 'Device is currently held by another GC / TL. Use Mid-shift Swap'; end if;
    if not ((v_pos.owner_department='operations' and v_pos.stock_state='assigned' and v_pos.current_holder_type='onroll' and v_pos.current_holder_employee_id=v_assignment.employee_id)
      or (v_pos.owner_department='it' and v_pos.stock_state='available' and v_pos.current_holder_type is null)) then
      raise exception 'HHD is not in an eligible IT or primary-custodian position for handover';
    end if;
  else
    if v_pos.owner_department<>'operations' or v_pos.stock_state<>'assigned' or v_pos.current_holder_type<>'offroll' then
      raise exception 'Mid-shift swap requires a device currently held by a GC / TL';
    end if;
  end if;

  if p_manual_override then
    if nullif(trim(p_manual_worker_name),'') is null or p_manual_worker_type not in ('GC','TL') or nullif(trim(p_override_reason),'') is null then
      raise exception 'Manual override requires worker name, worker type and reason';
    end if;
    select * into v_worker from public.offroll_worker_master
    where upper(employee_id)=v_worker_id and site_code=p_site_code and employment_status='active'
    order by last_synced_at desc limit 1;
    if found and v_worker.last_synced_at is not null and v_worker.last_synced_at >= now() - interval '26 hours' then
      raise exception 'This GC / TL exists in the active HR master. Revalidate the master record instead of overriding it';
    end if;
    v_worker_name := trim(p_manual_worker_name);
    v_worker_type := p_manual_worker_type;
    v_validation_source := 'manual_override';
  else
    select * into v_worker from public.offroll_worker_master
    where upper(employee_id)=v_worker_id and site_code=p_site_code and employment_status='active'
    order by last_synced_at desc limit 1;
    if not found then raise exception 'TL/GC Employee ID is not active in the HR master for this site'; end if;
    if v_worker.last_synced_at is null or v_worker.last_synced_at < now() - interval '26 hours' then
      raise exception 'HR worker master is stale. Run HR Sheet synchronization or complete a documented manual override';
    end if;
    v_worker_name := v_worker.employee_name;
    v_worker_type := v_worker.worker_type;
  end if;

  if exists (
    select 1 from public.device_stock_positions p
    where p.site_code=p_site_code and p.stock_state='assigned'
      and p.current_holder_type='offroll'
      and upper(p.current_holder_employee_id)=v_worker_id
      and p.device_serial<>v_serial
  ) then
    raise exception 'This GC / TL is already holding another HHD. Complete takeover of the existing HHD first';
  end if;

  v_from_type := coalesce(v_pos.current_holder_type,case when v_pos.owner_department='it' then 'it' else null end);
  v_from_id := v_pos.current_holder_employee_id;
  if v_from_type is null then raise exception 'Current HHD custody is not recorded'; end if;
  if p_transaction_type='mid_shift_swap' and v_from_type<>'offroll' then raise exception 'Mid-shift swap requires a current GC / TL holder'; end if;
  if v_from_type='offroll' then
    select coalesce(w.employee_name,h.to_holder_name,v_from_id)
      into v_from_name
    from (select 1) seed
    left join public.offroll_worker_master w on upper(w.employee_id)=upper(v_from_id) and w.site_code=p_site_code
    left join lateral (
      select ht.to_holder_name from public.hoto_transactions ht
      where ht.site_code=p_site_code and ht.device_serial=v_serial
        and ht.to_holder_type='offroll' and upper(ht.to_holder_employee_id)=upper(v_from_id)
      order by ht.performed_at desc limit 1
    ) h on true;
  elsif v_from_type='onroll' then
    select e.employee_name into v_from_name from public.onroll_employee_master e where upper(e.employee_id)=upper(v_from_id) limit 1;
  else
    v_from_name := 'IT Department';
  end if;

  update public.device_stock_positions
  set owner_department='operations',stock_state='assigned',
      current_holder_employee_id=v_worker_id,current_holder_type='offroll',
      physical_condition=p_physical_condition,functional_condition=p_functional_condition,
      updated_by=v_actor,updated_at=now(),last_reference_type='hoto',last_reference_id=null
  where device_serial=v_serial;

  insert into public.hoto_transactions(
    site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,
    from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,offroll_worker_type,
    physical_condition,functional_condition,notes,performed_by,from_holder_name,to_holder_name,
    worker_validation_source,manual_override_reason,manual_override_by,manual_override_at
  )
  values(
    p_site_code,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,p_transaction_type,
    v_from_type,v_from_id,'offroll',v_worker_id,v_worker_type,
    p_physical_condition,p_functional_condition,nullif(trim(p_notes),''),v_actor,v_from_name,v_worker_name,
    v_validation_source,case when p_manual_override then trim(p_override_reason) end,
    case when p_manual_override then v_actor end,case when p_manual_override then now() end
  )
  returning id into v_hoto_id;

  update public.device_stock_positions set last_reference_id=v_hoto_id::text where device_serial=v_serial;

  insert into public.device_movement_ledger(
    device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,
    to_holder_type,to_holder_id,site_code,reference_type,reference_id,
    physical_condition,functional_condition,notes,performed_by
  )
  values(
    v_serial,'hoto_'||p_transaction_type,
    case when v_from_type='it' then 'it' else 'operations' end,'operations',
    v_from_type,v_from_id,'offroll',v_worker_id,p_site_code,'hoto',v_hoto_id::text,
    p_physical_condition,p_functional_condition,p_notes,v_actor
  );

  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
  values(v_actor,'hoto.'||p_transaction_type,'hoto_transaction',v_hoto_id::text,p_site_code,
    jsonb_build_object('serial',v_serial,'from_holder_type',v_from_type,'from_holder_id',v_from_id,
      'from_holder_name',v_from_name,'to_holder_type','offroll','to_holder_id',v_worker_id,
      'to_holder_name',v_worker_name,'worker_type',v_worker_type,'shift_code',p_shift_code,
      'validation_source',v_validation_source),
    coalesce(nullif(trim(p_notes),''),case when p_manual_override then trim(p_override_reason) else 'Shift HOTO recorded' end));

  if p_manual_override then
    insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
    values(v_actor,'hoto.manual_override','hoto_transaction',v_hoto_id::text,p_site_code,
      jsonb_build_object('worker_id',v_worker_id,'worker_name',v_worker_name,'worker_type',v_worker_type,
        'validation_source','manual_override','shift_code',p_shift_code),
      trim(p_override_reason));
  end if;

  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'site_code',p_site_code,
    'from_holder_type',v_from_type,'from_holder_id',v_from_id,'from_holder_name',v_from_name,
    'to_holder_type','offroll','to_holder_id',v_worker_id,'to_holder_name',v_worker_name,
    'worker_name',v_worker_name,'worker_type',v_worker_type,'shift_code',p_shift_code,
    'transaction_type',p_transaction_type,'worker_validation_source',v_validation_source);
end;
$function$;

-- Shift-end return: IT becomes the stock owner; good/working devices return to
-- available IT stock, while damaged/non-working devices enter IT quarantine.
create or replace function public.hhd_hoto_takeover_to_it(
  p_device_serial text,
  p_site_code text,
  p_shift_code text,
  p_shift_date date default current_date,
  p_physical_condition text default 'good',
  p_functional_condition text default 'working',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_serial text;
  v_matches integer;
  v_device public.devices%rowtype;
  v_assignment public.device_assignments%rowtype;
  v_pos public.device_stock_positions%rowtype;
  v_from_id text;
  v_from_name text;
  v_worker_type text;
  v_hoto_id uuid;
  v_stock_state text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_shift_code not in ('A','B','C') then raise exception 'Shift must be A, B or C'; end if;
  if p_physical_condition not in ('good','damaged') or p_functional_condition not in ('working','not_working') then
    raise exception 'Select a valid physical and functional condition';
  end if;
  if not public.hhd_has_permission('hoto','acknowledge',p_site_code) then
    raise exception 'Forbidden: HOTO takeover acknowledgement is denied';
  end if;

  select d."Serial" into v_serial from public.devices d where upper(d."Serial")=upper(trim(p_device_serial)) limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial));
    if v_matches<>1 then raise exception 'IMEI does not resolve to exactly one device'; end if;
    select d."Serial" into v_serial from public.devices d where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial)) limit 1;
  end if;
  select * into v_device from public.devices where "Serial"=v_serial;
  select * into v_assignment from public.device_assignments
  where device_serial=v_serial and site_code=p_site_code and status='active'
  order by assigned_at desc limit 1 for update;
  if not found then raise exception 'No active primary custodian allocation exists for this HHD'; end if;
  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.site_code<>p_site_code then raise exception 'HHD is not registered at the selected site'; end if;
  if v_pos.current_holder_type is distinct from 'offroll' or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
    raise exception 'This HHD is not currently held by a GC / TL. A takeover may already have been completed';
  end if;

  v_from_id := v_pos.current_holder_employee_id;
  select coalesce(w.employee_name,h.to_holder_name,v_from_id),coalesce(w.worker_type,h.offroll_worker_type)
  into v_from_name,v_worker_type
  from (select 1) seed
  left join public.offroll_worker_master w
    on upper(w.employee_id)=upper(v_from_id) and w.site_code=p_site_code
  left join lateral (
    select ht.to_holder_name,ht.offroll_worker_type
    from public.hoto_transactions ht
    where ht.site_code=p_site_code and ht.device_serial=v_serial
      and ht.to_holder_type='offroll' and upper(ht.to_holder_employee_id)=upper(v_from_id)
    order by ht.performed_at desc limit 1
  ) h on true;

  v_stock_state := case when p_physical_condition='good' and p_functional_condition='working' then 'available' else 'quarantined' end;
  update public.device_stock_positions
  set owner_department='it',stock_state=v_stock_state,
      current_holder_employee_id=null,current_holder_type=null,
      physical_condition=p_physical_condition,functional_condition=p_functional_condition,
      updated_by=v_actor,updated_at=now(),last_reference_type='hoto_takeover',last_reference_id=null
  where device_serial=v_serial;

  insert into public.hoto_transactions(
    site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,
    from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,offroll_worker_type,
    physical_condition,functional_condition,notes,performed_by,from_holder_name,to_holder_name,worker_validation_source
  )
  values(
    p_site_code,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,'takeover',
    'offroll',v_from_id,'it',null,v_worker_type,
    p_physical_condition,p_functional_condition,nullif(trim(p_notes),''),v_actor,v_from_name,'IT Department','system'
  )
  returning id into v_hoto_id;

  update public.device_stock_positions set last_reference_id=v_hoto_id::text where device_serial=v_serial;

  insert into public.device_movement_ledger(
    device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,
    to_holder_type,to_holder_id,site_code,reference_type,reference_id,
    physical_condition,functional_condition,notes,performed_by
  )
  values(
    v_serial,'hoto_takeover','operations','it','offroll',v_from_id,'it',null,p_site_code,
    'hoto',v_hoto_id::text,p_physical_condition,p_functional_condition,p_notes,v_actor
  );

  insert into public.admin_audit_events(actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason)
  values(v_actor,'hoto.takeover','hoto_transaction',v_hoto_id::text,p_site_code,
    jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,'from_holder_id',v_from_id,
      'from_holder_name',v_from_name,'to_department','it','stock_state',v_stock_state,
      'physical_condition',p_physical_condition,'functional_condition',p_functional_condition,'shift_code',p_shift_code),
    coalesce(nullif(trim(p_notes),''),'HHD received by IT at shift end'));

  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'imei',v_device.imei_number,
    'site_code',p_site_code,'from_holder_id',v_from_id,'from_holder_name',v_from_name,
    'to_department','it','stock_state',v_stock_state,'transaction_type','takeover','shift_code',p_shift_code);
end;
$function$;

create or replace function public.hhd_list_hoto_transactions(p_site_code text, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','auth','pg_temp'
as $function$
declare v_rows jsonb;
begin
  if not public.hhd_has_permission('hoto','view',p_site_code) then
    raise exception 'Forbidden: HOTO history access denied';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.performed_at desc),'[]'::jsonb) into v_rows
  from (
    select id,site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,
      from_holder_type,from_holder_employee_id,from_holder_name,to_holder_type,to_holder_employee_id,
      to_holder_name,offroll_worker_type,physical_condition,functional_condition,notes,performed_by,
      performed_at,worker_validation_source,manual_override_reason,manual_override_by,manual_override_at
    from public.hoto_transactions
    where site_code=p_site_code
    order by performed_at desc
    limit greatest(1,least(coalesce(p_limit,100),500))
  ) x;
  return v_rows;
end;
$function$;

revoke all on function public.hhd_hoto_validate_worker(text,text,text) from public, anon;
revoke all on function public.hhd_hoto_resolve_device(text,text,text) from public, anon;
revoke all on function public.hhd_hoto_record_transfer(text,text,text,text,date,text,text,text,text,boolean,text,text,text) from public, anon;
revoke all on function public.hhd_hoto_takeover_to_it(text,text,text,date,text,text,text) from public, anon;
grant execute on function public.hhd_hoto_validate_worker(text,text,text) to authenticated;
grant execute on function public.hhd_hoto_resolve_device(text,text,text) to authenticated;
grant execute on function public.hhd_hoto_record_transfer(text,text,text,text,date,text,text,text,text,boolean,text,text,text) to authenticated;
grant execute on function public.hhd_hoto_takeover_to_it(text,text,text,date,text,text,text) to authenticated;

commit;
