jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('local development entry', () => {
  it('disables inherited remote telemetry before diagnostics and normal bootstrap', async () => {
    const previous = { ...process.env };
    process.env.DRASIL_DEV_GUILD_ID = '100000000000000001';
    process.env.LANGFUSE_TRACING_ENABLED = 'true';
    process.env.POSTHOG_PRODUCT_ANALYTICS_ENABLED = 'true';
    const init = jest.fn(() => {
      expect(process.env.LANGFUSE_TRACING_ENABLED).toBe('false');
      expect(process.env.POSTHOG_PRODUCT_ANALYTICS_ENABLED).toBe('false');
    });
    jest.doMock('../../observability/localDiagnostics', () => ({ initLocalDiagnostics: init }));
    const bootstrap = jest.fn();
    jest.doMock('../../__mocks__/index', () => {
      bootstrap();
      expect(init).toHaveBeenCalledTimes(1);
      return {};
    });
    try {
      jest.isolateModules(() => {
        require('../../dev');
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(bootstrap).toHaveBeenCalledTimes(1);
    } finally {
      process.env = previous;
      jest.dontMock('../../observability/localDiagnostics');
      jest.dontMock('../../__mocks__/index');
    }
  });
  it.each([undefined, 'invalid'])(
    'rejects missing or malformed guild scope %s before bootstrap',
    (value) => {
      const previous = process.env.DRASIL_DEV_GUILD_ID;
      if (value === undefined) delete process.env.DRASIL_DEV_GUILD_ID;
      else process.env.DRASIL_DEV_GUILD_ID = value;
      try {
        expect(() =>
          jest.isolateModules(() => {
            require('../../dev');
          })
        ).toThrow();
      } finally {
        if (previous === undefined) delete process.env.DRASIL_DEV_GUILD_ID;
        else process.env.DRASIL_DEV_GUILD_ID = previous;
      }
    }
  );
  it('rejects production mode before bootstrap', () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.DRASIL_DEV_GUILD_ID = '100000000000000001';
    try {
      expect(() =>
        jest.isolateModules(() => {
          require('../../dev');
        })
      ).toThrow(/production/i);
    } finally {
      process.env = previous;
    }
  });
});
