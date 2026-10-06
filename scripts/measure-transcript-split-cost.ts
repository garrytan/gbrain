#!/usr/bin/env bun
/**
 * Measures what the transcript part target costs at import (#5783): pages,
 * chunks and embedding input tokens for one synthetic 1 MB session at the
 * former part target (min(300 KB, 0.6 x content-sanity block) = 300,000 B)
 * and the current one (PART_TARGET_BYTES = 0.9 x the warn line).
 *
 * Free and offline: the session is generated deterministically (seeded
 * PRNG over a fixed vocabulary, no real content), each target imports into
 * its own in-memory PGLite brain through the real ingest path
 * (redactSession -> renderSessionParts -> importFromContent with embedding
 * on), and the embedding transport is a stub that counts input tokens with
 * the chunker's cl100k estimator instead of calling a provider.
 *
 *   bun scripts/measure-transcript-split-cost.ts [--bytes N] [--json]
 */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { estimateTokens } from '../src/core/chunkers/token-estimate.ts';
import { DEFAULT_BYTES_BLOCK } from '../src/core/content-sanity.ts';
import { PART_TARGET_BYTES, redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import type { ParsedSession, TranscriptMessage } from '../src/core/transcripts/types.ts';

const FORMER_PART_TARGET_BYTES = Math.min(300 * 1024, Math.floor(DEFAULT_BYTES_BLOCK * 0.6));

const VOCABULARY = ('plan review draft schedule budget migration index query latency cache worker queue retry '
  + 'deploy rollback branch commit test fixture parser chunk embed vector search rank recall page source sync '
  + 'agent prompt answer question decision follow-up owner deadline estimate risk metric dashboard alert note')
  .split(' ');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic session whose message text totals `targetBytes`. */
export function syntheticSession(targetBytes: number, seed = 5783): ParsedSession {
  const rand = mulberry32(seed);
  const messages: TranscriptMessage[] = [];
  const start = Date.UTC(2026, 0, 5, 9, 0, 0);
  let bytes = 0;
  for (let i = 0; bytes < targetBytes; i++) {
    const length = 600 + Math.floor(rand() * 2800);
    const sentences: string[] = [];
    let text = '';
    while (text.length < length) {
      const words = Array.from({ length: 8 + Math.floor(rand() * 10) }, () => VOCABULARY[Math.floor(rand() * VOCABULARY.length)]);
      sentences.push(`${words.join(' ')}.`);
      text = sentences.join(' ');
    }
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', timestamp: new Date(start + i * 20_000).toISOString(), text });
    bytes += Buffer.byteLength(text, 'utf8');
  }
  return { meta: { harness: 'claude-code', sessionId: 'synthetic-split-cost-0001', title: 'Synthetic split-cost session', startedAt: new Date(start).toISOString() }, messages };
}

export interface SplitCost { partTargetBytes: number; pages: number; chunks: number; embedInputTokens: number; embedCalls: number }

export async function measureSplitCost(session: ParsedSession, partTargetBytes: number): Promise<SplitCost> {
  const rendered = renderSessionParts(redactSession(session, { patterns: [] }), { sourcePath: '', partTargetBytes });
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  let embedInputTokens = 0;
  let embedCalls = 0;
  // The brain's own embedding plane (model + column width), so the import writes real vectors.
  const model = (await engine.getConfig('embedding_model')) ?? 'openai:text-embedding-3-large';
  const dimensions = Number((await engine.getConfig('embedding_dimensions')) ?? 1536);
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'sk-measure-offline', VOYAGE_API_KEY: 'pa-measure-offline' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedCalls++;
    const tokens = values.reduce((n, v) => n + estimateTokens(v), 0);
    embedInputTokens += tokens;
    return { embeddings: values.map(() => new Array(dimensions).fill(0.01)), usage: { tokens } };
  }) as never);
  try {
    for (const part of rendered.parts) {
      const r = await importFromContent(engine, part.slug, part.content, {
        noEmbed: false, source_kind: 'transcript:claude-code', ingested_via: 'cli:transcripts-ingest',
      });
      if (r.status !== 'imported') throw new Error(`${part.slug}: import ${r.status} ${r.error ?? ''}`);
    }
    const [pages] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type = 'conversation'");
    const [chunks] = await engine.executeRaw<{ n: number; embedded: number }>('SELECT count(*)::int AS n, count(embedding)::int AS embedded FROM content_chunks');
    if (chunks.embedded !== chunks.n) throw new Error(`${chunks.n - chunks.embedded} chunk(s) left unembedded`);
    return { partTargetBytes, pages: pages.n, chunks: chunks.n, embedInputTokens, embedCalls };
  } finally {
    __setEmbedTransportForTests(null as never);
    resetGateway();
    await engine.disconnect();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const bytesArg = args.indexOf('--bytes');
  const targetBytes = bytesArg >= 0 ? Number(args[bytesArg + 1]) : 1024 * 1024;
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) throw new Error('--bytes must be a positive integer');
  const session = syntheticSession(targetBytes);
  const sessionBytes = session.messages.reduce((n, m) => n + Buffer.byteLength(m.text, 'utf8'), 0);
  const former = await measureSplitCost(session, FORMER_PART_TARGET_BYTES);
  const current = await measureSplitCost(session, PART_TARGET_BYTES);
  const ratio = (a: number, b: number) => Math.round((b / a) * 1000) / 1000;
  const multiplier = { pages: ratio(former.pages, current.pages), chunks: ratio(former.chunks, current.chunks), embedInputTokens: ratio(former.embedInputTokens, current.embedInputTokens) };
  if (args.includes('--json')) {
    console.log(JSON.stringify({ sessionBytes, messages: session.messages.length, former, current, multiplier }, null, 2));
  } else {
    console.log(`synthetic session: ${sessionBytes} bytes of message text, ${session.messages.length} messages`);
    for (const [label, r] of [['former', former], ['current', current]] as const) {
      console.log(`${label.padEnd(8)} part target ${String(r.partTargetBytes).padStart(7)} B: ${r.pages} pages, ${r.chunks} chunks, ${r.embedInputTokens} embed input tokens (${r.embedCalls} calls)`);
    }
    console.log(`multiplier (current / former): pages x${multiplier.pages}, chunks x${multiplier.chunks}, embed input tokens x${multiplier.embedInputTokens}`);
  }
}
