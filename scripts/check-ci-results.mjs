import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function assertCiResults(results) {
  assert.equal(results?.impact?.result, 'success', 'impact must succeed');
  const profile = results.impact.outputs?.profile;
  assert.ok(
    ['full', 'local', 'local-database'].includes(profile),
    'Expected a valid impact profile'
  );
  const excluded = new Set(profile === 'full' ? [] : ['isolated-browsers', 'package-smoke']);
  if (profile === 'local') excluded.add('database-acceptance');
  for (const job of ['static-unit', 'database-acceptance', 'isolated-browsers', 'package-smoke']) {
    assert.ok(results[job], `${job} must be present`);
  }
  for (const [job, value] of Object.entries(results)) {
    if (excluded.has(job) && value?.result === 'skipped') continue;
    assert.equal(value?.result, 'success', `${job} must succeed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertCiResults(JSON.parse(process.env.CI_RESULTS ?? '{}'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
