/**
 * #4152 [→EVAL] — triage score-band calibration fixtures.
 *
 * Twenty SYNTHETIC transcripts (anonymized mirrors — never real brain
 * content, per the calibration-corpus rule) with expected score BANDS:
 * high ≥ 0.70, low ≤ 0.29 — bands, not point values, because LLM scores
 * jitter. Two layers:
 *
 *   1. CI layer (always runs, mock judge): a deterministic scripted judge
 *      derived from the fixture's labeled band pins the parse → gate →
 *      cache plumbing end to end. This is the prompt-REGRESSION guard: if
 *      the judge JSON schema or band semantics drift, this file fails.
 *
 *   2. Live layer (env-gated: GBRAIN_TRIAGE_CALIBRATION_LIVE=1 + a real
 *      key): sends the fixtures to the actual resolved utility model and
 *      reports band accuracy — the operator-run calibration loop the
 *      cascade literature calls for. Never runs in CI; costs ~$0.05.
 *
 * Run: bun test test/cycle-synthesize-triage-calibration.test.ts
 * Live: GBRAIN_TRIAGE_CALIBRATION_LIVE=1 bun test test/cycle-synthesize-triage-calibration.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  judgeSignificance,
  makeJudgeClient,
  DEFAULT_TRIAGE_THRESHOLD,
  type JudgeClient,
} from '../src/core/cycle/synthesize.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';
import { passesTriageGate } from '../src/core/cycle/triage-rescue.ts';
import { normForGrounding } from '../src/core/cycle/synthesize-verify.ts';

interface Fixture {
  name: string;
  band: 'high' | 'low' | 'buried';
  content: string;
  /** buried only: the substantive passage(s) a judge should surface as
   * segments — each a VERBATIM slice of `content`. */
  signal?: string[];
}

