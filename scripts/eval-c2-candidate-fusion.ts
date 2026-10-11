/**
 * C2 offline eval: fact supersession candidates, `facts.candidate_fusion`
 * `rrf_free` (one cosine arm, the current behavior) against `interleave`
 * (cosine + keyword arms, round-robin, cut to k = 5), on PGLite. No model or
 * network calls in the replay: the fixture is generated from a fixed seed and
 * embedded once with a free local model (scripts/eval-c2-embed.py); the
 * verdict records the sha256 of the texts and of the embeddings file.
 *
 *   bun scripts/eval-c2-candidate-fusion.ts texts > /tmp/c2-texts.json
 *   python3 scripts/eval-c2-embed.py /tmp/c2-texts.json /tmp/c2-embeddings.json.gz
 *   bun scripts/eval-c2-candidate-fusion.ts run --embeddings /tmp/c2-embeddings.json.gz [--out docs/eval/decisions/c2-interleave-dev]
 *
 * Fixture: 40 synthetic companies. Each has single-valued claims (revenue,
 * headcount, runway, …) as world facts, similar-but-different coexisting
 * claims (funding rounds, quarterly revenue, offices, board dates), and
 * private rows (a private copy and a private note of world claims, plus one
 * private-only claim). Probes, replayed in order through the product's
 * candidate listing: corrections with changed numbers or dates, restatements,
 * back-to-back corrections of one claim (the state a concurrent pair reaches
 * after the publication guard's retry), a private correction, new members of
 * coexisting claims and new claims. Every row carries its claim key, so the
 * expected twin of each probe is known by construction.
 *
 * Metrics per probe, paired by probe and clustered by company: twin
 * recall@5 (an active row of the probe's claim is in the scored candidate
 * set), false supersession (the decision replaced or deduplicated a row of a
 * different claim), correct decision. Per company at the end of the replay:
 * preserved distinct claims (every claim ever established still has an
 * active row). The decision is decideSingleFact's rule (max cosine among
 * eligible candidates at or above the threshold) replayed at each threshold
 * in TAUS; each threshold is also registered as the model's
 * `facts.supersession_thresholds` override, so the real decideSingleFact
 * runs beside every replayed decision and must agree.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { cosineSimilarity } from '../src/core/facts/classify.ts';
import { SUPERSESSION_THRESHOLDS_KEY, calibrationKey, resolveSupersessionThreshold } from '../src/core/facts/supersession-threshold.ts';
import {
  CANDIDATE_FUSION_KEY, SUPERSESSION_CANDIDATE_K, decideSingleFact, listSupersessionCandidates, type CandidateFusion,
} from '../src/core/facts/single-prepare.ts';
import { mulberry32 } from '../src/eval/shared/bootstrap.ts';
import { holmAdjusted, pairedClusterStatistics } from '../src/core/eval/paired-bootstrap.ts';

export const FIXTURE_SEED = 20261005;
export const TAUS = [0.85, 0.9, 0.95];
const MODES: CandidateFusion[] = ['rrf_free', 'interleave'];
const SOURCE = 'eval:c2-explicit';
const DRAWS = 10_000;

type Visibility = 'world' | 'private';
interface Row { key: string; fact: string; visibility: Visibility }
interface Probe extends Row { kind: 'correction' | 'restatement' | 'concurrent' | 'private_correction' | 'coexisting' | 'new_claim' }
interface Company { slug: string; dense: boolean; seeds: Row[]; probes: Probe[] }

// ---------------------------------------------------------------------------
// Fixture (deterministic from FIXTURE_SEED)
// ---------------------------------------------------------------------------

const STEMS = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel', 'Ironwood', 'Juniper',
  'Kauri', 'Larch', 'Maple', 'Nutmeg', 'Oak', 'Pine', 'Quince', 'Rowan', 'Spruce', 'Teak'];
const PEOPLE = ['Alice Example', 'Bob Example', 'Carol Example', 'Dan Example', 'Erin Example', 'Frank Example', 'Grace Example', 'Hank Example'];
const CITIES = ['Austin', 'Denver', 'Boston', 'Seattle', 'Toronto', 'Lisbon', 'Berlin', 'Dublin', 'Singapore', 'Sydney', 'Chicago', 'Madrid'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Rand = () => number;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const shuffle = <T>(r: Rand, xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};
const day = (r: Rand) => `${pick(r, MONTHS)} ${int(r, 1, 28)}, ${int(r, 2025, 2027)}`;

/** Single-valued claims: a new value corrects the old one. Two phrasings each. */
const SINGLE: Record<string, { value: (r: Rand) => string; say: Array<(e: string, v: string) => string> }> = {
  arr: { value: r => `$${int(r, 2, 60)}M`, say: [(e, v) => `${e}'s annual recurring revenue is ${v}.`, (e, v) => `${e} now has ${v} in annual recurring revenue.`] },
  headcount: { value: r => String(int(r, 20, 400)), say: [(e, v) => `${e} has ${v} full-time employees.`, (e, v) => `${e}'s headcount is ${v} people.`] },
  runway: { value: r => String(int(r, 6, 36)), say: [(e, v) => `${e} has ${v} months of cash runway.`, (e, v) => `${e}'s cash runway is ${v} months.`] },
  hq: { value: r => pick(r, CITIES), say: [(e, v) => `${e} is headquartered in ${v}.`, (e, v) => `${e}'s headquarters are in ${v}.`] },
  ceo: { value: r => pick(r, PEOPLE), say: [(e, v) => `The CEO of ${e} is ${v}.`, (e, v) => `${v} is the chief executive of ${e}.`] },
  price: { value: r => `$${int(r, 8, 120)}`, say: [(e, v) => `${e}'s Pro plan costs ${v} per seat per month.`, (e, v) => `The Pro plan at ${e} is priced at ${v} per seat monthly.`] },
  customers: { value: r => String(int(r, 15, 5000)), say: [(e, v) => `${e} serves ${v} paying customers.`, (e, v) => `${e} has ${v} paying customers.`] },
  launch: { value: r => day(r), say: [(e, v) => `${e} plans to launch its mobile app on ${v}.`, (e, v) => `${e}'s mobile app launch is scheduled for ${v}.`] },
  churn: { value: r => `${int(r, 1, 9)}.${int(r, 0, 9)}%`, say: [(e, v) => `${e}'s monthly logo churn is ${v}.`, (e, v) => `Monthly customer churn at ${e} is ${v}.`] },
  nps: { value: r => String(int(r, 10, 80)), say: [(e, v) => `${e}'s net promoter score is ${v}.`, (e, v) => `${e} reports a net promoter score of ${v}.`] },
};

