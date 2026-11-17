/**
 * #9547 — `gbrain takes extract --from-pages --dry-run` without `--yes`
 * sends nothing to the model. It lists and counts the candidate pages and
 * reports no claim count (null, never 0: 0 would read as "nothing to
 * extract"). `--dry-run --yes` still classifies and writes nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { runTakes } from '../src/commands/takes.ts';

let engine: PGLiteEngine;
let repo: string;
let chatCalls = 0;
const BODY = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
const SLUG = 'concepts/dry-run-candidate';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gb-takes-dry-run-'));
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  await engine.setConfig('sync.repo_path', repo);
  await engine.setConfig('takes.bootstrap_enabled', 'true');
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-ant-test-dry-run' } });
  __setChatTransportForTests(async () => {
    chatCalls++;
    const text = '[{"claim":"a bootstrapped claim","kind":"take","weight":0.7}]';
    return {
      text,
      blocks: [{ type: 'text' as const, text }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    };
  });
  await engine.putPage(SLUG, { type: 'concept', title: 'Dry run', compiled_truth: BODY, frontmatter: {} });
  writeFileSync(join(repo, `${SLUG}.md`), `# Dry run\n\n${BODY}\n`, 'utf-8');
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

async function rowCounts(): Promise<Record<string, number>> {
  const tables = await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
  const counts: Record<string, number> = {};
  for (const { t } of tables) {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    counts[t] = rows[0].n;
  }
  return counts;
}

async function runCaptured(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runTakes(engine, args);
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}

describe('takes extract --from-pages --dry-run (#9547)', () => {
  test('without --yes: no model call, candidates listed, no claim count, nothing written', async () => {
    const mdPath = join(repo, `${SLUG}.md`);
    const mdBefore = readFileSync(mdPath, 'utf-8');
    const countsBefore = await rowCounts();
    chatCalls = 0;

    const result = JSON.parse(await runCaptured(['extract', '--from-pages', '--dry-run', '--json']));

    expect(chatCalls).toBe(0);
    expect(result.dry_run).toBe(true);
    expect(result.claims_extracted ?? null).toBeNull();
    expect(result.pages_scanned).toBe(1);
    expect(result.candidates).toEqual([{ slug: SLUG, source_id: 'default' }]);
    expect(readFileSync(mdPath, 'utf-8')).toBe(mdBefore);
    expect(await rowCounts()).toEqual(countsBefore);
  });

  test('without --yes: the summary says nothing was sent to the model', async () => {
    chatCalls = 0;
    const out = await runCaptured(['extract', '--from-pages', '--dry-run']);
    expect(chatCalls).toBe(0);
    expect(out).toContain(SLUG);
    expect(out).toContain('nothing was sent to the model');
    expect(out).not.toContain('0 claim(s)');
  });

  test('with --yes: classifies the candidates and writes nothing', async () => {
    const mdPath = join(repo, `${SLUG}.md`);
    const mdBefore = readFileSync(mdPath, 'utf-8');
    const countsBefore = await rowCounts();
    chatCalls = 0;

    const result = JSON.parse(await runCaptured(['extract', '--from-pages', '--dry-run', '--yes', '--json']));

    expect(chatCalls).toBe(1);
    expect(result.dry_run).toBeUndefined();
    expect(result.claims_extracted).toBe(1);
    expect(readFileSync(mdPath, 'utf-8')).toBe(mdBefore);
    expect(await rowCounts()).toEqual(countsBefore);
  });
});
