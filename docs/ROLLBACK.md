# HHD Operations Phase 1 — Rollback and Recovery

## Safe rollback principles

- The Phase 1 migration is additive. It does not delete or replace legacy `public.users`, existing `devices`, tickets or legacy logs.
- Do not drop the new tables or functions as the first rollback step. They may contain invited users, HR identities, allocation events, device assignments, HOTO and audit evidence after testing.
- Never restore an old database backup over production without an explicit recovery decision and a fresh backup of the current state.

## Disable new UI access

1. In Vercel, stop sharing or disable the Phase 1 preview deployment.
2. The production `/` route remains the legacy application route. The new route is isolated at `/?ops-live=1`.
3. If the feature branch has been merged into another branch, revert the specific App.jsx route/import and new `frontend/src/operations` files in a reviewed Git commit. Do not reset the whole `main` branch.

## Stop HR synchronization

In Apps Script, run `removeHrWorkerSyncTrigger()`. This removes only the `syncHrWorkersToSupabase` hourly trigger. Keep the HR worker rows and sync history for review. The HR secret can be revoked/rotated in Supabase after the trigger is disabled.

## Disable user invitations

- Stop creating users through the Operations UI and remove/deploy back the `admin-create-user` Edge Function if required.
- Do not delete Auth users unless the Admin has confirmed that the identity is unused and the access/audit impact is understood.
- Deactivate compromised or unwanted application access through the Admin workflow where possible; preserve records.

## Database rollback

The recommended first response to a faulty migration is to disable the new route/functions and preserve the new tables for investigation. If a schema rollback is genuinely required, prepare a targeted reverse migration based on the actual live data and dependency graph. Do not blindly `DROP TABLE` because foreign keys and audit history may contain operational evidence.

## Credential response

If any Supabase Secret key, legacy service_role JWT, HR sync key or password appears in a screenshot, log, repository or chat:
1. Identify every consumer of that key.
2. Create/rotate the replacement on the server side.
3. Update each consumer and test it.
4. Revoke the exposed key after consumers have migrated.
5. Remove accidental secret values from repository history where applicable; deleting a file in a new commit does not erase previous Git history.
