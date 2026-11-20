select count(*) as total_gc,
       count(*) filter (where upper("CurrentStatus") = 'LIVE') as live_gc,
       count(*) filter (where upper("CurrentStatus") = 'LEFT') as left_gc,
       count(*) filter (where upper("CurrentStatus") = 'NOT_IN_SOURCE') as removed_from_source,
       max("SyncedAt") as latest_sync
from public.gc_master;
