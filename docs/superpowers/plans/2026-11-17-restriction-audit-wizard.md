# Restriction Audit Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved policy-aware restriction assessment and a compact wizard that applies only reviewed repairs and reports their verified outcomes.

**Architecture:** Keep Discord reads/writes in bot adapters and put assessment, proposal selection, and execution rules behind the existing shared application boundary. Persist audit snapshots, accepted plans, and fenced effect receipts in existing moderation requests. Reuse the current web Foundation, request queue, delegation approvals, and quarantine restoration data.

**Tech Stack:** TypeScript, discord.js, InversifyJS, Zod, Prisma/Postgres, Next.js/React, Jest, Vitest, Playwright.

**Spec:** [Approved restriction audit wizard design](../specs/2026-11-17-restriction-audit-wizard-design.md), approved by the user on 2026-11-17.

## Review brief

Deliver this as one feature through a single issue, isolated worktree, and PR. The seven tasks below build the assessment, safe repairs, shared interfaces, and reviewed UI in dependency order. No partial backend should be enabled publicly before selected-plan approval is enforced everywhere.

The administrator journey stays **Choose fixes → Review selected bullets and affected people → Apply and verify**. The implementation preserves dark mode, the original tree icon, bulk selection, and details closed by default. Production counts and defaults come from the assessment, not the fictional prototype.

Implementation has not started. This plan needs review before execution. Live Discord acceptance is a separate authorization and is not implied by approving code work.

## Global Constraints

- “The intended access is the member's own private case thread, with no other community access by default.”
- “Administrators may explicitly configure read-only exception channels.”
- “Do not remove protected staff roles through this wizard.”
- “Audit is read-only.”
- “Select all includes all selectable proposals, including optional and broader ones; it is never approval.”
- “Stop the batch at the first write failure, lost precondition, or uncertain outcome.”
- “There is no automatic rollback or retry loop.”
- “Do not automatically elevate bot permissions to complete an audit.”
- “Automatic member-specific overwrite rewriting and its later restoration are deferred.”
- “Do not automatically migrate recovery channels or thread memberships in V1.”
- “This assessment must not reintroduce the removed setup-readiness downgrade or prevent configured automatic cases/kicks from being attempted.”
- “A successful API response or finished batch alone cannot produce Verified.”
- Verify permissions separately from recovery-parent content. Do not scan message history or claim verified information isolation from metadata.
- Use existing Foundation components, theme preferences, and `apps/web/public/brand/drasil-tree.png`. No new dependencies, theme system, queue system, or generic workflow engine.
- Public copy uses neutral fictional examples and no private server/member identifiers. Do not persist long diagnostic prose or source-defined threat indicators.
- Reuse small fact builders. Keep real-database tests for fencing, concurrent acceptance, and snapshot ownership; do not duplicate fixture graphs across interfaces.

## Review Focus

1. A case closes or its member leaves between approval and role removal: no new removal, no overwritten restoration snapshot. Tasks 3–4.
2. An old worker wakes after another claim owns execution: it cannot write progress, terminal results, or a second role effect. Tasks 3–4.
3. Only part of a category is inspected, a channel is obfuscated, or archived thread paging fails: coverage is explicit and isolation cannot be verified. Tasks 1–2.
4. Two proposals touch the same permission bits, or an unsync changes inheritance: deduplicate compatible effects or reject conflicting selection before approval, never silently broaden it. Tasks 2 and 4.
5. A user signs in through a deep link, changes selection after approval, or submits a foreign/expired audit reference: return to the intended task, require fresh approval, and never trust client-supplied effects. Tasks 4–6.

## Structure and cross-task interfaces

Use the existing `operations` application module rather than creating a second feature framework:

