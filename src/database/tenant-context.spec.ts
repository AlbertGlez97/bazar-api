import {
  isInsideManagedTransaction,
  runInFreshTenantScope,
  withManagedTransactionFlag,
} from './tenant-context.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('withManagedTransactionFlag', () => {
  it('is off by default', () => {
    expect(isInsideManagedTransaction()).toBe(false);
    runInFreshTenantScope(() => {
      expect(isInsideManagedTransaction()).toBe(false);
    });
  });

  it('stays on across awaits until the callback settles, then turns off', async () => {
    await runInFreshTenantScope(async () => {
      const seen = await withManagedTransactionFlag(async () => {
        const before = isInsideManagedTransaction();
        await tick();
        const after = isInsideManagedTransaction();
        return [before, after];
      });
      expect(seen).toEqual([true, true]);
      expect(isInsideManagedTransaction()).toBe(false);
    });
  });

  it('does not leak into a concurrent branch of the same request', async () => {
    await runInFreshTenantScope(async () => {
      const managed = withManagedTransactionFlag(async () => {
        await tick();
        return isInsideManagedTransaction();
      });
      const standalone = (async () => {
        await tick();
        return isInsideManagedTransaction();
      })();
      expect(await managed).toBe(true);
      expect(await standalone).toBe(false);
    });
  });

  it('restores the previous value when nested', async () => {
    await runInFreshTenantScope(async () => {
      await withManagedTransactionFlag(async () => {
        await withManagedTransactionFlag(async () => {
          await tick();
        });
        expect(isInsideManagedTransaction()).toBe(true);
      });
      expect(isInsideManagedTransaction()).toBe(false);
    });
  });
});
