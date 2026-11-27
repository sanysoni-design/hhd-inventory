-- HHD Tracking: controlled STO request, approval, dispatch and receipt workflow
begin;

alter table public.sto_headers
  drop constraint if exists sto_headers_check,
  drop constraint if exists sto_headers_status_check;
alter table public.sto_headers
  add column if not exists from_department text not null default 'operations',
  add column if not exists to_department text not null default 'operations',
  add column if not exists approval_required boolean not null default false,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_role_code text,
  add column if not exists approval_notes text,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text;
alter table public.sto_headers
  alter column dispatched_at drop not null,
  alter column dispatched_at drop default,
  add constraint sto_headers_status_check
    check (status in ('pending_approval','approved','rejected','dispatched','partially_received','received','cancelled')),
  add constraint sto_headers_from_department_check
    check (from_department in ('operations','it','superstore')),
  add constraint sto_headers_to_department_check
    check (to_department in ('operations','it','superstore'));

alter table public.sto_lines drop constraint if exists sto_lines_status_check;
alter table public.sto_lines
  add constraint sto_lines_status_check
    check (status in ('pending_approval','approved','rejected','dispatched','received'));

update public.sto_headers
   set from_department=coalesce(from_department,'operations'),
       to_department=coalesce(to_department,'operations'),
       approval_required=coalesce(approval_required,false)
 where true;

create index if not exists sto_headers_from_site_status_idx
  on public.sto_headers(from_site_code,status,created_at desc);
create index if not exists sto_headers_to_site_status_idx
  on public.sto_headers(to_site_code,status,created_at desc);

-- Asset Manager creates a request only. Site IT remains untouched until approval and dispatch.
create or replace function public.hhd_sto_create_request(
  p_from_site_code text,p_to_site_code text,p_to_department text,
  p_scans text[],p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_sto_id uuid;
  v_sto_number text;
  v_scan text;
  v_serial text;
  v_imei text;
  v_matches integer;
  v_pos public.device_stock_positions%rowtype;
  v_status text;
  v_approval_required boolean;
  v_count integer:=0;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_to_department not in ('it','operations','superstore') then
    raise exception 'Select a valid receiving department';
  end if;
  if not exists(select 1 from public.sites where "Site"=p_from_site_code)
     or not exists(select 1 from public.sites where "Site"=p_to_site_code) then
    raise exception 'Unknown source or destination site';
  end if;
  if p_from_site_code=p_to_site_code and p_to_department<>'it' then
    raise exception 'Same-site STO is supported only for transfer from Operations to Site IT';
  end if;
  if not public.hhd_has_permission('sto','create',p_from_site_code) then
    raise exception 'Forbidden: only Asset Manager or Admin can create an STO request';
  end if;
  if coalesce(array_length(p_scans,1),0)=0 or array_length(p_scans,1)>100 then
    raise exception 'Scan between 1 and 100 devices before creating an STO';
  end if;

  v_approval_required:=p_to_department='it';
  v_status:=case when v_approval_required then 'pending_approval' else 'approved' end;
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_from_site_code)),71023));
  v_sto_number:='STO-'||to_char(now(),'YYYYMMDD')||'-'||
    upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));

  insert into public.sto_headers(
    sto_number,from_site_code,to_site_code,from_department,to_department,
    status,approval_required,notes,created_by,dispatched_at
  ) values(
    v_sto_number,p_from_site_code,p_to_site_code,'operations',p_to_department,
    v_status,v_approval_required,nullif(trim(p_notes),''),v_actor,null
  ) returning id into v_sto_id;

  foreach v_scan in array p_scans loop
    if nullif(trim(v_scan),'') is null then raise exception 'Blank device scan is not allowed'; end if;
    v_serial:=null; v_imei:=null;
    select d."Serial",d.imei_number into v_serial,v_imei
      from public.devices d where upper(d."Serial")=upper(trim(v_scan)) limit 1;
    if v_serial is null then
      select count(*) into v_matches from public.devices d
       where upper(coalesce(d.imei_number,''))=upper(trim(v_scan));
      if v_matches=0 then raise exception 'Device Serial / IMEI not found: %',v_scan; end if;
      if v_matches>1 then raise exception 'IMEI is not unique: %. Resolve the duplicate device records first.',v_scan; end if;
      select d."Serial",d.imei_number into v_serial,v_imei
        from public.devices d where upper(d.imei_number)=upper(trim(v_scan)) limit 1;
    end if;

    if exists(
      select 1 from public.sto_lines sl
      join public.sto_headers sh on sh.id=sl.sto_id
      where sl.device_serial=v_serial
        and sh.status in ('pending_approval','approved','dispatched','partially_received')
    ) then raise exception 'Device % is already in an open STO',v_serial; end if;

    select * into v_pos from public.device_stock_positions
     where device_serial=v_serial for update;
    if not found or v_pos.site_code<>p_from_site_code
       or v_pos.owner_department<>'operations' or v_pos.stock_state<>'available'
       or v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working'
       or v_pos.current_holder_employee_id is not null or v_pos.current_holder_type is not null then
      raise exception 'Device % must be Good + Working, unheld and Available in Operations inventory',v_serial;
    end if;
    if (select count(*) from public.device_assignments da
         where da.device_serial=v_serial and da.status='active')>1 then
      raise exception 'Device % has more than one active virtual custodian assignment. Reconcile before STO.',v_serial;
    end if;

    insert into public.sto_lines(sto_id,device_serial,imei_number,status)
    values(v_sto_id,v_serial,v_imei,v_status);
    v_count:=v_count+1;
  end loop;

  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'sto.request_created','sto',v_sto_id::text,p_from_site_code,
    jsonb_build_object('sto_number',v_sto_number,'from_site',p_from_site_code,
      'to_site',p_to_site_code,'from_department','operations','to_department',p_to_department,
      'device_count',v_count,'approval_required',v_approval_required),
    coalesce(nullif(trim(p_notes),''),'STO request created; physical dispatch not yet performed')
  );
  return jsonb_build_object(
    'sto_id',v_sto_id,'sto_number',v_sto_number,'status',v_status,
    'approval_required',v_approval_required,'from_site_code',p_from_site_code,
    'to_site_code',p_to_site_code,'from_department','operations',
    'to_department',p_to_department,'device_count',v_count
  );
