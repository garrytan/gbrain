/**
 * A second process on a Rust brain, for test/rust-engine-store-snapshot.test.ts: it joins the brain's owner as a client, sends
 * the `snapshotStore` whole operation, tells its parent the request is out, and waits. The test kills it mid-copy.
 * Arguments: <addon path> <brain dir> <target> <op id> <batch delay ms> <batch bytes>.
 */
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { forwardWholeOperation } from '../../src/core/rust-engine/owner-ipc/whole-op.ts';

const [addonPath, dir, target, opId, delay, bytes] = process.argv.slice(2) as [string, string, string, string, string, string];
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
const engine = openRustEngine({ addon, databasePath: dir });
await engine.connect({ engine: 'pglite', database_path: dir } as never);
const sent = forwardWholeOperation(engine, 'snapshotStore', [target, { opId, batchDelayMs: Number(delay), batchBytes: Number(bytes) }]);
if (!sent) throw new Error('this process did not become a client of the owner');
process.stdout.write('sent\n');
await sent.then(() => process.stdout.write('done\n'), (error: Error) => process.stdout.write(`failed ${(error as { code?: string }).code}\n`));
await engine.disconnect();