/** Coexisting claims: same template, different numbers or dates, all true at once. */
const STAGES = ['pre-seed', 'seed', 'Series A', 'Series B', 'Series C', 'Series D'];
const MULTI: Record<string, (r: Rand, e: string, i: number) => { member: string; fact: string }> = {
  round: (r, e, i) => ({ member: STAGES[i], fact: `${e} raised a $${int(r, 1, 9) * (i + 1)}M ${STAGES[i]} round in ${2019 + i}.` }),
  quarter: (r, e, i) => ({ member: `Q${(i % 4) + 1}-${2025 + Math.floor(i / 4)}`, fact: `${e}'s revenue in Q${(i % 4) + 1} ${2025 + Math.floor(i / 4)} was $${int(r, 1, 30)}.${int(r, 0, 9)}M.` }),
  office: (r, e, i) => ({ member: CITIES[i], fact: `${e} opened an office in ${CITIES[i]} in ${2020 + i}.` }),
  board: (r, e, i) => ({ member: `m${i}`, fact: `${e}'s board met on ${MONTHS[(i * 3) % 12]} ${int(r, 1, 28)}, ${2025 + Math.floor(i / 4)} to review the budget.` }),
};

export function buildFixture(seed = FIXTURE_SEED): Company[] {
  const r = mulberry32(seed);
  const companies: Company[] = [];
  for (const [si, stem] of STEMS.entries()) {
    for (const suffix of ['Labs', 'Works']) {
      // Every fourth company is dense: all four coexisting families with many
      // members and three private notes per claim, so the cosine top 5 is crowded.
      const dense = (si * 2 + (suffix === 'Labs' ? 0 : 1)) % 4 === 0;
      const name = `${stem} Example ${suffix}`;
      const slug = `companies/${stem.toLowerCase()}-example-${suffix.toLowerCase()}`;
      const seeds: Row[] = [];
      const probes: Probe[] = [];
      const families = shuffle(r, Object.keys(SINGLE));
      const seeded = families.slice(0, 7);
      const values = new Map<string, string>();
      for (const f of seeded) {
        const v = SINGLE[f].value(r);
        values.set(f, v);
        seeds.push({ key: `${slug}|${f}`, fact: SINGLE[f].say[0](name, v), visibility: 'world' });
      }
      // Private rows over world claims: a private copy and a private note.
      for (const f of seeded.slice(0, 4)) {
        const v = values.get(f)!;
        seeds.push({ key: `${slug}|${f}|private-copy`, fact: SINGLE[f].say[1](name, v), visibility: 'private' });
        seeds.push({ key: `${slug}|${f}|private-note`, fact: `Private note: ${SINGLE[f].say[0](name, v)}`, visibility: 'private' });
        if (dense) {
          seeds.push({ key: `${slug}|${f}|private-board-deck`, fact: `From the board deck (private): ${SINGLE[f].say[1](name, v)}`, visibility: 'private' });
          seeds.push({ key: `${slug}|${f}|private-call`, fact: `Heard on a private call: ${SINGLE[f].say[0](name, SINGLE[f].value(r))}`, visibility: 'private' });
          seeds.push({ key: `${slug}|${f}|private-draft`, fact: `Draft, do not share: ${SINGLE[f].say[0](name, SINGLE[f].value(r))}`, visibility: 'private' });
        }
      }
      // One private-only claim.
      const privFamily = seeded[6];
      const privValue = SINGLE[privFamily].value(r);
      seeds.push({ key: `${slug}|${privFamily}|private-only`, fact: `Internal estimate: ${SINGLE[privFamily].say[1](name, privValue)}`, visibility: 'private' });
      // Coexisting claims: two families, members 0..n-1 seeded, the next one is a probe.
      const multis = shuffle(r, Object.keys(MULTI)).slice(0, dense ? 4 : 2);
      const multiNext: Array<{ family: string; i: number }> = [];
      for (const m of multis) {
        const n = dense ? int(r, 4, m === 'round' ? 5 : 8) : int(r, 2, 3);
        for (let i = 0; i < n; i++) {
          const c = MULTI[m](r, name, i);
          seeds.push({ key: `${slug}|${m}|${c.member}`, fact: c.fact, visibility: 'world' });
        }
        multiNext.push({ family: m, i: n });
      }
      const newValue = (f: string) => { let v = SINGLE[f].value(r); while (v === values.get(f)) v = SINGLE[f].value(r); values.set(f, v); return v; };
      for (const f of seeded.slice(0, 3)) probes.push({ kind: 'correction', key: `${slug}|${f}`, fact: SINGLE[f].say[int(r, 0, 1)](name, newValue(f)), visibility: 'world' });
      probes.push({ kind: 'restatement', key: `${slug}|${seeded[3]}`, fact: SINGLE[seeded[3]].say[1](name, values.get(seeded[3])!), visibility: 'world' });
      for (const _ of [0, 1]) probes.push({ kind: 'concurrent', key: `${slug}|${seeded[4]}`, fact: SINGLE[seeded[4]].say[int(r, 0, 1)](name, newValue(seeded[4])), visibility: 'world' });
      let pv = SINGLE[privFamily].value(r);
      while (pv === privValue) pv = SINGLE[privFamily].value(r);
      probes.push({ kind: 'private_correction', key: `${slug}|${privFamily}|private-only`, fact: `Internal estimate: ${SINGLE[privFamily].say[0](name, pv)}`, visibility: 'private' });
      for (const { family, i } of multiNext.slice(0, 2)) {
        const c = MULTI[family](r, name, i);
        probes.push({ kind: 'coexisting', key: `${slug}|${family}|${c.member}`, fact: c.fact, visibility: 'world' });
      }
      const fresh = families[7];
      probes.push({ kind: 'new_claim', key: `${slug}|${fresh}`, fact: SINGLE[fresh].say[int(r, 0, 1)](name, SINGLE[fresh].value(r)), visibility: 'world' });
      companies.push({ slug, dense, seeds, probes: shuffle(r, probes).sort((a, b) => Number(a.kind === 'concurrent') - Number(b.kind === 'concurrent')) });
    }
  }
  return companies;
}

