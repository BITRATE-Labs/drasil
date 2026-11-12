import { setLocalGuildScope } from './localGuildScope';
import * as dotenv from 'dotenv';
import { initLocalDiagnostics } from './observability/localDiagnostics';

dotenv.config();
const guildId = process.env.DRASIL_DEV_GUILD_ID;
if (!guildId) throw new Error('Set DRASIL_DEV_GUILD_ID before starting the local bot.');
setLocalGuildScope(guildId);
process.env.LANGFUSE_TRACING_ENABLED = 'false';
process.env.POSTHOG_PRODUCT_ANALYTICS_ENABLED = 'false';
initLocalDiagnostics();
console.log(`[local-diagnostics] pid=${process.pid}; remote telemetry disabled; real bot startup`);
void import('./index');
