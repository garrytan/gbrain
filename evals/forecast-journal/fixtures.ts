/**
 * W7 forecast-journal gate ($0, synthetic): the deterministic fixture
 * generator. REPLICATES independent cohorts, each on its own source, of
 * placeholder holders with a known skill (the probability that a resolved
 * prediction of theirs comes out correct). Every prediction is a bet with a
 * stated deadline ("by the end of YYYY") about one of TOPICS placeholder
 * company pages, so the journal's horizon scan dates it; each holder also
 * has one overdue and one open prediction, and each cohort one undated take.
 * Pure: the same seed gives the same bytes (fixturesSha256 pins them in
 * PREREGISTRATION.md and the keyless test).
 */
import { createHash } from 'node:crypto';

export const SEED = 20261017;
export const REPLICATES = 20;
export const SKILLED_HOLDERS = 12;
export const LOW_N_HOLDERS = 2;
export const LOW_N = 4;
export const TOPICS = 40;
export const AS_OF = '2026-10-16T00:00:00Z';
/** Skill of holder i (1-based, skilled holders only): evenly spaced from 0.30 to 0.90. */
export const skillOf = (i: number) => Number((0.3 + (0.6 * (i - 1)) / (SKILLED_HOLDERS - 1)).toFixed(4));

export interface Prediction {
  topic: string; claim: string; kind: 'bet' | 'take'; holder: string; weight: number; since: string;
  outcome: 'correct' | 'incorrect' | null; resolved_at: string | null; resolved_source: string | null;
  /** Gold state as of AS_OF. */
  state: 'resolved' | 'overdue' | 'open' | 'undated';
}
export interface Cohort { replicate: number; source_id: string; holders: Array<{ holder: string; skill: number | null; resolved: number }>; predictions: Prediction[] }

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

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const topicSlug = (t: number) => `companies/topic-${pad(t, 3)}-example`;
const topicName = (t: number) => `Topic-${pad(t, 3)}-example`;

export function cohorts(): Cohort[] {
  const rand = mulberry32(SEED);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: Cohort[] = [];
  for (let r = 1; r <= REPLICATES; r++) {
    const predictions: Prediction[] = [];
    const holders: Cohort['holders'] = [];
    let k = 0;
    const bet = (holder: string, year: number, extra: Partial<Prediction>): Prediction => {
      const t = int(1, TOPICS);
      k++;
      return { topic: topicSlug(t), claim: `${topicName(t)} will reach milestone ${k} by the end of ${year}`, kind: 'bet', holder,
        weight: Number((0.55 + 0.4 * rand()).toFixed(2)), since: `${year - 1}-${pad(int(1, 12))}`, outcome: null, resolved_at: null, resolved_source: null, state: 'open', ...extra };
    };
    for (let i = 1; i <= SKILLED_HOLDERS + LOW_N_HOLDERS; i++) {
      const holder = `holder-${pad(i)}-example`;
      const skilled = i <= SKILLED_HOLDERS;
      const skill = skilled ? skillOf(i) : 0.6;
      const n = skilled ? int(10, 30) : LOW_N;
      holders.push({ holder, skill: skilled ? skill : null, resolved: n });
      for (let j = 0; j < n; j++) {
        const year = int(2021, 2024);
        predictions.push(bet(holder, year, {
          outcome: rand() < skill ? 'correct' : 'incorrect',
          resolved_at: `${year + 1}-${pad(int(1, 6))}-${pad(int(1, 28))}T00:00:00Z`,
          resolved_source: rand() < 0.8 ? `notes/${year + 1}-evidence-${pad(int(1, 99))}-example` : null,
          state: 'resolved',
        }));
      }
      predictions.push(bet(holder, 2025, { state: 'overdue' }));
      predictions.push(bet(holder, 2030, { state: 'open' }));
    }
    predictions.push({ topic: topicSlug(1), claim: `${topicName(1)} has the strongest team in its market`, kind: 'take', holder: 'holder-01-example',
      weight: 0.7, since: '2024-03', outcome: null, resolved_at: null, resolved_source: null, state: 'undated' });
    out.push({ replicate: r, source_id: `fj-rep-${pad(r)}`, holders, predictions });
  }
  return out;
}

export const fixturesSha256 = () => createHash('sha256').update(JSON.stringify(cohorts())).digest('hex');

/** Gold for "who was right about T": per topic, the holders with a correct resolved prediction on it. */
export function whoWasRight(c: Cohort): Map<string, Set<string>> {
  const gold = new Map<string, Set<string>>();
  for (let t = 1; t <= TOPICS; t++) gold.set(topicSlug(t), new Set());
  for (const p of c.predictions) if (p.outcome === 'correct') gold.get(p.topic)!.add(p.holder);
  return gold;
}
