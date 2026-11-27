-- HHD Tracking: revised custody model, quantity increments, condition history and HOTO custody
begin;

-- HOTO is a physical transfer between Operations inventory and a GC/TL, never Site IT.
alter table public.hoto_transactions
  drop constraint if exists hoto_transactions_from_holder_type_check,
  drop constraint if exists hoto_transactions_to_holder_type_check;
alter table public.hoto_transactions
  add constraint hoto_transactions_from_holder_type_check
    check (from_holder_type in ('onroll','offroll','it','operations')),
  add constraint hoto_transactions_to_holder_type_check
    check (to_holder_type in ('onroll','offroll','it','operations'));

-- New permission gates.
insert into public.app_permissions
  (permission_code,module_code,module_name,action_code,action_name,description,sort_order,is_active)
values
  ('distribution.assign_device','distribution','Distribution','assign_device','Assign physical HHD','Asset Manager scans a physical Operations-stock HHD into a virtual custodian assignment.',35,true),
  ('sto.approve','sto','Stock Transfer Orders','approve','Approve STO','Custodian or Allocator approval for Operations-to-Site-IT transfers.',45,true),
  ('inventory.condition_history','inventory','Inventory','condition_history','View condition history','View device physical and functional condition change history and weekly trends.',55,true)
on conflict (permission_code) do update
set module_code=excluded.module_code,module_name=excluded.module_name,
    action_code=excluded.action_code,action_name=excluded.action_name,
    description=excluded.description,sort_order=excluded.sort_order,is_active=true;

-- The custodian is an accountable virtual owner. The physical stock always remains with Operations
-- until a HOTO handover to a GC/TL or a separately approved STO.
with migrated as materialized (
  select p.device_serial,p.site_code,p.owner_department,p.stock_state,
         p.current_holder_employee_id,p.current_holder_type,p.physical_condition,p.functional_condition,
         da.employee_id
  from public.device_stock_positions p
  join public.device_assignments da
    on da.device_serial=p.device_serial and da.status='active'
   and da.site_code=p.site_code and da.employee_id=p.current_holder_employee_id
  where p.current_holder_type='onroll'
), changed as (
  update public.device_stock_positions p
     set owner_department='operations',
         stock_state=case when p.physical_condition='good' and p.functional_condition='working'
                           then 'available' else 'quarantined' end,
         current_holder_employee_id=null,current_holder_type=null,
         last_reference_type='custody_model_migration',
         last_reference_id=null,updated_at=now()
    from migrated m
   where p.device_serial=m.device_serial
  returning p.device_serial,p.site_code,p.physical_condition,p.functional_condition
)
insert into public.device_movement_ledger
  (device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,
   to_holder_type,to_holder_id,site_code,reference_type,physical_condition,functional_condition,
   notes,performed_by,metadata)
select m.device_serial,'custody_model_migration',m.owner_department,'operations','onroll',m.employee_id,
       'operations_inventory',null,m.site_code,'custody_model_migration',
       c.physical_condition,c.functional_condition,
       'Custodian converted from physical holder to virtual accountability; physical inventory retained by Operations.',
       null,jsonb_build_object('previous_stock_state',m.stock_state)
from migrated m join changed c using(device_serial);

-- Correct existing devices whose last physical takeover was incorrectly stored under IT.
with old_it as materialized (
  select p.device_serial,p.site_code,p.physical_condition,p.functional_condition,
         p.stock_state,p.owner_department
  from public.device_stock_positions p
  where p.owner_department='it'
    and p.last_reference_type='hoto_takeover'
    and p.current_holder_employee_id is null
), changed as (
  update public.device_stock_positions p
     set owner_department='operations',
         stock_state=case when p.physical_condition='good' and p.functional_condition='working'
                           then 'available' else 'quarantined' end,
         current_holder_employee_id=null,current_holder_type=null,
         last_reference_type='hoto_takeover',
         updated_at=now()
    from old_it o
   where p.device_serial=o.device_serial
  returning p.device_serial,p.site_code,p.physical_condition,p.functional_condition
)
insert into public.device_movement_ledger
  (device_serial,event_type,from_department,to_department,from_holder_type,to_holder_type,
   site_code,reference_type,physical_condition,functional_condition,notes,metadata)
select o.device_serial,'hoto_takeover_reclassified_to_operations','it','operations','it','operations',
       o.site_code,'hoto_takeover',c.physical_condition,c.functional_condition,
       'Historical HOTO takeover position corrected to Operations inventory by custody policy migration.',
       jsonb_build_object('previous_stock_state',o.stock_state)
from old_it o join changed c using(device_serial);

update public.hoto_transactions
   set to_holder_type='operations',to_holder_name='Operations Inventory'
 where transaction_type='takeover' and to_holder_type='it';

-- Durable condition history; every update to either condition is recorded, even when a caller
-- forgets to append a movement-ledger row.
create table if not exists public.device_condition_history (
  id bigserial primary key,
  device_serial text not null references public.devices("Serial") on update cascade on delete restrict,
  site_code text not null references public.sites("Site") on update cascade on delete restrict,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  previous_physical_condition text,
  physical_condition text not null,
  previous_functional_condition text,
  functional_condition text not null,
  change_kind text not null check (change_kind in ('physical','functional','both')),
  reference_type text,
  reference_id text,
  remarks text
);
create index if not exists device_condition_history_site_time_idx
  on public.device_condition_history(site_code,changed_at desc);
create index if not exists device_condition_history_device_time_idx
  on public.device_condition_history(device_serial,changed_at desc);
alter table public.device_condition_history enable row level security;
revoke all on table public.device_condition_history from public,anon,authenticated;

create or replace function public.hhd_track_device_condition_change()
returns trigger
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_physical boolean := old.physical_condition is distinct from new.physical_condition;
  v_functional boolean := old.functional_condition is distinct from new.functional_condition;
  v_remarks text;
begin
  if not v_physical and not v_functional then return new; end if;
  v_remarks := nullif(trim(current_setting('app.hhd_condition_notes',true)),'');
  insert into public.device_condition_history(
    device_serial,site_code,changed_at,changed_by,
    previous_physical_condition,physical_condition,
    previous_functional_condition,functional_condition,
    change_kind,reference_type,reference_id,remarks
  ) values (
    new.device_serial,new.site_code,now(),coalesce(new.updated_by,auth.uid()),
    old.physical_condition,new.physical_condition,
    old.functional_condition,new.functional_condition,
    case when v_physical and v_functional then 'both'
         when v_physical then 'physical' else 'functional' end,
    new.last_reference_type,new.last_reference_id,
    coalesce(v_remarks,nullif(new.last_reference_type,''),'Condition updated')
  );
  return new;
end;
$$;
drop trigger if exists hhd_track_device_condition_history on public.device_stock_positions;
create trigger hhd_track_device_condition_history
after update of physical_condition,functional_condition on public.device_stock_positions
for each row execute function public.hhd_track_device_condition_change();
revoke all on function public.hhd_track_device_condition_change() from public,anon,authenticated;

