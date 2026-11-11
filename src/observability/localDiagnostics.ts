import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider } from '@langfuse/tracing';

const METADATA_KEYS = [
  'request_sent',
  'request_outcome',
  'usage_status',
  'cost_source',
  'response_status',
  'response_error_code',
  'response_incomplete_reason',
  'response_id',
  'request_id',
  'output_item_count',
  'output_text_count',
  'refusal_detected',
  'is_fallback',
  'error_category',
  'http_status',
];
const USAGE_KEYS = ['input', 'input_cached_tokens', 'output', 'output_reasoning_tokens', 'total'];

/** Local receipts omit raw span names, evidence and arbitrary observation attributes. */
export function initLocalDiagnostics(
  write: (line: string) => void = (line) => console.log(line)
): () => Promise<void> {
  const processor: SpanProcessor = {
    onStart: () => undefined,
    onEnd: (span) => {
      if (span.attributes['drasil.observation'] !== true) return;
      try {
        const metadata: Record<string, string | number | boolean> = {};
        for (const key of METADATA_KEYS) {
          const value = span.attributes[`langfuse.observation.metadata.${key}`];
          if (
            typeof value === 'string' &&
            (key === 'response_id' || key === 'request_id'
              ? /^[A-Za-z0-9_-]{1,200}$/.test(value)
              : /^[a-z0-9_]{1,64}$/.test(value))
          )
            metadata[key] = value;
          else if (
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          )
            metadata[key] = value;
        }
        const usage: Record<string, number> = {};
        const encoded = span.attributes['langfuse.observation.usage_details'];
        if (typeof encoded === 'string') {
          const parsed: unknown = JSON.parse(encoded);
          if (typeof parsed === 'object' && parsed !== null) {
            for (const key of USAGE_KEYS) {
              if (!(key in parsed)) continue;
              const value: unknown = Reflect.get(parsed, key);
              if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
                usage[key] = value;
            }
          }
        }
        write(
          JSON.stringify({
            event: 'local_observation',
            pid: process.pid,
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: span.parentSpanContext?.spanId,
            elapsedMs: span.duration[0] * 1000 + span.duration[1] / 1_000_000,
            metadata,
            usage,
          })
        );
      } catch {
        // A failed local receipt must not change or replay the observed operation.
      }
    },
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  setLangfuseTracerProvider(provider);
  return async () => {
    await provider.shutdown();
    manager.disable();
    context.disable();
    trace.disable();
  };
}