end;
$$;

-- Approver must hold a live Custodian or Allocator role at the source site.
-- A Custodian can approve only devices assigned virtually to their own Employee ID; an Allocator can approve a batch.
create or replace function public.hhd_sto_approve(
  p_sto_id uuid,p_approval_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_header public.sto_headers%rowtype;
  v_role text;
  v_employee_id text;
  v_line record;
  v_pos public.device_stock_positions%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_header from public.sto_headers where id=p_sto_id for update;
  if not found then raise exception 'STO request not found'; end if;
  if v_header.status<>'pending_approval' or not v_header.approval_required
     or v_header.to_department<>'it' then
    raise exception 'This STO is not pending Custodian / Allocator approval';
  end if;
  if not public.hhd_has_permission('sto','approve',v_header.from_site_code) then
    raise exception 'Forbidden: STO approval is not permitted for this site';
  end if;

  select ura.role_code into v_role
    from public.user_role_assignments ura
    join public.app_roles ar on ar.role_code=ura.role_code and ar.is_active
   where ura.user_id=v_actor and ura.is_active
     and ura.role_code in ('site_lead','assigned_employee')
     and (ura.valid_until is null or ura.valid_until>now())
     and (ura.valid_from is null or ura.valid_from<=now())
     and (ura.site_code='*' or lower(ura.site_code)=lower(v_header.from_site_code))
   order by case ura.role_code when 'site_lead' then 1 else 2 end
   limit 1;
  if v_role is null then raise exception 'Only the assigned Custodian or Allocator can approve an STO to Site IT'; end if;

  if v_role='assigned_employee' then
    select employee_id into v_employee_id from public.app_users
     where user_id=v_actor and account_status='active';
    if v_employee_id is null then raise exception 'Custodian login is not linked to an Employee ID'; end if;
    if exists(
      select 1 from public.sto_lines sl
      left join public.device_assignments da
        on da.device_serial=sl.device_serial and da.status='active'
      where sl.sto_id=p_sto_id
        and (da.id is null or da.employee_id<>v_employee_id)
    ) then
      raise exception 'Custodian approval is limited to STO devices under their own virtual responsibility. Ask the Allocator to approve this batch.';
    end if;
  end if;

  for v_line in select * from public.sto_lines where sto_id=p_sto_id for update loop
    select * into v_pos from public.device_stock_positions
     where device_serial=v_line.device_serial for update;
    if not found or v_pos.site_code<>v_header.from_site_code
       or v_pos.owner_department<>'operations' or v_pos.stock_state<>'available'
       or v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working'
       or v_pos.current_holder_employee_id is not null or v_pos.current_holder_type is not null then
      raise exception 'Device % is no longer eligible. It must be returned to Operations inventory before approval.',v_line.device_serial;
    end if;
  end loop;

  update public.sto_headers
     set status='approved',approved_by=v_actor,approved_at=now(),
         approval_role_code=v_role,approval_notes=nullif(trim(p_approval_notes),''),
         updated_at=now()
   where id=p_sto_id;
  update public.sto_lines set status='approved' where sto_id=p_sto_id;
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'sto.approved','sto',p_sto_id::text,v_header.from_site_code,
    jsonb_build_object('sto_number',v_header.sto_number,'approver_role',v_role,
      'to_department',v_header.to_department),
    coalesce(nullif(trim(p_approval_notes),''),'STO approved by '||case when v_role='site_lead' then 'Allocator' else 'Custodian' end)
  );
  return jsonb_build_object('sto_id',p_sto_id,'sto_number',v_header.sto_number,
    'status','approved','approved_by_role',v_role);
