/**
 * A second process that OWNS a Rust brain, for test/backup-rust-roundtrip.test.ts: `gbrain backup create` in the test
 * process then reaches the brain as a client of this owner. It answers one command per stdin line with `ok`:
 * `put <slug>` writes a page, `admit <uuid>` leaves a queued write request, `finish <uuid>` cancels it, `quit` exits.
 * Arguments: <addon path> <brain dir>.
 */
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import type { RustStore } from '../../src/core/rust-engine/store.ts';

const [addonPath, dir] = process.argv.slice(2) as [string, string];
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
const engine = openRustEngine({ addon, databasePath: dir });
await engine.connect({ engine: 'rust', database_path: dir } as never);
if (engine.ownerRole !== 'owner') throw new Error(`expected to own the brain, got ${engine.ownerRole}`);
const brain = (engine as unknown as { openStore(member: string): RustStore }).openStore('test').brain as unknown as { admitWrite(a: object): Promise<unknown>; finishWrite(p: object, id: string, f: object): Promise<unknown> };
const principal = { kind: 'local_cli', id: 'writer-1' };
process.stdout.write('ready\n');
const decoder = new TextDecoder();
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk);
  for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
    const [command, argument] = buffered.slice(0, at).split(' ');
    buffered = buffered.slice(at + 1);
    if (command === 'put') await engine.putPage(argument!, { type: 'note', title: argument!, compiled_truth: `written while a backup runs: ${argument}`, timeline: '' });
    else if (command === 'admit') await brain.admitWrite({ principal, operation: 'put_page', requestId: argument, slug: 'queued/x', callerIntent: {} });
    else if (command === 'finish') await brain.finishWrite(principal, argument!, { state: 'cancelled' });
    else if (command === 'quit') { await engine.disconnect(); process.exit(0); }
    process.stdout.write('ok\n');
  }
}
