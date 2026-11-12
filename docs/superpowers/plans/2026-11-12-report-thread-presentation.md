# Report Thread Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repetitive report messages with an opening card and one confirmation/receipt message, including safe failure and close states.

**Architecture:** Keep report state, authorization and submission in their existing services. Add one focused Discord presentation service shared by current senders, plus a pure card builder. Persist message references in existing intake metadata and reuse the current claim/recovery mechanism rather than introducing a second job system.

**Tech Stack:** TypeScript, discord.js, existing application schemas, Prisma metadata, Jest.

**Spec:** [Approved report thread design](../specs/2026-11-12-report-thread-presentation.md).

## Review brief

The reporter sees progress without a stream of acknowledgments. A new confirmation appears below their evidence, and submission edits it into a receipt. Wrong or missing identities go to moderators without another reporter task.

The implementation needs four connected changes: shared presentation, durable delivery, caller integration, and recovery verification. The main tradeoff is that later evidence can appear below the confirmation because Discord edits do not move messages. We accept this rather than reposting and pinging repeatedly.

No further product decision blocks this plan. First-confirmation-only mention is the proposed notification default to verify locally. Implementation, publication and deployment are not performed by writing this plan.

## Global constraints

- Exactly the states/copy and ownership rules in the spec; two bot messages in the normal flow.
- No model, matching, moderation-policy, retention, or staff-review redesign.
- No new dependency, database table, generic event bus or notification framework.
- No evidence mutation, raw receipt GUIDs, or technical match fields in reporter cards.
- Preserve actor/guild/thread/revision/prompt checks and submission idempotency.
- Persist message location independently of tokens that new evidence invalidates.
- No success receipt without durable outcome proof; no retry on an unknown dispatch outcome.
- Keep shipped IDs/receipt recovery compatible. Do not add speculative compatibility branches.
- Use synthetic fixtures and generic environment labels in committed documentation and PRs.
- Develop in an isolated worktree. Do not change the protected main mirror.

## Review focus

These are required tests in the owning tasks, not additional features:

1. A late presentation worker must not replace submitted/closed state with an older suggestion (Tasks 2 and 4).
2. Discord accepts a send but saving its ID fails: recovery must not duplicate it or ping again (Tasks 2 and 4).
3. Permission failure is not deletion and must not trigger replacement sends (Task 2).
4. A timeout after dispatch must not expose Try again or create a second detection (Tasks 3 and 4).
5. Old reports without presentation metadata must retain functioning authorized controls and recover shipped receipts (Tasks 2 and 4).

## Source map and scope

| Files                                                                                      | Responsibility                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| New `src/utils/reportIntakePresentation.ts`                                                | Pure card copy, state-to-controls model, candidate formatting                      |
| New `src/services/ReportIntakePresentationService.ts`                                      | Only reporter-card send/edit/recovery owner; no submission or moderation decisions |
| `src/services/ThreadManager.ts`                                                            | Opening card creation and reference capture; existing thread lifecycle             |
| `src/services/ReportIntakeService.ts`                                                      | Evidence updates, saved confirmation, rejection, close and submission state        |
| `src/services/ReportIntakeHandoffService.ts`                                               | Existing presentation claims and staff handoff delivery                            |
| `src/controllers/ReportInteractionHandler.ts`                                              | Interaction acknowledgment, reporter actions and transient close confirmation      |
| `src/utils/reportPresentationDiscord.ts`                                                   | Bounded authored-message recovery, including shipped receipts                      |
| `src/repositories/reportIntakeProcessing.ts`, `src/repositories/ReportIntakeRepository.ts` | Durable presentation scheduling, optimistic updates and claim eligibility          |
| `packages/application/src/reports/analysis.ts`, `intakeState.ts`                           | Optional validated presentation metadata and durable state projection              |
| `src/di/symbols.ts`, `src/di/container.ts`                                                 | Presentation service wiring without a dependency cycle                             |
| Existing report unit/integration suites and repository fakes                               | Verify changed contracts and recovery                                              |

Inspect callers of every changed signature before editing. `ReportSubmissionService.submitConfirmedReportIntake` and application report actions remain the submission boundary; adjust their callers, not their side-effect policy. No public package export is needed for a Discord-only builder. Update application exports only if a new shared schema is introduced there.

### Task 1: Define and render the approved states

**Files:** Create `src/utils/reportIntakePresentation.ts` and `src/__tests__/unit/reportIntakePresentation.unit.test.ts`; inspect application `reports/intakeState.ts` and existing candidate types.

