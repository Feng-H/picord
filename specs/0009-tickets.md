# Spec 0009 Tickets — Reconcile Session Cleanup & Artifacts (Candidate 4)

Spec: [0009-reconcile-cleanup-and-artifacts.md](./0009-reconcile-cleanup-and-artifacts.md)

## Ticket 1
**Port upstream safety and concurrency fixes (`N1`, `N5-OWNER`, `R2-1`, `R1-D1`, `R3-G1`, `R5-G1`) to `artifacts`, `session-cleanup`, and `Commands.#fork`**
- Blocked by: None
- Scope:
  - Reconcile `src/server/artifacts.ts` + `test/artifact-delete.test.ts` (`5ba92ca3`).
  - Reconcile `src/server/session-cleanup.ts` + `src/server/extensions/session-cleanup/index.js` + `src/server/commands.ts` (`#fork`) + `test/session-cleanup.test.ts` (`cf4f84ce`, `6e1ba440`, `a602728b`, `907fe632`, `87470932`).

## Ticket 2
**Verify regression suites, run two-axis code review, deploy, and close Candidate 4**
- Blocked by: Ticket 1
- Scope:
  - Run `npm run check`, `npm run lint`, `node --test test/session-cleanup.test.ts test/artifact-delete.test.ts` + Picord suites + `npm run check:sandbox`.
  - Parallel two-axis code review, push `main`, watch CI green, restart `pi-pocket.service`, close GitHub issues, and update `PI-POCKET.md`.
