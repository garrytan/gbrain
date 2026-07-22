/**
 * check-key-files-current-state.test.ts — coverage of the anti-disease guard.
 *
 * The guard is the structural backstop that keeps CLAUDE.md from re-bloating:
 * it bans bolded `**v0.<digit>` release markers in the reference docs and caps
 * CLAUDE.md size. If the guard is broken, the append-only-history disease can
 * silently return. This suite pins its contract against fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts/check-key-files-current-state.sh");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doc-guard-"));
  mkdirSync(join(root, "docs/architecture"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeDoc(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function run(extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, GBRAIN_DOC_GUARD_ROOT: root, ...extraEnv },
  });
}

// A minimal clean repo shape the guard is happy with.
function seedClean() {
  writeDoc("CLAUDE.md", "# CLAUDE.md\n\norientation only\n");
  writeDoc(
    "docs/architecture/KEY_FILES.md",
    "# Key files\n\n- `src/core/db.ts` — connection management. Pinned by `test/db.test.ts`.\n",
  );
  writeDoc("docs/architecture/thin-client.md", "# Thin-client\n\nrouting seam\n");
  writeDoc("docs/TESTING.md", "# Testing\n\ntiers\n");
}

describe("check-key-files-current-state.sh", () => {
  it("passes on a clean current-state repo", () => {
    seedClean();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("FAILS when a reference doc carries a bolded release-clause marker", () => {
    seedClean();
    writeDoc(
      "docs/architecture/KEY_FILES.md",
      "# Key files\n\n- `src/core/db.ts` — connection mgmt. **v0.41.2 (#9):** added pool reconnect.\n",
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bolded release-clause");
    expect(r.stderr).toContain("KEY_FILES.md");
  });

  it("PASSES on a legitimate non-bolded version mention (no false positive)", () => {
    seedClean();
    writeDoc(
      "docs/architecture/KEY_FILES.md",
      "# Key files\n\n- `src/core/db.ts` — requires pgvector 0.7; on Postgres 11+ the ADD COLUMN is metadata-only.\n",
    );
    const r = run();
    expect(r.status).toBe(0);
  });

  it("FAILS when CLAUDE.md exceeds the size cap", () => {
    seedClean();
    writeDoc("CLAUDE.md", "x".repeat(200_000));
    const r = run({ GBRAIN_CLAUDE_MD_MAX_BYTES: "90000" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("over the");
  });

  it("size cap is configurable via env", () => {
    seedClean();
    writeDoc("CLAUDE.md", "x".repeat(5_000));
    expect(run({ GBRAIN_CLAUDE_MD_MAX_BYTES: "1000" }).status).toBe(1);
    expect(run({ GBRAIN_CLAUDE_MD_MAX_BYTES: "10000" }).status).toBe(0);
  });

  it("soft-warns (non-fatal) on prose history markers", () => {
    seedClean();
    writeDoc(
      "docs/TESTING.md",
      "# Testing\n\nThe tier set, then v0.26.7 added the parallel loop (pre-fix it was serial).\n",
    );
    const r = run();
    expect(r.status).toBe(0); // warn, not fail
    expect(r.stderr).toContain("WARN");
  });

  it("catches the marker in any of the three reference docs (thin-client)", () => {
    seedClean();
    writeDoc("docs/architecture/thin-client.md", "# Thin-client\n\n**v0.36.3:** added cross-modal.\n");
    expect(run().status).toBe(1);
  });
});