-- Additive quantity semantics: each submission adds to the existing entitlement.
create or replace function public.hhd_add_allocation_quantity(
  p_site_code text,p_employee_id text,p_process text,p_additional_quantity integer,p_reason text
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_employee public.onroll_employee_master%rowtype;
  v_alloc public.allocation_entitlements%rowtype;
  v_exists boolean := false;
  v_old integer := 0;
  v_new integer;
  v_collected integer := 0;
  v_available integer := 0;
  v_reserved_other integer := 0;
  v_event text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if nullif(trim(p_site_code),'') is null or nullif(trim(p_process),'') is null then
    raise exception 'Site and process are required';
  end if;
  if p_additional_quantity is null or p_additional_quantity<1 then
    raise exception 'Additional quantity must be a positive whole number';
  end if;
  if nullif(trim(p_reason),'') is null then
    raise exception 'Enter the operational reason for this additional quantity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_site_code)),71023));
  select * into v_employee from public.onroll_employee_master
   where upper(employee_id)=upper(trim(p_employee_id))
     and site_code=p_site_code and employment_status='active' for update;
  if not found then raise exception 'Employee is not active at this site'; end if;
  if regexp_replace(lower(trim(v_employee.designation)),'[^a-z]','','g')
     not in ('lead','srlead','seniorlead','am') then
    raise exception 'Quantity allocation is limited to on-roll Lead, Sr. Lead and AM employees';
  end if;
  if v_employee.linked_user_id is null or not exists(
    select 1 from public.app_users u where u.user_id=v_employee.linked_user_id and u.account_status='active'
  ) then raise exception 'Employee must have an active individual application login'; end if;

  select * into v_alloc from public.allocation_entitlements
   where site_code=p_site_code and employee_id=v_employee.employee_id
     and lower(process)=lower(trim(p_process)) and status='active'
   for update;
  v_exists := found;
  if v_exists then
    if not public.hhd_has_permission('distribution','update',p_site_code) then
      raise exception 'Forbidden: Allocator quantity increase permission required';
    end if;
    v_old := v_alloc.authorized_quantity;
    select count(*)::integer into v_collected from public.device_assignments
     where allocation_id=v_alloc.id and status='active';
    v_new := v_old+p_additional_quantity;
  else
    if not public.hhd_has_permission('distribution','create',p_site_code) then
      raise exception 'Forbidden: Allocator quantity creation permission required';
    end if;
    v_old := 0;
    v_collected := 0;
    v_new := p_additional_quantity;
  end if;

  select count(*)::integer into v_available
    from public.device_stock_positions p
   where p.site_code=p_site_code and p.owner_department='operations'
     and p.stock_state='available' and p.physical_condition='good'
     and p.functional_condition='working'
     and p.current_holder_employee_id is null and p.current_holder_type is null
     and not exists(select 1 from public.device_assignments da
                     where da.device_serial=p.device_serial and da.status='active');
  select coalesce(sum(greatest(a.authorized_quantity-coalesce(c.collected,0),0)),0)::integer
    into v_reserved_other
    from public.allocation_entitlements a
    left join lateral (
      select count(*)::integer collected from public.device_assignments da
       where da.allocation_id=a.id and da.status='active'
    ) c on true
   where a.site_code=p_site_code and a.status='active'
     and (not v_exists or a.id<>v_alloc.id);

  if (v_new-v_collected)>greatest(v_available-v_reserved_other,0) then
    raise exception 'Insufficient unreserved Operations stock. Available: %, reserved for other custodians: %, already virtually assigned to this custodian: %',
      v_available,v_reserved_other,v_collected;
  end if;

  if v_exists then
    update public.allocation_entitlements
       set authorized_quantity=v_new,reason=trim(p_reason),updated_by=v_actor,
           updated_at=now(),version=version+1
     where id=v_alloc.id returning * into v_alloc;
    v_event := 'quantity_increased';
  else
    insert into public.allocation_entitlements(
      site_code,employee_id,process,designation_snapshot,authorized_quantity,status,
      reason,created_by,updated_by
    ) values(
      p_site_code,v_employee.employee_id,trim(p_process),v_employee.designation,
      v_new,'active',trim(p_reason),v_actor,v_actor
    ) returning * into v_alloc;
    v_event := 'created';
  end if;

  insert into public.allocation_events(
    allocation_id,event_type,old_quantity,new_quantity,collected_quantity_at_event,
    reason,performed_by,metadata
  ) values(
    v_alloc.id,v_event,case when v_exists then v_old else null end,v_new,v_collected,
    trim(p_reason),v_actor,
    jsonb_build_object('site_code',p_site_code,'employee_id',v_employee.employee_id,
      'process',trim(p_process),'additional_quantity',p_additional_quantity)
  );
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,before_data,after_data,reason
  ) values(
    v_actor,'distribution.'||v_event,'allocation',v_alloc.id::text,p_site_code,
    case when v_exists then jsonb_build_object('authorized_quantity',v_old) else null end,
    jsonb_build_object('authorized_quantity',v_new,'additional_quantity',p_additional_quantity,
      'collected_quantity',v_collected),trim(p_reason)
  );
  return jsonb_build_object(
    'allocation_id',v_alloc.id,'site_code',v_alloc.site_code,'employee_id',v_alloc.employee_id,
    'process',v_alloc.process,'previous_authorized_quantity',v_old,
    'additional_quantity',p_additional_quantity,'authorized_quantity',v_new,
    'collected_quantity',v_collected,'pending_quantity',greatest(v_new-v_collected,0),
    'status',v_alloc.status,'version',v_alloc.version,'event',v_event
  );
end;
$$;

