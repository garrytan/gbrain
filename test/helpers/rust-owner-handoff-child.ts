/**
 * A separate process that owns a Rust brain (test helper for rust-owner-handoff.serial.test.ts).
 *
 *   bun test/helpers/rust-owner-handoff-child.ts <brain dir> <addon path>
 *
 * Multi-user Rust is turned on in this process's own environment before the engine opens (this is a plain script, so
 * no test preload strips it). It prints one JSON `ready` line with the store's own mode, then waits on stdin:
 * `exit` disconnects (a graceful owner exit: the handoff) and exits 0; the parent may also kill it (a crash).
 * `ran` lines name every logIngest the owner itself ran, so the parent can prove no write ran twice.
 */
process.env.GBRAIN_RUST_MULTIUSER = '1';
const [dir, addonPath] = process.argv.slice(2);
const { openRustEngine } = await import('../../src/core/rust-engine.ts');
const { loadRustAddon } = await import('../../src/core/rust-engine/addon-loader.ts');
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath! } });
const engine = openRustEngine({ addon: addon as never, databasePath: dir! });
await engine.connect({ engine: 'rust', database_path: dir } as never);
const record = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
const logIngest = record.logIngest!.bind(engine);
// Slow enough that calls queue behind each other on the writer while the owner exits.
record.logIngest = async (...args: unknown[]) => {
  await new Promise(r => setTimeout(r, 25));
  const out = await logIngest(...args);
  process.stdout.write(JSON.stringify({ t: 'ran', ref: (args[0] as { source_ref: string }).source_ref }) + '\n');
  return out;
};
process.stdout.write(JSON.stringify({ t: 'ready', pid: process.pid, role: engine.ownerRole, multiuser: engine.openStore('owner-child').multiuser,
  served: !!engine.ownerServer()?.attachServed }) + '\n');
let buffer = '';
process.stdin.on('data', async chunk => {
  buffer += String(chunk);
  if (!buffer.includes('exit')) return;
  await engine.disconnect();
  process.stdout.write(JSON.stringify({ t: 'exited' }) + '\n');
  process.exit(0);
});
export {};
