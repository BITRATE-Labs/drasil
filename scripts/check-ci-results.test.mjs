import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertCiResults } from './check-ci-results.mjs';

const jobs = ['static-unit', 'database-acceptance', 'isolated-browsers', 'package-smoke'];
const successful = () => Object.fromEntries(jobs.map((job) => [job, { result: 'success' }]));

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

test('CLI rejects missing or malformed JSON and propagates failure', () => {
  for (const value of ['', '{', JSON.stringify({}), JSON.stringify(successful())]) {
    const result = spawnSync(process.execPath, ['scripts/check-ci-results.mjs'], {
      env: { ...process.env, CI_RESULTS: value },
      encoding: 'utf8',
    });
    assert.equal(result.status, value === JSON.stringify(successful()) ? 0 : 1);
  }
});
