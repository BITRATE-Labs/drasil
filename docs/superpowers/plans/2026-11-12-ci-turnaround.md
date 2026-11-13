# CI turnaround implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Reduce complete PR CI from the observed 22-25 minutes toward 10-12 minutes while retaining all checks and staying within 25 percent growth in execution-job minutes.

**Architecture:** First establish explicit preparation and reusable npm check groups, with the local entry point running them sequentially. Then run four independent execution jobs behind the existing `build-test` aggregate. All storage consumers remain sequential in one disposable Postgres job.

**Tech Stack:** Node 24, npm workspaces, Jest, Vitest, Playwright, Postgres 16, GitHub Actions, existing dependencies only.

**Spec:** [Approved CI design](../specs/2026-11-12-ci-turnaround-design.md).

## Outcome and review decisions

The user approved one PR containing both stages and a 25 percent cost review threshold. This plan translates that design into three deliverables: remove duplicate work, split the workflow, and verify the measured result. Keep the first two in separate implementation commits so parallelization can be reverted independently.

Recommend native execution in this chat, followed by an independent whole-branch review. These tasks share npm orchestration and workflow interfaces, so separate implementers would add coordination without much useful concurrency. Execution method remains for the user to select at plan review.

## Global constraints

- Use Node 24 on Ubuntu 24.04 for all four execution jobs.
- Keep the exact `build-test` check name and require every execution group to succeed.
- Preserve all existing test cases, assertions, coverage thresholds, screenshots, security checks and production packaging checks.
- Keep database consumers sequential and retain one worker for their browser suites.
- Require identical `TEST_DATABASE_URL`, `DATABASE_URL` and `POSTGRES_DB_URL`; retain owned loopback `55433/drasil_mcp_test` locally and `5432/drasil_test` in CI.
- No dependency additions, cross-job build artifact transport or general-purpose task scheduler.
- Retain production workspace acceptance and the separate legacy fixture server configuration.
- Do not merge or deploy. Existing deployment workflows and environment gates retain their current behavior.
- Treat more than 25 percent growth in summed execution-job minutes as requiring revision or renewed user judgment. Aim for 10-12 minutes excluding queue delays and deployment.

## Review focus

1. A missing, skipped, cancelled or failed execution job must prevent a green aggregate. Task 2 tests every result class.
2. Standalone integration invocation on an empty owned database must prepare it; a rejected target must stop before subprocesses or fixtures. Task 1 covers both paths.
3. Suppressing npm lifecycle hooks must not suppress installation scripts or omit compiled prerequisites. Task 1 checks clean installation, prepared orchestration and standalone commands.
4. Moving web coverage or browser suites must not silently skip database-backed or enabled MCP cases. Tasks 1 and 3 compare execution counts and intended skips.
5. Two jobs must not share mutable database fixtures, build directories or artifact names. Tasks 2 and 3 inspect ownership and the hosted run.

## File map

| File                                                                                                          | Responsibility                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `package.json`                                                                                                | Sequential local orchestration and prepared CI group scripts                                |
| `scripts/run-integration-tests.js`                                                                            | Guarded standalone preparation and explicit prepared invocation                             |
| `scripts/run-integration-tests.test.js`                                                                       | Preparation, guard, argument and subprocess failure contracts                               |
| `src/__tests__/setup.ts`                                                                                      | Per-test truncation and per-suite connection cleanup only                                   |
| `src/__tests__/testDb.ts`                                                                                     | Retain fixture/pool helpers; remove migration/extension helpers after their callers migrate |
| `scripts/check-ci-results.mjs`                                                                                | Validate the aggregate's four prerequisite results using Node built-ins                     |
| `scripts/check-ci-results.test.mjs`                                                                           | Aggregate success and negative result cases                                                 |
| `.github/workflows/ci.yml`                                                                                    | Four execution jobs, aggregate, named steps and distinct artifacts                          |
| `docs/dev/pr-workflow.md`, `docs/dev/mcp-client-compatibility.md`, `docs/dev/action-boundary.md`, `AGENTS.md` | Correct descriptions of preparation and CI execution where affected                         |
| `docs/superpowers/specs/2026-11-12-ci-turnaround-design.md`                                                   | Record design approval and the accepted cost threshold                                      |
| `docs/superpowers/plans/2026-11-12-ci-turnaround.md`                                                          | Track execution and measured results                                                        |

Root npm scripts are sufficient for the split; avoid changing `apps/web/package.json` unless verification reveals a nested lifecycle behavior that cannot be scoped from the root invocation. Preserve `scripts/run-mcp-e2e.js`, the Dockerfile, test fixtures and Playwright worker counts.

## Task 1: remove repeated work in the serial gate

**Interfaces:** Preserve `npm run check:ci` as complete local orchestration. Add `ci:static:prepared`, `ci:database:prepared`, `ci:browsers:prepared` and `ci:prepared` root scripts. These require compiled application and bot output. `ci:prepared` runs the three groups sequentially. Direct integration invocation remains self-preparing; `node scripts/run-integration-tests.js --prepared` is reserved for the sequence that has already prepared the database and generated client. It always validates the owned target.

