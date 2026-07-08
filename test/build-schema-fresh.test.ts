/**
 * Freshness guard for the auto-generated schema blob.
 *
 * `src/core/schema-embedded.ts` is generated from `src/schema.sql` by
 * `scripts/build-schema.sh` (`bun run build:schema`). The compiled binary
 * embeds this blob, so a stale copy ships an old schema to every PGLite
 * install. There was NO test pinning the committed blob to a fresh
 * regeneration, so real drift sat undetected: a v114 `link_source`
 * provenance rewrite in `schema.sql` was never regenerated into the blob
 * and only got synced incidentally during an unrelated change.
 *
 * Mirrors the `test/build-llms.test.ts` discipline (regenerate in a
 * sandbox, byte-compare against the committed file) so "forgot to rerun
 * the generator" is caught before review — and the
 * `test/privacy-script-wired.test.ts` discipline for proving the verify
 * dispatcher still fires the matching shell guard.
 *
 * Single source of truth: this test runs THE REAL `scripts/build-schema.sh`
 * (pointed at a temp `OUT_FILE`) rather than reimplementing the sed escaping,
 * so the test and the generator can never drift apart.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMMITTED = join(REPO_ROOT, "src/core/schema-embedded.ts");
const VERIFY_DISPATCHER = join(REPO_ROOT, "scripts/run-verify-parallel.sh");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");

const REGEN_HINT =
  "src/core/schema-embedded.ts is stale vs src/schema.sql. " +
  "Run `bun run build:schema` and commit the regenerated blob.";

const scratch = mkdtempSync(join(tmpdir(), "gbrain-schema-fresh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
/** Run the real generator into a fresh temp file; return its bytes. */
function generate(): string {
  const out = join(scratch, `schema-embedded-${seq++}.ts`);
  const r = spawnSync("bash", ["scripts/build-schema.sh"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Pin SCHEMA_FILE to the canonical source so an inherited SCHEMA_FILE env
    // var can't redirect the freshness/determinism comparison off the real
    // schema. Use the RELATIVE path (build-schema.sh cd's to the repo root) so
    // the embedded `// Source:` line matches the committed blob. The escaping
    // test below sets its own fixture SCHEMA_FILE.
    env: { ...process.env, SCHEMA_FILE: "src/schema.sql", OUT_FILE: out },
  });
  expect(r.status, `build-schema.sh failed: ${r.stderr ?? ""}`).toBe(0);
  return readFileSync(out, "utf8");
}

describe("build-schema generator freshness", () => {
  // Core guard — the committed blob must equal a fresh regeneration. If this
  // fails in CI, run `bun run build:schema` and commit the result.
  test("committed schema-embedded.ts matches fresh build:schema output", () => {
    const fresh = generate();
    const committed = readFileSync(COMMITTED, "utf8");
    expect(committed, REGEN_HINT).toBe(fresh);
  });

  // The generator is a pure function of schema.sql — two runs must be
  // byte-identical, else the freshness guard would flap.
  test("generator output is deterministic across runs", () => {
    expect(generate()).toBe(generate());
  });

  // Sanity — the committed file carries the do-not-edit header. Catches a
  // hand-edit that happens to match a stale generation but loses the banner.
  test("committed blob keeps the AUTO-GENERATED header", () => {
    const committed = readFileSync(COMMITTED, "utf8");
    expect(committed.startsWith("// AUTO-GENERATED")).toBe(true);
    expect(committed).toContain("Run: bun run build:schema");
    expect(committed).toContain("export const SCHEMA_SQL");
  });

  // Exercises the SCHEMA_FILE override (otherwise an unused knob) AND pins the
  // template-literal escaping in build-schema.sh — backtick → \` and $ → \$ —
  // which is what keeps the generated TS valid. Previously this escaping was
  // covered only indirectly via whatever happened to be in the real schema.
  test("SCHEMA_FILE override regenerates + escapes backtick/dollar for template-literal safety", () => {
    const fixtureSql = join(scratch, "fixture-schema.sql");
    writeFileSync(fixtureSql, "SELECT `x`, '$y', ${z};\n");
    const out = join(scratch, "fixture-embedded.ts");
    const r = spawnSync("bash", ["scripts/build-schema.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, SCHEMA_FILE: fixtureSql, OUT_FILE: out },
    });
    expect(r.status, `build-schema.sh failed: ${r.stderr ?? ""}`).toBe(0);
    const generated = readFileSync(out, "utf8");
    expect(generated).toContain("export const SCHEMA_SQL");
    expect(generated).toContain("\\`x\\`"); // backtick escaped
    expect(generated).toContain("\\$y"); // bare dollar escaped
    expect(generated).toContain("\\${z}"); // dollar-brace escaped (no interpolation)
  });
});

describe("build-schema verify wiring", () => {
  // The unit suite catches drift, but only `bun run verify` runs on the fast
  // pre-push path. Prove the matching shell guard stays in the dispatcher so
  // verify isn't blind to schema drift (the exact gap that bit build-llms).
  test("run-verify-parallel.sh dispatches check:schema-embedded", () => {
    const r = spawnSync("bash", [VERIFY_DISPATCHER, "--dry-list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const checks = r.stdout.trim().split("\n");
    expect(checks).toContain("check:schema-embedded");
  });

  test('package.json "check:schema-embedded" points at the freshness script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    expect(pkg.scripts?.["check:schema-embedded"]).toContain(
      "check-schema-embedded-fresh.sh",
    );
  });

  // Follow the indirection the way privacy-script-wired.test.ts does: it is not
  // enough that the dispatcher LISTS the check — `verify` must delegate to the
  // dispatcher and CI must run `verify`, or the guard silently leaves the
  // pre-push/CI path while --dry-list keeps passing.
  test('package.json "verify" delegates to the parallel dispatcher', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    expect(pkg.scripts?.verify).toContain("run-verify-parallel.sh");
  });

  test("CI test.yml runs `bun run verify` so the schema guard fires in CI", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/test.yml"), "utf8");
    expect(yml).toContain("bun run verify");
  });

  test("scripts/check-schema-embedded-fresh.sh exists and is executable", () => {
    const script = join(REPO_ROOT, "scripts/check-schema-embedded-fresh.sh");
    const st = statSync(script);
    // eslint-disable-next-line no-bitwise
    expect((st.mode & 0o100) !== 0).toBe(true);
  });

  // Exercise the shell guard's own success path — it is the artifact CI runs on
  // the verify lane, so a regression in IT (broken diff, swallowed exit code)
  // must fail here, not just the in-process generate/compare above.
  test("check-schema-embedded-fresh.sh exits 0 on the committed (fresh) tree", () => {
    const r = spawnSync("bash", ["scripts/check-schema-embedded-fresh.sh"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr ?? "").toBe(0);
    expect(r.stdout).toContain("fresh");
  });
});
