#!/usr/bin/env bun
/**
 * Retrieval scale bench: local stand-ins for the embedding and rerank
 * providers (GBRA-156), so a latency run measures foresights and not a provider.
 *
 *   bun scripts/bench/retrieval-scale/mock-providers.ts --manifest manifest.json [--port 0] [--embed-ms 0] [--rerank-ms 0]
 *
 * OpenAI-compatible POST /v1/embeddings returns, for each input, a unit vector
 * near chunk 0 of a page picked by a hash of the text, drawn from the same
 * synthetic-latent geometry the corpus was built with, so the vector arm sees
 * in-distribution queries. Voyage-compatible POST /v1/rerank scores documents
 * by word overlap with the query. Each answer waits --embed-ms / --rerank-ms
 * first (a fixed provider round trip). Counts every call on GET /stats.
 */
import { readFileSync } from 'node:fs';
import { buildBasis, Generator, hash32, LATENT_DEFAULTS, Rng, type LatentParams } from '../hnsw-latent-corpus.ts';

export interface MockOptions { manifest: { seed: number; chunks: number; pages: number; dims: number }; port?: number; embedMs?: number; rerankMs?: number }
export interface MockServer { url: string; stats: { embed_calls: number; embed_inputs: number; rerank_calls: number; rerank_docs: number }; stop(): void }

export function startMockProviders(o: MockOptions): MockServer {
  const params: LatentParams = { ...LATENT_DEFAULTS, chunks: o.manifest.chunks, dims: o.manifest.dims, seed: o.manifest.seed };
  const gen = new Generator(params, buildBasis(params));
  const stats = { embed_calls: 0, embed_inputs: 0, rerank_calls: 0, rerank_docs: 0 };
  const sleep = (ms: number) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
  const vectorFor = (text: string, dims: number): number[] => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = hash32(h, text.charCodeAt(i));
    const p = h % o.manifest.pages;
    const out = new Float32Array(params.dims);
    gen.page(p, 1, (_c, vec) => out.set(vec));
    const rng = new Rng(h);
    let norm = 0;
    for (let d = 0; d < out.length; d++) { out[d]! += 0.6 * rng.gauss() / Math.sqrt(out.length); norm += out[d]! * out[d]!; }
    const inv = 1 / Math.sqrt(norm);
    return Array.from(out.subarray(0, dims), v => v * inv);
  };
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path.endsWith('/stats')) return Response.json(stats);
      const body = await req.json().catch(() => ({})) as any;
      if (path.endsWith('/embeddings')) {
        const inputs: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
        stats.embed_calls++; stats.embed_inputs += inputs.length;
        await sleep(o.embedMs ?? 0);
        const dims = Number(body.dimensions ?? params.dims);
        const data = inputs.map((t, index) => {
          const v = vectorFor(String(t), dims);
          if (body.encoding_format === 'base64') return { object: 'embedding', index, embedding: Buffer.from(new Float32Array(v).buffer).toString('base64') };
          return { object: 'embedding', index, embedding: v };
        });
        const tokens = inputs.reduce((a, t) => a + Math.ceil(String(t).length / 4), 0);
        return Response.json({ object: 'list', data, model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } });
      }
      if (path.endsWith('/rerank')) {
        const docs: string[] = body.documents ?? [];
        stats.rerank_calls++; stats.rerank_docs += docs.length;
        await sleep(o.rerankMs ?? 0);
        const q = words(String(body.query ?? ''));
        const scored = docs.map((d, index) => { const w = words(String(d)); let hit = 0; for (const t of q) if (w.has(t)) hit++; return { index, relevance_score: q.size ? hit / q.size : 0 }; });
        scored.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
        const k = Number(body.top_k ?? scored.length);
        return Response.json({ object: 'list', data: scored.slice(0, k), model: body.model, usage: { total_tokens: docs.reduce((a, d) => a + Math.ceil(String(d).length / 4), 0) } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { url: 'http://127.0.0.1:' + server.port, stats, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string, f?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : f; };
  const manifest = JSON.parse(readFileSync(flag('--manifest')!, 'utf8'));
  const s = startMockProviders({ manifest, port: Number(flag('--port', '0')), embedMs: Number(flag('--embed-ms', '0')), rerankMs: Number(flag('--rerank-ms', '0')) });
  console.log(s.url);
}
