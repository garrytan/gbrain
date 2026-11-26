/**
 * The shadow's Rust owner, as a child process, for test/shadow-drill-addon.test.ts: it opens the store `<shadow dir>/store`
 * (becoming its owner), writes pages, prints `ready <n>`, keeps writing a page every 25 ms (the shadow follower keeps
 * applying while a drill runs) and, when its stdin gets a line, prints `stopped <total>` and exits.
 * Arguments: <addon path> <shadow dir>.
 */
import { createInterface } from 'node:readline';
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';

const [addonPath, shadowDir] = process.argv.slice(2) as [string, string];
const store = `${shadowDir}/store`;
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
const engine = openRustEngine({ addon, databasePath: store });
await engine.connect({ database_path: store } as never);
/** A page with one chunk, as the shadow's follower writes them, so the keyword index has something to search. */
async function page(n: number): Promise<void> {
  const slug = `notes/p${n}`;
  const text = `Body ${n} about harbor lanterns. ${'filler '.repeat(40)}`;
  await engine.putPage(slug, { type: 'note', title: `Drill page ${n}`, compiled_truth: text, timeline: '' });
  await engine.sealChunks(slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
}
let total = 0;
for (; total < 60; total++) await page(total);
process.stdout.write(`ready ${total}\n`);
let stopping = false;
createInterface({ input: process.stdin }).once('line', () => { stopping = true; });
while (!stopping) { await page(total++); await new Promise(done => setTimeout(done, 25)); }
process.stdout.write(`stopped ${total}\n`);
await engine.disconnect();
