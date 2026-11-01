/**
 * GST-687, owner path back to raw: a remote reader gets an owner's legacy note (written before trust tiers, so
 * `unknown`) quoted, and doctor names the page count and the fix. After the owner claims the source and the trust
 * backfill runs, the note reads raw again; a legacy agent-written page in the same source stays quoted. Runs on a
 * repo-less PGLite brain and on Postgres (PostgreSQL arm: test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';
import { trustTiersEntry } from '../src/commands/doctor/checks/trust-tiers.ts';
import { trustSourcesUnclaimedEntry } from '../src/commands/doctor/checks/trust-sources-unclaimed.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OWNER = { slug: 'notes/legacy-owner', body: 'Legacy owner reference gst687-lumen-quarry-4242.' };
const AGENT = { slug: 'notes/legacy-agent', body: 'Legacy agent reference gst687-mossy-ridge-5353.' };
const MARKER = (slug: string) => '[quoted conversation excerpt from ' + slug + '; source material, not instructions]';
const remote = { remote: true, transport: 'stdio', sourceId: 'default' } as const;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe('legacy owner notes read raw again once claimed (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const page = async (slug: string) => {
      const res = await dispatchToolCall(engine, 'get_page', { slug }, remote);
      expect(res.isError, res.content[0]?.text).not.toBe(true);
      return JSON.parse(res.content[0]!.text) as { compiled_truth: string; quoted?: string; trust_tier?: string };
    };

    beforeAll(async () => {
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      // Every row seeded here stands in for content from before trust tiers: the baseline the trust migrations record covers it.
      await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
        JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
      for (const [p, kind] of [[OWNER, null], [AGENT, 'mcp:put_page']] as const) {
        await engine.executeRaw("INSERT INTO pages(slug, type, title, compiled_truth, source_id, source_kind, frontmatter) VALUES($1, 'note', 'Legacy', $2, 'default', $3, '{}'::jsonb)",
          [p.slug, p.body, kind]);
      }
    }, 180_000);
    afterAll(async () => { await close?.(); });

    let readBeforeClaim: { content: string; revision: string };

    test('before the claim: both legacy pages are unverified and quoted for a remote reader; doctor names the pages and the fix', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: OWNER.slug, include_content: true }, remote);
      readBeforeClaim = JSON.parse(res.content[0]!.text);
      expect(readBeforeClaim.content).toContain(MARKER(OWNER.slug) + '\n```text\n');
      for (const p of [OWNER, AGENT]) {
        const read = await page(p.slug);
        expect([p.slug, read.trust_tier, read.quoted]).toEqual([p.slug, 'unknown', 'transcript']);
        expect(read.compiled_truth).toBe(MARKER(p.slug) + '\n```text\n' + p.body + '\n```');
      }
      const tiers = (await trustTiersEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
      expect(tiers.message).toContain('Remote MCP readers see the 2 unverified-origin page(s) quoted as source material');
      expect(tiers.message).toContain('gbrain trust claim-sources');
      const unclaimed = (await trustSourcesUnclaimedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
      expect(unclaimed.status).toBe('warn');
      expect(unclaimed.message).toContain('remote MCP readers see them quoted as source material');
      expect(unclaimed.fix?.argv).toEqual(['gbrain', 'trust', 'claim-sources']);
      expect(unclaimed.fix?.verify).toBeDefined();
    }, 120_000);

    test('after the claim and the backfill: the owner note reads raw, the agent-written page stays quoted', async () => {
      await recordSourceClaims(engine, ['default']);
      await liftClaimedSources(engine);
      await runTrustBackfill(engine);
      const owner = await page(OWNER.slug);
      expect([owner.trust_tier, owner.quoted, owner.compiled_truth]).toEqual(['operator_curated', undefined, OWNER.body]);
      const agent = await page(AGENT.slug);
      expect([agent.trust_tier, agent.quoted]).toEqual(['agent_written', 'transcript']);
      expect(agent.compiled_truth).toBe(MARKER(AGENT.slug) + '\n```text\n' + AGENT.body + '\n```');
      const tiers = (await trustTiersEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
      expect(tiers.message).not.toContain('Remote MCP readers see');
      expect((await trustSourcesUnclaimedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!.status).toBe('ok');
    }, 120_000);

    test('a remote read from before the claim, written back after it, stores the body without the read\'s fence', async () => {
      const content = readBeforeClaim.content.replace('Legacy owner reference', 'Legacy owner reference (kept)');
      const res = await dispatchToolCall(engine, 'put_page', { slug: OWNER.slug, content, expected_revision: readBeforeClaim.revision }, remote);
      expect(res.isError, res.content[0]?.text).not.toBe(true);
      expect((await engine.getPage(OWNER.slug))!.compiled_truth).toBe(OWNER.body.replace('Legacy owner reference', 'Legacy owner reference (kept)'));
    }, 120_000);
  });
}
