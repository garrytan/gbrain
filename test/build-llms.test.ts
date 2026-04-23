import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildLlmsFiles } from "../scripts/build-llms";
import { SECTIONS, FULL_SIZE_BUDGET } from "../scripts/llms-config";

const repoRoot = join(import.meta.dir, "..");

describe("build-llms generator", () => {
  // Case 1 — every config path resolves on disk. Catches rename-induced 404s.
  test("every configured path exists on disk", () => {
    for (const section of SECTIONS) {
      for (const entry of section.entries) {
        const abs = join(repoRoot, entry.path);
        expect(existsSync(abs), `missing: ${entry.path}`).toBe(true);

        const st = statSync(abs);
        if (entry.path.endsWith("/")) {
          expect(st.isDirectory(), `${entry.path} should be a directory`).toBe(true);
        } else {
          expect(st.isFile(), `${entry.path} should be a file`).toBe(true);
        }
      }
    }
  });

  // Case 2 — generator is idempotent. Run twice in-memory, compare byte-for-byte.
  test("generator output is deterministic across runs", () => {
    const first = buildLlmsFiles();
    const second = buildLlmsFiles();
    expect(second.llmsTxt).toBe(first.llmsTxt);
    expect(second.llmsFullTxt).toBe(first.llmsFullTxt);
  });

  // Case 3 — llms.txt spec shape per llmstxt.org: H1 + blockquote + required H2s.
  test("llms.txt follows llmstxt.org spec shape", () => {
    const { llmsTxt } = buildLlmsFiles();
    const lines = llmsTxt.split("\n");

    expect(lines[0], "first line must be H1").toBe("# GBrain");

    // Blockquote summary on line 2 or 3 (spec allows blank line after H1).
    const hasEarlyBlockquote =
      lines.slice(1, 4).some((line) => line.startsWith("> "));
    expect(hasEarlyBlockquote, "needs > blockquote summary near top").toBe(true);

    // Required H2 sections for GBrain's user need (config/debug/migration).
    expect(llmsTxt).toContain("## Core entry points");
    expect(llmsTxt).toContain("## Configuration");
    expect(llmsTxt).toContain("## Debugging");
    expect(llmsTxt).toContain("## Migrations");
  });

  // Case 4 — checked-in files match generator output. Catches "forgot to rerun
  // generator" before ship. If this fails in CI, run `bun run build:llms` and
  // commit the result.
  test("committed llms.txt + llms-full.txt match current generator output", () => {
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles();

    const committedLlms = readFileSync(join(repoRoot, "llms.txt"), "utf8");
    const committedFull = readFileSync(join(repoRoot, "llms-full.txt"), "utf8");

    const helpMsg =
      "Run `bun run build:llms` and commit the updated output before shipping.";
    expect(committedLlms, helpMsg).toBe(llmsTxt);
    expect(committedFull, helpMsg).toBe(llmsFullTxt);
  });

  // Case 5 — content contract. Prevents silent removal of critical sections or
  // entries from llms-config.ts. Catches "someone deleted the Debugging section."
  test("content contract: llms.txt references required entry points", () => {
    const { llmsTxt } = buildLlmsFiles();
    expect(llmsTxt).toContain("skills/RESOLVER.md");
    expect(llmsTxt).toContain("INSTALL_FOR_AGENTS.md");
    expect(llmsTxt).toContain("AGENTS.md");
    expect(llmsTxt).toContain("CLAUDE.md");
  });

  test("content contract: AGENTS.md mirrors README + INSTALL_FOR_AGENTS install path", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("CLAUDE.md");
    expect(agents).toContain("skills/RESOLVER.md");
    expect(agents).toContain("INSTALL_FOR_AGENTS.md");
    expect(agents).toContain("llms.txt");
    // Trust boundary is the non-obvious security concept agents need up-front.
    expect(agents.toLowerCase()).toContain("trust boundary");
  });

  test("llms-full.txt stays within size budget", () => {
    const { llmsFullTxt } = buildLlmsFiles();
    const bytes = Buffer.byteLength(llmsFullTxt, "utf8");
    expect(
      bytes,
      `llms-full.txt is ${bytes} bytes (budget ${FULL_SIZE_BUDGET}). Add includeInFull: false to large entries.`,
    ).toBeLessThan(FULL_SIZE_BUDGET);
  });
});
