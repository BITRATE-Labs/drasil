---
name: local-bot-testing
description: Use when reproducing or testing Drasil behavior with a locally running development bot, or before shipping diagnostic changes just to obtain a deployed reproduction.
compatibility: opencode
---

# Local bot testing

Use a local dev bot for real Discord behavior, then retest changes without a deployment. Focused offline tests and provider fixtures can narrow a failure, but do not establish Discord acceptance.

## Choose the test

Record the worktree, source commit and relevant diff, expected behavior, synthetic fixture, allowed effects, provider attempt allowance and stopping point. Preserve unrelated changes. Read `AGENTS.local.md` when present and follow [worktree setup](../../../docs/dev/worktrees.md).

Run the relevant existing unit test first. If persistence matters, use the [integration skill](../testing-integration/SKILL.md) and the current disposable-target guard in `src/__tests__/testDb.ts`. Integration tests migrate and truncate; keep their database and admin connection separate from the dev bot's DB. A local Supabase address is not proof it is disposable. Do not reset the dev database as routine test preparation.

Read-only inspection and offline tests are autonomous within assigned work. Retain existing authorization for a bounded live run across ordinary restarts. Before live execution, obtain any missing authorization for its concrete target, fixture, effects and provider allowance. New apps/tokens, shared-service interruptions, extra paid requests, production changes and moderation need their own scope. Starting the bot already starts workers and can cause effects.

## Prove isolation before login

Complete this private preflight record. A secret name, display name or `NODE_ENV=development` does not prove identity.

| Identity           | Required evidence                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Source             | Worktree, commit/diff, installed dependencies and generated-client readiness                                          |
| Effective config   | Selected env file plus inherited variables; dotenv leaves existing variables in place                                 |
| App/bot            | Authorized authenticated Discord read establishes immutable IDs; distinct from deployed app                           |
| Guilds             | Complete dev bot guild membership, selected test guild and permission checks; settle unexpected guilds before startup |
| Channels and roles | Fresh dev fixture channels/roles; deployed bot cannot act on ordinary fixture messages                                |
| DB                 | Actual SQL server/database/schema, migration state, configured guild IDs, pending jobs and exclusive owner            |
| Processes          | Owned local watcher/child identity and remote-owner confirmation that no other instance consumes this dev app or DB   |
| Provider           | Intended project/key source, effective endpoint/model/options, approved attempts and unknown prior outcomes           |

Reuse the documented `drasil/dev` credential route only after proving it belongs to the selected dev identity. `npm run dev:env` writes `.env` and overwrites any existing file. Preserve and explicitly select existing configuration before hydration; never print or commit credential values. If no suitable dev identity can be verified, report what is missing before proposing app creation or a same-token handover.

A different bot in a shared channel can still react to the same message. Isolate the fixture with channel permissions or a dedicated test guild. Do not copy deployed channel configuration, production DB contents, report IDs or persisted custom IDs into the local fixture. Store IDs and operational receipts in the already ignored `.debug/local-bot-testing/<run-id>/` directory or outside the checkout. Verify the selected destination is private and ignored before writing.

Inspect current `Bot`, ready handler and worker startup. Global command registration affects the selected app. Action, report analysis, CAPTCHA, queue, reminder and reconciliation workers can act before the test interaction. Check due/processing jobs before enabling features. Detection test mode changes accounting, not side effects. Do not infer a guild sandbox from an undocumented environment flag.

### Read-only setup recipes

After the corresponding authenticated reads are authorized, use the selected Discord REST credential for `GET /users/@me` and `GET /oauth2/applications/@me`. Retain only immutable user/app IDs and the bot flag. Inventory `GET /users/@me/guilds?limit=200` with successive `after` cursors until exhausted, then compare the complete ID set. Never place the authorization header or raw response in a receipt. Record a failed operation before choosing another route.

Through the approved local DB client, run these reads against the selected connection without printing its URL:

```sql
SELECT current_database(), current_schema(), inet_server_addr(), inet_server_port();
SELECT guild_id, is_active FROM servers;
SELECT status, count(*) FROM moderation_action_requests GROUP BY status;
SELECT status, count(*) FROM captcha_challenges GROUP BY status;
SELECT status, count(*), count(*) FILTER (WHERE analysis_due_at <= now()) AS due,
       count(*) FILTER (WHERE analysis_lease_until > now()) AS leased
FROM report_intakes GROUP BY status;
```

These counts identify work to inspect, not proof that every worker is idle. Review current queue/reminder/reconciliation source and the selected records privately before startup. Do not export report contents. For container preparation, `docker build -t drasil-local-test .` builds the existing image without starting the bot. Select a Docker-supported route to the verified host DB; record that address and SQL identity in the private run inputs rather than assuming container loopback reaches the host.