-- Asset Manager scans the IMEI/serial and creates the virtual custodian link. Physical stock stays in Operations.
create or replace function public.hhd_scan_assign_device(
  p_site_code text,p_allocation_id uuid,p_scan_value text
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_alloc public.allocation_entitlements%rowtype;
  v_serial text;
  v_imei text;
  v_matches integer;
  v_position public.device_stock_positions%rowtype;
  v_assignment uuid;
  v_collected integer;
  v_employee public.onroll_employee_master%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not public.hhd_has_permission('distribution','assign_device',p_site_code) then
    raise exception 'Forbidden: only Asset Manager or Admin can map physical HHDs to virtual custodian allocations';
  end if;
  if nullif(trim(p_scan_value),'') is null then raise exception 'Scan a device Serial or IMEI'; end if;
  perform pg_advisory_xact_lock(hashtextextended(lower(trim(p_site_code)),71023));
  select * into v_alloc from public.allocation_entitlements
   where id=p_allocation_id and site_code=p_site_code and status='active' for update;
  if not found then raise exception 'Select an active custodian quantity allocation'; end if;
  select * into v_employee from public.onroll_employee_master
   where employee_id=v_alloc.employee_id and site_code=p_site_code and employment_status='active';
  if not found then raise exception 'The virtual custodian is no longer active at this site'; end if;

  select d."Serial",d.imei_number into v_serial,v_imei
    from public.devices d where upper(d."Serial")=upper(trim(p_scan_value)) limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value));
    if v_matches=0 then raise exception 'Device Serial / IMEI not found'; end if;
    if v_matches>1 then raise exception 'IMEI matches multiple device records. Use the unique asset Serial'; end if;
    select d."Serial",d.imei_number into v_serial,v_imei
      from public.devices d where upper(d.imei_number)=upper(trim(p_scan_value)) limit 1;
  end if;

  select count(*)::integer into v_collected from public.device_assignments
   where allocation_id=v_alloc.id and status='active';
  if v_collected>=v_alloc.authorized_quantity then
    raise exception 'Custodian allocation is full. Ask the Allocator to add more HHD quantity before assigning another device';
  end if;
  select * into v_position from public.device_stock_positions where device_serial=v_serial for update;
  if not found then raise exception 'Device has no reconciled stock position'; end if;
  if v_position.site_code<>p_site_code or v_position.owner_department<>'operations'
     or v_position.stock_state<>'available'
     or v_position.physical_condition<>'good' or v_position.functional_condition<>'working'
     or v_position.current_holder_employee_id is not null or v_position.current_holder_type is not null then
    raise exception 'Device is not eligible. It must be Good + Working, unheld and Available in Operations inventory';
  end if;
  if exists(select 1 from public.device_assignments where device_serial=v_serial and status='active') then
    raise exception 'Device already has an active virtual custodian assignment';
  end if;
  if exists(select 1 from public.sto_lines sl join public.sto_headers sh on sh.id=sl.sto_id
             where sl.device_serial=v_serial and sh.status in ('pending_approval','approved','dispatched','partially_received')) then
    raise exception 'Device is already included in an open STO';
  end if;

  insert into public.device_assignments(
    allocation_id,device_serial,employee_id,site_code,status,assigned_by
  ) values(v_alloc.id,v_serial,v_alloc.employee_id,p_site_code,'active',v_actor)
  returning id into v_assignment;

  -- The stock position is intentionally NOT marked assigned/on-roll: this is a virtual responsibility only.
  insert into public.device_movement_ledger(
    device_serial,imei_number,event_type,from_department,to_department,
    from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,
    reference_type,reference_id,physical_condition,functional_condition,
    notes,performed_by,metadata
  ) values(
    v_serial,v_imei,'virtual_custodian_assignment','operations','operations',
    'operations_inventory',p_site_code,'virtual_custodian',v_alloc.employee_id,p_site_code,
    'device_assignment',v_assignment::text,v_position.physical_condition,v_position.functional_condition,
    'Asset Manager mapped the HHD to the custodian virtually; physical stock remains in Operations.',
    v_actor,jsonb_build_object('allocation_id',v_alloc.id,'process',v_alloc.process,
      'authorized_quantity',v_alloc.authorized_quantity)
  );
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'distribution.virtual_assign','device_assignment',v_assignment::text,p_site_code,
    jsonb_build_object('device_serial',v_serial,'imei',v_imei,'employee_id',v_alloc.employee_id,
      'allocation_id',v_alloc.id,'physical_owner_department','operations'),
    'Virtual custodian accountability created by Asset Manager'
  );
  return jsonb_build_object(
    'assignment_id',v_assignment,'serial',v_serial,'imei',v_imei,
    'employee_id',v_alloc.employee_id,'allocation_id',v_alloc.id,
    'collected_quantity',v_collected+1,'authorized_quantity',v_alloc.authorized_quantity,
    'pending_quantity',greatest(v_alloc.authorized_quantity-v_collected-1,0),
    'owner_department','operations','stock_state','available','custody_type','virtual'
  );
end;
$$;

create or replace function public.hhd_list_custodian_device_assignments(p_site_code text)
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
    public.hhd_permission_scope('distribution','view',p_site_code),
    public.hhd_permission_scope('employee_collection','view',p_site_code)
  );
  if v_scope is null then raise exception 'Forbidden: custodian assignment list access denied'; end if;
  select employee_id into v_employee_id from public.app_users
   where user_id=auth.uid() and account_status='active';
  select coalesce(jsonb_agg(to_jsonb(x) order by x.assigned_at desc),'[]'::jsonb)
    into v_rows
    from (
      select da.id as assignment_id,da.device_serial,d.imei_number,d."Make" as make,d."Model" as model,
             da.employee_id,e.employee_name,e.designation,ae.process,ae.authorized_quantity,
             da.assigned_at,da.assigned_by,da.status as assignment_status,
             p.owner_department,p.stock_state,p.physical_condition,p.functional_condition,
             p.current_holder_type,p.current_holder_employee_id,
             case when p.current_holder_type='offroll' then coalesce(w.employee_name,ht.to_holder_name,p.current_holder_employee_id)
                  when p.current_holder_type='it' then 'Site IT'
                  when p.owner_department='operations' and p.current_holder_employee_id is null then 'Operations Inventory'
                  else p.current_holder_employee_id end as current_holder_name
        from public.device_assignments da
        join public.devices d on d."Serial"=da.device_serial
        join public.device_stock_positions p on p.device_serial=da.device_serial
        join public.onroll_employee_master e on e.employee_id=da.employee_id
        join public.allocation_entitlements ae on ae.id=da.allocation_id
        left join public.offroll_worker_master w
          on upper(w.employee_id)=upper(p.current_holder_employee_id) and w.site_code=p.site_code
        left join lateral (
          select h.to_holder_name from public.hoto_transactions h
           where h.device_serial=da.device_serial and h.to_holder_type='offroll'
             and upper(h.to_holder_employee_id)=upper(p.current_holder_employee_id)
           order by h.performed_at desc limit 1
        ) ht on true
       where da.site_code=p_site_code and da.status='active'
         and (v_scope<>'own' or da.employee_id=v_employee_id)
    ) x;
  return v_rows;
end;
$$;