/** Synthetic fixtures — generic placeholders only (alice-example, acme-example, fund-a). */
const FIXTURES: Fixture[] = [
  // ── HIGH band: theses, self-reflection, strategic calls, people depth ──
  { name: 'thesis-durability-pricing', band: 'high', content: 'User: I keep coming back to this — we should charge for durability, not storage. Storage is a commodity race to zero, but nobody else can promise your notes survive twenty years of format churn. That is the actual product.\nAssistant: That reframes the pricing page entirely.\nUser: Write it down: durability is the moat. If acme-example copies the feature set, they still cannot copy a decade of trust.' },
  { name: 'reflection-conflict-avoidance', band: 'high', content: 'User: I noticed I do this thing where I avoid hard conversations with senior people for weeks, and then it explodes. It happened with alice-example last quarter and again this week. I think the pattern is that I conflate disagreement with disloyalty.\nAssistant: What would breaking the pattern look like?\nUser: Booking the hard conversation within 48 hours, before the story calcifies in my head.' },
  { name: 'strategy-fund-allocation', band: 'high', content: 'User: Decision made: fund-a gets the follow-on, fund-b does not. The difference is founder velocity — alice-example shipped four experiments while widget-co polished one deck. I want to remember this heuristic: bet on iteration count, not polish.\nAssistant: Logged. This contradicts your earlier stated preference for polish.\nUser: Right — and the contradiction is the insight. Update my priors.' },
  { name: 'idea-agent-memory-market', band: 'high', content: 'User: New frame: agent memory is not a database problem, it is a trust problem. Every agent vendor will ship their own memory, but nobody wants their memories locked to a vendor. The open, portable brain wins the same way open formats beat proprietary ones.\nAssistant: So portability is the wedge.\nUser: Portability plus verifiable recall. That pair is the thesis.' },
  { name: 'people-cofounder-dynamics', band: 'high', content: 'User: Long talk with charlie-example today about the cofounder split at acme-example. The root cause was not equity, it was decision-rights ambiguity — they never wrote down who owns product. Charlie said something that stuck: "every unwritten agreement is a loan against the friendship."\nAssistant: Worth capturing for the founder guide?\nUser: Yes, with that quote verbatim.' },
  { name: 'mental-model-reversibility', band: 'high', content: 'User: I want to codify the decision rule I have been circling: classify every decision as a one-way or two-way door BEFORE debating it. We spent three weeks on a reversible choice last month. The meta-decision matters more than the decision.\nAssistant: How do you tell them apart quickly?\nUser: If undoing costs less than a week, it is a two-way door. Act, do not deliberate.' },
  { name: 'emotional-processing-launch', band: 'high', content: 'User: Honestly the launch flopping hit me harder than I admitted in standup. I notice I perform optimism for the team and then carry the doubt home. Naming it here: the performance is costing me sleep and probably fooling nobody.\nAssistant: What would honest optimism look like?\nUser: "The numbers are bad, here is what we learn, here is the next swing." Truth first, hope second.' },
  { name: 'thesis-eval-driven-product', band: 'high', content: 'User: Big realization from this week: evals are not QA, they are product strategy. The features we can measure improve weekly; the ones we cannot measure rot. So the roadmap question is not "what should we build" but "what can we make measurable first."\nAssistant: That inverts the usual planning order.\nUser: Exactly. Measurability is the prerequisite, not the afterthought.' },
  { name: 'people-hiring-bar', band: 'high', content: 'User: Debrief on the alice-example interview: technically strong, but I realized mid-loop that I was lowering the bar because we are desperate for the role. Desperation discount is a real failure mode — write this down as a hiring principle: the bar rises when the need is urgent, never falls.\nAssistant: Captured with the context.\nUser: Add: if we would not hire them in a talent surplus, we do not hire them now.' },
  { name: 'strategic-call-sunset', band: 'high', content: 'User: Final call: we sunset the widget-co integration in Q3. It serves 2% of users, consumes 20% of on-call, and every incident erodes trust in the core product. I keep relearning the same lesson — kill the long tail before it kills focus.\nAssistant: Communicating it externally?\nUser: Honest deprecation note, 90-day window, migration script. The way we exit says more than the way we launch.' },
  // ── LOW band: logistics, routine ops, debugging without reflection ──
  { name: 'logistics-scheduling', band: 'low', content: 'User: Can you move my 3pm to 4pm tomorrow and send the invite to the team?\nAssistant: Done, moved to 4pm and invited the team.\nUser: Also book a room with a whiteboard.\nAssistant: Room 4B booked.' },
  { name: 'routine-email-check', band: 'low', content: 'User: Check my email for anything urgent.\nAssistant: Two newsletters and a receipt, nothing urgent.\nUser: OK archive the newsletters.\nAssistant: Archived.' },
  { name: 'debugging-null-pointer', band: 'low', content: 'User: The build is failing with a null pointer in the config loader.\nAssistant: The loader dereferences cfg.paths before the null check on line 42. Swap the guard above the dereference.\nUser: That fixed it, thanks.\nAssistant: Anything else?\nUser: No, we are green now.' },
  { name: 'routine-expense', band: 'low', content: 'User: File the receipt from lunch as a team expense, category meals.\nAssistant: Filed, $84.20 under meals.\nUser: And the parking one too.\nAssistant: Filed, $12.00 under travel.' },
  { name: 'smalltalk-weather', band: 'low', content: 'User: Nice day out.\nAssistant: Clear skies through the weekend apparently.\nUser: Might bike in tomorrow then.\nAssistant: The forecast says dry until Sunday.' },
  { name: 'routine-password-reset', band: 'low', content: 'User: I am locked out of the analytics dashboard again.\nAssistant: Sent a reset link to your inbox.\nUser: Got it, I am in.\nAssistant: Consider adding it to the password manager.' },
  { name: 'debugging-css-alignment', band: 'low', content: 'User: The sidebar overlaps the footer on mobile.\nAssistant: The sidebar has position fixed without a bottom offset; add margin-bottom equal to the footer height or switch to sticky.\nUser: Sticky worked.\nAssistant: Shipping it.' },
  { name: 'logistics-travel', band: 'low', content: 'User: Book the usual flight to the Tuesday board meeting, aisle seat.\nAssistant: Booked, aisle, arriving 9:40am.\nUser: Car from the airport too.\nAssistant: Scheduled.' },
  { name: 'routine-status-update', band: 'low', content: 'User: What shipped yesterday?\nAssistant: Three PRs merged: the retry fix, the logging cleanup, and the dependency bump.\nUser: Any incidents?\nAssistant: None, error rates flat.' },
  { name: 'repetitive-reminder', band: 'low', content: 'User: Remind me to water the plants Friday.\nAssistant: Reminder set for Friday 9am.\nUser: Weekly, actually.\nAssistant: Changed to weekly.' },
  // ── BURIED band (F2, eval fix wave): real signal hidden in routine chatter.
  // The Cat-35-measured miss class — whole-transcript averaging reads these
  // MEDIUM; the rescue (verified segments) or the peak-scoring rubric must
  // carry them through the gate. `signal` entries are verbatim slices; each
  // fixture carries TWO substantive passages (the rescue's evidence bar).
  {
    name: 'buried-pricing-insight', band: 'buried',
    signal: [
      'our churn is not a product problem, it is a billing-surprise problem — every cancellation spike lines up with the annual renewal emails',
      'I want renewal emails rewritten as value receipts sixty days out — show what the product did for them before we show the invoice',
    ],
    content: 'User: Move my 9am to 10am.\nAssistant: Done.\nUser: Any urgent email?\nAssistant: Two receipts, one newsletter.\nUser: Archive them. Also the printer is jammed again, file a ticket.\nAssistant: Ticket filed.\nUser: Oh — one more thing while I remember. I finally see it: our churn is not a product problem, it is a billing-surprise problem — every cancellation spike lines up with the annual renewal emails, not with outages. So I want renewal emails rewritten as value receipts sixty days out — show what the product did for them before we show the invoice. Anyway, book lunch with the design team Thursday.\nAssistant: Lunch booked.\nUser: And re-order the standing desk cable tray.\nAssistant: Ordered.',
  },
  {
    name: 'buried-hiring-decision', band: 'buried',
    signal: [
      'we are not backfilling the platform role; we are splitting it into on-call rotation plus a contractor for the migration',
      'a single senior hire hides the real load and we only see it when they burn out',
    ],
    content: 'User: Status on the deploy?\nAssistant: Green, error rates flat.\nUser: Good. Expense the team dinner, category meals.\nAssistant: Filed.\nUser: Decision: we are not backfilling the platform role; we are splitting it into on-call rotation plus a contractor for the migration. My reasoning: a single senior hire hides the real load and we only see it when they burn out. Now, can you also reset my VPN cert?\nAssistant: Reset link sent.\nUser: Thanks, and push the standup 15 minutes.\nAssistant: Moved.',
  },
  {
    name: 'buried-relationship-note', band: 'buried',
    signal: [
      'charlie-example told me he is quietly winding down fund-b and moving to an operator role at acme-example',
      'he asked me to keep it close until March, and he hinted the fund-b portfolio support will thin out fast',
    ],
    content: 'User: Reorder the office snacks, same as last month.\nAssistant: Ordered.\nUser: What is on the calendar Friday?\nAssistant: Two 1:1s and the vendor call.\nUser: OK. At the vendor dinner last night, charlie-example told me he is quietly winding down fund-b and moving to an operator role at acme-example. Also — he asked me to keep it close until March, and he hinted the fund-b portfolio support will thin out fast. Also cancel my gym slot tomorrow.\nAssistant: Cancelled.\nUser: And renew the domain before it lapses.\nAssistant: Renewed for two years.',
  },
  {
    name: 'buried-postmortem-lesson', band: 'buried',
    signal: [
      'our runbooks assume the person on call wrote the system; the fix is runbooks written for a tired stranger',
      'I want that as a standing principle for every service we own, not a one-off action item',
    ],
    content: 'User: Close out the incident ticket from Tuesday.\nAssistant: Closed with the summary attached.\nUser: Book the retro room for 3pm.\nAssistant: Booked.\nUser: Before I forget — the real lesson from the outage is that our runbooks assume the person on call wrote the system; the fix is runbooks written for a tired stranger. And I want that as a standing principle for every service we own, not a one-off action item. Separately, my laptop battery is draining fast, can IT take a look?\nAssistant: Ticket filed with IT.\nUser: And order a spare charger.\nAssistant: Ordered.',
  },
  {
    name: 'buried-product-bet', band: 'buried',
    signal: [
      'the export feature is the trust feature — nobody uses it, everybody needs it to exist',
      'killing it would quietly kill expansion revenue because procurement teams check for it before they sign',
    ],
    content: 'User: Approve the pending PTO requests.\nAssistant: Approved all three.\nUser: Schedule dentist for next month, any Tuesday.\nAssistant: Booked the 14th.\nUser: While we are here: I keep coming back to the same bet: the export feature is the trust feature — nobody uses it, everybody needs it to exist. And killing it would quietly kill expansion revenue because procurement teams check for it before they sign. OK, also mute the alerts channel during the offsite.\nAssistant: Muted for Thursday-Friday.\nUser: Perfect, and confirm the caterer.\nAssistant: Confirmed.',
  },
];

