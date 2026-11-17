# Task 5 report

Implemented the shared selected-repair contract across application commands, request codecs, delegation, native web submission, Discord entry points, worker dispatch, MCP admission/status, DI and public result projections. No wizard UI, dependency, queue framework, live Discord operation, deployment or external post was added.

## Binding contract for Task 6

- Shipped identifiers remain `audit_case_role_lockdown` and `apply_case_role_lockdown`. Public executable apply input is exactly `{ kind, auditRequestId, auditRevision, selectedFixIds }`. Schemas reject old `unsyncAllowedChannels`, client effects, plan envelopes, actors and worker tokens. Legacy persisted coarse commands terminate with `plan_required` and a fresh-audit/review recovery path, with zero effects.
- `prepareRestrictionPlan` remains the admission boundary. MCP setup resolution receives a narrow optional `SetupResolutionResources.restriction` dependency, freezes `{ kind: 'restriction_plan', plan }`, shows exact selected effects and bounds approval to the original audit expiry. `encodeIntentDelivery` creates trusted `restriction_schema_version: 1` and `restriction_plan` metadata. Accepted-plan equality, command digest, actor/guild, current authority, grant and consent checks remain mandatory.
- Native web `queueModerationQueueOperation` prepares selected references using `createWebRestrictionPlanDependencies()` and constructs trusted metadata itself. It does not accept client plan/effect metadata. The existing form action requires the selected audit references and explicit review confirmation; a checkbox-only request fails with `plan_required`. Task 6 should present the exact effects before that confirmation.
- `createWebRestrictionPlanDependencies` and `readWebRestrictionFacts` are in `apps/web/lib/mcp/adapters/restriction.ts`. They reuse existing REST readers and PostgreSQL setup/case data. Admission refreshes roles, hierarchy, the full channel/category/source structure, selected case revision/member join identity, selected thread metadata and complete selected thread membership. It never runs the full worker collector in web. Missing selected evidence fails closed. Thread-member pagination is bounded at 100 pages of 100, then rejects incomplete evidence. Discord hierarchy ties are normalized consistently with the bot collector.
- Bot `operationsRuntime.forRequest(request, reconcileOnly?)` constructs trusted stores/token/effect dependencies. Direct apply without this server-owned request context fails `plan_required`. `operationsRuntime.enqueueAudit(context)` returns the durable request ID. Discord audit queues this read-only work and returns a concise message; slash apply returns `plan_required` with a guild-scoped review link. The expected Task 6 route is `/admin/guild/[guildId]/operations/restrictions`, based on existing admin routes. URL base uses existing `NEXT_PUBLIC_APP_URL` / `DRASIL_WEB_PUBLIC_URL` settings.
- Stored audit result is `{ audit_request_id, restriction_audit: RestrictionAudit }`. Stored apply result is `{ restriction_progress, restriction_apply: RestrictionApplyResult }`. Task 3 completion preserves authoritative progress. Full fact snapshots stay server-owned.
- `projectRestrictionAudit(auditRequestId, audit, diagnosticOffset = 0)` returns `PublicRestrictionAudit`. Every page contains the complete fix manifest, global coverage, setup summary and compact case summaries. `diagnostics` contains at most 50 findings, with nullable `caseId`/`caseRevision`; `diagnosticOffset`, `diagnosticTotal`, and `nextDiagnosticOffset` support paging. Setup and case summaries omit unbounded finding arrays; case summaries omit repeated coverage. It never exposes `facts`.
- Existing `get_action_status` accepts optional nonnegative integer `diagnosticOffset`, and `DelegatedActionService.status(principal, executionId, diagnosticOffset?)` reloads the completed audit through a guild-bound store only after current own-execution/read authorization and read-budget admission. Original calls still return page zero. Later pages retain all fixes. Public typed results are `outcome.restrictionAudit` and `outcome.restrictionApply`. Native request summaries expose the same types, with the first audit page; Task 6 can reuse the projector for authorized later-page server reads.
- Interrupted versioned apply settlement rotates its private token and now recognizes the same started execution even when it returns through ordinary `claimNext` without the generic recovery flag. Admission binds the accepted plan, current token and live lease, then selects `restriction_reconciliation`. Executor read-only reconciliation never replays or continues the batch, including when no receipt exists. Fresh audit/selection is required for further work.
- Revoked and tampered pre-send admission atomically terminalize only the currently owned, unstarted queue row before closing its MCP execution. A shared narrow helper proves exact queue/execution ID, actor, guild, delegated digest/connection/grant, current token/live lease and absence of substantive receipts. It preserves existing result/progress namespaces and refuses any substantive receipt. Started/unknown evidence cannot be relabeled as an unstarted denial; insufficient no-send proof returns read-only `uncertain_prior_effect` without erasing the evidence. No effect, receipt or snapshot fence was relaxed. Existing connection/execution/request locking order is retained.
- Deleted `applyGuild`, `buildReport`, legacy fixture-only audit branches, duplicate permission evaluation and IntegrityAuditService's parked-case fallback. CaseRoleLockdownService retains only thin shared-assessment projections used by existing containment consumers. Account containment and its public preview consume structured assessment status instead of raw warning totals. No automatic moderation setup/readiness gate was added.

