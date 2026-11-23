/**
 * A fresh process on a restored Rust brain, for test/backup-rust-roundtrip.test.ts: opens it the normal way and prints
 * what it reads as JSON. Arguments: <addon path> <brain dir> <slug> <search words>.
 */
import { loadRustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';

const [addonPath, dir, slug, words] = process.argv.slice(2) as [string, string, string, string];
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: addonPath } });
const engine = openRustEngine({ addon, databasePath: dir });
await engine.connect({ engine: 'rust', database_path: dir } as never);
try {
  const page = await engine.getPage(slug);
  const hits = await engine.searchKeyword(words, { limit: 5 });
  process.stdout.write(JSON.stringify({ title: page?.title ?? null, hits: hits.map(h => h.slug), role: engine.ownerRole }) + '\n');
} finally { await engine.disconnect(); }
