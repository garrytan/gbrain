/**
 * Apple Contacts enrichment (plan GST-3278, PR 2) on a repo-less brain, against the synthetic Contacts read stub and a
 * fake write route: off by default; dry_run records the proposals and sends nothing; on sends one enrich-token batch
 * only when writes are on. It fills only empty company and job title fields from the one linked person page, adds only
 * confirmed emails and phones (the owner's Google Contacts row for that card alone, or a fact the owner stated), creates
 * a card only when switched on and only for a Google Contacts entry matching one person page, never touches a card linked to two people, and its
 * record holds no email or phone. Every name and address is a placeholder; nothing talks to a real Mac.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { ContactsStub, STUB_TOKEN, type StubContact } from './helpers/apple-contacts-stub.ts';
import { runAppleContactsSync } from '../src/core/apple-contacts/apple-contacts-source.ts';
import { parseAppleContactsSourceConfig } from '../src/core/apple-contacts/source-config.ts';
import { proposeEnrichment, readEnrichRecord } from '../src/core/apple-contacts/enrich.ts';
import { APPLE_CONTACT_ID_KEY } from '../src/core/apple-contacts/types.ts';
import { appleContactsError } from '../src/core/apple/contacts-client.ts';
import type { ContactsWriteOpts } from '../src/core/apple/contacts-write-client.ts';
import { runAppleContacts } from '../src/commands/apple-contacts.ts';

const WRITE_TOKEN = ['tok', 'fixture', 'enrich'].join('-');
let home = '';
let engine: BrainEngine;
let stub: ContactsStub;
let sourceId = '';
let cfg: ReturnType<typeof parseAppleContactsSourceConfig>;
const sent: ContactsWriteOpts[] = [];
let answer: (o: ContactsWriteOpts) => Promise<unknown> = async o => ({ batch: o.batch, journal: 'j-1', stopped: null, sideEffects: 'all', next: null,
  results: o.changes.map(c => ({ key: c.key, op: c.op, status: 'applied', id: c.id ?? 'card-new', reason: null })) });
const send = async (o: ContactsWriteOpts) => { sent.push(o); return answer(o) as never; };
const run = () => runAppleContactsSync(engine, sourceId, cfg, { ...options } as SyncOpts, { log: () => {}, enrichSend: send });
const person = (slug: string, title: string, frontmatter: Record<string, unknown>, source = 'default') =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: title + ' is a placeholder.', timeline: '', frontmatter } as never, { sourceId: source } as never);
const card = (given: string, email: string, extra: Partial<StubContact> = {}): StubContact => ({ given_name: given, family_name: 'Example', emails: [{ label: null, value: email }], ...extra });
const ownerCtx = (remote = false) => ({ engine, config: { engine: engine.kind }, remote, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } }) as never;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-apple-enrich-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const tokenFile = join(home, 'read-token.json');
  writeFileSync(tokenFile, JSON.stringify({ accessToken: STUB_TOKEN }), { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const writeToken = join(home, 'write-token.json');
  writeFileSync(writeToken, JSON.stringify({ accessToken: WRITE_TOKEN }), { mode: 0o600 });
  chmodSync(writeToken, 0o600);
  await engine.setConfig('apple_contacts.write_token_file', writeToken);

  stub = new ContactsStub().start();
  stub.upsert('c-alice', card('Alice', 'alice@example.invalid'));
  stub.upsert('c-bob', card('Bob', 'bob@example.invalid', { organization: 'Kept Co' }));
  stub.upsert('c-twin', card('Twin', 'twin@example.invalid'));
  sourceId = 'apple-contacts-enrich';
  const config = { kind: 'apple-contacts', ac_helper_host: '127.0.0.1', ac_helper_port: stub.port, ac_token_file: tokenFile, owner_only: true, federated: false };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [sourceId, JSON.stringify(config)]);
  cfg = parseAppleContactsSourceConfig(config);

  await person('people/alice-example', 'Alice Example', { email: 'alice@example.invalid', company: 'Acme Example', role: 'Engineer' });
  await person('people/bob-example', 'Bob Example', { email: 'bob@example.invalid', company: 'Other Co', role: 'Designer' });
  await person('people/twin-one', 'Twin One', { email: 'twin@example.invalid', company: 'Twin Co' });
  await person('people/twin-two', 'Twin Two', { email: 'twin@example.invalid', company: 'Twin Co' });
  await person('people/carol-example', 'Carol Example', { email: 'carol@example.invalid', company: 'Carol Co' });
  const { operationsByName } = await import('../src/core/operations.ts');
  await operationsByName.remember!.handler(ownerCtx(), { fact: 'Phone: (555) 555-0123', entity: 'people/alice-example', source_id: 'default',
    provenance: 'owner-note', content_origin: 'user_said', infer_entity: false });
  await operationsByName.remember!.handler(ownerCtx(true), { fact: 'An old address was alice.old@example.invalid', entity: 'people/alice-example', source_id: 'default',
    provenance: 'mail-extract', content_origin: 'inferred', infer_entity: false });

  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', ['google-a', JSON.stringify({ kind: 'google' })]);
  const google = (slug: string, title: string, emails: string[], phones: string[] = []) =>
    person(slug, title, { google_contact_id: 'people/' + slug, emails, ...(phones.length ? { phones } : {}) }, 'google-a');
  await google('contacts/alice', 'Alice Example', ['alice@example.invalid', 'alice.work@example.invalid']);
  await google('contacts/shared', 'Shared Inbox', ['bob@example.invalid', 'twin@example.invalid', 'shared.extra@example.invalid']);
  await google('contacts/carol', 'Carol Example', ['carol@example.invalid'], ['+1 555 555 0177']);
  await google('contacts/dave', 'Dave Example', ['dave@example.invalid']);
}, 120_000);
afterAll(async () => { stub?.stop(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const shape = (changes: Array<{ op: string; card: string | null; field: string | null; value: string | null; from: string }>) =>
  changes.map(c => [c.op, c.card ?? 'new', c.field ?? '', c.value ?? '', c.from].join(' ')).sort();

describe('apple contacts enrichment (repo-less brain)', () => {
  test('off by default: a pull records and sends nothing', async () => {
    const result = await run();
    expect(result.status).toBe('synced');
    expect(await readEnrichRecord(engine, sourceId)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test('dry_run records only adds and fills from confirmed values, and sends nothing; new cards only once switched on', async () => {
    await engine.setConfig('apple_contacts.enrich', 'dry_run');
    await run();
    const existing = [
      'add_value c-alice emails  google-a:contacts/alice',
      'add_value c-alice phones  default:people/alice-example',
      'fill c-alice job_title Engineer default:people/alice-example',
      'fill c-alice organization Acme Example default:people/alice-example',
      'fill c-bob job_title Designer default:people/bob-example',
    ];
    expect(shape((await readEnrichRecord(engine, sourceId))!.changes)).toEqual(existing);
    await engine.setConfig('apple_contacts.enrich.create_cards', 'true');
    await run();
    const record = (await readEnrichRecord(engine, sourceId))!;
    expect(record.mode).toBe('dry_run');
    expect(record.sent).toBe(false);
    expect(shape(record.changes)).toEqual([...existing, 'create new   google-a:contacts/carol'].sort());
    const stored = JSON.stringify(record);
    for (const value of ['alice.work@example.invalid', '0123', 'carol@example.invalid', '0177', 'alice.old']) expect(stored).not.toContain(value);
    expect(sent).toHaveLength(0);
  });

  test('on with writes off sends nothing and says why', async () => {
    await engine.setConfig('apple_contacts.enrich', 'on');
    await run();
    const record = (await readEnrichRecord(engine, sourceId))!;
    expect(record.sent).toBe(false);
    expect(record.note).toContain('apple_contacts.write is off');
    expect(sent).toHaveLength(0);
  });

  test('on sends one enrich-token batch whose results are recorded; a rerun repeats the same keys and batch', async () => {
    await engine.setConfig('apple_contacts.write', 'on');
    await run();
    expect(sent).toHaveLength(1);
    const batch = sent[0]!;
    expect(batch.auth).toEqual({ kind: 'enrich', token: WRITE_TOKEN });
    expect(batch.changes.map(c => c.op).sort()).toEqual(['add_value', 'add_value', 'create', 'fill', 'fill', 'fill']);
    expect(batch.changes.every(c => ['create', 'fill', 'add_value', 'group_add'].includes(c.op))).toBe(true);
    const create = batch.changes.find(c => c.op === 'create')!;
    expect(create.fields).toEqual({ given_name: 'Carol', family_name: 'Example', organization: 'Carol Co',
      emails: [{ label: '', value: 'carol@example.invalid' }], phones: [{ label: '', value: '+1 555 555 0177' }] });
    expect(batch.changes.find(c => c.op === 'add_value' && c.field === 'emails')!.value).toBe('alice.work@example.invalid');
    const record = (await readEnrichRecord(engine, sourceId))!;
    expect(record.sent).toBe(true);
    expect(record.changes.every(c => c.status === 'applied')).toBe(true);
    await run();
    expect(sent[1]!.batch).toBe(batch.batch);
    expect(sent[1]!.changes.map(c => c.key)).toEqual(batch.changes.map(c => c.key));
  });

  test('a helper refusal is recorded and never fails the pull', async () => {
    answer = async () => { throw appleContactsError('apple_contacts_write_off', 'Contacts writes are switched off on the Mac.', 'fix'); };
    const result = await run();
    expect(['synced', 'up_to_date']).toContain(result.status);
    const record = (await readEnrichRecord(engine, sourceId))!;
    expect(record.sent).toBe(false);
    expect(record.note).toBe('apple_contacts_write_off');
  });

  test('enrich status and dry-run print the last run and the next proposals', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await runAppleContacts(engine, ['enrich', 'status', '--source', sourceId]);
      await runAppleContacts(engine, ['enrich', 'dry-run', '--source', sourceId, '--json']);
    } finally { spy.mockRestore(); }
    expect(lines[0]).toContain('enrich: on');
    expect(lines[0]).toContain('apple_contacts_write_off');
    expect(lines[0]).toContain('fill c-alice organization = Acme Example from default:people/alice-example');
    const dry = JSON.parse(lines[1]!) as { dry_run: boolean; changes: unknown[] };
    expect(dry.dry_run).toBe(true);
    expect(dry.changes).toHaveLength(6);
  });

  test('only a whole, still valid Email: or Phone: fact adds a value, and a card linked to two people gets nothing from Google Contacts', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    for (const fact of ['Do not use mallory@example.invalid; it belongs to someone else now', 'Met on 2024-01-15 10:30', 'Phone: +1 555 555 0199']) {
      await operationsByName.remember!.handler(ownerCtx(), { fact, entity: 'people/alice-example', source_id: 'default', provenance: 'owner-note',
        content_origin: 'user_said', infer_entity: false });
    }
    await engine.executeRaw("UPDATE facts SET valid_from='1999-01-01', valid_until='2000-01-01' WHERE fact='Phone: +1 555 555 0199'");
    const [twinCard] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND frontmatter->>$2 = $3', [sourceId, APPLE_CONTACT_ID_KEY, 'c-twin']);
    const twins = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug IN ('people/twin-one','people/twin-two')");
    for (const [source, page] of [[sourceId, twinCard!.id], ...twins.map(t => ['default', t.id] as const)] as const) {
      await engine.executeRaw("INSERT INTO entity_identities (entity_id, source_id, page_id) VALUES ('ent-twin-example', $1, $2)", [source, page]);
    }
    await person('contacts/twin-only', 'Twin Only', { google_contact_id: 'people/contacts/twin-only', emails: ['twin@example.invalid', 'twin.alt@example.invalid'] }, 'google-a');
    const adds = (await proposeEnrichment(engine, sourceId, '1')).filter(p => p.change.op === 'add_value').map(p => p.change.id + ' ' + p.change.value);
    expect(adds.sort()).toEqual(['c-alice (555) 555-0123', 'c-alice alice.work@example.invalid']);
  });
});
