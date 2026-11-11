import OpenAI from 'openai';
import { initLocalDiagnostics } from '../../observability/localDiagnostics';
import { recordObservation, withObservation } from '../../observability/langfuse';
import { GPTService } from '../../services/GPTService';
import { sourceRef } from '../fixtures/report-intake/source-associated';

describe('local diagnostics', () => {
  let shutdown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  it('captures an incomplete SDK response without network telemetry or private content', async () => {
    const lines: string[] = [];
    shutdown = initLocalDiagnostics((line) => lines.push(line));
    const http = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_synthetic',
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          model: 'synthetic-model',
          output: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic' },
        }
      )
    );
    const result = await new GPTService(
      new OpenAI({ apiKey: 'private-token', fetch: http })
    ).extractReportIdentity({
      sources: [{ ref: sourceRef, content: { kind: 'text', text: 'private-evidence' } }],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'invalid_output' });
    expect(http).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(JSON.parse(lines[0])).toMatchObject({
      event: 'local_observation',
      pid: process.pid,
      metadata: {
        response_status: 'incomplete',
        response_incomplete_reason: 'max_output_tokens',
        response_id: 'resp_synthetic',
        request_id: 'req_synthetic',
        output_item_count: '0',
        output_text_count: '0',
        request_outcome: 'invalid_response',
        usage_status: 'reported',
      },
    });
    expect(lines.join('')).not.toMatch(/private-evidence|private-token|sourceRefs|input_image/);
  });

  it('keeps concurrent and nested observations correlated while dropping arbitrary attributes', async () => {
    const lines: string[] = [];
    shutdown = initLocalDiagnostics((line) => lines.push(line));
    const run = (): Promise<void> =>
      withObservation('private-root', 'chain', async () => {
        await withObservation('private-child', 'generation', async () => {
          await Promise.resolve();
          recordObservation('generation', {
            input: 'private-input',
            output: 'private-output',
            metadata: {
              request_outcome: 'success',
              private_field: 'private-value',
              response_status: { secret: 'private-value' },
            },
          });
        });
      });
    await Promise.all([run(), run()]);
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);
    const roots = records.filter((record) => !record.parentSpanId);
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((record) => record.traceId)).size).toBe(2);
    for (const root of roots) {
      const child = records.find((record) => record.parentSpanId === root.spanId);
      expect(child).toMatchObject({
        traceId: root.traceId,
        metadata: { request_outcome: 'success' },
      });
      expect(child.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(lines.join('')).not.toContain('private');
  });

  it('does not replay or reject an operation when its local writer fails', async () => {
    shutdown = initLocalDiagnostics(() => {
      throw new Error('disk unavailable');
    });
    const operation = jest.fn().mockResolvedValue('done');
    await expect(withObservation('test', 'generation', operation)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
