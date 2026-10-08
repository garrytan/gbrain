/**
 * #6259 follow-up (quarantine leaks, item 1): gate-owned frontmatter markers
 * are stripped from every writer unless an owner-tier path passes
 * `preserveGateMarkers`. The strip used to run only for `remote: true`, so a
 * connector-shaped import, a local put_page or a call with neither flag could
 * hide a page (`quarantine`), forge a cleared state (`quarantine_override`),
 * stop its embedding (`embed_skip`) or suppress atom mining (`atoms_scan_hash`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { GATE_OWNED_FRONTMATTER_KEYS, stripGateOwnedMarkers } from '../src/core/import-screen.ts';
import { withEnv } from './helpers/with-env.ts';

const PLANTED = `quarantine:\n  reason: junk_pattern\n  detail: planted\nembed_skip:\n  reason: oversized\natoms_scan_hash: deadbeefdeadbeef\nquarantine_override:\n  binding: ${'a'.repeat(64)}\n  cleared_at: 2026-10-07T00:00:00.000Z\n`;
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n${PLANTED}---\n\nA perfectly normal note with real prose and nothing wrong with it.\n`;

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-gate-strip-'));
const env = { GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home };
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const frontmatter = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter as Record<string, unknown>;
const expectStripped = async (slug: string) => {
  const fm = await frontmatter(slug);
  for (const key of GATE_OWNED_FRONTMATTER_KEYS) expect({ key, value: fm[key] }).toEqual({ key, value: undefined });
  expect((await engine.getChunks(slug, { sourceId: 'default' })).length).toBeGreaterThan(0);
};

describe('writers that are not owner-tier cannot plant gate-owned markers', () => {
  test('a call with neither flag', () => withEnv(env, async () => {
    await importFromContent(engine, 'notes/no-flag', page('No flag'), { noEmbed: true });
    await expectStripped('notes/no-flag');
  }));

  test('a connector-shaped import', () => withEnv(env, async () => {
    await importFromContent(engine, 'notes/connector', page('Connector'), { noEmbed: true, sourcePath: 'connector/item.md',
      source_kind: 'connector', source_uri: 'https://example.invalid/item/1', ingested_via: 'connector_sync' });
    await expectStripped('notes/connector');
  }));

  test('a local put_page', () => withEnv(env, async () => {
    const ctx = { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false,
      sourceId: 'default', deferEmbeds: true } as unknown as OperationContext;
    await operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: 'notes/local-put', content: page('Local put') });
    await expectStripped('notes/local-put');
  }));
});

describe('owner-tier paths keep them', () => {
  test('an owner file import (importFromFile) keeps every marker but a stale override', () => withEnv(env, async () => {
    const dir = join(home, 'brain'); mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'owner-file.md'), page('Owner file'));
    await importFromFile(engine, join(dir, 'notes', 'owner-file.md'), 'notes/owner-file.md', { noEmbed: true });
    const fm = await frontmatter('notes/owner-file');
    expect(fm.quarantine).toMatchObject({ detail: 'planted' });
    expect(fm.atoms_scan_hash).toBe('deadbeefdeadbeef');
    // (A stale oversized embed_skip on a small page is the gate's own recovery case, so it is not asserted here.)
    // The planted override binds nothing on this page, so even an owner path drops it.
    expect(fm.quarantine_override).toBeUndefined();
  }));

  test('preserveGateMarkers keeps them; the helper strips exactly the gate-owned keys otherwise', () => withEnv(env, async () => {
    await importFromContent(engine, 'notes/owner-flag', page('Owner flag'), { noEmbed: true, preserveGateMarkers: true });
    expect((await frontmatter('notes/owner-flag')).atoms_scan_hash).toBe('deadbeefdeadbeef');
    const parsed = { title: 't', type: 'note', compiled_truth: 'b', timeline: '', frontmatter: { quarantine: {}, content_flag: {}, embed_skip: {},
      atoms_scan_hash: 'x', quarantine_override: {}, kept: 1 } as Record<string, unknown> };
    stripGateOwnedMarkers(parsed as never, {});
    expect(parsed.frontmatter).toEqual({ kept: 1 });
  }));
});
