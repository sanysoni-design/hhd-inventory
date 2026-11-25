-- Read-only Phase 1 verification queries. Safe to run after migration.

-- 1. Foundation tables exist.
select table_name
from information_schema.tables
where table_schema='public'
  and table_name in (
    'app_users','app_roles','app_permissions','role_permissions','user_role_assignments',
    'onroll_employee_master','offroll_worker_master','hr_sync_runs','device_stock_positions',
    'allocation_entitlements','device_assignments','allocation_events','device_movement_ledger',
    'hoto_transactions','admin_audit_events'
  )
order by table_name;

-- 2. Built-in system roles and permission counts.
select r.role_code, r.role_name, r.scope_type, r.is_system_role, r.is_active,
       count(rp.permission_code) filter (where rp.is_allowed) as allowed_permissions
from public.app_roles r
left join public.role_permissions rp on rp.role_code=r.role_code
group by r.role_code,r.role_name,r.scope_type,r.is_system_role,r.is_active
order by r.is_system_role desc,r.role_name;

-- 3. Site master count and device inventory count.
select (select count(*) from public.sites) as site_count,
       (select count(*) from public.devices) as device_count;

-- 4. Duplicate nonblank IMEIs. Any returned row requires investigation before IMEI scanning is enabled.
select trim(imei_number) as imei, count(*) as matching_device_rows,
       array_agg("Serial" order by "Serial") as asset_serials
from public.devices
where nullif(trim(imei_number),'') is not null
group by trim(imei_number)
having count(*) > 1
order by count(*) desc, trim(imei_number);

-- 5. Devices without an operations opening position. Reconcile these only after physical verification.
select count(*) as devices_without_stock_position
from public.devices d
left join public.device_stock_positions p on p.device_serial=d."Serial"
where p.device_serial is null;

-- 6. HR sync health.
select id,status,received_rows,inserted_rows,updated_rows,deactivated_rows,
       snapshot_complete,started_at,completed_at,message
from public.hr_sync_runs
order by started_at desc
limit 20;

-- 7. Current on-roll allocation and assignment reconciliation.
select a.site_code,a.employee_id,e.employee_name,a.process,a.authorized_quantity,
       count(da.id) filter (where da.status='active') as active_assigned,
       greatest(a.authorized_quantity-count(da.id) filter (where da.status='active'),0) as pending_collection,
       a.status,a.updated_at
from public.allocation_entitlements a
join public.onroll_employee_master e on e.employee_id=a.employee_id
left join public.device_assignments da on da.allocation_id=a.id
group by a.id,e.employee_name
order by a.site_code,e.employee_name,a.process;

-- 8. HOTO devices currently with off-roll holders.
select p.site_code,p.device_serial,p.current_holder_employee_id as offroll_employee_id,
       w.employee_name,w.worker_type,w.employment_status,w.last_synced_at,
       p.updated_at as last_device_position_update
from public.device_stock_positions p
left join public.offroll_worker_master w on w.employee_id=p.current_holder_employee_id
where p.current_holder_type='offroll'
order by p.site_code,w.employee_name;

-- 9. Confirm audit trail has rows (bootstrap may be the first row).
select created_at,action_code,entity_type,entity_id,site_code,reason
from public.admin_audit_events
order by created_at desc
limit 50;