## Red and green evidence

Initial behavioral red:

`npm run application:test -- --runInBand --runTestsByPath src/operations/actions.test.ts src/requests/operations.test.ts src/setup/resolution.test.ts src/delegation/confirmationPolicy.test.ts src/delegation/execution.test.ts`

One failed, 77 passed. The new legacy coarse-apply regression expected `{ kind: 'denied', code: 'plan_required' }`, but received a repair outcome. After migration, the required five suites passed 79 tests. Final focused run including `src/operations/restrictionExecution.test.ts` passed six suites and 89 tests.

The first database run exposed explicit UUID/text fixture binding and omitted MCP enable/config mock dependencies. After fixing those fixtures, selected execution passed while interruption tests still failed: expected `restriction_apply.stopReason = interrupted`, received the unchanged empty/prior-progress result. That confirmed the already-started routing gap. A revoked pre-send request likewise remained processing because admission had closed its execution before the ordinary terminal fence. The narrow routing and atomic pre-send-denial changes fixed these behavioral failures.

All DB commands read both integration skill files and the owned database guard, and used only identical `TEST_DATABASE_URL`, `DATABASE_URL`, `POSTGRES_DB_URL` values of `postgresql://postgres:postgres@127.0.0.1:55433/drasil_mcp_test?schema=public`, with `JEST_INTEGRATION=1`. Each invocation used `node -e "require('./scripts/owned-test-database').ownedTestDatabase()"` before direct Jest. No integration-runner filter assumption or concurrent database test run was used.

Final database commands/results:

- `npx jest --runInBand --runTestsByPath src/__tests__/integration/McpLockdownConfiguration.integration.test.ts src/__tests__/integration/McpOperations.integration.test.ts --silent`: two suites, 72 passed, 57.883 seconds. Both pg and Prisma variants passed. Covers selected execution, tampering, connection revocation, cross-guild audit reads, interrupted recovery, full fix manifest, later diagnostic pages, delegated read budgets and denied post-revocation paging.
- After adding the substantive-receipt pre-send-denial guard regression and moving zero-receipt reconciliation below actor checking: `npx jest --runInBand --runTestsByPath src/__tests__/integration/McpLockdownConfiguration.integration.test.ts --silent`: one suite, 18 passed, 15.132 seconds. After the final terminal-tampering follow-up the same suite passed all 18 again in 18.982 seconds.

Other focused checks:

- `npm run web:test -- lib/mcp/tools/setup.test.ts lib/moderationActionRequestDataAdapter.test.ts lib/moderationQueueOperationActionQueue.test.ts lib/mcp/adapters/restriction.test.ts`: four files, 31 passed in the final run. The added native real-plan-admission/client-envelope regression was also verified with `npm run web:test -- lib/moderationQueueOperationActionQueue.test.ts`, eight passed.
- `npx jest --runInBand --runTestsByPath src/__tests__/unit/CommandHandler.config-lockdown.unit.test.ts src/__tests__/unit/CaseRoleLockdownService.unit.test.ts src/__tests__/unit/AccountQuarantineService.unit.test.ts`: three suites, 24 passed. Expected existing failure-path console output remains.
- `npx jest --runInBand --runTestsByPath src/__tests__/unit/CaseRoleLockdownService.unit.test.ts src/__tests__/unit/RestrictionAuditService.unit.test.ts`: two suites, 11 passed.
- `npx jest --runInBand --runTestsByPath src/__tests__/unit/ModerationActionRequestService.unit.test.ts --testNamePattern 'lockdown'`: five affected tests passed. Other tests were intentionally filtered for Task 7.
- `npx jest --runInBand --runTestsByPath src/__tests__/unit/SecurityActionService.unit.test.ts --testNamePattern 'auto-kicks high-confidence|continues case notification when automatic restriction fails|creates detection and verification'`: three affected automatic-response tests passed. Configured case/kick handling is still attempted and case delivery continues after incomplete restriction. Other tests were intentionally filtered.
- Application build/typecheck, root no-emit TypeScript and web typecheck passed. `npm run action:boundary` passed 17 tests and all 55 command-kind inventory checks. Touched-file ESLint across each package and `git diff --check` passed.

