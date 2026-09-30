/**
 * Structural guard: the cwd-.env quarantine list cannot silently rot.
 *
 * Every `process.env.GBRAIN_*` / `Bun.env.GBRAIN_*` / `env.GBRAIN_*` read in src/ whose NAME looks
 * like a code-loading, exec-target, root-redirect, endpoint-redirect or
 * posture-widening knob (`_BIN`, `_CLI`, `_MODULE`, `_PATH`, `_HOME`, `_URL`
 * suffix or `GBRAIN_ALLOW_` prefix) must either be in CWD_DOTENV_PROTECTED_KEYS
 * or carry a `cwd-dotenv-ok: <why>` annotation on the same or the previous line.
 * Adding a new such variable without deciding its cwd-.env posture fails here.
 * (`_URL` — review cycle 3: a cwd .env retargeting GBRAIN_DATABASE_URL or the
 * OAuth relay is endpoint redirection with the operator's credentials attached.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CWD_DOTENV_PROTECTED_KEYS } from '../src/core/env-trust.ts';

const SRC_ROOT = join(import.meta.dir, '..', 'src');
const SUSPICIOUS_NAME = /_BIN$|_CLI$|_MODULE$|_PATH$|_URL$|^GBRAIN_ALLOW_|_HOME$/;
const READ_SITE = /(?:process\.env|Bun\.env|\benv)(?:\.(GBRAIN_[A-Z0-9_]+)|\[['"](GBRAIN_[A-Z0-9_]+)['"]\])/g;
const OK_MARKER = 'cwd-dotenv-ok:';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

describe('CWD_DOTENV_PROTECTED_KEYS covers every suspicious GBRAIN_* env read in src/', () => {
  test('scanner self-test: a Bun.env read of a suspicious name is flagged', () => {
    const hits = [...'const b = Bun.env.GBRAIN_FAKE_BIN; const p = process.env["GBRAIN_FAKE_MODULE"];'.matchAll(READ_SITE)]
      .map((m) => m[1] ?? m[2]!);
    expect(hits).toEqual(['GBRAIN_FAKE_BIN', 'GBRAIN_FAKE_MODULE']);
    for (const h of hits) expect(SUSPICIOUS_NAME.test(h)).toBe(true);
    expect(SUSPICIOUS_NAME.test('GBRAIN_DATABASE_URL')).toBe(true);
    expect(SUSPICIOUS_NAME.test('GBRAIN_OAUTH_RELAY_URL')).toBe(true);
    expect(SUSPICIOUS_NAME.test('GBRAIN_SOURCE')).toBe(false);
  });

  test('list is non-empty and de-duplicated', () => {
    expect(CWD_DOTENV_PROTECTED_KEYS.length).toBeGreaterThan(10);
    expect(new Set(CWD_DOTENV_PROTECTED_KEYS).size).toBe(CWD_DOTENV_PROTECTED_KEYS.length);
  });

  test('each suspicious read is protected or annotated', () => {
    const protectedSet = new Set<string>(CWD_DOTENV_PROTECTED_KEYS);
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walk(SRC_ROOT)) {
      const lines = readFileSync(file, 'utf-8').split('\n'); // every `file` lives under 'src/' (walk(SRC_ROOT))
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const m of line.matchAll(READ_SITE)) {
          const name = m[1] ?? m[2]!;
          if (!SUSPICIOUS_NAME.test(name)) continue;
          scanned++;
          if (protectedSet.has(name)) continue;
          const prev = i > 0 ? lines[i - 1]! : '';
          if (line.includes(OK_MARKER) || prev.includes(OK_MARKER)) continue;
          offenders.push(`${relative(SRC_ROOT, file)}:${i + 1} reads ${name}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(5); // the scanner itself must be finding the known sites
    expect(offenders).toEqual([]);
  });
});