| Owner  | Files and responsibility                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 | New `packages/application/src/operations/restrictionTypes.ts`, `restrictionAssessment.ts`, `restrictionPolicy.ts`, and their colocated tests. Shared platform-neutral facts, classification, and effective access. Export through `packages/application/src/index.ts`. |
| Task 2 | New `src/services/RestrictionAuditService.ts`; modify `CaseRoleLockdownService.ts`, `RoleQuarantineService.ts`, and `IntegrityAuditService.ts`. Collect live facts, generate proposals, and migrate existing audit consumers.                                          |
| Task 3 | New `packages/application/src/operations/restrictionPersistence.ts` and `packages/application/src/postgres/restriction.ts`; extend existing moderation-request repository/worker fencing and quarantine-snapshot repository. No new tables planned.                    |
| Task 4 | New `packages/application/src/operations/restrictionActions.ts`, `restrictionExecution.ts`, and `src/application/adapters/restriction.ts`. Selection admission, frozen approval, repair execution, and read-back.                                                      |
| Task 5 | Existing operation commands/reports/actions, request codec/dispatch, setup intent resolver, delegation registry/execution, Discord lockdown handler, MCP setup tools, and result projections. One contract on every interface.                                         |
| Task 6 | New `apps/web/components/operations/RestrictionAuditWizard.tsx`, CSS module, component tests/stories, `apps/web/lib/restrictionAuditDataAdapter.ts`, and guild-scoped wizard route/actions. Reuse workspace entry points and polling.                                  |
| Task 7 | Existing feature documentation plus focused end-to-end and integration coverage; final PR, CI, and acceptance evidence.                                                                                                                                                |

Define these contracts in Task 1, with Zod validation for persisted/input shapes. Public timestamps are ISO strings; permission bitfields are decimal strings, not JSON bigint values.

- `RestrictionStatus = 'verified' | 'incomplete' | 'unverified'`.
- `RestrictionCoverage`: `area`, `state: 'complete' | 'partial' | 'unavailable' | 'out_of_scope'`, `checked`, `total: number | null`, `reason: string | null`, and observation times. Areas are `channels`, `cases`, `threads`, `affected_members`, and `parent_content`.
- `RestrictionAssessment`: status, stable finding codes, coverage, and assessed scope. Case assessments also bind `caseId`, `caseRevision`, and `userId`.
- `RestrictionAssessmentSet`: `{ setup: RestrictionAssessment; cases: readonly RestrictionCaseAssessment[] }`, with `RestrictionCaseAssessment` extending the assessment's case/member binding above.
- `RestrictionRoleFact`: `id`, `name`, `position`, decimal `permissions`, `managed`, and `botManaged`. `RestrictionRolePolicyInput` binds `guildId`, `caseRoleId`, `purpose: 'standard_case' | 'compromised_account'`, configured quarantine mode, exempt role IDs, manual-intake role ID, nullable bot-highest position, and the role facts. `RestrictionRoleDisposition` contains `roleId`, `removable`, and a nullable typed skip reason matching the existing enforcement distinctions.
- `RestrictionFacts`: guild/case-role identities, relevant settings, roles with privileges/manageability, channel overwrites/inheritance, current case/member roles, and thread state/membership. No message content.
- `RestrictionFix`: stable ID, kind, readable summary, before/after effects, affected scope/counts, `defaultSelected`, `selectable`, and `effects: readonly RestrictionEffect[]`. Hardening and manual findings remain distinguishable from access failures.
- `RestrictionEffect` is a closed union: `edit_overwrite`, `set_role_permissions`, `unsync_channel`, `update_quarantine_policy`, or `quarantine_case_roles`. Member-overwrite corrections remain manual. Every automatic effect binds target IDs, expected material state, and desired state; role-removal effects additionally bind case revision, member ID, and role IDs.
- `RestrictionAudit`: `schemaVersion: 1`, guild ID, observation times, `revision`, `expiresAt`, setup assessment, case assessments, coverage, fixes, and server-owned fact snapshot. Do not expose the full snapshot in public tool/UI projections. `expiresAt` is ten minutes after the audit's initial observation; admitting a selection does not extend it.
- `RestrictionSelection`: `auditRequestId`, `auditRevision`, and nonempty unique `selectedFixIds`. Never accept client-authored effects.
- `ApprovedRestrictionPlan`: selection plus actor/guild binding, canonical selected effects, material-state fingerprint, and `expiresAt`. Use `RESTRICTION_PLAN_TTL_MS = 10 * 60 * 1000`; an expired review requires fresh admission.
- `RestrictionProgress`: schema version, monotonic revision, current effect index, and per-effect `not_attempted | started | applied | failed | unknown` receipts. Distinguish observed state from assumed causation.
- `RestrictionApplyResult`: progress, stop reason, and fresh setup/case verification. Request completion and permission verification are separate states.

