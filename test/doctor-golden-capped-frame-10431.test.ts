/**
 * #10431: the doctor golden normalizer folds the disconnect audit's caller frame however long its path is.
 *
 * 1. Protects: queue_health caps the most recent caller frame at 200 characters (queue-jobs.ts), so a long checkout path
 *    loses the frame's own closing parenthesis; the golden must normalize that capped frame like a complete one.
 * 2. Fails when: a capped frame survives normalization, so two captures of the same report disagree.
 * 3. Real seams: normalizeDoctorText over the exact sentence queue_health renders. No database.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeDoctorText } from './helpers/doctor-json-golden.ts';

const sentence = (frame: string) => ` Disconnect-call audit: 16 call(s) in 24h (most recent caller: ${frame.slice(0, 200)}).`;
const frameAt = (dir: string) => `at disconnectInternal (${dir}/src/core/postgres-engine.ts:812:15)`;

describe('#10431 doctor golden normalizes the capped caller frame', () => {
  test('a complete frame and a frame capped through its path normalize to the same text', () => {
    const short = frameAt('/workspace/brain');
    const long = frameAt(`/workspace/${'nested-checkout-example/'.repeat(10)}brain`);
    expect(short.length).toBeLessThan(200);
    expect(long.length).toBeGreaterThan(200);
    const expected = ' Disconnect-call audit: 16 call(s) in 24h (most recent caller: <frame>).';
    expect(normalizeDoctorText(sentence(short), {})).toBe(expected);
    expect(normalizeDoctorText(sentence(long), {})).toBe(expected);
  });
});
