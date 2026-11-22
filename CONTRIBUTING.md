# Contributing

AnyLink is a protocol and SDK project with independently maintained reference clients. Keep new integrations at the adapter boundary; do not add a mandatory dependency on a particular agent harness.

1. Fork either mirror and work on a topic branch. Submit pull requests to GitHub; the maintainer reconciles Gitee changes before synchronizing `main`.
2. Install Node 24 and run `npm ci`, `npm run check`, `npm run test:sdk`, and `npm run protocol:check`.
3. Run `npm run test:integration` against a disposable database named **anylink_test**. The suite rebuilds that database schema. Never point it at product data.
4. Protocol changes need a corresponding SDK/contract update and a boundary test. Preserve revision checks, durable receipts, agent-scoped memory isolation, and unknown-outcome behavior.
5. Do not commit credentials, model assets, Cubism Core, user transcripts, databases, or host-specific profiles. Public Android builds are asset-free by default. Run `npm run release:audit` before publishing.

English and Chinese README files must describe the same shipping capabilities. Label mockups, browser previews, reference implementations, and hardware validation accurately. Keep license notices when copying third-party code.

Mirror publication is `npm run repo:sync` from a clean `main` checkout. It checks remote divergence and never force-pushes. Release binaries are hosted on GitHub Releases; both mirrors link to the same artifacts and checksums.
