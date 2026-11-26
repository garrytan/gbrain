/**
 * gbrain telemetry through the real CLI: the command surface, and the privacy
 * invariant. A brain seeded with a canary string in page names, fact text,
 * provenance, a missing slug and a harness name runs init, remember, query,
 * get, doctor, a failing setup and more at community tier; no telemetry file
 * and no captured POST body may contain the canary.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli } from './helpers/cli-spawn.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'gbrain-telemetry-cli-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const CANARY = 'zqxcanary7';

function readAll(dir: string): string {
  let text = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    text += `${name}\n`;
    text += statSync(p).isDirectory() ? readAll(p) : readFileSync(p, 'utf8');
  }
  return text;
}

describe('gbrain telemetry CLI', () => {
  test('status, the tiers and pulse without an endpoint', async () => {
    const home = join(ROOT, 'surface');
    const status = await runCli(['telemetry', '--json'], { home });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ tier: 'off', answered: false, endpoint: null, search_telemetry: 'local_only' });
    const on = await runCli(['telemetry', 'anonymous', '--json'], { home });
    expect(JSON.parse(on.stdout)).toMatchObject({ tier: 'anonymous', installation_id: null });
    const pulse = await runCli(['telemetry', 'pulse', '--json'], { home });
    expect(pulse.exitCode).not.toBe(0);
    expect(JSON.parse(pulse.stdout)).toMatchObject({ code: 'telemetry_pulse_unavailable', stale: false });
    const off = await runCli(['telemetry', 'off'], { home });
    expect(off.stdout).toContain('Telemetry is off');
    expect(readdirSync(join(home, '.gbrain', 'telemetry')).sort()).toEqual(['settings.json']);
  }, 120_000);

  // Value: protects=an unknown telemetry subcommand exits non-zero with unknown_command and changes nothing; fails_when=the fallthrough is removed and it silently runs status; why_new=no CLI test passes a bad subcommand; seam=none; no_claim=none beyond protects
  test('an unknown subcommand fails with unknown_command', async () => {
    const home = join(ROOT, 'unknown');
    const r = await runCli(['telemetry', 'bogus', '--json'], { home });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('unknown_command');
  }, 120_000);

  test('privacy: no canary from a page, a fact, a slug, a harness or an error reaches the queue or the wire', async () => {
    const home = join(ROOT, 'canary');
    const posts: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'POST') posts.push(await req.text());
        return Response.json({ accepted: 1, rejected: 0 });
      },
    });
    const env = { GBRAIN_TELEMETRY_URL: `http://127.0.0.1:${server.port}` };
    try {
      expect((await runCli(['telemetry', 'community'], { home, env })).exitCode).toBe(0);
      const dir = join(home, '.gbrain', 'telemetry');
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ last_attempt_at: new Date().toISOString() }));
      const runs = [
        ['init', '--pglite', '--no-embedding'],
        ['remember', `the ${CANARY} project ships in May`, '--entity', `people/${CANARY}-example`, '--provenance', `told by ${CANARY} on a call`],
        ['query', `what does ${CANARY} ship`],
        ['search', CANARY],
        ['get', `${CANARY}-missing-page`],
        ['doctor', '--json'],
        ['setup', `${CANARY}harness`],
        ['errors', `${CANARY}_code`],
        [`${CANARY}-not-a-command`],
        ['stats'],
      ];
      for (const args of runs) await runCli(args, { home, env, timeoutMs: 90_000 });
      const counts = join(dir, 'counts');
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      for (const f of readdirSync(counts)) renameSync(join(counts, f), join(counts, `${yesterday}.json`));
      const queued = readAll(dir);
      expect(queued).toContain('"event_type":"setup"');
      expect(queued).toContain('"remember"');
      const sync = await runCli(['telemetry', 'sync', '--force', '--json'], { home, env });
      expect(JSON.parse(sync.stdout)).toMatchObject({ status: 'sent', http: 200 });
      expect(posts.length).toBe(1);
      const sent = JSON.parse(posts[0]) as Array<Record<string, unknown>>;
      expect(sent.some(e => e.event_type === 'daily_rollup')).toBe(true);
      expect(sent.some(e => e.event_type === 'doctor')).toBe(true);
      expect(sent.find(e => e.event_type === 'setup' && e.harness)).toMatchObject({ harness: 'other', outcome: 'error' });
      for (const text of [queued, readAll(dir), ...posts]) expect(text.toLowerCase()).not.toContain(CANARY);
    } finally {
      server.stop(true);
    }
  }, 600_000);

  test('without a telemetry address, init asks nothing about usage data', async () => {
    const home = join(ROOT, 'no-address');
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    const doc = JSON.parse(init.stdout) as { notices?: Array<{ decisions?: Array<{ id: string }> }> };
    expect((doc.notices ?? []).flatMap(n => n.decisions ?? []).map(d => d.id)).not.toContain('telemetry');
  }, 240_000);

  test('telemetry takes one subcommand, so a flag value or a second word never picks a tier', async () => {
    const home = join(ROOT, 'two-words');
    for (const args of [['telemetry', '--source', 'community', 'off'], ['telemetry', 'community', 'off'], ['telemetry', '--source', 'community']]) {
      const r = await runCli([...args, '--json'], { home });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('invalid_params');
    }
    expect(JSON.parse((await runCli(['telemetry', '--json'], { home })).stdout)).toMatchObject({ tier: 'off', answered: false });
  }, 120_000);

  test('with a telemetry address, init asks about usage data without answering it, holds its setup event, and a yes releases it', async () => {
    const home = join(ROOT, 'consent');
    const env = { GBRAIN_TELEMETRY_URL: 'http://127.0.0.1:9' };
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, env, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    const doc = JSON.parse(init.stdout) as { notices?: Array<{ decisions?: Array<{ id: string; default: string }> }> };
    const decision = (doc.notices ?? []).flatMap(n => n.decisions ?? []).find(d => d.id === 'telemetry');
    expect(decision).toMatchObject({ default: 'unanswered' });
    const dir = join(home, '.gbrain', 'telemetry');
    expect(readdirSync(dir)).toEqual(['pending.jsonl']);
    expect(readFileSync(join(dir, 'pending.jsonl'), 'utf8')).toContain('"step":"brain_create"');
    const status = JSON.parse((await runCli(['telemetry', '--json'], { home })).stdout);
    expect(status).toMatchObject({ tier: 'off', answered: false, held_events: 1 });
    await runCli(['telemetry', 'community'], { home });
    const show = JSON.parse((await runCli(['telemetry', 'show', '--json'], { home })).stdout) as { held_for_answer: unknown[]; next_send: Array<Record<string, unknown>> };
    expect(show.held_for_answer).toEqual([]);
    expect(show.next_send.map(e => e.event_type)).toEqual(['setup', 'consent']);
    await runCli(['doctor', '--only', 'connection', '--json'], { home, timeoutMs: 120_000 });
    const after = JSON.parse((await runCli(['telemetry', 'show', '--json'], { home })).stdout) as { next_send: Array<Record<string, unknown>> };
    expect(after.next_send.map(e => e.event_type)).toEqual(['setup', 'consent']);
  }, 240_000);
});
