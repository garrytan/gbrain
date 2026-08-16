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

interface Fixture {
  name: string;
  band: 'high' | 'low';
  content: string;
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
      const score = band === 'high' ? 0.85 : 0.1;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            score,
            content_type: band === 'high' ? 'reflection' : 'routine',
            segments: band === 'high' ? [{ quote: fixture!.content.slice(0, 80), note: 'fixture' }] : [],
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
  test('fixture set shape: 20 fixtures, 10 per band, all synthetic placeholders', () => {
    expect(FIXTURES).toHaveLength(20);
    expect(FIXTURES.filter(f => f.band === 'high')).toHaveLength(10);
    expect(FIXTURES.filter(f => f.band === 'low')).toHaveLength(10);
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
      } else {
        expect(r.score).toBeLessThanOrEqual(0.29);
        expect(r.worth_processing).toBe(false);
      }
    }
  });
});

// ── Live layer: opt-in real-model calibration (never in CI) ──
const LIVE = process.env.GBRAIN_TRIAGE_CALIBRATION_LIVE === '1';
const describeLive = LIVE ? describe : describe.skip;

describeLive('triage calibration — LIVE utility model (opt-in, ~$0.05)', () => {
  test('band accuracy ≥ 80% on the synthetic corpus', async () => {
    const model = 'anthropic:claude-haiku-4-5-20251001';
    const judge = makeJudgeClient(model);
    if (!judge) {
      throw new Error('GBRAIN_TRIAGE_CALIBRATION_LIVE=1 but no reachable provider for the utility model');
    }
    let correct = 0;
    const misses: string[] = [];
    for (const f of FIXTURES) {
      const r = await judgeSignificance(judge, toTranscript(f), model);
      if (r.unreliable) { misses.push(`${f.name}: unreliable(${r.unreliable})`); continue; }
      const passed = r.score >= DEFAULT_TRIAGE_THRESHOLD;
      const expected = f.band === 'high';
      if (passed === expected) correct++;
      else misses.push(`${f.name}: band=${f.band} score=${r.score}`);
    }
    const accuracy = correct / FIXTURES.length;
    console.error(`[calibration] band accuracy: ${(accuracy * 100).toFixed(0)}% | misses: ${misses.join('; ') || 'none'}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  }, 300_000);
});
