/**
 * `gbrain trust claim-sources` (#5575, legacy content) and the asks around it.
 *
 * Protects: the owner claims a source only by typing its id on a terminal
 * (--yes never counts; without a terminal the command refuses with an
 * tell_user_to_run fix and changes nothing); a claim sets the per-source default
 * operator_curated and lifts the source's legacy unknown rows through the
 * backfill, never above operator_curated, while rows with a lowering signal
 * (mcp:* and capture stamps, transcript imports, clipped pages, connector
 * stamps, backstop facts, the lower-only trust_tier marker) keep their lower
 * tier; connector sources cannot be claimed; an interrupted lift resumes, and
 * until it does the scan refuses and explain shows the rows as owner tier;
 * `--dry-run` writes nothing; `sources set-trust` to a lower tier ends a
 * claim. Doctor `trust_sources_unclaimed` warns with tell_user_to_run while unclaimed
 * legacy rows exist and never on a fresh brain; doctor `trust_scan` leaves the
 * scan to the user; post-upgrade and the behavior-change notice name the claim.
 * None of these fixes carries consent effects (nothing is destructive).
 * Also pins the SQL frontmatter caps to `frontmatterTrustCaps`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderAction, type Action } from '../src/core/agent-output.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { frontmatterTrustCaps, frontmatterTrustCapsSql } from '../src/core/trust/channel.ts';
import { claimSourcesFix, listClaimSources, liftClaimedSources, recordSourceClaims, readUnclaimedLegacySources } from '../src/core/trust/claim.ts';
import { TRUST_CLAIM_LIFTED_AT_KEY, TRUST_CLAIMED_AT_KEY } from '../src/core/trust/claim-state.ts';
import { trustClaimUpgradeNotice } from '../src/core/trust/claim-notice.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { explainTrust } from '../src/core/trust/review.ts';
import { TRUST_TIER_RANK } from '../src/core/trust/tier.ts';
import { runTrustScan } from '../src/core/eligibility/scan.ts';
import { runTrustClaimSources } from '../src/commands/trust-claim.ts';
import { runSetTrust } from '../src/commands/sources-trust.ts';
import { trustSourcesUnclaimedEntry } from '../src/commands/doctor/checks/trust-sources-unclaimed.ts';
import { trustScanEntry } from '../src/commands/doctor/checks/trust-scan.ts';
import { withTrustClaimAsk } from '../src/core/behavior-change-notice.ts';
import { FACTS_BACKSTOP_SOURCES } from '../src/core/facts/capture-sources.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: BrainEngine;
/** A brain nothing seeds: fresh-install expectations. */
let fresh: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema();
  engine = pg;
  // Every row the tests seed stands in for content from before trust tiers: the baseline the trust migrations record covers it.
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
  const empty = new PGLiteEngine(); await empty.connect({}); await empty.initSchema();
  fresh = empty;
}, 120_000);
afterAll(async () => { await engine.disconnect(); await fresh.disconnect(); });
afterEach(() => { __setConfirmationIoForTests(null); process.exitCode = 0; });

const cli = { transport: 'cli' as const, isCallable: () => false, preapproved: () => true };
const render = (fix: unknown) => renderAction(fix as Action, cli);
const doctor = async (entry: { run: (ctx: DoctorContext) => Promise<unknown> }, db = engine) => (await entry.run({ engine: db } as unknown as DoctorContext) as Check[])[0]!;

function tty(answer: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let prompt = '';
  output.on('data', chunk => { prompt += String(chunk); });
  __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { GBRAIN_INTERACTIVE: '1' } }, input, output, timeoutMs: 2000 });
  input.write(`${answer}\n`);
  return { prompt: () => prompt };
}
const nonTty = () => __setConfirmationIoForTests({ probe: { stdinIsTTY: false, stdoutIsTTY: false, env: {} } });

/** Runs the CLI, returning what it printed on stdout (console.log) and stderr. */
async function runCli(args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const write = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await runTrustClaimSources(engine, args); } finally { console.log = log; process.stderr.write = write; }
  return { out: out.join('\n'), err: err.join('') };
}

