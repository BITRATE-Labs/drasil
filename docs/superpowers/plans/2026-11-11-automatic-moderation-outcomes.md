# Automatic moderation outcomes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attempt configured automatic moderation without a general setup gate, while preserving role-grant safety and making failed or partial responses actionable.

**Architecture:** Remove the readiness downgrade from `EventHandler`. Keep role validation at assignment, retain the existing case failure metadata, and use existing detection metadata and queue rows for failures without a case. Record the Discord kick acknowledgement separately from follow-up success.

**Tech Stack:** TypeScript, discord.js, existing application package and Zod, Prisma/Postgres, Jest, Vitest, existing Discord notification and web inbox components.

**Spec:** [Approved design](../specs/2026-11-11-automatic-moderation-outcomes-design.md).

## Review brief

Five sequential tasks implement one change. First protect the actual role grant, then make attention durable, then preserve truthful kick outcomes, then remove the gate and connect failures, and finally expose and verify the result. Do not remove the gate until its replacement safeguards and failure reporting are ready.

The main tradeoff is that a case can be open with incomplete restriction. Display the confirmed state and failed steps. Do not promise full isolation, replay historical detections, or change live permissions.

This plan needs review and an execution-method choice before product implementation. Recommendation: subagent-driven execution, because role-grant security and post-kick outcome handling merit independent review before the gate is removed. Native execution remains viable and uses fewer fresh contexts.

## Global constraints

- Preserve configured `off`, `record_only`, and `notify_only`, confidence thresholds, exemptions, automatic-kick opt-ins, target protections, and authorization.
- No new dependency, workflow framework, database enum, or schema migration. If a migration proves necessary, return for review before expanding scope.
- General setup readiness does not control runtime response policy. Keep onboarding and configuration diagnostics intact.
- Preserve confirmed side effects, existing safety compensation, and durable evidence requirements. Do not automatically retry kicks or escalate a failed restriction to a kick.
- Reuse existing case/detection attention and existing moderator pages. Send evidence only to configured moderator destinations.
- Failure attention after a selected action bypasses the ordinary observed-alert confidence cutoff and setup-DM suppression; ordinary low-confidence routing stays unchanged.
- Keep private community names, account handles, raw messages, prompts, and credentials out of public artifacts and diagnostics.

## Review focus

1. A configured case role with Administrator or administrative channel grants is rejected at assignment, including through repair paths. Task 1 pins this.
2. A successful kick followed by an acknowledgement-callback or database error remains a confirmed kick, and its claimed action is not released for replay. Task 3 pins this.
3. No Discord queue channel or a failed notification still leaves one web inbox item; scheduled reconciliation cannot delete it. Task 2 pins this.
4. Repeated processing, active-case linking, and attention acknowledgement preserve unresolved outcome details without duplicate cases or repeated enforcement. Tasks 2 and 4 pin this.
5. A kick transport failure is uncertain; an explicit Discord rejection is failed. Neither is automatically retried. Task 3 pins this.

## Task 1: Enforce safety at the role-assignment boundary

**Files:** Modify `src/services/RoleManager.ts` and `src/services/UserModerationService.ts`. Create `src/__tests__/unit/RoleManager.unit.test.ts`; extend `src/__tests__/unit/UserModerationService.unit.test.ts`. Update affected role-manager fakes in existing tests.

**Interfaces:** Add `IRoleManager.assertSafeCaseRole(member: GuildMember, roleId: string): Promise<void>`. Keep `assignCaseRole(member: GuildMember, roleId?: string): Promise<boolean>` and `getCaseRoleId(guildId: string): Promise<string | null>`.

- [ ] **Write failing tests.** Name the parameterized rejection test `rejects unsafe case roles before role mutation` and the permitted case `allows verification media permissions without setup gating`. Reject a missing role, @everyone, managed/unassignable role, nonzero guild permissions, or channel management/moderation grants. Pin `expect(member.roles.add).not.toHaveBeenCalled()`. Allow a zero-permission case role with the five benign media/reaction grants in the designated verification channel. Verify both explicit-role and configured-role assignment.
- [ ] **Run the new tests and confirm the security assertions fail on the current code.** Run `npm test -- --runInBand --testPathPattern='RoleManager.unit|UserModerationService.unit'` after `npm ci` in this worktree.
- [ ] **Implement the check once in `RoleManager`.** Resolve the actual role and inspect fresh role/channel data. Reject channel allows for `Administrator`, `ManageGuild`, `ManageChannels`, `ManageRoles`, `ManageMessages`, `ManageThreads`, `ManageWebhooks`, `ModerateMembers`, `KickMembers`, and `BanMembers`. Do not reintroduce a prohibition on every extra allow bit. `assignCaseRole` always calls the check before `roles.add`. `applyCaseRole` resolves and checks the same candidate before role-quarantine side effects. Retain assignment-time revalidation and existing rollback if assignment subsequently fails.
- [ ] **Audit all assignment callers.** `rg -n 'assignCaseRole|applyCaseRole' src` must cover repair, restoration, and rejoin paths. Existing role removal remains possible even for a now-invalid role. Tests must show a rejected grant produces a recorded failure rather than a false success.
- [ ] **Run the focused tests to green, inspect the diff, and commit.** Commit message: `[AGENT] Validate case role grants at assignment`.

