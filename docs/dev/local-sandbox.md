# Local sandbox

Use one sandbox checkout for pooled, owner-ready changes. Start the part you are working on,
then edit normally. The target is less than two minutes from a prepared checkout to usable local
readiness. Web work opens a signed-in browser automatically, with synthetic Discord data and a
persistent local database. No Discord OAuth secret is needed for this workflow.

## Start a part

From the sandbox checkout:

| Command                     | Result                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run sandbox -- web`    | Start Next development mode and open a dedicated signed-in Chromium window at `http://localhost:3000/admin`.                |
| `npm run sandbox -- bot`    | Start the existing real dev bot with source watching and one-guild dispatch. Requires the one-time dev credentials below.   |
| `npm run sandbox -- db`     | Start the owned Postgres container and apply pending migrations and regenerate the database client. Preserve existing rows. |
| `npm run sandbox -- shared` | Rebuild the shared application package, including its browser exports. Running dev servers observe the emitted files.       |

Web and bot commands also prepare their database and shared package. Web/source edits hot reload;
bot/source edits restart the scoped dev entry. After a shared-package change, run `shared` once.
Start the servers before running a live bot fixture: rebuilding shared output can restart an existing bot watcher. Stop a foreground command with Ctrl+C. Its browser, fixture provider and owned server process are
stopped together. The database volume remains available for the next session. Do not remove the
volume as routine preparation.

The web command uses the actual application graph, current migrations, and existing controlled
Discord fixtures. The dedicated browser gets a synthetic moderator session through the same cookie
helpers used by the tests. No login bypass or fixture branch is added to the release application.
The fixture data is seeded once and retained across restarts. It is separate from the live dev bot's
database, so synthetic web actions cannot become real Discord moderation jobs. Synthetic action
requests can remain queued: no live Discord worker consumes this web database.

## One-time preparation

Use Node and Docker versions supported by the repo, and install locked dependencies with `npm ci`.
Install the existing Playwright browser once if it is missing: `npx playwright install chromium`.
The first web command creates `.env.sandbox.local` with random local signing keys. This file is
ignored by Git. Never paste its contents into logs or a PR.

Use a dedicated worktree without another `.env` or web dotenv file. The launcher refuses competing
dotenv files and does not inherit production database, Discord, provider or Vercel settings. The
database is bound only to `127.0.0.1:15434`. The bot uses `drasil_sandbox`; synthetic web data uses
`drasil_sandbox_web`. Integration-test databases and the shared development Supabase database are
separate targets. If an existing `.env.sandbox.local` uses port `55434`, change only its database
URL port to `15434`; the named volume and stored data remain the same. Both sandbox schemas use the current migrations; neither is reset on startup.

For the real bot, set the selected development guild ID in `.env.sandbox.local`, then run
`npm run sandbox -- credentials`. This reads only the documented `drasil/dev/DISCORD_TOKEN` route,
verifies the dev identity, and saves it locally without printing it. An expired AWS SSO session must
be refreshed through the normal sign-in flow. The first real bot start checks its app identity and
access to the selected guild. Every watched restart checks that its database contains only that
guild before login. The initial guild row is inactive, and model calls target a closed loopback
endpoint. Enabling external effects or provider calls is a separate bounded test.

For a real Discord smoke, follow the [local bot testing playbook](../../.opencode/skills/local-bot-testing/SKILL.md).
The web sandbox does not require AWS credentials, real Discord credentials, or an OAuth setup step.
MCP registration's Vercel ingress contract and real OAuth consent are hosting-specific checks;
they are not claimed by this synthetic local web session. MCP is disabled in this launcher.

## Pool changes and update

Start from current `origin/main` in a named sandbox worktree. Integrate compatible, owner-ready
branches into that checkout and identify the source revision before testing. Keep unfinished draft
designs out of the integration. Each command reports the checkout it runs from. Do not reset or
silently switch another worker's checkout. Reuse the running web/bot watcher for ordinary edits
instead of doing a cloud deployment after each change.

Use the existing manual Vercel preview workflow when a change needs hosted behavior. Its preview
configuration must be set up independently; production settings are not a substitute for a sandbox.
No hosted database, paid clone, or new Vercel project is provisioned by this local workflow.

## Measured baseline

One Windows machine, Docker running, dependencies and Chromium installed:

| Operation                                                   |    Observed time |
| ----------------------------------------------------------- | ---------------: |
| First owned database preparation                            |           16.7 s |
| Repeat database preparation                                 |           12.1 s |
| Shared application build                                    |            8.3 s |
| First signed-in web start, including its schema preparation |           36.6 s |
| Final interactive signed-in web start                       |           28.3 s |
| Five workspace page loads                                   |   0.6�2.1 s each |
| Web edit to browser hot reload                              |            0.4 s |
| Real dev bot start and compiled-container smoke             | Not measured yet |

The page smoke covered the server picker, inbox, history, setup and operations. A database marker
survived a full sandbox restart and was then removed. The dev entry rejected an out-of-scope guild
row before Discord login. These are local results, not production latency measurements or a promise
about cold downloads and provider availability. Time initial dependency/browser setup separately
from routine update-to-readiness measurements. The launcher prints preparation/readiness timings;
web readiness includes an actual signed-in server-picker load.
