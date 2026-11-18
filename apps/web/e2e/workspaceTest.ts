import { test as base } from '@playwright/test';
import { workspaceFixtures } from './workspaceFixtures';

interface WorkspaceTestFixtures {
  workspaceReset: void;
}

interface WorkspaceWorkerFixtures {
  workspaceProvider: void;
}

export const fixtures = workspaceFixtures();
export const test = base.extend<WorkspaceTestFixtures, WorkspaceWorkerFixtures>({
  workspaceReset: [
    async ({ context, baseURL }, use) => {
      await fixtures.reset(context, baseURL!);
      await use();
    },
    { auto: true },
  ],
  workspaceProvider: [
    // Playwright requires a destructured fixture argument even without dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      try {
        await fixtures.start();
        await use();
      } finally {
        await fixtures.stop();
      }
    },
    { scope: 'worker', auto: true },
  ],
});

export { expect } from '@playwright/test';
