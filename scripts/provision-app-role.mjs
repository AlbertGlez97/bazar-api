import 'dotenv/config';
import pg from 'pg';
import {
  selectTestDatabase,
  selectTestMigrationDatabase,
} from './test-environment.ts';

// Idempotent provisioning of the dedicated runtime database role.
//
//   node scripts/provision-app-role.mjs dev    (npm run db:provision)
//   node scripts/provision-app-role.mjs test   (npm run db:provision:test)
//
// Connects as the owner/migrator (DATABASE_URL_MIGRATE, falling back to
// DATABASE_URL; for `test`, DATABASE_URL_TEST_MIGRATE falling back to
// DATABASE_URL_TEST) and makes the runtime role a plain, RLS-enforced role:
// NOSUPERUSER NOBYPASSRLS, DML only. Never prints passwords or connection
// strings. See doc/runtime-database-role.md.

const MIN_PASSWORD_LENGTH = 16;
const MIGRATIONS_TABLE = '_prisma_migrations';

const TARGETS = {
  dev: {
    userVar: 'APP_DB_USER',
    passwordVar: 'APP_DB_PASSWORD',
    migratorUrl: (env) => {
      const url = env.DATABASE_URL_MIGRATE || env.DATABASE_URL;
      if (!url) {
        throw new Error(
          'DATABASE_URL_MIGRATE (or DATABASE_URL as a fallback) is required: the owner connection used for provisioning',
        );
      }
      return url;
    },
  },
  test: {
    userVar: 'APP_DB_TEST_USER',
    passwordVar: 'APP_DB_TEST_PASSWORD',
    migratorUrl: (env) => {
      selectTestDatabase(env); // isolation checks on the test runtime URL
      return selectTestMigrationDatabase(env);
    },
  },
};

function log(message) {
  console.log(`[provision-app-role] ${message}`);
}

function readRuntimeCredentials(target, env = process.env) {
  const roleName = env[target.userVar]?.trim();
  const password = env[target.passwordVar];
  if (!roleName) throw new Error(`${target.userVar} is required`);
  if (!password) throw new Error(`${target.passwordVar} is required`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `${target.passwordVar} must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  return { roleName, password };
}

async function provisionAppRole(client, { roleName, password }) {
  const { rows } = await client.query(
    `SELECT current_user AS migrator, current_database() AS db,
            r.rolsuper, r.rolcreaterole
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const { migrator, db, rolsuper, rolcreaterole } = rows[0];
  if (roleName === migrator) {
    throw new Error(
      `The runtime role must differ from the migrator role ("${migrator}"); refusing to weaken or reuse the owner role`,
    );
  }
  if (!rolsuper && !rolcreaterole) {
    throw new Error(
      `The migrator role "${migrator}" cannot create roles (needs SUPERUSER or CREATEROLE). Point DATABASE_URL_MIGRATE at the owner role`,
    );
  }

  const role = client.escapeIdentifier(roleName);
  const owner = client.escapeIdentifier(migrator);
  const database = client.escapeIdentifier(db);
  const passwordLiteral = client.escapeLiteral(password);
  const attributes =
    'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';

  const existing = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [roleName],
  );
  if (existing.rowCount === 0) {
    await client.query(
      `CREATE ROLE ${role} WITH ${attributes} PASSWORD ${passwordLiteral}`,
    );
    log(`created role ${roleName}`);
  } else {
    await client.query(
      `ALTER ROLE ${role} WITH ${attributes} PASSWORD ${passwordLiteral}`,
    );
    log(`updated role ${roleName} (attributes forced, password rotated)`);
  }

  const statements = [
    [
      `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
      `granted CONNECT on database ${db}`,
    ],
    [
      `GRANT USAGE ON SCHEMA public TO ${role}`,
      'granted USAGE on schema public',
    ],
    [
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      'granted SELECT, INSERT, UPDATE, DELETE on all tables in public',
    ],
    [
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      'granted USAGE, SELECT on all sequences in public',
    ],
    [
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      `default privileges: tables created by ${migrator} are granted automatically`,
    ],
    [
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
      `default privileges: sequences created by ${migrator} are granted automatically`,
    ],
  ];
  for (const [sql, message] of statements) {
    await client.query(sql);
    log(message);
  }

  const migrations = await client.query(
    `SELECT to_regclass('public.${MIGRATIONS_TABLE}') IS NOT NULL AS present`,
  );
  if (migrations.rows[0].present) {
    await client.query(
      `REVOKE ALL ON TABLE public.${client.escapeIdentifier(MIGRATIONS_TABLE)} FROM ${role}`,
    );
    log(`revoked all on ${MIGRATIONS_TABLE} from ${roleName}`);
  } else {
    log(
      `${MIGRATIONS_TABLE} does not exist yet; re-run this script after the first migration to revoke it`,
    );
  }
}

async function main() {
  const targetName = process.argv[2];
  const target = TARGETS[targetName];
  if (!target) {
    throw new Error('Usage: provision-app-role.mjs <dev|test>');
  }
  const credentials = readRuntimeCredentials(target);
  const client = new pg.Client({
    connectionString: target.migratorUrl(process.env),
  });
  await client.connect();
  try {
    log(`target: ${targetName}`);
    await provisionAppRole(client, credentials);
    log('done');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // Only the message: never echo connection strings or passwords.
  console.error(`[provision-app-role] FAILED: ${error.message}`);
  process.exitCode = 1;
});
