/**
 * #7026 part 1: Claude Code records `gbrain hook session-start` stdout as a
 * SessionStart `hook_success` attachment, not as hook_additional_context.
 * The parser keeps that block (from gbrain's envelope on) as an injected
 * block, so the first prompt's turn context does not repeat the facts the
 * session-start pack already showed, and core memory printed before the
 * envelope does not suppress pointers. Other tools' SessionStart output is
 * never dedupe input.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';
import { assembleContextPack, assembleTurnContext, TURN_CONTEXT_ENVELOPE } from '../src/core/context/turn-context.ts';
import { composeSessionStartOutput } from '../src/core/context/session-start-output.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

const CORE = '## Core memory\n- Bob Example owns the roadmap (people/bob-example)';
const PACK = `${TURN_CONTEXT_ENVELOPE}\n\n## Hot memory (recent facts)\n- SESSION-FACT the deploy window is tuesday [companies/acme-example] (0.90)`;

const sessionStartLine = (hookEvent: string, content: string) => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'attachment', sessionId: 'sess-7026',
  attachment: { type: 'hook_success', hookName: `${hookEvent}:startup`, toolUseID: 'tool-1', hookEvent, content, stdout: content, stderr: '', exitCode: 0, command: 'hook', durationMs: 12 },
});
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gb-7026-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function transcript(lines: string[]): string {
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('#7026 SessionStart hook_success is an injected block', () => {
  test('gbrain session-start output is kept from the envelope on; a foreign SessionStart output is excluded', () => {
    const p = transcript([
      sessionStartLine('SessionStart', 'project-sync: repo is 2 commits behind; see companies/acme-example'),
      sessionStartLine('SessionStart', composeSessionStartOutput(CORE, ['MEMORY digest line', PACK])),
      userLine('hello'),
    ]);
    const r = parseTranscript(p);
    expect(r.injectedContextBlocks).toEqual([PACK]);
    expect(r.turns.map((t) => t.text)).toEqual(['hello']);
  });

  test('a hook_success from another event carrying the envelope is not a session-start block', () => {
    const p = transcript([sessionStartLine('PostToolUse', PACK), userLine('hello')]);
    expect(parseTranscript(p).injectedContextBlocks).toEqual([]);
  });
});

for (const backend of testBackends()) {
  describe(`#7026 end to end (${backend})`, () => {
    let engine: BrainEngine;
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      __resetHotMemoryCacheForTests();
      // Targeted deletes, not resetPgliteState: that also empties trust_policy_state, and hot memory reads nothing without its row.
      if (pglite) { engine = pglite; await engine.executeRaw('DELETE FROM facts'); await engine.executeRaw('DELETE FROM pages'); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    test('a fact the session-start pack showed is not rendered again by the first turn context', async () => {
      await engine.executeRaw(
        `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, 'default', 'person', $2, $3, '')`,
        ['people/bob-example', 'Bob Example', 'Bob Example owns the roadmap at acme-example.'],
      );
      const fact = 'SESSION-FACT the deploy window is tuesday';
      await engine.insertFact(
        { fact, kind: 'fact', entity_slug: 'companies/acme-example', source: 'test', visibility: 'world' },
        { source_id: 'default' },
      );
      const pack = await assembleContextPack(engine, { sourceId: 'default', sessionId: 'sess-7026' });
      expect(pack.factsCount).toBe(1);
      expect(pack.text).toContain(fact);

      const p = transcript([
        sessionStartLine('SessionStart', composeSessionStartOutput(CORE, ['MEMORY digest line', pack.text])),
        userLine('what is Bob Example working on'),
      ]);
      const parsed = parseTranscript(p);
      __resetHotMemoryCacheForTests();
      const turn = await assembleTurnContext(engine, {
        sourceId: 'default',
        sessionId: 'sess-7026',
        window: parsed.turns,
        priorContextText: parsed.injectedContextBlocks.join('\n\n'),
      });
      expect(turn.factsCount).toBe(0);
      expect(turn.text).not.toContain(fact);
      // Core memory sits before the envelope, so its slug does not suppress the pointer.
      expect(turn.pointers.map((x) => x.slug)).toContain('people/bob-example');
      expect(parsed.injectedContextBlocks).toEqual([pack.text]);
    });
  });
}
