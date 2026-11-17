# Task 3 report

Implemented durable restriction audit, frozen-plan and progress stores, native/MCP attempt fencing, immutable versioned acceptance, and existing-snapshot append/outcome ownership.

## Files

- `packages/application/src/operations/restrictionPersistence.ts`: exported `RestrictionAuditStore` and `RestrictionExecutionStore` ports.
- `packages/application/src/postgres/restriction.ts`: `createRestrictionStores(database)` and shared `restrictionActiveFenceSql`.
- `packages/application/src/index.ts`, `packages/application/src/postgres/index.ts`: package exports.
- `packages/application/src/postgres/enqueue.ts`: existing versioned request cannot be reset or have its accepted plan replaced on idempotency conflict.
- `packages/application/src/postgres/delegation.ts`: interrupted versioned audit/apply settlement rotates the restriction attempt token; stale delegated queue admission rejects a replaced token.
- `src/repositories/ModerationActionRequestRepository.ts`: native claim/takeover token rotation, heartbeat/complete/fail token and live-lease guards, immutable restriction metadata namespace.
- `src/services/ModerationActionRequestService.ts`: pass private restriction token through existing worker heartbeat and terminal writes.
- `src/repositories/RoleQuarantineSnapshotRepository.ts`: narrow append and outcome methods.
- `src/__tests__/fakes/moderationActionRequests.ts`, `src/__tests__/fakes/inMemoryRepositories.ts`: request fake parity; snapshot fake explicitly requires the real DB fixture for repair ownership.
- `packages/application/src/operations/restrictionPersistence.test.ts`: stored-shape/binding and invalid revision tests.
- `src/__tests__/integration/RestrictionRepairPersistence.integration.test.ts`: six real DB tests.

## Binding contract for Tasks 4 and 5

Server-owned metadata uses `restriction_schema_version: 1`, `restriction_plan: ApprovedRestrictionPlan`, and `restriction_attempt_token: string`. Existing action types remain `audit_case_role_lockdown` and `apply_case_role_lockdown`. Completed audit result uses `restriction_audit: RestrictionAudit`. Apply results carry `restriction_progress: RestrictionProgress`; terminal dispatch must retain that namespace alongside final verification. Clients must never supply these stored envelopes directly. Admission owns their construction and actor/guild binding.

`createRestrictionStores(database)` returns both stores. Audit loading requires a completed matching audit operation, exact request guild and schema version, and valid versioned audit whose guild matches. Plan loading validates the schema and binds stored actor/guild to request actor/guild. Loading does not enforce expiry, which remains admission/execution responsibility. Progress starts at expected revision zero when absent. Each save requires next revision exactly expected+1, unique receipt effect indices, active processing token, 15-minute lease, applicable apply action, and for MCP a still-open bound execution. CAS prevents competing writes; prior receipts cannot disappear, and applied/failed receipts cannot be rewritten. A loser must reload before deciding whether it can continue. Never replay started/unknown effects.

`getRestrictionAttemptToken(request)` is server-side worker ownership. `restrictionActiveFenceSql` is static SQL with request alias `q` and parameters `$1` request ID and `$2` token. Task 4 must use the progress save/fence before new effects and stop when ownership is lost. Authority rechecking still belongs the executor; this lease is not user authorization.

Snapshot API:

```ts
appendRestrictionRepairRoles({
  caseId: string, caseRevision: number, requestId: string,
  attemptToken: string, userId: string, roleIds: readonly string[],
}): Promise<RoleQuarantineSnapshot | null>
recordRestrictionRepairOutcome({
  snapshotId: string, requestId: string, attemptToken: string,
  roleId: string, state: 'applied' | 'failed' | 'unknown',
}): Promise<RoleQuarantineSnapshot | null>
```

Append locks request, case, then existing snapshots. It requires active apply ownership, the exact pending case revision/member/guild, no existing quarantine attempt, no recorded member-left outcome, and active snapshot state. It refuses policy-managed enabled intake/honeypot roles and competing or unowned previously planned removals. Earlier original/planned/removed roles remain intact. It uses existing snapshot `metadata.restriction_role_owners[roleId] = {requestId, attemptToken, state}` with initial state `started`; this is snapshot ownership, not a separate restoration ledger. New removal acquisition never changes case containment, quarantine attempt, or revision.

