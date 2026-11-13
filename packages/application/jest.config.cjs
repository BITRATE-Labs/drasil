module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Keep Windows worktree paths out of glob expansion in Jest 29.
  testMatch: ['**/src/**/*.test.ts'],
  clearMocks: true,
};