end;
$$;

create or replace function public.hhd_sto_reject(
  p_sto_id uuid,p_rejection_reason text
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_header public.sto_headers%rowtype;
  v_role text;
  v_employee_id text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_rejection_reason),'') is null then raise exception 'Rejection reason is mandatory'; end if;
  select * into v_header from public.sto_headers where id=p_sto_id for update;
  if not found then raise exception 'STO request not found'; end if;
  if v_header.status<>'pending_approval' or not v_header.approval_required then
    raise exception 'This STO is not pending approval';
  end if;
  if not public.hhd_has_permission('sto','approve',v_header.from_site_code) then
    raise exception 'Forbidden: STO approval is not permitted for this site';
  end if;
  select ura.role_code into v_role
    from public.user_role_assignments ura
    join public.app_roles ar on ar.role_code=ura.role_code and ar.is_active
   where ura.user_id=v_actor and ura.is_active
     and ura.role_code in ('site_lead','assigned_employee')
     and (ura.valid_until is null or ura.valid_until>now())
     and (ura.valid_from is null or ura.valid_from<=now())
     and (ura.site_code='*' or lower(ura.site_code)=lower(v_header.from_site_code))
   order by case ura.role_code when 'site_lead' then 1 else 2 end
   limit 1;
  if v_role is null then raise exception 'Only the Custodian or Allocator can reject an STO to Site IT'; end if;
  if v_role='assigned_employee' then
    select employee_id into v_employee_id from public.app_users
     where user_id=v_actor and account_status='active';
    if v_employee_id is null or exists(
      select 1 from public.sto_lines sl
      left join public.device_assignments da on da.device_serial=sl.device_serial and da.status='active'
      where sl.sto_id=p_sto_id and (da.id is null or da.employee_id<>v_employee_id)
    ) then
      raise exception 'Custodian can reject only an STO containing devices under their own virtual responsibility';
    end if;
  end if;
  update public.sto_headers
     set status='rejected',rejected_by=v_actor,rejected_at=now(),
         approval_role_code=v_role,rejection_reason=trim(p_rejection_reason),
         updated_at=now()
   where id=p_sto_id;
  update public.sto_lines set status='rejected' where sto_id=p_sto_id;
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'sto.rejected','sto',p_sto_id::text,v_header.from_site_code,
    jsonb_build_object('sto_number',v_header.sto_number,'approver_role',v_role),
    trim(p_rejection_reason)
  );
  return jsonb_build_object('sto_id',p_sto_id,'sto_number',v_header.sto_number,'status','rejected');
end;
$$;

