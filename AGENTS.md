# AGENTS.md

## Verify

- Server/web types: `npm run check`; unit: `npm test`; SDK: `npm run test:sdk`; protocol drift: `npm run protocol:check` (regenerate with `npm run protocol:generate`).
- Integration (real PostgreSQL, disposable `anylink_test` only; URL in `secrets/integration.json`): `npm run test:integration`. Local container: `anylink-test-pg` on 127.0.0.1:55432 (OrbStack).
- Mac (reference client): `npm run test:mac`, `npm run test:peer`, `npm run test:companion`, `npm run test:mac-control`.
- Android (reference client): `node examples/android-native/scripts/build.mjs --test`; public APK `node examples/android-native/scripts/build.mjs` + `node examples/android-native/scripts/inspect-apk.mjs`; private (owner-only, Live2D) `npm --prefix examples/android-native run build:private` + `node examples/android-native/scripts/inspect-apk.mjs --private`.
- Before pushing to GitHub (public mirror): `npm run release:audit`.

## Deploy (ywc)

`scripts/build-release.sh` needs a clean tree (use a `git worktree` at the commit), then `bash scripts/deploy.sh artifacts/<12-char-commit> ywc` (pre-deploy pg_dump + auto-rollback). Secrets live in `/opt/anylink-agent/secrets/` on the server (`app.env` holds `ANYLINK_JOIN_KEY` and optional `ANYLINK_LOGIN_PASSWORD`); local copy of the join key: `secrets/ywc-join-key`. Public HTTPS (Caddy) only exposes `/edge/v1/*`, `/model/v1/*`, `/healthz`.

## Conventions

- Compact TypeScript/JS one-liner style, zod schemas, raw SQL via `pg`.
- Showcase clients live under `examples/` (`examples/mac-openclaw`, `examples/android-native`, `examples/persona`), cleanly isolated from the core protocol, cloud hub, SDKs, and MCP adapter.
- Persona: `examples/persona/dafeiyu.md` is shared; host appendices are `examples/mac-openclaw/persona-main.md`, `examples/mac-openclaw/persona-remote.md`, `examples/mac-openclaw/companion/persona.md`, `examples/android-native/persona.md`.
- Never commit secrets, passwords, model assets, Cubism Core, or `-private` APKs.
