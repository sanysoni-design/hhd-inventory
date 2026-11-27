-- Device summary condition columns must reflect the live inventory position,
-- not merely the last condition event inside the selected reporting window.
begin;
do $$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.hhd_get_device_condition_dashboard(text,date,date,text,integer)'::regprocedure
  ) into v_def;

  v_old := E'p.stock_state as current_stock_state,\n           p.owner_department as current_owner_department';
  v_new := E'p.stock_state as current_stock_state,\n           p.owner_department as current_owner_department,\n           p.physical_condition as current_physical_condition,\n           p.functional_condition as current_functional_condition';
  if position(v_old in v_def)=0 then raise exception 'Could not locate dashboard live stock-position columns'; end if;
  v_def:=replace(v_def,v_old,v_new);

  v_old := E'max(f.physical_condition) filter(where f.changed_at=latest.latest_at) current_physical_condition,\n               max(f.functional_condition) filter(where f.changed_at=latest.latest_at) current_functional_condition,\n               max(f.current_stock_state) current_stock_state';
  v_new := E'max(f.current_physical_condition) current_physical_condition,\n               max(f.current_functional_condition) current_functional_condition,\n               max(f.current_stock_state) current_stock_state';
  if position(v_old in v_def)=0 then raise exception 'Could not locate dashboard current-condition aggregation'; end if;
  v_def:=replace(v_def,v_old,v_new);
  execute v_def;
end;
$$;
commit;
