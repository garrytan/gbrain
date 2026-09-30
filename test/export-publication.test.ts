import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportStage, EXPORT_MARKER } from '../src/core/export-stage.ts';
import { publishExport } from '../src/core/export-publish.ts';

async function fixture(run: (stage: ExportStage, root: string, outside: string) => Promise<void>) {
  const stage = new ExportStage();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'export-publish-')));
  const root = join(base, 'out'), outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  try { await run(stage, root, outside); }
  finally { chmodSync(root, 0o700); stage.close(); rmSync(base, { recursive: true, force: true }); }
}
test('atomic leaves never replace a newly occupied later target', () => fixture(async (stage, root) => {
  stage.add('a.md', 'file', 'first'); stage.add('b.md', 'file', 'second');
  await expect(publishExport(stage, root, () => writeFileSync(join(root, 'b.md'), 'competitor'))).rejects.toThrow();
  expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe('competitor');
  expect(readFileSync(join(root, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
}));
test('exclusive marker fences competing exporters', () => fixture(async (stage, root) => {
  stage.add('a.md', 'file', 'first');
  const competitor = new ExportStage(); competitor.add('b.md', 'file', 'second');
  try {
    await publishExport(stage, root, async () => { await expect(publishExport(competitor, root)).rejects.toThrow(); });
    expect(existsSync(join(root, 'b.md'))).toBe(false);
  } finally { competitor.close(); }
}));
test('ancestor symlink replacement cannot redirect a later file outside', () => fixture(async (stage, root, outside) => {
  stage.add('a.md', 'file', 'first'); stage.add('nested/b.md', 'file', 'second');
  await expect(publishExport(stage, root, () => symlinkSync(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir'))).rejects.toThrow();
  expect(existsSync(join(outside, 'b.md'))).toBe(false);
}));
test('root replacement cannot receive files or a completion receipt', () => fixture(async (stage, root, outside) => {
  stage.add('a.md', 'file', 'first'); stage.add('b.md', 'file', 'second');
  await expect(publishExport(stage, root, (path) => {
    if (path === 'a.md') { renameSync(root, root + '-old'); mkdirSync(root); }
  })).rejects.toThrow();
  expect(existsSync(join(root, 'b.md'))).toBe(false);
  expect(readFileSync(join(existsSync(root + '-old') ? root + '-old' : root, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
  expect(existsSync(join(outside, 'b.md'))).toBe(false);
}));
test('marker replacement refuses completion without modifying the replacement', () => fixture(async (stage, root) => {
  stage.add('a.md', 'file', 'first');
  await expect(publishExport(stage, root, () => {
    renameSync(join(root, EXPORT_MARKER), join(root, 'original-marker'));
    writeFileSync(join(root, EXPORT_MARKER), 'unknown');
  })).rejects.toThrow();
  if (existsSync(join(root, 'original-marker'))) {
    expect(readFileSync(join(root, EXPORT_MARKER), 'utf8')).toBe('unknown');
    expect(readFileSync(join(root, 'original-marker'), 'utf8')).not.toContain('\nCOMPLETE\n');
  } else expect(readFileSync(join(root, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
}));
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('permission failure after publication leaves a durable incomplete marker', () => fixture(async (stage, root) => {
  stage.add('a.md', 'file', 'first'); stage.add('b.md', 'file', 'second');
  await expect(publishExport(stage, root, () => chmodSync(root, 0o500))).rejects.toThrow();
  expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('first');
  expect(readFileSync(join(root, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
}));
test('SIGKILL after a leaf leaves an incomplete marker and nonzero process result', () => fixture(async (_stage, root) => {
  const program = `import {ExportStage} from './src/core/export-stage.ts';
    import {publishExport} from './src/core/export-publish.ts';
    const stage = new ExportStage(); stage.add('a.md','file','first'); stage.add('b.md','file','second');
    await publishExport(stage, ${JSON.stringify(root)}, () => { console.log('KILLING'); process.kill(process.pid, 'SIGKILL'); });`;
  const child = Bun.spawnSync([process.execPath, '-e', program], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode).not.toBe(0);
  expect(child.stdout.toString()).toContain('KILLING');
  expect(child.stderr.toString()).toBe('');
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('first');
  expect(existsSync(join(root, 'b.md'))).toBe(false);
  expect(readFileSync(join(root, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
}));
