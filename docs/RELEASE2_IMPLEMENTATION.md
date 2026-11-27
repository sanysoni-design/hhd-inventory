# HHD Tracking — Release 2 implementation

## Branch separation

Release 2 was developed on `release-2-implementation`, based on `feature/operations-live-phase1`, then fast-forwarded onto `feature/operations-live-phase1`.

- `feature/operations-live-phase1` now contains the Release 2 implementation.
- `feature/hhd-test-accounts` remains the temporary test-account deployment branch and was not modified.
- The test-account branch is intentionally separate and is now 33 commits behind the implementation branch, with its own one test-account commit.
- `main` is unchanged.
- The Release 2 migration and Edge Function have not been deployed to the live Supabase project.

## Included changes

### 1. Role nomenclature
The UI and database role display names are changed to:
- `site_lead` → Allocator
- `assigned_employee` → Custodian
- `operations_spoc` → Asset Manager

The immutable role codes are retained so existing role assignments and permissions are not broken.

### 2. Admin-managed user lifecycle
A new `admin-manage-user` Edge Function provides:
- Admin-only account creation through Supabase Auth Admin.
- Email-confirmed account provisioning without sending an invitation/creation email.
- Admin editing of name, Login ID, Employee ID, email, designation and process.
- Admin-initiated password reset.
- Audit events for create, update and password reset.

The new Operations UI calls this function. The older `admin-create-user` invite flow is no longer used by the Release 2 UI.

**Password visibility:** Auth passwords are hashed. Admins can set/reset a password, but the current plaintext password is never retrievable. Password values are not written to app tables, audit payloads or logs.

Employee ID edits must point to an active On-roll Employee Master record. The user must not have active HHD assignments or active allocation entitlements when changing their employee ID; this preserves the historical foreign-key references.

### 3. Password recovery and change
- Forgot password action on the login screen.
- Auth recovery link flow for every role.
- Signed-in user password change with current-password verification.
- Admin reset through the user edit screen.
- UI and Edge Function validation: 6–72 characters.

Supabase's hosted Auth project setting must also be updated to a minimum length of 6, or Auth may reject a password accepted by the UI. Supabase recommends a minimum of at least 8 characters; the requested 6-character rule is a deliberate security trade-off.

### 4. Barcode scanning
Reusable `ScanInput` fields are provided for HHD serial/IMEI and GC/TL IDs in:
- Custodian device collection.
- HOTO handover / takeover.
- HOTO return.
- Stock reconciliation.
- STO dispatch and STO receipt.

A USB/Bluetooth scanner that types into the focused field works like a keyboard. Camera barcode scanning is available where the browser supports `BarcodeDetector` and camera access over HTTPS. Manual typing remains available.

### 5. IMEI-level history
The additive migration:
- Adds an IMEI snapshot to `device_movement_ledger` and backfills existing rows from the device master.
- Automatically stamps IMEI on future movement entries.
- Audits device-master IMEI, Status and FaultReason changes.
- Audits owner department, stock state, physical condition and functional condition changes in `device_stock_positions`.
- Adds a filtered movement-ledger read function for authorized site users.

The ledger preserves the IMEI at the time of the event, even if the device master IMEI is later corrected.

### 6. Multi-site assignments
Users and role assignments accept multiple selected sites. Assignments remain individual user-role-site rows for revocation and audit history. The global `All sites` selector is reserved for the Admin role. Custodian accounts should remain tied to the site of their On-roll employee record.

### 7. Role and employee permissions
- The On-roll Employee Master screen requires explicit `admin_employees.view`.
- Distribution users receive a separate minimal employee picker with only the fields needed to make an allocation.
- Roles & Permissions requires `admin_roles.view`.
- Permission changes require `admin_roles.manage_permissions` in both the UI and database function.
- The backend employee-master function no longer falls back to the broader `distribution.view` permission.

### 8. Stock Transfer Orders
The migration adds STO header and line tables and the following atomic RPCs:
- `hhd_sto_create_dispatch`: scan and validate devices at the source site, then dispatch them into transit.
- `hhd_sto_receive_device`: scan each device at the destination, receive it into IT, Operations or Superstore, and allow partial receipt.
- `hhd_sto_list`: list authorized incoming and outgoing transfers.

Dispatch rejects unknown/duplicate devices, un-reconciled stock, wrong source site, active employee assignments, devices in an unsuitable state/condition, and devices already in an open STO.

## Supabase configuration required before testing