**Interfaces:** Produce `ReportIntakePresentationState` as a discriminated union for the spec states; `buildReportIntakePresentation(state: ReportIntakePresentationState): MessageCreateOptions`. Reuse existing candidate identity types. The result contains embeds and existing report action IDs; it performs no I/O. Create/edit callers select the compatible Discord payload fields explicitly.

- [ ] Write table-driven tests asserting exact titles, bodies and action labels from the spec, including empty action sets for submitting/updating/unknown/closed states. Assert that no receipt GUID, raw user ID or AI label is rendered.
- [ ] Run `npx jest --runInBand --runTestsByPath src/__tests__/unit/reportIntakePresentation.unit.test.ts`; confirm failure because the builder is absent.
- [ ] Implement the union and builder. Include avatar and distinct nickname only when available; omit unsupported source explanations; escape names and incidental mentions. Pass action bindings from validated caller state, never infer authorization from rendered text.
- [ ] Add tests for long/Markdown-bearing names, missing avatar, same/different nickname and text-only evidence. Preserve existing Discord content/component limits and legacy multiple-candidate behavior.
- [ ] Run the focused test and build; commit the renderer and tests.

### Task 2: Give reporter messages durable ownership

**Files:** Create presentation service and `src/__tests__/unit/ReportIntakePresentationService.unit.test.ts`; modify source-map repository/metadata/recovery/DI files and their fakes; extend `ReportIntakeHandoffService.unit.test.ts`.

**Interfaces:** Produce `IReportIntakePresentationService.reconcile(intakeId: string): Promise<void>`. It re-reads and projects persisted state rather than accepting a stale caller-provided status. Add optional validated `reporter_presentation` metadata with `openingMessageId`, `followupMessageId` and an optional pending send record containing slot, evidence revision and reservation timestamp. Keep any delivery lease/attempt count in the existing presentation claim machinery, not a separate scheduler. Durable IDs survive prompt invalidation.

- [ ] Write failing tests for initial-card edits, first follow-up send, subsequent follow-up edits, terminal-state precedence, and preservation of unrelated metadata.
- [ ] Run the new unit suite and confirm the missing behavior fails.
- [ ] Implement the service using repository optimistic updates and existing presentation leases. Extend claim eligibility only as needed for progress/terminal reconciliation, with an existing retry schedule. Avoid nested claims: the handoff worker delegates a claimed delivery to this owner, not a second competing claim. Keep dependencies directed toward repository/Discord/builder; do not inject intake or handoff services into the presenter.
- [ ] Capture the message returned by opening-card send in `ThreadManager.activateReportIntakeThread`; preserve its existing boolean caller contract if possible. Route new opening sends through the same reservation/recovery rules. Clear obsolete opening controls when the follow-up takes over.
- [ ] Extend `findAuthoredReportMessage` through an explicit matcher while retaining shipped footer matching. First fetch stored IDs; recover reserved sends by exact author/thread plus intake-bound components or a unique reserved receipt match. If a history scan is incomplete or ambiguous, stop and surface delivery failure rather than resend. A definite Unknown Message permits replacement; Forbidden/timeouts do not.
- [ ] Add tests for accepted send plus metadata-save failure, concurrent workers, deleted message, denied history, bounded-history exhaustion, restart, missing metadata and shipped footer/custom-ID adoption. Assert only the first confirmation can mention the reporter; all edits/replacements have empty allowed mentions.
- [ ] Run the presentation, handoff and processing tests plus build. Commit the delivery owner and recovery changes.

### Task 3: Connect the existing flow and remove duplicate messages

**Files:** Modify `ReportIntakeService.ts`, `ReportIntakeHandoffService.ts`, `ReportInteractionHandler.ts`, `ThreadManager.ts`; update their existing unit tests, `ReportActions.unit.test.ts` and `ReportSubmissionService.unit.test.ts` where assertions change.

**Interfaces:** Call Task 2 `reconcile(intakeId)` after durable state changes. Keep existing report action/submission interfaces and tokens. Reuse existing reporter close custom IDs, adding a confirmation/cancel binding only where required. Do not create a second submit path for Try again.