create or replace function public.hhd_release_virtual_custodian_assignment(
  p_device_serial text,p_physical_condition text,p_functional_condition text,p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_assignment public.device_assignments%rowtype;
  v_position public.device_stock_positions%rowtype;
  v_state text;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_physical_condition not in ('good','damaged')
     or p_functional_condition not in ('working','not_working') then
    raise exception 'Select physical and functional condition';
  end if;
  select * into v_assignment from public.device_assignments
   where upper(device_serial)=upper(trim(p_device_serial)) and status='active'
   order by assigned_at desc limit 1 for update;
  if not found then raise exception 'No active virtual custodian responsibility exists for this HHD'; end if;
  if not public.hhd_has_permission('distribution','receive_return',v_assignment.site_code) then
    raise exception 'Forbidden: only Asset Manager or Admin can release virtual custodian responsibility';
  end if;
  select * into v_position from public.device_stock_positions
   where device_serial=v_assignment.device_serial for update;
  if not found or v_position.site_code<>v_assignment.site_code then
    raise exception 'Device Operations stock position is missing or mismatched';
  end if;
  if v_position.current_holder_type='offroll' then
    raise exception 'GC/TL is still holding this HHD. Complete HOTO Takeover before releasing the virtual custodian assignment';
  end if;
  if v_position.owner_department<>'operations' or v_position.current_holder_employee_id is not null then
    raise exception 'Device is not physically present in Operations inventory';
  end if;
  v_state:=case when p_physical_condition='good' and p_functional_condition='working'
                then 'available' else 'quarantined' end;
  perform set_config('app.hhd_condition_notes',coalesce(p_notes,'Virtual custodian responsibility released by Asset Manager'),true);
  update public.device_assignments
     set status='returned',returned_by=v_actor,returned_at=now(),
         return_physical_condition=p_physical_condition,
         return_functional_condition=p_functional_condition,
         return_notes=nullif(trim(p_notes),'')
   where id=v_assignment.id;
  update public.device_stock_positions
     set owner_department='operations',stock_state=v_state,
         physical_condition=p_physical_condition,functional_condition=p_functional_condition,
         current_holder_employee_id=null,current_holder_type=null,
         updated_by=v_actor,updated_at=now(),
         last_reference_type='virtual_custodian_release',
         last_reference_id=v_assignment.id::text
   where device_serial=v_assignment.device_serial;
  insert into public.device_movement_ledger(
    device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,
    to_holder_type,to_holder_id,site_code,reference_type,reference_id,
    physical_condition,functional_condition,notes,performed_by
  ) values(
    v_assignment.device_serial,'virtual_custodian_release','operations','operations',
    'virtual_custodian',v_assignment.employee_id,'operations_inventory',null,
    v_assignment.site_code,'device_assignment',v_assignment.id::text,
    p_physical_condition,p_functional_condition,p_notes,v_actor
  );
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'distribution.virtual_release','device_assignment',v_assignment.id::text,
    v_assignment.site_code,jsonb_build_object('device_serial',v_assignment.device_serial,
      'employee_id',v_assignment.employee_id,'stock_state',v_state,
      'physical_condition',p_physical_condition,'functional_condition',p_functional_condition),
    coalesce(nullif(trim(p_notes),''),'Asset Manager released virtual custodian responsibility')
  );
  return jsonb_build_object('assignment_id',v_assignment.id,'device_serial',v_assignment.device_serial,
    'employee_id',v_assignment.employee_id,'stock_state',v_state,'site_code',v_assignment.site_code);
end;
$$;

-- HOTO device resolution: first handover can only start from unheld Operations inventory.
create or replace function public.hhd_hoto_resolve_device(
  p_scan_value text,p_site_code text,p_action text
) returns jsonb
language plpgsql
stable security definer
set search_path=public,auth,pg_temp
as $$
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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_action not in ('handover','takeover','mid_shift_swap') then raise exception 'Unsupported HOTO action'; end if;
  v_permission:=case when p_action='takeover' then 'acknowledge'
                     when p_action='mid_shift_swap' then 'swap' else 'create' end;
  if not public.hhd_has_permission('hoto',v_permission,p_site_code) then
    raise exception 'Forbidden: HOTO action is not permitted for this site';
  end if;
  if nullif(trim(p_scan_value),'') is null then
    return jsonb_build_object('valid',false,'reason','Scan or enter the HHD IMEI / barcode.');
  end if;
  select d."Serial" into v_serial from public.devices d
   where upper(d."Serial")=upper(trim(p_scan_value)) limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value));
    if v_matches<>1 then
      return jsonb_build_object('valid',false,'reason',
        case when v_matches=0 then 'HHD barcode was not found in the device master.'
             else 'This IMEI matches more than one device. Use the unique HHD Serial.' end);
    end if;
    select d."Serial" into v_serial from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_scan_value)) limit 1;
  end if;
  select * into v_device from public.devices d where d."Serial"=v_serial;
  select * into v_pos from public.device_stock_positions p where p.device_serial=v_serial;
  if not found then return jsonb_build_object('valid',false,'reason','No stock position exists for this HHD.'); end if;
  if v_pos.site_code<>p_site_code then return jsonb_build_object('valid',false,'reason','This HHD is not registered at the selected site.'); end if;
  select * into v_assignment from public.device_assignments da
   where da.device_serial=v_serial and da.site_code=p_site_code and da.status='active'
   order by da.assigned_at desc limit 1;
  if not found then return jsonb_build_object('valid',false,'reason','This HHD has no active virtual custodian assignment.'); end if;

  if v_pos.current_holder_type='offroll' then
    select coalesce(w.employee_name,h.to_holder_name,v_pos.current_holder_employee_id),
           coalesce(w.worker_type,h.offroll_worker_type)
      into v_holder_name,v_worker_type
      from (select 1) seed
      left join public.offroll_worker_master w
        on upper(w.employee_id)=upper(v_pos.current_holder_employee_id) and w.site_code=p_site_code
      left join lateral (
        select ht.to_holder_name,ht.offroll_worker_type from public.hoto_transactions ht
         where ht.site_code=p_site_code and ht.device_serial=v_serial
           and ht.to_holder_type='offroll'
           and upper(ht.to_holder_employee_id)=upper(v_pos.current_holder_employee_id)
         order by ht.performed_at desc limit 1
      ) h on true;
    v_holder_type:='offroll';
  elsif v_pos.current_holder_type='onroll' then
    select e.employee_name into v_holder_name from public.onroll_employee_master e
     where upper(e.employee_id)=upper(v_pos.current_holder_employee_id) limit 1;
    v_holder_type:='onroll';
  elsif v_pos.owner_department='operations' and v_pos.stock_state='available'
        and v_pos.current_holder_employee_id is null and v_pos.current_holder_type is null then
    v_holder_name:='Operations Inventory'; v_holder_type:='operations';
  elsif v_pos.owner_department='it' and v_pos.stock_state='available' then
    v_holder_name:='Site IT'; v_holder_type:='it';
  else
    v_holder_type:=coalesce(v_pos.current_holder_type,'unknown');
    v_holder_name:=v_pos.current_holder_employee_id;
  end if;

  if p_action='handover' then
    if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
      return jsonb_build_object('valid',false,'reason','Damaged or non-working HHD cannot be handed to a GC / TL.');
    end if;
    if v_pos.current_holder_type='offroll' then
      return jsonb_build_object(
        'valid',true,'requires_swap',true,
        'device',jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,
          'make',v_device."Make",'model',v_device."Model",
          'physical_condition',v_pos.physical_condition,'functional_condition',v_pos.functional_condition,
          'primary_employee_id',v_assignment.employee_id),
        'current_holder',jsonb_build_object('employee_id',v_pos.current_holder_employee_id,
          'employee_name',v_holder_name,'worker_type',v_worker_type)
      );
    end if;
    if not (v_pos.owner_department='operations' and v_pos.stock_state='available'
       and v_pos.current_holder_type is null and v_pos.current_holder_employee_id is null) then
      return jsonb_build_object('valid',false,'reason','HHD must be unheld and Available in Operations inventory before HOTO handover.');
    end if;
  elsif p_action='takeover' then
    if v_pos.current_holder_type is distinct from 'offroll'
       or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
      return jsonb_build_object('valid',false,'reason','This HHD is not currently held by a GC / TL. A takeover may already be completed.');
    end if;
  elsif p_action='mid_shift_swap' then
    if v_pos.current_holder_type is distinct from 'offroll'
       or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
      return jsonb_build_object('valid',false,'reason','Mid-shift swap requires an HHD currently held by a GC / TL.');
    end if;
    if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
      return jsonb_build_object('valid',false,'reason','Damaged or non-working HHD cannot be transferred to another GC / TL.');
    end if;
  end if;
  return jsonb_build_object(
    'valid',true,'requires_swap',false,
    'device',jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,
      'make',v_device."Make",'model',v_device."Model",
      'physical_condition',v_pos.physical_condition,'functional_condition',v_pos.functional_condition,
      'primary_employee_id',v_assignment.employee_id),
    'current_holder',case when v_holder_type is null then null else
      jsonb_build_object('holder_type',v_holder_type,'employee_id',v_pos.current_holder_employee_id,
        'employee_name',coalesce(v_holder_name,v_pos.current_holder_employee_id),'worker_type',v_worker_type) end
  );