export function fixtureTexts(companies: Company[]): string[] {
  return [...new Set(companies.flatMap(c => [...c.seeds, ...c.probes].map(x => x.fact)))].sort();
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// Embeddings (int8 + per-vector scale, gzip JSON)
// ---------------------------------------------------------------------------

interface EmbeddingFile { model: string; dims: number; texts_sha256: string; vectors: Record<string, { s: number; q: string } | { f: string }> }

function loadEmbeddings(path: string, texts: string[]): { model: string; dims: number; sha256: string; get(t: string): Float32Array } {
  const raw = readFileSync(path);
  const file = JSON.parse(gunzipSync(raw).toString('utf8')) as EmbeddingFile;
  const expected = sha256(JSON.stringify(texts));
  if (file.texts_sha256 !== expected) throw new Error(`Embeddings were made for another fixture (texts sha ${file.texts_sha256}, fixture ${expected}); re-run scripts/eval-c2-embed.py.`);
  const cache = new Map<string, Float32Array>();
  return {
    model: file.model, dims: file.dims, sha256: sha256(raw),
    get(t: string) {
      const hit = cache.get(t);
      if (hit) return hit;
      const v = file.vectors[sha256(t)];
      if (!v) throw new Error(`No embedding for fixture text: ${t}`);
      const bytes = Buffer.from('f' in v ? v.f : v.q, 'base64');
      const out = 'f' in v
        ? new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        : Float32Array.from(new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), x => x * v.s);
      cache.set(t, out);
      return out;
    },
  };
}

