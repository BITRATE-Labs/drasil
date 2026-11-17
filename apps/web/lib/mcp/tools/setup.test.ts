import { describe, expect, it, vi } from 'vitest';
import { createSetupTools } from './setup';
import { mcpWorkflowManifest } from '../manifest';

describe('setup and guild operations tools', () => {
  it('registers every setup and operations workflow with its canonical strict parser', () => {
    const tools = createSetupTools({ service: { submit: vi.fn() } });
    expect(tools.map((tool) => tool.toolName)).toEqual(
      mcpWorkflowManifest
        .filter((entry) => ['setup', 'operations'].includes(entry.family))
        .map((entry) => entry.toolName)
    );
  });
});

it('keeps shipped apply identifier but rejects coarse boolean approval and client effect bodies', () => {
  const tool = mcpWorkflowManifest.find((entry) => entry.id === 'apply_case_role_lockdown')!;
  expect(tool.inputSchema.safeParse({ unsyncAllowedChannels: true }).success).toBe(false);
  expect(
    tool.inputSchema.safeParse({
      auditRequestId: 'audit',
      auditRevision: 'r1',
      selectedFixIds: ['repair'],
      effects: [],
    }).success
  ).toBe(false);
  expect(
    tool.inputSchema.safeParse({
      auditRequestId: 'audit',
      auditRevision: 'r1',
      selectedFixIds: ['repair'],
    }).success
  ).toBe(true);
  const tools = createSetupTools({ service: { submit: vi.fn() } });
  expect(tools.some((t) => t.toolName === 'drasil_apply_case_role_lockdown')).toBe(true);
});
