import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli } from './helpers/cli-spawn.ts';

test('local skill commands use the resident PGLite owner without lending CLI authority to stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-live-cli-'));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_UPDATE_CHECK: '0', GBRAIN_SWEEP: '0', NODE_ENV: 'test' };
  const client = new Client({ name: 'shared-live-cli-fixture', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'serve'], cwd: home, env, stderr: 'pipe' });
  const cli = async (args: string[]) => {
    const result = await runCli(args, { home, cwd: home, env: { ...env, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined }, timeoutMs: 60_000 });
    expect({ exit: result.exitCode, failure: result.exitCode ? result.stdout + result.stderr : '' }).toEqual({ exit: 0, failure: '' });
    return result.stdout;
  };
  const json = async (args: string[]) => JSON.parse(await cli([...args, '--json']));
  try {
    await cli(['init', '--pglite', '--no-embedding', '--non-interactive', '--json']);
    await client.connect(transport, { signal: AbortSignal.timeout(30_000) });
    const catalog = await json(['skills', '--schema-version', '2']);
    expect(catalog.skills.length).toBe(3);
    const recall = catalog.skills.find((skill: { name: string }) => skill.name === 'memory-recall');
    const detail = await json(['skill', '--schema-version', '2', '--qualified-id', recall.qualified_id, '--revision', recall.revision]);
    expect(detail.body).toContain('Recall saved context');
    const policy = await json(['skill-policy', '--source-id', 'default']);
    expect(policy.policy.allow_follow).toBe(true);
    const joined = await json(['join-brain', '--adapter', 'generic', '--follow-policy', JSON.stringify({ approved: true, source_ids: ['default'] })]);
    expect(joined.skills.length).toBe(3);
    const refreshed = await json(['sync-brain-skills', '--installation-id', joined.installation_id, '--enrollment-epoch', String(joined.enrollment_epoch)]);
    expect(refreshed.installation_id).toBe(joined.installation_id);
    const body = '---\nname: live-cli-fixture\ndescription: A synthetic live owner test\n---\nLive canonical fixture instructions.\n';
    const published = await json(['put-skill', '--request-id', randomUUID(), '--source-id', 'default',
      '--source-incarnation', recall.source_incarnation, '--pack-id', recall.pack_id, '--name', 'live-cli-fixture',
      '--files', JSON.stringify([{ path: 'skills/live-cli-fixture/SKILL.md', content: body, file_class: 'prose' }])]);
    expect(published.state).toBe('committed');
    const remote = await client.callTool({ name: 'get_skill', arguments: { schema_version: 2, name: 'live-cli-fixture' } });
    expect(remote.isError).not.toBe(true);
    const remoteBody = JSON.parse((remote.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')!.text!);
    expect(remoteBody.body).toBe(body);
    expect(remoteBody.revision).toBe(published.revision);
    const denied = await client.callTool({ name: 'get_skill_policy', arguments: { source_id: 'default' } });
    expect(denied.isError).toBe(true);
    await json(['leave-brain', '--installation-id', joined.installation_id, '--enrollment-epoch', String(joined.enrollment_epoch)]);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 180_000);