/**
 * Embed the fixture through the product gateway (`embed`, inputType
 * 'document', the call prepareFactEmbedding makes) with a configured
 * provider model. PAID: one batch call per 128 texts; the fixture is about
 * 24K tokens. Vectors are stored as float32 so cosines near the threshold
 * are exact.
 */
async function embedWithGateway(model: string, dims: number, outPath: string): Promise<Record<string, unknown>> {
  const { embed } = await import('../src/core/ai/gateway.ts');
  const { estimateTokens } = await import('../src/core/chunkers/token-estimate.ts');
  const texts = fixtureTexts(buildFixture());
  resetGateway();
  configureGateway({ embedding_model: model, embedding_dimensions: dims, env: { ...process.env } as Record<string, string> });
  const vectors: EmbeddingFile['vectors'] = {};
  for (let i = 0; i < texts.length; i += 128) {
    const batch = texts.slice(i, i + 128);
    const out = await embed(batch, { inputType: 'document' });
    batch.forEach((t, j) => {
      if (out[j].length !== dims) throw new Error(`expected ${dims} dims from ${model}, got ${out[j].length}`);
      vectors[sha256(t)] = { f: Buffer.from(new Float32Array(out[j]).buffer).toString('base64') };
    });
  }
  const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
  writeFileSync(outPath, gzipSync(JSON.stringify({ model, dims, texts_sha256: sha256(JSON.stringify(texts)), vectors })));
  return { model, dims, texts: texts.length, approx_cl100k_tokens: tokens, out: outPath };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface ProbeOutcome {
  company: string; dense: boolean; kind: Probe['kind']; has_twin: boolean; twin_in_candidates: boolean;
  status: 'inserted' | 'superseded' | 'duplicate'; outcome: 'correct' | 'missed' | 'false_supersession';
  hit_key?: string; best_eligible_cosine: number | null; keyword_only_candidates: number;
}
interface ArmResult { probes: ProbeOutcome[]; preserved: Record<string, { claims: number; preserved: number }>; stale_claims: number; product_mismatches: number }

async function replay(engineDims: number, model: string, emb: (t: string) => Float32Array, companies: Company[], mode: CandidateFusion, tau: number): Promise<ArmResult> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig(CANDIDATE_FUSION_KEY, mode);
  // The product decides at this threshold too, so every replayed decision is checked against decideSingleFact.
  await engine.setConfig(SUPERSESSION_THRESHOLDS_KEY, JSON.stringify({ [calibrationKey(model, engineDims)]: tau }));
  const keyOf = new Map<number, string>();
  const established = new Map<string, Set<string>>();
  const insert = async (c: Company, row: Row, supersedeId?: number) => {
    const res = await engine.insertFact({ fact: row.fact, kind: 'fact', entity_slug: c.slug, visibility: row.visibility, source: SOURCE, embedding: emb(row.fact), embedding_model: model }, // gbrain-allow-direct-insert: offline eval seeds a throwaway in-memory PGLite brain
      { source_id: 'default', ...(supersedeId ? { supersedeId } : {}) });
    keyOf.set(res.id, row.key);
    if (!established.has(c.slug)) established.set(c.slug, new Set());
    established.get(c.slug)!.add(row.key);
  };
  for (const c of companies) for (const s of c.seeds) await insert(c, s);
  const probes: ProbeOutcome[] = [];
  let productMismatches = 0;
  for (const c of companies) {
    for (const p of c.probes) {
      const e = emb(p.fact);
      const active = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM facts WHERE source_id='default' AND entity_slug=$1 AND visibility=$2 AND expired_at IS NULL`, [c.slug, p.visibility]);
      const twins = new Set(active.map(a => Number(a.id)).filter(id => keyOf.get(id) === p.key));
      const [exact] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND entity_slug=$1 AND visibility=$2
        AND expired_at IS NULL AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3) ORDER BY id LIMIT 1`, [c.slug, p.visibility, p.fact]);
      const candidates = await listSupersessionCandidates(engine, 'default', c.slug, p.fact, e, model, mode);
      const cosineIds = new Set((await listSupersessionCandidates(engine, 'default', c.slug, p.fact, e, model, 'rrf_free')).map(x => x.id));
      let bestId: number | null = null;
      let score = -1;
      for (const cand of candidates) {
        if (!cand.embedding || cand.visibility !== p.visibility || cand.expired_at) continue;
        const s = cosineSimilarity(e, cand.embedding);
        if (s > score) { score = s; bestId = cand.id; }
      }
      const eligibleCosine = bestId === null ? null : score;
      if (exact) bestId = Number(exact.id);
      const status: ProbeOutcome['status'] = exact ? 'duplicate' : bestId !== null && score >= tau ? 'superseded' : 'inserted';
      const hitId = status === 'inserted' ? null : bestId;
      {
        const product = await decideSingleFact(engine, 'default', { fact: p.fact, kind: 'fact', visibility: p.visibility, entity_slug: c.slug }, e, model, SOURCE);
        if (product.status !== status || (product.candidate?.id ?? null) !== hitId) productMismatches++;
      }
      const hitKey = hitId === null ? undefined : keyOf.get(hitId);
      const outcome: ProbeOutcome['outcome'] = hitId === null
        ? (twins.size > 0 ? 'missed' : 'correct')
        : (twins.has(hitId) ? 'correct' : 'false_supersession');
      probes.push({
        company: c.slug, dense: c.dense, kind: p.kind, has_twin: twins.size > 0, twin_in_candidates: candidates.some(x => twins.has(x.id)), status, outcome,
        ...(hitKey && outcome === 'false_supersession' ? { hit_key: hitKey.split('|').slice(1).join('|') } : {}),
        best_eligible_cosine: eligibleCosine === null ? null : Math.round(eligibleCosine * 10_000) / 10_000,
        keyword_only_candidates: candidates.filter(x => !cosineIds.has(x.id)).length,
      });
      if (status !== 'duplicate') await insert(c, p, status === 'superseded' ? hitId! : undefined);
    }
  }
  const activeRows = await engine.executeRaw<{ id: number; entity_slug: string }>(`SELECT id, entity_slug FROM facts WHERE source_id='default' AND expired_at IS NULL`);
  const activeKeys = new Map<string, number>();
  for (const a of activeRows) { const k = keyOf.get(Number(a.id))!; activeKeys.set(k, (activeKeys.get(k) ?? 0) + 1); }
  const preserved: ArmResult['preserved'] = {};
  for (const [slug, keys] of established) preserved[slug] = { claims: keys.size, preserved: [...keys].filter(k => activeKeys.has(k)).length };
  const staleClaims = [...activeKeys].filter(([k, n]) => n > 1 && Object.keys(SINGLE).includes(k.split('|')[1]) && k.split('|').length === 2).length;
  await engine.disconnect();
  return { probes, preserved, stale_claims: staleClaims, product_mismatches: productMismatches };
}

