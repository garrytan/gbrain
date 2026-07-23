// v0.42.x — Life Chronicle (#2390) feature eval (Phase A.9), the PRIMARY proof.
//
// Deterministic + CI-safe (no LLM): builds a small synthetic corpus with a KNOWN
// gold chronology + a planted ontology supersession + a planted conflict, then
// asserts the chronicle layer answers the temporal/longitudinal questions
// correctly. This is the "does the feature deliver value" bar from the North
// Star — chronology reconstruction, last-seen, supersession time-travel,
// contradiction surfacing, source isolation — measured against gold, not vibes.
//
// The OFF baseline (raw meeting pages) structurally CANNOT order intra-day
// events or time-travel ontology; the ON path (chronicle ops) does. We score
// the ON path against gold; a perfect score is the proof the ops are correct.
import type { BrainEngine } from '../../core/engine.ts';
import { runChronicleExtract, type ChronicleJudge } from '../../core/chronicle/extract-events.ts';

export interface ChronicleEvalTask { id: string; passed: boolean; detail: string }
export interface ChronicleEvalResult {
  tasks: ChronicleEvalTask[];
  passed: number;
  total: number;
  score: number; // passed / total, [0,1]
}

const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';

/** Seed the synthetic corpus into a fresh engine (schema already initialized). */
export async function seedChronicleEvalCorpus(engine: BrainEngine): Promise<void> {
  // Two same-day meetings → two events, gold intra-day order AM then PM.
  await engine.putPage('meetings/2026-03-02-am', {
    type: 'meeting', title: 'Morning standup', compiled_truth: 'x'.repeat(120),
    frontmatter: { attendees: [ALICE] }, effective_date: new Date('2026-03-02T09:00:00Z'),
  });
  await engine.putPage('meetings/2026-03-02-pm', {
    type: 'meeting', title: 'Afternoon review', compiled_truth: 'y'.repeat(120),
    frontmatter: { attendees: [ALICE] }, effective_date: new Date('2026-03-02T15:00:00Z'),
  });
  const judge = (when: string, what: string): ChronicleJudge => async () => ({
    events: [{ when, who: [ALICE], what, kind: 'meeting' }],
  });
  await runChronicleExtract(engine, { slug: 'meetings/2026-03-02-am', judge: judge('2026-03-02T09:00:00Z', 'Morning standup') });
  await runChronicleExtract(engine, { slug: 'meetings/2026-03-02-pm', judge: judge('2026-03-02T15:00:00Z', 'Afternoon review') });

  // Ontology: alice was a founder, became an advisor (forward supersession).
  await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'role', value: 'founder', source: 'meetings/2024-01-10', validFrom: '2024-01-01' });
  await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'role', value: 'advisor', source: 'meetings/2026-03-02-pm', validFrom: '2026-03-01' });

  // Planted conflict: bob has two backdated-vs-forward open values from 2 sources.
  await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'advisor', source: 'meetings/a', validFrom: '2026-05-01' });
  await engine.mergeOntologyFact({ entitySlug: BOB, dimension: 'role', value: 'founder', source: 'meetings/b', validFrom: '2026-01-01' });
}

export async function runChronicleEval(engine: BrainEngine): Promise<ChronicleEvalResult> {
  await seedChronicleEvalCorpus(engine);
  const tasks: ChronicleEvalTask[] = [];
  const check = (id: string, ok: boolean, detail: string) => tasks.push({ id, passed: ok, detail });

  // 1. Day reconstruction in correct intra-day order.
  const day = await engine.getTimelineForDate('2026-03-02', { sourceId: 'default' });
  const order = day.map((r) => r.summary);
  check('day_order', JSON.stringify(order) === JSON.stringify(['Morning standup', 'Afternoon review']),
    `order=${JSON.stringify(order)}`);

  // 2. Last-seen exact date.
  const ls = await engine.getLastSeen(ALICE, { sourceId: 'default' });
  check('last_seen', ls.last_date === '2026-03-02', `last_date=${ls.last_date}`);

  // 3. Supersession: current value is the new one.
  const now = await engine.getOntology(ALICE, { sourceId: 'default' });
  const roleNow = now.find((v) => v.dimension === 'role')?.value;
  check('supersession_now', roleNow === 'advisor', `role_now=${roleNow}`);

  // 4. Valid-time travel: as-of before the change returns the prior value.
  const past = await engine.getOntology(ALICE, { sourceId: 'default', asof: '2025-01-01' });
  const rolePast = past.find((v) => v.dimension === 'role')?.value;
  check('supersession_asof', rolePast === 'founder', `role_asof=${rolePast}`);

  // 5. Contradiction surfaced (genuine disagreement, not supersession).
  const conflicts = await engine.findOntologyConflicts({ sourceId: 'default' });
  check('conflict_surfaced', conflicts.some((c) => c.entity_slug === BOB && c.dimension === 'role'),
    `conflicts=${conflicts.length}`);

  // 6. Source isolation: querying another source leaks nothing.
  const otherSource = await engine.getOntology(ALICE, { sourceId: 'nonexistent-source' });
  check('source_isolation', otherSource.length === 0, `leaked=${otherSource.length}`);

  const passed = tasks.filter((t) => t.passed).length;
  return { tasks, passed, total: tasks.length, score: tasks.length ? passed / tasks.length : 0 };
}
