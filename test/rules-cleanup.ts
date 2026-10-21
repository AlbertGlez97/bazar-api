import pg from 'pg';
import { selectTestMigrationDatabase } from '../scripts/test-environment.js';

/**
 * Test-only cleanup of finance rule sets. Their triggers reject DELETE (and
 * approvals of a decided set), so a test cannot remove its own fixtures through
 * the application connection. Like `purgeAgreementData`, this connects as the
 * table owner of the isolated bazar_test database and turns the guards off
 * inside ONE transaction, so they are never left off for another session.
 * It also removes the emailed links, objections and address confirmations
 * that reference the same members.
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
    await client.query('ALTER TABLE "FinanceRuleObjection" DISABLE TRIGGER "FinanceRuleObjection_guard"');
    for (const contextId of contextIds) {
      await client.query("SELECT set_config('app.context_id', $1, true)", [contextId]);
      await client.query('DELETE FROM "FinanceRuleReminder" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "FinanceRuleApproval" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "FinanceRuleObjection" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "FinanceRuleLink" WHERE "contextId" = $1', [contextId]);
      await client.query('DELETE FROM "MemberEmailConfirmation" WHERE "contextId" = $1', [contextId]);
      // A version copied from another points at it: remove the ones nobody points at, until none is left.
      let removed = 1;
      while (removed > 0) {
        const result = await client.query(
          'DELETE FROM "FinanceRuleSet" s WHERE s."contextId" = $1 AND NOT EXISTS (SELECT 1 FROM "FinanceRuleSet" c WHERE c."basedOnId" = s."id")',
          [contextId],
        );
        removed = result.rowCount ?? 0;
      }
    }
    await client.query('ALTER TABLE "FinanceRuleSet" ENABLE TRIGGER "FinanceRuleSet_guard"');
    await client.query('ALTER TABLE "FinanceRuleApproval" ENABLE TRIGGER "FinanceRuleApproval_guard"');
    await client.query('ALTER TABLE "FinanceRuleObjection" ENABLE TRIGGER "FinanceRuleObjection_guard"');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