Outcome writes require current request ownership and matching per-role ownership. They can record an already-started outcome after case resolution without reopening the case/snapshot. Applied roles append to existing removed roles. Unknown/failed evidence stays in snapshot ownership metadata. Unknown earlier removals remain blocked. A lost lease cannot record outcomes, so Task 4 must preserve its exact local applied effects for existing `restoreMemberRoles(..., appliedEffects)` late-effect reconciliation. This method does not itself restore roles or contact Discord.

MCP recovery hook: `settleMcpQueue` now returns stale versioned audit/apply requests with a rotated token for reconciliation. Task 5 must admit the already-started execution only to the read-only reconciliation path. Existing generic admission may currently observe an already-started execution instead. Task 4 must reconcile started/unknown receipts read-only and stop, never automatically replay a Discord write. Parent explicitly retained this routing work for Task 5.

## TDD and verification

All database commands scoped these identical environment variables per shell command:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55433/drasil_mcp_test?schema=public'
$env:DATABASE_URL=$env:TEST_DATABASE_URL
$env:POSTGRES_DB_URL=$env:TEST_DATABASE_URL
$env:JEST_INTEGRATION='1'
npx jest --runInBand --runTestsByPath src/__tests__/integration/RestrictionRepairPersistence.integration.test.ts
Remove-Item Env:JEST_INTEGRATION
```

Read both integration skill files and `scripts/owned-test-database.js`. Used only the supplied disposable local PostgreSQL database, never dev/prod.

- Initial red: missing `createRestrictionStores` export, TS2305. This failed before fixture setup and is not the behavioral red evidence.
- Behavioral red after successful DB setup: `a later revision cannot erase a durable effect receipt`, expected false, received true. One failed and four passed DB tests. Added the SQL receipt-preservation guard afterward.
- Final green for the command above: one suite, six tests passed in 6.01 seconds. Covers concurrent worker claim/takeover, stale progress/heartbeat/terminal writes, concurrent immutable acceptance, revision CAS, snapshot append and late outcome without reopening, completed audit guild/version validation, and receipt preservation.
- Existing `ActionRequestEnqueue.integration.test.ts`: 74 passed. Run serialized with the new DB suite. An intermediate new acceptance test assumed which concurrent call wins; corrected it to allow either winner and require identical returned stored metadata. No production code change for that correction.
- Existing worker tests: `npx jest --runInBand --runTestsByPath src/__tests__/unit/ModerationActionRequestService.unit.test.ts src/__tests__/unit/ModerationActionRequestDelegation.unit.test.ts`, 149 passed. Expected failure-path console warnings.
- Persistence unit tests: `npm test --workspace @drasil/application -- --runInBand --runTestsByPath src/operations/restrictionPersistence.test.ts`, two passed.
- `npm run lint --workspace @drasil/application`: passed after explicit return types.
- Targeted root ESLint for edited request/snapshot repositories, service, request fake and new DB suite: passed without warnings. The broad initial fake-file check showed two pre-existing unrelated warnings in `inMemoryRepositories.ts`; no unrelated edits.
- `npm run build --workspace @drasil/application`: passed.
- `npx tsc --noEmit -p tsconfig.json`: passed.
- `git diff --check`: passed.

## Self-review and remaining boundaries

Report-ban predicates and transitions remain unchanged; restriction fencing is an additional independent guard. No table, enum, dependency, generic queue, or Discord side effect was added. Protected-role policy remains upstream shared policy/admission responsibility, not an authorization inferred from snapshot append input. The numeric database case revision must be derived from the frozen server-owned case identity.

Skipped live Discord verification and full CI. New restriction MCP settlement was inspected and token-fenced, but a complete already-started MCP execution fixture and routing acceptance belong Task 5. Existing worker/delegation regression tests cover current paths. This intermediate commit must remain staged with the broader feature and must not publish the coarse apply route separately.

Final directly affected package regressions: npm test --workspace @drasil/application -- --runInBand --runTestsByPath src/postgres/enqueue.test.ts src/delegation/execution.test.ts, two suites and 24 tests passed.