## Task 2: Make failed-response attention independent of Discord delivery

**Files:** Create `packages/application/src/moderation/automaticResponse.ts`, `packages/application/src/moderation/automaticResponse.test.ts`, and `src/__tests__/integration/AutomaticModerationAttention.integration.test.ts`; export from `packages/application/src/index.ts`. Modify `src/services/ModerationQueueService.ts`, `src/repositories/DetectionEventsRepository.ts`, `src/__tests__/fakes/inMemoryRepositories.ts`, `src/utils/verificationActionFailures.ts`, and `src/repositories/ModerationQueueRepository.ts`. Extend `packages/application/src/operations/attention.ts` and `apps/web/lib/application/adapters/attention.ts` for the existing acknowledgement action, with their existing tests and `src/__tests__/unit/ModerationQueueService.unit.test.ts`.

**Interfaces:** Export a validated `AutomaticModerationResponse` union and `readAutomaticModerationResponse(metadata: unknown): AutomaticModerationResponse | null`. Store it under detection metadata key `automatic_moderation_response`. Keep `IModerationQueueService.upsertObservedAlertMirrorById(detectionEventId: string): Promise<void>` as the queue entry point. Add `notification` to existing case action-failure kinds where delivery failure is not already represented.

The union shares `updatedAt: string`, `failures: Array<{step: 'role' | 'thread' | 'kick' | 'persistence' | 'notification'; code: string}>`, `attention: 'required' | 'acknowledged' | 'resolved'`, and `caseId: string | null`. Variants are `action: 'kick'` with `outcome: 'pending' | 'kicked' | 'failed' | 'unknown'`, `action: 'restrict'` with `outcome: 'pending' | 'case_opened' | 'failed'`, and `action: 'notify'` with `outcome: 'pending' | 'notified' | 'failed'`. Use a Zod discriminated union and reject malformed external metadata. Use safe codes `role_assignment_failed`, `thread_creation_failed`, `kick_rejected`, `kick_outcome_unknown`, `persistence_failed`, and `notification_delivery_failed`. Never persist raw exception messages in this snapshot.

- [ ] **Write failing tests.** Use `persists response attention without Discord delivery`, `retains unresolved attention through reconciliation`, and `acknowledgement preserves the action outcome`. Required attention without a Discord notification ID or queue channel creates one `OBSERVED_ALERT_MIRROR` row. Two upserts retain the same identity. A failed send leaves the row. A confirmed kick with failed follow-up retains attention despite its completed observed action. Two concurrent calls claim the same detection at most once. Reconciliation keeps that row. Resolved attention removes only the attention item, without changing the actual action result. Acknowledged but unresolved attention remains visible without repeated pings. Assert `expect(queueRepository.upsert).toHaveBeenCalled()` even when Discord sends fail.
- [ ] **Run the tests to demonstrate the current notification-dependent behavior fails.** Run `npm run application:test -- --runInBand automaticResponse` and `npm test -- --runInBand --testPathPattern='ModerationQueueService.unit'`.
- [ ] **Implement the narrow exception for response attention.** Retain ordinary observed-alert eligibility. For valid response attention, persist the existing queue row before resolving Discord channels or sending. Include unresolved required or acknowledged response attention in `findUnresolvedObservedNotificationsByServer` and in stale-item reconciliation, even when no Discord message exists or the enforcement action already succeeded. Respect case ownership and attention state. A pending kick means its outcome is not yet confirmed and is never an invitation to replay it.
- [ ] **Pin persistence failures and acknowledgement behavior.** A repository write error propagates as an error; no code claims the alert was saved. Acknowledgement changes only attention state, leaving action outcome and failure details available. Add `QueueAttentionRepository.acknowledgeAutomaticResponse(input: {itemId: string; guildId: string; actorId: string; acknowledgedAt: Date}): Promise<QueueAttentionAcknowledgeStatus>` to both repository implementations. Update the detection snapshot and existing queue row together in a transaction, bound to the guild. Route only validated automatic-response items through this branch; ordinary observed alerts retain their existing actions. Keep acknowledged unresolved rows visible without repeated pings until resolution or a changed failure. Use existing attention controls rather than treating acknowledgement as a false-positive verdict.
- [ ] **Run package/unit tests and the targeted repository integration test in the owned test database.** Commit message: `[AGENT] Persist moderation response attention before delivery`.

