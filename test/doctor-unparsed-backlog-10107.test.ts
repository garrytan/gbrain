/**
 * Protects: doctor does not prescribe paid extraction for unreadable conversation formats.
 * Fails when: type-only backlog counts unparsed pages as ready, hides read failures,
 * or loses source identity / the bounded census / opt-in model fallback.
 * Existing durable-outcome tests do not exercise real parser input eligibility.
 * Seam: real pages, parser and doctor on both storage engines; no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

for (const kind of testBackends()) {
  describe(`doctor unparsed backlog (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const local = new PGLiteEngine();
        await local.connect({}); await local.initSchema();
        engine = local; close = () => local.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      else await engine.executeRaw('DELETE FROM pages');
      await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
      await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    });
    async function put(slug: string, body: string, sourceId = 'default') {
      await engine.putPage(slug, { type: 'conversation', title: slug,
        compiled_truth: body, timeline: '', frontmatter: { date: '2026-11-20' } }, { sourceId });
    }
    const parsed = '## User\n\nHello there.\n\n## Assistant\n\nHello back.';
    test('twelve unparsed pages leave the paid backlog and name a format remedy, without completing them', async () => {
      for (let i = 0; i < 12; i++) await put(`conversations/unparsed-${i}`, 'Ordinary prose without any speaker turn labels.');
      const result = await computeConversationFactsBacklogCheck(engine);
      expect(result.details?.backlog).toBe(0);
      expect(result.details?.parse_blocked).toBe(12);
      expect(result.details?.completed).toBe(0);
      expect(result.message).not.toContain('--max-cost-usd');
      expect(result.message).toContain('speaker');
      expect(result.details?.parse_fix_hint).toContain('conversation');
      expect(await engine.executeRaw('SELECT id FROM facts')).toEqual([]);
      await put('conversations/unparsed-0', parsed);
      const repaired = await computeConversationFactsBacklogCheck(engine);
      expect(repaired.details?.backlog).toBe(1);
      expect(repaired.details?.parse_blocked).toBe(11);
    });
    test('keeps real extractable siblings and source identity while excluding only unparsed input', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('other','other') ON CONFLICT DO NOTHING");
      await put('conversations/same', 'No speaker turns.');
      await put('conversations/same', parsed, 'other');
      const result = await computeConversationFactsBacklogCheck(engine);
      expect(result.details?.backlog).toBe(1);
      expect(result.details?.parse_blocked).toBe(1);
      expect(result.details?.parse_blocked_samples).toEqual([{ source_id: 'default', slug: 'conversations/same', reason: 'no_format_line' }]);
    });
    test('an opted-in LLM fallback keeps true parser misses actionable without calling it', async () => {
      await put('conversations/fallback', 'No speaker turns.');
      await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
      const result = await computeConversationFactsBacklogCheck(engine);
      expect(result.details?.backlog).toBe(1);
      expect(result.details?.parse_blocked).toBe(0);
    });
    test('bounds body inspection and discloses unresolved remainder instead of claiming completion', async () => {
      for (let i = 0; i < 115; i++) await put(`conversations/bounded-${i}`, 'No speaker turns.');
      const result = await computeConversationFactsBacklogCheck(engine);
      expect(result.details?.parse_inspected).toBe(100);
      expect(result.details?.parse_blocked).toBe(100);
      expect(result.details?.parse_uninspected).toBe(15);
      expect(result.details?.backlog).toBe(15);
      expect(result.details?.parser_coverage).toEqual({ health: 'unknown', reason: 'bound', bound: 'rows', exact: false, limit: 100 });
      expect(result.details?.fix_hint).toBeUndefined();
      expect(result.message).not.toContain('--max-cost-usd');
      expect(result.details?.parse_blocked_samples).toHaveLength(5);
      expect(result.message).toContain('not parser-inspected');
      expect(result.message).not.toContain('all eligible pages');
    });
    test('read failures warn without certifying parse blockers or completed work, then recover', async () => {
      await put('conversations/read-error', 'No speaker turns.');
      const original = engine.getPage;
      engine.getPage = async function (slug, opts) {
        if (slug === 'conversations/read-error') throw new Error('synthetic page read failed');
        return original.call(this, slug, opts);
      };
      try {
        const result = await computeConversationFactsBacklogCheck(engine);
        expect(result.status).toBe('warn');
        expect(result.message).toContain('synthetic page read failed');
        expect(result.details?.completed).toBeUndefined();
      } finally { engine.getPage = original; }
      const recovered = await computeConversationFactsBacklogCheck(engine);
      expect(recovered.details?.parse_blocked).toBe(1);
    });
    test('checks the canonical sidecar input, not its unparseable summary, and observes sidecar-only repairs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-readiness-'));
      try {
        await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES ('readiness-sidecar','fixture',$1) ON CONFLICT(id) DO UPDATE SET local_path = EXCLUDED.local_path", [root]);
        writeFileSync(join(root, 'transcript.txt'), 'No speaker turns.');
        await engine.putPage('conversations/sidecar', {
          type: 'conversation', title: 'Sidecar', compiled_truth: 'An unparseable summary.', timeline: '',
          frontmatter: { date: '2026-11-20', raw_transcript: 'transcript.txt' },
        }, { sourceId: 'readiness-sidecar' });
        expect((await computeConversationFactsBacklogCheck(engine)).details?.parse_blocked).toBe(1);
        writeFileSync(join(root, 'transcript.txt'), parsed);
        const repaired = await computeConversationFactsBacklogCheck(engine);
        expect(repaired.details?.parse_blocked).toBe(0);
        expect(repaired.details?.backlog).toBe(1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });
}
