# Task 6 report

Implemented the compact restriction wizard for issue #324 at `/admin/guild/[guildId]/operations/restrictions`. Operations and restriction settings lead to this route. The route loads the latest durable audit, or lets an administrator queue a read-only audit on the same screen. Choose, review, explicit approval/apply and results reuse the existing queue and request poller.

## Binding contract and interfaces

- `createRestrictionAuditDataAdapter()` exposes `queueAudit`, `readAudit` (with diagnostic offset), `prepareSelection`, `queueApply` and `readApply`. Every call checks the existing live OAuth identity and selected-guild staff-session boundary, then requires owner/Administrator authority. Reads remain guild-bound. No private fact snapshot or worker token reaches the browser.
- `prepareSelection` calls the real `prepareRestrictionPlan`. Its opaque encrypted review reference contains only purpose, selection references, actor/guild, original expiry, a random stable submission ID and the SHA-256 digest of canonical admitted effects plus material fingerprint. It does not contain the full plan or effects. Cosmetic names are outside the digest.
- `queueApply` verifies the reference against the current authenticated actor/guild and original expiry, re-admits the references, compares the material digest and expiry, and invokes the existing queue helper. That helper independently prepares and persists the server-owned accepted plan. Repeating the same reference retains the same request identity/idempotency key. No client effects, actor, counts, metadata or tokens are accepted as approval facts.
- Native server actions return narrow safe error outcomes because production Next server actions intentionally obscure thrown error text. Stale permissions/settings clear review and approval and require a fresh audit/review. Diagnostic read failures also use this boundary.
- Audit pages use `projectRestrictionAudit`, preserving the full fix manifest on every diagnostic page. A small server-side presenter converts typed effects into named permission/policy/member sentences using installed Discord API permission constants. It includes all grouped effects, actual category child scope, current/future role impact and role-restoration behavior. Selected member names come from existing guild-bound case/user records, with identity fallback.
- Apply results retain authoritative per-effect receipts and distinguish setup verification from current cases. Completed requests alone do not render Verified. Parent-message content remains explicitly unchecked.
- `RestrictionAuditWizard` consumes authorized DTOs and review/apply callbacks. `RestrictionActionResult<T>` adds safe recoverable errors; optional effect descriptions name authoritative apply receipts. The optional initial review prop is only used by the small story set, not by the production route.
- Choices persist in session storage per guild/audit revision. Approval and the review reference do not persist. Selection changes, bulk controls, edit-selection navigation, fresh audit and reload require approval again.
- Channel exceptions stay read-only. Setup no longer renders category-addition controls and ignores submitted category fields entirely, preserving stored category-derived exceptions without a read/overwrite race. Existing broader non-web configuration interfaces were not expanded or redesigned.
- No new dependency, theme, queue, framework, live Discord action, deployment or external post was added.

## Red and green evidence

Initial component red command:

`npm run web:test -- components/operations/RestrictionAuditWizard.test.tsx`

Failed because the wizard module did not yet exist. The analogous adapter red command failed because `restrictionAuditDataAdapter` did not exist. Browser red later demonstrated two actual issues: sticky footer overlap at all four viewport/theme combinations, and production-obscured stale-state exceptions. The footer now occupies its own persistent layout row outside the scrollable main region, and actions return explicit safe errors.

Final focused command:

`npm run web:test -- components/operations/RestrictionAuditWizard.test.tsx lib/restrictionAuditDataAdapter.test.ts lib/restrictionAuditPresentation.test.ts 'app/admin/guild/[guildId]/operations/restrictions/actions.test.ts' 'app/admin/guild/[guildId]/setup/actions.test.ts'`

Five files, 24 tests passed. Covers real server admission/re-admission, effect injection rejection, actor/guild/expiry/tamper binding, stable duplicate submission identity, stale facts, authorization before snapshot reads, later diagnostic pages retaining every fix, named overwrite/grouped policy-member copy, empty/healthy/loading/interrupted rendering, safe action errors and preserved category exceptions. `vitest.config.ts` now includes `.test.tsx` so the prescribed component tests actually run.

`npm run web:typecheck` passed. Touched-file ESLint and `git diff --check` passed. The final non-legacy `npm --workspace apps/web run build` passed, including the new route. Earlier build failures caught a misplaced server directive and an unnecessarily broad bot-client import; the directive was corrected and the presenter uses the already installed lightweight `discord-api-types/v10` constants.

E2E collection:

`npm --workspace apps/web exec -- playwright test --config playwright.workspace.config.ts restriction-audit.spec.ts --list`

The new file is explicitly included in the current workspace config and excluded from the legacy config. Initial collection showed seven tests; the final file contains eight after adding all-selection admission/navigation coverage.

