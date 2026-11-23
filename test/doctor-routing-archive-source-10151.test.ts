/**
 * source_routing_health and the conversation archive's empty target source (#10151).
 *
 * Protects: the archive's configured target source (default `conversations`)
 * and its owner-only twin are not reported as a routing collapse while they
 * hold zero pages; any other zero-page source still warns.
 * Fails when: the exemption is dropped or widened to every empty source.
 * Seams: duck-typed engine answering the check's queries.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkSourceRoutingHealth } from '../src/commands/doctor.ts';

function fakeEngine(ids: string[], archiveSource: string | null): BrainEngine {
  return {
    getConfig: async () => archiveSource,
    executeRaw: async (sql: string) => {
      if (/shared_skill_packs/.test(sql)) return [];
      if (/FROM pages/.test(sql)) return [{ n: '0' }];
      return ids.map((id) => ({ id }));
    },
  } as unknown as BrainEngine;
}

describe('checkSourceRoutingHealth and the archive source (#10151)', () => {
  test('the default empty conversations source does not warn', async () => {
    const r = await checkSourceRoutingHealth(fakeEngine(['conversations'], null));
    expect(r.status).toBe('ok');
  });

  test('a configured archive source and its owner twin do not warn', async () => {
    const r = await checkSourceRoutingHealth(fakeEngine(['chats', 'chats-owner'], 'chats'));
    expect(r.status).toBe('ok');
  });

  test('another empty source still warns', async () => {
    const r = await checkSourceRoutingHealth(fakeEngine(['conversations', 'lonely'], null));
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/zero pages: lonely\./);
  });
});