-- Asset Manager dispatches only after approval. This is the point where physical inventory moves to transit
-- and the virtual custodian responsibility is ended.
create or replace function public.hhd_sto_dispatch(
  p_sto_id uuid,p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_header public.sto_headers%rowtype;
  v_line public.sto_lines%rowtype;
  v_pos public.device_stock_positions%rowtype;
  v_assignment public.device_assignments%rowtype;
  v_assignment_count integer;
  v_count integer:=0;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_header from public.sto_headers where id=p_sto_id for update;
  if not found then raise exception 'STO not found'; end if;
  if not public.hhd_has_permission('sto','dispatch',v_header.from_site_code) then
    raise exception 'Forbidden: only Asset Manager or Admin can physically dispatch an STO';
  end if;
  if v_header.status<>'approved' then
    raise exception 'STO must be approved before dispatch. Current status: %',v_header.status;
  end if;

  for v_line in select * from public.sto_lines where sto_id=p_sto_id for update loop
    select * into v_pos from public.device_stock_positions
     where device_serial=v_line.device_serial for update;
    if not found or v_pos.site_code<>v_header.from_site_code
       or v_pos.owner_department<>'operations' or v_pos.stock_state<>'available'
       or v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working'
       or v_pos.current_holder_employee_id is not null or v_pos.current_holder_type is not null then
      raise exception 'Device % is no longer available in Operations inventory. STO dispatch cancelled.',v_line.device_serial;
    end if;
    select count(*)::integer into v_assignment_count from public.device_assignments
     where device_serial=v_line.device_serial and status='active';
    if v_assignment_count>1 then raise exception 'Device % has multiple active virtual custodian links. Reconcile before dispatch.',v_line.device_serial; end if;
    if v_assignment_count=1 then
      select * into v_assignment from public.device_assignments
       where device_serial=v_line.device_serial and status='active'
       order by assigned_at desc limit 1 for update;
      update public.device_assignments
         set status='returned',returned_by=v_actor,returned_at=now(),
             return_physical_condition=v_pos.physical_condition,
             return_functional_condition=v_pos.functional_condition,
             return_notes=coalesce(nullif(trim(p_notes),''),'Virtual responsibility ended by approved STO '||v_header.sto_number)
       where id=v_assignment.id;
    end if;

    update public.device_stock_positions
       set owner_department='in_transit',stock_state='in_transit',
           current_holder_employee_id=null,current_holder_type=null,
           location_code=v_header.to_site_code,
           last_reference_type='sto',last_reference_id=p_sto_id::text,
           updated_by=v_actor,updated_at=now()
     where device_serial=v_line.device_serial;
    insert into public.device_movement_ledger(
      device_serial,imei_number,event_type,from_department,to_department,
      from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,
      reference_type,reference_id,physical_condition,functional_condition,
      notes,performed_by,metadata
    ) values(
      v_line.device_serial,v_line.imei_number,'sto_dispatched','operations','in_transit',
      case when v_assignment.id is not null then 'virtual_custodian' else 'operations_inventory' end,
      case when v_assignment.id is not null then v_assignment.employee_id else v_header.from_site_code end,
      'in_transit',v_header.sto_number,v_header.from_site_code,'sto',p_sto_id::text,
      v_pos.physical_condition,v_pos.functional_condition,
      coalesce(nullif(trim(p_notes),''),v_header.notes),v_actor,
      jsonb_build_object('sto_number',v_header.sto_number,'destination_site',v_header.to_site_code,
        'destination_department',v_header.to_department,'custodian_assignment_closed',v_assignment.id)
    );
    update public.sto_lines set status='dispatched' where id=v_line.id;
    v_count:=v_count+1;
    v_assignment.id:=null;
    v_assignment.employee_id:=null;
  end loop;

  update public.sto_headers
     set status='dispatched',dispatched_by=v_actor,dispatched_at=now(),updated_at=now()
   where id=p_sto_id;
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'sto.dispatched','sto',p_sto_id::text,v_header.from_site_code,
    jsonb_build_object('sto_number',v_header.sto_number,'device_count',v_count,
      'to_site',v_header.to_site_code,'to_department',v_header.to_department,
      'approved_by',v_header.approved_by,'approved_role',v_header.approval_role_code),
    coalesce(nullif(trim(p_notes),''),'Approved STO physically dispatched by Asset Manager')
  );
  return jsonb_build_object('sto_id',p_sto_id,'sto_number',v_header.sto_number,
    'status','dispatched','device_count',v_count);
end;
$$;

