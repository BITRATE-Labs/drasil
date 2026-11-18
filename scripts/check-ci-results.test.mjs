import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { assertCiResults } from './check-ci-results.mjs';

const jobs = ['static-unit', 'database-acceptance', 'isolated-browsers', 'package-smoke'];
const successful = () => ({
  impact: { result: 'success', outputs: { profile: 'full' } },
  ...Object.fromEntries(jobs.map((job) => [job, { result: 'success' }])),
});

test('accepts success from every required execution job', () => {
  assert.doesNotThrow(() => assertCiResults(successful()));
});

for (const job of jobs) {
  test(`${job} cannot be absent or unsuccessful`, () => {
    for (const result of ['failure', 'cancelled', 'skipped', 'in_progress', undefined]) {
      const results = successful();
      results[job] = { result };
      assert.throws(() => assertCiResults(results), { message: new RegExp(job) });
    }
    const missing = successful();
    delete missing[job];
    assert.throws(() => assertCiResults(missing), { message: new RegExp(job) });
  });
}

test('rejects empty or invalid results', () => {
  for (const value of [{}, null, undefined, [], 'success'])
    assert.throws(() => assertCiResults(value));
});

test('also requires any additional workflow prerequisite to succeed', () => {
  for (const result of ['failure', 'cancelled', 'skipped', 'in_progress', undefined]) {
    assert.throws(() => assertCiResults({ ...successful(), 'additional-check': { result } }), {
      message: /additional-check/,
    });
  }
  assert.doesNotThrow(() =>
    assertCiResults({ ...successful(), 'additional-check': { result: 'success' } })
  );
});

test('CLI rejects missing or malformed JSON and propagates failure', () => {
  for (const value of ['', '{', JSON.stringify({}), JSON.stringify(successful())]) {
    const result = spawnSync(process.execPath, ['scripts/check-ci-results.mjs'], {
      env: { ...process.env, CI_RESULTS: value },
      encoding: 'utf8',
    });
    assert.equal(result.status, value === JSON.stringify(successful()) ? 0 : 1);
  }
});

test('only explicitly excluded local checks may be skipped', () => {
  for (const profile of ['local', 'local-database']) {
    const results = successful();
    results.impact.outputs.profile = profile;
    results['isolated-browsers'].result = 'skipped';
    if (profile === 'local') results['database-acceptance'].result = 'skipped';
    assert.doesNotThrow(() => assertCiResults(results));
    for (const job of jobs) {
      for (const result of ['failure', 'cancelled', 'in_progress', undefined]) {
        assert.throws(() => assertCiResults({ ...results, [job]: { result } }));
      }
      const missing = { ...results };
      delete missing[job];
      assert.throws(() => assertCiResults(missing));
    }
    results['static-unit'].result = 'skipped';
    assert.throws(() => assertCiResults(results));
  }
});

test('failed or invalid classification cannot select a lightweight gate', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined])
    assert.throws(() =>
      assertCiResults({ ...successful(), impact: { result, outputs: { profile: 'local' } } })
    );
  for (const profile of ['', 'unknown', undefined])
    assert.throws(() =>
      assertCiResults({ ...successful(), impact: { result: 'success', outputs: { profile } } })
    );
  const results = successful();
  results.impact.outputs.profile = 'local-database';
  results['database-acceptance'].result = 'skipped';
  assert.throws(() => assertCiResults(results));
});

test('workflow job conditions agree with the aggregate skip contract for every profile', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r', '');
  for (const profile of ['full', 'local', 'local-database']) {
    const results = successful();
    results.impact.outputs.profile = profile;
    for (const job of jobs) {
      const block = workflow
        .split(/(?=^ {2}[a-z][\w-]*:)/m)
        .find((entry) => entry.startsWith(`  ${job}:\n`));
      assert.ok(block, `${job} must exist in the workflow`);
      const condition = block.match(/^ {4}if: needs\.impact\.outputs\.profile (==|!=) '([^']+)'$/m);
      assert.equal(
        /^ {4}if:/m.test(block),
        Boolean(condition),
        `${job} needs an understood condition`
      );
      const runs =
        !condition || (condition[1] === '==' ? profile === condition[2] : profile !== condition[2]);
      const attempt = { ...results, [job]: { result: 'skipped' } };
      if (runs) assert.throws(() => assertCiResults(attempt), job);
      else assert.doesNotThrow(() => assertCiResults(attempt), job);
    }
  }
});

test('IaC runs on failed classification or missing outputs, and respects workflow cancellation', () => {
  const workflow = readFileSync('.github/workflows/iac.yml', 'utf8').replaceAll('\r', '');
  for (const job of ['terraform', 'checkov', 'actionlint']) {
    const block = workflow
      .split(/(?=^ {2}[a-z][\w-]*:)/m)
      .find((entry) => entry.startsWith(`  ${job}:\n`));
    const expression = block.match(/^ {4}if: \$\{\{ (.+) \}\}$/m)[1];
    for (const result of ['success', 'failure', 'skipped', 'cancelled']) {
      for (const output of ['true', 'false', undefined]) {
        for (const canceled of [false, true]) {
          const actual = runInNewContext(expression, {
            cancelled: () => canceled,
            needs: { impact: { result, outputs: { iac: output, actionlint: output } } },
          });
          assert.equal(
            actual,
            !canceled && (result !== 'success' || output !== 'false'),
            `${job}/${result}/${output}`
          );
        }
      }
    }
  }
});

test('cancellation fails the required aggregate without publishing stale snapshots', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8').replaceAll('\r', '');
  const block = (job) =>
    workflow.split(/(?=^ {2}[a-z][\w-]*:)/m).find((entry) => entry.startsWith(`  ${job}:\n`));
  const raw = block('build-test').match(/^ {4}if: (.+)$/m)[1];
  const required = raw.startsWith('${{') ? raw.slice(3, -2).trim() : raw;
  const snapshot = block('snapshot-preview').match(/^ {4}if: \$\{\{ (.+) \}\}$/m)[1];
  for (const canceled of [false, true]) {
    assert.equal(
      runInNewContext(required, { always: () => true, cancelled: () => canceled }),
      true
    );
    assert.equal(
      runInNewContext(snapshot, {
        github: { event_name: 'pull_request' },
        cancelled: () => canceled,
      }),
      !canceled
    );
  }
});
