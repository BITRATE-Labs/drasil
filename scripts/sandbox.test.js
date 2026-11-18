const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandboxEnvironment, requireSettings } = require('./sandbox');

test('sandbox excludes inherited live endpoints, tokens and database routes', () => {
  const env = sandboxEnvironment(
    {
      PATH: 'tools',
      DISCORD_TOKEN: 'production-token',
      DATABASE_URL: 'postgresql://remote/prod',
      DRASIL_WEB_DATABASE_URL: 'postgresql://remote/prod',
      OPENAI_API_KEY: 'paid-key',
      OPENAI_BASE_URL: 'https://provider.invalid',
      VERCEL: '1',
      PGHOST: 'remote',
    },
    'DISCORD_TOKEN=dev-token\nDISCORD_CLIENT_ID=dev-app'
  );
  assert.equal(env.DISCORD_TOKEN, 'dev-token');
  assert.equal(env.PATH, 'tools');
  assert.equal(env.VERCEL, undefined);
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:9/v1');
  assert.equal(env.OPENAI_API_KEY, 'sandbox-provider-disabled');
  assert.match(env.DATABASE_URL, /127\.0\.0\.1:55434\/drasil_sandbox/);
  assert.equal(env.DRASIL_WEB_DATABASE_URL, env.DATABASE_URL);
});

test('sandbox refuses remote, shared and disposable integration databases', () => {
  for (const url of [
    'postgresql://user@remote/drasil_sandbox?schema=public',
    'postgresql://user@127.0.0.1:55434/postgres?schema=public',
    'postgresql://user@127.0.0.1:55433/drasil_mcp_test?schema=public',
    'postgresql://user@127.0.0.1:55434/drasil_sandbox?schema=other',
  ])
    assert.throws(() => sandboxEnvironment({}, `DATABASE_URL=${url}`), /Sandbox requires/);
  assert.throws(
    () => sandboxEnvironment({}, 'DRASIL_WEB_DATABASE_URL=postgresql://remote/prod'),
    /same owned database/
  );
});

test('sandbox forces local runtime behavior even if the file enables exporters or paid providers', () => {
  const env = sandboxEnvironment(
    {},
    'NODE_ENV=production\nOPENAI_API_KEY=paid\nLANGFUSE_TRACING_ENABLED=true\nPOSTHOG_PRODUCT_ANALYTICS_ENABLED=true\nDRASIL_MCP_ENABLED=true'
  );
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.OPENAI_API_KEY, 'sandbox-provider-disabled');
  assert.equal(env.LANGFUSE_TRACING_ENABLED, 'false');
  assert.equal(env.POSTHOG_PRODUCT_ANALYTICS_ENABLED, 'false');
  assert.equal(env.DRASIL_MCP_ENABLED, 'false');
});

test('missing sandbox settings report names without exposing values', () => {
  assert.throws(
    () =>
      requireSettings({ DISCORD_TOKEN: 'private-token' }, ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']),
    (error) =>
      error.message.includes('DISCORD_CLIENT_ID') && !error.message.includes('private-token')
  );
});