/** One owner source with a row per signal class (all `unknown`), plus a github connector source. */
async function seed() {
  const tag = randomUUID().slice(0, 8);
  const src = `own-${tag}`, gh = `gh-${tag}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES($1,$1,'/home/alice-example/notes')`, [src]);
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"kind":"github"}'::jsonb)`, [gh]);
  const pages: Record<string, number> = {};
  const page = async (key: string, source: string, sourceKind: string | null, frontmatter: Record<string, unknown> = {}) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,source_kind,frontmatter)
      VALUES($1,'note','T','Plain notes about acme-example.',$2,$3,$4::text::jsonb) RETURNING id`, [`p/${key}`, source, sourceKind, JSON.stringify(frontmatter)]);
    pages[key] = Number(row!.id);
  };
  await page('plain', src, null);
  await page('mcp', src, 'mcp:put_page');
  await page('capture', src, null, { captured_via: 'capture' });
  await page('own-transcript', src, null, { transcript_import: { harness: 'codex' } });
  await page('other-transcript', src, null, { transcript_import: { harness: 'zoom' } });
  await page('clipped', src, null, { source_url: 'https://example.com/a', clipped_at: '2026-01-01' });
  await page('marker', src, null, { trust_tier: 'agent_written' });
  await page('confirmed-marker', src, null, { trust_tier: 'user_confirmed' });
  await page('connector-stamp', src, null, { ingested_via: 'connector:gmail' });
  await page('gh-plain', gh, null);
  const fact = async (source: string, fenced: string | null) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,source_markdown_slug,row_num)
      VALUES($1,'e','claim','fact',$2,$3,$4) RETURNING id`, [src, source, fenced, fenced ? 1 : null]);
    return Number(row!.id);
  };
  const facts = { plain: await fact('manual', null), backstop: await fact(FACTS_BACKSTOP_SOURCES[0]!, null), onPlain: await fact('manual', 'p/plain'), onMcp: await fact('manual', 'p/mcp') };
  const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) VALUES($1,1,'A take','take','brain',0.5) RETURNING id`, [pages.plain]);
  const [entry] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries(page_id,date,summary) VALUES($1,'2026-01-01','Clipped event') RETURNING id`, [pages.clipped]);
  return { src, gh, pages, facts, take: Number(take!.id), entry: Number(entry!.id) };
}

