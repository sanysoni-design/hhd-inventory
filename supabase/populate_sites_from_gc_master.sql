-- Run AFTER importing GC_Master_Import.csv into public.gc_master.
-- This creates the site options using the exact branch labels in the GC master.
insert into public.sites ("Site")
select distinct upper(trim("BranchCode"))
from public.gc_master
where coalesce(trim("BranchCode"), '') <> ''
on conflict ("Site") do nothing;

notify pgrst, 'reload schema';
