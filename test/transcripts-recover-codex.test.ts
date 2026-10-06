/**
 * D15 recovery for #5163. A brain that imported codex 0.154 rollouts before
 * the fix holds assistant-only conversation pages, and its `--since last`
 * watermark is already past them, so the fixed parser alone never restores
 * the user turns. `gbrain transcripts recover codex` previews, then restores
 * them from the retained rollouts; a rerun neither duplicates pages nor
 * re-imports, nothing touches the watermark, and a session whose rollout is
 * gone is reported as unrecoverable.
 *
 * The pre-fix import is seeded by importing the assistant-only rendering the
 * old parser produced (same slug, same frontmatter id), then recording the
 * watermark the way a clean `--since last` run does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { renderSessionParts } from '../src/core/transcripts/render.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { recordCompleted, loadOpCheckpoint } from '../src/core/op-checkpoint.ts';
import { applyCodexRecovery, planCodexRecovery } from '../src/core/transcripts/recover.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const FIXTURE_0154 = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout-0154.jsonl');
const SESSION = '01a0a325-0407-7fe2-867a-c98e6e63a000';

let engine: PGLiteEngine;
let tmp: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gb-recover-'));
});

/** What the pre-fix parser imported: the session with its user turns missing. */
async function seedPreFixImport(sessionId: string, rolloutPath: string): Promise<string> {
  const session: ParsedSession = {
    meta: { harness: 'codex', sessionId, cwd: '/home/alice-example/agent-workspace', startedAt: '2026-10-01T09:00:00.000Z', raw: { session_id: sessionId } },
    messages: [
      { role: 'assistant', timestamp: '2026-10-01T09:00:06.000Z', text: 'fund-a led the widget-co seed.' },
      { role: 'assistant', timestamp: '2026-10-01T09:00:09.000Z', text: 'Noted: bridge check-in every Thursday.' },
    ],
  };
  const rendered = renderSessionParts({ session, redactionCount: 0, imperativesFlagged: 0 } as never, { sourcePath: rolloutPath });
  for (const part of rendered.parts) {
    await importFromContent(engine, part.slug, part.content, { noEmbed: true, sourceId: 'default', source_kind: 'transcript:codex', source_uri: rolloutPath, ingested_via: 'cli:transcripts-ingest' });
  }
  return rendered.baseSlug;
}

async function body(slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1', [slug]);
  return row?.compiled_truth ?? '';
}

describe('transcripts recover codex (D15, #5163)', () => {
  test('preview names the recoverable session; apply restores its user turns; a rerun does nothing; the watermark stays put', async () => {
    const rollout = join(tmp, `rollout-2026-10-01T09-00-00-${SESSION}.jsonl`);
    copyFileSync(FIXTURE_0154, rollout);
    const slug = await seedPreFixImport(SESSION, rollout);
    const checkpointKey = { op: 'transcripts-ingest', fingerprint: 'fp-test' };
    await recordCompleted(engine, checkpointKey, ['since:2026-10-02T00:00:00.000Z']);
    expect(await body(slug)).not.toContain('**User**');

    const plan = await planCodexRecovery(engine, { sourceId: 'default', rolloutPaths: [rollout] });
    expect(plan.userless_sessions).toBe(1);
    expect(plan.recoverable).toEqual([{ session_id: SESSION, slug, rollout_path: rollout, user_turns: 2 }]);
    expect(plan.unrecoverable).toEqual([]);
    expect(await body(slug)).not.toContain('**User**'); // preview writes nothing

    const applied = await applyCodexRecovery(engine, plan, { userPatternsPath: '/nonexistent-patterns.txt' });
    expect(applied?.sessionsImported).toBe(1);
    const restored = await body(slug);
    expect(restored).toContain('**User**');
    expect(restored).toContain('Which fund led the widget-co seed round?');
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pages WHERE frontmatter->'transcript_import'->>'session_id' = $1", [SESSION]);
    expect(n).toBe(1);

    const again = await planCodexRecovery(engine, { sourceId: 'default', rolloutPaths: [rollout] });
    expect(again.userless_sessions).toBe(0);
    expect(await applyCodexRecovery(engine, again)).toBeNull();
    expect(await loadOpCheckpoint(engine, checkpointKey)).toEqual(['since:2026-10-02T00:00:00.000Z']);
    const [{ facts }] = await engine.executeRaw<{ facts: number }>('SELECT count(*)::int AS facts FROM facts');
    expect(facts).toBe(0);
  });

  test('a session whose rollout is gone is unrecoverable; one whose rollout has no user turn either stays reported', async () => {
    await seedPreFixImport('gone-session-1', join(tmp, 'rollout-gone-session-1.jsonl'));
    const assistantOnly = join(tmp, 'rollout-assistant-only.jsonl');
    writeFileSync(assistantOnly, [
      JSON.stringify({ timestamp: '2026-10-01T09:00:00.000Z', type: 'session_meta', payload: { id: 'ao-session-1', timestamp: '2026-10-01T09:00:00.000Z', cwd: '/w', cli_version: '0.154.0' } }),
      JSON.stringify({ timestamp: '2026-10-01T09:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    ].join('\n') + '\n');
    await seedPreFixImport('ao-session-1', assistantOnly);

    const plan = await planCodexRecovery(engine, { sourceId: 'default', rolloutPaths: [assistantOnly] });
    expect(plan.userless_sessions).toBe(2);
    expect(plan.recoverable).toEqual([]);
    expect(plan.unrecoverable.map((u) => u.session_id)).toEqual(['gone-session-1']);
    expect(plan.still_userless.map((u) => u.session_id)).toEqual(['ao-session-1']);
    expect(await applyCodexRecovery(engine, plan)).toBeNull();
  });

  test('another source is never read or written', async () => {
    const rollout = join(tmp, `rollout-${SESSION}.jsonl`);
    copyFileSync(FIXTURE_0154, rollout);
    await seedPreFixImport(SESSION, rollout);
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
    const plan = await planCodexRecovery(engine, { sourceId: 'other', rolloutPaths: [rollout] });
    expect(plan.userless_sessions).toBe(0);
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
