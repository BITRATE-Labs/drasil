import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function assertCiResults(results) {
  for (const job of ['static-unit', 'database-acceptance', 'isolated-browsers', 'package-smoke']) {
    assert.equal(results?.[job]?.result, 'success', `${job} must succeed`);
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