## Self-review and limits

No public or client projection contains the private fact snapshot or attempt token. Automatic write input always originates in the admitted stored plan, never a client effect list. Every public diagnostic page retains the complete selectable manifest. Started/unknown effects are observed without replay, and authoritative progress is retained during terminal recording. Existing user/grant/consent checks are additive to the selected-plan contract.

Automatic approval review rejected an initial wholesale integration-file replacement, then a truncation-based replacement whose exact deletion range was not proven. Neither command ran. The safe alternative read and hash-verified only the 4494-character obsolete coarse-enable test block (SHA256 c7f1f13b779552e437c53bf9b6b1157fb7714a67f027db5a1dcad9e0c5c9f30b), replaced that block, retained scope-denial assertions and appended narrow regressions. It also rejected moving intake-only policy reads out of other operations. That command did not run; production policy reads were preserved and the omitted fixture dependency was supplied explicitly.

Skipped full repository CI and live Discord acceptance, which remain Task 7. No Task 6 UI has been built; the review URL becomes usable with that route. The bounded selected thread-member read may conservatively reject very large selected threads. Discord still offers no cross-request transaction for permission writes; uncertain outcomes remain honest receipts and require a fresh reviewed plan. Existing unrelated incomplete-mock warnings remain Task 7 work.

## Files

- `apps/web/app/admin/guild/[guildId]/cases/messageCleanupActions.ts`
- `apps/web/app/admin/guild/[guildId]/operations/actions.ts`
- `apps/web/e2e/legacy/userReportActionQueue.ts`
- `apps/web/lib/discordApi.ts`
- `apps/web/lib/mcp/adapters/restriction.test.ts`
- `apps/web/lib/mcp/adapters/restriction.ts`
- `apps/web/lib/mcp/adapters/setup.ts`
- `apps/web/lib/mcp/delivery.ts`
- `apps/web/lib/mcp/tools/approvals.ts`
- `apps/web/lib/mcp/tools/setup.test.ts`
- `apps/web/lib/moderationActionRequestDataAdapter.ts`
- `apps/web/lib/moderationQueueOperationActionQueue.test.ts`
- `apps/web/lib/moderationQueueOperationActionQueue.ts`
- `apps/web/lib/userReportActionQueue.ts`
- `packages/application/src/containment/ports.ts`
- `packages/application/src/delegation/execution.test.ts`
- `packages/application/src/delegation/execution.ts`
- `packages/application/src/delegation/intents.ts`
- `packages/application/src/delegation/types.ts`
- `packages/application/src/index.ts`
- `packages/application/src/operations/actions.test.ts`
- `packages/application/src/operations/actions.ts`
- `packages/application/src/operations/commands.ts`
- `packages/application/src/operations/ports.ts`
- `packages/application/src/operations/reports.ts`
- `packages/application/src/operations/restrictionExecution.ts`
- `packages/application/src/operations/restrictionPresentation.ts`
- `packages/application/src/operations/restrictionTypes.ts`
- `packages/application/src/postgres/delegation.ts`
- `packages/application/src/requests/operations.test.ts`
- `packages/application/src/requests/operations.ts`
- `packages/application/src/results.ts`
- `packages/application/src/setup/resolution.test.ts`
- `packages/application/src/setup/resolution.ts`
- `src/__tests__/integration/McpLockdownConfiguration.integration.test.ts`
- `src/__tests__/integration/McpOperations.integration.test.ts`
- `src/__tests__/unit/AccountQuarantineService.unit.test.ts`
- `src/__tests__/unit/CaseRoleLockdownService.unit.test.ts`
- `src/__tests__/unit/CommandHandler.config-lockdown.unit.test.ts`
- `src/__tests__/unit/ModerationActionRequestService.unit.test.ts`
- `src/__tests__/unit/caseApplicationTestHarness.ts`
- `src/application/adapters/captcha.ts`
- `src/application/adapters/messageCleanup.ts`
- `src/application/adapters/operations.ts`
- `src/application/adapters/quarantine.ts`
- `src/application/operationsDispatch.ts`
- `src/application/quarantineDispatch.ts`
- `src/application/requestDispatch.ts`
- `src/application/requestRuntime.ts`
- `src/controllers/LockdownConfigCommandHandler.ts`
- `src/di/container.ts`
- `src/services/AccountQuarantineService.ts`
- `src/services/CaseRoleLockdownService.ts`
- `src/services/IntegrityAuditService.ts`