- [ ] Read the spec, relevant local guidance and current branch status. Create a scoped GitHub issue through the discovered GitHub write route before implementation. Describe the retained checks and approved cost boundary without private environment names.
- [ ] Capture the original `check:ci` command list and Docker smoke commands as a review checklist. Fetch main and confirm no intervening changes alter these interfaces before editing.
- [ ] Add focused runner tests using Node's existing test framework. Intercept child-process calls within the test process rather than connecting to a database. Assert that an unowned or mismatched target produces zero subprocess calls; normal invocation generates the client, prepares storage and launches Jest in that order; `--prepared` still validates ownership but launches only Jest; unknown arguments fail; any failed preparation/generation stops before Jest and returns failure. Restore environment, process arguments and mocks between cases.
- [ ] Run `node --test scripts/run-integration-tests.test.js` and confirm the new contract tests fail for the missing preparation/prepared behavior.
- [ ] Update `run-integration-tests.js` to accept only no arguments or `--prepared`. Always run `ownedTestDatabase()` first. In the ordinary path, retain generation and execute `prepare-test-database.js` with `process.execPath` before Jest. In the prepared path, skip only those explicit prerequisites. Preserve `JEST_INTEGRATION=1`, test URL propagation, inherited output and nonzero/null subprocess exit handling. Do not use an environment flag to bypass preparation.
- [ ] Remove extension/migration setup from `setup.ts`. Search every caller of `runMigrations` and `ensureExtensions`, then remove those helpers and unused imports from `testDb.ts` once no callers remain. Keep truncation, ownership checks and disconnect behavior intact.
- [ ] Define the group scripts below. Change `check:ci` to explicitly build the application and bot once, then invoke `ci:prepared` with npm lifecycle hooks disabled for that prepared sequence only. Leave ordinary standalone command hooks and `npm ci` untouched. Verify npm's inherited configuration actually suppresses nested pre-hooks.

