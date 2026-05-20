#!/usr/bin/env bun
/**
 * image-ingest/run.ts — daily image-import wrapper for v0.36.6.0 cross-modal
 * search. Calls `gbrain import <IMAGE_SOURCE_DIR>` with `GBRAIN_EMBEDDING_MULTIMODAL=true`
 * so gbrain's walker dispatches recognized image extensions through
 * importImageFile + Voyage multimodal-3 (1024d embedding_multimodal column).
 *
 * Contract:
 *   - Pre-flight env checks: VOYAGE_API_KEY, IMAGE_SOURCE_DIR, dir readable
 *   - Spawn gbrain import --json, capture stdout
 *   - Archive result to ~/brain/.agent/image-ingest/<ISO>.json
 *   - Update latest.json symlink atomically
 *   - Exit 0 on clean import, 1 on some failures, 2 on wrapper-level error
 *
 * Usage:
 *   bun run skills/kos-jarvis/image-ingest/run.ts            # full ingest
 *   bun run skills/kos-jarvis/image-ingest/run.ts --dry-run  # walker preview
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BIN = resolve(REPO_ROOT, "bin", "gbrain");
const BRAIN_AGENT_DIR = join(homedir(), "brain", ".agent");
const ARCHIVE_DIR = join(BRAIN_AGENT_DIR, "image-ingest");

interface ImportJsonOutput {
  status: string;
  duration_s: number;
  imported: number;
  skipped: number;
  errors: number;
  chunks: number;
  total_files: number;
}

interface IngestArchive {
  iso: string;
  source_dir: string;
  exit_code: number;
  duration_ms: number;
  import_result: ImportJsonOutput | null;
  est_cost_usd: number;
  raw_stdout_tail: string;
  raw_stderr_tail: string;
}

// Voyage multimodal-3 pricing model (2026-05-19): $0.05 / 1M tokens.
// Per-image typical: ~500 tokens (image patches + caption tokenization).
const TOKENS_PER_IMAGE_EST = 500;
const VOYAGE_USD_PER_1M_TOKENS = 0.05;

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function tail(text: string, lines = 30): string {
  const arr = text.split("\n");
  return arr.slice(-lines).join("\n");
}

function exitWrapperError(msg: string): never {
  console.error(`[image-ingest] WRAPPER ERROR: ${msg}`);
  process.exit(2);
}

function preflightChecks(): { sourceDir: string; dryRun: boolean } {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.VOYAGE_API_KEY) {
    exitWrapperError(
      "VOYAGE_API_KEY env var not set. Register at https://www.voyageai.com and add to plist EnvironmentVariables.",
    );
  }
  if (process.env.GBRAIN_EMBEDDING_MULTIMODAL !== "true") {
    exitWrapperError(
      "GBRAIN_EMBEDDING_MULTIMODAL must be 'true' (set in plist EnvironmentVariables).",
    );
  }

  const rawDir = process.env.IMAGE_SOURCE_DIR;
  if (!rawDir) {
    exitWrapperError(
      "IMAGE_SOURCE_DIR env var not set. Add absolute path to plist EnvironmentVariables.",
    );
  }
  const sourceDir = resolve(rawDir);
  if (!existsSync(sourceDir)) {
    exitWrapperError(`IMAGE_SOURCE_DIR does not exist: ${sourceDir}`);
  }
  if (!statSync(sourceDir).isDirectory()) {
    exitWrapperError(`IMAGE_SOURCE_DIR is not a directory: ${sourceDir}`);
  }
  if (!existsSync(BIN)) {
    exitWrapperError(`gbrain binary missing at ${BIN}. Run 'bun run build' first.`);
  }

  return { sourceDir, dryRun };
}

function parseImportJson(stdout: string): ImportJsonOutput | null {
  // gbrain import --json emits exactly one final JSON line on stdout
  // (src/commands/import.ts:285). Progress lines go to stderr.
  const lastLine = stdout.trim().split("\n").pop()?.trim();
  if (!lastLine || !lastLine.startsWith("{")) return null;
  const obj = JSON.parse(lastLine) as ImportJsonOutput;
  return obj;
}

function archive(result: IngestArchive): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const path = join(ARCHIVE_DIR, `${result.iso}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2), "utf8");

  // Atomic latest.json symlink swap
  const latest = join(ARCHIVE_DIR, "latest.json");
  const latestTmp = join(ARCHIVE_DIR, "latest.json.tmp");
  try {
    if (existsSync(latestTmp)) unlinkSync(latestTmp);
    symlinkSync(`${result.iso}.json`, latestTmp);
    renameSync(latestTmp, latest);
  } catch (e) {
    console.error(`[image-ingest] symlink swap warn: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  const { sourceDir, dryRun } = preflightChecks();
  const startMs = Date.now();
  const iso = isoStamp();

  const args = ["import", sourceDir, "--json"];
  if (dryRun) args.push("--no-embed"); // closest to dry-run: import metadata, skip embeddings

  console.error(
    `[image-ingest] starting: source=${sourceDir} dryRun=${dryRun} iso=${iso}`,
  );

  const proc = spawnSync(BIN, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 30 * 60 * 1000, // 30 min cap
  });

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  process.stderr.write(stderr); // forward for launchd capture

  const importResult = parseImportJson(stdout);
  const estCost = importResult
    ? (importResult.imported * TOKENS_PER_IMAGE_EST * VOYAGE_USD_PER_1M_TOKENS) / 1_000_000
    : 0;

  const result: IngestArchive = {
    iso,
    source_dir: sourceDir,
    exit_code: proc.status ?? -1,
    duration_ms: Date.now() - startMs,
    import_result: importResult,
    est_cost_usd: estCost,
    raw_stdout_tail: tail(stdout, 30),
    raw_stderr_tail: tail(stderr, 30),
  };

  archive(result);

  const summary = importResult
    ? `imported=${importResult.imported} skipped=${importResult.skipped} errors=${importResult.errors} chunks=${importResult.chunks}`
    : `(no --json payload found in stdout)`;
  console.error(
    `[image-ingest] done: ${summary} est_cost=$${estCost.toFixed(4)} duration_ms=${result.duration_ms}`,
  );

  if (proc.status !== 0) process.exit(1);
  if (importResult && importResult.errors > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => exitWrapperError(`unexpected: ${String(e)}`));
