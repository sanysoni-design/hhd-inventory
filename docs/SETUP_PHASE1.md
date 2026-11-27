# HHD Operations Phase 1 — Setup and Deployment

Version: 0.2  
Date: 25 November 2026  
Scope: Admin identity/RBAC, on-roll employee login/master, TL/GC HR synchronization, Operations opening stock, quantity allocations, employee IMEI assignment/return, and shift HOTO.

## 0. Deployment boundary

This is an additive Phase 1 Operations backend and live UI. It does **not** implement the universal STO engine, Vendor PO/GRN, Superstore putaway, Vendor Return/Repair/Replacement, or full procurement lifecycle. The current legacy Apps Script app remains available at the ordinary route and continues to own the existing IT/Operations STO process until a separate STO phase is designed and tested.

Routes:
- `/?ops-ui=preview` — sample-data preview, no production writes.
- `/?ops-live=1` — new Supabase-backed Phase 1 Operations workspace.
- `/` — existing legacy application route.

Do not point users to `ops-live=1` until the migration, Auth bootstrap, Edge Functions, and preview environment variables have been completed.

## 1. Required project values and secrets

Keep these in a secure password manager, not Git or chat.

### Frontend (Vercel Preview environment only for initial testing)
- `VITE_SUPABASE_URL`: `https://<project-ref>.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY`: `sb_publishable_...`

The frontend must never contain an `sb_secret_...`, legacy `service_role` JWT, HR sync secret, or other privileged key. Do not create `VITE_SUPABASE_SECRET_KEY`.

The existing `VITE_API_URL` for the legacy application remains as it is. The new Operations route uses the Supabase client-side Auth/REST endpoints via a browser-safe publishable key.

### Supabase Edge Function secrets
- `APP_INVITE_REDIRECT_URL`: stable Vercel preview URL ending in `/?ops-live=1`.
- `HR_SYNC_MIN_ROWS`: set to `0` for incremental/non-snapshot HR sync initially. Set to a conservative minimum only after HR confirms the tab is a complete worker snapshot.

For `admin-create-user`, `@supabase/server` uses the managed project secret-key context (`supabaseAdmin`) inside the Edge Function. Do not hardcode a service key.

For HR sync, create a dedicated Supabase Secret API key named **`hr_sync`** (Settings → API Keys → Secret keys). Copy it to Apps Script Script Properties as `HR_SYNC_SECRET_KEY`. This key is sent only in the `apikey` header to the `hr-sync-workers` Edge Function. Never put it in Vercel.

## 2. Preflight: inspect and back up the LIVE database

Do not run the migration until these checks are complete.

1. Take a fresh Supabase database backup/export and record the backup time.
2. In Supabase SQL Editor, inspect the live schema, not only the supplied 19-Nov backup.
3. Confirm these existing objects and columns:
   - `public.sites` with `"Site"` as the site key.
   - `public.devices` with `"Serial"` as the primary asset identifier, `"Make"`, `"Model"`, `"Location"`, `"Status"`, and `imei_number`.
   - `public.users` and all legacy ticket/custody tables remain present.
4. Compare the live `public.devices.imei_number` data and `"Serial"` values. `Serial` remains the canonical asset key. IMEI is accepted only when it maps to exactly one device.
5. Run the duplicate IMEI query from `supabase/validation/verify_phase1.sql`. Resolve/flag duplicates before operational IMEI scanning. Do not add a unique IMEI constraint until the live data has been audited and duplicates are handled.
6. Confirm every target site string in the employee/HR master exactly maps to `public.sites."Site"` (case-insensitive lookup is used by HR sync; canonical site spelling is stored).

**Important:** This package's migration assumes the existing `sites` and `devices` table/columns described above. It does not recreate the live schema. Do not apply the old base `schema.sql` to the production project.

## 3. Apply the additive SQL migration

1. Open Supabase → SQL Editor.
2. Open `supabase/migrations/20261125170000_hhd_operations_foundation.sql`.
3. Read the header and confirm it targets the expected Supabase project.
4. Execute the entire migration once. It creates the Phase 1 tables, permission catalogue, checked RPCs, triggers and grants in a transaction.
5. If SQL Editor reports any error, stop. Do not continue to Edge Function deployment or user invitations. Save the full error message and line number for review.
6. Run `supabase/validation/verify_phase1.sql` and confirm all 15 foundation tables, five built-in roles and permission rows are present.