| Script                 | Existing checks, in execution order                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci:static:prepared`   | Format; application lint/typecheck/coverage; action boundary; root lint/unit tests; contracts lint/typecheck/coverage; web lint/typecheck; runner and aggregate helper tests when added                                                 |
| `ci:database:prepared` | Owned-target guard tests and database preparation; web coverage; production web build; packaging and graph checks; workspace browser suite; prepared bot integration runner; web integration; `node scripts/run-mcp-e2e.js`; RLS checks |
| `ci:browsers:prepared` | Storybook production build; legacy browser suite; legacy visual suite; Storybook browser/visual suite                                                                                                                                   |

- [ ] Install this worktree's dependencies with `npm ci`. Run the focused runner/owned-target tests, root format/lint/build/unit checks and standalone application/web command smoke checks. Do not share another worktree's `node_modules`.
- [ ] Provision or claim an unused owned disposable Postgres 16 target. Check for other users before binding local port 55433. Run standalone integration against the empty target and confirm preparation succeeds before tests, all cases execute, and truncation still isolates cases. Verify rejected URL cases make no database connection. Do not use the development Supabase target.
- [ ] Run the complete serial `npm run check:ci` with identical owned URLs. Confirm one application build, one bot build and one database migration preparation in its log. Compare test counts, screenshots and intentional skips with the baseline checklist.
- [ ] Update affected preparation docs and mark the approved design/cost threshold as accepted. Apply unslop, formatting and `git diff --check`.
- [ ] Commit the cleanup. Open the PR linked to the issue and run hosted cleanup-only CI before adding the workflow split. Record job/step timestamps and summed execution minutes. Keep this measurement revision available in Git history.

## Task 2: split execution and preserve the required gate

**Interfaces:** Execution job IDs are `static-unit`, `database-acceptance`, `isolated-browsers` and `package-smoke`. The aggregate job ID/name remains `build-test`. Add `assertCiResults(results)` in `scripts/check-ci-results.mjs`: it returns normally only when all four named prerequisite objects have `result === 'success'`, otherwise throws. The CLI reads JSON from `CI_RESULTS` and exits nonzero for invalid/missing input or any unacceptable result. It imports no external packages.

- [ ] Add `check-ci-results.test.mjs`. Assert all-success returns normally. For each required job, assert missing, `failure`, `cancelled`, `skipped` and `in_progress` throw. Assert empty/malformed input throws. Run `node --test scripts/check-ci-results.test.mjs` and confirm failure before implementation.
- [ ] Implement the result assertion and CLI with Node built-ins. Run focused tests and include both new helper test files in the static group. This checks gate behavior, not a duplicate assertion of workflow text.
- [ ] Replace the old execution job with the four jobs below. Use explicit named setup and group steps. No execution job depends on another execution job. Keep `NODE_ENV=test` where previously required.

| Job                   | Bootstrap                                                                                                                                            | Services and execution                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `static-unit`         | Checkout, Node 24/npm cache, `npm ci`, application and bot build once                                                                                | No Postgres/browser installation; run `ci:static:prepared` with lifecycle hooks disabled       |
| `database-acceptance` | Existing Postgres service/URLs, checkout, Node/npm cache, `npm ci`, existing mirror/browser/Postgres readiness steps, application and bot build once | Run `ci:database:prepared` with lifecycle hooks disabled; all database consumers sequential    |
| `isolated-browsers`   | Checkout, Node/npm cache, `npm ci`, existing mirror/browser installation, application build once                                                     | No database URLs or Postgres service; run `ci:browsers:prepared` with lifecycle hooks disabled |
| `package-smoke`       | Checkout                                                                                                                                             | Existing Docker build and application import smoke, with build/install inside Docker unchanged |

- [ ] Add `build-test` with `needs` listing all four jobs and `if: always()`. Checkout and use Node 24 without dependency installation. Run the aggregate helper with `CI_RESULTS` set to `${{ toJSON(needs) }}`. Preserve existing snapshot-preview and web deployment dependencies on `build-test`; metrics remains separate.
- [ ] Preserve screenshot-difference logging in the database browser job and failure artifacts in both browser jobs. Use distinct artifact names, and collect the same relevant report/result directories as before. Keep snapshot-preview commenting unchanged.
- [ ] Lint the workflow with the discovered available actionlint/shellcheck route. Run helper tests, format checks and `git diff --check`. Inspect the original command checklist against all group scripts so no checks disappeared or moved into a skipped invocation.
- [ ] Commit the workflow split, push it to the same PR and run full hosted CI. Keep the two implementation commits separate.

## Task 3: prove the benefit and complete review

**Interfaces:** Use successful hosted run/job/step timestamps, exact head SHA, execution counts and existing PR feedback surfaces. No new monitoring service or benchmark dependency is needed.

- [ ] Build a compact comparison of original baseline, cleanup-only and final split. Report time to the complete gate, time including metrics, queue delay separately where available, per-job duration and summed execution-job minutes. Include Docker smoke in both old and new execution totals; separate the new aggregate's overhead. Metrics and deployment are outside the execution-cost comparison and must be labeled.
- [ ] Confirm a clean hosted installation produced all required outputs. Inspect database and browser test totals and reasons for skips. Verify enabled MCP cases ran in the database job, web coverage exercised its database-backed cases, screenshots were checked and no shared service/port/artifact collision occurred.
- [ ] If time exceeds 12 minutes, identify the longest remaining stage and investigate before declaring completion. If summed execution minutes exceed 125 percent of the comparable baseline, revise the split or return to the user with the measured tradeoff. Do not remove checks to meet either target.
- [ ] Only if Storybook remains worth optimizing, compare one versus two workers on the same code. Keep two only with a worthwhile time reduction, unchanged execution and screenshots, no observed instability, and the approved cost limit. Otherwise retain one; no benchmark is required if it cannot shorten the critical path materially.
- [ ] Request an independent whole-branch code review using the relevant review skill. Fix validated findings and rerun affected checks. No production changes.
- [ ] Wait for the latest pushed head's checks to finish, allow the delayed review window, then refresh required/informational checks, ordinary comments, formal reviews, inline threads and mutable reviewer summaries. Address valid feedback, reply/resolve handled threads and repeat after fixes.
- [ ] Record measured results in this plan's evidence section and report the final head/readiness. Stop before merge or deploy. Remove only task-owned disposable resources after confirming they are unused.

## Evidence and execution status

- Approved design commit: `35b1ad6`.
- User approved the design and 25 percent runner-minute threshold before this plan was written.
- Source and historical run references are in the design's evidence appendix.
- Cleanup implementation: `6ed95b6847ce95423373721aaef9e22d376bdcee`. [Cleanup-only CI](https://github.com/BITRATE-Labs/drasil/actions/runs/43344172909) passed, with 17m28s for build-test and 13m48s for its quality gate. Its quality-gate log contains one application build, one bot build and one migration preparation; the separate Docker smoke retains its own clean build.
- Local checks passed: 119 bot unit suites / 2,331 tests / 96 snapshots; 46 application suites / 648 tests; 32 standalone Postgres suites / 891 tests on fresh owned storage; 63 contracts tests; root build, action boundary and lint; contracts/web lint and typechecking. The application Jest configuration has an unchanged Windows path-matching limitation; local coverage passed with an explicit testMatch override. The complete hosted Linux chain passed.
- Workflow split: `53262d459082d5e887713b076ae3a050da85a271`. Independent whole-branch source review found no actionable findings; 21 helper/guard tests and actionlint passed. A subsequent one-line fix restores explicit local Prisma generation before compilation in check:ci.
- Final split timing, cost comparison and latest-head review sweep remain pending. Their receipt will be posted on PR #315 so recording a completed hosted measurement does not itself create another source revision requiring a new timing run.
