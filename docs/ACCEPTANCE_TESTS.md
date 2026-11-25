# HHD Operations Phase 1 — Acceptance Tests

Run these tests in a non-production preview/pilot site with test devices and separate test logins. Record test operator, timestamp, result and evidence.

## Identity and authorization

- [ ] First Admin can sign in and has global `*` scope.
- [ ] Admin can invite an on-roll user with login ID, Employee ID, role and site.
- [ ] Invite remains `invited` until email confirmation and password setup; then becomes active.
- [ ] Duplicate login ID, email or Employee ID linkage is rejected.
- [ ] TL/GC cannot be created as application users through the normal User & ID screen.
- [ ] Site-scoped user cannot list or mutate another site by changing request parameters.
- [ ] Site-scoped custom role with an `all_sites` permission grant remains bounded to its assigned site (scope ceiling test).
- [ ] Custom roles cannot be assigned `*` global site scope.
- [ ] Admin cannot deactivate itself or the last active Admin.
- [ ] Permission/role assignment and account deactivation appear in audit history.

## HR TL/GC synchronization

- [ ] HR Sheet sync accepts valid TL and GC records with exact Employee IDs and known sites.
- [ ] Missing required columns, invalid worker type/status, unknown site and duplicate IDs are rejected before syncing.
- [ ] Incremental sync with `snapshot_complete=false` does not deactivate missing rows.
- [ ] Empty payload is rejected.
- [ ] Complete snapshot under `HR_SYNC_MIN_ROWS` is rejected.
- [ ] Complete snapshot above configured minimum deactivates only HR records absent from that verified complete sheet.
- [ ] Active off-roll worker in another site is rejected by HOTO.
- [ ] Inactive off-roll worker is rejected for new HOTO.
- [ ] HR sync older than 26 hours is rejected for new HOTO.
- [ ] HR sync runs appear in Admin UI with counts and result.

## Opening inventory and quantity allocation

- [ ] Unreconciled device cannot be allocated.
- [ ] Duplicate/ambiguous IMEI is rejected; unique Serial works.
- [ ] Only Operations `available` + `good` + `working` device positions count as allocatable stock.
- [ ] Site Lead can create a quantity-only entitlement for an active, same-site on-roll employee with an active application login.
- [ ] Site Lead cannot select or map an IMEI in the allocation process.
- [ ] Allocations are reserved so two concurrent requests cannot reserve the same remaining stock.
- [ ] Allocation cannot exceed allocatable stock after existing uncollected reservations.
- [ ] Reduction below active device assignments is rejected.
- [ ] Reduction with enough returned devices but no reason is rejected.
- [ ] Approved reduction with a reason creates an allocation event and audit record.
- [ ] Optimistic version conflict prompts refresh rather than silently overwriting a newer allocation.

## Assigned employee collection and return

- [ ] Assigned employee sees only their own allocation and assigned devices.
- [ ] Employee cannot scan more devices than authorized quantity.
- [ ] Device from another site or another department is rejected.
- [ ] Device already assigned or not in good/working available stock is rejected.
- [ ] Successful scan maps the canonical device Serial to the signed-in employee and creates movement/audit records.
- [ ] Device can be returned only by an authorized user and while no off-roll holder remains in HOTO.
- [ ] Good + Working return becomes available Operations stock.
- [ ] Damaged and/or Not Working return becomes quarantined.

## TL/GC HOTO

- [ ] Operations SPOC can hand a currently assigned good/working HHD to an active, same-site HR TL/GC.
- [ ] TL/GC has no application account and does not receive login invitation.
- [ ] HOTO keeps the original primary on-roll assignment unchanged.
- [ ] Shift takeover/mid-shift swap requires current holder to be off-roll.
- [ ] Same TL/GC cannot be recorded as both current and next holder.
- [ ] Damaged or non-working device cannot be newly handed to a TL/GC.
- [ ] HOTO return records physical and functional condition.
- [ ] After HOTO return to primary, a damaged/non-working device must be returned/closed into quarantine before new allocation.
- [ ] HOTO event appears in movement and audit history.

## Regression and route isolation

- [ ] `/?ops-ui=preview` still opens the sample preview and does not call live APIs.
- [ ] `/?ops-live=1` opens the live Supabase Auth workspace.
- [ ] `/` continues to open the existing legacy application.
- [ ] Existing Apps Script STO/ticket flows remain unchanged.
- [ ] Production `main` is not changed during the pilot.
