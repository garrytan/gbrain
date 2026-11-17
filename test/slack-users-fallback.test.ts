/**
 * #9601: a user the users listing lacked is cached under its raw id. A later run that renders that user lists the
 * workspace again once the listing is a day old, so a new member gets a name; within the day it does not re-list,
 * so a Slack Connect user (never in the listing) does not cost a full listing every run.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { slackFetch, slackTs, type FakeSlack, slackTestToken } from './helpers/slack-fixture.ts';
import { runSlackSync } from '../src/core/slack/slack-source.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { slackApi } from '../src/core/slack/client.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-slack-users-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a user cached under the raw id is looked up again once the listing is a day old, not before', async () => {
  const fake: FakeSlack = { teamId: 'TACME00001', users: {}, calls: [], channels: [
    { id: 'CGENERAL01', name: 'general', messages: [{ ts: slackTs(NOW - 50 * HOUR), user: 'UBOB000001', text: 'First sync, before the listing had me.' }] },
  ] };
  const config = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', ['slack-users', JSON.stringify(config)]);
  const cfg = parseSlackSourceConfig(config, '');
  const sync = (at: number) => runSlackSync(engine, 'slack-users', cfg, { ...options }, {
    api: slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', fetchImpl: slackFetch(fake), sleep: async () => {}, minDelayMs: 0, now: () => at }), now: () => at });
  const listings = () => fake.calls.filter(c => c === 'users.list').length;
  const dayBody = async (text: string) => (await engine.executeRaw<{ body: string }>(
    `SELECT compiled_truth AS body FROM pages WHERE source_id='slack-users' AND deleted_at IS NULL AND compiled_truth LIKE $1`, [`%${text}%`]))[0]?.body ?? '';

  await sync(NOW);
  expect(listings()).toBe(1);

  fake.users.UBOB000001 = { name: 'Bob Example' };
  fake.channels[0]!.messages.push({ ts: slackTs(NOW - 26 * HOUR), user: 'UBOB000001', text: 'Second sync, an hour later.' });
  await sync(NOW + HOUR);
  expect(listings()).toBe(1);
  expect(await dayBody('Second sync')).toContain('**UBOB000001**');

  fake.channels[0]!.messages.push({ ts: slackTs(NOW - 2 * HOUR), user: 'UBOB000001', text: 'Third sync, a day later.' });
  await sync(NOW + 25 * HOUR);
  expect(listings()).toBe(2);
  const body = await dayBody('Third sync');
  expect(body).toContain('**Bob Example**');
  expect(body).not.toContain('**UBOB000001**');
}, 120_000);
