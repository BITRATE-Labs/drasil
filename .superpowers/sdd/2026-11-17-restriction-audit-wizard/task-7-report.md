# Task 7 report

Issue #324 implementation verification and acceptance preparation. Live Discord acceptance is pending separate authorization. This worker performed no push, PR publication, merge, deployment, permission write, synthetic live case, kick, ban or historical replay. Parent owns publication and exact-head hosted CI/review, and published draft PR #329 to start canonical Linux checks while local tests continued.

## Scope and branch reconciliation

Started from db75573. Checkpoint 56921ce added bounded REST admission coverage, automatic result polling coverage, idle review expiry and a feature test formatting correction. Parent refreshed main to fa2516b5349e7a1fcb3af9efc98c00d61e0679b1, including welcome cleanup #323 and the 200-server directory limit #326. Rebased the isolated branch onto that base, producing 8b39ce1f7a0f0c8a7f5308c8b666b09331587303. Rebased Task 6 final is 63e8a78, corresponding to old db75573. Task 7 review begins at 63e8a78, with 8b39ce1 and 6ad2a45af82cee70c8a83199de4c54fc6480c8e8 as initial code checkpoints. Later test-only checkpoints are c54c1f3 for hosted legacy smoke expectations and d4fbe93 for recovery role fixtures. Whole-branch review base is fa2516b.

The sole text conflict was setup/actions.test.ts, where independent tests were appended at the same location. Retained all four welcome-cleanup tests and the category-exception preservation test. Automatic merging duplicated the identical DiscordRole.tags field. Web typecheck caught it; removed only the duplicate. Welcome cleanup controls/settings remain, and the 200-server single-request directory regression remains intact.

## Changes and self-review

- Idle reviews now expire without another browser interaction. Expiry clears approval, disables approval/Apply and asks for a fresh audit. The Apply callback still checks the original deadline independently.
- The result E2E waits for automatic polling after durable synthetic settlement, without a manual reload. Existing queued-request reload coverage remains. Added idle-expiry coverage with the browser clock.
- Added selected REST case revision/persisted-role/join identity, private archived locked thread membership, foreign-thread rejection and missing-join rejection tests. A real REST reader test proves failure on a later membership page rejects incomplete evidence. Small existing builders are reused.
- Completed three feature-cited quarantine repository mocks with update(), and asserted the intentional quarantine-audit failure diagnostic. Other passing suites retain their unrelated expected/baseline error logs.
- Full gates found stale tests for removed dependencies, required repairCaseRoles, selected apply commands, structured preview assessment and integrity findings. Updated those contracts, kept authority and actor assertions, rejected old coarse confirmation with zero queue calls, and replaced coarse receipt snapshots with selected-plan behavioral checks.
- CI metrics rejected five new functions. Extracted specific effect matchers/writers, captured channel/thread checks, page data loading, and queued admission/denial helpers. No threshold or generic registry changed. Shared fence, readFresh and guild fetch still precede writer dispatch. DB connection/execution locks, intent validation, denial terminalization and finish ordering remain in the same transaction. Matching functions use local arrow style so installed Lizard recognizes their actual boundaries.
- Removed IntegrityAuditService's unused legacy lockdown injection after searching every direct constructor caller. Its only restriction source remains the shared audit.
- Updated moderation permissions, case lifecycle, compromised containment and test-case docs. Corrected the old claim that any planned hardening blocks containment. Added a controlled-live checklist with no authorized live effects.

Searched audit_case_role_lockdown/apply_case_role_lockdown callers across bot/application/web. Every write admission uses selected references and server-owned plans. applyGuild has no production method or caller. Remaining test spies explicitly prove old coarse routes cannot write. No dependency or migration was added by Task 7, no source-defined threat indicator was introduced, and no general automatic-moderation readiness gate or protected-role removal was added. The prototype remains outside shipped source.

## Acceptance trace

