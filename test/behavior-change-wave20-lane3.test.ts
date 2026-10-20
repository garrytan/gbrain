/**
 * Wave 20 review: the lane-3 spend changes each carry a BEHAVIOR_CHANGES row
 * that says what now costs money, so the upgrade notice warns before the
 * first paid run.
 */
import { describe, expect, test } from 'bun:test';
import { BEHAVIOR_CHANGES } from '../src/core/behavior-change-notice.ts';

const rows = BEHAVIOR_CHANGES.map((c) => String(c.text));
const find = (needle: string) => rows.filter((t) => t.includes(needle));

describe('wave 20 lane 3 spend rows', () => {
  test('a stored DB-plane chat_model now takes effect and can change the model and spend', () => {
    const [row] = find('database-plane `chat_model`');
    expect(row).toBeDefined();
    expect(row).toContain('before, the gateway ignored');
    expect(row).toMatch(/change which model runs/);
    expect(row).toMatch(/spend/);
  });

  test('#6984: embed --max-usd prices with pricing.overrides and can now spend up to the cap', () => {
    const [row] = find('(#6984)');
    expect(row).toBeDefined();
    expect(row).toContain('pricing.overrides');
    expect(row).toContain('no_pricing');
    expect(row).toMatch(/spend up to the cap/);
  });

  test('#6959: restamp-only vectors are left out of paid migration estimates and approvals', () => {
    const [row] = find('(#6959)');
    expect(row).toBeDefined();
    expect(row).toMatch(/estimate/);
    expect(row).toMatch(/approv/);
  });
});
