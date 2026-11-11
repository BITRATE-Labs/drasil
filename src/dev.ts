import * as dotenv from 'dotenv';
import { initLocalDiagnostics } from './observability/localDiagnostics';

dotenv.config();
process.env.LANGFUSE_TRACING_ENABLED = 'false';
process.env.POSTHOG_PRODUCT_ANALYTICS_ENABLED = 'false';
initLocalDiagnostics();
console.log(`[local-diagnostics] pid=${process.pid}; remote telemetry disabled; real bot startup`);
void import('./index');
