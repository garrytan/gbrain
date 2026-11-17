import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentLauncher } from '../src/core/agent-install/launcher.ts';

test('thin-client launcher reports missing node_modules actionably', async () => {
  const root = mkdtempSync(join(tmpdir(), 'thin-deps-'));
  try {
    mkdirSync(join(root, 'tree', 'src'), { recursive: true });
    const cli = join(root, 'tree', 'src', 'cli.ts');
    writeFileSync(cli, 'console.log("ran");\n');
    const launcher = join(root, 'gbrain');
    writeFileSync(launcher, renderAgentLauncher({ root, bunPath: process.execPath, cliPath: cli, mode: 'thin-client' }), { mode: 0o700 });
    const child = Bun.spawn(['bash', launcher], { stdout: 'pipe', stderr: 'pipe' });
    const err = await new Response(child.stderr).text();
    const code = await child.exited;
    expect(err).toContain('thin-client dependencies are missing');
    expect(err).toContain('install --frozen-lockfile --ignore-scripts');
    expect(code).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
