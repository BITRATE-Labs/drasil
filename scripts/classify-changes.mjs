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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let impact = classifyChanges([]);
  try {
    impact = classifyChanges(
      readChanges(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')))
    );
  } catch (error) {
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