- [ ] Write failing flow tests asserting opening + follow-up only, with no Evidence saved, visible receipt footer, duplicate ephemeral success or extra Report submitted for reply.
- [ ] Run the focused report service/handler suites and verify those assertions fail on the old send paths.
- [ ] Replace `acknowledgeStagedEvidence` output with reconciliation. Route `sendCandidateConfirmationPrompt` and `publishSavedConfirmation` through the shared presentation owner, preserving disabled-until-saved behavior. Revision-bound custom IDs must change when evidence changes, even when reusing the same message ID. Persist the new authorization before enabling buttons.
- [ ] Replace handoff receipt sends with shared reconciliation. Deliver the staff notification before rendering Sent to moderators; keep reporter receipt and staff delivery recovery independently tracked. A late handoff must not regress accepted submission.
- [ ] Update reporter interaction handlers to acknowledge promptly and edit the shared card. Use defer-update on the current card when valid; retain short private errors for unauthorized/stale actions or unavailable shared UI. Audit every Report submitted sender and change only intake-owned replies, preserving standalone report command behavior.
- [ ] Map durable submission states to submitting, accepted, definitely not dispatched and uncertain. Do not map the broad `status: failed` result to a safe retry without proof. Retry uses the original intake through its existing action boundary and guards; unknown dispatch remains on existing staff recovery/attention. Verify accepted side effects with a failed final-status write never submit again.
- [ ] Add transient close confirmation and Keep open behavior. On cancel, re-read current state. Use Close thread after handoff/submission, retaining staff review; do not archive on the first click. Render closed only after successful archive/lock behavior, preserving existing close semantics and authorization. On failure retain open state and private error. Block close during unresolved dispatch as existing rules require.
- [ ] Test newer evidence racing a click, stale custom IDs on the same message, concurrent confirmation, rejected candidate, staff-owned additional evidence, close cancellation after a state change, archive failure, unauthorized actor and cross-thread buttons.
- [ ] Run affected unit suites and build. Commit flow integration and remove the superseded send/copy code.

### Task 4: Verify recovery and the actual Discord experience

**Files:** Extend `src/__tests__/integration/ReportIntakeStagedFlow.integration.test.ts`, `ReportIntakeProcessing.integration.test.ts`, `ReportIntakeSubmissionRecovery.integration.test.ts`; update `docs/test-cases.md` and relevant workflow documentation. Update unit fake implementations for any changed repository contracts.

- [ ] Add integration tests for overlapping revisions/presentation claims, accepted-send recovery, successful submit followed by persistence failure, no duplicate detection on retry, terminal precedence and old metadata. Prove the failures before the corresponding fixes where not already covered in earlier tasks.
- [ ] Run focused integration suites through the repository integration runner against an isolated local test database. Read the testing-integration skill first; do not use production data or a shared database being tested by another worktree.
- [ ] Run `npm run check:ci` with its documented local prerequisites. Record blocked checks accurately; do not call a unit-only run full CI.
- [ ] Start the local dev bot using the existing local testing workflow and synthetic evidence. Verify actual embed layout, one new confirmation, targeted mention behavior, changed controls, nickname display and no extra acknowledgments. Avoid creating another bot/runtime workflow.
- [ ] Test failure/unknown/stale/close transitions through fakes or local fault injection. The prior live-test boundary still stops before submission or moderation; do not use real submissions to verify receipts without new explicit authorization. Mark live final-receipt proof untested if that authorization is absent.
- [ ] Test restart and a deliberately deleted bot-owned preview card in the controlled local fixture. Confirm recovery does not duplicate or ping. Never delete reporter evidence.
- [ ] Commit tests/docs, publish an issue-linked PR under the repo workflow, and iterate through exact-head checks, comments, inline threads, reviews and mutable review summaries. Stop merge-ready; do not merge or deploy under this planning request.

## Preparation and reuse

At execution start, fetch current main and create one isolated issue worktree using the worktree skill. Recheck the source map against current main. The inspected source checkout is clean but is a prior feature branch, not proof of current main.

Inspect the earlier reporter-copy worktree before porting changes. Its local commit already removes some acknowledgment noise and keeps shipped recovery markers recognizable. Reuse the useful pieces rather than blindly cherry-picking the entire commit into a changed message architecture. Do not overwrite or publish that branch as part of this plan.

## Evidence appendix

Inspected on 2026-11-12: report provider schema worktree; relevant service/controller/repository source and tests; existing reporter-copy commit `f04f3fc7d850ba6f0c7829cffc5ec97ead55718d` verified by Git log. Source observations include separate evidence acknowledgment, confirmation, handoff receipt and submission reply senders; prompt IDs invalidated on evidence changes; and existing persisted submission recovery states.

Prototype tests exercised normal stages, retry, uncertain outcome, handoff, close/cancel, stale-control removal and mobile width. Those tests prove the mockup only. No implementation, production reads, bot configuration changes or deployments occurred while writing this plan.
