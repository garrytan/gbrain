#!/usr/bin/env bun
/**
 * build-llms — generate llms.txt + llms-full.txt from scripts/llms-config.ts.
 *
 * Run: `bun run build:llms` (or `bun run scripts/build-llms.ts`).
 *
 * Outputs:
 *   - llms.txt       — llmstxt.org-spec index (H1 / blockquote / H2 sections).
 *   - llms-full.txt  — concatenated full content of non-optional entries.
 *
 * Deterministic: no timestamps, sorted within categories by config order.
 * Warns (does not fail) if llms-full.txt exceeds FULL_SIZE_BUDGET. CI catches
 * drift via test/build-llms.test.ts.
 *
 * Fork override: set LLMS_REPO_BASE to regenerate with a different URL base.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FULL_SIZE_BUDGET,
  INLINE_TIPS,
  PROJECT,
  SECTIONS,
  type DocEntry,
  type DocSection,
} from "./llms-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function urlFor(entry: DocEntry): string {
  return `${PROJECT.rawBaseUrl}/${entry.path}`;
}

function isDirectoryPath(path: string): boolean {
  return path.endsWith("/");
}

function renderLlmsTxt(): string {
  const lines: string[] = [];
  lines.push(`# ${PROJECT.name}`);
  lines.push("");
  lines.push(`> ${PROJECT.summary}`);
  lines.push("");
  lines.push(`Repo: ${PROJECT.repoUrl}`);
  lines.push("");

  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`);
    lines.push("");
    for (const entry of section.entries) {
      lines.push(
        `- [${entry.title}](${urlFor(entry)}): ${entry.description}`,
      );
    }
    lines.push("");
  }

  lines.push("## Operational tips");
  lines.push("");
  for (const tip of INLINE_TIPS) {
    lines.push(`- ${tip}`);
  }
  lines.push("");

  return lines.join("\n");
}

function renderLlmsFullTxt(): { content: string; sizes: Array<{ path: string; bytes: number }> } {
  const lines: string[] = [];
  const sizes: Array<{ path: string; bytes: number }> = [];

  lines.push(`# ${PROJECT.name} — Full Context`);
  lines.push("");
  lines.push(`> ${PROJECT.summary}`);
  lines.push("");
  lines.push(
    `This file concatenates core GBrain documentation for single-fetch ingestion.`,
  );
  lines.push(
    `For the link-only index, see \`llms.txt\`. Source of truth: ${PROJECT.repoUrl}.`,
  );
  lines.push("");

  for (const section of SECTIONS) {
    if (section.optional) continue;
    lines.push(`# ${section.heading}`);
    lines.push("");
    for (const entry of section.entries) {
      if (entry.includeInFull === false) continue;
      if (isDirectoryPath(entry.path)) continue;

      const absPath = join(repoRoot, entry.path);
      if (!existsSync(absPath)) {
        // build-llms won't silently skip — surface the problem. Test case 1
        // catches this too, but fail fast for manual runs.
        throw new Error(
          `llms-config references missing file: ${entry.path}`,
        );
      }

      const body = readFileSync(absPath, "utf8");
      const bytes = Buffer.byteLength(body, "utf8");
      sizes.push({ path: entry.path, bytes });

      lines.push(`## ${entry.path}`);
      lines.push("");
      lines.push(`Source: ${urlFor(entry)}`);
      lines.push("");
      lines.push(body.trimEnd());
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return { content: lines.join("\n"), sizes };
}

function validateConfig(): void {
  for (const section of SECTIONS) {
    for (const entry of section.entries) {
      const absPath = join(repoRoot, entry.path);
      if (!existsSync(absPath)) {
        throw new Error(
          `llms-config references missing path: ${entry.path}`,
        );
      }
      const st = statSync(absPath);
      if (isDirectoryPath(entry.path) && !st.isDirectory()) {
        throw new Error(
          `llms-config path ends with '/' but is a file: ${entry.path}`,
        );
      }
      if (!isDirectoryPath(entry.path) && !st.isFile()) {
        throw new Error(
          `llms-config path is a directory but missing trailing '/': ${entry.path}`,
        );
      }
    }
  }
}

export function buildLlmsFiles(): {
  llmsTxt: string;
  llmsFullTxt: string;
  sizes: Array<{ path: string; bytes: number }>;
} {
  validateConfig();
  const llmsTxt = renderLlmsTxt();
  const { content: llmsFullTxt, sizes } = renderLlmsFullTxt();
  return { llmsTxt, llmsFullTxt, sizes };
}

function main(): void {
  const { llmsTxt, llmsFullTxt, sizes } = buildLlmsFiles();

  const llmsPath = join(repoRoot, "llms.txt");
  const llmsFullPath = join(repoRoot, "llms-full.txt");

  writeFileSync(llmsPath, llmsTxt);
  writeFileSync(llmsFullPath, llmsFullTxt);

  const fullBytes = Buffer.byteLength(llmsFullTxt, "utf8");
  console.log(`wrote ${llmsPath} (${Buffer.byteLength(llmsTxt, "utf8")} bytes)`);
  console.log(`wrote ${llmsFullPath} (${fullBytes} bytes)`);

  if (fullBytes > FULL_SIZE_BUDGET) {
    console.warn("");
    console.warn(
      `WARN: llms-full.txt (${fullBytes} bytes) exceeds FULL_SIZE_BUDGET (${FULL_SIZE_BUDGET} bytes).`,
    );
    console.warn(
      "Add `includeInFull: false` to the biggest entries in scripts/llms-config.ts:",
    );
    const sorted = [...sizes].sort((a, b) => b.bytes - a.bytes);
    for (const entry of sorted.slice(0, 5)) {
      console.warn(`  ${entry.bytes} bytes  ${entry.path}`);
    }
  }
}

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
