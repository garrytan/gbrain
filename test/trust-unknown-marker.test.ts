/** #6550: an unclassified (`unknown`) stored tier never becomes a permanent `trust_tier: unknown` marker. */
import { expect, test } from 'bun:test';
import { pageWriteTrust, stampPageTrustMarker } from '../src/core/trust/page-write.ts';

const row = { id: 'r1', operation: 'put_page', authority: { remote: true }, intent: {} } as never;

test('an agent write to an unclassified legacy page stamps the writer tier, so the round trip keeps it', () => {
  const first = pageWriteTrust(row, {});
  expect(first?.tier).toBe('agent_written');
  const fm: Record<string, unknown> = {};
  stampPageTrustMarker(row, fm, first, 'unknown');
  expect(fm.trust_tier).toBe('agent_written');
  expect(pageWriteTrust(row, fm)?.tier).toBe('agent_written');
});

test('a classified lower stored tier and an explicit unknown marker still lower the marker', () => {
  const trust = pageWriteTrust(row, {});
  const external: Record<string, unknown> = {};
  stampPageTrustMarker(row, external, trust, 'external_untrusted');
  expect(external.trust_tier).toBe('external_untrusted');
  const explicit: Record<string, unknown> = { trust_tier: 'unknown' };
  const capped = pageWriteTrust(row, explicit);
  expect(capped?.tier).toBe('unknown');
  stampPageTrustMarker(row, explicit, capped, 'unknown');
  expect(explicit.trust_tier).toBe('unknown');
});
