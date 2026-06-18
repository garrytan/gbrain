// Centralized registry of bundled schema packs — the SINGLE source of
// truth for "which packs ship inside the binary, and where to read them."
//
// THE COMPILE BUG THIS FIXES (v0.42.52): the bundled pack YAMLs were never
// embedded in `bun build --compile` binaries. The old locators resolved
// pack paths via `dirname(fileURLToPath(import.meta.url)) + existsSync`,
// which points at `/$bunfs/root/...` in a compiled binary where the YAML
// is NOT on disk → `gbrain schema active` => "unknown schema pack:
// gbrain-base", put_page silently degraded (skipped type validation +
// reverted to a hardcoded prefix table), and brain-taxonomist (a
// `gbrain schema show --json` wrapper) was neutered. Because the active
// pack (e.g. `jarvis-operational`) `extends: gbrain-base`, the bundled
// parent failing to load took the whole resolution down.
//
// FIX: import each pack YAML as a Bun file asset (`with { type: 'file' }`).
// Bun bundles the bytes INTO the compiled binary and the import evaluates
// to a path string — a real on-disk path under `bun run`, a readable
// `/$bunfs/...` path in the compiled binary — that `readFileSync` /
// `loadPackFromFile` can read. This mirrors the proven WASM-embedding
// pattern (src/core/chunkers/code.ts + scripts/check-wasm-embedded.sh).
//
// CONTRACT: every pack-load surface (active-pack load in load-active.ts,
// the CLI `schema show`/`validate`/`list`/`use`/`fork`/... in
// commands/schema.ts, the MCP `list_schema_packs` op, and the read-only
// mutability gate in mutate.ts) MUST route through this registry so that
// adding a pack here makes it bundled, listable, and read-only EVERYWHERE
// in one edit. Functional regression guard: scripts/check-packs-embedded.sh.

// @ts-ignore — `type: 'file'` is a Bun import attribute, not in lib.d.ts.
import GBRAIN_BASE from './base/gbrain-base.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_BASE_V2 from './base/gbrain-base-v2.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_RECOMMENDED from './base/gbrain-recommended.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_CREATOR from './base/gbrain-creator.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_INVESTOR from './base/gbrain-investor.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_ENGINEER from './base/gbrain-engineer.yaml' with { type: 'file' };
// @ts-ignore — Bun import attribute.
import GBRAIN_EVERYTHING from './base/gbrain-everything.yaml' with { type: 'file' };

/**
 * name → embedded asset path. Values are the runtime paths produced by the
 * `with { type: 'file' }` imports (readable in BOTH `bun run` and
 * `bun build --compile` binaries). Order matches BUNDLED_PACK_LIST.
 */
export const BUNDLED_PACK_PATHS: Readonly<Record<string, string>> = {
  'gbrain-base': GBRAIN_BASE,
  'gbrain-base-v2': GBRAIN_BASE_V2,
  'gbrain-recommended': GBRAIN_RECOMMENDED,
  'gbrain-creator': GBRAIN_CREATOR,
  'gbrain-investor': GBRAIN_INVESTOR,
  'gbrain-engineer': GBRAIN_ENGINEER,
  'gbrain-everything': GBRAIN_EVERYTHING,
};

/**
 * Ordered list of bundled pack names (stable display order: base, its v2
 * successor, recommended, then the three lens packs + the everything
 * meta-pack). `gbrain schema list` and MCP `list_schema_packs` render in
 * this order.
 */
export const BUNDLED_PACK_LIST: ReadonlyArray<string> = Object.freeze([
  'gbrain-base',
  'gbrain-base-v2',
  'gbrain-recommended',
  'gbrain-creator',
  'gbrain-investor',
  'gbrain-engineer',
  'gbrain-everything',
]);

/**
 * Bundled pack names as a Set. These ship inside the binary and are
 * READ-ONLY — edits would be lost on upgrade — so the mutability gate
 * (mutate.ts `locateMutablePackFile`) refuses to mutate any of them and
 * directs the user to `gbrain schema fork <name> <new-name>`.
 */
export const BUNDLED_PACK_NAMES: ReadonlySet<string> = new Set(BUNDLED_PACK_LIST);

/**
 * Resolve a bundled pack name to its embedded asset path, or null when the
 * name isn't bundled (caller falls back to ~/.gbrain/schema-packs/<name>).
 */
export function bundledPackPath(name: string): string | null {
  return BUNDLED_PACK_PATHS[name] ?? null;
}
