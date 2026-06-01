/**
 * Tests for `gbrain candidate scorecard` — a narrow, proof-first compare
 * view for evaluating VA candidates against a role brief.
 *
 * Privacy invariant: fixtures anonymize people and candidate identities.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  buildCandidateFitBriefFromText,
  buildCandidateFitCompare,
  computeCandidateFitScorecard,
} from '../src/commands/candidate-scorecard.ts';

const HOSTAWAY_BRIEF = `
I'm not looking for a generic STR VA. The useful role here is someone who has
actually lived inside Hostaway-heavy guest ops.

- Hostaway inbox triage across 5 active listings, with conversation volume
mostly Airbnb, then VRBO, then Direct
- guest comms ownership: arrival questions, stay issues, post-stay follow-up,
escalation notes, and keeping the thread clean
- reservation hygiene: new / modified / inquiry / cancelled reservations,
missing guest contact fields, and handoff notes
- vendor / maintenance coordination when a guest issue needs action instead
of just a reply
- owner-update support when a guest issue, stay change, or operational
pattern needs a clean summary
- repeat-guest / direct-booking support: manually inspect high-value repeat
OTA households, prep outreach, and keep evidence tied back to Hostaway
rather than claiming wins without proof
- listing/revenue support around property-level patterns, but only if they
can work from actual reservation and channel data

For each candidate:
1. Which PMS they used, and whether Hostaway was a daily working surface
2. Portfolio size and property type they supported
3. What they personally owned day to day
4. A concrete example of a messy guest/reservation issue they handled end to end
5. Whether they have worked from reservation/channel data, not just inbox messages
6. Timezone, working hours, and rate range
`;

describe('buildCandidateFitBriefFromText', () => {
  test('turns the Hostaway-heavy brief into weighted criteria without private names', () => {
    const brief = buildCandidateFitBriefFromText(HOSTAWAY_BRIEF);

    expect(brief.schema_version).toBe(1);
    expect(brief.criteria.map((c) => c.id)).toEqual([
      'hostaway_daily_surface',
      'portfolio_match',
      'guest_comms_ownership',
      'reservation_hygiene',
      'vendor_maintenance_coordination',
      'owner_update_support',
      'repeat_guest_direct_booking_support',
      'listing_revenue_data_support',
      'messy_issue_example',
      'timezone_hours_rate',
    ]);
    expect(brief.criteria.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
    expect(JSON.stringify(brief)).not.toContain('Private Recruiter');
    expect(JSON.stringify(brief)).not.toContain('Private Referrer');
  });
});

describe('computeCandidateFitScorecard', () => {
  const brief = buildCandidateFitBriefFromText(HOSTAWAY_BRIEF);

  test('scores a Hostaway-ops candidate high with source-backed evidence', () => {
    const scorecard = computeCandidateFitScorecard({
      brief,
      candidateId: 'candidate_a',
      resumeSummary: `
        Supported 8 short-term rental properties across beach homes and condos.
        Hostaway was the daily PMS surface for inbox triage, reservations, guest
        contact fields, and channel notes. Owned Airbnb, VRBO, and direct guest
        messages, arrival questions, in-stay issues, post-stay follow-up, and
        escalation notes. Coordinated vendors for a same-day AC failure, updated
        the owner with a clean summary, and closed the loop in Hostaway. Reviewed
        reservation and channel data for repeat OTA households and listing/revenue
        patterns. Philippines timezone, 9am-5pm ET overlap, $9-$11/hr.
      `,
    });

    expect(scorecard.candidate_id).toBe('candidate_a');
    expect(scorecard.fit_score).toBeGreaterThanOrEqual(90);
    expect(scorecard.recommendation).toBe('strong_fit');
    expect(scorecard.red_flags).toEqual([]);
    expect(scorecard.criteria.find((c) => c.id === 'hostaway_daily_surface')?.status).toBe('strong');
    expect(scorecard.criteria.find((c) => c.id === 'messy_issue_example')?.evidence.length).toBeGreaterThan(0);
  });

  test('penalizes generic VA evidence and flags growth claims without ops proof', () => {
    const scorecard = computeCandidateFitScorecard({
      brief,
      candidateId: 'candidate_b',
      resumeSummary: `
        General admin VA with Airbnb inbox experience, calendar updates, Canva,
        spreadsheet cleanup, and social posting. Light exposure to Hostaway during
        training but not a daily working surface. Interested in growth VA work and
        direct booking campaigns. No owner updates, vendor coordination, reservation
        channel-data examples, or messy guest issue example provided. Available
        flexible hours, $6/hr.
      `,
    });

    expect(scorecard.fit_score).toBeLessThan(45);
    expect(scorecard.recommendation).toBe('weak_fit');
    expect(scorecard.red_flags.map((f) => f.kind)).toContain('hostaway_gap');
    expect(scorecard.red_flags.map((f) => f.kind)).toContain('growth_claim_without_ops_proof');
    expect(scorecard.criteria.find((c) => c.id === 'hostaway_daily_surface')?.status).toBe('weak');
  });

  test('does not count unrelated words like accurate as rate evidence', () => {
    const scorecard = computeCandidateFitScorecard({
      brief,
      candidateId: 'candidate_c',
      resumeSummary: 'Remote operations coordinator with accurate records and fast-paced workflows.',
    });

    expect(scorecard.criteria.find((c) => c.id === 'timezone_hours_rate')?.status).toBe('weak');
  });

  test('does not count unrelated words like strong as STR portfolio evidence', () => {
    const scorecard = computeCandidateFitScorecard({
      brief,
      candidateId: 'candidate_d',
      resumeSummary: 'Strong mix of real estate admin, outreach, scheduling, and content support.',
    });

    expect(scorecard.criteria.find((c) => c.id === 'portfolio_match')?.status).toBe('weak');
  });

  test('hashes non-generic candidate ids and redacts private evidence tokens', () => {
    const scorecard = computeCandidateFitScorecard({
      brief,
      candidateId: 'Private Person - Resume',
      resumeSummary: `
        Private Person worked inside Hostaway for daily inbox triage, reservations,
        and channel notes at Example Rentals. Reach them at candidate@example.com or
        555-123-4567. Managed a same-day AC failure and updated the owner with
        a clean summary.
      `,
    });

    expect(scorecard.candidate_id).toMatch(/^candidate_[0-9a-f]{8}$/);
    expect(scorecard.candidate_id).not.toContain('private');
    const evidence = scorecard.criteria.flatMap((criterion) => criterion.evidence).join(' ');
    expect(evidence).toContain('Hostaway');
    expect(evidence).not.toContain('Private');
    expect(evidence).not.toContain('Person');
    expect(evidence).not.toContain('Example');
    expect(evidence).not.toContain('candidate@example.com');
    expect(evidence).not.toContain('555-123-4567');
    expect(scorecard.criteria.find((c) => c.id === 'vendor_maintenance_coordination')?.status).toBe('strong');
  });
});

describe('buildCandidateFitCompare', () => {
  test('sorts candidates by fit and preserves anonymized compare rows', () => {
    const brief = buildCandidateFitBriefFromText(HOSTAWAY_BRIEF);
    const compare = buildCandidateFitCompare({
      brief,
      candidates: [
        {
          id: 'candidate_b',
          resumeSummary: 'General admin VA. Airbnb inbox. Light Hostaway training. Flexible hours.',
        },
        {
          id: 'candidate_a',
          resumeSummary: 'Daily Hostaway PMS for 8 STR listings, guest comms, reservations, vendors, owner updates, repeat OTA review, channel data, 9am-5pm ET, $10/hr.',
        },
      ],
    });

    expect(compare.schema_version).toBe(1);
    expect(compare.candidates.map((c) => c.candidate_id)).toEqual(['candidate_a', 'candidate_b']);
    expect(JSON.stringify(compare)).not.toContain('Private Operator');
    expect(JSON.stringify(compare)).not.toContain('Private Recruiter');
    expect(JSON.stringify(compare)).not.toContain('Private Referrer');
  });
});

describe('candidate CLI help', () => {
  test('reaches detailed help without connecting a brain', () => {
    const result = spawnSync('bun', ['run', 'src/cli.ts', 'candidate', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_HOME: '/tmp/gbrain-test-candidate-help-nonexistent' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: gbrain candidate scorecard');
    expect(result.stdout).toContain('--candidate-file');
    expect(result.stdout).toContain('Examples:');
    expect(result.stdout).not.toContain('No config found');
  });
});