Final browser command:

`npm --workspace apps/web exec -- playwright test --config playwright.workspace.config.ts restriction-audit.spec.ts`

Eight passed in 8.5 seconds against the exact final non-legacy build. Coverage includes signed-out deep-link return, insufficient authority, keyboard selection, Select all/Clear all, mandatory approval, approval reset on edits/reload, durable request reload, persisted selected-plan metadata, stale settings with zero queued apply requests, synthetic interrupted applied/unknown receipts, setup/current-case distinction, all three automatic proposals admitted together, and 390px/1280px dark/light footer clearance with no horizontal overflow.

The shared chooser/story/E2E fixture uses a real Restricted-role overwrite correction for the configured `#rules (read-only)` exception, optional current-member role repair and optional hardening. The interrupted-result fixture is attached to an actually reviewed two-effect request before synthetic durable results are injected. This is controlled presentation/queue evidence, not live-provider execution proof.

## Owned test environment and harness seam

Read both integration skill files and `scripts/owned-test-database.js`. All database variables were identical:

`postgresql://postgres:postgres@127.0.0.1:55433/drasil_mcp_test?schema=public`

`TEST_DATABASE_URL`, `DATABASE_URL` and `POSTGRES_DB_URL` were set to that value, and the owned database guard ran before browser execution. `DRASIL_WEB_DATABASE_URL` used the same value for build/runtime. `JEST_INTEGRATION` was not set for web unit/build/E2E commands. No concurrent database test ran.

Built with `DRASIL_LEGACY_TEST_BUILD=false`, fixture mode false, owned workspace session/OAuth secrets, controlled provider credentials, app URL `http://127.0.0.1:3002` and controlled Discord API URL `http://127.0.0.1:34569`.

Port 34568 was occupied by an existing sandbox process: PID 46460, parent 132480, `node scripts/sandbox.js web`. Read-only identity inspection established that it was not this task's test helper. It was left running. A narrow test-only `DRASIL_WORKSPACE_PROVIDER_PORT` override now exists in the existing workspace fixture/config; default remains 34568, this run used 34569. Task 7 should retain that override if the sandbox still owns the default port. No product runtime setting was added.

One final test attempt accidentally lacked worktree write escalation, so its application prebuild failed with EPERM. It did not run the tests. The same focused command was rerun with scoped escalation and passed all 24. No approval-review rejection occurred.

## Visual evidence

All paths below are relative to:

`D:/bench/drasil-wt/restriction-audit-wizard-design/apps/web/workspace-test-results/`

- `restriction-audit-chooser-390px-dark-keeps-footer-clear/chooser-390-dark.png`
- `restriction-audit-chooser-390px-dark-keeps-footer-clear/footer-390-dark.png`
- `restriction-audit-chooser-390px-light-keeps-footer-clear/chooser-390-light.png`
- `restriction-audit-chooser-390px-light-keeps-footer-clear/footer-390-light.png`
- `restriction-audit-chooser-1280px-dark-keeps-footer-clear/chooser-1280-dark.png`
- `restriction-audit-chooser-1280px-dark-keeps-footer-clear/footer-1280-dark.png`
- `restriction-audit-chooser-1280px-light-keeps-footer-clear/chooser-1280-light.png`
- `restriction-audit-chooser-1280px-light-keeps-footer-clear/footer-1280-light.png`
- `restriction-audit-keyboard-06326-recover-interrupted-results/review-desktop.png`
- `restriction-audit-keyboard-06326-recover-interrupted-results/interrupted-results.png`

Top-of-chooser captures are separate from scrolled footer-clearance captures. Inspected the narrow dark chooser, desktop review and interrupted result images. Parent also inspected the corrected role/channel/policy captures. The final run refreshed these after removing the redundant scope-count wording and correcting singular case copy.

## Self-review and limits

The review token and accepted queued plan preserve the original audit expiry. Server facts and trusted plans remain server-owned. Live authority and material-state admission remain mandatory even after the browser has approved. Native checkboxes/disclosures and Foundation focus/theme/typography/tree asset are reused. Protected/manual/unknown items remain a closed attention disclosure. The rejected explanatory block was not restored.

Full repository CI, broader regression/integration coverage, PR review loops and live Discord acceptance remain Task 7. Story files were typechecked but no separate Storybook build was run. Browser results use synthetic worker settlement and cannot prove live Discord permission writes or information isolation. Existing category exceptions remain editable through previously shipped non-web interfaces; this task prevents new category additions in this web settings/wizard flow only. No blocking implementation concern remains from the focused Task 6 checks.
