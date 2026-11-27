-- Return numeric zeroes for empty condition-history periods.
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
  v_old := E'  from filtered;\n\n  return jsonb_build_object';
  v_new := E'  from filtered;\n\n  v_summary := coalesce(v_summary,jsonb_build_object(\n    ''total_changes'',0,''physical_changes'',0,''functional_changes'',0,''devices_affected'',0\n  ));\n\n  return jsonb_build_object';
  if position(v_old in v_def)=0 then raise exception 'Could not locate dashboard summary return block'; end if;
  execute replace(v_def,v_old,v_new);
end;
$$;
commit;