// ---------------------------------------------------------------------------
// Statistics: paired by probe (or company), bootstrap over companies
// ---------------------------------------------------------------------------

interface Paired { cluster: string; a: number; b: number }

function pairedStats(pairs: Paired[]) {
  const st = pairedClusterStatistics(pairs.map(p => ({ cluster: p.cluster, baseline: p.a, candidate: p.b })), { seed: 42, draws: DRAWS });
  return {
    n_pairs: st.n, n_clusters: st.clusters, mean_a: st.baseline_mean, mean_b: st.candidate_mean, delta: st.delta,
    ci95: [st.lower95, st.upper95] as [number, number], wins: st.wins, losses: st.losses, ties: st.ties,
    p_two_sided: st.p_value, p_method: 'cluster-sign-flip',
  };
}

type Gate = { id: string; metric: string; gate: 'superiority' | 'noninferiority' | 'exploratory'; direction: 'higher' | 'lower'; tolerance?: number; description: string };
export const COMPARISONS: Gate[] = [
  { id: 'twin-recall-at-5', metric: 'twin_recall_at_5', gate: 'superiority', direction: 'higher', description: 'probes whose claim has an active row: that row is in the scored candidate set (k = 5)' },
  { id: 'false-supersession', metric: 'false_supersession_rate', gate: 'noninferiority', direction: 'lower', tolerance: 0.005, description: 'probes whose decision replaced or deduplicated a row of a different claim' },
  { id: 'preserved-distinct-claims', metric: 'preserved_distinct_share', gate: 'noninferiority', direction: 'higher', tolerance: 0.005, description: 'per company: share of every claim ever established that still has an active row after the replay' },
  { id: 'correct-decision', metric: 'correct_decision_rate', gate: 'exploratory', direction: 'higher', description: 'probes decided as the fixture expects (twin replaced, distinct claim inserted)' },
];

