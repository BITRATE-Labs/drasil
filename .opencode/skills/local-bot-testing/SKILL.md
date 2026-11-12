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

Read-only inspection and offline tests are autonomous within assigned work. Retain existing authorization for a bounded live run across ordinary restarts. Provisioning a new exclusively owned local database and applying current migrations is routine authorized setup for a requested local test. Do it without another permission prompt; preserve existing databases and passwords. Before live execution, obtain only genuinely missing authorization for external effects or provider spend. New apps/tokens, shared-service interruptions, extra paid requests, production changes and moderation need their own scope. Starting the bot already starts workers and can cause effects.

## Prove isolation before login

Complete this private preflight record. A secret name, display name or `NODE_ENV=development` does not prove identity.

| Identity           | Required evidence                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source             | Worktree, commit/diff, installed dependencies and generated-client readiness                                                         |
| Effective config   | Selected env file plus inherited variables; dotenv leaves existing variables in place                                                |
| App/bot            | Authenticated dev identity matches the selected credential route; compare available non-secret deployment identity                   |
| Guilds             | Complete dev bot guild membership and selected test guild; scope dev dispatch to that guild even when other memberships exist        |
| Channels and roles | Fresh dev fixture channels/roles; deployed bot cannot act on ordinary fixture messages                                               |
| DB                 | Actual SQL server/database/schema, migration state, configured guild IDs, pending jobs and exclusive owner                           |
| Processes          | Inspect local processes and known hosting routes for competing instances; report the checks performed and handle a detected conflict |
| Provider           | Intended project/key source, effective endpoint/model/options, approved attempts and unknown prior outcomes                          |

Reuse the documented `drasil/dev` credential route after verifying the dev bot identity. Production-token access is not a prerequisite for local testing. Use non-secret deployed application identity/configuration where available and state any comparator uncertainty; do not expand credential access just to make preflight complete. `npm run dev:env` writes `.env` and overwrites any existing file. Preserve and explicitly select existing configuration before hydration; never print or commit credential values. If no suitable dev identity can be verified, report what is missing before proposing app creation or a same-token handover.

A different bot in a shared channel can still react to the same message. Isolate the fixture with channel permissions or a dedicated test guild. Do not copy deployed channel configuration, production DB contents, report IDs or persisted custom IDs into the local fixture. Store IDs and operational receipts in the already ignored `.debug/local-bot-testing/<run-id>/` directory or outside the checkout. Verify the selected destination is private and ignored before writing.

Inspect current `Bot`, ready handler and worker startup. Normal startup globally registers commands for its app; the dev entry registers only in the selected guild. Action, report analysis, CAPTCHA, queue, reminder and reconciliation workers can act before the test interaction. Check due/processing jobs before enabling features. Detection test mode changes accounting, not side effects. Set the implemented `DRASIL_DEV_GUILD_ID` to the selected guild. The dev entry requires it and the controller dispatch boundary ignores other guild events. Normal startup leaves that guard inactive. Dev command registration uses the selected guild route and preserves the app's global commands; ready-time configuration and workers must use an exclusively owned DB containing only the selected guild.

### Owned local database setup

Use the existing local Postgres/Supabase runtime. Create an unused task-owned database, ensure `extensions` and `uuid-ossp`, then apply this checkout's migrations with `prisma migrate deploy`. Keep its URL separate from the truncating integration-test URLs. Verify the applied migration set rather than assuming a running Supabase instance is current.

Use the existing local administrator route for grants/migrations requiring ownership. In Supabase, the ordinary `postgres` role may not be a superuser; the container's `supabase_admin` can use the already-bound `POSTGRES_PASSWORD` internally without exporting it. If an old shared login's documented password does not match, leave it unchanged and provision a restricted login for the new DB. Give it ownership/access only within that database, verify its login and UUID function access, and save the generated connection in the owned ignored environment. Seed only the selected guild and the settings required by the test. Inspect all worker queues before startup.

On Windows, inspect `Win32_Process` for Node commands running `src/dev.ts`, `src/index.ts` or their compiled equivalents. Compare PID, creation time, command path and owning session without dumping raw command lines. Inspect the repository's known hosting/deployment routes for a dev instance. Reuse an already-owned session or stop a demonstrably stale owned process; do not kill unrelated Node processes. State the bounded evidence when no competitor is found rather than asking the user to prove absence on every machine.

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

Prepare the selected `DRASIL_DEV_GUILD_ID` in the owned environment. After preflight and authorization, use `npm run dev` in an owned interactive session. This selects `src/dev.ts`, initializes local diagnostic capture, disables remote Langfuse/PostHog export, then imports the existing bootstrap. It is a real bot, not a dry-run or an automatic identity check. The normal `npm start` entry does not activate guild scoping and still registers global commands. Remote-exporter testing through that entry is separate app-wide work; do not use it as a scoped test or against an app whose global Entry Point must be preserved.