Final self-review follow-up: selected-ID tampering now produces an explicit terminal binding-mismatch denial on both queue and public execution receipt, instead of leaving a no-effect request processing. The existing tamper DB test asserts status/result and zero writes. The same no-send proof helper handles grant revocation; substantive prior receipts retain read-only uncertain evidence.


## Review fix round 1 of 5

Review base: `fc26813`. Read `task-5-review.md`; addressed both Important findings.

1. Stored plan-envelope mismatch now enters the existing exact no-send terminalization proof for an unstarted execution. It no longer unconditionally selects observation-only handling. Current queue/execution identity, actor/guild, delegated binding, token/live lease and absence of substantive receipts remain required. Started or completed executions remain observation-only, and an unstarted execution with prior substantive receipts still fails the no-send proof and retains `uncertain_prior_effect`. The new real-DB regression mutates only `metadata.restriction_plan.effects`, asserts zero adapter writes, and requires terminal `binding_mismatch` in both queue and public execution receipt.
2. Shared permission assessment and the existing containment projection now use the broader compromised-account privilege set, including ban, kick and the other existing compromised-account safeguards. Both explicitly include the everyone role even if it is absent from the member's supplied role-ID list. Case-role privileges are assessed as well. The existing root compromised enforcement array now aliases the shared flag list so it cannot drift from diagnostics. `STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS`, role classification, staff protection, exemptions and role-removal decisions remain unchanged. Broader diagnostic findings do not silently expand the existing case-role permission-edit proposal mask; newly detected powers can remain manual repairs. No automatic moderation readiness gate was introduced.

Red evidence:

- `npm run application:test -- --runInBand --runTestsByPath src/operations/restrictionAssessment.test.ts src/operations/restrictionPolicy.test.ts`: nine failed and 35 passed. Valid private recovery/full-coverage fixtures with dangerous global powers lacked `retained_privileged_permissions` findings. Tests cover case and everyone roles, including a member role list that omits everyone.
- `npx jest --runInBand --runTestsByPath src/__tests__/unit/CaseRoleLockdownService.unit.test.ts src/__tests__/unit/AccountQuarantineService.unit.test.ts --silent`: two failed and 20 passed. The retained-privilege projection omitted the case/everyone role with Ban Members.
- Guarded `npx jest --runInBand --runTestsByPath src/__tests__/integration/McpLockdownConfiguration.integration.test.ts --testNamePattern 'plan-envelope' --silent`: both pg/Prisma regressions failed. Expected terminal denial, received processing with an empty result. Eighteen unrelated tests were deliberately filtered in this red run.

Green evidence:

- The focused application assessment/policy command above: two suites, 45 passed in 4.482 seconds, including the added combined staff/global-power protection regression.
- The focused containment command above: two suites, 22 passed in 3.68 seconds.
- Guarded `npx jest --runInBand --runTestsByPath src/__tests__/integration/McpLockdownConfiguration.integration.test.ts --silent`: one suite, all 20 passed in 21.093 seconds. This includes both adapters, envelope and selected-ID tampering, valid reviewed execution, revocation, substantive-receipt preservation and interrupted read-only recovery.
- Application build, touched-file ESLint, root no-emit TypeScript and `git diff --check` passed. The final added policy test was formatted and included in the 45-test green run.

Database environment remained the identical guarded owned loopback URL for `TEST_DATABASE_URL`, `DATABASE_URL` and `POSTGRES_DB_URL`, with `JEST_INTEGRATION=1` only for direct serialized DB Jest. No live provider call, new dependency, broad suite, workflow publication or deployment was performed.

Contract addition: `COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSION_FLAGS` and its combined mask are exported with the existing restriction-policy exports. They describe containment risk, independently of the unchanged standard role-removal policy. Existing skipped full CI/live acceptance and Task 7 minor-test/noisy-mock follow-ups remain unchanged.