| Approved acceptance criterion | Implementation owner and evidence |
| --- | --- |
| Feasible ordinary-role combinations, quarantine modes/exemptions/failures | Tasks 1/2; restrictionAssessment, restrictionPolicy, restrictionProposals and RoleQuarantineService tests |
| Actual staff limitation with protected roles retained | Tasks 1/4/5; restrictionPolicy, assessment, concrete repair and containment tests |
| Overrides, owner/admin, inheritance, missing metadata, channel/thread interactions; content unchecked | Tasks 1/2; assessment/collector/read-port tests; Task 7 selected REST boundary tests |
| Inherited grouping, actual versus prospective counts, incomplete coverage | Tasks 2/6; restrictionProposals, audit presentation and adapter tests |
| Defaults, bulk selection, approval reset, nonempty selected effects | Tasks 4/6; restrictionActions, wizard/action tests and workspace restriction E2E |
| Actor/guild/plan substitution, revocation and stale permissions/settings/membership | Tasks 3/4/5/6; actions/execution tests, restriction persistence, MCP operations/config integration and review-reference tests |
| Stop on failure/unknown, no replay, durable ownership and restoration | Tasks 3/4/5; execution, RestrictionRepairPersistence/Restoration integration, MCP interruption tests |
| Separate setup/current-case outcomes, no verification from write success | Tasks 1/4/5/6; concrete adapter read-back, dispatch projections and synthetic interrupted browser results |
| Keyboard/narrow/light/dark/brand and readable review/results | Task 6 workspace E2E and inspected captures; Task 7 rerun also covers polling and expiry |
| Controlled live member access, exceptions, restoration and failure reporting | Pending. Checklist in docs/test-cases.md. Automated/provider-fixture tests are not live proof. |

## Test environment

Sole owned disposable database owner. TEST_DATABASE_URL, DATABASE_URL and POSTGRES_DB_URL were identical to postgresql://postgres:postgres@127.0.0.1:55433/drasil_mcp_test?schema=public. Owned guard ran before destructive fixtures. No dev/prod database was used and no DB suite ran concurrently. Prisma generated from the rebased schema and migrations ran through the owned preparer. All 50 migrations applied, including the two new main-branch welcome-message migrations.

DRASIL_WORKSPACE_PROVIDER_PORT=34569. Existing sandbox provider34568 was left alone. Current-workspace E2E uses the nonlegacy production build and fixture provider. JEST_INTEGRATION and DRASIL_LEGACY_TEST_BUILD were absent from unrelated command groups; their owning runners set them where required. Scoped npm_config_script_shell=C:/Program Files/Git/bin/bash.exe supports existing POSIX npm commands on Windows, without changing CI scripts. Legacy/browser acceptance uses its separate configuration/build.

## Commands and results

Initial npm run check:ci halted at feature formatting. After rebase, formatting caught the additive conflict whitespace. The final full invocation passed format, runner checks, application lint/typecheck/coverage, action-boundary and root lint, then found seven stale root test suites. It is not a passing full check:ci result. Remaining groups were continued after focused fixes rather than repeating unchanged stages. Full logs are ignored task-7-*.log files beside this report.

- application coverage: 52 suites, 738 tests passed. Application tests reran after measured extraction; build, lint and types passed.
- root full run: 119 suites passed, seven stale feature suites failed. Affected nine-suite coverage totals 370 passing tests across corrected focused runs, plus post-extraction concrete adapter/audit/dispatch69 and integrity-cleanup16.
- action boundary: 17 checks passed; all 55 stored kinds retain codecs, handlers and caller coverage.
- contracts lint/typecheck/coverage passed. Web lint and typecheck passed after duplicate-field correction.
- full web unit run: 122 of 124 files passed; stale operation tests and one loaded transport-import timeout failed. Corrected focused18 passed in 730ms. No timeout changed.
- Docker production package smoke passed before and after the measured source cleanup. A task-specific local image was built; no existing container changed.
- Installed scc/Lizard metrics passed via Git Bash after specific extraction.
- Full web coverage passed all 124 files and 1,239 tests. Production web build, MCP packaging and production dependency graph checks passed.
- Current-workspace100 run: 91 passed, nine failed. Eight failed only because corresponding Windows screenshot baselines do not exist; preceding layout/accessibility assertions passed. No Linux baseline changed. The new idle-expiry test had a strict alert selector matching Next's route announcer; scoping the selector fixed it. Focused restriction E2E then passed all nine in 9.4 seconds, including automatic polling and expiry. Generated Win32 baselines were removed.
- Root database integration: full run passed 34 suites and 764 tests, with one compile failure in a stale runtime dependency fixture. Corrected ReportBanRecovery then passed 173 of 180, exposing seven old role fixtures missing bitfields and bot hierarchy. Those races never reached their removal barrier. Reused the existing small role builder, completed hierarchy facts and made premature completion fail the barrier promptly. Focused seven passed in 8.756s; shared-builder adapter unit eight passed. Cumulative all 35 suites and 944 DB tests passed without timeout changes.
- Web integration: six files, 89 tests passed.
- Existing node scripts/run-mcp-e2e.js exited before tests on Windows. Credential-free spawnSync npm probe returned status null and ENOENT. Used the exact same three specs and controlled environment through working npm/Git Bash, without changing the runner or reducing coverage. All 13 tests passed in 1.8 minutes.
- Owned RLS check passed all 45 checked tables.
- npm run ci:browsers:prepared ran with all DB/JEST/MCP/legacy overrides removed and NODE_ENV=test. Storybook build passed. Legacy browser smoke passed nine tests with 13 intentionally skipped MCP/fixture-disabled tests, which the separate MCP group had already exercised.
- Local legacy visual: all eight tests failed against obsolete Win32 baselines. Inspected unchanged landing actual/expected: current main has Shared protection and Foundation, whereas the Win32 baseline still has Review scams and the older layout. No unrelated Windows baseline was accepted.
- Canonical hosted Linux run 44077129251 at c54c1f3 passed the smoke correction and exposed only Setup/Operations light/dark screenshot changes. Parent reviewed Setup dark actual/diff and Operations dark/light actual. This worker reviewed Setup light actual/diff and Operations light diff. Changes start at the approved restriction settings/audit CTA; welcome cleanup remains present and later content shifts with section height. Copied only these four reviewed Linux actuals into their existing baseline paths in commit 38dc8e7857d76bb11436685b3ab118ea2ab1ffc7. No threshold changed. Final hosted rerun remains parent-owned.
- Storybook visual initially could not bind port6006. Its existing Storybook dispatcher PID108800, parent134416, was identified and left untouched. Existing PLAYWRIGHT_STORYBOOK_PORT=6007 and PLAYWRIGHT_REUSE_STORYBOOK_SERVER=false select a verified free route. The group finished with 167 passing tests and four Windows visual failures. Three existing CaseHistory/MemberProfile baselines differ; the fourth lacks Turnstile Win32 baselines. Those component/story sources are unchanged from main. Actual/diff evidence remains in apps/web/storybook-test-results. Removed the two newly generated Win32 files instead of accepting them. Owned port6007 stopped at completion; no new product setting was added.

