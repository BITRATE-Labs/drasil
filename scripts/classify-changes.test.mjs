import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { classifyChanges, readChanges, deploymentRequired } from './classify-changes.mjs';

const changes = (...paths) => paths.map((path) => ({ status: 'M', path }));

test('local tools retain static checks without production deployment', () => {
  assert.deepEqual(classifyChanges(changes('docs/dev/local-sandbox.md', 'scripts/sandbox.js')), {
    profile: 'local',
    bot: false,
    web: false,
    iac: false,
    actionlint: false,
  });
});

test('the #333 file set retains database acceptance', () => {
  assert.equal(
    classifyChanges(
      changes(
        '.env.sandbox.example',
        'apps/web/e2e/workspaceFixtures.ts',
        'apps/web/lib/sandboxFixtures.test.ts',
        'compose.sandbox.yml',
        'docs/dev/local-sandbox.md',
        'scripts/sandbox.js',
        'scripts/sandbox.test.js',
        'src/dev.ts'
      )
    ).profile,
    'local-database'
  );
});

test('unknown, production, shared, workflow and mixed changes keep full coverage', () => {
  for (const path of [
    'src/index.ts',
    'apps/web/app/page.tsx',
    'packages/application/src/index.ts',
    'packages/contracts/src/index.ts',
    'package-lock.json',
    'package.json',
    '.npmrc',
    'prisma/schema.prisma',
    'Dockerfile',
    '.dockerignore',
    'tsconfig.json',
    'apps/web/lib/mcp/runtime/index.js',
    'apps/web/e2e/legacy/build-aliases.mjs',
    '.github/workflows/ci.yml',
    'new-file',
    'scripts/sandbox.js\nnew-file',
  ]) {
    const impact = classifyChanges(changes('scripts/sandbox.js', path));
    assert.equal(impact.profile, 'full', path);
    assert.equal(impact.bot && impact.web && impact.iac && impact.actionlint, true, path);
  }
  assert.equal(classifyChanges([]).profile, 'full');
  assert.equal(classifyChanges([{ status: 'T', path: 'scripts/sandbox.js' }]).profile, 'full');
});

test('complete git diffs cover multiple commits, renames, deletions and divergent PR history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'drasil-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (path) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'fixture\n');
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    write('src/index.ts');
    const before = commit();
    write('scripts/sandbox.js');
    const local = commit();
    assert.equal(classifyChanges(readChanges({ before, after: local }, cwd)).profile, 'local');
    write('unknown');
    commit();
    write('docs/dev/local-sandbox.md');
    const after = commit();
    assert.equal(classifyChanges(readChanges({ before, after }, cwd)).profile, 'full');
    git('checkout', '-q', '-b', 'rename', before);
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    git('mv', 'src/index.ts', 'scripts/sandbox.js');
    const renamed = commit();
    assert.deepEqual(
      readChanges({ before, after: renamed }, cwd)
        .map(({ path }) => path)
        .sort(),
      ['scripts/sandbox.js', 'src/index.ts']
    );
    assert.equal(classifyChanges(readChanges({ before, after: renamed }, cwd)).profile, 'full');
    assert.throws(() => readChanges({ before: renamed, after: before }, cwd));
    git('checkout', '-q', '-b', 'divergent', before);
    write('scripts/sandbox.js');
    writeFileSync(join(cwd, 'scripts/sandbox.js'), 'divergent fixture');
    const divergent = commit();
    const pull = { pull_request: { base: { sha: after }, head: { sha: divergent } } };
    assert.deepEqual(readChanges(pull, cwd), [{ status: 'A', path: 'scripts/sandbox.js' }]);
    assert.equal(classifyChanges(readChanges(pull, cwd)).profile, 'local');
    git('checkout', '-q', '-b', 'delete-local', local);
    git('rm', '-q', 'scripts/sandbox.js');
    const deleted = commit();
    assert.deepEqual(readChanges({ before: local, after: deleted }, cwd), [
      { status: 'D', path: 'scripts/sandbox.js' },
    ]);
    assert.equal(
      classifyChanges(readChanges({ before: local, after: deleted }, cwd)).profile,
      'local'
    );
    git('checkout', '-q', '-b', 'rename-production', local);
    git('mv', 'scripts/sandbox.js', 'new-production.js');
    const moved = commit();
    assert.equal(
      classifyChanges(readChanges({ before: local, after: moved }, cwd)).profile,
      'full'
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('missing history and invalid event input default the CLI to full coverage', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'drasil-impact-event-'));
  try {
    for (const event of [
      {},
      { before: '0'.repeat(40), after: 'a'.repeat(40) },
      { before: 'a'.repeat(40), after: 'b'.repeat(40) },
    ]) {
      const eventPath = join(cwd, 'event.json');
      writeFileSync(eventPath, JSON.stringify(event));
      const result = spawnSync(process.execPath, [resolve('scripts/classify-changes.mjs')], {
        cwd,
        env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: '' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).profile, 'full');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('deployment decisions retain changes since the last actual successful rollout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'drasil-deployment-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    writeFileSync(join(cwd, 'production.js'), 'old');
    const old = commit();
    writeFileSync(join(cwd, 'production.js'), 'new');
    const released = commit();
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(join(cwd, 'scripts/sandbox.js'), 'local');
    const after = commit();
    for (const target of ['bot', 'web']) {
      const name = target === 'bot' ? 'deploy' : 'deploy-web-prod';
      const api = (runs, jobs) => async (path) =>
        path.includes('/workflows/')
          ? { workflow_runs: runs }
          : { jobs: jobs[path.match(/runs\/(\d+)/)[1]], total_count: 1 };
      const run = (id, sha, event = 'push') => ({ id, head_sha: sha, event });
      const job = (conclusion) => [{ name, conclusion, completed_at: '2026-11-18T00:00:00Z' }];
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(2, released), run(1, old)], {
            2: job('success'),
            1: [{ name, conclusion: 'success', completed_at: '2026-11-18T01:00:00Z' }],
          }),
          cwd
        ),
        true
      );
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(1, 'a'.repeat(40))], { 1: job('success') }),
          cwd
        ),
        true
      );

      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(1, released)], { 1: job('success') }),
          cwd
        ),
        false
      );
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(2, released), run(1, old)], { 2: job('failure'), 1: job('success') }),
          cwd
        ),
        true
      );
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(2, after), run(1, released)], { 2: job('skipped'), 1: job('success') }),
          cwd
        ),
        false
      );
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          api([run(1, released, 'workflow_dispatch')], { 1: job('success') }),
          cwd
        ),
        true
      );
      assert.equal(await deploymentRequired({ after }, target, api([], {}), cwd), true);
      assert.equal(
        await deploymentRequired(
          { after },
          target,
          async () => {
            throw new Error('offline');
          },
          cwd
        ),
        true
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