end;
$$;

-- HOTO issue and mid-shift swap use Operations as the physical source of custody.
create or replace function public.hhd_hoto_record_transfer(
  p_device_serial text,p_offroll_employee_id text,p_site_code text,p_shift_code text,
  p_shift_date date default current_date,p_transaction_type text default 'handover',
  p_notes text default null,p_physical_condition text default 'good',
  p_functional_condition text default 'working',p_manual_override boolean default false,
  p_manual_worker_name text default null,p_manual_worker_type text default null,
  p_override_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_serial text;
  v_assignment public.device_assignments%rowtype;
  v_pos public.device_stock_positions%rowtype;
  v_worker public.offroll_worker_master%rowtype;
  v_worker_id text;
  v_worker_name text;
  v_worker_type text;
  v_validation_source text:='hr_master';
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
  v_permission:=case when p_transaction_type='mid_shift_swap' then 'swap' else 'create' end;
  if not public.hhd_has_permission('hoto',v_permission,p_site_code) then
    raise exception 'Forbidden: HOTO action requires Asset Manager or Admin scope';
  end if;
  v_worker_id:=upper(trim(coalesce(p_offroll_employee_id,'')));
  if v_worker_id='' then raise exception 'Scan or enter the TL/GC Employee ID'; end if;

  select d."Serial" into v_serial from public.devices d
   where upper(d."Serial")=upper(trim(p_device_serial)) limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial));
    if v_matches<>1 then raise exception 'IMEI does not resolve to exactly one device. Use unique asset Serial'; end if;
    select d."Serial" into v_serial from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial)) limit 1;
  end if;
  select * into v_assignment from public.device_assignments
   where device_serial=v_serial and site_code=p_site_code and status='active'
   order by assigned_at desc limit 1 for update;
  if not found then raise exception 'Device has no active virtual custodian assignment at this site'; end if;
  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.site_code<>p_site_code then raise exception 'Device is not registered at the selected site'; end if;
  if v_pos.physical_condition<>'good' or v_pos.functional_condition<>'working' then
    raise exception 'Device is recorded as damaged or non-working. It cannot be issued to a GC / TL';
  end if;

  if p_transaction_type='handover' then
    if v_pos.current_holder_type='offroll' then raise exception 'Device is currently held by another GC / TL. Use Mid-shift Swap'; end if;
    if not (v_pos.owner_department='operations' and v_pos.stock_state='available'
       and v_pos.current_holder_type is null and v_pos.current_holder_employee_id is null) then
      raise exception 'Handover requires an unheld HHD in Available Operations inventory';
    end if;
  else
    if v_pos.owner_department<>'operations' or v_pos.stock_state<>'assigned'
       or v_pos.current_holder_type<>'offroll' then
      raise exception 'Mid-shift swap requires a device currently held by a GC / TL';
    end if;
  end if;

  if p_manual_override then
    if nullif(trim(p_manual_worker_name),'') is null or p_manual_worker_type not in ('GC','TL')
       or nullif(trim(p_override_reason),'') is null then
      raise exception 'Manual override requires worker name, worker type and reason';
    end if;
    select * into v_worker from public.offroll_worker_master
     where upper(employee_id)=v_worker_id and site_code=p_site_code and employment_status='active'
     order by last_synced_at desc limit 1;
    if found and v_worker.last_synced_at is not null and v_worker.last_synced_at>=now()-interval '26 hours' then
      raise exception 'This GC / TL exists in the active HR master. Revalidate the master instead of overriding';
    end if;
    v_worker_name:=trim(p_manual_worker_name);
    v_worker_type:=p_manual_worker_type;
    v_validation_source:='manual_override';
  else
    select * into v_worker from public.offroll_worker_master
     where upper(employee_id)=v_worker_id and site_code=p_site_code and employment_status='active'
     order by last_synced_at desc limit 1;
    if not found then raise exception 'TL/GC Employee ID is not active in the HR master for this site'; end if;
    if v_worker.last_synced_at is null or v_worker.last_synced_at<now()-interval '26 hours' then
      raise exception 'HR worker master is stale. Run HR Sheet synchronization or complete a documented manual override';
    end if;
    v_worker_name:=v_worker.employee_name;
    v_worker_type:=v_worker.worker_type;
  end if;

  if exists(
    select 1 from public.device_stock_positions p
     where p.site_code=p_site_code and p.stock_state='assigned'
       and p.current_holder_type='offroll'
       and upper(p.current_holder_employee_id)=v_worker_id and p.device_serial<>v_serial
  ) then raise exception 'This GC / TL is already holding another HHD. Complete takeover first'; end if;

  v_from_type:=coalesce(v_pos.current_holder_type,
    case when v_pos.owner_department='operations' then 'operations' else null end);
  v_from_id:=v_pos.current_holder_employee_id;
  if v_from_type is null then raise exception 'Current HHD physical custody is not recorded'; end if;
  if p_transaction_type='mid_shift_swap' and v_from_type<>'offroll' then
    raise exception 'Mid-shift swap requires a current GC / TL holder';
  end if;
  if p_transaction_type='mid_shift_swap' and upper(coalesce(v_from_id,''))=v_worker_id then
    raise exception 'This GC / TL is already the current holder';
  end if;
  if v_from_type='offroll' then
    select coalesce(w.employee_name,h.to_holder_name,v_from_id) into v_from_name
      from (select 1) seed
      left join public.offroll_worker_master w
        on upper(w.employee_id)=upper(v_from_id) and w.site_code=p_site_code
      left join lateral (
        select ht.to_holder_name from public.hoto_transactions ht
         where ht.site_code=p_site_code and ht.device_serial=v_serial
           and ht.to_holder_type='offroll' and upper(ht.to_holder_employee_id)=upper(v_from_id)
         order by ht.performed_at desc limit 1
      ) h on true;
  elsif v_from_type='onroll' then
    select e.employee_name into v_from_name from public.onroll_employee_master e
     where upper(e.employee_id)=upper(v_from_id) limit 1;
  else
    v_from_name:='Operations Inventory';
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
  ) values(
    p_site_code,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,p_transaction_type,
    v_from_type,v_from_id,'offroll',v_worker_id,v_worker_type,
    p_physical_condition,p_functional_condition,nullif(trim(p_notes),''),v_actor,v_from_name,v_worker_name,
    v_validation_source,case when p_manual_override then trim(p_override_reason) end,
    case when p_manual_override then v_actor end,case when p_manual_override then now() end
  ) returning id into v_hoto_id;

  update public.device_stock_positions set last_reference_id=v_hoto_id::text where device_serial=v_serial;

  insert into public.device_movement_ledger(
    device_serial,event_type,from_department,to_department,from_holder_type,from_holder_id,
    to_holder_type,to_holder_id,site_code,reference_type,reference_id,
    physical_condition,functional_condition,notes,performed_by
  ) values(
    v_serial,'hoto_'||p_transaction_type,'operations','operations',
    v_from_type,v_from_id,'offroll',v_worker_id,p_site_code,'hoto',v_hoto_id::text,
    p_physical_condition,p_functional_condition,p_notes,v_actor
  );

  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'hoto.'||p_transaction_type,'hoto_transaction',v_hoto_id::text,p_site_code,
    jsonb_build_object('serial',v_serial,'from_holder_type',v_from_type,'from_holder_id',v_from_id,
      'from_holder_name',v_from_name,'to_holder_type','offroll','to_holder_id',v_worker_id,
      'to_holder_name',v_worker_name,'worker_type',v_worker_type,'shift_code',p_shift_code,
      'validation_source',v_validation_source),
    coalesce(nullif(trim(p_notes),''),case when p_manual_override then trim(p_override_reason) else 'Shift HOTO recorded' end)
  );
  if p_manual_override then
    insert into public.admin_audit_events(
      actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
    ) values(
      v_actor,'hoto.manual_override','hoto_transaction',v_hoto_id::text,p_site_code,
      jsonb_build_object('worker_id',v_worker_id,'worker_name',v_worker_name,
        'worker_type',v_worker_type,'validation_source','manual_override','shift_code',p_shift_code),
      trim(p_override_reason)
    );
  end if;
  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'site_code',p_site_code,
    'from_holder_type',v_from_type,'from_holder_id',v_from_id,'from_holder_name',v_from_name,
    'to_holder_type','offroll','to_holder_id',v_worker_id,'to_holder_name',v_worker_name,
    'worker_name',v_worker_name,'worker_type',v_worker_type,'shift_code',p_shift_code,
    'transaction_type',p_transaction_type,'worker_validation_source',v_validation_source);