Record the watcher and child PID/start time. Wait for login, configuration, command registration and relevant workers, not just the generic startup line. Verify the selected guild setup and pending work before the fixture action.

Create one fresh synthetic fixture using existing helpers. Use dev-app-owned messages/components. For staged report tests, confirm both staged intake and evidence analysis are enabled locally, reporter and target IDs differ, and source/image limits permit the fixture. State the expected candidate and directory coverage. A moderator fallback does not count as successful matching. Stop at the agreed boundary before confirmation, submission or moderation.

Observe the Discord result and JSON lines with `event=local_observation`. Records include process and trace/span correlation, elapsed time, selected provider metadata and usage counts. Raw evidence and model output are excluded from these records. Ordinary console logs are separate and may contain private content; review them before sharing.

An incomplete response with `max_output_tokens`, empty output and zero reported usage proves the reported response shape, not actual token consumption or a need to increase the cap. Match the tested source's prompt/schema/options before drawing a provider conclusion. An unknown or timed-out attempt is not free and does not authorize another request. One Discord action can cause multiple model calls; inspect actual worker allowances and pending work.

## Edit and retest

Let active work finish or reconcile its outcome before editing. Node watch restarts on source changes; record the new child identity and source diff. Reuse the approved allowance, and stop when exhausted. Use a fresh intake rather than erasing attempts or evidence on an old one.

On Windows or macOS, if imported dependencies cause repeated restarts, stop the owned watcher and use `node --watch-path=src -r ts-node/register src/dev.ts`. This excludes imported dependency watching while retaining source restarts. Node's explicit watch paths are unsupported on Linux, where the normal imported-module watch remains the route. Rebuild shared packages and explicitly restart when changing them.

Explicitly restart after env changes and repeat config/identity checks. Prepare dependencies, migrations and generated clients when the change requires them. Avoid restarting during moderation actions.

For a provider-only question, `GPTService.extractReportIdentityFixture` shares the live extractor without logging into Discord or needing a DB. The existing evaluator defaults to dry-run; `--execute-paid` permits three requests, not one, and does not initialize tracing or load bot environment. Do not run it under a one-request allowance. The helper accepts one PNG, so it is not an exact replay of a request with multiple images/text parts. Preserve those differences in conclusions. The local diagnostics initializer is reusable by a separately scoped fixture harness. Keep this shortcut optional and do not confuse it with Discord/member-directory acceptance.

## Shutdown and recovery

Stop the owned watcher and bot child through their managed session, then prove both exited. Identify a process by PID plus start time and worktree/session, not PID alone. Never stop all Node processes. Some ready-time timers lack explicit bot cleanup; process exit is required shutdown evidence.

After a crash, inspect pending jobs, provider attempts and external outcomes before restarting. Report analysis leases currently use 30 seconds with ten-second renewal; inspect current source and other action-specific recovery rules. Lease expiry does not prove the side effect never happened. Preserve unknown outcomes and use supported recovery. Do not mass-reset processing rows or clear attempt limits.

Restore only recorded local settings and owned fixture objects within the approved cleanup scope. Report surviving fixtures and pending work. Report closure or evidence deletion is not implicit shutdown. Default isolation should require no production restoration.

## Final runtime acceptance and handoff

Stop the dev process and repeat the relevant bounded Discord test using the repository Docker build/runtime with the same isolated app/guild/DB, explicitly overriding its entry to `node dist/src/dev.js`. The image uses Node 24 and pruned dependencies; a ts-node pass or CI import smoke misses compiled runtime behavior. The image sets `NODE_ENV=production`; explicitly retain dev credentials/services. Container loopback differs from host loopback, so select the supported local DB network route and prove the same SQL identity again. Stay inside the authorized request allowance.

The image's default `node dist/src/index.js` entry activates neither the local collector nor guild scoping, and can replace global commands. Do not run it as part of this bounded dev test. Testing normal production startup is separately scoped app-wide acceptance; keep it marked unverified unless that separate run is authorized and performed. Never switch to a production DB to make a container test connect.

Save a compact private receipt: source/diff, fixture ID/hash, identity proofs, process ownership, runtime/config/provider differences, attempts and safe diagnostics, expected/actual behavior, unknown outcomes, cleanup and remaining objects. Separate offline, real provider, live Discord and deployed acceptance claims. Production release remains the normal PR/deployment workflow.

Measure first setup, ready time, first result, edit-to-retest time, request count and cleanup on the first authorized run. Set speed targets from that baseline rather than guessing. Hand off blockers with exact missing proof or failed operation, not a generic request to deploy for debugging.
