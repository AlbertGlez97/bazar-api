/**
 * Postgres never applies row-level security to a SUPERUSER or BYPASSRLS
 * role, not even to tables with FORCE ROW LEVEL SECURITY. A connection
 * with either flag would silently turn every tenant policy into a no-op,
 * so the app refuses to run on it instead of "working" without isolation.
 */
export interface RoleFlagsClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

interface RoleFlags {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

const ROLE_FLAGS_QUERY =
  'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user';

export async function assertRlsEnforcingRole(
  client: RoleFlagsClient,
): Promise<void> {
  const rows = await client.$queryRawUnsafe<RoleFlags[]>(ROLE_FLAGS_QUERY);
  const role = rows[0];
  if (!role) {
    throw new Error(
      'Refusing to start: could not inspect the database connection role in pg_roles, so row-level security enforcement cannot be confirmed.',
    );
  }
  const offending = [
    role.rolsuper ? 'SUPERUSER' : undefined,
    role.rolbypassrls ? 'BYPASSRLS' : undefined,
  ].filter((flag) => flag !== undefined);
  if (offending.length === 0) return;
  throw new Error(
    `Refusing to start: the database connection role "${role.rolname}" has ${offending.join(' and ')}. ` +
      'Postgres never applies row-level security to such roles (FORCE included), so tenant isolation would not be enforced by the database. ' +
      'Connect with the dedicated runtime role (NOSUPERUSER NOBYPASSRLS): run "npm run db:provision" and point DATABASE_URL at that role; ' +
      'keep the owner role only in DATABASE_URL_MIGRATE. See doc/runtime-database-role.md.',
  );
}
