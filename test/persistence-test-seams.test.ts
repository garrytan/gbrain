/**
 * Persistence test seams restore production defaults.
 *
 * Protects: every timing seam the test corpus shortens (maintenance publish
 * wait, embedding-claim renewal interval, connector wait budget) returns to
 * its production value after a test restores it, so a shortened budget never
 * leaks into a later file that shares the shard process.
 * Fails when: a setter stops returning a working restore function, a restore
 * resets to a stale value instead of the previous one, or a production
 * default changes without its tests noticing.
 * Why new: the seams were bare setters with `null` resets; nothing checked
 * the restored value.
 * Seam: the seams under test.
 */
import { afterAll, expect, test } from 'bun:test';
import { MAINTENANCE_PUBLISH_WAIT_MS, MAINTENANCE_WRITE_WAIT_MS, MaintenanceWriteWait, __setMaintenanceWriteWaitForTests, maintenancePublishWaitMs } from '../src/core/persistence/maintenance-wait.ts';
import { EFFECT_RENEWAL_INTERVAL_MS, __setEffectRenewalIntervalForTests, effectRenewalInterval } from '../src/core/persistence/effects.ts';
import { CONNECTOR_WAIT_BUDGET_MS, connectorWaitBudget } from '../src/core/persistence/connector-sync.ts';
import { createConnectorFixture, withPausedOwnerBudget } from './helpers/connector-fixture.ts';

function expectProductionDefaults(): void {
  expect(maintenancePublishWaitMs()).toBe(MAINTENANCE_PUBLISH_WAIT_MS);
  expect(new MaintenanceWriteWait().ms()).toBe(MAINTENANCE_WRITE_WAIT_MS);
  expect(effectRenewalInterval()).toBe(EFFECT_RENEWAL_INTERVAL_MS);
  expect(connectorWaitBudget.ms).toBe(CONNECTOR_WAIT_BUDGET_MS);
}

afterAll(expectProductionDefaults);

test('production defaults are the documented values', () => {
  expect([MAINTENANCE_PUBLISH_WAIT_MS, MAINTENANCE_WRITE_WAIT_MS, EFFECT_RENEWAL_INTERVAL_MS, CONNECTOR_WAIT_BUDGET_MS])
    .toEqual([5_000, 30_000, 10_000, 30_000]);
  expectProductionDefaults();
});

test('the maintenance wait seam scales both waits and nested restores unwind in order', () => {
  const outer = __setMaintenanceWriteWaitForTests(500);
  const inner = __setMaintenanceWriteWaitForTests(250);
  expect(maintenancePublishWaitMs()).toBe(250);
  expect(new MaintenanceWriteWait().ms()).toBe(250);
  inner();
  expect(maintenancePublishWaitMs()).toBe(500);
  outer();
  expectProductionDefaults();
});

test('the effect renewal seam restores the previous interval', () => {
  const outer = __setEffectRenewalIntervalForTests(1_500);
  const inner = __setEffectRenewalIntervalForTests(null);
  expect(effectRenewalInterval()).toBe(EFFECT_RENEWAL_INTERVAL_MS);
  inner();
  expect(effectRenewalInterval()).toBe(1_500);
  outer();
  expectProductionDefaults();
});

test('the connector fixture restores the production wait budget on teardown', async () => {
  const fixture = createConnectorFixture();
  await fixture.setup();
  try {
    expect(connectorWaitBudget.ms).toBe(CONNECTOR_WAIT_BUDGET_MS);
    await withPausedOwnerBudget(async () => { expect(connectorWaitBudget.ms).toBeLessThan(CONNECTOR_WAIT_BUDGET_MS); });
    expect(connectorWaitBudget.ms).toBe(CONNECTOR_WAIT_BUDGET_MS);
  } finally { await fixture.teardown(); }
  expectProductionDefaults();
}, 120_000);
