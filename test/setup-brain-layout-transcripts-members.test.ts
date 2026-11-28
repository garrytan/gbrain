/**
 * `gbrain setup <harness> --serves several --shape company --transcripts <dir>` end to end (GBRA-585, GST-2904): member keys
 * that cannot read the company source are named, and each call stays with the owner and its attendees.
 * Split from test/setup-brain-layout.test.ts (GST-4082).
 * Shared fixture: test/helpers/setup-brain-layout-box.ts. The authoring gate for the whole suite is in test/setup-brain-layout.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupBoxes, box, setup, gbrain, plantedToken, callsDir, CALL_SLUGS } from './helpers/setup-brain-layout-box.ts';

afterAll(cleanupBoxes);

describe('setup --transcripts', () => {
  test('GBRA-585: a company setup whose member keys do not read company says no member key setup minted reads the calls yet', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company'])).exitCode).toBe(0);
    for (const m of ['alice-example', 'bob-example']) expect((await gbrain(b, ['auth', 'rescope', '--token', `member-${m}`, '--sources', 'default'])).exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company', '--no-stdio-member', '--transcripts', callsDir(b, plantedToken())]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'kept', federated: false });
    expect(r.doc.brain_layout.transcripts.calls).toBeUndefined();
    expect(r.doc.brain_layout.transcripts.not_scoped).toMatchObject({ reason: 'stdio_unbound' });
    expect(r.doc.brain_layout.transcripts.not_scoped.command).toContain('--stdio-member');
    expect(r.doc.serves.regrant).toBeUndefined();
    const t = r.doc.brain_layout.transcripts;
    expect(t.imported).toBe(3);
    expect(t.readers).toMatchObject({ members: 'every_source_reader', serves: 'several' });
    expect(t.readers.detail).toStartWith('no member key setup minted reads them yet: source company is not federated');
    expect(t.readers.detail).toContain('gbrain sources federate company');
    expect(t.readers.detail).toContain('this brain serves several people: alice-example, bob-example');
    expect(t.readers.detail).not.toContain('every member key gbrain setup minted');
  }, 300_000);

  test('GST-2904: a company setup for several people ties its own entry to the owner and keeps each call to the owner and its attendees; the archive says why it is on', async () => {
    const b = box();
    const calls = callsDir(b, plantedToken());
    writeFileSync(join(calls, '2026-03-05 hiring debrief.md'), 'Attendees: alice-example, dave-example\n\nAlice: the staff engineer range is set.\n');
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company', '--transcripts', calls]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'created', federated: false });
    expect(r.doc.serves.engine).toContain('gbrain migrate --to postgres');
    const t = r.doc.brain_layout.transcripts;
    const owner = r.doc.target.stdio_member;
    expect(owner).toBe(r.doc.serves.stdio.member);
    expect(r.doc.serves.owner_from).toBe('login');
    expect(r.doc.serves.brain_serves).toBe('several');
    expect(t.imported).toBe(4);
    expect(t.not_scoped).toBeUndefined();
    expect(t.readers).toBeUndefined();
    expect(t.calls).toContainEqual({ slug: 'company/calls/2026-03-05-hiring-debrief', readers: [owner, 'alice-example'], unmatched: ['dave-example'] });
    for (const slug of CALL_SLUGS) expect(t.calls).toContainEqual({ slug, readers: [owner], unmatched: [] });
    const reads = async (member: string, slug: string) => (await gbrain(b, ['get', slug, '--source', 'company', '--as', member])).exitCode === 0;
    expect(await reads('alice-example', 'company/calls/2026-03-05-hiring-debrief')).toBe(true);
    expect(await reads('bob-example', 'company/calls/2026-03-05-hiring-debrief')).toBe(false);
    expect((await gbrain(b, ['get', 'company/calls/2026-03-05-hiring-debrief', '--source', 'company'])).exitCode).toBe(0);
    expect(r.doc.serves.regrant.keys.map((k: any) => [k.member, k.adds])).toEqual([['alice-example', ['company']], ['bob-example', ['company']]]);
    const archive = r.doc.brain_layout.archive;
    expect(archive.state).toBe('on');
    expect(archive.detail).toStartWith('on for now: this brain serves several people');
    expect(archive.detail).toContain('gbrain config set brain.audience shared');
    const status = await gbrain(b, ['transcripts', 'archive', 'status']);
    expect(status.stdout).toContain('conversation archive: on');
    expect(status.stdout).toContain('  why: on for now: this brain serves several people');
    const doctor = JSON.parse((await gbrain(b, ['doctor', '--only', 'transcript_archive_freshness', '--json'])).stdout);
    const check = doctor.checks.find((c: any) => c.name === 'transcript_archive_freshness');
    expect(check.message).toContain('Conversation archive is on (on for now: this brain serves several people');
    expect(check.details).toMatchObject({ enabled: true, enabled_by: 'default', serves_several: true });
    const help = await gbrain(b, ['transcripts', '--help']);
    expect(help.stdout).not.toContain('off unless turned on');
  }, 300_000);
});