-- Destination department is fixed by the request; Site IT cannot choose a different owner at receipt.
create or replace function public.hhd_sto_receive_device(
  p_sto_id uuid,p_scan_value text,p_destination_department text default 'operations',
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_header public.sto_headers%rowtype;
  v_line public.sto_lines%rowtype;
  v_serial text;
  v_pos public.device_stock_positions%rowtype;
  v_remaining integer;
  v_stock_state text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_header from public.sto_headers where id=p_sto_id for update;
  if not found then raise exception 'STO not found'; end if;
  if not public.hhd_has_permission('sto','receive',v_header.to_site_code) then
    raise exception 'Forbidden: destination-site STO receiving permission required';
  end if;
  if p_destination_department is distinct from v_header.to_department then
    raise exception 'Receiving department is fixed by the approved STO as %. It cannot be changed at receipt.',v_header.to_department;
  end if;
  if v_header.status not in ('dispatched','partially_received') then
    raise exception 'STO is not open for receipt';
  end if;

  select d."Serial" into v_serial from public.devices d
   where upper(d."Serial")=upper(trim(p_scan_value)) limit 1;
  if v_serial is null then
    if (select count(*) from public.devices d where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value)))<>1 then
      raise exception 'IMEI does not resolve to exactly one device';
    end if;
    select d."Serial" into v_serial from public.devices d
     where upper(d.imei_number)=upper(trim(p_scan_value)) limit 1;
  end if;
  select * into v_line from public.sto_lines
   where sto_id=p_sto_id and device_serial=v_serial for update;
  if not found then raise exception 'Scanned device is not listed in this STO'; end if;
  if v_line.status='received' then raise exception 'Device has already been received'; end if;
  if v_line.status<>'dispatched' then raise exception 'Device line has not been dispatched'; end if;
  select * into v_pos from public.device_stock_positions
   where device_serial=v_serial for update;
  if not found or v_pos.owner_department<>'in_transit' or v_pos.stock_state<>'in_transit' then
    raise exception 'Device is not currently in transit';
  end if;
  v_stock_state:=case when v_pos.physical_condition='good' and v_pos.functional_condition='working'
                      then 'available' else 'quarantined' end;
  update public.device_stock_positions
     set site_code=v_header.to_site_code,owner_department=v_header.to_department,
         stock_state=v_stock_state,current_holder_employee_id=null,current_holder_type=null,
         location_code=v_header.to_site_code,last_reference_type='sto',
         last_reference_id=v_header.id::text,updated_by=v_actor,updated_at=now()
   where device_serial=v_serial;
  update public.sto_lines
     set status='received',received_department=v_header.to_department,
         received_by=v_actor,received_at=now(),received_notes=nullif(trim(p_notes),'')
   where id=v_line.id;
  insert into public.device_movement_ledger(
    device_serial,imei_number,event_type,from_department,to_department,
    site_code,reference_type,reference_id,physical_condition,functional_condition,
    notes,performed_by,metadata
  ) values(
    v_serial,v_line.imei_number,'sto_received','in_transit',v_header.to_department,
    v_header.to_site_code,'sto',v_header.id::text,
    v_pos.physical_condition,v_pos.functional_condition,p_notes,v_actor,
    jsonb_build_object('sto_number',v_header.sto_number,'source_site',v_header.from_site_code,
      'destination_site',v_header.to_site_code,'receiving_department',v_header.to_department,
      'received_stock_state',v_stock_state)
  );
  select count(*) into v_remaining from public.sto_lines
   where sto_id=p_sto_id and status<>'received';
  update public.sto_headers
     set status=case when v_remaining=0 then 'received' else 'partially_received' end,
         received_at=case when v_remaining=0 then now() else received_at end,updated_at=now()
   where id=p_sto_id;
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'sto.receive_device','sto_line',v_line.id::text,v_header.to_site_code,
    jsonb_build_object('sto_id',v_header.id,'sto_number',v_header.sto_number,
      'device_serial',v_serial,'imei_number',v_line.imei_number,
      'receiving_department',v_header.to_department,'stock_state',v_stock_state),
    coalesce(nullif(trim(p_notes),''),'Device received against approved STO')
  );
  return jsonb_build_object('sto_id',v_header.id,'sto_number',v_header.sto_number,
    'device_serial',v_serial,'imei_number',v_line.imei_number,
    'status',case when v_remaining=0 then 'received' else 'partially_received' end,
    'remaining_devices',v_remaining,'to_department',v_header.to_department);
end;
$$;

create or replace function public.hhd_sto_list(p_site_code text,p_limit integer default 100)
returns jsonb
language plpgsql
stable security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_scope text;
  v_employee_id text;
  v_rows jsonb;