`RestrictionPlanDependencies` binds the existing `AuthorityPort`, audit store, injected `now(): Date`, and `readFresh(guildId: string, fixes: readonly RestrictionFix[]): Promise<RestrictionFacts>`. `RestrictionExecutionDependencies` additionally binds the private worker attempt token, execution store, `write(effect: RestrictionEffect): Promise<void>`, `observe(effect: RestrictionEffect): Promise<RestrictionEffectObservation>`, and `audit(guildId: string): Promise<RestrictionAudit>`. Observations distinguish desired state satisfied, before-state still observed, and unavailable evidence. A timeout remains unknown even if an immediate read still shows before-state; that does not rule out later completion. None of these ports accept a client-supplied actor, token, or effect body.

The case-role edit mask identifies only approved permission bits. Unsync plans freeze the source overwrite set because copying it is itself material. A policy change freezes only relevant settings, not unrelated configuration or cosmetic names.

### Focused integration commands

The existing `npm run test:integration` runner accepts only `--prepared`; it does not forward Jest file filters. Do not change that runner just for this feature. After following the integration skill, set all three database URLs to the same owned disposable loopback database accepted by `scripts/owned-test-database.js`, generate Prisma, and prepare it with `node -r dotenv/config scripts/prepare-test-database.js`.

For the focused commands below, define this PowerShell session helper so the database flag does not leak into subsequent unit tests:

```powershell
function Test-RestrictionIntegration([string[]]$TestFile) {
  $previousIntegration = $env:JEST_INTEGRATION
  try {
    $env:JEST_INTEGRATION = '1'
    npx jest --runInBand --runTestsByPath @TestFile
  } finally {
    $env:JEST_INTEGRATION = $previousIntegration
  }
}
```

Each targeted integration command must execute its named tests, with nonzero assertions in the summary. A skipped suite is not a green result. The normal full gate still uses the repository runner unchanged.

## Task 1: Share role policy and effective-access assessment

**Files:** Create the Task 1 files above plus `restrictionTestData.ts` beside their tests. Modify `src/services/RoleQuarantineService.ts` and its existing unit test to consume the classifier. Keep fixture helpers limited to role, channel, case, and fact builders.

**Interfaces:** Produce `classifyRestrictionRoles(input: RestrictionRolePolicyInput): readonly RestrictionRoleDisposition[]` and `assessRestrictionFacts(facts: RestrictionFacts): RestrictionAssessmentSet`. The latter returns setup/case assessments and grouped findings; it performs no I/O. Preserve standard versus compromised-account classification and configured manual-intake exclusions.

- [ ] **Write the failing tests.** In `restrictionAssessment.test.ts`, assert `expect(assessRestrictionFacts(facts).setup.status).toBe('verified')` for a role deny plus an allow on a role removed by configured quarantine. A table covers quarantine `off`, legacy `audit_only`, exemptions, missing case role, unknown metadata, Administrator/owner, and member overwrites. Assert visibility denial suppresses an apparent posting-only leak. Assert staff-role existence is not a setup failure, but an actual restricted staff case with excess access is incomplete. Assert `parent_content` remains `out_of_scope` and never supports information-isolation claims.
- [ ] **Run red:** `npm run application:test -- --runInBand --runTestsByPath src/operations/restrictionAssessment.test.ts src/operations/restrictionPolicy.test.ts`. Expect missing exports or failing policy assertions, not a database failure.
- [ ] **Implement the two functions and schemas.** Extract the existing standard/compromised role classification once, preserve privilege/hierarchy/managed-role skips, and apply Discord permission precedence to channel-type capabilities and private-thread access. Keep configured-policy predictions separate from actual member facts. Cover reaction limitations as a known restriction limitation, not an invented deny capability.
- [ ] **Run green:** repeat the application command, then `npm test -- --runInBand --runTestsByPath src/__tests__/unit/RoleQuarantineService.unit.test.ts`. Expect policy parity and assessment tests to pass without a database.
- [ ] **Commit:** `feat: assess restriction access using shared quarantine policy`.

