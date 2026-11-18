import { expect, it } from 'vitest';
import { workspaceFixtures } from '../e2e/workspaceFixtures';

it.each([
  'postgresql://user@remote/drasil_sandbox_web?schema=public',
  'postgresql://user@127.0.0.1:55434/drasil_sandbox?schema=public',
  'postgresql://user@127.0.0.1:55433/drasil_mcp_test?schema=public',
  'postgresql://user@127.0.0.1:55434/drasil_sandbox_web?schema=other',
  'postgresql://user@127.0.0.1:55434/drasil_sandbox_web?schema=public&host=remote',
])('rejects a fixture database outside the owned web sandbox (%s)', (sandboxDatabaseUrl) => {
  expect(() => workspaceFixtures({ sandboxDatabaseUrl, preserveData: true })).toThrow(
    'Sandbox fixtures require their owned local web database.'
  );
});