begin
  v_scope:=coalesce(
    public.hhd_permission_scope('sto','view',p_site_code),
    public.hhd_permission_scope('sto','approve',p_site_code),
    public.hhd_permission_scope('sto','receive',p_site_code),
    public.hhd_permission_scope('sto','dispatch',p_site_code),
    public.hhd_permission_scope('sto','create',p_site_code)
  );
  if v_scope is null then raise exception 'Forbidden: STO access denied'; end if;
  select employee_id into v_employee_id from public.app_users
   where user_id=auth.uid() and account_status='active';

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
    into v_rows
    from (
      select sh.id,sh.sto_number,sh.from_site_code,sh.to_site_code,
             sh.from_department,sh.to_department,sh.status,sh.approval_required,
             sh.approved_by,approver.full_name as approved_by_name,sh.approved_at,
             sh.approval_role_code,sh.approval_notes,sh.rejected_by,sh.rejected_at,
             sh.rejection_reason,sh.created_by,creator.full_name as created_by_name,
             sh.created_at,sh.dispatched_at,sh.received_at,
             sh.dispatched_by,sh.notes,
             (select count(*)::integer from public.sto_lines sl where sl.sto_id=sh.id) as device_count,
             (select count(*)::integer from public.sto_lines sl where sl.sto_id=sh.id and sl.status='received') as received_count,
             (select coalesce(jsonb_agg(jsonb_build_object(
                'id',sl.id,'device_serial',sl.device_serial,'imei_number',sl.imei_number,
                'status',sl.status,'received_department',sl.received_department,
                'received_at',sl.received_at,'received_notes',sl.received_notes
              ) order by sl.created_at),'[]'::jsonb)
                from public.sto_lines sl where sl.sto_id=sh.id) as lines
        from public.sto_headers sh
        left join public.app_users approver on approver.user_id=sh.approved_by
        left join public.app_users creator on creator.user_id=sh.created_by
       where (sh.from_site_code=p_site_code or sh.to_site_code=p_site_code)
         and (
           v_scope<>'own'
           or sh.created_by=auth.uid()
           or (
             sh.status='pending_approval'
             and public.hhd_has_permission('sto','approve',sh.from_site_code)
             and (
               exists(select 1 from public.user_role_assignments ura
                       where ura.user_id=auth.uid() and ura.is_active and ura.role_code='site_lead'
                         and (ura.valid_until is null or ura.valid_until>now())
                         and (ura.site_code='*' or lower(ura.site_code)=lower(sh.from_site_code)))
               or (
                 v_employee_id is not null
                 and exists(select 1 from public.user_role_assignments ura
                             where ura.user_id=auth.uid() and ura.is_active and ura.role_code='assigned_employee'
                               and (ura.valid_until is null or ura.valid_until>now())
                               and (ura.site_code='*' or lower(ura.site_code)=lower(sh.from_site_code)))
                 and not exists(
                   select 1 from public.sto_lines sl
                   left join public.device_assignments da
                     on da.device_serial=sl.device_serial and da.status='active'
                   where sl.sto_id=sh.id
                     and (da.id is null or da.employee_id<>v_employee_id)
                 )
               )
             )
           )
         )
       order by sh.created_at desc
       limit greatest(1,least(coalesce(p_limit,100),250))
    ) x;
  return v_rows;
end;
$$;

-- The legacy combined create+dispatch route would bypass the approval gate.
revoke all on function public.hhd_sto_create_dispatch(text,text,text[],text) from public,anon,authenticated;
revoke all on function public.hhd_sto_create_request(text,text,text,text[],text) from public,anon,authenticated;
revoke all on function public.hhd_sto_approve(uuid,text) from public,anon,authenticated;
revoke all on function public.hhd_sto_reject(uuid,text) from public,anon,authenticated;
revoke all on function public.hhd_sto_dispatch(uuid,text) from public,anon,authenticated;
revoke all on function public.hhd_sto_receive_device(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_sto_list(text,integer) from public,anon,authenticated;

grant execute on function public.hhd_sto_create_request(text,text,text,text[],text) to authenticated;
grant execute on function public.hhd_sto_approve(uuid,text) to authenticated;
grant execute on function public.hhd_sto_reject(uuid,text) to authenticated;
grant execute on function public.hhd_sto_dispatch(uuid,text) to authenticated;
grant execute on function public.hhd_sto_receive_device(uuid,text,text,text) to authenticated;
grant execute on function public.hhd_sto_list(text,integer) to authenticated;

commit;
