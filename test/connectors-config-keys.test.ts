/**
 * connectors-config-keys.test.ts — pure staleness gate + truthiness + key builders.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoSyncKey,
  isConnectorSyncStale,
  isTruthy,
  watermarkKey,
} from '../src/core/connectors/config-keys.ts';

describe('isConnectorSyncStale (pure, now injected)', () => {
  const floor = 1440; // minutes = 1 day
  const now = 10_000_000_000_000;
  test('no prior sync → stale', () => {
    expect(isConnectorSyncStale(null, now, floor)).toBe(true);
    expect(isConnectorSyncStale(undefined, now, floor)).toBe(true);
    expect(isConnectorSyncStale('not-a-date', now, floor)).toBe(true);
  });
  test('synced within the floor → NOT stale', () => {
    const recent = new Date(now - 60 * 60_000).toISOString(); // 1h ago
    expect(isConnectorSyncStale(recent, now, floor)).toBe(false);
  });
  test('synced longer than the floor → stale', () => {
    const old = new Date(now - 2 * 1440 * 60_000).toISOString(); // 2 days ago
    expect(isConnectorSyncStale(old, now, floor)).toBe(true);
  });
});

describe('isTruthy', () => {
  test.each(['1', 'true', 'TRUE', 'yes', 'on'])('%s → true', (v) => expect(isTruthy(v)).toBe(true));
  test.each(['0', 'false', 'no', 'off', '', null, undefined])('%s → false', (v) => expect(isTruthy(v as string)).toBe(false));
});

describe('key builders', () => {
  test('per-provider keys are namespaced', () => {
    expect(autoSyncKey('chatgpt')).toBe('connectors.chatgpt.auto_sync');
    expect(watermarkKey('claude')).toBe('connectors.claude.watermark_iso');
  });
});