## Task 3: Preserve kick acknowledgement through follow-up failures

**Files:** Modify `src/services/UserModerationService.ts`, `src/services/SecurityActionService.ts`, `src/application/adapters/cases.ts`, `src/application/adapters/delegatedCases.ts`, and `packages/application/src/delegation/execution.ts` only where existing native outcome handling needs the new error classification. Extend `UserModerationService.unit.test.ts`, `SecurityActionService.unit.test.ts`, `McpNativeLifecycle.unit.test.ts`, and the existing native-enforcement integration suite.

**Interfaces:** Preserve `IUserModerationService.kickUser(member, reason, moderator, detectionEventId?, nativeLifecycle?): Promise<boolean>` and `NativeEnforcementLifecycle.beforeSend()/acknowledged()`. Export `KickExecutionError` with `outcome: 'failed' | 'unknown' | 'kicked'`, `step: 'kick' | 'persistence' | 'notification'`, a safe code, and the original error as its internal cause. No boolean result or public MCP schema changes.

- [ ] **Write failing tests.** Use `preserves confirmed kick when follow-up fails`, `does not release an acknowledged kick claim`, and `does not retry uncertain kicks`. Pin `expect(member.kick).toHaveBeenCalledTimes(1)` and `expect(error.outcome).toBe('kicked')` for post-acknowledgement failure. When `member.kick` resolves and later finalization throws, the error has `outcome: 'kicked'`. Failure in `nativeLifecycle.acknowledged()` does not roll back the claim as though no kick happened. An explicit Discord rejection produces `failed`; a transport failure after dispatch produces `unknown`. Assert the kick is called once and no automatic retry occurs.
- [ ] **Run these cases to red.** Run `npm test -- --runInBand --testPathPattern='UserModerationService.unit|McpNativeLifecycle.unit|SecurityActionService.unit'`.
- [ ] **Track success at the real Discord boundary.** Mark acknowledgement immediately after `member.kick` resolves, before the lifecycle callback or later database/notification work. Roll back terminal claims only for a known pre-acknowledgement rejection, preserving existing native execution uncertainty handling for ambiguous requests. Wrap errors with accurate phase/outcome without exposing unsafe exception text to product copy.
- [ ] **Connect automatic kicks to durable metadata.** `autoKickSuspiciousMember` persists a pending response before dispatch and passes trusted lifecycle callbacks that persist `kicked` immediately after acknowledgement. Use `IDetectionEventsRepository.claimObservedAction` as the existing atomic per-detection claim, not a read-then-write check. Persist the pending snapshot as part of that claim. Existing response state for the same detection prevents replay of pending, failed, unknown, or confirmed kicks; repair/delivery work may continue without repeating enforcement. Document the lifecycle hook as usable by trusted internal callers, not only native delegation.
- [ ] **Migrate error consumers.** `kickObservedDetection` must preserve its action claim when a `KickExecutionError` says `kicked` or `unknown`. The case adapter/native execution path must preserve confirmed/uncertain outcomes and existing authorization. Audit `rg -n '\.kickUser\(|kickUser:' src apps/web` and update affected fixtures. Normal success remains `true`; failures remain exceptions with more accurate context.
- [ ] **Run focused tests plus native-enforcement integration coverage, then commit.** Commit message: `[AGENT] Preserve confirmed kick outcomes after follow-up errors`.

## Task 4: Remove the blanket gate and route actual failures to attention

**Files:** Modify `src/controllers/EventHandler.ts`, `src/services/SecurityActionService.ts`, and `src/services/NotificationManager.ts`. Extend their existing unit tests. Reuse the outcome contract and queue behavior from Tasks 2 and 3.

**Interfaces:** Keep public message/join service signatures and configured policy selection. Add `ISecurityActionService.recordAutomaticResponseFailure(member: GuildMember, detectionResult: DetectionResult, response: AutomaticModerationResponse, sourceMessage?: Message): Promise<void>` for failures not already owned by the durable case flow. It resolves the detection/case owner, persists actual outcome, upserts attention, then attempts configured delivery. A failed attention write must propagate and emit error telemetry.