function judge(g: Gate, stats: ReturnType<typeof pairedStats>): 'pass' | 'fail' | 'inconclusive' | 'exploratory' {
  if (g.gate === 'exploratory') return 'exploratory';
  const [lo, hi] = stats.ci95;
  if (g.gate === 'superiority') {
    const better = g.direction === 'higher' ? lo > 0 : hi < 0;
    const worse = g.direction === 'higher' ? hi < 0 : lo > 0;
    return better ? 'pass' : worse ? 'fail' : 'inconclusive';
  }
  const tol = g.tolerance ?? 0;
  const ok = g.direction === 'higher' ? lo >= -tol : hi <= tol;
  const bad = g.direction === 'higher' ? hi < -tol : lo > tol;
  return ok ? 'pass' : bad ? 'fail' : 'inconclusive';
}

async function run(embeddingsPath: string, outDir: string | null, taus: number[] = TAUS, decisionId = 'c2-interleave-dev'): Promise<void> {
  const companies = buildFixture();
  const texts = fixtureTexts(companies);
  const store = loadEmbeddings(embeddingsPath, texts);
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: store.dims, env: { OPENAI_API_KEY: 'sk-offline-c2-eval-no-network' } });
  const model = store.model.includes(':') ? store.model : `local:${store.model}`;
  const sweep: SweepRow[] = [];
  const sources: unknown[] = [];
  const summary: Record<string, unknown> = {};
  const allVerdicts: string[] = [];
  for (const tau of taus) {
    const arms = {} as Record<CandidateFusion, ArmResult>;
    for (const mode of MODES) arms[mode] = await replay(store.dims, model, t => store.get(t), companies, mode, tau);
    const A = arms.rrf_free;
    const B = arms.interleave;
    const pairsFor = (pick: (o: ProbeOutcome) => number | null): Paired[] => A.probes.flatMap((a, i) => {
      const xa = pick(a); const xb = pick(B.probes[i]);
      return xa === null || xb === null ? [] : [{ cluster: a.company, a: xa, b: xb }];
    });
    const metricPairs: Record<string, Paired[]> = {
      // Only probes where both arms had an active twin when the probe arrived.
      twin_recall_at_5: A.probes.flatMap((a, i) => a.has_twin && B.probes[i].has_twin ? [{ cluster: a.company, a: Number(a.twin_in_candidates), b: Number(B.probes[i].twin_in_candidates) }] : []),
      false_supersession_rate: pairsFor(o => Number(o.outcome === 'false_supersession')),
      correct_decision_rate: pairsFor(o => Number(o.outcome === 'correct')),
      preserved_distinct_share: Object.keys(A.preserved).map(slug => ({ cluster: slug, a: A.preserved[slug].preserved / A.preserved[slug].claims, b: B.preserved[slug].preserved / B.preserved[slug].claims })),
    };
    const stats = COMPARISONS.map(g => pairedStats(metricPairs[g.metric]));
    const holm = holmAdjusted(stats.map(st => st.p_two_sided));
    const comparisons = COMPARISONS.map((g, i) => ({ ...g, status: judge(g, stats[i]), stats: stats[i], p_holm: holm[i] }));
    const gated = comparisons.filter(c => c.gate !== 'exploratory');
    const verdict = gated.some(c => c.status === 'fail') ? 'fail' : gated.every(c => c.status === 'pass') ? 'pass' : 'inconclusive';
    allVerdicts.push(verdict);
    const byKind = (arm: ArmResult) => Object.fromEntries([...new Set(arm.probes.map(p => p.kind))].map(k => {
      const ps = arm.probes.filter(p => p.kind === k);
      return [k, { n: ps.length, correct: ps.filter(p => p.outcome === 'correct').length, missed: ps.filter(p => p.outcome === 'missed').length,
        false_supersession: ps.filter(p => p.outcome === 'false_supersession').length, twin_in_candidates: ps.filter(p => p.has_twin && p.twin_in_candidates).length,
        with_twin: ps.filter(p => p.has_twin).length }];
    }));
    const falseHits = (arm: ArmResult) => {
      const counts: Record<string, number> = {};
      for (const p of arm.probes.filter(x => x.outcome === 'false_supersession')) {
        const k = `${p.kind}->${p.hit_key!.split('|')[0]}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return counts;
    };
    for (const mode of MODES) sweep.push(sweepRow(arms[mode], tau, mode));
    sources.push({
      source: `c2-twin-fixture-tau-${tau}`, verdict, threshold: tau,
      arms: { baseline: { config: { [CANDIDATE_FUSION_KEY]: 'rrf_free' } }, candidate: { config: { [CANDIDATE_FUSION_KEY]: 'interleave' } } },
      family: { family_id: `${decisionId}:tau-${tau}`, verdict, alpha: 0.05, comparisons },
      diagnostics: {
        by_kind: { rrf_free: byKind(A), interleave: byKind(B) },
        false_supersession_hits: { rrf_free: falseHits(A), interleave: falseHits(B) },
        stale_single_value_claims_at_end: { rrf_free: A.stale_claims, interleave: B.stale_claims },
        probes_with_keyword_only_candidates: B.probes.filter(p => p.keyword_only_candidates > 0).length,
        twin_recall_by_slice: Object.fromEntries((['dense', 'standard'] as const).map(slice => [slice, Object.fromEntries((['rrf_free', 'interleave'] as const).map(m => {
          const ps = arms[m].probes.filter(p => p.has_twin && p.dense === (slice === 'dense'));
          return [m, { with_twin: ps.length, twin_in_candidates: ps.filter(p => p.twin_in_candidates).length }];
        }))])),
        product_decide_mismatches: { rrf_free: A.product_mismatches, interleave: B.product_mismatches },
      },
    });
    summary[String(tau)] = Object.fromEntries(comparisons.map(c => [c.id, { a: round(c.stats.mean_a), b: round(c.stats.mean_b), delta: round(c.stats.delta), ci95: c.stats.ci95.map(round), status: c.status }]));
  }
  const overall = allVerdicts.includes('fail') ? 'fail' : allVerdicts.every(v => v === 'pass') ? 'pass' : 'inconclusive';
  const fixture = {
    seed: FIXTURE_SEED, companies: companies.length, seeded_rows: companies.reduce((n, c) => n + c.seeds.length, 0),
    probes: companies.reduce((n, c) => n + c.probes.length, 0), texts: texts.length, texts_sha256: sha256(JSON.stringify(texts)),
    embedding_model: store.model, embedding_dims: store.dims, embeddings_sha256: store.sha256, candidate_k: SUPERSESSION_CANDIDATE_K,
    gbrain_git_head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim() || null,
    gbrain_tree_dirty: Bun.spawnSync(['git', 'status', '--porcelain', '--', 'src']).stdout.toString().trim() !== '',
  };
  // Preregistered pick (rrf_free, the default arm): the lowest correction miss
  // rate whose false supersession stays at or under 1% of probes and whose
  // preserved distinct claims stay at or over 99.5%; plus the equal-weight
  // balance (correction miss + coexisting false supersession).
  const thresholdPick = { ...pickThreshold(sweep.filter(r => r.arm === 'rrf_free')), product: resolveSupersessionThreshold(model, store.dims).threshold };
  const decidedAt = new Date().toISOString();
  const verdictJson = {
    decision_id: decisionId, plan: 'MEMORY_PROOF_WAVE C2', stage: 'dev', eligible_for_default: false,
    eligibility_note: 'Dev verdict on a synthetic fixture; it cannot set a default. The parent wave routes facts.candidate_fusion and the supersession threshold.',
    verdict_type: 'quality', overall, decided_at: decidedAt, fixture, threshold_sweep: sweep, threshold_pick: thresholdPick, sources,
  };
  console.log(JSON.stringify({ overall, fixture, threshold_pick: thresholdPick, sweep }, null, 2));
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(verdictJson, null, 2) + '\n');
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;

type SweepRow = Record<string, unknown> & { threshold: number };

function sweepRow(arm: ArmResult, tau: number, mode: CandidateFusion): SweepRow {
  const ps = arm.probes;
  const rate = (num: number, den: number) => den === 0 ? null : round(num / den);
  const corr = ps.filter(p => p.has_twin && (p.kind === 'correction' || p.kind === 'concurrent' || p.kind === 'private_correction'));
  const rest = ps.filter(p => p.has_twin && p.kind === 'restatement');
  const coex = ps.filter(p => p.kind === 'coexisting');
  const kept = Object.values(arm.preserved);
  return {
    threshold: tau, arm: mode,
    correction_miss_rate: rate(corr.filter(p => p.outcome === 'missed').length, corr.length),
    restatement_miss_rate: rate(rest.filter(p => p.outcome === 'missed').length, rest.length),
    coexisting_false_supersession_rate: rate(coex.filter(p => p.outcome === 'false_supersession').length, coex.length),
    false_supersession_rate: rate(ps.filter(p => p.outcome === 'false_supersession').length, ps.length),
    preserved_distinct_share: rate(kept.reduce((n, k) => n + k.preserved, 0), kept.reduce((n, k) => n + k.claims, 0)),
    correct_decision_rate: rate(ps.filter(p => p.outcome === 'correct').length, ps.length),
    stale_single_value_claims_at_end: arm.stale_claims,
  };
}

/**
 * Preregistered pick over the rrf_free (default) rows: the lowest correction
 * miss rate whose false supersession stays at or under 1% of probes and whose
 * preserved distinct claims stay at or over 99.5%; plus the equal-weight
 * balance (correction miss + coexisting false supersession).
 */
function pickThreshold(rows: SweepRow[]) {
  const num = (r: SweepRow, k: string) => Number(r[k] ?? 0);
  const safe = rows.filter(r => num(r, 'false_supersession_rate') <= 0.01 && num(r, 'preserved_distinct_share') >= 0.995);
  const pickMin = (xs: SweepRow[], f: (r: SweepRow) => number) => xs.length === 0 ? null : xs.reduce((a, b) => f(b) < f(a) ? b : a).threshold;
  return {
    rule: 'lowest correction miss rate with false supersession <= 1% of probes and preserved distinct claims >= 99.5% (rrf_free arm); balanced = argmin(correction miss + coexisting false supersession)',
    guarded: pickMin(safe, r => num(r, 'correction_miss_rate')),
    balanced: pickMin(rows, r => num(r, 'correction_miss_rate') + num(r, 'coexisting_false_supersession_rate')),
  };
}

/**
 * One-shot calibration for `gbrain doctor`'s supersession_calibration fix:
 * embed the fixture with the brain's model (paid, about a cent), sweep the
 * default arm over 0.80-0.97, print the key, the rows and the guarded pick.
 */
async function calibrate(model: string, dims: number, outPath: string): Promise<void> {
  await embedWithGateway(model, dims, outPath);
  const companies = buildFixture();
  const store = loadEmbeddings(outPath, fixtureTexts(companies));
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-offline-c2-eval-no-network' } });
  const rows: SweepRow[] = [];
  for (const tau of thresholdRange('0.80:0.97:0.01')) rows.push(sweepRow(await replay(dims, model, t => store.get(t), companies, 'rrf_free', tau), tau, 'rrf_free'));
  const pick = pickThreshold(rows);
  console.log(JSON.stringify({ key: calibrationKey(model, dims), threshold_pick: pick, threshold_sweep: rows,
    register: pick.guarded === null ? null : `gbrain config set ${SUPERSESSION_THRESHOLDS_KEY} '{"${calibrationKey(model, dims)}": ${pick.guarded}}'` }, null, 2));
}

/** `0.80:0.97:0.01` (inclusive range) or `0.85,0.9,0.95`. */
function thresholdRange(spec: string): number[] {
  if (!spec.includes(':')) return spec.split(',').map(Number);
  const [lo, hi, step] = spec.split(':').map(Number);
  const out: number[] = [];
  for (let i = 0; lo + i * step <= hi + 1e-9; i++) out.push(Math.round((lo + i * step) * 1000) / 1000);
  return out;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'texts') {
    const texts = fixtureTexts(buildFixture());
    console.log(JSON.stringify({ texts_sha256: sha256(JSON.stringify(texts)), texts }));
  } else if (cmd === 'run') {
    const arg = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
    const embeddings = arg('--embeddings');
    if (!embeddings) { console.error('run needs --embeddings <file> (make it with scripts/eval-c2-embed.py or the embed command)'); process.exit(2); }
    const range = arg('--taus');
    const taus = range ? thresholdRange(range) : TAUS;
    await run(embeddings, arg('--out'), taus, arg('--decision-id') ?? 'c2-interleave-dev');
  } else if (cmd === 'calibrate') {
    const [model, dims, out] = rest;
    if (!model || !Number.isInteger(Number(dims)) || !out) { console.error('calibrate needs <provider:model> <dims> <out-file> (paid provider calls, about a cent)'); process.exit(2); }
    await calibrate(model, Number(dims), out);
  } else if (cmd === 'embed') {
    const arg = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
    const model = arg('--model'); const dims = Number(arg('--dims')); const out = arg('--out');
    if (!model || !Number.isInteger(dims) || !out) { console.error('embed needs --model <provider:model> --dims <n> --out <file> (paid provider calls)'); process.exit(2); }
    console.log(JSON.stringify(await embedWithGateway(model, dims, out)));
  } else {
    console.error('usage: bun scripts/eval-c2-candidate-fusion.ts texts | calibrate <model> <dims> <out> | embed --model m --dims n --out f | run --embeddings <file> [--taus 0.80:0.97:0.01] [--decision-id id] [--out <dir>]');
    process.exit(2);
  }
}
