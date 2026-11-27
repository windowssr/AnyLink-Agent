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

The phone owns conversation history, streamed model/tool rounds and SQLite operation receipts. Current phone tools are device information, private AnyLink notes, shared memory and cross-device tasks routed by capability. With the Mac offline, phone chat and phone tools continue; only Mac-directed tasks remain queued.

Android 0.5 adds a floating companion and local phone control. When connected and granted overlay permission, the app shows a small non-focusable Live2D overlay after the activity backgrounds (tap to talk, long-press to reopen, drag to move, drag to a bottom × target to hide); a `specialUse|microphone` foreground service keeps the agent worker and overlay voice alive. After the owner enables the app's AccessibilityService, conversation tools `phone_screen`, `phone_open_app`, `phone_list_apps`, `phone_tap`, `phone_type`, `phone_scroll`, `phone_back` and `phone_home` read and operate other apps directly without per-action confirmation — screen content is treated as data, not instructions. These tools are local-only and are not advertised as cross-device capabilities.

For USB **development** testing, forward the server service rather than a Mac Gateway:

```bash
ssh -N -L 3180:127.0.0.1:3180 YOUR_SERVER_ALIAS
adb reverse tcp:3180 tcp:3180
# App server URL: http://127.0.0.1:3180, with the phone's own credential JSON.
```

A normal remote install uses an operator-provided HTTPS endpoint directly and does not depend on that development Mac. The existing production Compose remains loopback-only; setting up a reachable HTTPS endpoint is a deployment prerequisite, not something the APK can invent.

Android v0.10.0-preview.8 adds local Chinese/English recognition with a separately downloaded model (about 199 MiB), pinned file hashes and atomic installation. Install the model in Keep-Alive → Local offline recognition; local transcription needs no cloud ASR key, while chat/replies still use the server. Automatic mode prefers the installed local model. Android system recognition remains selectable and its provider may process audio online. Playback prefers the cloud `POST /model/v1/speech` endpoint: the server strips code, tables, Markdown, links and emoji, optionally rewrites the reply into a one-or-two-sentence spoken summary via the configured model provider, and returns a Microsoft neural voice MP3 by default, or an Aliyun Qwen `Momo` WAV when the server has a Bailian key configured (default rate 1.12; Microsoft remains the first synthesis fallback) that the app plays with `MediaPlayer` while driving the companion's speaking state. Android preview.11 requests an NDJSON stream (`start`/`audio`/`done`), plays 24kHz PCM16 mono as it arrives through AudioTrack, and retains WAV/MP3 compatibility. Chat speech uses the original generated sentences; companion captions reveal them on the playback clock and Reading mode shows the full response. At most one utterance is prefetched, ordinary notifications wait until hang-up, and a fallback provider stays selected until the next reply. Partial streams are never replayed using a different voice. Metadata diagnostics omit speech text and secrets. Speech text is sent to Aliyun or, during fallback, Microsoft; the synthesis API does not upload local ASR recordings. Keys remain server-side. A new owner reply interrupts current playback and clears prefetched audio; `companion.say` messages queue. On synthesis failure or a 502 the app falls back to system `TextToSpeech` with the server's `spoken_text`, or locally sanitized text when the request fails entirely. Explicit Stop and tapping Speak interrupt playback/model work; hands-free full-duplex barge-in and latency are not promised. Basic transcription, audible call replies and private-build Live2D rendering were checked on HONOR BRP-AN80 / Android 15. Homophone accuracy, long background calls, headset routes and full-duplex interruption have not been comprehensively validated.

Mac file search uses `mac/peer/link-worker.mjs`: it advertises `files.search` through AnyLink, reads the existing Mac-owned root policy, and keeps its own durable SDK execution journal. Missing local policy opens no folders. `node mac/peer/configure-link.mjs` prepares a workspace-only policy or preserves an existing one; use `--workspace YOUR_DIRECTORY` only for a fresh policy. Any joined agent can then dispatch `files.search` to the Mac agent — target it by agent or device; no direct phone-to-Mac address is configured. `mac/start.mjs` supervises that worker alongside the local Gateway.

For file changes, the same worker also serves `agent.ask` on the `mac-openclaw` agent: it forwards the instruction to the Mac's own OpenClaw `remote` agent (`openclaw/remote` on the loopback gateway), which uses the confined `anylink_files_*` tools inside the policy roots. Deletes go to Trash, never permanent unlink; `agent.ask` executes without confirmation, so anyone holding the join key can trigger file operations within those roots — keep the join key private and the Mac awake with the launch agent running. `node mac/configure-remote.mjs` installs the remote agent entry and persona (`mac/persona-remote.md`). Handler failures that are definite (bad input, gateway 4xx/refused) report `failed`; ambiguous outcomes after the request may have been sent report `unknown` and are never auto-retried.

The public build does not currently have a character-import UI. To use a permitted model on Android, configure it privately in the checkout and build locally with `ANYLINK_CHARACTER_MODE=private node examples/android-native/scripts/build.mjs`. That private build must not be uploaded or mirrored without the author's distribution permission. The default build is asset-free, and the public inspector rejects a private-character package. See [Android engineering instructions](../../examples/android-native/README.md) for the pinned toolchain and source.

## Integrating another harness

Use the SDK and protocol directly. A host adapter advertises its own capabilities and owns local execution, approval prompts, cancellation and receipt persistence. The [Codex read-only example](../../sdk/examples/codex-read-only.mjs) uses `codex exec --sandbox read-only` in an operator-selected workspace and Codex's own credentials/model. It does not attach to an existing desktop conversation. Supporting that requires a separate session/[app-server](https://learn.chatgpt.com/docs/app-server) adapter; an MCP memory tool alone cannot receive and execute phone commands.

Here, read-only means the CLI filesystem sandbox. MCP servers, plugins, hooks and connector permissions remain governed by the operator's Codex configuration; review them before granting remote access, preferably in a dedicated configuration. The example does not forward interactive approval events to the phone. A production adapter should preserve those events and decisions instead of disabling approvals.
