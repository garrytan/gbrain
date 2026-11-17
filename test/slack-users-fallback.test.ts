/**
 * A user cached with the raw-id fallback (the users listing lacked it) is not
 * resolved: the next run that renders a message by that user re-lists.
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

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (daysAgo: number, hour: number) => Date.parse(new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00Z`);

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-slack-users-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a user cached with the id fallback is looked up again on the next run', async () => {
  const fake: FakeSlack = { teamId: 'TACME00001', users: {}, calls: [], channels: [
    { id: 'CGENERAL01', name: 'general', messages: [{ ts: slackTs(at(2, 9)), user: 'UBOB000001', text: 'First sync, before the listing had me.' }] },
  ] };
  const config = { kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', ['slack-users', JSON.stringify(config)]);
  const cfg = parseSlackSourceConfig(config, '');
  const sync = () => runSlackSync(engine, 'slack-users', cfg, { ...options }, {
    api: slackApi({ token: slackTestToken(), userAgent: 'gbrain-test', fetchImpl: slackFetch(fake), sleep: async () => {}, minDelayMs: 0, now: () => NOW }), now: () => NOW });
  await sync();
  fake.users.UBOB000001 = { name: 'Bob Example' };
  fake.channels[0]!.messages.push({ ts: slackTs(at(1, 11)), user: 'UBOB000001', text: 'Second sync, after the listing has me.' });
  await sync();
  const [row] = await engine.executeRaw<{ body: string }>(
    `SELECT compiled_truth AS body FROM pages WHERE source_id='slack-users' AND deleted_at IS NULL AND compiled_truth LIKE '%Second sync%'`);
  expect(row!.body).toContain('**Bob Example**');
  expect(row!.body).not.toContain('**UBOB000001**');
}, 120_000);
