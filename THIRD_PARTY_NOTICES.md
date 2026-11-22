# Third-party notices and assets

AnyLink's original code and documentation are MIT licensed under [LICENSE](LICENSE). This does not relicense third-party code, characters, model files or hosted services.

- **OpenClaw**: MIT, OpenClaw Foundation. The pinned Android reference and Mac runtime retain upstream notices. See [the exact Android license](android-native/licenses/OpenClaw-MIT.txt).
- **Caddy**: optional HTTPS component, Apache-2.0; the installer retains the official archive LICENSE. Version and checksum are fixed in [the runtime lock](deploy/https/runtime-lock.json).
- **Peekaboo**: its original MIT license is retained at [mac/control/PEEKABOO-LICENSE](mac/control/PEEKABOO-LICENSE); the Mac reference bundles the unmodified, signed upstream helper.
- **PixiJS / pixi-live2d-display / AIRI compatibility changes**: original MIT notices are retained in [mac/companion/vendor](mac/companion/vendor).
- **DeepSeek-chan / 大肥鱼**: original art and separation by 神宫凉子; Live2D by 霓虹猫_NeonNeko. The [model usage notice](https://github.com/YJackie-Li/DeepSeek-chan/blob/main/README.md) permits attributed creative displays but prohibits unauthorized re-upload of the full model. Any illustrated local configuration is an optional third-party example, not AnyLink artwork or a bundled character. Public packages exclude its model, textures and derived avatar. Obtain resources through the author's source and follow its terms.
- **Live2D Cubism Core**: proprietary, separately licensed; absent from public packages. See the [Live2D agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) and [SDK distribution terms](https://www.live2d.com/en/sdk/license/).
- **Speech services and optional speech models**: Microsoft online synthesis is an optional external service and receives synthesis text when enabled. Other optional engines/model weights keep their own terms and are downloaded separately.
- npm, Android and renderer dependencies retain their package notices. The Android reference retains upstream notices and exposes them in the Server connection → Licenses panel. Build-only dependencies are not represented as AnyLink's own work.

Public packages use original code-drawn placeholder artwork. A private local build may be configured with assets the operator is permitted to use; that does not grant permission to publish that build.