end;
$$;

-- Shift-end HOTO takeover returns the physical device to Operations inventory, not Site IT.
create or replace function public.hhd_hoto_takeover_to_operations(
  p_device_serial text,p_site_code text,p_shift_code text,p_shift_date date default current_date,
  p_physical_condition text default 'good',p_functional_condition text default 'working',
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
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
  if p_physical_condition not in ('good','damaged')
     or p_functional_condition not in ('working','not_working') then
    raise exception 'Select a valid physical and functional condition';
  end if;
  if not public.hhd_has_permission('hoto','acknowledge',p_site_code) then
    raise exception 'Forbidden: HOTO takeover requires Asset Manager or Admin permission';
  end if;
  select d."Serial" into v_serial from public.devices d
   where upper(d."Serial")=upper(trim(p_device_serial)) limit 1;
  if v_serial is null then
    select count(*) into v_matches from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial));
    if v_matches<>1 then raise exception 'IMEI does not resolve to exactly one device'; end if;
    select d."Serial" into v_serial from public.devices d
     where upper(coalesce(d.imei_number,''))=upper(trim(p_device_serial)) limit 1;
  end if;
  select * into v_device from public.devices where "Serial"=v_serial;
  select * into v_assignment from public.device_assignments
   where device_serial=v_serial and site_code=p_site_code and status='active'
   order by assigned_at desc limit 1 for update;
  if not found then raise exception 'No active virtual custodian assignment exists'; end if;
  select * into v_pos from public.device_stock_positions where device_serial=v_serial for update;
  if not found or v_pos.site_code<>p_site_code then raise exception 'HHD is not registered at the selected site'; end if;
  if v_pos.current_holder_type is distinct from 'offroll'
     or v_pos.stock_state<>'assigned' or v_pos.owner_department<>'operations' then
    raise exception 'This HHD is not currently held by a GC / TL. Takeover may already be completed';
  end if;
  v_from_id:=v_pos.current_holder_employee_id;
  select coalesce(w.employee_name,h.to_holder_name,v_from_id),
         coalesce(w.worker_type,h.offroll_worker_type)
    into v_from_name,v_worker_type
    from (select 1) seed
    left join public.offroll_worker_master w
      on upper(w.employee_id)=upper(v_from_id) and w.site_code=p_site_code
    left join lateral (
      select ht.to_holder_name,ht.offroll_worker_type from public.hoto_transactions ht
       where ht.site_code=p_site_code and ht.device_serial=v_serial
         and ht.to_holder_type='offroll' and upper(ht.to_holder_employee_id)=upper(v_from_id)
       order by ht.performed_at desc limit 1
    ) h on true;
  v_stock_state:=case when p_physical_condition='good' and p_functional_condition='working'
                      then 'available' else 'quarantined' end;
  perform set_config('app.hhd_condition_notes',
    coalesce(p_notes,'HHD returned from GC/TL through HOTO takeover to Operations inventory'),true);
  update public.device_stock_positions
     set owner_department='operations',stock_state=v_stock_state,
         current_holder_employee_id=null,current_holder_type=null,
         physical_condition=p_physical_condition,functional_condition=p_functional_condition,
         updated_by=v_actor,updated_at=now(),last_reference_type='hoto_takeover',last_reference_id=null
   where device_serial=v_serial;
  insert into public.hoto_transactions(
    site_code,device_serial,primary_assignment_id,shift_date,shift_code,transaction_type,
    from_holder_type,from_holder_employee_id,to_holder_type,to_holder_employee_id,
    offroll_worker_type,physical_condition,functional_condition,notes,performed_by,
    from_holder_name,to_holder_name,worker_validation_source
  ) values(
    p_site_code,v_serial,v_assignment.id,coalesce(p_shift_date,current_date),p_shift_code,'takeover',
    'offroll',v_from_id,'operations',null,v_worker_type,p_physical_condition,p_functional_condition,
    nullif(trim(p_notes),''),v_actor,v_from_name,'Operations Inventory','system'
  ) returning id into v_hoto_id;
  update public.device_stock_positions
     set last_reference_id=v_hoto_id::text where device_serial=v_serial;
  insert into public.device_movement_ledger(
    device_serial,imei_number,event_type,from_department,to_department,
    from_holder_type,from_holder_id,to_holder_type,to_holder_id,site_code,
    reference_type,reference_id,physical_condition,functional_condition,notes,performed_by
  ) values(
    v_serial,v_device.imei_number,'hoto_takeover','operations','operations',
    'offroll',v_from_id,'operations_inventory',null,p_site_code,
    'hoto',v_hoto_id::text,p_physical_condition,p_functional_condition,p_notes,v_actor
  );
  insert into public.admin_audit_events(
    actor_user_id,action_code,entity_type,entity_id,site_code,after_data,reason
  ) values(
    v_actor,'hoto.takeover','hoto_transaction',v_hoto_id::text,p_site_code,
    jsonb_build_object('serial',v_serial,'imei',v_device.imei_number,'from_holder_id',v_from_id,
      'from_holder_name',v_from_name,'to_department','operations','to_holder_name','Operations Inventory',
      'stock_state',v_stock_state,'physical_condition',p_physical_condition,
      'functional_condition',p_functional_condition,'shift_code',p_shift_code),
    coalesce(nullif(trim(p_notes),''),'HHD received into Operations inventory after GC/TL shift end')
  );
  return jsonb_build_object('hoto_id',v_hoto_id,'serial',v_serial,'imei',v_device.imei_number,
    'site_code',p_site_code,'from_holder_id',v_from_id,'from_holder_name',v_from_name,
    'to_department','operations','to_holder_name','Operations Inventory',
    'stock_state',v_stock_state,'transaction_type','takeover','shift_code',p_shift_code);