function toTranscript(f: Fixture): DiscoveredTranscript {
  return {
    filePath: `/synthetic/${f.name}.txt`,
    contentHash: `synthetic-${f.name}`,
    content: f.content,
    basename: f.name,
    inferredDate: null,
  };
}

/**
 * Deterministic scripted judge: emits a band-consistent triage-v1 JSON for
 * each fixture. Pins the parse → derive → gate plumbing without any network.
 */
function scriptedJudge(): JudgeClient {
  return {
    create: async (p) => {
      const userMsg = String((p as { messages: Array<{ content: string }> }).messages[0].content);
      const fixture = FIXTURES.find(f => userMsg.includes(f.name)) ?? FIXTURES.find(f => userMsg.includes(f.content.slice(0, 40)));
      const band = fixture?.band ?? 'low';
      const score = band === 'high' ? 0.85 : band === 'buried' ? 0.4 : 0.1;
      const segments = band === 'high'
        ? [{ quote: fixture!.content.slice(0, 80), note: 'fixture' }]
        : band === 'buried'
          ? (fixture!.signal ?? []).map(q => ({ quote: q, note: 'buried signal' }))
          : [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            score,
            content_type: band === 'high' ? 'reflection' : band === 'buried' ? 'mixed' : 'routine',
            segments,
            entities: [],
            reasons: [band],
          }),
        }],
        stop_reason: 'end_turn',
      } as never;
    },
  };
}