- [ ] **Write the routing matrix as failing tests.** Name the parameterized matrix `honors configured response despite unrelated setup errors` and the failure case `reports failed enforcement above its action threshold even below the observed cutoff`. Assert the selected service action is called once, the unrelated diagnostic result does not substitute `record_only`, and required attention is persisted. Qualified message/join actions run despite diagnostic errors, missing diagnostic service, or diagnostic exceptions. Staff watchlist detections reach observed review. Eligible kicks run without a case role or verification channel. Explicit modes, confidence cutoffs, staff exemptions, rejoin policy, and kick opt-ins remain unchanged. Add the failure case where action qualification passes but the ordinary observed-alert cutoff is higher; attention must still appear.
- [ ] **Run to red.** Run `npm test -- --runInBand --testPathPattern='EventHandler.unit|SecurityActionService.unit|NotificationManager.unit'`.
- [ ] **Delete runtime readiness gating.** Remove `evaluateAutomaticDetectionSetupSafety`, its loader/cache/types/constants and both downgrade branches once caller searches show no remaining use. Preserve onboarding readiness and shared setup nudges. Supplemental setup diagnostics must not delay or prevent enforcement or alerts.
- [ ] **Use actual outcomes.** Existing case creation remains before role/thread effects. Record notification failures alongside existing case failures, preserve successful steps, and expose one case-owned attention record. Use `recordAutomaticResponseFailure` for no-case failures, including typed kick errors. Do not create an observed item alongside an existing case-owned failure. Do not convert deliberate `record_only` into a failure.
- [ ] **Emit truthful telemetry and handle database failure.** Required outcomes are confirmed success, failed action, unknown action, or successful action with incomplete follow-up. Incomplete response traces use warning/error levels; delivery and persistence errors use `ERROR`. Persist only safe codes. A missing durable prerequisite prevents dependent enforcement; failure to save a post-kick record never rewrites an acknowledged kick as unperformed.
- [ ] **Prove independent work and deduplication.** Test role failure with thread/notification continuation, thread failure after role success, case reuse, repeated detection processing, and both Discord destinations unavailable. Run focused tests to green and commit `[AGENT] Attempt configured moderation without setup downgrade`.

## Task 5: Present incomplete outcomes and verify the complete flow

**Files:** Modify `src/services/NotificationPresentationBuilder.ts`, queue payload builders, `apps/web/lib/moderationInboxDataAdapter.ts`, and existing case detail adapters/presentation only where failure fields are missing. Extend `NotificationManager.unit.test.ts`, queue tests, `moderationInboxDataAdapter.test.ts`, and affected case adapter tests. Update `docs/workflow.md` and `docs/test-cases.md`.

**Interfaces:** Use `readAutomaticModerationResponse` from Task 2 and existing case failure metadata. Keep existing inbox item kinds, links, and page routes. Use existing title, summary, status, and available action fields; no new page or navigation contract.

- [ ] **Write failing presentation tests.** Use `shows actual action separately from failed follow-up`, `renders response attention without Discord links`, and `does not offer repeat kick for confirmed outcomes`. Assert `expect(item.allowedActions).not.toContain('kick_user')` for a confirmed kick. Render role failure, thread failure after successful restriction, failed kick, unknown kick, and confirmed kick with failed delivery. Confirmed kicks expose no repeat-kick action; uncertain kicks direct inspection before further enforcement. Offer the existing acknowledgement action only for validated response-attention rows. Persisted failures render when every Discord message link is null. Case mirrors deduplicate to the same case. Acknowledged attention never displays as successful enforcement.
- [ ] **Run to red.** Run `npm --workspace apps/web run test -- lib/moderationInboxDataAdapter.test.ts lib/activeCaseDataAdapter.test.ts` and the affected bot payload tests.
- [ ] **Implement concise existing-surface copy.** Use the approved design's examples. Show the actual action and failed steps with existing case/detection links and repair actions. Do not describe an applied role as proven full isolation. Record and render changed failure details when alert updates coalesce repeated detections.
- [ ] **Run the complete scenario with fakes and the owned database.** Qualifying suspicious detection, general setup errors, attempted configured action, partial failure, durable queue record, inaccessible Discord notification, visible web inbox, and no replay on reconciliation. Also cover successful enforcement and successful notification to detect regressions. Add a focused browser assertion only if a component/layout actually changes.
- [ ] **Update workflow documentation and run required checks.** Use `npm run check:ci` with the worktree's owned test database, application package tests/typecheck, and affected web tests/typecheck. Do not run integration suites concurrently against another worktree's database. Commit `[AGENT] Show incomplete automatic moderation outcomes`.

## Execution and review handoff

Review each task's tests and diff before advancing, especially the role-grant safeguard before gate removal. Search shared callers again after interface or error changes. Use `unslop` on changed product copy and implementation summaries.

Track implementation with a generic GitHub issue and PR under the repository workflow. Do not include private incident identities. Push the final implementation head, complete required checks, and apply the repository's latest-head review sweep if the assignment includes making the PR merge-ready. Merging triggers production deployment, so keep merge/deployment separate from plan approval.

This planning checkpoint runs Markdown formatting and whitespace checks only. Dependencies, test database setup, product tests, and runtime verification begin during implementation. The unresolved lockdown warnings stay outside this change and remain a documented risk.
