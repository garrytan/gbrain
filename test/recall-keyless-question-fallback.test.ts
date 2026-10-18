/**
 * Cat 41 run 4 (D runs): after `gbrain remember "... coffee black, with a pinch
 * of cardamom" --kind preference` on a keyless brain, the agents asked
 * `gbrain recall "how does the user take their coffee"` and got "No matching
 * facts." The positional is an entity, then a literal fact-text substring
 * (#4720), so a question matches neither, while `--question` ranks the fact
 * first. On a brain without embeddings a multi-word positional that matched
 * nothing is now ranked as a question (keyword-only, as `--question` is
 * there), with a note. Controls: a one-word positional keeps the text
 * fallback, and a brain with embeddings keeps "No matching facts." plus a
 * hint (no ranking change). PGLite in-process; no keys, no network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecall } from '../src/commands/recall.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
let out = '';
let err = '';
const FACT = 'The user takes their coffee black, with a pinch of cardamom.';

async function recall(args: string[]): Promise<{ out: string; err: string }> {
  out = ''; err = '';
  await runRecall(engine, [...args, '--source', 'default']);
  return { out, err };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact({ fact: FACT, kind: 'preference', entity_slug: 'user', source: 'test', visibility: 'world' }, { source_id: 'default' });
});
afterAll(async () => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  resetGateway();
  await engine.disconnect();
});
beforeEach(() => {
  process.stdout.write = ((c: string | Uint8Array) => { out += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += typeof c === 'string' ? c : Buffer.from(c).toString(); return true; }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  resetGateway();
});

describe('keyless brain: a question passed as the positional is ranked as a question', () => {
  beforeEach(() => configureGateway({ env: {} }));

  test('the coffee question finds the coffee fact, with a note saying how', async () => {
    for (const q of ['how does the user take their coffee', 'how do I take my coffee?']) {
      const r = await recall([q]);
      expect(r.err).toContain(`[recall] no entity or fact text matched '${q}'; ranked facts by relevance to it as a question (keyword-only: this brain has no embeddings).`);
      expect(r.out).toContain('Facts (ranked by relevance to the question):');
      expect(r.out).toContain(FACT);
    }
  });

  test('an unrelated question still finds nothing; a one-word positional keeps the text fallback', async () => {
    expect((await recall(['what is my dog called'])).out).toContain('No saved fact matched the question.');
    const word = await recall(['coffee']);
    expect(word.err).toContain("[recall] no facts for entity 'coffee'; matched 1 fact(s) by text");
    expect(word.out).toContain(FACT);
    expect(word.out).not.toContain('ranked by relevance');
  });
});

describe('brain with embeddings: output unchanged, plus a hint', () => {
  beforeEach(() => configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-no-network' } }));

  test('the positional question is not re-ranked: "No matching facts." and a --question hint', async () => {
    const q = 'how does the user take their coffee';
    const r = await recall([q]);
    expect(r.out).toContain('No matching facts.');
    expect(r.out).not.toContain(FACT);
    expect(r.err).toContain(`To rank facts against it as a question: gbrain recall --question ${JSON.stringify(q)}`);
  });
});
