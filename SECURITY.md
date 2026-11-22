# Security policy

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/windowssr/AnyLink-Agent/security/advisories/new). Do not include credentials or exploit details in a public issue. If that feature is unavailable, open a minimal issue asking for a private reporting channel without disclosing the vulnerability.

The current server is a **single-owner reference deployment**. Device credentials belong to that owner's trust domain. Default memory context selects global and current-device facts; the legacy memory API permits explicit same-owner cross-device access. It is not a multi-tenant or hardware-attested isolation boundary.

Task routing is open to any joined agent advertising the capability; there is no per-pair grant. Revoking an agent stops subsequent admission and its targeted queued tasks; it does not undo an already-admitted external effect. Cancellation is cooperative. The join key lets any holder connect and dispatch to any agent, so keep it in server secrets and serve clients over HTTPS. The host must enforce workspace, application, command and approval policy at its own point of effect.

Use HTTPS for remote connections or a loopback SSH tunnel. Keep the owner token, device credentials and provider keys on trusted hosts. Do not expose the current loopback OpenClaw Gateway directly to the Internet. The server can read memory, task payloads, results and forwarded model requests; this is not end-to-end encrypted storage.

The SDK never automatically retries model calls or unknown submissions. Reuse a mutation's idempotency key to reconcile its result. Keep the worker SQLite journal across restarts. Started receipts with no durable result require inspection; they are never silently executed again. At-most-once admission is not an exactly-once guarantee for outside systems.

Release checks include Git history/current-source secret scans and package inspection. macOS preview binaries are ad-hoc signed and are not notarized. Android previews use a debug signature. Do not treat a preview as a store-reviewed release.
