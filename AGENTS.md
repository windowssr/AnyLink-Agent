# AGENTS.md

## Verify

- Server/web types: `npm run check`; unit: `npm test`; SDK: `npm run test:sdk`; protocol drift: `npm run protocol:check` (regenerate with `npm run protocol:generate`).
- Integration (real PostgreSQL, disposable `anylink_test` only; URL in `secrets/integration.json`): `npm run test:integration`. Local container: `anylink-test-pg` on 127.0.0.1:55432 (OrbStack).
- Mac: `node --test mac/connect.test.mjs mac/plugin/*.test.mjs`, `npm run test:peer`, `npm run test:companion`.
- Android: `node android-native/scripts/build.mjs --test`; public APK `node android-native/scripts/build.mjs` + `node android-native/scripts/inspect-apk.mjs`; private (owner-only, Live2D) `npm --prefix android-native run build:private` + `inspect-apk.mjs --private`.
- Before pushing to GitHub (public mirror): `npm run release:audit`.

## Deploy (ywc)

`scripts/build-release.sh` needs a clean tree (use a `git worktree` at the commit), then `scripts/deploy.sh artifacts/<12-char-commit> ywc` (pre-deploy pg_dump + auto-rollback). Secrets live in `/opt/anylink-agent/secrets/` on the server (`app.env` holds `ANYLINK_JOIN_KEY`); local copy of the join key: `secrets/ywc-join-key`. Public HTTPS (Caddy) only exposes `/edge/v1/*`, `/model/v1/*`, `/healthz`.

## Conventions

- Compact TypeScript/JS one-liner style, zod schemas, raw SQL via `pg`.
- Persona: `persona/dafeiyu.md` is shared; host appendices are `mac/persona-main.md`, `mac/companion/persona.md`, `android-native/persona.md`.
- Never commit secrets, model assets, Cubism Core, or `-private` APKs.