const tierOf = async (table: string, id: number) => (await engine.executeRaw<{ t: string }>(`SELECT trust_tier AS t FROM ${table} WHERE id=$1`, [id]))[0]!.t;
const configOf = async (id: string) => {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  return (typeof row!.config === 'string' ? JSON.parse(row!.config) : row!.config) as Record<string, unknown>;
};
const snapshot = async (src: string) => JSON.stringify({
  pages: await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM pages WHERE source_id=$1 ORDER BY id`, [src]),
  facts: await engine.executeRaw(`SELECT id, trust_tier FROM facts WHERE source_id=$1 ORDER BY id`, [src]),
  config: await configOf(src),
  checkpoints: await engine.executeRaw(`SELECT op, fingerprint FROM op_checkpoints ORDER BY op, fingerprint`),
});

describe('trust claim-sources', () => {
  test('the SQL frontmatter caps match frontmatterTrustCaps', async () => {
    const samples: Array<Record<string, unknown>> = [
      {}, { trust_tier: 'agent_written' }, { trust_tier: 'user_confirmed' }, { trust_tier: 'bogus' }, { trust_tier: 5 },
      { source_kind: 'webhook' }, { source_kind: 'mcp:remember' }, { ingested_via: 'capture-cli' }, { captured_via: ' connector:gmail ' }, { source_kind: 'github' },
      { source_kind: 'sync' }, { transcript_import: { harness: 'Claude-Code' } }, { transcript_import: { harness: 'zoom' } }, { transcript_import: [] },
      { transcript_import: 'yes' }, { source_url: 'https://x', clipped_at: '2026' }, { source_url: 'https://x' }, { source_url: ' ', clipper: 'x' },
      { source_url: 'https://x', captured_via: 'clipper' }, { source_url: 'https://x', type: 'clipping' }, { provenance: 'auto-extracted' },
      { dream_generated: true }, { dream_generated: 'true' }, { dream_generated: false }, { provenance: 'manual', source_kind: 'inbox-folder', trust_tier: 'tool_observed' },
    ];
    const sql = `SELECT LEAST(${frontmatterTrustCapsSql('v.fm').join(', ')}) AS r FROM (SELECT $1::text::jsonb AS fm) v`;
    for (const fm of samples) {
      const [row] = await engine.executeRaw<{ r: number | null }>(sql, [JSON.stringify(fm)]);
      const caps = frontmatterTrustCaps(fm);
      const expected = caps.length ? Math.min(...caps.map(t => TRUST_TIER_RANK[t])) : null;
      expect({ fm, rank: row!.r === null ? null : Number(row!.r) }).toEqual({ fm, rank: expected });
    }
  });

  test('--dry-run lists each source with its projection and writes nothing', async () => {
    const s = await seed();
    const before = await snapshot(s.src);
    const listing = await listClaimSources(engine);
    const { out } = await runCli(['--dry-run']);
    expect(await snapshot(s.src)).toBe(before);
    const own = listing.sources.find(x => x.id === s.src)!;
    expect(own).toMatchObject({ local_path: '/home/alice-example/notes', pages: 9, claimable: true, claimed: false });
    expect(own.current!.unknown).toBe(own.legacy_unknown);
    expect(own.projected_if_claimed.user_confirmed).toBe(0);
    expect(own.projected_if_claimed.operator_curated).toBe(5);
    expect(listing.sources.find(x => x.id === s.gh)).toMatchObject({ claimable: false, blocker: 'connector' });
    expect(out).toContain(`${s.src} (/home/alice-example/notes): 9 page(s)`);
    expect(out).toContain('github connector: cannot be claimed');
  });

  test('without a terminal it refuses with a tell_user_to_run fix and changes nothing', async () => {
    const s = await seed();
    const before = await snapshot(s.src);
    nonTty();
    const { err } = await runCli(['--source', s.src, '--yes']);
    expect(err).toContain('confirmation_required');
    expect(await snapshot(s.src)).toBe(before);
    const fix = render(claimSourcesFix());
    expect(fix.next).toBe('tell_user_to_run');
    expect(fix.consent).toEqual([]);
    expect(fix.argv).toEqual(['gbrain', 'trust', 'claim-sources']);
    expect(fix.user_message).toContain('gbrain trust claim-sources');
    expect(fix.user_message).toContain('your notes');
  });

  test('typing the id claims the source: legacy rows become your notes, lowering signals keep their tier, nothing is confirmed', async () => {
    const s = await seed();
    const io = tty(s.src);
    await runCli(['--source', s.src]);
    expect(io.prompt()).toContain(`Type ${s.src} to confirm`);
    const config = await configOf(s.src);
    expect(config.trust_tier).toBe('operator_curated');
    expect(typeof config[TRUST_CLAIMED_AT_KEY]).toBe('string');
    expect(typeof config[TRUST_CLAIM_LIFTED_AT_KEY]).toBe('string');
    const p = s.pages;
    expect({
      plain: await tierOf('pages', p.plain!), mcp: await tierOf('pages', p.mcp!), capture: await tierOf('pages', p.capture!),
      ownTranscript: await tierOf('pages', p['own-transcript']!), otherTranscript: await tierOf('pages', p['other-transcript']!),
      clipped: await tierOf('pages', p.clipped!), marker: await tierOf('pages', p.marker!), confirmedMarker: await tierOf('pages', p['confirmed-marker']!),
      connectorStamp: await tierOf('pages', p['connector-stamp']!), gh: await tierOf('pages', p['gh-plain']!),
      factPlain: await tierOf('facts', s.facts.plain), factBackstop: await tierOf('facts', s.facts.backstop),
      factOnPlain: await tierOf('facts', s.facts.onPlain), factOnMcp: await tierOf('facts', s.facts.onMcp),
      take: await tierOf('takes', s.take), entry: await tierOf('timeline_entries', s.entry),
    }).toEqual({
      plain: 'operator_curated', mcp: 'agent_written', capture: 'agent_written', ownTranscript: 'agent_written', otherTranscript: 'external_untrusted',
      clipped: 'external_untrusted', marker: 'agent_written', confirmedMarker: 'operator_curated', connectorStamp: 'external_untrusted', gh: 'unknown',
      factPlain: 'operator_curated', factBackstop: 'agent_written', factOnPlain: 'operator_curated', factOnMcp: 'agent_written',
      take: 'operator_curated', entry: 'external_untrusted',
    });
    const [origin] = await engine.executeRaw<{ c: string }>(`SELECT write_origin->>'channel' AS c FROM pages WHERE id=$1`, [p.plain]);
    expect(origin!.c).toBe('trust_claim');
    expect((await readUnclaimedLegacySources(engine)).unclaimed.map(u => u.id)).not.toContain(s.src);
  });

  test('a wrong token declines; --yes never claims', async () => {
    const s = await seed();
    tty('yes');
    const { out } = await runCli(['--source', s.src, '--yes']);
    expect(out).toContain('--yes never claims');
    expect(out).toContain(`${s.src}: not claimed`);
    expect((await configOf(s.src))[TRUST_CLAIMED_AT_KEY]).toBeUndefined();
    expect(await tierOf('pages', s.pages.plain!)).toBe('unknown');
  });

  test('connector sources cannot be claimed', async () => {
    const s = await seed();
    tty(s.gh);
    const { err } = await runCli(['--source', s.gh]);
    expect(err).toContain('invalid_params');
    expect(err).toContain('connector');
    await expect(recordSourceClaims(engine, [s.gh])).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await tierOf('pages', s.pages['gh-plain']!)).toBe('unknown');
  });

  test('an interrupted lift resumes; until then the scan refuses and explain shows owner tier', async () => {
    const s = await seed();
    await recordSourceClaims(engine, [s.src]);
    let batches = 0;
    await expect(runTrustBackfill(engine, { sources: [s.src], batchSize: 1, log: () => { if (++batches === 2) throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
    const pending = await doctor(trustSourcesUnclaimedEntry);
    expect(pending.status).toBe('warn');
    expect(render(pending.fix).argv).toEqual(['gbrain', 'trust', 'claim-sources', '--resume']);
    await expect(runTrustScan(engine)).rejects.toMatchObject({ code: 'recovery_required' });
    const [still] = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND trust_tier='unknown' ORDER BY id LIMIT 1`, [s.src]);
    const [explained] = await explainTrust(engine, `p:${s.src}/${still!.slug}`);
    expect(explained).toMatchObject({ tier: 'unknown', claimed_source: 'lift_pending' });
    expect(explained!.label).toStartWith('your notes');
    tty('unused');
    await runCli(['--resume']);
    expect(await tierOf('pages', s.pages.plain!)).toBe('operator_curated');
    expect(await tierOf('pages', s.pages.mcp!)).toBe('agent_written');
    expect((await readUnclaimedLegacySources(engine)).pending).not.toContain(s.src);
    expect((await liftClaimedSources(engine)).sources).toEqual([]);
  });

  test('sources set-trust to a lower tier ends the claim', async () => {
    const s = await seed();
    await recordSourceClaims(engine, [s.src]);
    const log = console.log;
    console.log = () => {};
    try { await runSetTrust(engine, [s.src, 'agent_written']); } finally { console.log = log; }
    const config = await configOf(s.src);
    expect(config.trust_tier).toBe('agent_written');
    expect(config[TRUST_CLAIMED_AT_KEY]).toBeUndefined();
  });
});

