/**
 * doctor `schema_pack_active` size warning (#6432, wave 14 P1.2).
 *
 * Protects: an operator learns that a mutable pack file has grown past the
 * size a hand-written manifest ever reaches (the backslash-doubling class
 * grows a pack 2x per mutation) before every CLI process pays for loading
 * it, with the runbook that names the manual fix. Regression: the check
 * stays `ok` on a bloated pack. Existing coverage checks pack resolution,
 * not its size. No production seam: the warn bound is the documented
 * GBRAIN_SCHEMA_PACK_WARN_BYTES override.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchemaPackActive } from '../src/commands/doctor/schema-pack-checks.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let tmpHome: string;

beforeEach(() => {
  _resetPackCacheForTests();
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-pack-size-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  rmSync(tmpHome, { recursive: true, force: true });
});

const engine = { getConfig: async (key: string) => (key === 'schema_pack' ? 'mine' : null) } as unknown as BrainEngine;

function seedPack(padding: number): void {
  const dir = join(tmpHome, '.gbrain', 'schema-packs', 'mine');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), `api_version: gbrain-schema-pack-v1
name: mine
version: 1.0.0
description: a pack
extends: null
page_types:
  - name: person
    primitive: entity
    path_prefixes:
      - people/
    aliases: []
    extractable: false
    expert_routing: false
${'# '.padEnd(padding, 'x')}
`, 'utf-8');
}

describe('schema_pack_active size warning', () => {
  test('a normal-sized mutable pack is ok', async () => {
    seedPack(10);
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined, GBRAIN_SCHEMA_PACK_WARN_BYTES: '4096' }, async () => {
      const check = await checkSchemaPackActive(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('mine');
    });
  });

  test('an oversized mutable pack warns with the runbook pointer and the size', async () => {
    seedPack(6000);
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined, GBRAIN_SCHEMA_PACK_WARN_BYTES: '4096' }, async () => {
      const check = await checkSchemaPackActive(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('mine');
      expect(check.message).toContain('KiB');
      expect(check.message).toContain('schema-packs.md#oversized-pack');
      expect(check.details).toMatchObject({ code: 'schema_pack_oversized' });
    });
  });
});
