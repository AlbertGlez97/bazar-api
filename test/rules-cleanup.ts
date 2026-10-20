import pg from 'pg';
import { selectTestMigrationDatabase } from '../scripts/test-environment.js';

/**
 * Test-only cleanup of finance rule sets. Their triggers reject DELETE (and
 * approvals of a decided set), so a test cannot remove its own fixtures through
 * the application connection. Like `purgeAgreementData`, this connects as the
 * table owner of the isolated bazar_test database and turns the two guards off
 * inside ONE transaction, so they are never left off for another session.
 */
export async function purgeRuleData(contextIds: string[]): Promise<void> {
  if (!contextIds.length) return;
  const client = new pg.Client({
    connectionString: selectTestMigrationDatabase(),
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE "FinanceRuleSet" DISABLE TRIGGER "FinanceRuleSet_guard"');
    await client.query('ALTER TABLE "FinanceRuleApproval" DISABLE TRIGGER "FinanceRuleApproval_guard"');
    for (const contextId of contextIds) {
      await client.query("SELECT set_config('app.context_id', $1, true)", [contextId]);
      await client.query('DELETE FROM "FinanceRuleReminder" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "FinanceRuleApproval" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "FinanceRuleSet" WHERE "contextId" = $1', [contextId]);
    }
    await client.query('ALTER TABLE "FinanceRuleSet" ENABLE TRIGGER "FinanceRuleSet_guard"');
    await client.query('ALTER TABLE "FinanceRuleApproval" ENABLE TRIGGER "FinanceRuleApproval_guard"');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
