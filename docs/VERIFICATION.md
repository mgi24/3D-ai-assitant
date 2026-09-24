# Verification record — 2026-09-07

- VRoid Studio 2.14.0 selected sample was exported to `mamadv1.vrm` (19,133,972 bytes) and copied to `public/avatar/character.vrm`.
- VRM 1.0 parsed: 54 humanoid bones, 14 preset expressions, 3 mesh definitions. Original exporter reported 180 total bones before export processing.
- Reference clone: pixiv/ChatVRM commit `b542aa00e19dccf9fc48ba340cf7eee011d2329a`. The reference app's dependencies were not installed or run.
- `npm run build`: success. Production dependency audit: 0 vulnerabilities reported at test time.
- `python -m pytest tests -q`: 7 passed. Two dependency deprecation warnings from Starlette/AnyIO; no failed tests.
- Real Indonesian TTS: generated a 5.04-second MP3; real local STT reproduced “Halo, saya siap menemani kamu berbincang hari ini.”
- Real browser mic fixture flow: listening → transcribing → thinking → preparing → speaking. STT 3,235 ms; AI 8,656 ms. AI answer: “Halo, namaku Mamad.” Mouth amplitude reached 0.368 and returned to zero on stop.
- Stop during speech: mic inactive, audio stopped, conversation continuation unchecked, state idle.
- Stop during delayed chat: late reply discarded; no new assistant message or playback.
- Automatic continuation: verified that natural playback completion starts the next microphone turn. This isolated test mocked text providers and used real TTS.
- 15 FPS option measured 15 rendered frames/sec over the test interval.
- Desktop/mobile screenshots inspected. No horizontal overflow at 390px width; no browser page exceptions.
- Actual Chrome application opened via `start.ps1`, selected avatar visible, state idle, mic not active. Server and browser use a dedicated project environment/profile.
- Latest actual app snapshot: server 71 MB RSS, browser process working sets total about 810 MB, free system RAM about 15.5 GB. GPU 2 used about 2,597 MiB with 9,519 MiB free (global GPU snapshot including other applications); GPU 1 unchanged at 10 MiB used.
- COLMAP PID 17440 remained running. CPU time continued increasing; priority remained Normal. No COLMAP command, process termination, resource affinity edit, or project/configuration change was made.

Not verified: the user's physical microphone/speaker, long conversations, use of different VRM assets, production availability of remote providers, offline TTS, and the optional larger STT model. Synthetic microphone tests do not prove physical device routing or room-noise quality.

Machine-readable results and images are in `test-results/`. API keys are intentionally excluded from all reports.

## Follow-up — 2026-09-22

- `start.bat` now opens the Electron windowless shell. The startup log records the preload phase and native capture `test-results/start-bat-native-final.png` shows the ready state without a title bar and with transparent surroundings; the old Chrome/start.ps1 observation above is historical.
- `short_audio.wav` (64.15 seconds) transcribed successfully with base/CPU and small/`cuda:0`. Apply returned `loaded: true`, `compute: float16`; `/api/stt` returned HTTP 200 with 13 segments.
- Settings persist `STT_MODEL` and `STT_DEVICE` to `.env`. The Apply button remains in a loading state until the selected model is loaded.
- On a fresh `start.bat`, the persisted model is preloaded before mic controls are enabled; health changed from `loading: true` to `loaded: true` for `small/cuda:0`.
- `npm run test:poses`: 11 wave frames captured at 0.5-second intervals and returned to idle. `pytest tests/test_server.py -q`: 14 passed.
- System Prompt UI capture `test-results/system-prompt-settings.png` shows the replacement textarea, default prompt with the Mamad identity, and the **Reset default** control. Backend tests cover prompt persistence and verify the configured text is sent as the LLM `system` message; `pytest tests/test_server.py -q`: 14 passed.
- Pose Browser captures `test-results/pose-window-native-fullscreen.png`, `test-results/pose-window-native.png`, and `test-results/pose-browser-wave-*.png` verified the separate Electron child window from the dock, 8 built-in pose cards, automatic looping after selecting `wave`, timeline progress, one-button Pause/Resume toggle, right-drag camera pan, and no browser exceptions. `test-results/pose-browser-editor.png` verifies Add pose, armature keyframe update, local custom save, and the custom card appearing in the library. The pose library is outside Settings.
- `node scripts/test-pose-browser.mjs` also selects `talk`, seeks to 0.20s, and verifies VRM mouth expression `aa` is above 0.6 from `expressionTracks`; capture `test-results/pose-browser-talk-mouth.png` records the preview.
- The same browser test verifies the legacy numeric per-bone editor is gone, the humanoid armature visibility, the Rotate tool, the combined playback/dope-sheet timeline, yellow keyframe markers, Reset bone, Delete keyframe from the preview, Undo/Redo, one-shot Apply all propagation from the active keyframe to following keyframes, Insert keyframe, and custom pose persistence. `test-results/pose-browser-editor.png` shows the Blender-style armature/timeline editor; `test-results/pose-browser-ready.png` shows the preview controls.