end;
$$;

-- Dashboard aggregates only actual condition changes, with before/after values and audit details.
create or replace function public.hhd_get_device_condition_dashboard(
  p_site_code text,p_from_date date default current_date-55,
  p_to_date date default current_date,p_search text default null,p_limit integer default 300
) returns jsonb
language plpgsql
stable security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_summary jsonb;
  v_weekly jsonb;
  v_devices jsonb;
  v_details jsonb;
  v_from date:=coalesce(p_from_date,current_date-55);
  v_to date:=coalesce(p_to_date,current_date);
  v_query text:=lower(trim(coalesce(p_search,'')));
begin
  if not public.hhd_has_permission('inventory','condition_history',p_site_code) then
    raise exception 'Forbidden: condition history is restricted to Asset Manager and Admin';
  end if;
  if v_from>v_to then raise exception 'From date cannot be after To date'; end if;

  with filtered as (
    select h.*,d.imei_number,d."Make" as make,d."Model" as model,
           u.full_name as changed_by_name,p.stock_state as current_stock_state,
           p.owner_department as current_owner_department
      from public.device_condition_history h
      join public.devices d on d."Serial"=h.device_serial
      left join public.app_users u on u.user_id=h.changed_by
      left join public.device_stock_positions p on p.device_serial=h.device_serial
     where h.site_code=p_site_code
       and h.changed_at>=v_from::timestamptz
       and h.changed_at<(v_to+1)::timestamptz
       and (v_query='' or lower(h.device_serial) like '%'||v_query||'%'
            or lower(coalesce(d.imei_number,'')) like '%'||v_query||'%'
            or lower(coalesce(h.remarks,'')) like '%'||v_query||'%')
  )
  select
    jsonb_build_object(
      'total_changes',count(*),
      'physical_changes',count(*) filter (where change_kind in ('physical','both')),
      'functional_changes',count(*) filter (where change_kind in ('functional','both')),
      'devices_affected',count(distinct device_serial)
    ),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'week_start',week_start,'total_changes',total_changes,
        'physical_changes',physical_changes,'functional_changes',functional_changes,
        'devices_affected',devices_affected
      ) order by week_start)
      from (
        select date_trunc('week',changed_at)::date week_start,count(*) total_changes,
               count(*) filter(where change_kind in ('physical','both')) physical_changes,
               count(*) filter(where change_kind in ('functional','both')) functional_changes,
               count(distinct device_serial) devices_affected
          from filtered group by 1
      ) w
    ),'[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'device_serial',device_serial,'imei',imei_number,'make',make,'model',model,
        'total_changes',total_changes,'physical_changes',physical_changes,
        'functional_changes',functional_changes,'last_change_at',last_change_at,
        'current_physical_condition',current_physical_condition,
        'current_functional_condition',current_functional_condition,
        'current_stock_state',current_stock_state
      ) order by total_changes desc,last_change_at desc)
      from (
        select f.device_serial,max(f.imei_number) imei_number,max(f.make) make,max(f.model) model,
               count(*) total_changes,
               count(*) filter(where f.change_kind in ('physical','both')) physical_changes,
               count(*) filter(where f.change_kind in ('functional','both')) functional_changes,
               max(f.changed_at) last_change_at,
               max(f.physical_condition) filter(where f.changed_at=latest.latest_at) current_physical_condition,
               max(f.functional_condition) filter(where f.changed_at=latest.latest_at) current_functional_condition,
               max(f.current_stock_state) current_stock_state
          from filtered f
          join lateral (select max(x.changed_at) latest_at from filtered x where x.device_serial=f.device_serial) latest on true
         group by f.device_serial,latest.latest_at
      ) d
    ),'[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',id,'changed_at',changed_at,'device_serial',device_serial,'imei',imei_number,
        'event_type',change_kind,'previous_physical_condition',previous_physical_condition,
        'physical_condition',physical_condition,
        'previous_functional_condition',previous_functional_condition,
        'functional_condition',functional_condition,'change_kind',change_kind,
        'remarks',coalesce(remarks,reference_type,'Condition updated'),
        'changed_by',changed_by,'changed_by_name',changed_by_name,
        'reference_type',reference_type,'reference_id',reference_id,
        'current_stock_state',current_stock_state
      ) order by changed_at desc,id desc)
      from (select * from filtered order by changed_at desc,id desc
             limit greatest(1,least(coalesce(p_limit,300),500))) detail
    ),'[]'::jsonb)
  into v_summary,v_weekly,v_devices,v_details
  from filtered;

  return jsonb_build_object('site_code',p_site_code,'from_date',v_from,'to_date',v_to,
    'summary',coalesce(v_summary,'{}'::jsonb),'weekly',coalesce(v_weekly,'[]'::jsonb),
    'devices',coalesce(v_devices,'[]'::jsonb),'details',coalesce(v_details,'[]'::jsonb),
    'generated_at',now());
end;
$$;

-- Workspace availability excludes devices already virtually mapped to a custodian.
create or replace function public.hhd_get_site_workspace(p_site_code text)
returns jsonb
language plpgsql
stable security definer
set search_path=public,auth,pg_temp
as $$
declare
  v_stock jsonb;
  v_allocations jsonb;
  v_summary jsonb;
  v_inventory_scope text;
  v_distribution_scope text;
  v_employee_id text;
