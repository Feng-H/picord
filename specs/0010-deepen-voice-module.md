# Spec 0010: Deepen `web/voice.js` & Slim `web/composer.js` (Candidate 2)

- **Status**: Ready for Implementation
- **Preceded By**: [specs/0009-reconcile-cleanup-and-artifacts.md](./0009-reconcile-cleanup-and-artifacts.md)

## Problem Statement
`web/composer.js` (3,560 lines, top upstream conflict hotspot) currently embeds duplicate copies of `VoiceLangButton` and `VoiceOverlay` alongside ~180 lines of push-to-talk pointer gesture state (`pressStartRef`, 50px slide-up / 40px hysteresis, 500ms tap guard, vibration, timer interval, wake lock coordination), inline `pocket.voiceMode` localStorage persistence, inline upload retry logic (`3` tries, `.m4a` vs `.webm`), and 65 lines of `voice-press-bar` / `voice-mode-toggle` JSX. Meanwhile `web/voice.js` already houses `VoiceLangButton`, `VoiceOverlay`, and `useVoiceMessage`, leaving voice UI and state split awkwardly across both files and duplicating components.

## Solution
Deepen `web/voice.js` into the single self-contained client voice module and reduce `web/composer.js` to thin integration:
1. **Single UI Source of Truth**: Delete duplicate `VOICE_LANGS`, `VoiceLangButton`, and `VoiceOverlay` from `web/composer.js`; import the single canonical `VoiceLangButton` and `VoiceOverlay` from `web/voice.js`.
2. **Encapsulated Push-to-Talk & Mode Hooks (`web/voice.js`)**:
   - `uploadVoiceBlob(blob, upload, options?)`: converts `audio/mp4` vs `audio/webm` into a `File` and retries transient upload failures (3 attempts, configurable delay) with unified error toast reporting.
   - `useVoiceMode(storageKey?)`: manages `voiceMode` state and `pocket.voiceMode` `localStorage` persistence cleanly.
   - `useHoldToTalk(voice, options?)`: encapsulates `pressStartRef`, pointer capture, `50px`/`40px` slide-up cancel hysteresis, `500ms` short-press guard + toast, vibration, recording elapsed-second timer, and unmount timer cleanup.
   - `HoldToTalkBar` and `VoiceModeToggle`: reusable Preact components in `web/voice.js` preserving every existing CSS class (`voice-press-wrapper`, `voice-press-bar`, `voice-mode-toggle`) and `data-part` attribute for `web/style.css` & UI themes.
3. **Cache Invalidation**: Bump `SHELL_CACHE` to `picord-shell-v8` in `web/sw.js`.

## Testing Decisions
- **Agreed Seam**: `web/voice.js` exported controllers/components tested in Node (`test/voice.test.ts`):
  - `uploadVoiceBlob` retries transient upload failures up to 3 attempts, picks `.m4a` for `audio/mp4`, and emits an error notice + returns `undefined` after exhausting retries.
  - `useHoldToTalk` cancels short taps (`< 500ms`) with an info toast, cancels when dragged upward (`deltaY > 50px`) and recovers at `<= 40px`, triggers `voice.stop(true)` on valid holds (`>= 500ms`), and cleans up its interval on unmount.
  - `HoldToTalkBar`, `VoiceModeToggle`, `VoiceLangButton`, and `VoiceOverlay` render cleanly with zero DOM errors.
- Verify `npm run check`, `npm run lint`, `node --test test/voice.test.ts` + core suites, and `npm run check:sandbox` (InstaBox).
