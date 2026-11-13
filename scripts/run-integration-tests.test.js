const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { ownedTestDatabase } = require('./owned-test-database.js');

function run({ args = [], url, overrides = {}, statuses = [] } = {}) {
  const database = url ?? 'postgresql://postgres:postgres@localhost:5432/drasil_test';
  const calls = [];
  const exit = {};
  const processStub = {
    argv: ['node', 'run-integration-tests.js', ...args],
    execPath: 'node',
    env: {
      TEST_DATABASE_URL: database,
      DATABASE_URL: database,
      POSTGRES_DB_URL: database,
      ...overrides,
    },
    exit(code) {
      this.exitCode = code;
      throw exit;
    },
  };
  const requireStub = (name) => {
    if (name === 'dotenv/config') return {};
    if (name === './owned-test-database.js')
      return { ownedTestDatabase: () => ownedTestDatabase(processStub.env) };
    if (name === 'child_process' || name === 'node:child_process')
      return {
        spawnSync(...call) {
          calls.push(call);
          return { status: statuses.length ? statuses.shift() : 0 };
        },
      };
    return require(name);
  };
  requireStub.resolve = (name) => name;
  let error;
  try {
    runInNewContext(readFileSync(join(__dirname, 'run-integration-tests.js'), 'utf8'), {
      require: requireStub,
      process: processStub,
      __dirname,
      console: { error() {} },
    });
  } catch (caught) {
    if (caught !== exit) error = caught;
  }
  return { calls, code: processStub.exitCode, error };
}

test('standalone invocation generates, prepares storage and then runs integration tests', () => {
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls[0][1][1], 'generate');
  assert.match(result.calls[1][1][0], /prepare-test-database\.js$/);
  assert.equal(result.calls[2][1][0], 'jest/bin/jest');
  assert.equal(result.calls[2][2].env.JEST_INTEGRATION, '1');
});

test('prepared invocation launches only Jest', () => {
  const result = run({ args: ['--prepared'] });
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][1][0], 'jest/bin/jest');
});

test('both paths reject unowned or mismatched storage before launching any process', () => {
  for (const args of [[], ['--prepared']]) {
    for (const input of [
      { url: 'postgresql://postgres:postgres@remote.example:5432/drasil_test' },
      { overrides: { POSTGRES_DB_URL: 'postgresql://different' } },
    ]) {
      const result = run({ args, ...input });
      assert.equal(result.calls.length, 0);
      assert.ok(result.error || result.code !== 0);
    }
  }
});

test('unknown or repeated options fail before launching any process', () => {
  for (const args of [['--unknown'], ['--prepared', '--prepared']]) {
    const result = run({ args });
    assert.equal(result.calls.length, 0);
    assert.ok(result.error || result.code !== 0);
  }
});

test('generation and preparation failures stop before Jest, including a missing exit status', () => {
  for (const statuses of [[2], [null], [0, 3], [0, null]]) {
    const expectedCalls = statuses.length;
    const result = run({ statuses });
    assert.equal(result.calls.length, expectedCalls);
    assert.notEqual(result.code, 0);
  }
});

test('Jest failure is propagated', () => {
  assert.equal(run({ args: ['--prepared'], statuses: [5] }).code, 5);
});