1. Take a database backup or use an isolated Supabase development branch.
2. Review and apply `supabase/migrations/20261127120000_hhd_release2.sql` once. It is additive to the existing Phase 1 schema; do not re-run the Phase 1 bootstrap migration.
3. Deploy `supabase/functions/admin-manage-user/index.ts` as the `admin-manage-user` Edge Function.
4. Confirm the function configuration in `supabase/config.toml` has `verify_jwt = true`.
5. In Supabase Auth settings:
   - Set the minimum password length to 6 (the user-requested rule).
   - Disable public user sign-ups so application accounts are Admin-created only.
   - Add the deployed application URL, including its password-recovery redirect, to the allowed redirect URLs.
   - Configure a production SMTP provider for password recovery emails.
6. Run the Supabase security advisor and review any new findings before production rollout.

The application password flows are not fully deployable until the Edge Function, additive migration and hosted Auth settings are in place. These were committed to GitHub only; this branch has not been applied to the live Supabase project.

## Release 2 acceptance checklist

### Account lifecycle
- [ ] Admin creates a real user; no invitation/creation email is sent.
- [ ] New user appears as Active and can sign in using the Admin-provided initial password.
- [ ] A non-Admin user cannot call the Admin create/update/reset Edge Function.
- [ ] Admin edits full name, Login ID, Employee ID and email; changes persist in both Auth and the application profile.
- [ ] Employee ID update rejects duplicates, inactive IDs and users with active allocations/assignments.
- [ ] Admin resets a password; the user can sign in with the new password.
- [ ] Admin cannot read/retrieve an existing plaintext password.
- [ ] Each role can request a forgotten-password link and change its own password.
- [ ] Passwords of 6 characters are accepted after the hosted Auth minimum is set to 6; passwords below 6 are rejected.

### Roles and permissions
- [ ] Allocator, Custodian and Asset Manager labels appear while stored role codes remain unchanged.
- [ ] Admin assigns one user to one site and to multiple sites.
- [ ] Admin can use All sites; a non-Admin assignment cannot use `*`.
- [ ] Asset Manager with `distribution.view` but without `admin_employees.view` does not see the On-roll Employee Master page.
- [ ] The same Asset Manager can use the minimal employee picker in allocation workflows.
- [ ] Direct RPC call to `hhd_admin_list_onroll_employees` is denied without `admin_employees.view`.
- [ ] Roles & Permissions is hidden without `admin_roles.view`; save operations are rejected without `admin_roles.manage_permissions`.

### Barcode / HOTO / custody
- [ ] Hardware barcode scanner types Serial/IMEI into each ScanInput.
- [ ] Camera scan works on supported HTTPS browsers; unsupported browsers retain manual/keyboard scan input.
- [ ] HHD Serial / IMEI and GC/TL employee ID are scanned during HOTO.
- [ ] Wrong-site, inactive and unknown GC/TL IDs are rejected by the backend.
- [ ] HOTO return records the HHD condition and restores the primary custodian.

### IMEI audit
- [ ] Device assignment creates a ledger event with IMEI.
- [ ] Device return creates a ledger event with IMEI.
- [ ] Each HOTO transfer / takeover / return creates a ledger event with IMEI and holder transition.
- [ ] Opening-stock reconciliation creates a ledger event with IMEI.
- [ ] Device stock state, department, physical condition and functional condition changes create history.
- [ ] Device-master Status, FaultReason and IMEI changes create history.
- [ ] Historical events retain the IMEI snapshot that applied at the time.

### STO
- [ ] Source-site user scans and dispatches multiple eligible HHDs.
- [ ] Duplicate / unknown / assigned / unavailable / unsuitable-condition device is rejected.
- [ ] Destination user receives a single HHD by Serial or IMEI.
- [ ] Partial and full receipt update the STO status correctly.
- [ ] Each dispatch, each device receipt, and the associated stock state changes appear in the IMEI movement ledger.
- [ ] A user without source dispatch or destination receive permission is denied by the backend.

## Rollout sequence

1. Review the Release 2 branch and complete acceptance tests in a non-production environment.
2. Deploy this branch as a preview using the Release 2 Supabase development backend.
3. Run the test matrix above with Admin, Site IT, Asset Manager, Allocator and Custodian test accounts.
4. After sign-off, merge the release branch into `feature/operations-live-phase1` or open a PR for review.
5. Apply the approved migration and deploy the Edge Function in production, then deploy the approved frontend branch.