## Task 2: Collect live facts and build actionable audit results

**Files:** Create `src/services/RestrictionAuditService.ts` and `src/__tests__/unit/RestrictionAuditService.unit.test.ts`; modify the existing lockdown, quarantine, integrity services, DI symbols/container, and corresponding audit tests. Put proposal generation in new `packages/application/src/operations/restrictionProposals.ts` with colocated tests.

**Interfaces:** Produce `RestrictionAuditService.auditGuild(guildId: string): Promise<RestrictionAudit>` and `proposeRestrictionFixes(facts: RestrictionFacts, assessment: RestrictionAssessmentSet): readonly RestrictionFix[]`. Existing audit consumers adapt the same result, not a separately implemented definition of health. The collector's injected clock and Discord read port make coverage failures testable.

- [ ] **Write the failing tests.** Fake two pages of cases and an archived-thread page failure. Assert `expect(audit.coverage.find(x => x.area === 'threads')?.state).toBe('partial')` and `expect(audit.setup.status).not.toBe('verified')` when required coverage is missing. Cover obfuscated/missing overwrites, voice/forum/media channels, public siblings, private membership, reopening archived threads, missing own-thread access, and API denial. Assert synced children produce one grouped proposal with affected child IDs. Assert prospective role conditions do not claim observed member counts.
- [ ] **Run red:** `npm test -- --runInBand --runTestsByPath src/__tests__/unit/RestrictionAuditService.unit.test.ts` and `npm run application:test -- --runInBand --runTestsByPath src/operations/restrictionProposals.test.ts`.
- [ ] **Implement collection and proposals.** Use fresh Discord facts, paginated case/member/thread metadata, and the existing sibling-thread caching seam. Use case pages of 50, Discord-supported thread/member pages of up to 100, concurrency 2, and an injected 90-second audit deadline. On exhaustion return partial coverage and known findings, never a sample labeled complete. Run collection in the existing worker, not in the web request. Do not read parent message history. Expand inherited exception categories into named channel effects while preserving stored settings until an approved change. Separate required recovery-parent access from ordinary exceptions.
- [ ] **Implement selection policy and effect normalization.** Default-check only selectable, narrow case-role permission corrections with established absence of ordinary-member access effects. Unknown impact, role removals, policy changes, unsyncs, broader changes, and hardening start unchecked. Prefer quarantine-policy corrections to removing ordinary access. Merge compatible overlapping bit edits, reject contradictory effects, and group prerequisites into disclosed inseparable fixes. Protect staff roles and list unsupported/manual work instead of generating a write.
- [ ] **Run green:** both focused commands plus existing `CaseRoleLockdownService.unit.test.ts`, `IntegrityAuditService.unit.test.ts`, and compromised-account quarantine tests. Assert no new readiness gate in `DetectionOrchestrator`/automatic-kick regressions. Commit `feat: collect restriction audit coverage and reviewed repair proposals`.

## Task 3: Persist audits, frozen plans, and fenced repair progress

**Files:** Create the Task 3 application/postgres modules, `restrictionPersistence.test.ts`, and `src/__tests__/integration/RestrictionRepairPersistence.integration.test.ts`. Modify `ModerationActionRequestRepository.ts`, `ModerationActionRequestService.ts`, their interfaces/fakes, `RoleQuarantineSnapshotRepository.ts`, and `src/__tests__/fakes/moderationActionRequests.ts`. Update package exports. Read the repo integration-testing skill before running the database test.

**Interfaces:** Produce `RestrictionAuditStore.load(auditRequestId: string, guildId: string): Promise<RestrictionAudit | null>` and `RestrictionExecutionStore` methods `loadPlan(requestId: string): Promise<ApprovedRestrictionPlan | null>`, `loadProgress(requestId: string): Promise<RestrictionProgress | null>`, and `saveProgress(requestId: string, attemptToken: string, expectedRevision: number, next: RestrictionProgress): Promise<boolean>`. Persist versioned audit data in completed audit-request results, the accepted plan in apply-request metadata, and progress/final verification in apply-request results. The server loads and validates these records; clients only send references/selections.

