/**
 * Recorded-time reads (get_page / get_versions with known_as_of) by a remote read-scope caller must not serve
 * what the current-time read withholds from that caller: (1) a quarantined page's body, (2) a page whose
 * readable_by excludes the caller, (3) a soft-deleted page. The plain version history (4) and delta's belief changes (5)
 * keep a quarantined page's body and claims from the same caller, (6) when the page was quarantined only by a later write too, and
 * (7) per page across granted sources. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';
import { importFromContent } from '../src/core/import-file.ts';

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const at = async (b: BeliefBrain) => {
  await pause();
  const [row] = await b.engine.executeRaw<{ t: string }>(`SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t`);
  await pause();
  return new Date(row!.t).toISOString();
};
const remoteOf = (b: BeliefBrain) => ({ ...b.ctx, remote: true, transport: 'http', takesHoldersAllowList: ['world'], sourceId: b.sourceId,
  auth: { token: '', clientId: 'reader-probe', scopes: ['read'], sourceId: b.sourceId, allowedSources: [b.sourceId] } }) as unknown as BeliefBrain['ctx'];
const call = (b: BeliefBrain, ctx: BeliefBrain['ctx'], op: string, params: Record<string, unknown>) =>
  (operationsByName[op]!.handler(ctx, params) as Promise<unknown>).then(r => ({ ok: true as const, text: JSON.stringify(r) }), (e: { code?: string }) => ({ ok: false as const, code: e.code, text: '' }));

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`recorded-time reads respect the remote read gate (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { managed: true, databaseUrl: engineCase.databaseUrl });

    test('(1) a quarantined page: the current read omits the body, and so does every recorded-time read', () => brain(async b => {
      const slug = 'companies/quarantined-example';
      const control = 'companies/plain-example';
      await b.put(slug, beliefPage({ title: 'Attention Required! | Cloudflare', prose: 'Canary body canaryquarantine.' }));
      await b.put(control, beliefPage({ prose: 'Canary body canarycontrol.' }));
      const [row] = await b.engine.executeRaw<{ q: unknown }>(`SELECT frontmatter->'quarantine' AS q FROM pages WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]);
      expect(row?.q).toMatchObject({ reason: 'junk_pattern' });
      const t = await at(b);
      const remote = remoteOf(b);
      const current = await call(b, remote, 'get_page', { slug });
      expect([current.ok, current.text.includes('canaryquarantine')]).toEqual([true, false]);
      expect((await call(b, remote, 'get_page', { slug: control, known_as_of: t })).text).toContain('canarycontrol');
      for (const [op, params] of [['get_page', { slug, known_as_of: t }], ['get_versions', { slug, known_as_of: t, include_body: true, diff: true }]] as const) {
        const out = await call(b, remote, op, params);
        expect({ op, leaked: out.text.includes('canaryquarantine') }).toEqual({ op, leaked: false });
      }
    }), 120_000);

    test('(2) a page whose readable_by excludes the caller: every recorded-time read answers page_not_found', () => brain(async b => {
      const slug = 'notes/restricted-example';
      await b.put(slug, beliefPage({ type: 'note', title: 'Restricted', prose: 'Canary body canaryrestricted.', frontmatter: { readable_by: '[alice-example]' } }));
      await b.put('notes/open-example', beliefPage({ type: 'note', title: 'Open', prose: 'Canary body canaryopen.' }));
      const t = await at(b);
      const remote = remoteOf(b);
      expect((await call(b, remote, 'get_page', { slug: 'notes/open-example', known_as_of: t })).text).toContain('canaryopen');
      expect((await call(b, b.ctx, 'get_page', { slug, known_as_of: t })).text).toContain('canaryrestricted');
      expect(await call(b, remote, 'get_page', { slug })).toMatchObject({ ok: false, code: 'page_not_found' });
      for (const [op, params] of [['get_page', { slug, known_as_of: t }], ['get_versions', { slug, known_as_of: t, include_body: true, diff: true }]] as const) {
        const out = await call(b, remote, op, params);
        expect({ op, ok: out.ok, code: out.ok ? null : out.code, leaked: out.text.includes('canaryrestricted') }).toEqual({ op, ok: false, code: 'page_not_found', leaked: false });
      }
    }), 120_000);

    test('(3) a soft-deleted page: no recorded-time read serves its body to a remote caller, with or without include_deleted', () => brain(async b => {
      const slug = 'companies/deleted-example';
      await b.put(slug, beliefPage({ prose: 'Canary body canarydeleted.' }));
      const before = await at(b);
      expect((await call(b, remoteOf(b), 'get_page', { slug, known_as_of: before })).text).toContain('canarydeleted');
      const [{ revision }] = await b.engine.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]) as [{ revision: string }];
      await b.op('delete_page', { slug, expected_revision: revision });
      const after = await at(b);
      const remote = remoteOf(b);
      expect(await call(b, remote, 'get_page', { slug })).toMatchObject({ ok: false, code: 'page_not_found' });
      for (const t of [before, after]) {
        for (const [op, params] of [['get_page', { slug, known_as_of: t }], ['get_page', { slug, known_as_of: t, include_deleted: true }],
          ['get_versions', { slug, known_as_of: t, include_body: true, diff: true }]] as const) {
          const out = await call(b, remote, op, params);
          expect({ op, t: t === before ? 'before' : 'after', params: Object.keys(params).join(','), leaked: out.text.includes('canarydeleted') })
            .toEqual({ op, t: t === before ? 'before' : 'after', params: Object.keys(params).join(','), leaked: false });
        }
      }
    }), 120_000);
    test('(4) a quarantined page: the plain version history keeps its bodies from a remote caller too, and the local caller keeps them', () => brain(async b => {
      const slug = 'companies/quarantined-history-example';
      await b.put(slug, beliefPage({ title: 'Attention Required! | Cloudflare', prose: 'Canary body canaryqhistory one.' }));
      await b.put(slug, beliefPage({ title: 'Attention Required! | Cloudflare', prose: 'Canary body canaryqhistory two.' }));
      await b.put('companies/plain-history-example', beliefPage({ prose: 'Canary body canaryhistorycontrol one.' }));
      await b.put('companies/plain-history-example', beliefPage({ prose: 'Canary body canaryhistorycontrol two.' }));
      const remote = remoteOf(b);
      expect((await call(b, remote, 'get_versions', { slug: 'companies/plain-history-example', include_body: true })).text).toContain('canaryhistorycontrol');
      expect((await call(b, b.ctx, 'get_versions', { slug, include_body: true })).text).toContain('canaryqhistory');
      const out = await call(b, remote, 'get_versions', { slug, include_body: true });
      expect({ ok: out.ok, leaked: out.text.includes('canaryqhistory') }).toEqual({ ok: true, leaked: false });
    }), 120_000);

    test('(5) a quarantined page: delta {beliefs: true} gives a remote caller none of its recorded claims', () => brain(async b => {
      const t0 = await at(b);
      await b.put('companies/quarantined-claims-example', beliefPage({ title: 'Attention Required! | Cloudflare', facts: ['Canary claim canaryqclaim'] }));
      await b.put('companies/plain-claims-example', beliefPage({ facts: ['Canary claim canaryclaimcontrol'] }));
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const remote = { ...remoteOf(b), auth: { clientId: 'reader-probe', scopes: ['read'] } } as unknown as BeliefBrain['ctx'];
      const out = await call(b, remote, 'delta', { since: t0, beliefs: true });
      expect(out.text).toContain('canaryclaimcontrol');
      expect(out.text.includes('canaryqclaim')).toBe(false);
    }), 120_000);

    test('(6) a page created clean and quarantined by a later write: delta {beliefs: true} gives a remote caller none of its creation claims', () => brain(async b => {
      const t0 = await at(b);
      const slug = 'companies/late-quarantine-example';
      await b.put(slug, beliefPage({ facts: ['Canary claim canarylateq'] }));
      await b.put('companies/plain-late-example', beliefPage({ facts: ['Canary claim canarylatecontrol'] }));
      await b.put(slug, beliefPage({ title: 'Attention Required! | Cloudflare', facts: ['Canary claim canarylateq'] }));
      const [row] = await b.engine.executeRaw<{ q: unknown }>(`SELECT frontmatter->'quarantine' AS q FROM pages WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]);
      expect(row?.q).toMatchObject({ reason: 'junk_pattern' });
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const remote = { ...remoteOf(b), auth: { clientId: 'reader-probe', scopes: ['read'] } } as unknown as BeliefBrain['ctx'];
      const out = await call(b, remote, 'delta', { since: t0, beliefs: true });
      expect(out.text).toContain('canarylatecontrol');
      expect(out.text.includes('canarylateq')).toBe(false);
    }), 120_000);

    test('(7) a federated version history: each version follows its own page, so a newer clean page in another source does not open a quarantined page\'s bodies', () => beliefBrain(async b => {
      const slug = 'companies/federated-history-example';
      await b.put(slug, beliefPage({ prose: 'Canary body canaryfedq one.' }));
      await b.put(slug, beliefPage({ title: 'Attention Required! | Cloudflare', prose: 'Canary body canaryfedq two.' }));
      const [row] = await b.engine.executeRaw<{ q: unknown }>(`SELECT frontmatter->'quarantine' AS q FROM pages WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]);
      expect(row?.q).toMatchObject({ reason: 'junk_pattern' });
      await b.engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      await pause();
      await importFromContent(b.engine, slug, beliefPage({ prose: 'Canary body canaryfedclean one.' }), { sourceId: 'source-b', noEmbed: true });
      await b.engine.createVersion(slug, { sourceId: 'source-b' });
      const remote = remoteOf(b);
      const federated = { ...remote, auth: { ...remote.auth, allowedSources: [b.sourceId, 'source-b'] } } as unknown as BeliefBrain['ctx'];
      const out = await call(b, federated, 'get_versions', { slug, include_body: true });
      expect({ ok: out.ok, control: out.text.includes('canaryfedclean'), leaked: out.text.includes('canaryfedq') }).toEqual({ ok: true, control: true, leaked: false });
    }, { databaseUrl: engineCase.databaseUrl }), 120_000);
  });
}
