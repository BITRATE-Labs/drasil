const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.sandbox.local');
const databaseUrl = 'postgresql://postgres:sandbox@127.0.0.1:55434/drasil_sandbox?schema=public';
const parts = ['web', 'bot', 'db', 'shared', 'credentials'];

function sandboxEnvironment(inherited, contents) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(DRASIL_|DISCORD_|OPENAI_|TYPESAFE_|LANGFUSE_|POSTHOG_|PG|POSTGRES_|DATABASE_URL$|NODE_ENV$|NEXT_PUBLIC_APP_URL$|VERCEL)/.test(
        key
      )
    )
      delete env[key];
  }
  Object.assign(env, dotenv.parse(contents));
  const target = new URL(env.DATABASE_URL || databaseUrl);
  if (target.toString() !== databaseUrl)
    throw new Error('Sandbox requires its owned 127.0.0.1:55434/drasil_sandbox database.');
  if (env.DRASIL_WEB_DATABASE_URL && env.DRASIL_WEB_DATABASE_URL !== target.toString())
    throw new Error('Sandbox web and bot must use the same owned database.');
  Object.assign(env, {
    DATABASE_URL: target.toString(),
    DRASIL_WEB_DATABASE_URL: target.toString(),
    DRASIL_WEB_DATA_PROVIDER: 'postgres',
    DRASIL_SANDBOX: 'true',
    NODE_ENV: 'development',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    OPENAI_API_KEY: 'sandbox-provider-disabled',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    LANGFUSE_TRACING_ENABLED: 'false',
    POSTHOG_PRODUCT_ANALYTICS_ENABLED: 'false',
    DRASIL_MCP_ENABLED: 'false',
  });
  delete env.TYPESAFE_API_KEY;
  return env;
}

function requireSettings(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in .env.sandbox.local.`);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Sandbox command failed (${path.basename(command)}).`);
}

function buildShared(env) {
  run(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'packages/application/tsconfig.json'],
    env
  );
  run(process.execPath, ['packages/application/scripts/build-browser.mjs'], env);
}

async function prepareDatabase(env) {
  run('docker', ['compose', '-f', 'compose.sandbox.yml', 'up', '-d', '--wait'], env);
  if (new URL(env.DATABASE_URL).pathname === '/drasil_sandbox_web') {
    const admin = new Pool({ connectionString: databaseUrl });
    try {
      const found = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='drasil_sandbox_web'"
      );
      if (!found.rowCount) await admin.query('CREATE DATABASE drasil_sandbox_web');
    } finally {
      await admin.end();
    }
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS extensions');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions');
    run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
    run(process.execPath, ['scripts/prisma-generate.js'], env);
    if (env.DRASIL_DEV_GUILD_ID) {
      if (!/^\d{17,20}$/.test(env.DRASIL_DEV_GUILD_ID)) throw new Error('Invalid dev guild ID.');
      const servers = await pool.query('SELECT guild_id FROM servers');
      if (servers.rows.some((row) => row.guild_id !== env.DRASIL_DEV_GUILD_ID))
        throw new Error(
          'Sandbox database contains a different guild; existing data was preserved.'
        );
      await pool.query(
        'INSERT INTO servers(guild_id,is_active) VALUES($1,false) ON CONFLICT(guild_id) DO NOTHING',
        [env.DRASIL_DEV_GUILD_ID]
      );
    }
  } finally {
    await pool.end();
  }
}

async function verifyDevBot(env) {
  requireSettings(env, ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DRASIL_DEV_GUILD_ID']);
  if (!/^\d{17,20}$/.test(env.DRASIL_DEV_GUILD_ID)) throw new Error('Invalid dev guild ID.');
  const headers = { authorization: `Bot ${env.DISCORD_TOKEN}` };
  const identityResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!identityResponse.ok)
    throw new Error(`Dev bot identity check failed (${identityResponse.status}).`);
  const identity = await identityResponse.json();
  if (identity.bot !== true || identity.id !== env.DISCORD_CLIENT_ID)
    throw new Error('The selected token does not match the configured dev application.');
  const guildResponse = await fetch(
    `https://discord.com/api/v10/guilds/${env.DRASIL_DEV_GUILD_ID}`,
    {
      headers,
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!guildResponse.ok)
    throw new Error(`Dev bot cannot access the selected guild (${guildResponse.status}).`);
}

function ensureEnvironmentFile() {
  if (fs.existsSync(envFile)) return;
  const initial = dotenv.parse(fs.readFileSync(path.join(root, '.env.sandbox.example')));
  initial.DRASIL_SESSION_SECRET = randomBytes(32).toString('hex');
  fs.writeFileSync(
    envFile,
    Object.entries(initial)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 }
  );
  console.log('[sandbox] Created ignored local configuration.');
}

