import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const localFiles = new Set([
  '.env.sandbox.example',
  'compose.sandbox.yml',
  'docs/dev/local-sandbox.md',
  'docs/dev/pr-workflow.md',
  'scripts/sandbox.js',
  'scripts/sandbox.test.js',
  'src/dev.ts',
]);
const databaseFiles = new Set([
  'apps/web/e2e/workspaceFixtures.ts',
  'apps/web/lib/sandboxFixtures.test.ts',
]);

export function classifyChanges(changes) {
  const local =
    changes.length > 0 &&
    changes.every(
      ({ status, path }) =>
        /^[AMD]$/.test(status) && (localFiles.has(path) || databaseFiles.has(path))
    );
  return {
    profile: local
      ? changes.some(({ path }) => databaseFiles.has(path))
        ? 'local-database'
        : 'local'
      : 'full',
    bot: !local,
    web: !local,
    iac: !local,
    actionlint: !local,
  };
}

export function readChanges(event, cwd = process.cwd()) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const pull = event.pull_request;
  const before = pull ? pull.base.sha : event.before;
  const after = pull ? pull.head.sha : event.after;
  for (const sha of [before, after])
    assert.match(sha ?? '', /^(?!0+$)[a-f0-9]{40}$/, 'Complete commit history is required');
  if (!pull) git('merge-base', '--is-ancestor', before, after);
  // Renames are delete/add pairs so both paths must qualify, including moves out of production.
  const fields = git(
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--name-status',
    '-z',
    pull ? `${before}...${after}` : before,
    ...(pull ? [] : [after]),
    '--'
  ).split('\0');
  assert.equal(fields.pop(), '', 'Expected NUL-delimited git diff');
  assert.equal(fields.length % 2, 0, 'Expected status/path pairs');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2)
    changes.push({ status: fields[i], path: fields[i + 1] });
  return changes;
}

export async function deploymentRequired(event, target, api, cwd = process.cwd()) {
  const [workflow, jobName] =
    target === 'bot' ? ['deploy-prod.yml', 'deploy'] : ['ci.yml', 'deploy-web-prod'];
  try {
    // shortcut: inspect ten recent runs; an older or uncertain receipt requires deployment.
    const { workflow_runs: runs } = await api(`/actions/workflows/${workflow}/runs?per_page=10`);
    let receipt;
    for (const run of runs) {
      if (String(run.id) === process.env.GITHUB_RUN_ID) continue;
      if (!['push', 'workflow_dispatch'].includes(run.event)) continue;
      const { jobs, total_count: total } = await api(`/actions/runs/${run.id}/jobs?per_page=100`);
      if (total > jobs.length) return true;
      const job = jobs.find((entry) => entry.name === jobName && entry.conclusion === 'success');
      if (!job) continue;
      const completed = Date.parse(job.completed_at);
      if (!Number.isFinite(completed)) return true;
      if (!receipt || completed > receipt.completed) receipt = { run, completed };
    }
    // Manual recovery can deploy a ref different from the workflow's head SHA.
    if (receipt?.run.event === 'push') {
      return classifyChanges(
        readChanges({ before: receipt.run.head_sha, after: event.after }, cwd)
      )[target];
    }
  } catch (error) {
    console.warn(`Deployment receipt unavailable: ${error.message}`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let impact = classifyChanges([]);
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    impact = classifyChanges(readChanges(event));
    const target = process.env.DEPLOYMENT_TARGET;
    if (impact.profile !== 'full' && process.env.GITHUB_EVENT_NAME === 'push' && target) {
      assert.ok(['bot', 'web'].includes(target), 'Unknown deployment target');
      const api = async (path) => {
        const response = await fetch(
          `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}${path}`,
          {
            headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
            signal: AbortSignal.timeout(10000),
          }
        );
        assert.ok(response.ok, `Deployment history read failed: HTTP ${response.status}`);
        return response.json();
      };
      impact[target] = await deploymentRequired(event, target, api);
      if (impact[target]) impact.profile = 'full';
    }
  } catch (error) {
    impact = classifyChanges([]);
    console.warn(`Using full coverage: ${error.message}`);
  }
  console.log(JSON.stringify(impact));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(impact)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    );
}