- [ ] **Write the failing real-Postgres tests.** Two workers claim the same queued apply; assert one owns it. After lease takeover, assert `expect(await store.saveProgress(id, oldToken, revision, next)).toBe(false)` and that the old owner cannot heartbeat, complete, or fail the new owner's request. Concurrent accepts of the same idempotency key produce one apply request with one immutable selected plan. JSON read/modify/write must not lose another effect receipt. Foreign-guild audit references and malformed stored versions are rejected.
- [ ] **Run red:** `Test-RestrictionIntegration -TestFile 'src/__tests__/integration/RestrictionRepairPersistence.integration.test.ts'`, with the prepared owned local test database. Expect assertions/missing implementation failures after database setup succeeds.
- [ ] **Implement narrow persistence changes.** Reuse existing JSON columns; no new table or enum is needed. Extend the existing claim/heartbeat/15-minute interrupted-worker handling specifically for versioned restriction audit/apply requests. Generate a restriction attempt token for both native queue claims and MCP-settled claims; guard progress and terminal writes by current token, processing state, revision, and current lease. A lost delegated execution fence also stops effects. Keep existing report-ban fencing unchanged. Interrupted apply requests may be reclaimed for reconciliation, not automatic effect replay. Other operation kinds retain their current behavior.
- [ ] **Add snapshot append fencing.** Expose `appendRestrictionRepairRoles(input: { caseId: string; caseRevision: number; requestId: string; attemptToken: string; userId: string; roleIds: readonly string[] }): Promise<RoleQuarantineSnapshot | null>`. Atomically bind to the still-pending case and active attempt; append planned restoration/removal state without replacing earlier snapshot roles. Refuse competing ownership of an unresolved removal for the same case/role and keep unknown earlier removals blocked until reconciled. Preserve exclusions for policy-managed intake/honeypot roles. A resolved or departed case cannot acquire new removal work. Use the existing snapshot model and case lifecycle fences, not a parallel restoration ledger.
- [ ] **Run green:** the database command plus focused request and snapshot repository tests, serialized against one local database. Commit `feat: persist approved restriction repairs with fenced progress`.

## Task 4: Admit and execute only the approved selected repairs

**Files:** Create `restrictionActions.ts`, `restrictionExecution.ts`, colocated unit tests, `src/application/adapters/restriction.ts`, and `src/__tests__/unit/RestrictionRepairService.unit.test.ts`. Modify `RoleQuarantineService.ts` and its interface to implement existing-case removals, using Task 3 snapshot append. Add `src/__tests__/integration/RestrictionRepairRestoration.integration.test.ts` for lifecycle races.

**Interfaces:** Produce `prepareRestrictionPlan(context: ActionContext, selection: RestrictionSelection, deps: RestrictionPlanDependencies): Promise<ApprovedRestrictionPlan>` and `executeRestrictionPlan(context: ActionContext, requestId: string, deps: RestrictionExecutionDependencies): Promise<RestrictionApplyResult>`. Dependencies consume Tasks 1–3 and explicit Discord effect/read-back ports. Add `repairCaseRoles(member: GuildMember, caseRecord: VerificationEvent, roleIds: readonly string[], actor: User, fence: RestrictionRepairFence): Promise<RoleQuarantineApplyResult>` to the bot quarantine boundary.