async function loadDevCredentials(env) {
  requireSettings(env, ['DRASIL_DEV_GUILD_ID']);
  const result = spawnSync(
    'aws',
    [
      'secretsmanager',
      'get-secret-value',
      '--region',
      'us-east-1',
      '--secret-id',
      'drasil/dev/DISCORD_TOKEN',
      '--query',
      'SecretString',
      '--output',
      'text',
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0)
    throw new Error(
      'Dev credential read failed. Refresh the existing AWS SSO session, then retry credentials.'
    );
  const token = result.stdout.trim();
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Dev identity read failed (${response.status}).`);
  const identity = await response.json();
  if (
    identity.bot !== true ||
    typeof identity.id !== 'string' ||
    !/^\d{17,20}$/.test(identity.id) ||
    (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_ID !== identity.id)
  )
    throw new Error('Dev credential identity mismatch.');
  const values = dotenv.parse(fs.readFileSync(envFile));
  Object.assign(values, {
    DISCORD_TOKEN: token,
    DISCORD_CLIENT_ID: identity.id,
  });
  fs.writeFileSync(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 }
  );
  console.log('[sandbox] Verified dev bot credentials saved locally. Values were not printed.');
}

function startChild(part, env) {
  const args =
    part === 'web'
      ? [
          path.join(root, 'node_modules/next/dist/bin/next'),
          'dev',
          '--hostname',
          '127.0.0.1',
          '--port',
          '3000',
        ]
      : [
          ...(process.platform === 'win32' || process.platform === 'darwin'
            ? ['--watch-path=src', '--watch-path=packages/application/dist']
            : ['--watch']),
          '-r',
          'ts-node/register',
          'src/dev.ts',
        ];
  return spawn(process.execPath, args, {
    cwd: part === 'web' ? path.join(root, 'apps/web') : root,
    env,
    stdio: 'inherit',
  });
}

async function main(part = process.argv[2]) {
  if (!parts.includes(part)) {
    console.log(
      'Usage: npm run sandbox -- web|bot|db|shared|credentials\nSee docs/dev/local-sandbox.md.'
    );
    if (part && part !== '--help') process.exitCode = 1;
    return;
  }
  const started = performance.now();
  if (part !== 'shared') ensureEnvironmentFile();
  const contents = fs.existsSync(envFile) ? fs.readFileSync(envFile) : '';
  const env = sandboxEnvironment(process.env, contents);
  if (part === 'credentials') {
    await loadDevCredentials(env);
    return;
  }
  if (part === 'shared') {
    buildShared(env);
    console.log(
      `[sandbox] Shared package ready in ${((performance.now() - started) / 1000).toFixed(1)}s.`
    );
    return;
  }
  for (const relative of [
    '.env',
    'apps/web/.env',
    'apps/web/.env.local',
    'apps/web/.env.development',
    'apps/web/.env.development.local',
  ]) {
    if (fs.existsSync(path.join(root, relative)))
      throw new Error(
        'Use a dedicated sandbox checkout without other dotenv files. Existing files were preserved.'
      );
  }
  let fixtures;
  let browser;
  if (part === 'web') {
    requireSettings(env, ['DRASIL_SESSION_SECRET']);
    const url = new URL(env.DATABASE_URL);
    url.pathname = '/drasil_sandbox_web';
    Object.assign(env, {
      DATABASE_URL: url.toString(),
      DRASIL_WEB_DATABASE_URL: url.toString(),
      DRASIL_DEV_GUILD_ID: '',
      DISCORD_API_BASE_URL: 'http://127.0.0.1:34568',
      DISCORD_TOKEN: 'controlled-provider-bot-token',
      DRASIL_WEB_BOT_TOKEN: 'controlled-provider-bot-token',
      DISCORD_CLIENT_ID: 'controlled-provider-client',
      DISCORD_CLIENT_SECRET: 'controlled-provider-client-secret',
      DRASIL_OAUTH_ENCRYPTION_KEY: env.DRASIL_SESSION_SECRET,
      DRASIL_LEGACY_TEST_BUILD: 'false',
      DRASIL_WEB_E2E_FIXTURE_MODE: 'false',
    });
    require('ts-node').register({
      transpileOnly: true,
      moduleTypes: { 'apps/web/**/*.ts': 'cjs' },
    });
    const { workspaceFixtures } = require('../apps/web/e2e/workspaceFixtures.ts');
    fixtures = workspaceFixtures({
      sandboxDatabaseUrl: env.DATABASE_URL,
      preserveData: true,
      secret: env.DRASIL_SESSION_SECRET,
    });
    await fixtures.start();
  }
  if (part === 'bot') await verifyDevBot(env);
  try {
    await prepareDatabase(env);
    if (part === 'db') {
      console.log(
        `[sandbox] Database ready in ${((performance.now() - started) / 1000).toFixed(1)}s. Existing rows preserved.`
      );
      return;
    }
    buildShared(env);
  } catch (error) {
    await fixtures?.stop();
    throw error;
  }
  console.log(
    `[sandbox] ${part}; source=${root}; owner PID=${process.pid}; prepared in ${((performance.now() - started) / 1000).toFixed(1)}s.`
  );
  const child = startChild(part, env);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    await fixtures?.stop();
  }
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
    void close();
  });
  child.on('exit', (code) => {
    if (!closing) process.exitCode = code ?? 1;
    void close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void close();
    });
  if (part === 'web') {
    try {
      const { chromium } = require('@playwright/test');
      browser = await chromium.launchPersistentContext(path.join(root, '.debug/sandbox-browser'), {
        headless: process.argv.includes('--headless'),
      });
      await fixtures.reset(browser, 'http://localhost:3000');
      const page = browser.pages()[0] ?? (await browser.newPage());
      const deadline = performance.now() + 90000;
      while (true) {
        try {
          await fetch('http://127.0.0.1:3000/admin', { redirect: 'manual' });
          break;
        } catch (error) {
          if (performance.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await page.goto('http://localhost:3000/admin');
      await page.getByRole('heading', { name: 'Choose a Server' }).waitFor();
      console.log(
        `[sandbox] Signed-in web ready at http://localhost:3000/admin in ${((performance.now() - started) / 1000).toFixed(1)}s. Synthetic Discord, persistent owned web database.`
      );
    } catch (error) {
      process.exitCode = 1;
      await close();
      throw error;
    }
  }
}

module.exports = { sandboxEnvironment, requireSettings };
if (require.main === module)
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
