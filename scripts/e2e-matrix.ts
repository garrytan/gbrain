#!/usr/bin/env bun
// Freeze selection before setup; workers execute exactly the supplied argv.
// selector -> exclusions -> weighted matrix -> isolated sequential workers
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { loadWeights, partition, type WeightMap } from "./sharding.ts";

// PR owner of the reconciliation crash suites is persistence-validation.yml
// (called from test.yml on every PR; postgres x every supported Bun; crash
// manifests uploaded). Nightly full-corpus E2E still runs them.
export const PERSISTENCE_VALIDATION_OWNED = new Set([
  'test/e2e/reconcile-crash.test.ts',
  'test/e2e/reconcile-crash-unactivated.test.ts',
]);
// PR owner of every test/e2e/ row of scripts/e2e-backend-matrix.txt (`!` rows
// stay out of the matrix) is e2e.yml's tier1-backend-matrix job: it runs each
// file on direct Postgres and again through PgBouncer, so Selected E2E's
// direct-only run of the same file was a duplicate (C3).
export const BACKEND_MATRIX_OWNED = new Set(
  readFileSync(resolve(import.meta.dir, "e2e-backend-matrix.txt"), "utf8").split("\n")
    .filter(row => row.startsWith("test/e2e/"))
    .map(row => row.split("\t")[0]),
);
export function exclusionNotice(file: string): string {
  if (PERSISTENCE_VALIDATION_OWNED.has(file)) return `excluded: ${file} (owned by persistence-validation.yml)`;
  if (BACKEND_MATRIX_OWNED.has(file)) return `excluded: ${file} (owned by the Tier 1 backend matrix, scripts/e2e-backend-matrix.txt)`;
  return `excluded (named-job / live-key lane): ${file}`;
}
export const MAX_E2E_WORKERS = 14;
export const E2E_EXCLUSIONS = new Set([
  'test/e2e/op-checkpoint-jsonb-parity.test.ts',
  'test/e2e/jsonb-roundtrip.test.ts',
  'test/e2e/mechanical.test.ts',
  'test/e2e/job-isolation.test.ts',
  'test/e2e/sync-reconcile-postgres.test.ts',
  'test/e2e/engine-parity.test.ts',
  'test/e2e/serve-http-multi-agent.test.ts',
  'test/e2e/postgres-bootstrap.test.ts',
  'test/e2e/sync-delegation-under-serve.serial.test.ts',
  'test/e2e/dream-synthesize-pglite.test.ts',
  'test/e2e/skills.test.ts',
  'test/e2e/voyage-rerank-live.test.ts',
  'test/e2e/voyage-multimodal.test.ts',
  // Engine graduation: run once by the tier1-graduation job (direct Postgres + PgBouncer).
  'test/e2e/graduation-cli.test.ts',
  'test/e2e/graduation-cli-topologies.test.ts',
  'test/e2e/graduation-cli-history.test.ts',
  'test/e2e/graduation-cli-zero-mutation-1.test.ts',
  'test/e2e/graduation-cli-zero-mutation-2.test.ts',
  'test/e2e/graduation-cli-zero-mutation-3.test.ts',
  'test/e2e/graduation-clients.test.ts',
  'test/e2e/graduation-clients-serve.test.ts',
  'test/e2e/graduation-crash-run-1.test.ts',
  'test/e2e/graduation-crash-run-2.test.ts',
  'test/e2e/graduation-crash-run-3.test.ts',
  'test/e2e/graduation-crash-rollback-1.test.ts',
  'test/e2e/graduation-crash-rollback-2.test.ts',
  'test/e2e/graduation-faults.test.ts',
  'test/e2e/graduation-legacy-copy.test.ts',
  ...PERSISTENCE_VALIDATION_OWNED,
  ...BACKEND_MATRIX_OWNED,
]);
export interface E2ERow { shard: number; files: string[]; empty: boolean }
function validatePath(file: unknown): asserts file is string {
  if (typeof file !== "string" || !/^test\/e2e\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(file) || file.split("/").some(p => p === ".." || p === "." || p === "")) {
    throw new Error(`invalid E2E test path: ${JSON.stringify(file)}`);
  }
}
export function prepareMatrix(files: string[], weights: WeightMap): { include: E2ERow[] } {
  for (const file of files) validatePath(file);
  if (new Set(files).size !== files.length) throw new Error("duplicate selected E2E file");
  const selected = files.filter(file => {
    if (!E2E_EXCLUSIONS.has(file)) return true;
    console.error(exclusionNotice(file));
    return false;
  });
  if (!selected.length) return { include: [{ shard: 1, files: [], empty: true }] };
  return { include: partition(selected, weights, Math.min(MAX_E2E_WORKERS, selected.length)).map((files, i) => ({ shard: i + 1, files, empty: false })) };
}
export function validateRow(value: unknown, root: string): E2ERow {
  if (!value || typeof value !== "object") throw new Error("missing E2E matrix row");
  const row = value as E2ERow;
  if (!Number.isInteger(row.shard) || row.shard < 1 || row.shard > MAX_E2E_WORKERS || !Array.isArray(row.files) || typeof row.empty !== "boolean") throw new Error("malformed E2E matrix row");
  if (row.empty !== (row.files.length === 0) || (row.empty && row.shard !== 1)) throw new Error("invalid empty E2E sentinel");
  if (new Set(row.files).size !== row.files.length) throw new Error("duplicate E2E worker file");
  const base = realpathSync(root);
  for (const file of row.files) {
    validatePath(file);
    if (E2E_EXCLUSIONS.has(file)) throw new Error(`excluded E2E worker file: ${file}`);
    const target = realpathSync(resolve(base, file));
    const path = relative(base, target);
    if (isAbsolute(path) || !path.startsWith("test/e2e/") || !statSync(target).isFile()) throw new Error(`E2E path escapes corpus: ${file}`);
  }
  return row;
}
export async function runRow(value: unknown, root = process.cwd()): Promise<number> {
  const row = validateRow(value, root);
  if (row.empty) {
    console.log("selected E2E: explicit empty selection; no tests launched");
    return 0;
  }
  const env = { ...process.env };
  delete env.SHARD; // The prepared list is already partitioned.
  console.log(`selected E2E shard ${row.shard}: ${row.files.length} frozen files`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let pendingSignal: "SIGTERM" | "SIGINT" | undefined;
  const forward = (signal: "SIGTERM" | "SIGINT") => {
    pendingSignal = signal;
    child?.kill(signal);
  };
  const term = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  process.once("SIGTERM", term);
  process.once("SIGINT", interrupt);
  try {
    child = Bun.spawn(["bash", "scripts/run-e2e.sh", ...row.files], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
    if (pendingSignal) child.kill(pendingSignal);
    const code = await child.exited;
    return pendingSignal ? (pendingSignal === "SIGINT" ? 130 : 143) : code;
  }
  finally { process.off("SIGTERM", term); process.off("SIGINT", interrupt); }
}
async function main() {
  if (process.argv[2] === "prepare") {
    if (process.stdin.isTTY) throw new Error("prepare requires selector output on stdin");
    const raw = await new Response(Bun.stdin.stream()).text();
    const files = raw.split("\n").filter(Boolean);
    const matrix = prepareMatrix(files, loadWeights(resolve(import.meta.dir, "e2e-weights.json")));
    console.error(`selected E2E: ${files.length} selected, ${matrix.include.reduce((n, row) => n + row.files.length, 0)} executable, ${matrix.include.length} workers`);
    console.log(JSON.stringify(matrix));
  } else if (process.argv[2] === "run") {
    if (!process.env.E2E_MATRIX_ROW) throw new Error("E2E_MATRIX_ROW is required");
    process.exitCode = await runRow(JSON.parse(process.env.E2E_MATRIX_ROW));
  } else throw new Error("usage: bun scripts/e2e-matrix.ts prepare|run");
}
if (import.meta.main) main().catch(error => { console.error(`e2e-matrix: ${error.message}`); process.exitCode = 1; });
