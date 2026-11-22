# Reference client setup / 参考客户端安装

The clients demonstrate companion interaction and host execution. They currently use OpenClaw transport, while the generic protocol/SDK is a separate integration surface. Download the asset-free public binaries from the tagged GitHub Release and verify `SHA256SUMS` first.

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

Install the public APK on Android 12+ through your normal trusted-package workflow. It uses `com.anylink.agent.debug`, a preview/debug signature, and original placeholder artwork. No cloud/device/Gateway credential is embedded. The official OpenClaw connection flow pairs the phone with your own Mac Gateway.

For local USB testing after enabling USB debugging:

```bash
adb reverse tcp:18791 tcp:18791
```

Configure the forwarded endpoint in the app's connection screen and complete pairing and relevant permissions yourself. Keep the Mac online: it hosts this reference Agent. The phone's system speech-recognition service must support the language you want to use. Microphone, playback, interruption, GPU, background behavior and phone-node operations have not yet been verified on a physical phone for this preview.

Before pairing, prepare the reference Android agent on your Mac. Register a **separate Android logical device** in the owner console and save its credential JSON as `secrets/android-preview-connection.json`. Add a `server` field containing the same AnyLink base URL used by the Mac connection; this is logical context routing, not proof of hardware pairing. Then run:

```bash
node android-native/scripts/configure-preview.mjs
node android-native/scripts/configure-preview.mjs --apply
# Optional: explicitly enable Microsoft synthesis, which sends synthesis text there:
# node android-native/scripts/configure-preview.mjs --apply --consent-microsoft
```

The helper works without a private avatar, preserves existing user persona text, and validates with the pinned official OpenClaw CLI before replacing configuration. It retains a backup. Existing explicitly configured Microsoft speech is preserved; new installations do not silently opt in. For expression tools, run `node mac/configure-companion.mjs`; for the optional paired, read-only Mac file search, review the allowed roots and run `node mac/peer/configure.mjs` after preparing the Android credential. Those reference adapters retain their own local policies.

The public build does not currently have a character-import UI. To use a permitted model on Android, configure it privately in the checkout and build locally with `ANYLINK_CHARACTER_MODE=private node android-native/scripts/build.mjs`. That private build must not be uploaded or mirrored without the author's distribution permission. The default build is asset-free, and the public inspector rejects a private-character package. See [Android engineering instructions](../../android-native/README.md) for the pinned toolchain and source.

## Integrating another harness

Use the SDK and protocol directly. A host adapter advertises its own capabilities and owns local execution, approval prompts, cancellation and receipt persistence. The [Codex read-only example](../../sdk/examples/codex-read-only.mjs) uses `codex exec --sandbox read-only` in an operator-selected workspace and Codex's own credentials/model. It does not attach to an existing desktop conversation. Supporting that requires a separate session/[app-server](https://learn.chatgpt.com/docs/app-server) adapter; an MCP memory tool alone cannot receive and execute phone commands.

Here, read-only means the CLI filesystem sandbox. MCP servers, plugins, hooks and connector permissions remain governed by the operator's Codex configuration; review them before granting remote access, preferably in a dedicated configuration. The example does not forward interactive approval events to the phone. A production adapter should preserve those events and decisions instead of disabling approvals.
