# Call cues

`res/raw/anylink_call_start.wav` and `res/raw/anylink_call_end.wav` are original, deterministic synthesized cues generated with `make-sfx-core@2.0.0` (MIT). They contain no recorded speech or third-party ringtone samples. The synthesizer is a build tool and is not bundled into the app. The generated audio is distributed under this project's MIT license.

Reproduce from the repository root:

```sh
npm exec --yes --package make-sfx-core@2.0.0 -- make-sfx --preset confirm --duration 0.30 --pitch-shift 0.84 --punch 0.1 --out examples/android-native/overlay/app/src/main/res/raw/anylink_call_start.wav
npm exec --yes --package make-sfx-core@2.0.0 -- make-sfx --preset deny --duration 0.26 --pitch-shift 1.2 --punch 0.1 --out examples/android-native/overlay/app/src/main/res/raw/anylink_call_end.wav
```

Both cues are mono PCM16 WAV at 44,100 Hz, about 0.30 and 0.26 seconds respectively. Playback uses reduced volume and the current communication route. Capture starts after the entry cue; interruption by another audio app stops cues without replaying a hangup cue.

Tool: https://www.npmjs.com/package/make-sfx-core

Tool license: `make-sfx-MIT.txt`.
