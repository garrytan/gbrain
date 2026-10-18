/**
 * Shared steps of the segmented withdrawal tests (segmented-withdrawal-mirror.test.ts, segmented-withdrawal-fences.test.ts):
 * a purge through the MCP verb on a twin brain (segmented-twins.ts), effect passes run until the mirror and Git effects
 * settle, the page's streamed export to compare the canonical file with, and the effects' outcome.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exportBodyLedger, readExportPage, readExportWithdrawals, segmentedExportMarkdown } from '../../src/core/export-snapshot.ts';
import { serializeMarkdown, slugStampedFrontmatter } from '../../src/core/markdown.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import type { TwinBrain } from './segmented-twins.ts';
import { waitFor } from './wait-for.ts';
import { withEnv } from './with-env.ts';

export const fileOf = (brain: TwinBrain, slug: string) => join(brain.root, slug + '.md');
/** Staging leftovers (hidden `.<sha>.tmp.<uuid>` siblings) next to the twins' files. */
export const stagingLeft = (brain: TwinBrain) => readdirSync(join(brain.root, 'people')).filter(name => name.includes('.tmp.'));

/**
 * Runs effect passes on this host until the source's mirror and Git effects have all settled; the persistence consumer
 * runs them too, so a claim it holds settles meanwhile. Past the deadline the assertions report the effects' state.
 */
export const settle = (brain: TwinBrain, kind: 'pglite' | 'postgres', beforePass?: () => Promise<void>) => waitFor(async () => {
  await beforePass?.();
  const [open] = await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
    WHERE source_id=$1 AND kind IN ('withdrawal-mirror','git') AND (state NOT IN ('committed','failed') OR recovery IS NOT NULL)`, [brain.sourceId]);
  if (!open!.n) return true;
  await withEnv(brain.env(), async () => {
    await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
    await runPersistenceEffects(brain.engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
  });
  return false;
}, { timeoutMs: 120_000, intervalMs: 100, label: 'the mirror and Git effects settled' }).catch(() => undefined);

/** The page's export, streamed as `gbrain export` streams a segmented page (export.ts), concatenated here only to compare. */
export const exported = (brain: TwinBrain, slug: string) => brain.engine.transaction(async tx => {
  const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>(
    'SELECT id::text AS id, source_id, slug FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, slug]);
  const withdrawals = await readExportWithdrawals(tx, brain.sourceId);
  const { page, tags } = await readExportPage(tx, key!, withdrawals);
  const head = serializeMarkdown(slugStampedFrontmatter(page.slug, page.frontmatter ?? {}), '', '', { type: page.type, title: page.title, tags }).slice(0, -1);
  const parts: Buffer[] = [];
  for await (const piece of segmentedExportMarkdown(tx, page, exportBodyLedger(page.slug, withdrawals), head)) parts.push(Buffer.from(piece));
  return Buffer.concat(parts);
});

export const effectsOf = async (brain: TwinBrain, requestId: string) => (await brain.engine.executeRaw<{ kind: string; state: string; error_code: string | null; data: any }>(
  `SELECT e.kind, e.state, e.error_code, e.data FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.request_id=$1::uuid AND e.kind IN ('withdrawal-mirror','git') ORDER BY e.kind`, [requestId]))
  .map(e => ({ kind: e.kind, state: e.state, error: e.error_code, skipped: (typeof e.data === 'string' ? JSON.parse(e.data) : e.data)?.skipped ?? [] }));
export const SETTLED = [{ kind: 'git', state: 'committed', error: null, skipped: [] }, { kind: 'withdrawal-mirror', state: 'committed', error: null, skipped: [] }];

export async function purge(brain: TwinBrain, kind: 'pglite' | 'postgres', slug: string, claim: string, beforePass?: () => Promise<void>) {
  const [fact] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3', [brain.sourceId, slug, claim]);
  expect(fact).toBeDefined();
  const dry = await brain.call('purge_fact', { id: Number(fact!.id), dry_run: true }, slug);
  expect(dry.confirm_token).toBeString();
  const requestId = randomUUID();
  const done = await brain.call('purge_fact', { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId }, slug);
  expect(done.state).toBe('committed');
  await settle(brain, kind, beforePass);
  return { requestId, hash8: String(done.purge.hash8) };
}