describe('the asks around claiming', () => {
  test('doctor trust_sources_unclaimed: ok on a fresh brain, tell_user_to_run while unclaimed legacy rows exist', async () => {
    expect((await doctor(trustSourcesUnclaimedEntry, fresh)).status).toBe('ok');
    expect(await trustClaimUpgradeNotice(fresh)).toBeNull();
    expect(await withTrustClaimAsk(fresh, { code: 'behavior_changes', kind: 'safety', why: 'w', fix: { argv: ['gbrain', 'doctor', '--only', 'behavior_changes', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'x' } }))
      .toMatchObject({ fix: { argv: ['gbrain', 'doctor', '--only', 'behavior_changes', '--json'] } });
    const s = await seed();
    const check = await doctor(trustSourcesUnclaimedEntry);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(s.src);
    expect(check.message).not.toContain(s.gh);
    const fix = render(check.fix);
    expect(fix.next).toBe('tell_user_to_run');
    expect(fix.consent).toEqual([]);
    expect(fix.argv).toEqual(['gbrain', 'trust', 'claim-sources']);
  });

  test('a row stored as unknown after the trust migrations is not legacy: no warning, and a claim never lifts it', async () => {
    const [page] = await fresh.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,source_id) VALUES('p/late','note','T','x','default') RETURNING id`);
    expect((await fresh.executeRaw<{ t: string }>('SELECT trust_tier AS t FROM pages WHERE id=$1', [page!.id]))[0]!.t).toBe('unknown');
    expect((await doctor(trustSourcesUnclaimedEntry, fresh)).status).toBe('ok');
    await recordSourceClaims(fresh, ['default']);
    await liftClaimedSources(fresh);
    expect((await fresh.executeRaw<{ t: string }>('SELECT trust_tier AS t FROM pages WHERE id=$1', [page!.id]))[0]!.t).toBe('unknown');
  });

  test('doctor trust_scan leaves the legacy scan to the user', async () => {
    await seed();
    // These rows stand in for content from before the write gate: no scan baseline bounds them.
    await engine.executeRaw('DELETE FROM config WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY]);
    const check = await doctor(trustScanEntry);
    expect(check.status).toBe('warn');
    const fix = render(check.fix);
    expect(fix.next).toBe('tell_user_to_run');
    expect(fix.consent).toEqual([]);
    expect(fix.argv).toEqual(['gbrain', 'trust', 'scan']);
    expect(fix.user_message).toContain('claim');
  });

  test('post-upgrade and the behavior-change notice carry the tell_user_to_run block', async () => {
    await seed();
    const lines = (await trustClaimUpgradeNotice(engine))!.join('\n');
    expect(lines).toContain('[AGENT]');
    expect(lines).toContain('next: tell_user_to_run: gbrain trust claim-sources');
    expect(lines).toContain('[SHOW USER]');
    expect(lines).not.toContain('gbrain trust scan --');
    const notice = await withTrustClaimAsk(engine, { code: 'behavior_changes', kind: 'safety', why: 'w', fix: { argv: ['gbrain', 'doctor', '--only', 'behavior_changes', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'x' } });
    expect(render(notice!.fix)).toMatchObject({ next: 'tell_user_to_run', consent: [] });
    expect(notice!.user_message).toContain('gbrain trust claim-sources');
  });
});
