import 'reflect-metadata';

import { truncateAllTables, disconnectPrismaClient } from './testDb';

const shouldUseDatabase = process.env.JEST_INTEGRATION === '1';

if (shouldUseDatabase) {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await disconnectPrismaClient();
  });
}