## Start and test

After preflight and authorization, use `npm run dev` in an owned interactive session. This selects `src/dev.ts`, initializes local diagnostic capture, disables remote Langfuse/PostHog export, then imports the existing bootstrap. It is a real bot, not a dry-run or an automatic identity check. To test an explicitly approved remote exporter configuration, use the normal `npm start` entry instead; `npm run dev` deliberately overrides inherited export settings.

Record the watcher and child PID/start time. Wait for login, configuration, command registration and relevant workers, not just the generic startup line. Verify the selected guild setup and pending work before the fixture action.

Create one fresh synthetic fixture using existing helpers. Use dev-app-owned messages/components. For staged report tests, confirm both staged intake and evidence analysis are enabled locally, reporter and target IDs differ, and source/image limits permit the fixture. State the expected candidate and directory coverage. A moderator fallback does not count as successful matching. Stop at the agreed boundary before confirmation, submission or moderation.

Observe the Discord result and JSON lines with `event=local_observation`. Records include process and trace/span correlation, elapsed time, selected provider metadata and usage counts. Raw evidence and model output are excluded from these records. Ordinary console logs are separate and may contain private content; review them before sharing.

An incomplete response with `max_output_tokens`, empty output and zero reported usage proves the reported response shape, not actual token consumption or a need to increase the cap. Match the tested source's prompt/schema/options before drawing a provider conclusion. An unknown or timed-out attempt is not free and does not authorize another request. One Discord action can cause multiple model calls; inspect actual worker allowances and pending work.

## Edit and retest

Let active work finish or reconcile its outcome before editing. Node watch restarts on source changes; record the new child identity and source diff. Reuse the approved allowance, and stop when exhausted. Use a fresh intake rather than erasing attempts or evidence on an old one.

Explicitly restart after env changes and repeat config/identity checks. Prepare dependencies, migrations and generated clients when the change requires them. Avoid restarting during moderation actions.

For a provider-only question, `GPTService.extractReportIdentityFixture` shares the live extractor without logging into Discord or needing a DB. The existing evaluator defaults to dry-run; `--execute-paid` permits three requests, not one, and does not initialize tracing or load bot environment. Do not run it under a one-request allowance. The helper accepts one PNG, so it is not an exact replay of a request with multiple images/text parts. Preserve those differences in conclusions. The local diagnostics initializer is reusable by a separately scoped fixture harness. Keep this shortcut optional and do not confuse it with Discord/member-directory acceptance.

## Shutdown and recovery

Stop the owned watcher and bot child through their managed session, then prove both exited. Identify a process by PID plus start time and worktree/session, not PID alone. Never stop all Node processes. Some ready-time timers lack explicit bot cleanup; process exit is required shutdown evidence.

After a crash, inspect pending jobs, provider attempts and external outcomes before restarting. Report analysis leases currently use 30 seconds with ten-second renewal; inspect current source and other action-specific recovery rules. Lease expiry does not prove the side effect never happened. Preserve unknown outcomes and use supported recovery. Do not mass-reset processing rows or clear attempt limits.

Restore only recorded local settings and owned fixture objects within the approved cleanup scope. Report surviving fixtures and pending work. Report closure or evidence deletion is not implicit shutdown. Default isolation should require no production restoration.

## Final runtime acceptance and handoff

Stop the dev process and repeat the relevant bounded Discord test using the repository Docker build/runtime with the same isolated app/guild/DB. The image uses Node 24, pruned dependencies and `node dist/src/index.js`; a ts-node pass or CI import smoke misses real runtime behavior. The image sets `NODE_ENV=production`; explicitly retain dev credentials/services. Container loopback differs from host loopback, so select the supported local DB network route and prove the same SQL identity again. Stay inside the authorized request allowance.

The image's normal entry does not select the local collector. For local image diagnostics, use the developer entry `node dist/src/dev.js` with the verified dev configuration; also test the normal image entry when asserting production-startup behavior. If diagnostics/export differ, state that limitation. Never switch to a production DB to make a container test connect.

Save a compact private receipt: source/diff, fixture ID/hash, identity proofs, process ownership, runtime/config/provider differences, attempts and safe diagnostics, expected/actual behavior, unknown outcomes, cleanup and remaining objects. Separate offline, real provider, live Discord and deployed acceptance claims. Production release remains the normal PR/deployment workflow.

Measure first setup, ready time, first result, edit-to-retest time, request count and cleanup on the first authorized run. Set speed targets from that baseline rather than guessing. Hand off blockers with exact missing proof or failed operation, not a generic request to deploy for debugging.
