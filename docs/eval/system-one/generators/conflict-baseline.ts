/**
 * Adds today's zero-LLM write-path decision to every S9 pair so a matched
 * pair (cosine rule vs the conflict slot) can be scored without re-embedding.
 *
 *   OPENAI_API_KEY=... bun docs/eval/system-one/generators/conflict-baseline.ts [pairs.jsonl]
 *
 * Embeds every distinct fact/candidate text with OpenAI
 * text-embedding-3-large at 1536 dimensions (one batch request per 256
 * texts; vectors cached under ~/.capy/work, never committed), then per pair:
 *   baseline_cosine    cosine(fact, candidate), 4 decimals
 *   baseline_decision  the decideSingleFact rule (src/core/facts/single-prepare.ts)
 *                      applied to the pair's family: an exact normalized-text
 *                      match is `duplicate`; otherwise only the family's
 *                      highest-cosine candidate can match, and at cosine >= 0.95
 *                      it is `supersede` when the kinds agree and `duplicate`
 *                      when they differ; every other pair is `independent`
 *                      (the rule inserts the new fact alongside it).
 *   baseline_model     the embedding model and dimensions
 *   sweep_eligible     cosine >= 0.80, the S9 sweep's candidate floor: pairs
 *                      below it never reach the conflict slot in production
 * Appends one line per request batch to docs/eval/system-one/ledger-datasets.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cosineSimilarity } from '../../../../src/core/facts/classify.ts';

const MODEL = 'text-embedding-3-large';
const DIMS = 1536;
const USD_PER_MTOK = 0.13;
const COSINE_RULE = 0.95;
const SWEEP_FLOOR = 0.8;
const pairsPath = process.argv[2] ?? join(import.meta.dir, '..', 'datasets', 's9-conflict', 'pairs.jsonl');
const ledger = join(import.meta.dir, '..', 'ledger-datasets.jsonl');
const cacheDir = join(homedir(), '.capy', 'work', 'ds');
const cachePath = join(cacheDir, `s9-embeddings-${MODEL}-${DIMS}.json`);

interface Pair { id: string; family: string; fact: string; candidate: string; kind: string; candidate_kind: string; [k: string]: unknown }

const pairs = readFileSync(pairsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Pair);
const cache: Record<string, number[]> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const texts = [...new Set(pairs.flatMap((p) => [p.fact, p.candidate]))].filter((t) => !cache[t]);

for (let i = 0; i < texts.length; i += 256) {
  const batch = texts.slice(i, i + 256);
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, input: batch, dimensions: DIMS }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { data: Array<{ index: number; embedding: number[] }>; usage: { prompt_tokens: number } };
  for (const d of body.data) cache[batch[d.index]!] = d.embedding;
  const tokens = body.usage.prompt_tokens;
  appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), purpose: `s9 baseline_cosine embeddings (${batch.length} texts)`, provider: 'openai', model: `${MODEL}@${DIMS}`, input_tokens: tokens, output_tokens: 0, usd: Number((tokens * USD_PER_MTOK / 1e6).toFixed(6)) }) + '\n');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
}

const vec = (t: string) => new Float32Array(cache[t]!);
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const cos = new Map(pairs.map((p) => [p.id, cosineSimilarity(vec(p.fact), vec(p.candidate))]));
const best = new Map<string, string>();
for (const p of pairs) {
  const b = best.get(p.family);
  if (!b || cos.get(p.id)! > cos.get(b)!) best.set(p.family, p.id);
}
const out = pairs.map((p) => {
  const c = cos.get(p.id)!;
  const decision = norm(p.fact) === norm(p.candidate) ? 'duplicate'
    : best.get(p.family) === p.id && c >= COSINE_RULE ? (p.kind === p.candidate_kind ? 'supersede' : 'duplicate')
    : 'independent';
  return JSON.stringify({ ...p, baseline_cosine: Number(c.toFixed(4)), baseline_decision: decision, baseline_model: `openai:${MODEL}@${DIMS}`, sweep_eligible: c >= SWEEP_FLOOR });
});
writeFileSync(pairsPath, out.join('\n') + '\n');
console.error(`${pairs.length} pairs scored (${texts.length} new texts embedded)`);
