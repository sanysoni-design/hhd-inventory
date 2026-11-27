-- No direct inventory reconciliation may create or move physical stock into Site IT.
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
  v_old := E'if p_owner_department=''it'' and v_before is not null and\n     (coalesce(v_before->>''owner_department'','''')<>''it'' or coalesce(v_before->>''site_code'','''')<>p_site_code) then\n    raise exception ''Moving an existing HHD into Site IT must be done through an approved STO'';\n  end if;';
  v_new := E'if p_owner_department=''it'' then\n    raise exception ''Site IT stock must be received only against an approved STO'';\n  end if;';
  if position(v_old in v_def)=0 then raise exception 'Could not update single-device reconciliation guard'; end if;
  execute replace(v_def,v_old,v_new);

  select pg_get_functiondef(
    'public.hhd_admin_reconcile_device_positions(jsonb,text)'::regprocedure
  ) into v_def;
  v_old := E'if v_owner=''it'' and v_before is not null and\n       (coalesce(v_before->>''owner_department'','''')<>''it'' or coalesce(v_before->>''site_code'','''')<>v_site) then\n      raise exception ''Moving an existing HHD into Site IT must be done through an approved STO: %'',v_serial;\n    end if;';
  v_new := E'if v_owner=''it'' then\n      raise exception ''Site IT stock must be received only against an approved STO: %'',v_serial;\n    end if;';
  if position(v_old in v_def)=0 then raise exception 'Could not update batch reconciliation guard'; end if;
  execute replace(v_def,v_old,v_new);
end;
$$;
commit;
