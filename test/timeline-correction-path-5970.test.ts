/**
 * #5970 (wave 15 P2.7): the timeline correction path is named at the call
 * site. There is no update/remove verb on purpose: the page body is the
 * system of record for timeline rows, so a bullet edited through `edit_page`
 * (with the page's `expected_revision`) refreshes or deletes its row. The op
 * descriptions say so, and the `add_timeline_entry` receipt returns the
 * rendered bullet so the caller can find the exact line to edit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall as dispatchToolCallImpl } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';

const SOURCE = 'default';
const OPTS = { remote: true, sourceId: SOURCE } as const;
const SLUG = 'notes/timeline-correction-example';
const BODY = 'Synthetic note body for the timeline correction path.';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-timeline-correction-'));

async function dispatchToolCall(...args: Parameters<typeof dispatchToolCallImpl>) {
  return withEnv({
    GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_EMBEDDING_MODEL: undefined,
  }, async () => {
    try { return await dispatchToolCallImpl(...args); }
    finally { await disposePersistenceConsumer(args[0]); }
  });
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
  await engine.putPage(SLUG, { type: 'note', title: 'Timeline correction fixture', compiled_truth: BODY, timeline: '' }, { sourceId: SOURCE });
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('#5970 timeline correction path', () => {
  test('both timeline op descriptions name the page-edit route with expected_revision', () => {
    const byName = new Map(operations.map(op => [op.name, op]));
    for (const name of ['add_timeline_entry', 'get_timeline']) {
      const description = byName.get(name)!.description;
      expect(description).toContain('edit_page');
      expect(description).toContain('expected_revision');
      expect(description).toMatch(/change or remove/i);
    }
  });

  test('the add receipt returns the rendered bullet, which is the exact line in the page, and editing that line corrects the row', async () => {
    const added = await dispatchToolCall(engine, 'add_timeline_entry', { slug: SLUG, date: '2026-03-02', summary: 'Signed the example lease', source: 'manual' }, OPTS);
    expect(added.isError).toBeUndefined();
    const receipt = payload(added);
    expect(receipt).toMatchObject({ status: 'ok', entry: { date: '2026-03-02', source: 'manual', summary: 'Signed the example lease' } });
    expect(receipt.bullet).toBe('- **2026-03-02** | manual — Signed the example lease');

    const read = payload(await dispatchToolCall(engine, 'get_page', { slug: SLUG, include_content: true }, OPTS)) as { revision: string; content: string };
    expect(read.content).toContain(receipt.bullet as string);

    const edited = await dispatchToolCall(engine, 'edit_page', {
      slug: SLUG, expected_revision: read.revision,
      edits: [{ old_text: receipt.bullet as string, new_text: '- **2026-03-02** | manual — Signed the example sublease' }],
    }, OPTS);
    expect(edited.isError).toBeUndefined();

    const timeline = payload(await dispatchToolCall(engine, 'get_timeline', { slug: SLUG }, OPTS)) as Array<{ summary: string }> | { entries?: Array<{ summary: string }> };
    const entries = Array.isArray(timeline) ? timeline : (timeline.entries ?? []);
    expect(entries.map(e => e.summary)).toEqual(['Signed the example sublease']);

    // Replaying the original entry after the correction reports the duplicate identity, not a second row.
    const replay = await dispatchToolCall(engine, 'add_timeline_entry', { slug: SLUG, date: '2026-03-02', summary: 'Signed the example sublease', source: 'manual' }, OPTS);
    expect(payload(replay)).toMatchObject({ status: 'skipped', reason: 'duplicate', bullet: '- **2026-03-02** | manual — Signed the example sublease' });
  });
});