The migration intentionally does not alter or delete `public.users`, old device tickets, legacy logs or existing device records. It adds a separate `app_users` table tied to Supabase Auth.

## 4. Bootstrap the first Admin

The first Admin must be created before the Admin UI can provision other users.

1. Supabase → Authentication → Users → Add user.
2. Create the initial Admin email and confirm/auto-confirm the email.
3. In `supabase/bootstrap/01_first_admin.sql`, replace `REPLACE_WITH_FIRST_ADMIN_EMAIL` in both places with the exact email.
4. Execute the bootstrap SQL in SQL Editor.
5. Verify the final query returns `account_status=active`, `role_code=admin`, `site_code=*`.
6. Configure Vercel Preview environment values from section 1, deploy the feature branch preview, and open `/?ops-live=1`.
7. Sign in using the Admin Auth email and password.

Never create the first Admin by adding a browser-side privileged key or by disabling RLS.

## 5. Configure Auth invitation delivery

Admin-created users receive an invitation through Supabase Auth.

1. Configure a production-capable SMTP provider in Supabase Auth. Do not rely on development/test mail delivery for an operational rollout.
2. Set Auth Site URL and add the exact Vercel Preview redirect URL to the allowed redirect URLs.
3. Set `APP_INVITE_REDIRECT_URL` to `https://<stable-preview-host>.vercel.app/?ops-live=1`.
4. In Authentication → Email Templates → Invite User, use the content in `docs/INVITE_EMAIL_TEMPLATE.html`. It includes `{{ .RedirectTo }}`, `{{ .TokenHash }}`, and `type=invite`.
5. Test an invitation to a controlled non-production account. Accept it and set a password before inviting site users.

The invited profile remains `invited` until Supabase Auth confirms the email. The database trigger then activates the application profile. An invited/unconfirmed employee cannot receive allocations.

## 6. Deploy the Edge Functions

Install/use the Supabase CLI on the development machine. From the repository root:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase secrets set APP_INVITE_REDIRECT_URL="https://YOUR_PREVIEW_HOST.vercel.app/?ops-live=1" HR_SYNC_MIN_ROWS="0"
npx supabase functions deploy admin-create-user
npx supabase functions deploy hr-sync-workers
```

`supabase/config.toml` sets `admin-create-user` to JWT verification and `hr-sync-workers` to `verify_jwt=false`; the latter validates the specifically named `hr_sync` Secret key through `@supabase/server`.

Do not manually set `SUPABASE_SERVICE_ROLE_KEY` in the frontend. Do not change `verify_jwt` for `admin-create-user` to false.

## 7. Configure the HR TL/GC Google Sheet synchronization

Add `apps-script/HR_Sync.gs` as a **new file** in the existing Apps Script project. Do not replace `Code.gs`; the existing Apps Script web app continues to run the legacy STO/ticket routes in this phase.

The HR-owned tab must contain these columns (case/spacing aliases are accepted):

- `EmployeeID`
- `Name`
- `WorkerType` (only `TL` or `GC`)
- `Site`
- `Process` (optional)
- `Status` (Active/Live or Inactive/Left)
- `UpdatedAt` (optional)

The HR tab must include all TL and GC rows that are expected to be valid for HOTO. The application does not create TL/GC login accounts and does not permit Admin to edit their HR employment status.

Apps Script → Project Settings → Script Properties:
- `HR_SPREADSHEET_ID`: exact HR spreadsheet ID.
- `HR_SHEET_NAME`: exact worksheet/tab name.
- `HR_SYNC_ENDPOINT`: `https://<project-ref>.supabase.co/functions/v1/hr-sync-workers`.
- `HR_SYNC_SECRET_KEY`: the dedicated Supabase Secret key named `hr_sync`.
- `HR_SYNC_FULL_SNAPSHOT`: `false` initially.
- `HR_SYNC_HEADER_ROW`: `1`, unless the source headers are on another row.

