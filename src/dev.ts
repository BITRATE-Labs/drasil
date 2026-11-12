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
void import('./index');
