const { spawnSync } = require('child_process');
const { join } = require('node:path');
require('dotenv/config');
const { ownedTestDatabase } = require('./owned-test-database.js');
ownedTestDatabase();

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--prepared')) {
  console.error('Usage: node scripts/run-integration-tests.js [--prepared]');
  process.exit(1);
}

process.env.JEST_INTEGRATION = '1';

const testDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  console.error('Missing TEST_DATABASE_URL or DATABASE_URL for integration tests.');
  process.exit(1);
}

const testEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || testDatabaseUrl,
};

if (args[0] !== '--prepared') {
  for (const command of [
    [require.resolve('prisma/build/index.js'), 'generate'],
    [join(__dirname, 'prepare-test-database.js')],
  ]) {
    const result = spawnSync(process.execPath, command, { stdio: 'inherit', env: testEnv });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(
  process.execPath,
  [jestBin, '--testPathPattern=src/__tests__/integration'],
  {
    stdio: 'inherit',
    env: testEnv,
  }
);

process.exit(result.status !== null ? result.status : 1);
