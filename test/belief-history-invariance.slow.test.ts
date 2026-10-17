/**
 * W3 invariance gate, assertions 1 to 3 (docs/architecture/historical-retrieval.md
 * section 7). For each seed, engine and caller, the evidence think and
 * `search {known_as_of}` build at a quiescent T is byte-identical before and
 * after a seeded later history; every removed-phrase question finds its phrase
 * in the T body while today's pipeline after the later history does not (the
 * control); and the indexed retriever returns the brute-force oracle's
 * ranking. 20 seeds x 12 questions x 2 engines x 2 callers = 960 comparisons
 * (GBRAIN_HISTORY_GATE_SEEDS narrows a local run; the gate runs 20). The E2E tier
 * runs the Postgres arm in two halves (GBRAIN_HISTORY_GATE_SEED_FROM), each inside
 * its per-file cap.
 */
import { describe, expect, test } from 'bun:test';
import { testBackends } from './helpers/test-backends.ts';
import { beliefEngineCase } from './helpers/belief-ledger.ts';
import { applyLaterHistory, callers, captureEvidence, evidenceBlocks, oracleRanking, retrieverRanking, thinkPrompt, withWorld } from './helpers/history-world.ts';

const SEEDS = Number(process.env.GBRAIN_HISTORY_GATE_SEEDS ?? 20);
const FROM = Number(process.env.GBRAIN_HISTORY_GATE_SEED_FROM ?? 1);
const ORACLE_LIMIT = 10;

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`W3 historical retrieval invariance (${engineCase.name})`, () => {
    for (let seed = FROM; seed <= SEEDS; seed++) {
      test(`seed ${seed}: evidence at T is unchanged by the later history, removed phrases are found only through history, and the index agrees with the oracle`, () => withWorld(seed, engineCase.databaseUrl, async (b, w) => {
        expect(w.questions).toHaveLength(12);
        expect(w.questions.filter(q => q.removed).length).toBeGreaterThanOrEqual(3);
        const before = new Map<string, string>();
        for (const caller of callers(b)) {
          for (const q of w.questions) {
            before.set(`${caller.name}|${q.id}`, await captureEvidence(b, caller, q, w.T));
            expect(await retrieverRanking(b, caller, q.text, w.T, ORACLE_LIMIT)).toEqual(await oracleRanking(b, caller, q.text, w.T, ORACLE_LIMIT));
          }
        }
        const changes = await applyLaterHistory(b, w);
        expect(changes).toBeGreaterThanOrEqual(30);
        expect(changes).toBeLessThanOrEqual(60);
        let compared = 0;
        for (const caller of callers(b)) {
          for (const q of w.questions) {
            const key = `${caller.name}|${q.id}`;
            expect({ key, evidence: await captureEvidence(b, caller, q, w.T) }).toEqual({ key, evidence: before.get(key)! });
            compared++;
            expect(await retrieverRanking(b, caller, q.text, w.T, ORACLE_LIMIT)).toEqual(await oracleRanking(b, caller, q.text, w.T, ORACLE_LIMIT));
          }
        }
        expect(compared).toBe(24);
        // Assertion 2: the T evidence holds each removed phrase; today's think after the later history does not (the control).
        for (const caller of callers(b)) {
          for (const q of w.questions.filter(x => x.removed)) {
            const found = evidenceBlocks((await thinkPrompt(b, caller, q.text, w.T)).prompt).includes(q.removed!.phrase);
            const today = evidenceBlocks((await thinkPrompt(b, caller, q.text)).prompt).includes(q.removed!.phrase);
            expect({ q: q.id, caller: caller.name, found, today }).toEqual({ q: q.id, caller: caller.name, found: true, today: false });
          }
        }
      }), 600_000);
    }
  });
}
