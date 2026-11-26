# Spec 0010 Tickets — Deepen `web/voice.js` & Slim `web/composer.js` (Candidate 2)

Spec: [0010-deepen-voice-module.md](./0010-deepen-voice-module.md)

## Ticket 1
**Deepen `web/voice.js` with `uploadVoiceBlob`, `useVoiceMode`, `useHoldToTalk`, `HoldToTalkBar`, and `VoiceModeToggle` (TDD)**
- Blocked by: None
- Scope:
  - Write failing unit tests in `test/voice.test.ts` for `uploadVoiceBlob` retry/mime handling, `useHoldToTalk` gesture/cancel/short-press state machine & unmount cleanup, and `HoldToTalkBar`/`VoiceModeToggle` rendering.
  - Implement all exported helpers/hooks/components in `web/voice.js`.

## Ticket 2
**Remove duplicate voice UI & push-to-talk boilerplate from `web/composer.js` and bump SW cache**
- Blocked by: Ticket 1
- Scope:
  - Wire `web/composer.js` to `web/voice.js` exports, removing duplicate `VOICE_LANGS`, `VoiceLangButton`, `VoiceOverlay`, inline upload retry loop, inline pointer-gesture handlers, and inline hold-to-talk/toggle markup.
  - Bump `SHELL_CACHE` to `picord-shell-v8` in `web/sw.js`.

## Ticket 3
**Verify suites, run two-axis code review, deploy, and close Candidate 2**
- Blocked by: Ticket 2
- Scope:
  - Run `npm run check`, `npm run lint`, `node --test test/voice.test.ts` + server suites, and `npm run check:sandbox`.
  - Parallel two-axis code review, push `main`, watch CI green, restart `pi-pocket.service`, close issues, and update `PI-POCKET.md`.
