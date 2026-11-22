# Reference client setup / 参考客户端安装

The clients demonstrate companion interaction and host execution. Each device connects to the AnyLink server. The Mac uses a local OpenClaw harness; Android 0.3+ owns its Agent loop on the phone. The generic protocol/SDK is also usable without either reference client. Download the asset-free public binaries from the tagged GitHub Release and verify `SHA256SUMS` first.

## macOS

The preview archive contains a compiled **Apple Silicon** `.app`, not the private runtime, account configuration, provider key or character model. It connects to a separately configured checkout. macOS 15+ supports text/companion playback; voice input uses macOS 26 APIs. The outer preview app is ad-hoc signed and not notarized. macOS may require its normal **Open Anyway** confirmation; review the source/checksum and use the system's documented per-app approval flow. Do not disable Gatekeeper globally.

Prepare your own checkout:

```bash
npm ci
node mac/install-runtime.mjs
node mac/install-control.mjs
```

In your own AnyLink service owner console, register a Mac and save the one-time credential JSON to `secrets/my-mac-credential.json` (mode 0600). Then connect it:

```bash
# Direct local service or an already protected HTTPS endpoint:
node mac/connect.mjs --server http://127.0.0.1:3180 \
  --credential-file secrets/my-mac-credential.json
# Alternatively, with an operator-configured SSH alias:
# --server http://127.0.0.1:3181 --ssh-host YOUR_SSH_ALIAS
node mac/configure-desktop.mjs
node mac/configure-control.mjs
# Optional cloud read-only search: defaults to this Agent workspace only.
node mac/peer/configure-link.mjs
node mac/start.mjs
```

Open the downloaded App and select this configured project directory. `mac/connect.mjs` refuses to overwrite an existing connection/profile. Current users retain their normal update workflow. To build instead, install Xcode Command Line Tools and run `node mac/build-app.mjs --public`; it writes to `artifacts/public/desktop/` and does not replace the installed application.

Computer control requires explicit enabling and macOS Accessibility / Screen Recording permission for the signed Peekaboo helper. Voice input requires microphone/Speech permission. These permissions are completed by the user, not by granting a cloud device credential.

Optional local character configuration, only after reading and accepting the author/Core terms:

```bash
node mac/companion/install.mjs --accept-third-party-licenses
node mac/configure-companion.mjs
```

The model is fetched from its pinned source into ignored local data, not included in the public App. Public attribution and further distribution remain governed by its own license. Optional online speech sends synthesis text to Microsoft and requires the explicit opt-in described in the existing voice documentation.

## Android

Install the public APK on Android 12+. It uses `com.anylink.agent.debug`, a preview/debug signature, and original placeholder artwork. The launcher is `ai.openclaw.app.anylink.AnyLinkActivity`; it never starts or connects to an OpenClaw Gateway.

Register a separate Android device in your server's owner console and save its one-time credential JSON. In the phone's **Server connection** panel, enter your server's HTTPS root URL and import that JSON. The app verifies protocol and device identity before storing the credential with Android Keystore encryption. No provider key is sent to the phone. No Mac pairing or device-specific rebuild is needed.

The phone owns conversation history, streamed model/tool rounds and SQLite operation receipts. Current phone tools are device information, private AnyLink notes, shared memory and cross-device tasks routed by capability. General control of other phone apps is not implemented by this cutover. With the Mac offline, phone chat and phone tools continue; only Mac-directed tasks remain queued.

For USB **development** testing, forward the server service rather than a Mac Gateway:

```bash
ssh -N -L 3180:127.0.0.1:3180 YOUR_SERVER_ALIAS
adb reverse tcp:3180 tcp:3180
# App server URL: http://127.0.0.1:3180, with the phone's own credential JSON.
```

A normal remote install uses an operator-provided HTTPS endpoint directly and does not depend on that development Mac. The existing production Compose remains loopback-only; setting up a reachable HTTPS endpoint is a deployment prerequisite, not something the APK can invent.

Speech uses Android recognition and TTS services, preferring on-device recognition when available. The system provider may process audio/text online. Explicit Stop and tapping Speak interrupt current playback/model work; hands-free full-duplex barge-in, voice quality and latency are not promised. Physical phone microphone, playback, GPU and lifecycle behavior remain unverified.

Mac file search uses `mac/peer/link-worker.mjs`: it advertises `files.search` through AnyLink, reads the existing Mac-owned root policy, and keeps its own durable SDK execution journal. Missing local policy opens no folders. `node mac/peer/configure-link.mjs` prepares a workspace-only policy or preserves an existing one; use `--workspace YOUR_DIRECTORY` only for a fresh policy. Any joined agent can then dispatch `files.search` to the Mac agent — target it by agent or device; no direct phone-to-Mac address is configured. `mac/start.mjs` supervises that worker alongside the local Gateway.

The public build does not currently have a character-import UI. To use a permitted model on Android, configure it privately in the checkout and build locally with `ANYLINK_CHARACTER_MODE=private node android-native/scripts/build.mjs`. That private build must not be uploaded or mirrored without the author's distribution permission. The default build is asset-free, and the public inspector rejects a private-character package. See [Android engineering instructions](../../android-native/README.md) for the pinned toolchain and source.

## Integrating another harness

Use the SDK and protocol directly. A host adapter advertises its own capabilities and owns local execution, approval prompts, cancellation and receipt persistence. The [Codex read-only example](../../sdk/examples/codex-read-only.mjs) uses `codex exec --sandbox read-only` in an operator-selected workspace and Codex's own credentials/model. It does not attach to an existing desktop conversation. Supporting that requires a separate session/[app-server](https://learn.chatgpt.com/docs/app-server) adapter; an MCP memory tool alone cannot receive and execute phone commands.

Here, read-only means the CLI filesystem sandbox. MCP servers, plugins, hooks and connector permissions remain governed by the operator's Codex configuration; review them before granting remote access, preferably in a dedicated configuration. The example does not forward interactive approval events to the phone. A production adapter should preserve those events and decisions instead of disabling approvals.
