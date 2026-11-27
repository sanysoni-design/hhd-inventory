-- Preserve operator-entered reasons in every condition history row.
begin;

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
    new.last_reference_type,new.last_reference_id,v_remarks
  );
  return new;
end;
$$;

create or replace function public.hhd_enrich_condition_history_remarks()
returns trigger
language plpgsql
security definer
set search_path=public,auth,pg_temp
as $$
begin
  if new.action_code='inventory.reconcile'
     and new.entity_type='device_stock_position'
     and nullif(trim(coalesce(new.reason,'')),'') is not null then
    update public.device_condition_history h
       set remarks=trim(new.reason)
     where h.id=(
       select h2.id from public.device_condition_history h2
        where h2.device_serial=new.entity_id
          and h2.changed_by=new.actor_user_id
          and h2.changed_at>=new.created_at-interval '2 minutes'
          and h2.changed_at<=new.created_at+interval '2 minutes'
          and h2.reference_type='opening_reconciliation'
          and h2.remarks is null
        order by h2.changed_at desc,h2.id desc
        limit 1
     );
  end if;
  return new;
end;
$$;
drop trigger if exists hhd_enrich_condition_history_remarks on public.admin_audit_events;
create trigger hhd_enrich_condition_history_remarks
after insert on public.admin_audit_events
for each row execute function public.hhd_enrich_condition_history_remarks();

revoke all on function public.hhd_track_device_condition_change() from public,anon,authenticated;
revoke all on function public.hhd_enrich_condition_history_remarks() from public,anon,authenticated;

-- Backfill condition events already logged during the opening-reconciliation workflow.
update public.device_condition_history h
   set remarks=a.reason
  from lateral (
    select ae.reason,ae.created_at
      from public.admin_audit_events ae
     where ae.action_code='inventory.reconcile'
       and ae.entity_type='device_stock_position'
       and ae.entity_id=h.device_serial
       and ae.actor_user_id is not distinct from h.changed_by
       and ae.created_at between h.changed_at-interval '2 minutes' and h.changed_at+interval '2 minutes'
       and nullif(trim(coalesce(ae.reason,'')),'') is not null
     order by abs(extract(epoch from (ae.created_at-h.changed_at)))
     limit 1
  ) a
 where h.reference_type='opening_reconciliation'
   and h.remarks='opening_reconciliation';

commit;
