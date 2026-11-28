/**
 * Source guard for one switch answer (I-0, multiuser-switch.ts): multi-user mode is the environment switch OR the brain's
 * config row `engine.rust.multiuser`, and only a store that opened knows the second half. So every site that runs after
 * a store opens reads the resolved answer (`RustStore.multiuser`, `RustEngine.brainMultiuser`, brainMultiuserOf, or
 * rustMultiuserOfOwner from the owner's hello), never the environment switch alone.
 *
 * The environment-only reads that remain are named here, each with the reason it cannot read the store. A new
 * `rustMultiuserFromEnv(` call or a direct read of `GBRAIN_RUST_MULTIUSER` in src/ fails this test until it reads the
 * resolved answer or is added here with its reason.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
/** `rustMultiuserFromEnv(` calls and direct reads of the variable (`.GBRAIN_RUST_MULTIUSER`, `['GBRAIN_RUST_MULTIUSER']`, `[RUST_MULTIUSER_ENV]`). */
const READ = /\brustMultiuserFromEnv\(|\.GBRAIN_RUST_MULTIUSER\b|\[\s*['"]GBRAIN_RUST_MULTIUSER['"]\s*\]|\[\s*RUST_MULTIUSER_ENV\s*\]/g;

/** Each file that keeps an environment-only read, how many, and why it cannot read the store's answer. */
const ALLOWED: Record<string, { reads: number; why: string }> = {
  'src/core/rust-engine/multiuser-switch.ts': { reads: 4, why: 'the definition; rustMultiuserOfOwner: the owner\'s hello answer, or this process\'s own switch; rustMultiuserOfBrain: the environment half, OR the brain\'s config row read through its open engine (the engine swap, whose destination store is not open)' },
  'src/core/rust-engine/store.ts': { reads: 1, why: 'the environment half sent to the store open; the store adds its own config row and reports the answer' },
  'src/core/rust-engine.ts': { reads: 1, why: 'the host id is minted before the open; a brain on by its config row mints it on the store\'s HOST_ID_REQUIRED answer' },
  'src/core/rust-engine/access-self-check.ts': { reads: 1, why: 'storeMultiuser: the fallback for a store that reports no answer of its own' },
  'src/core/rust-engine/owner-ipc/remote-check.ts': { reads: 1, why: 'ownerRemoteCheckOn: the fallback for an owner with no store open' },
  'src/core/rust-engine/served/serve-listen.ts': { reads: 2, why: 'storeMode with no store, and the listen variable for an engine with no answer of its own (not Rust), which startRustListen refuses' },
  'src/core/rust-engine/served/engine.ts': { reads: 1, why: 'servedTargetFor: a served client holds no store; the config row lives in the server\'s store' },
  'src/commands/auth-rust-server-owner.ts': { reads: 1, why: 'the fallback when no store is open' },
  'src/core/engine-capabilities.ts': { reads: 1, why: 'the SQL engines (PGLite, Postgres) have no Rust store and no Rust config row' },
};

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
    .map(e => join(e.parentPath, e.name));
}

describe('environment-only reads of the multi-user switch', () => {
  test('appear only in the named files, each with its reason', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(SRC)) {
      // test-reads-source-ok[structural]: a source-text tripwire by design: a new environment-only switch read must read the store's answer or be named here.
      const reads = (strip(readFileSync(file, 'utf8')).match(READ) ?? []).length;
      if (reads > 0) found[relative(ROOT, file)] = reads;
    }
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([file, { reads }]) => [file, reads]));
    expect(found).toEqual(allowed);
  });

  test('every named file gives a reason', () => {
    for (const [file, { why }] of Object.entries(ALLOWED)) expect({ file, why: why.length > 10 }).toEqual({ file, why: true });
  });

  test('the pattern matches each read shape and not a name listed as data', () => {
    const count = (s: string) => (s.match(READ) ?? []).length;
    expect(count('if (rustMultiuserFromEnv()) x();')).toBe(1);
    expect(count("process.env.GBRAIN_RUST_MULTIUSER === '1'")).toBe(1);
    expect(count("env['GBRAIN_RUST_MULTIUSER']")).toBe(1);
    expect(count('env[RUST_MULTIUSER_ENV]')).toBe(1);
    expect(count("const NAMES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_HOME'];")).toBe(0);
  });
});
