#!/usr/bin/env bun
/**
 * The release addon has no crash points (scripts/rust-crash/README.md). This check opens a brain with the release
 * addon in a child process, with the crash cell's variables set to freeze at the first page write, and writes a page.
 * The child must finish the write and exit 0 within the time bound, and the crash point log must not exist. An addon
 * built with the `crash-points` feature freezes the child at its first write and fails the check.
 *
 *   GBRAIN_RUST_ENGINE_ADDON=<the release addon> bun scripts/rust-crash/release-ignores.ts
 *
 * Exit 0 when the addon ignores the variables; 1 when it does not; 2 on bad usage.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON;
if (!addonPath || !existsSync(addonPath)) {
  console.error('GBRAIN_RUST_ENGINE_ADDON must name the release addon (bun run rust:build prints the path).');
  process.exit(2);
}

if (process.argv[2] === 'child') {
  // The child: one brain, one page write through put_page, then a clean exit.
  const brain = process.argv[3]!;
  const { loadRustEngineAddon } = await import('../../src/core/rust-engine/addon-loader.ts');
  const { openRustEngine } = await import('../../src/core/rust-engine.ts');
  const { operationsByName } = await import('../../src/core/operations.ts');
  const loaded = await loadRustEngineAddon();
  if (!loaded.ok) {
    console.error(`the Rust addon did not load: ${loaded.message}`);
    process.exit(2);
  }
  const engine = openRustEngine({ addon: loaded.addon, databasePath: brain });
  await engine.connect({ engine: 'rust', database_path: brain } as never);
  await engine.initSchema();
  const ctx = { engine, config: { engine: 'rust', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false, remote: false, sourceId: 'default' };
  const result = await operationsByName.put_page!.handler(ctx as never, { request_id: crypto.randomUUID(), slug: 'notes/release-check', force: true,
    content: '---\ntitle: Release check\n---\n# Release check\n\nThe release addon wrote this page.\n' }) as { status?: string };
  await engine.disconnect();
  console.log(`written ${result.status}`);
  process.exit(result.status === 'created_or_updated' ? 0 : 1);
}

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-rust-release-check-'));
const log = join(scratch, 'crash-points.log');
const child = Bun.spawn([process.execPath, import.meta.path, 'child', join(scratch, 'brain')], {
  env: { PATH: process.env.PATH ?? '', HOME: join(scratch, 'home'), TMPDIR: tmpdir(), GBRAIN_HOME: join(scratch, 'home'),
    GBRAIN_RUST_ENGINE_ADDON: resolve(addonPath), GBRAIN_TEST_RUST_CRASH_LOG: log, GBRAIN_TEST_RUST_CRASH_AT: 'write:1' },
  stdout: 'pipe', stderr: 'pipe',
});
const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
await child.exited;
clearTimeout(timer);
const problems: string[] = [];
if (child.exitCode !== 0) problems.push(`the write did not finish (exit ${child.exitCode}, signal ${child.signalCode}): the addon froze at a crash point or failed\n${stderr.slice(-600)}`);
if (!/written created_or_updated/.test(stdout)) problems.push(`the child did not report the write: ${stdout.slice(-300)}`);
if (existsSync(log)) problems.push(`the addon wrote the crash point log ${log}: it reads GBRAIN_TEST_RUST_CRASH_LOG`);
rmSync(scratch, { recursive: true, force: true });
if (problems.length > 0) {
  console.log(`FAIL  the addon at ${addonPath} acts on the crash cell's variables:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok    the addon at ${addonPath} ignores the crash cell's variables: the write finished and no log was written`);
process.exit(0);
