import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/core/persistence/digest.ts';

test('generic local CLI imports reviewed human skill edits through durable publication', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-proposal-cli-'));
  const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_IN_AGENT_SETUP']) delete env[key as keyof typeof env];
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: home, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error: code ? stdout + stderr : '' }).toEqual({ code: 0, error: '' });
    return stdout;
  };
  const call = async (operation: string, params: Record<string, unknown>) => {
    const output = await run(['call', '--source', 'default', operation, JSON.stringify(params)]);
    const envelope = JSON.parse(output);
    expect(envelope.isError).not.toBe(true);
    expect(envelope.error).toBeUndefined();
    return Array.isArray(envelope.content) ? JSON.parse(envelope.content[0].text) : envelope;
  };
  try {
    const output = await run(['init', '--pglite', '--no-embedding', '--non-interactive', '--json']);
    const initialized = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.status === 'success');
    expect(initialized.content.status).toBe('ready');
    const before = await call('get_skill', { schema_version: 2, source_id: 'default', name: 'memory-recall' });
    const path = 'skills/memory-recall/SKILL.md';
    const body = `${before.body}\nReviewed synthetic CLI import.\n`;
    writeFileSync(join(initialized.content.root, path), body);
    const params = { request_id: randomUUID(), expected_revision: before.revision, source_id: 'default', source_incarnation: before.source_incarnation,
      pack_id: before.pack_id, name: before.name, files: [{ path, content: body, file_class: 'prose' }],
      expected_hashes: { [path]: sha256(body), 'skillpack.json': sha256(readFileSync(join(initialized.content.root, 'skillpack.json'))) } };
    const published = await call('import_skill_proposal', params);
    expect(published.state).toBe('committed');
    expect(published.revision).not.toBe(before.revision);
    expect((await call('get_skill', { schema_version: 2, source_id: 'default', name: before.name })).body).toBe(body);
    expect((await call('import_skill_proposal', params)).revision).toBe(published.revision);
    expect(readFileSync(join(initialized.content.root, path), 'utf8')).toBe(body);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