- [ ] **Write the failing tests.** Submitting an effect body, a foreign-guild audit reference, expired audit, unknown/duplicate fix IDs, unsupported/manual fix, conflicting selection, or no selection cannot admit a plan. Another actor cannot execute a prepared plan bound to its original actor. For a relevant permission/membership change, assert `expect(result.stopReason).toBe('stale_state')` and `expect(write).not.toHaveBeenCalled()`. Cosmetic renames and unrelated settings do not invalidate an otherwise matching plan. Revoked authority denies execution. A selected grouped policy/current-member repair must disclose both effects.
- [ ] **Write the execution failure tests.** Fail effect 2 of 3: effect 1 remains applied, effect 2 is failed/unknown according to read-back and transport evidence, effect 3 is not attempted. A crash after an external role removal but before receipt completion reconciles without removing again or replacing the snapshot. Case closure, member departure, new staff privilege, and role hierarchy changes prevent not-yet-started removal. An already in-flight removal racing with resolution must retain the restoration snapshot and use existing resolution reconciliation, not pretend the Discord request was cancelled. Preserve unrelated overwrite bits, reject stale unsync sources, and verify the resulting access rather than trusting the API response. The real-database test proves role restoration still includes prior and newly repaired snapshot removals exactly once.
- [ ] **Run red:** `npm run application:test -- --runInBand --runTestsByPath src/operations/restrictionActions.test.ts src/operations/restrictionExecution.test.ts`; `npm test -- --runInBand --runTestsByPath src/__tests__/unit/RestrictionRepairService.unit.test.ts`; `Test-RestrictionIntegration -TestFile 'src/__tests__/integration/RestrictionRepairRestoration.integration.test.ts'`.
- [ ] **Implement admission and the sequential executor.** Recheck owner/Administrator authority, stored actor/guild/revision, fresh material state, expiry, and selected effects before accepting; hash a canonical material projection that excludes labels and unrelated fields. Recheck all selected preconditions before the first write and each effect immediately before its write. Save `started` before Discord, read back afterward, and commit a fenced receipt. Stop at the first failed/unknown effect or lost fence. On recovery reconcile started/unknown effects read-only and stop; never automatically continue an interrupted batch. New execution requires a fresh plan for remaining work. Existing-case removal must use `repairCaseRoles`, not `quarantineMember`'s already-active shortcut. Never auto-rollback, strip staff roles, or rewrite member-specific overwrites.
- [ ] **Run green:** all three focused suites and the restoration integration test. Assert setup and current-case results remain distinct and no unchanged successful role grant is treated as containment proof. Commit `feat: execute selected restriction repairs with fresh approval and verification`.

## Task 5: Migrate every operation surface to the shared contract

**Files:** Modify `packages/application/src/operations/{commands,reports,ports,actions}.ts`, `requests/{operations,commands}.ts`, `setup/resolution.ts`, `delegation/{types,operations,commands,execution,confirmationPolicy}.ts`, and the corresponding tests; `src/application/{operationsDispatch,requestDispatch}.ts`, bot operations/restriction adapters and DI; `src/controllers/LockdownConfigCommandHandler.ts`; `apps/web/lib/mcp/tools/setup.ts`, its bindings/adapter tests, and operation result projections. Extend `McpLockdownConfiguration.integration.test.ts` and `McpOperations.integration.test.ts`.

**Interfaces:** Keep shipped `audit_case_role_lockdown` and `apply_case_role_lockdown` workflow/tool identifiers. Audit yields the versioned normalized audit and durable `auditRequestId`. Apply's executable command is `{ kind: 'apply_case_role_lockdown'; auditRequestId: string; auditRevision: string; selectedFixIds: readonly string[] }`; its execution metadata contains the trusted accepted plan, never supplied by the client. Add `IntentPreconditions` case `{ kind: 'restriction_plan'; plan: ApprovedRestrictionPlan }`. Existing grant/consent rules remain mandatory in addition to the plan binding.

- [ ] **Write the failing tests.** Web, Discord, and MCP observe equivalent audit coverage and effects. `expect(oldCoarseApplyWrites).toBe(0)` for a legacy apply request lacking a selected plan. Existing legacy queued apply commands decode into an explicit `plan_required` rejection with a new-audit/review recovery path, never into all fixes selected. A user-approved old boolean or `unsyncAllowedChannels` cannot authorize new effects. Test selected-ID tampering between MCP intent acceptance and worker execution, connection revocation, delegated read limits, and cross-guild request status reads.
- [ ] **Run red:** `npm run application:test -- --runInBand --runTestsByPath src/operations/actions.test.ts src/requests/operations.test.ts src/setup/resolution.test.ts src/delegation/confirmationPolicy.test.ts src/delegation/execution.test.ts`; `npm run web:test -- lib/mcp/tools/setup.test.ts lib/moderationActionRequestDataAdapter.test.ts`; `Test-RestrictionIntegration -TestFile @('src/__tests__/integration/McpLockdownConfiguration.integration.test.ts','src/__tests__/integration/McpOperations.integration.test.ts')`.
- [ ] **Implement schema, dispatch, and presentation migration.** Project full structured audit/plan summaries and paginated findings, rather than the current first-eight-issues count-only projection. Expose the complete selectable-fix manifest for the completed audit even when diagnostic details are paginated; bulk selection cannot silently select only the visible page. Discord audit returns a concise result and wizard link; slash apply without a reviewed selection opens review or explains how to obtain it, with zero effects. MCP audit and apply use the same selection, exact-effect summary, durable approval, and result schema through existing workflow tools. Update all callers of `applyGuild` and adapters; remove the obsolete coarse execution path after migration. Preserve compromised-account containment checks and staff privilege distinctions, but consume the corrected assessment instead of treating raw warning totals as proof of failed containment.
- [ ] **Run green:** the focused suites, `npm run application:typecheck`, and `npm run action:boundary`. Assert automatic case/kick responses still attempt configured actions when isolation is incomplete. Commit `feat: share restriction audit and selected repair approval across interfaces`.

