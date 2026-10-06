import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect, publicEffectsForRequest, queueLinksReconcile } from '../../src/core/persistence/effect-journal.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { withEnv } from './with-env.ts';

/**
 * Remote mention-links effect contract (#6007), shared by the PGLite unit
 * test and the PostgreSQL E2E wrapper. Each scenario owns its own source and
 * OAuth client, so scenarios can share one database.
 */
export const remoteLinksCases = ['links', 'other_producers', 'confined', 'config_off', 'superseded', 'restart', 'revoked', 'trusted_local', 'reconcile', 'wanted'] as const;
export type RemoteLinksCase = typeof remoteLinksCases[number];

const config = { engine: 'pglite' as const, embedding_disabled: true };
const MENTIONS = (sourceId: string) => `---
type: note
title: Remote example
related: concepts/frontier-example
---

Met [[people/alice-example]] who works at [[companies/acme-example]] and founded it.
Also [[people/secret-example]], [[people/ghost-example]] and [[${sourceId}-other:people/bob-example]].

<!-- timeline -->

- 2026-01-01: Saw [[people/timeline-example]].
`;

export async function exerciseRemoteLinks(engine: BrainEngine, scenario: RemoteLinksCase, opts: { managed?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-remote-links-'));
  const sourceId = `links-${scenario.replaceAll('_', '-')}${opts.managed ? '-managed' : ''}`;
  const clientId = `client-${sourceId}`;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)', [sourceId, `${sourceId}-other`]);
      const page = (slug: string, frontmatter: Record<string, unknown> = {}, source = sourceId) => engine.putPage(slug,
        { type: slug.startsWith('people/') ? 'person' : slug.startsWith('companies/') ? 'company' : 'concept', title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter }, { sourceId: source });
      await page('people/alice-example');
      await page('companies/acme-example');
      await page('concepts/frontier-example');
      await page('people/timeline-example');
      await page('people/secret-example', { visibility: 'private' });
      await page('people/bob-example', {}, `${sourceId}-other`);
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
        VALUES($1,'fixture-hash','example-client','read write',$2,$3::text[])`, [clientId, sourceId, scenario === 'confined' ? ['notes/', 'people/'] : null]);
      if (opts.managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const remote: Partial<OperationContext> = { remote: true, auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId },
        scopes: ['read', 'write'], sourceId, ...(scenario === 'confined' ? { boundSlugPrefixes: ['notes/', 'people/'] } : {}) } as OperationContext['auth'] };

      const write = async (content: string, slug = 'notes/example', overrides: Partial<OperationContext> = remote): Promise<WriteRequest> => {
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
        const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId, logger: { info() {}, warn() {}, error() {} }, ...overrides };
        const authority = await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
        const current = await engine.readPageSnapshot(slug, { sourceId });
        const intent = { content, ...(current ? { expected_revision: current.revision } : {}) };
        await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation,
          slug, pageId: current?.page.id ?? null, requestId: randomUUID(), callerIntent: intent, intent });
        const row = (await claimNextWrite(engine, localHostId()))!;
        const committed = await publishMutation(engine, row, await preparePageMutation(engine, row, config));
        expect(committed.state).toBe('committed');
        return committed;
      };
      const runLinks = async () => {
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'links' AND state='queued'");
        await runPersistenceEffects(engine, config, { hostId: localHostId() });
      };
      const links = (from = 'notes/example') => engine.executeRaw<{ to_slug: string; link_type: string; link_source: string }>(`SELECT t.slug AS to_slug,l.link_type,l.link_source
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.slug,l.link_source`, [sourceId, from]);
      const effect = async (row: WriteRequest) => (await engine.executeRaw<{ state: string; outcome: Record<string, unknown> | null }>(
        "SELECT state,outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='links'", [row.id]))[0];
      const mention = (to_slug: string) => ({ to_slug, link_type: 'mentions', link_source: 'mcp-remote-mention' });

      if (scenario === 'links') {
        const row = await write(MENTIONS(sourceId));
        expect(row.outcome?.auto_links).toMatchObject({ skipped: 'remote', mention_links: 'queued' });
        expect(await effect(row)).toMatchObject({ state: 'queued' });
        expect(await links()).toEqual([]);
        await runLinks();
        // Plain mentions of visible same-source pages only: no private, missing, cross-source, frontmatter or timeline target, no typed edge.
        expect(await links()).toEqual([mention('companies/acme-example'), mention('people/alice-example')]);
        const outcome = (await effect(row)).outcome!;
        expect(outcome).toMatchObject({ links: 'committed', added: 2, removed: 0 });
        expect(new Map((outcome.skipped_targets as { slug: string; reason: string }[]).map(t => [t.slug, t.reason]))).toEqual(new Map([
          ['people/bob-example', 'cross_source'], ['people/ghost-example', 'missing'], ['people/secret-example', 'not_visible']]));
        expect((await publicEffectsForRequest(engine, row.id)).find(e => e.kind === 'links')).toEqual({ kind: 'links', state: 'committed', added: 2, removed: 0 });
        expect(await engine.executeRaw("SELECT 1 FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND l.link_type<>'mentions'", [sourceId])).toEqual([]);
        return;
      }

      if (scenario === 'wanted') {
        const wanted = () => engine.executeRaw<{ target_ref: string; producer: string; link_type: string }>(`SELECT w.target_ref,w.producer,w.link_type
          FROM wanted_links w JOIN pages p ON p.id=w.origin_page_id WHERE p.source_id=$1 AND p.slug='notes/example' ORDER BY w.target_ref`, [sourceId]);
        await engine.setConfig('wanted_pages.remote', 'false');
        await write(MENTIONS(sourceId));
        await runLinks();
        expect(await wanted()).toEqual([]); // turned off: nothing recorded
        await engine.executeRaw("DELETE FROM config WHERE key='wanted_pages.remote'"); // default on
        try {
          await write(`${MENTIONS(sourceId)}\nAnother paragraph.\n`);
          await runLinks();
          // Only the missing same-source target: not the private, cross-source, frontmatter or timeline ones.
          expect(await wanted()).toEqual([{ target_ref: 'people/ghost-example', producer: 'body', link_type: 'mentions' }]);
          await write('---\ntype: note\ntitle: Remote example\n---\n\nOnly [[companies/acme-example]] now.\n');
          await runLinks();
          expect(await wanted()).toEqual([]);
        } finally {
          await engine.executeRaw("DELETE FROM config WHERE key='wanted_pages.remote'");
        }
        return;
      }

      if (scenario === 'other_producers') {
        await write(MENTIONS(sourceId));
        await runLinks();
        await engine.addLink('notes/example', 'people/alice-example', 'hand-made', 'works_at', 'manual', undefined, undefined, // gbrain-allow-direct-insert: fixture edge owned by another producer
          { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
        await engine.addLinksBatch([{ from_slug: 'notes/example', to_slug: 'companies/acme-example', from_source_id: sourceId, to_source_id: sourceId, // gbrain-allow-direct-insert: fixture edge owned by the markdown producer
          link_type: 'mentions', link_source: 'markdown', context: 'local' }]);
        const second = await write('---\ntype: note\ntitle: Remote example\n---\n\nOnly [[companies/acme-example]] now.\n');
        await runLinks();
        expect((await effect(second)).outcome).toMatchObject({ links: 'committed', added: 0, removed: 1 });
        expect(await links()).toEqual([
          { to_slug: 'companies/acme-example', link_type: 'mentions', link_source: 'markdown' }, mention('companies/acme-example'),
          { to_slug: 'people/alice-example', link_type: 'works_at', link_source: 'manual' }]);
        return;
      }

      if (scenario === 'confined') {
        const row = await write(MENTIONS(sourceId));
        await runLinks();
        expect(await links()).toEqual([mention('people/alice-example')]);
        expect((await effect(row)).outcome!.skipped_targets).toContainEqual({ slug: 'companies/acme-example', reason: 'outside_grant' });
        return;
      }

      if (scenario === 'config_off') {
        await engine.setConfig('mcp.remote_auto_links', 'Off');
        try {
          const off = await write(MENTIONS(sourceId));
          expect(await effect(off)).toBeUndefined();
          expect(off.outcome?.auto_links).toMatchObject({ skipped: 'remote' });
          expect((off.outcome?.auto_links as Record<string, unknown>).mention_links).toBeUndefined();
          await engine.setConfig('mcp.remote_auto_links', 'on');
          await engine.setConfig('auto_link', 'false');
          const autoLinkOff = await write(`${MENTIONS(sourceId)}\nAnother paragraph.\n`);
          expect(await effect(autoLinkOff)).toBeUndefined();
          await engine.setConfig('auto_link', 'true');
          const on = await write(`${MENTIONS(sourceId)}\nA third paragraph.\n`);
          // Turned off between publication and execution: the queued effect settles as skipped.
          await engine.setConfig('mcp.remote_auto_links', 'false');
          await runLinks();
          expect(await effect(on)).toMatchObject({ state: 'committed', outcome: { links: 'skipped', reason: 'disabled' } });
          expect(await links()).toEqual([]);
        } finally {
          await engine.executeRaw("DELETE FROM config WHERE key IN ('mcp.remote_auto_links','auto_link')");
        }
        return;
      }

      if (scenario === 'superseded') {
        const row = await write(MENTIONS(sourceId));
        const snapshot = (await engine.readPageSnapshot('notes/example', { sourceId }))!;
        await engine.putPage('notes/example', { ...snapshot.page, compiled_truth: 'Rewritten by a later writer [[people/alice-example]].' }, { sourceId });
        await runLinks();
        expect(await effect(row)).toMatchObject({ state: 'committed', outcome: { links: 'skipped', reason: 'superseded' } });
        expect((await publicEffectsForRequest(engine, row.id)).find(e => e.kind === 'links')).toEqual({ kind: 'links', state: 'skipped', reason: 'superseded' });
        expect(await links()).toEqual([]);
        return;
      }

      if (scenario === 'restart') {
        const row = await write(MENTIONS(sourceId));
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE kind<>'links' AND state='queued'");
        // A consumer claims the effect and dies before finishing it.
        const claimed = (await claimPersistenceEffect(engine, localHostId()))!;
        expect(claimed).toMatchObject({ kind: 'links', request_id: row.id, state: 'running' });
        await engine.executeRaw("UPDATE persistence_effects SET claim_expires_at=now()-interval '1 second' WHERE id=$1", [claimed.id]);
        await runLinks();
        expect(await effect(row)).toMatchObject({ state: 'committed', outcome: { links: 'committed', added: 2 } });
        expect(await links()).toEqual([mention('companies/acme-example'), mention('people/alice-example')]);
        return;
      }

      if (scenario === 'revoked') {
        const row = await write(MENTIONS(sourceId));
        await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [clientId]);
        await runLinks();
        expect(await effect(row)).toMatchObject({ state: 'committed', outcome: { links: 'skipped', reason: 'permission_denied' } });
        expect(await links()).toEqual([]);
        return;
      }

      if (scenario === 'trusted_local') {
        const row = await write(MENTIONS(sourceId), 'notes/example', { remote: false });
        expect(await effect(row)).toBeUndefined();
        expect((row.outcome?.auto_links as Record<string, unknown>)?.skipped).toBeUndefined();
        const local = await links();
        expect(local.some(link => link.link_source === 'mcp-remote-mention')).toBe(false);
        expect(local.map(link => link.to_slug)).toContain('people/alice-example');
        return;
      }

      // reconcile: a batch whose first page references a page the batch creates later.
      const first = await write('---\ntype: note\ntitle: First\n---\n\nSee [[notes/second-example]].\n', 'notes/first-example');
      await runLinks();
      expect((await effect(first)).outcome).toMatchObject({ links: 'committed', added: 0, skipped_targets: [{ slug: 'notes/second-example', reason: 'missing' }] });
      const second = await write('---\ntype: note\ntitle: Second\n---\n\nBack to [[notes/first-example]].\n', 'notes/second-example');
      expect(await engine.transaction(tx => queueLinksReconcile(tx, { sourceId, requestIds: [first.id, second.id] }))).toBe(2);
      await runLinks();
      expect(await links('notes/first-example')).toEqual([mention('notes/second-example')]);
      expect(await links('notes/second-example')).toEqual([mention('notes/first-example')]);
      expect((await effect(first)).outcome).toMatchObject({ links: 'committed', added: 1 });
    });
  } finally { rmSync(home, { force: true, recursive: true }); }
}