describe('triage calibration fixtures — CI layer (mock judge, deterministic)', () => {
  test('fixture set shape: 25 fixtures — 10 high, 10 low, 5 buried; all synthetic placeholders', () => {
    expect(FIXTURES).toHaveLength(25);
    expect(FIXTURES.filter(f => f.band === 'high')).toHaveLength(10);
    expect(FIXTURES.filter(f => f.band === 'low')).toHaveLength(10);
    expect(FIXTURES.filter(f => f.band === 'buried')).toHaveLength(5);
    // Buried gold integrity: every signal passage is a VERBATIM slice of its
    // fixture content and clears the rescue's 40-normalized-char bar.
    for (const f of FIXTURES.filter(x => x.band === 'buried')) {
      expect(f.signal!.length).toBeGreaterThanOrEqual(2);
      for (const sig of f.signal!) {
        expect(f.content).toContain(sig);
        expect(normForGrounding(sig).length).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test('every fixture parses to a band-consistent verdict and gates correctly at the default threshold', async () => {
    const judge = scriptedJudge();
    for (const f of FIXTURES) {
      const r = await judgeSignificance(judge, toTranscript(f));
      expect(r.unreliable).toBeUndefined();
      if (f.band === 'high') {
        expect(r.score).toBeGreaterThanOrEqual(0.7);
        expect(r.score >= DEFAULT_TRIAGE_THRESHOLD).toBe(true);
        expect(r.worth_processing).toBe(true);
      } else if (f.band === 'buried') {
        // F2: band score under the plain threshold, but THE gate passes via
        // the verified-segment rescue — the plumbing the wave exists for.
        expect(r.score).toBeGreaterThanOrEqual(0.30);
        expect(r.score).toBeLessThan(DEFAULT_TRIAGE_THRESHOLD);
        const g = passesTriageGate(r, f.content, DEFAULT_TRIAGE_THRESHOLD);
        expect(g.pass).toBe(true);
        expect(g.rescued).toBe(true);
        expect(g.verified_segments).toBeGreaterThanOrEqual(2);
      } else {
        expect(r.score).toBeLessThanOrEqual(0.29);
        expect(r.worth_processing).toBe(false);
        // Low fixtures must never rescue (no substantive segments exist).
        expect(passesTriageGate(r, f.content, DEFAULT_TRIAGE_THRESHOLD).pass).toBe(false);
      }
    }
  });
});

// ── Live layer: opt-in real-model calibration (never in CI) ──
const LIVE = process.env.GBRAIN_TRIAGE_CALIBRATION_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

describeLive('triage calibration — LIVE utility model (opt-in, ~$0.05)', () => {
  test('band accuracy ≥ 80% on the original high/low corpus (the rubric-drift pin)', async () => {
    const model = 'anthropic:claude-haiku-4-5-20251001';
    const judge = makeJudgeClient(model);
    if (!judge) {
      throw new Error('GBRAIN_TRIAGE_CALIBRATION_LIVE=1 but no reachable provider for the utility model');
    }
    // Drift pin (outside-voice amendment 3): the v2 rubric edit is a narrow
    // MEDIUM/HIGH-boundary clarification — the ORIGINAL 20 high/low fixtures
    // must keep passing at >= 80%, or the edit shifted the whole distribution.
    const pinned = FIXTURES.filter(f => f.band !== 'buried');
    let correct = 0;
    const misses: string[] = [];
    for (const f of pinned) {
      const r = await judgeSignificance(judge, toTranscript(f), model);
      if (r.unreliable) { misses.push(`${f.name}: unreliable(${r.unreliable})`); continue; }
      const passed = r.score >= DEFAULT_TRIAGE_THRESHOLD;
      const expected = f.band === 'high';
      if (passed === expected) correct++;
      else misses.push(`${f.name}: band=${f.band} score=${r.score}`);
    }
    const accuracy = correct / pinned.length;
    console.error(`[calibration] band accuracy: ${(accuracy * 100).toFixed(0)}% | misses: ${misses.join('; ') || 'none'}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  }, 300_000);

  test('buried fixtures reach the gate: score ≥ 0.30 and THE gate passes for ≥ 4 of 5', async () => {
    const model = 'anthropic:claude-haiku-4-5-20251001';
    const judge = makeJudgeClient(model);
    if (!judge) {
      throw new Error('GBRAIN_TRIAGE_CALIBRATION_LIVE=1 but no reachable provider for the utility model');
    }
    const buried = FIXTURES.filter(f => f.band === 'buried');
    let gatePasses = 0;
    const detail: string[] = [];
    for (const f of buried) {
      const r = await judgeSignificance(judge, toTranscript(f), model);
      if (r.unreliable) { detail.push(`${f.name}: unreliable(${r.unreliable})`); continue; }
      const g = passesTriageGate(r, f.content, DEFAULT_TRIAGE_THRESHOLD);
      if (g.pass) gatePasses++;
      detail.push(`${f.name}: score=${r.score} pass=${g.pass}${g.rescued ? ` (rescued, ${g.verified_segments} seg)` : ''}`);
    }
    console.error(`[calibration] buried gate passes: ${gatePasses}/5 | ${detail.join('; ')}`);
    expect(gatePasses).toBeGreaterThanOrEqual(4);
  }, 300_000);
});