## Task 6: Build the reviewed compact web wizard

**Files:** Create `apps/web/components/operations/RestrictionAuditWizard.tsx`, `RestrictionAuditWizard.module.css`, `RestrictionAuditWizard.test.tsx`, `RestrictionAuditWizard.stories.tsx`; `apps/web/lib/restrictionAuditDataAdapter.ts` and `.test.ts`; `apps/web/app/admin/guild/[guildId]/operations/restriction-audit/{page.tsx,actions.ts}` and `actions.test.ts`; `apps/web/e2e/restriction-audit.spec.ts`. Modify existing Operations/setup entry points, operation action queue/polling/result adapters, `apps/web/e2e/workspaceFixtures.ts`, `apps/web/playwright.workspace.config.ts` test matching, and the corresponding default-config exclusions in `apps/web/playwright.config.ts`.

**Interfaces:** `RestrictionAuditWizard({ guildId, auditRequest, audit, applyRequest, onReview, onApply }: RestrictionAuditWizardProps)` consumes server-authorized DTOs, not raw snapshots. `RestrictionAuditDataAdapter` exposes `queueAudit(guildId)`, `readAudit(guildId, auditRequestId)`, `prepareSelection(guildId, selection)`, `queueApply(guildId, approvedPlanReference)`, and `readApply(guildId, requestId)`, all through the existing staff session/request boundary. Server actions derive actor/guild and reload accepted facts; browser form values cannot supply effects or trusted counts.

- [ ] **Write the failing tests.** Three realistic proposals exercise a default-selected case-role correction, unchecked current-member role repair, and unchecked hardening; one shared fixture feeds component, story, and E2E tests. Assert Select all includes all selectable fixes but not manual/unavailable rows; Clear all empties the bullet list and disables review/apply. Changing selection or returning to choose clears approval. Confirmed apply submits only the server-issued selection reference, never rendered effect text. Denied, loading, empty/healthy, incomplete coverage, stale plan, and interrupted-request results have explicit states without rendering a false success.
- [ ] **Run red:** `npm run web:test -- components/operations/RestrictionAuditWizard.test.tsx lib/restrictionAuditDataAdapter.test.ts 'app/admin/guild/[guildId]/operations/restriction-audit/actions.test.ts'`. Use literal paths/runner filters appropriate to the shell; do not let bracketed route names become glob expressions.
- [ ] **Implement the approved journey.** Put findings and checkboxes on one screen, with closed What changes disclosures, readable affected scope, Select all/Clear all, a sticky selected count, and Review changes. Show only selected fixes as short bullets with exact material effects and affected people on review; keep approval explicit. Use the existing tree image, Foundation typography/colors, native focus/checkbox/disclosure semantics, and existing dark/light preference. Keep `#rules (read-only)` as illustrative inline exception formatting, never a hardcoded exception or badge. Reuse Setup's channel exception controls and link back to them; present channel exceptions as read-only, preserve existing category-derived exceptions without allowing new category-wide additions, and invalidate old plans after relevant settings edits. Preserve selections during ordinary navigation, clear approval when required, and poll existing request status through reloads. Keep manual/unknown/staff findings in a compact attention disclosure; do not re-add the rejected These changes cannot block. Retain scoped parent-content limitations in outcomes.
- [ ] **Run green and inspect.** Run the focused tests and `npm run web:typecheck`. Add the new E2E file to the workspace config's explicit test list and exclude it from the legacy fixture config. Reuse `workspaceFixtures()` for controlled provider/database behavior. Build the non-legacy test app with `DRASIL_LEGACY_TEST_BUILD=false` in the owned workspace-test environment, then run `npm --workspace apps/web exec -- playwright test --config playwright.workspace.config.ts restriction-audit.spec.ts`. Confirm the test is collected, not filtered out. E2E covers signed-out deep-link return, insufficient authority, keyboard selection, bulk controls, approval invalidation, request reload, stale effects, and the results distinction. Check narrow 390px and desktop 1280px widths plus dark/light preferences; the footer must not obscure controls. Add only a small story set for chooser, review, and partial results. Commit `feat(web): add the restriction audit and repair wizard`.

