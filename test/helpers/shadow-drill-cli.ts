/**
 * The drill CLI half as a child process, for test/shadow-drill-addon.test.ts: runs one drill and prints its record as JSON.
 * The test kills it mid-copy. Arguments: <addon path> <shadow dir> <batch delay ms> <batch bytes>.
 */
import { loadRustEngineAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { runBackupDrill } from '../../src/shadow/drill.ts';

const [addonPath, dir, delay, bytes] = process.argv.slice(2) as [string, string, string, string];
process.env.GBRAIN_RUST_ENGINE_ADDON = addonPath; // the digest the drill checks against the epoch is of this file
const record = await runBackupDrill(dir, {
  loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } }),
  snapshotOptions: { batchDelayMs: Number(delay), batchBytes: Number(bytes) },
});
process.stdout.write(`${JSON.stringify(record)}\n`);
process.exit(0);
