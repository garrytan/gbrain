#!/usr/bin/env bun
/**
 * Writes (or checks) rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json, the fixture the
 * Rust fact-fingerprint ports are tested against (trust/fingerprint.rs and facts.rs, test module
 * `fingerprint_corpus`).
 *
 * Every answer in the file comes from PGLite, never from the Rust code under test: a fresh in-memory
 * brain of the repository's own PGLite (the engine a Rust brain replaces) runs the corpus in
 * rust/scripts/lib/fact-fingerprint-corpus.ts through the installed `gbrain_fact_normalize`,
 * `gbrain_fact_fingerprint` and `gbrain_fact_fingerprint_v1`, and reads `lower()` and the
 * `[[:space:]]` class for every code point.
 *
 * test/fact-fingerprint-corpus.test.ts recomputes the same file on PGLite in every test run and fails
 * when it differs, so a stale fixture cannot pass CI.
 *
 * Usage (from the repository root):
 *   bun rust/scripts/fact-fingerprint-fixture.ts           # check: exit 1 on any difference
 *   bun rust/scripts/fact-fingerprint-fixture.ts --write   # rewrite the fixture
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildFingerprintFixture, renderFingerprintFixture } from './lib/fact-fingerprint-corpus.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FINGERPRINT_FIXTURE_PATH = resolve(here, '../crates/gbrain-store/tests/fixtures/fact_fingerprints.json');

if (import.meta.main) {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const fresh = renderFingerprintFixture(await buildFingerprintFixture(engine));
    if (process.argv.includes('--write')) {
      writeFileSync(FINGERPRINT_FIXTURE_PATH, fresh);
      console.log(`wrote ${FINGERPRINT_FIXTURE_PATH} (${fresh.length} bytes)`);
    } else {
      const committed = readFileSync(FINGERPRINT_FIXTURE_PATH, 'utf8');
      if (committed !== fresh) {
        console.error(`${join('rust/crates/gbrain-store/tests/fixtures', 'fact_fingerprints.json')} differs from PGLite; rerun with --write and review the diff`);
        process.exit(1);
      }
      console.log('fact_fingerprints.json matches PGLite');
    }
  } finally {
    await engine.disconnect();
  }
}