Then:
1. Run `syncHrWorkersToSupabase()` manually and authorize the script.
2. Check Supabase `hr_sync_runs` and the Admin → HR TL/GC master screen.
3. Check row counts, missing/duplicate employee IDs, site names and TL/GC counts with HR.
4. Only when HR confirms the tab contains the **complete** worker population, set `HR_SYNC_FULL_SNAPSHOT=true`, choose a safety minimum row count, and set the same `HR_SYNC_MIN_ROWS` Edge Function secret. A snapshot below the minimum is rejected. This protects against accidental mass deactivation if the sheet is filtered or partially loaded.
5. Run one more manual sync and inspect the deactivation count.
6. Run `setupHrWorkerSyncTrigger()` once to create the hourly trigger. Do not create multiple triggers manually.

If the HR source is not complete or HR cannot confirm completeness, keep `HR_SYNC_FULL_SNAPSHOT=false`. Incremental sync does not deactivate rows missing from a sheet snapshot.

## 8. Configure Vercel Preview

1. Vercel → Project `hhd-inventory` → Settings → Environment Variables.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for **Preview only** during the pilot.
3. Keep the existing `VITE_API_URL` unchanged for the legacy route.
4. Do not add Supabase Secret keys, `HR_SYNC_SECRET_KEY`, passwords or other privileged credentials to Vercel.
5. Redeploy `feature/operations-advanced-ui` after adding the variables.
6. Open `https://<preview-host>.vercel.app/?ops-live=1`.

The `?ops-ui=preview` route remains the sample UI. The plain `/` route remains the legacy application.

## 9. Initial Admin configuration

After sign-in:

1. Admin → Organization/On-roll Employees (On-roll employee master screen): create the active on-roll employee record with exact Employee ID, site, designation, process and work email.
2. Admin → User & ID Management: invite the same person with matching Employee ID, work email and login ID. For Operations roles, designation is required. Employee ID is linked to the `onroll_employee_master` record. For a new record, the invite function creates/links the on-roll master row.
3. Assign a role and site. Supported system role codes are `site_it`, `operations_spoc`, `site_lead`, `assigned_employee`, and `admin`.
4. Admin → Roles & Permissions: create custom roles if required, then grant module/action permissions and data scopes. Custom roles cannot be given a global `*` site assignment. The Admin role is the only global role.
5. Users should accept the email invitation and set a password before tests requiring an active account.
6. TL/GC records only arrive from HR sync. Never provision TL/GC as application users.

Note: Role and permission configuration is enforced by database RPCs. Hiding a UI menu is not the security control. If a permission is enabled, the backend still validates the current user, requested site and record ownership.

## 10. Opening stock reconciliation

Before any employee collection, reconcile the existing on-site physical inventory into `device_stock_positions`.

1. Perform a physical count and scan the canonical asset `Serial` for each HHD.
2. Match the record to `public.devices`. If using IMEI, confirm it resolves to exactly one device.
3. Admin/authorized Inventory user records site, owner department, state, physical condition, functional condition and a mandatory reason in Opening Stock Reconciliation.
4. Only `available` + `good` + `working` Operations stock is eligible for new allocation/collection.
5. Damaged, not-working, unknown, lost and maintenance devices are not eligible for allocation.
6. Do not reconcile a device over an active employee assignment or active HOTO holder. Close the live custody flow first.

The migration does not auto-assume all devices are Operations stock. Only the opening count should set Phase 1 positions.

## 11. Controlled pilot and acceptance tests

Pilot one site and a small number of devices/users first. Use the `docs/ACCEPTANCE_TESTS.md` checklist. Test every role using separate accounts and confirm site boundaries. Do not use real operational HHDs until all negative tests pass.

## 12. Rollout boundary and known limitations

- The universal STO screen is a placeholder in Phase 1. Continue using the existing legacy STO workflow until a separately scoped STO release is implemented.
- PO inbound, GRN, staging, putaway, Superstore inventory, vendor returns, repairs and replacements are not implemented in Phase 1.
- The current Apps Script `Code.gs` remains responsible for the legacy app and uses its existing Supabase key/header scheme. Do not replace its old key with an `sb_secret_...` value unless its request headers are migrated first. The HR helper is separate and uses its dedicated `hr_sync` Secret key in the `apikey` header only.
- The old legacy `public.users` login and new Supabase Auth `app_users` are parallel during this migration. Do not delete old users or logs.
- This package has not been run against the user's live Supabase project. SQL must be executed and verified there before this route can work.
