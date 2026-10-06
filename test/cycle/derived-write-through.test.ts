// #5041: opt-in markdown write-through for generated atoms and concepts on an
// unmanaged brain.
//
// Protects: with `cycle.extract_atoms.write_through` /
// `cycle.synthesize_concepts.write_through` unset the phases stay
// database-only; once a key is on, new pages land as markdown files in the
// source checkout, pages generated before it was on are written on the next
// run, a retired atom's file is removed, and a gitignored target stays
// database-only.
// Fails when: neither phase writes files (the pre-fix behavior), or a phase
// writes files unasked.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let repo: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-derived-wt-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [repo]);
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
});

const chat = (atoms: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(atoms.map(title => ({ title, atom_type: 'insight', body: `${title} body.` })));
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  };
};
const extract = (titles: string[], contentHash = 'hash-one') => runPhaseExtractAtoms(engine, {
  _transcripts: [{ filePath: '/fake/2026-09-07-meeting.txt', content: 'content', contentHash }], _pages: [], _chat: chat(titles),
});
const atomSlugs = async (live = true) => (await engine.executeRaw<{ slug: string }>(
  `SELECT slug FROM pages WHERE type = 'atom' AND (deleted_at IS NULL) = $1 ORDER BY slug`, [live])).map(r => r.slug);
const fileFor = (slug: string) => join(repo, `${slug}.md`);

describe('extract_atoms write-through (#5041)', () => {
  test('off by default: atoms stay database-only', async () => {
    await extract(['Renders vs proof']);
    const [slug] = await atomSlugs();
    expect(slug).toBeDefined();
    expect(existsSync(fileFor(slug!))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });

  test('on: each new atom lands as a markdown file with its final frontmatter', async () => {
    await engine.setConfig('cycle.extract_atoms.write_through', 'true');
    await extract(['Renders vs proof', 'Founder lesson']);
    const slugs = await atomSlugs();
    expect(slugs).toHaveLength(2);
    for (const slug of slugs) {
      const parsed = parseMarkdown(readFileSync(fileFor(slug), 'utf-8'), fileFor(slug));
      expect(parsed.type).toBe('atom');
      expect(String(parsed.frontmatter.source_hash)).not.toStartWith('pending:');
    }
    rmSync(repo, { recursive: true, force: true });
  });

  test('enabling the key writes earlier atoms on the next run, and a retired atom loses its file', async () => {
    await extract(['Renders vs proof']);
    const [old] = await atomSlugs();
    await engine.setConfig('cycle.extract_atoms.write_through', 'on');
    await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [], _chat: chat([]) });
    expect(existsSync(fileFor(old!))).toBe(true);
    await extract(['A different lesson'], 'hash-two');
    expect(await atomSlugs(false)).toEqual([old!]);
    expect(existsSync(fileFor(old!))).toBe(false);
    const [current] = await atomSlugs();
    expect(existsSync(fileFor(current!))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test('a gitignored target stays database-only', async () => {
    writeFileSync(join(repo, '.gitignore'), 'atoms/\n');
    await engine.setConfig('cycle.extract_atoms.write_through', 'true');
    await extract(['Renders vs proof']);
    const [slug] = await atomSlugs();
    expect(existsSync(fileFor(slug!))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('synthesize_concepts write-through (#5041)', () => {
  const atoms = Array.from({ length: 2 }, (_, i) => ({ slug: `atoms/a${i}`, title: `A${i}`, body: `b${i}`, concept_refs: ['flywheel'], visibility: 'world' as const }));

  test('off by default; on writes the concept page file', async () => {
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    expect(existsSync(fileFor('concepts/flywheel'))).toBe(false);
    await engine.setConfig('cycle.synthesize_concepts.write_through', 'true');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    const parsed = parseMarkdown(readFileSync(fileFor('concepts/flywheel'), 'utf-8'), fileFor('concepts/flywheel'));
    expect(parsed.type).toBe('concept');
    expect(parsed.frontmatter.synthesized_by).toBe('synthesize_concepts-v0.41');
    rmSync(repo, { recursive: true, force: true });
  });

  test('on: a newly synthesized concept is written by the publication itself', async () => {
    await engine.setConfig('cycle.synthesize_concepts.write_through', 'true');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    expect(readFileSync(fileFor('concepts/flywheel'), 'utf-8')).toContain('T3 concept. 2 atoms reference this.');
    rmSync(repo, { recursive: true, force: true });
  });

  test('a concept that already has a file is rewritten in place even with the key off', async () => {
    await engine.setConfig('cycle.synthesize_concepts.write_through', 'true');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    await engine.setConfig('cycle.synthesize_concepts.write_through', 'false');
    const three = [...atoms, { slug: 'atoms/a2', title: 'A2', body: 'b2', concept_refs: ['flywheel'], visibility: 'world' as const }];
    await runPhaseSynthesizeConcepts(engine, { _atoms: three, sourceId: 'default' });
    expect(readFileSync(fileFor('concepts/flywheel'), 'utf-8')).toContain('T3 concept. 3 atoms reference this.');
    rmSync(repo, { recursive: true, force: true });
  });
});