begin
  if not public.hhd_has_permission('dashboard','view',p_site_code) then
    raise exception 'Forbidden: dashboard access denied for this site';
  end if;
  v_inventory_scope:=public.hhd_permission_scope('inventory','view',p_site_code);
  v_distribution_scope:=public.hhd_permission_scope('distribution','view',p_site_code);
  select employee_id into v_employee_id from public.app_users
   where user_id=auth.uid() and account_status='active';

  if v_inventory_scope is not null and v_inventory_scope<>'own' then
    select jsonb_build_object(
      'available',count(*) filter(where p.owner_department='operations' and p.stock_state='available'
        and p.physical_condition='good' and p.functional_condition='working'
        and p.current_holder_employee_id is null and p.current_holder_type is null
        and not exists(select 1 from public.device_assignments da where da.device_serial=p.device_serial and da.status='active')),
      'assigned',count(*) filter(where p.owner_department='operations' and p.stock_state='assigned'),
      'virtual_assigned',(select count(*) from public.device_assignments da where da.site_code=p_site_code and da.status='active'),
      'quarantined',count(*) filter(where p.stock_state in ('quarantined','maintenance')),
      'lost',count(*) filter(where p.stock_state='lost')
    ) into v_summary from public.device_stock_positions p where p.site_code=p_site_code;
  else
    select jsonb_build_object('available',0,
      'assigned',count(*) filter(where da.status='active'),
      'virtual_assigned',count(*) filter(where da.status='active'),
      'quarantined',0,'lost',0)
      into v_summary from public.device_assignments da
     where da.site_code=p_site_code and da.employee_id=v_employee_id;
  end if;

  if v_distribution_scope is not null or public.hhd_has_permission('employee_collection','view',p_site_code) then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc),'[]'::jsonb)
      into v_allocations
      from (
        select a.id,a.site_code,a.employee_id,e.employee_name,e.designation,a.process,a.authorized_quantity,
          count(da.id) filter(where da.status='active')::integer as collected_quantity,
          greatest(a.authorized_quantity-count(da.id) filter(where da.status='active')::integer,0)::integer as pending_quantity,
          a.status,a.reason,a.created_at,a.updated_at,a.version
        from public.allocation_entitlements a
        join public.onroll_employee_master e on e.employee_id=a.employee_id
        left join public.device_assignments da on da.allocation_id=a.id
        where a.site_code=p_site_code and (coalesce(v_distribution_scope,'own')<>'own' or a.employee_id=v_employee_id)
        group by a.id,e.employee_name,e.designation
        order by a.updated_at desc limit 250
      ) x;
  else v_allocations:='[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'serial',d."Serial",'imei',d.imei_number,'make',d."Make",'model',d."Model",
    'physical_condition',p.physical_condition,'functional_condition',p.functional_condition,
    'stock_state',p.stock_state,'holder_employee_id',p.current_holder_employee_id,
    'holder_type',p.current_holder_type
  ) order by d."Serial"),'[]'::jsonb)
    into v_stock
    from public.device_stock_positions p join public.devices d on d."Serial"=p.device_serial
   where p.site_code=p_site_code and v_inventory_scope is not null
     and (v_inventory_scope<>'own' or exists(
       select 1 from public.device_assignments da
        where da.device_serial=p.device_serial and da.employee_id=v_employee_id and da.status='active'
     ));
  return jsonb_build_object('site_code',p_site_code,'summary',coalesce(v_summary,'{}'::jsonb),
    'allocations',v_allocations,'devices',coalesce(v_stock,'[]'::jsonb),'generated_at',now());
end;
$$;

-- Role policy: Allocator controls quantity, Asset Manager controls physical assignment and STO execution,
-- Custodian only reads their virtual responsibility and may approve removal to Site IT.
insert into public.role_permissions(role_code,permission_code,is_allowed,data_scope,updated_at)
select x.role_code,x.permission_code,x.is_allowed,x.data_scope,now()
from (values
  ('admin','distribution.assign_device',true,'all_sites'),
  ('admin','sto.approve',false,'all_sites'),
  ('admin','inventory.condition_history',true,'all_sites'),

  ('operations_spoc','distribution.assign_device',true,'assigned_sites'),
  ('operations_spoc','sto.approve',false,'assigned_sites'),
  ('operations_spoc','sto.create',true,'assigned_sites'),
  ('operations_spoc','sto.dispatch',true,'assigned_sites'),
  ('operations_spoc','sto.receive',true,'assigned_sites'),
  ('operations_spoc','sto.view',true,'assigned_sites'),
  ('operations_spoc','inventory.condition_history',true,'assigned_sites'),

  ('site_it','distribution.assign_device',false,'assigned_sites'),
  ('site_it','hoto.acknowledge',false,'assigned_sites'),
  ('site_it','hoto.create',false,'assigned_sites'),
  ('site_it','hoto.swap',false,'assigned_sites'),
  ('site_it','hoto.view',false,'assigned_sites'),
  ('site_it','sto.create',false,'assigned_sites'),
  ('site_it','sto.dispatch',false,'assigned_sites'),
  ('site_it','sto.approve',false,'assigned_sites'),
  ('site_it','sto.receive',true,'assigned_sites'),
  ('site_it','sto.view',true,'assigned_sites'),

  ('assigned_employee','employee_collection.scan_assign',false,'own'),
  ('assigned_employee','employee_collection.return',false,'own'),
  ('assigned_employee','employee_collection.view',true,'own'),
  ('assigned_employee','sto.approve',true,'own'),
  ('assigned_employee','sto.view',true,'own'),

  ('site_lead','distribution.create',true,'assigned_sites'),
  ('site_lead','distribution.update',true,'assigned_sites'),
  ('site_lead','distribution.view',true,'assigned_sites'),
  ('site_lead','sto.approve',true,'assigned_sites'),
  ('site_lead','sto.view',true,'assigned_sites'),
  ('site_lead','hoto.create',false,'assigned_sites'),
  ('site_lead','hoto.acknowledge',false,'assigned_sites'),
  ('site_lead','hoto.swap',false,'assigned_sites'),
  ('site_lead','hoto.view',false,'assigned_sites')
) as x(role_code,permission_code,is_allowed,data_scope)
on conflict(role_code,permission_code) do update
set is_allowed=excluded.is_allowed,data_scope=excluded.data_scope,updated_at=now();

-- Remove obsolete RPC routes that allowed custodians to self-collect/return or bypass the new HOTO flow.
revoke all on function public.hhd_create_or_adjust_allocation(text,text,text,integer,text,integer) from public,anon,authenticated;
revoke all on function public.hhd_return_assigned_device(text,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_return_hoto_to_primary(text,text,text,text,date,text) from public,anon,authenticated;
revoke all on function public.hhd_record_hoto_transfer(text,text,text,date,text,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_hoto_takeover_to_it(text,text,text,date,text,text,text) from public,anon,authenticated;

revoke all on function public.hhd_add_allocation_quantity(text,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.hhd_scan_assign_device(text,uuid,text) from public,anon,authenticated;
revoke all on function public.hhd_list_custodian_device_assignments(text) from public,anon,authenticated;
revoke all on function public.hhd_release_virtual_custodian_assignment(text,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_hoto_resolve_device(text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_hoto_record_transfer(text,text,text,text,date,text,text,text,text,boolean,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_hoto_takeover_to_operations(text,text,text,date,text,text,text) from public,anon,authenticated;
revoke all on function public.hhd_get_device_condition_dashboard(text,date,date,text,integer) from public,anon,authenticated;
revoke all on function public.hhd_get_site_workspace(text) from public,anon,authenticated;

grant execute on function public.hhd_add_allocation_quantity(text,text,text,integer,text) to authenticated;
grant execute on function public.hhd_scan_assign_device(text,uuid,text) to authenticated;
grant execute on function public.hhd_list_custodian_device_assignments(text) to authenticated;
grant execute on function public.hhd_release_virtual_custodian_assignment(text,text,text,text) to authenticated;
grant execute on function public.hhd_hoto_resolve_device(text,text,text) to authenticated;
grant execute on function public.hhd_hoto_record_transfer(text,text,text,text,date,text,text,text,text,boolean,text,text,text) to authenticated;
grant execute on function public.hhd_hoto_takeover_to_operations(text,text,text,date,text,text,text) to authenticated;
grant execute on function public.hhd_get_device_condition_dashboard(text,date,date,text,integer) to authenticated;
grant execute on function public.hhd_get_site_workspace(text) to authenticated;

commit;
