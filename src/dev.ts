import { setLocalGuildScope } from './localGuildScope';
import * as dotenv from 'dotenv';
import { initLocalDiagnostics } from './observability/localDiagnostics';

dotenv.config();
if (process.env.NODE_ENV === 'production')
  throw new Error('The guild-scoped development entry cannot run in production mode.');
const guildId = process.env.DRASIL_DEV_GUILD_ID;
if (!guildId) throw new Error('Set DRASIL_DEV_GUILD_ID before starting the local bot.');
setLocalGuildScope(guildId);
process.env.LANGFUSE_TRACING_ENABLED = 'false';
process.env.POSTHOG_PRODUCT_ANALYTICS_ENABLED = 'false';
initLocalDiagnostics();
console.log(
  `[local-diagnostics] DEVELOPMENT ONLY; pid=${process.pid}; guild=${guildId}; gateway dispatch and commands scoped; workers use all configured DB rows; remote telemetry disabled`
);
async function startDevelopment(): Promise<void> {
  if (process.env.DRASIL_SANDBOX === 'true') {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    if (
      databaseUrl.hostname !== '127.0.0.1' ||
      databaseUrl.port !== '55434' ||
      databaseUrl.pathname !== '/drasil_sandbox' ||
      databaseUrl.searchParams.size !== 1 ||
      databaseUrl.searchParams.get('schema') !== 'public'
    )
      throw new Error('The sandbox bot requires its owned local database.');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      const servers = await pool.query<{ guild_id: string }>('SELECT guild_id FROM servers');
      if (servers.rows.some((server) => server.guild_id !== guildId))
        throw new Error('The sandbox bot database contains an out-of-scope guild.');
    } finally {
      await pool.end();
    }
  }
  await import('./index');
}
void startDevelopment().catch((error: unknown) => {
  console.error('Development startup failed:', error);
  process.exitCode = 1;
});
