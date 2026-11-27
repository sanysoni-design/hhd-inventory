-- Prevent direct reconciliation from moving existing devices into Site IT.
begin;

do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.hhd_admin_reconcile_device_position(text,text,text,text,text,text,text)'::regprocedure
  ) into v_def;
  v_old := 'select to_jsonb(p) into v_before from public.device_stock_positions p where device_serial=trim(p_device_serial);';
  v_new := v_old || E'\n  if p_owner_department=''it'' and v_before is not null and\n     (coalesce(v_before->>''owner_department'','''')<>''it'' or coalesce(v_before->>''site_code'','''')<>p_site_code) then\n    raise exception ''Moving an existing HHD into Site IT must be done through an approved STO'';\n  end if;';
  if position(v_old in v_def)=0 then raise exception 'Could not patch single-device reconciliation function'; end if;
  execute replace(v_def,v_old,v_new);

  select pg_get_functiondef(
    'public.hhd_admin_reconcile_device_positions(jsonb,text)'::regprocedure
  ) into v_def;
  v_old := 'select to_jsonb(p) into v_before from public.device_stock_positions p where device_serial=v_serial for update;';
  v_new := v_old || E'\n    if v_owner=''it'' and v_before is not null and\n       (coalesce(v_before->>''owner_department'','''')<>''it'' or coalesce(v_before->>''site_code'','''')<>v_site) then\n      raise exception ''Moving an existing HHD into Site IT must be done through an approved STO: %'',v_serial;\n    end if;';
  if position(v_old in v_def)=0 then raise exception 'Could not patch batch reconciliation function'; end if;
  execute replace(v_def,v_old,v_new);
end;
$$;

-- Trigger helper functions are invoked by table triggers, never directly through PostgREST.
revoke all on function public.hhd_audit_device_master_status_change() from public,anon,authenticated;
revoke all on function public.hhd_audit_device_position_change() from public,anon,authenticated;

create index if not exists device_condition_history_changed_by_idx
  on public.device_condition_history(changed_by);

commit;
