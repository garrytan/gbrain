/**
 * GBRA-218 member-access doctor checks on a repo-less PGLite brain:
 * access_readers_malformed, access_unknown_readers, access_recent_narrowings
 * and access_page_readers_backfill each find their case, carry a fix whose
 * verify is the read-only check, and are not applicable on a brain with no
 * member restriction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { memberAccessEntry } from '../src/commands/doctor/checks/member-access.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

const SRC = 'ad-team';
const page = (title: string, readers?: string) => ['---', 'type: note', 'title: ' + title, ...(readers ? ['readable_by: ' + readers] : []), '---', '# ' + title, '', 'Body.'].join('\n');

describe('member-access doctor checks (pglite, repo-less)', () => {
  let engine: BrainEngine;
  const run = async () => Object.fromEntries((await memberAccessEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string }>).map(c => [c.name, c])) as Record<string, any>;

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a brain with no member restriction is not applicable for every check', async () => {
    await importFromContent(engine, 'notes/open', page('Open'), { sourceId: SRC, noEmbed: true });
    const checks = await run();
    expect(Object.keys(checks).sort()).toEqual(['access_page_readers_backfill', 'access_readers_malformed', 'access_recent_narrowings', 'access_unknown_readers']);
    for (const c of Object.values(checks)) expect(c).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
  }, 60_000);

  test('each check finds its case', async () => {
    for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a'), ('team-empty')");
    await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', 'bob-example')");
    await importFromContent(engine, 'notes/fine', page('Fine', '[alice-example, group:team-a]'), { sourceId: SRC, noEmbed: true });
    await importFromContent(engine, 'notes/odd', page('Odd', '[alice-example, Not Valid]'), { sourceId: SRC, noEmbed: true });
    await importFromContent(engine, 'notes/typo', page('Typo', '[alice-exmaple, group:team-b, group:team-empty]'), { sourceId: SRC, noEmbed: true });
    await engine.createVersion('notes/open', { sourceId: SRC });
    await importFromContent(engine, 'notes/open', page('Open', '[bob-example]'), { sourceId: SRC, noEmbed: true });
    const checks = await run();

    expect(checks.access_readers_malformed).toMatchObject({ status: 'warn', details: { count: 1, samples: [SRC + ':notes/odd'] } });
    expect(checks.access_readers_malformed.fix).toMatchObject({ argv: ['gbrain', 'get', '--source', SRC, '--', 'notes/odd'], verify: { argv: ['gbrain', 'doctor', '--only', 'access_readers_malformed', '--json'] } });

    expect(checks.access_unknown_readers.status).toBe('warn');
    expect(checks.access_unknown_readers.details.unknown.map((u: { reader: string }) => u.reader).sort()).toEqual(['group:team-b', 'member:alice-exmaple']);
    expect(checks.access_unknown_readers.details.empty_groups).toEqual([{ reader: 'group:team-empty', pages: 1 }]);
    expect(checks.access_unknown_readers.fix).toMatchObject({ ask_user: true, verify: { argv: ['gbrain', 'doctor', '--only', 'access_unknown_readers', '--json'] } });

    expect(checks.access_recent_narrowings).toMatchObject({ status: 'warn', details: { count: 1, narrowings: [{ page: SRC + ':notes/open', readers: ['member:bob-example'] }] } });
    expect(checks.access_recent_narrowings.fix.verify).toEqual({ argv: ['gbrain', 'doctor', '--only', 'access_recent_narrowings', '--json'] });

    expect(checks.access_page_readers_backfill).toMatchObject({ status: 'ok', details: { count: 0 } });
    await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER pages_access_derive_readers');
    try { await engine.executeRaw("UPDATE pages SET page_readers = NULL WHERE slug = 'notes/fine'"); } finally { await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER pages_access_derive_readers'); }
    const after = await run();
    expect(after.access_page_readers_backfill).toMatchObject({ status: 'warn', details: { count: 1 }, fix: { argv: ['gbrain', 'repair', 'access', '--apply'], preview_argv: ['gbrain', 'repair', 'access', '--json'], ask_user: true, verify: { argv: ['gbrain', 'doctor', '--only', 'access_page_readers_backfill', '--json'] } } });
  }, 60_000);
});
