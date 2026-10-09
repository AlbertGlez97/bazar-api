import pg from 'pg';
import { selectTestMigrationDatabase } from '../scripts/test-environment.js';

const IMMUTABLE_TABLES = [
  'DistributionAgreementParticipant',
  'DistributionAgreementReversal',
  'DistributionAgreement',
] as const;

/**
 * Test-only cleanup of distribution agreements.
 *
 * The three agreement tables reject UPDATE and DELETE for the runtime role by
 * trigger, so a test cannot delete its own fixtures through the application
 * connection. This helper connects as the table owner (the migrator URL of the
 * isolated bazar_test database, never the runtime role), disables the
 * immutability triggers inside ONE transaction, deletes the given contexts'
 * rows and re-enables the triggers before committing, so the guard is never
 * left off for any other session.
 */
export async function purgeAgreementData(contextIds: string[]): Promise<void> {
  if (!contextIds.length) return;
  const client = new pg.Client({
    connectionString: selectTestMigrationDatabase(),
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const table of IMMUTABLE_TABLES)
      await client.query(
        `ALTER TABLE "${table}" DISABLE TRIGGER "${table}_immutable"`,
      );
    for (const contextId of contextIds) {
      await client.query("SELECT set_config('app.context_id', $1, true)", [
        contextId,
      ]);
      await client.query(
        'DELETE FROM "DistributionAgreementReversal" WHERE "contextId" = $1',
        [contextId],
      );
      await client.query(
        'DELETE FROM "DistributionAgreementParticipant" WHERE "contextId" = $1',
        [contextId],
      );
      // Replacement links are RESTRICT references between agreements.
      await client.query(
        'UPDATE "DistributionAgreement" SET "replacesAgreementId" = NULL WHERE "contextId" = $1',
        [contextId],
      );
      await client.query(
        'DELETE FROM "DistributionAgreement" WHERE "contextId" = $1',
        [contextId],
      );
      await client.query(
        'DELETE FROM "DistributionAgreementCounter" WHERE "contextId" = $1',
        [contextId],
      );
    }
    for (const table of IMMUTABLE_TABLES)
      await client.query(
        `ALTER TABLE "${table}" ENABLE TRIGGER "${table}_immutable"`,
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
