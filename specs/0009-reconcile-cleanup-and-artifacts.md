# Spec 0009: Reconcile Early-Ported Session Cleanup & Artifacts Modules (Candidate 4)

- **Status**: Ready for Implementation
- **Preceded By**: [specs/0008-dialogue-runtime-coordinator.md](./0008-dialogue-runtime-coordinator.md)

## Problem Statement
`Feng-H/picord` previously cherry-picked upstream `session-cleanup` (`#163`) and `artifacts` deletion (`#313`) onto its pre-`0.30.0` tree. Upstream subsequently landed six critical data-safety and concurrency fixes (`cf4f84ce`, `6e1ba440`, `5ba92ca3`, `a602728b`, `907fe632`, `87470932`) before releasing `0.30.1`. Leaving Picord on the older snapshot risks deleting git-ignored `.env` files during worktree cleanup, deleting uploads needed by concurrent forks, leaving orphan kept-upload folders after the final fork is deleted, and blocking HTTP artifact DELETE responses while sweeping every conversation's asset index — while also creating unnecessary line-level merge friction in `session-cleanup.ts` and `artifacts.ts`.

## Solution
Reconcile `src/server/session-cleanup.ts`, `src/server/artifacts.ts`, `src/server/extensions/session-cleanup/index.js`, `src/server/commands.ts` (`#fork`), `test/session-cleanup.test.ts`, and `test/artifact-delete.test.ts` with those six upstream fixes cleanly on `main`:
1. **`5ba92ca3` (`N1`)**: Export `sweeping` promise from `src/server/artifacts.ts` and execute `sweepAssets(app)` asynchronously after `deleteArtifact()` resolves.
2. **`6e1ba440` + `a602728b` (`N5-OWNER` + `R2-1`)**: Detect git-ignored env files (`isEnvFile` via `hasIgnoredEnv`, skipping `node_modules` and failing closed as `"env"` past `MAX_COUNTED`) before `git worktree remove`, and surface the `"env"` reason in the session-cleanup extension UI.
3. **`cf4f84ce` (`R1-D1`)**: Purge previously retained parent uploads from `RemovedSession.keepUploads` once the last fork referencing them is removed.
4. **`907fe632` (`R3-G1`)**: Re-evaluate kept uploads inside the removal commit transaction (`DeletedDoc`) so forks created mid-plan retain their uploads.
5. **`87470932` (`R5-G1`)**: Reject `Commands.#fork` inside its commit if the source session already appears in `DeletedDoc` (`409 Conflict`).

## Verification Plan
- `node --test test/session-cleanup.test.ts test/artifact-delete.test.ts` plus Picord core tests (`dialogue-runtime`, `turn-pipeline-*`, `channels`, `rule-engine*`, `voice`).
- `npm run check`, `npm run lint`, and `npm run check:sandbox` (InstaBox).
- Two-axis code review + production deployment verification.
