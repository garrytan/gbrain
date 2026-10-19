/**
 * A transcript kept in the brain's own checkout and linked into the corpus
 * dir (a symlinked folder) is both a corpus file and a synced
 * `type: conversation` page. The file hash covers frontmatter, the page hash
 * covers the body, so the body-hash dedupe misses it; synthesize must still
 * read it once, from the corpus file.
 */
import { describe, expect, afterAll, beforeAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessDreamTest as test } from './helpers/keyless-dream-test.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];
const tmp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-corpus-twin-${label}-`)); dirs.push(d); return d; };
const body = 'Mentor: size every trade by R, not by conviction.\nStudent: even the small ones?\n'.repeat(4);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await engine.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A source checkout with `transcripts/<name>`, a corpus dir linking that folder, and its synced page. */
async function brainWithLinkedTranscript(name: string) {
  await resetPgliteState(engine);
  await engine.setConfig('dream.synthesize.min_chars', '0');
  const checkout = tmp('checkout');
  mkdirSync(join(checkout, '.git'));
  mkdirSync(join(checkout, 'transcripts'));
  writeFileSync(join(checkout, 'transcripts', name), `---\ntitle: Mentor session\ntype: conversation\n---\n\n${body}`);
  const corpus = tmp('corpus');
  symlinkSync(join(checkout, 'transcripts'), join(corpus, 'mentor'), 'dir');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [checkout, 'default']);
  await engine.putPage('transcripts/mentor-session', {
    type: 'conversation', title: 'Mentor session', compiled_truth: body, timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
  return { checkout, corpus };
}

async function discovered(): Promise<string[]> {
  const result = await runPhaseSynthesize(engine, { brainDir: tmp('brain'), dryRun: true });
  expect(result.status).toBe('ok');
  return ((result.details as { verdicts: Array<{ filePath: string }> }).verdicts).map((v) => v.filePath).sort();
}

describe('synthesize reads a corpus file and its synced conversation page once', () => {
  test('the page synced from a linked corpus file is left to the corpus file', async () => {
    const { corpus } = await brainWithLinkedTranscript('mentor-session.md');
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2', ['transcripts/mentor-session.md', 'transcripts/mentor-session']);
    expect(await discovered()).toEqual([join(corpus, 'mentor', 'mentor-session.md')]);
  }, 60_000);

  test('the default source without local_path resolves its page file under sync.repo_path', async () => {
    const { checkout, corpus } = await brainWithLinkedTranscript('mentor-session.md');
    await engine.executeRaw('UPDATE sources SET local_path = NULL WHERE id = $1', ['default']);
    await engine.setConfig('sync.repo_path', checkout);
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2', ['transcripts/mentor-session.md', 'transcripts/mentor-session']);
    expect(await discovered()).toEqual([join(corpus, 'mentor', 'mentor-session.md')]);
  }, 60_000);

  test('a conversation page synced from another file is still discovered', async () => {
    const { checkout, corpus } = await brainWithLinkedTranscript('mentor-session.md');
    writeFileSync(join(checkout, 'other.md'), body);
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2', ['other.md', 'transcripts/mentor-session']);
    expect(await discovered()).toEqual([
      join(corpus, 'mentor', 'mentor-session.md'),
      'gbrain-page://default/transcripts/mentor-session',
    ].sort());
  }, 60_000);
});