## Task 7: Verify the whole feature and prepare acceptance

**Files:** Update `docs/moderation-permissions.md`, `docs/cases.md`, `docs/compromised-account-quarantine.md`, and `docs/test-cases.md`; update the approved design's evidence appendix with actual implementation decisions only if they remain within scope. Do not copy the throwaway HTML into shipped source.

**Interfaces:** The final feature exposes the same audit, selected plan, receipts, and status through web, Discord, and MCP. No unreviewed coarse permission-write entry point remains.

- [ ] **Check coverage against the spec.** Trace each acceptance bullet to the task/test that owns it. Search all `audit_case_role_lockdown`, `apply_case_role_lockdown`, and `applyGuild` callers. Remove dead helpers and duplicate fixture setup. Ensure no code-defined campaign indicators, new dependencies, blanket moderation gate, hidden staff removal, or invented content verification entered the branch.
- [ ] **Run the required gates.** After installing dependencies once in the execution worktree, run `npm run check:ci`, `npm run web:lint`, `npm run web:typecheck`, `npm run web:test`, and `npm run web:build`, plus the focused wizard E2E and new integration suites not covered by those commands. Follow repository CI for any additional package/delegation/visual checks. Do not run unrelated integration suites concurrently against the same database.
- [ ] **Prepare a controlled Discord acceptance checklist.** Name the test server/account only in private operator evidence. Separately authorize a synthetic case, verify own-thread access, excluded channels, explicit read-only exception behavior and platform limits, protected staff access, current-case role repair, role restoration, and truthful failed/unverified outcomes. Default to read-only checks before approved effects. No production permission changes, kicks, bans, or historical case replay are authorized by this plan.
- [ ] **Record proof at the correct level.** Unit/integration/browser passes are implementation proof. A completed deploy is rollout proof. A signed-in restricted-member session is live access proof. If live acceptance has not been authorized or completed, report it pending, not passed.
- [ ] **Finish the PR workflow.** Link the implementation issue and approved design, push the exact head, wait for terminal checks, handle valid review feedback and resolve addressed threads, then perform the delayed final sweep of comments/reviews/sticky summaries. Stop merge-ready unless the user separately authorizes merging. Commit the final documentation as `docs: document restriction audit operation and acceptance`.

## Execution preparation and evidence

- Create one sanitized implementation issue before Task 1 product commits. Continue in this isolated feature worktree or a fresh worktree containing the approved design and this plan; keep the protected checkout clean.
- Install dependencies once at execution time and use the repo local-DB/integration skill. This planning task deliberately does not install dependencies or run product tests.
- The plan uses the approved Mobbin-informed journey: [Twenty, Updating records](https://mobbin.com/flows/5970df17-fd43-4b05-8031-b11b1db98089?tab=screens), positions 1–7 previously inspected. Compact selection and separate approval are reused; no new UX research or added wizard steps are needed.
- Design checkpoint: `dd3d4d7`; source baseline: `f7f05b79016ef34ff3265c3d4b34a4df603d6431`. Prototype `restriction-audit-v11.html` is a visual reference only. Its fake counts, defaults, simulated checks, and standalone CSS are not an implementation.
- Plan review must precede product implementation. Recommended execution is subagent-driven, sequential by task, because persistence/approval mistakes can cause unintended permission changes. Keep implementation and reviewer contexts bounded to the relevant task and shared contracts.