## Final cleanup and review boundaries

Restored only the Next-generated next-env.d.ts/tsconfig.json test-mode rewrites. Removed only generated, untracked Windows baselines, preserving actual/diff evidence. No production source changed after 6ad2a45; later commits are test fixtures, reviewed Linux snapshots and documentation. Final npm run web:typecheck, npm run web:lint, npm run format:check and git diff --check passed.

Local visual gates are not reported as passing. Canonical Linux snapshot changes were reviewed and committed, but parent must obtain terminal checks for the final pushed head. No threshold was relaxed, no stale Windows baseline was silently accepted and no live acceptance was substituted with synthetic tests.

Important logs beside this report: task-7-check-ci-final.log, task-7-after-refactor.log, task-7-database.log, task-7-wizard-e2e.log, task-7-root-integration.log, task-7-recovery-integration.log, task-7-recovery-focused.log, task-7-web-integration.log, task-7-mcp-e2e-windows.log, task-7-rls.log, task-7-isolated-browsers.log, task-7-storybook-visual-6007.log, task-7-package-final.log and task-7-metrics-final.log. Final formatting/types/lint use task-7-final-*.log.

## Pending live acceptance and delivery

Follow docs/test-cases.md's controlled acceptance checklist. Keep actual server/account identities in private operator evidence. Begin read-only, then separately authorize any synthetic case and exact permission/role effects. Verify own-thread access from a signed-in restricted member, excluded channels, read-only exception limits, protected roles, selected current-case repair, normal role restoration and truthful failed/unknown outcomes. Recovery-parent content needs its own authorized inspection.

Local tests establish implementation behavior. Deployment would establish rollout only. Neither proves live restricted-member access or unread-content isolation. No live acceptance, production changes, automatic rollback/retry or replay was attempted. Parent must push the exact final head, wait for terminal hosted checks, inspect comments/inline threads/formal reviews/sticky summaries, resolve valid feedback, and perform a delayed final sweep before declaring merge-ready. Merge remains separately unauthorized.

Visual evidence: focused chooser/review/results captures are retained under task-7-browser-artifacts in this ignored SDD directory. Inspected the narrow dark chooser and the original expired-review capture, which showed disabled approval and Apply. Broad missing-baseline evidence remains in apps/web/workspace-test-results. Hosted isolated-browser logs also exposed two stale legacy smoke expectations. The separate test-only fix checks current exception controls and canonical wizard links, proves old coarse controls absent, and retains unrelated maintenance checks. No fake legacy wizard was added.

No supported local Linux visual runner was found in repository docs/scripts/configs; hosted Ubuntu CI is the existing canonical route.

Live member access, deployed runtime and recovery-parent content are UNKNOWN. No live acceptance or deployment was performed.

PR draft: task-7-pr-body.md, sanitized and not posted by this worker.
