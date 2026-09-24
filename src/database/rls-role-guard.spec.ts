import {
  assertRlsEnforcingRole,
  type RoleFlagsClient,
} from './rls-role-guard.js';

function clientReturning(rows: unknown[]) {
  const $queryRawUnsafe = vi.fn().mockResolvedValue(rows);
  return {
    client: { $queryRawUnsafe } as unknown as RoleFlagsClient,
    $queryRawUnsafe,
  };
}

describe('assertRlsEnforcingRole', () => {
  it('passes for a role that is neither superuser nor BYPASSRLS', async () => {
    const { client, $queryRawUnsafe } = clientReturning([
      { rolname: 'bazar_app', rolsuper: false, rolbypassrls: false },
    ]);
    await expect(assertRlsEnforcingRole(client)).resolves.toBeUndefined();
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect($queryRawUnsafe.mock.calls[0]?.[0]).toContain('current_user');
  });

  it('rejects a superuser role and names the flag and the fix', async () => {
    const { client } = clientReturning([
      { rolname: 'bazar_dev', rolsuper: true, rolbypassrls: false },
    ]);
    const error = await assertRlsEnforcingRole(client).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"bazar_dev"');
    expect((error as Error).message).toContain('has SUPERUSER.');
    expect((error as Error).message).toContain('npm run db:provision');
    expect((error as Error).message).toContain('doc/runtime-database-role.md');
  });

  it('rejects a BYPASSRLS role', async () => {
    const { client } = clientReturning([
      { rolname: 'bazar_dev', rolsuper: false, rolbypassrls: true },
    ]);
    await expect(assertRlsEnforcingRole(client)).rejects.toThrow(/BYPASSRLS/);
  });

  it('names both flags when the role has both', async () => {
    const { client } = clientReturning([
      { rolname: 'bazar_dev', rolsuper: true, rolbypassrls: true },
    ]);
    await expect(assertRlsEnforcingRole(client)).rejects.toThrow(
      /SUPERUSER.*BYPASSRLS/s,
    );
  });

  it('fails closed when the role cannot be inspected', async () => {
    const { client } = clientReturning([]);
    await expect(assertRlsEnforcingRole(client)).rejects.toThrow(
      /could not inspect/i,
    );
  });
});
