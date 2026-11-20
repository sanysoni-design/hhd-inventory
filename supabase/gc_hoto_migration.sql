-- HHD Inventory: GC lookup and readable custody event names
-- Run this in Supabase SQL Editor BEFORE importing GC_Master_Import.csv.

create table if not exists public.gc_master (
  "EmployeeID" text primary key,
  "Valinor" text not null unique,
  "Name" text not null,
  "Designation" text not null,
  "BranchCode" text not null,
  "CurrentStatus" text not null,
  "SyncedAt" timestamptz not null default now()
);

create index if not exists gc_master_valinor_idx on public.gc_master ("Valinor");
create index if not exists gc_master_branch_status_idx on public.gc_master ("BranchCode", "CurrentStatus");

alter table public.gc_master enable row level security;

alter table public.device_logs add column if not exists "FromName" text;
alter table public.device_logs add column if not exists "ToName" text;

notify pgrst, 'reload schema';
