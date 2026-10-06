/**
 * The shared-skills installer and the capability verifier parse a tool
 * result's structured body (content[0]) only. A host that predates the
 * running release appends a one-time `behavior_changes` notice block to each
 * HTTP client's first call; joining every block made `join_brain`'s answer
 * unparseable and the installer reported `shared_skills_unsupported`.
 *
 * Protects: install over HTTP against an upgraded (older than an hour) brain
 * still reaches `restart_required`, while the notice is really delivered to
 * that client. Regression it catches: parsing the joined content blocks.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withTransportFixture } from './fixtures/shared-skills-transports.ts';
import { writeCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';
import { installSharedSkillsConnection } from '../src/core/harness/shared-skills.ts';
import { HTTP_SHOWN_KEY } from '../src/core/behavior-change-notice.ts';
import { resultBodyText } from '../src/core/connect-probe.ts';

test('resultBodyText reads content[0] and ignores appended notice blocks', () => {
  expect(resultBodyText([{ type: 'text', text: '{"ok":true}' }, { type: 'text', text: '[gbrain notice behavior_changes kind=safety]\nwhy: ...' }])).toBe('{"ok":true}');
  expect(resultBodyText([])).toBe('');
  expect(resultBodyText(undefined)).toBe('');
});

test('installing shared skills on an upgraded brain survives the one-time behavior_changes notice', async () => {
  await withTransportFixture(async f => {
    await f.seed();
    await f.engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw("UPDATE sources SET created_at = now() - interval '2 hours'");
    });
    const peer = f.peers.reader;
    const root = join(f.dir, 'gbrain-home', 'bootstrap', 'shared-skills', 'codex', randomUUID());
    const credentials: HarnessCredentials = { version: 1, mcp_url: f.url, issuer_url: f.url.replace(/\/mcp$/, ''),
      client_id: peer.id, access_token: peer.token, shared_skills: { follow: true } };
    writeCredentials(join(root, 'credentials.json'), credentials);
    const installed = await installSharedSkillsConnection(credentials, { harness: 'codex', root, name: 'gbrain', nativeSkillsDir: join(f.dir, 'codex-skills') });
    expect(installed.status).toBe('restart_required');
    const shown = JSON.parse((await f.engine.getConfig(HTTP_SHOWN_KEY)) ?? '{"clients":{}}') as { clients: Record<string, string> };
    expect(Object.keys(shown.clients)).toContain(peer.id);
  });
}, 120_000);
