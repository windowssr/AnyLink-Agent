# Self-hosting

The local quickstart in the root README starts a loopback-only server and a PostgreSQL 16 container. `scripts/init-local.mjs` creates private random database/owner credentials and refuses to replace an existing `.env`. Configure your own provider key only if using model passthrough; memory and task services work without it. The database's development port is `127.0.0.1:54329`; this differs from the disposable integration-test port.

The owner UI registers logical devices and displays each credential JSON only once. Save it in an ignored file with owner-only permissions. Devices use `/edge/v1/*` and `/model/v1/*`; owner session cookies authenticate `/v1/*`. To grant a capability, use `scripts/grant-capability.mjs` with an owner-token **file**, not a token command-line argument.

## Production reference

Existing Linux/amd64 deployment scripts target an operator-managed directory at `/opt/anylink-agent`. They are not a first-time server provisioner. Prepare these ignored server secrets first:

- `secrets/postgres.env`: PostgreSQL user/database/password.
- `secrets/app.env`: `DATABASE_URL`, `OWNER_TOKEN`, `HOST=0.0.0.0`, `PORT=3180`, `APP_ORIGIN`.
- `secrets/model.env`: `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`.
- `secrets/owner-token`: the same owner token for local administrative scripts.

Protect secret files with mode 0600 and their directory with 0700. Never put them in the source archive or release image. The production Compose binds only `127.0.0.1:3180`; PostgreSQL stays on the private Compose network. Use an operator-configured HTTPS gateway or an SSH tunnel for clients. Set `APP_ORIGIN` to the actual browser origin rather than enabling permissive CORS.

```bash
# From a clean, validated source commit on macOS with Docker:
bash scripts/build-release.sh
bash scripts/deploy.sh artifacts/COMMIT_PREFIX YOUR_SSH_ALIAS
```

The release builder pins the app and PostgreSQL image identities. Deployment verifies checksums, backs up only this project's database, and switches releases through the existing owner. `scripts/rollback.sh` restores an earlier application release without deleting data volumes. Version 0.4 adds task-relay tables with an additive migration; older reference services ignore those tables.

## Operations and limits

Back up PostgreSQL and the worker's **local SQLite execution journal**. They have different owners: cloud task state alone cannot prove whether an external host action completed. Do not automatically restart/requeue uncertain work as a new task. Retain original idempotency keys to recover responses.

This service supports one owner. Same-owner device memory endpoints are not a tenant security boundary. Target execution is separately gated by source/target/capability grants. Model passthrough currently supports DeepSeek Flash, with one active request per device and a small global concurrency limit. Provider availability is separate from database liveness.

`/healthz` is process liveness. `/readyz` checks database reachability and reports whether optional provider credentials are configured; it does not spend a model request to verify upstream availability. No public hosted AnyLink endpoint or shared credentials are supplied by this repository.

Integration tests refuse any database name except `anylink_test` and rebuild that test schema. Use a disposable container, not production PostgreSQL. Never use global Docker prune/reset commands to update this project.
