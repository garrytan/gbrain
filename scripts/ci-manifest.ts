#!/usr/bin/env bun
/**
 * Failure and execution manifest (green master wave, Lane 4 evidence).
 *
 *   bun scripts/ci-manifest.ts --receipts-dir <dir> --out <file> [--summary <file>] [--deltas <tsv>]
 *
 * Reads every lane's executed-test receipts (the Bun JUnit reports written by
 * scripts/lib/test-env.sh, loaded through scripts/ci-executed-counts.ts) and
 * writes one versioned JSON manifest bound to the workflow, event, SHA, run id
 * and run attempt taken from the GitHub Actions environment
 * (GITHUB_WORKFLOW, GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_RUN_ID,
 * GITHUB_RUN_ATTEMPT). test.yml and e2e.yml upload it as the `ci-manifest`
 * artifact from their `executed-receipts` job; nightly-watch
 * (scripts/nightly-issue.ts) reads it to name every failing test and to
 * prove which files ran and passed before it clears a master-red failure.
 *
 * `complete` is false when any lane's receipts are incomplete (a killed
 * shard, a truncated report, a receipt from an older attempt, a lane that
 * executed nothing without a declared skip row, no receipts at all). An incomplete manifest still lists the failures it saw, but it never
 * counts as proof that a file passed. Exit 0 when written, 2 on usage error.
 * Docs: docs/ci-red-runbook.md#ci-failure-manifest
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSide, compare, DEFAULT_DELTAS, loadReceiptDir, parseDeltas, parseJUnit, type DeltaRow, type Receipt } from './ci-executed-counts.ts';

export const MANIFEST_SCHEMA = 'gbrain-ci-manifest/v1';
export const MANIFEST_ARTIFACT = 'ci-manifest';
export const MANIFEST_FILE = 'ci-manifest.json';
export const MANIFEST_DOCS = 'docs/ci-red-runbook.md#ci-failure-manifest';

export interface ManifestFile { file: string; lane: string; arm: string; executed: number; failed: number; skipped: number }
/** `signature` is the stress gate's failure signature of the JUnit failure message, so exemption records match its failures; it is omitted when the message carries a credential (then no exemption is offered). */
export interface ManifestFailure { lane: string; file: string; test: string; arm: string; signature?: string; message?: string }
export interface CiManifest {
  schema: typeof MANIFEST_SCHEMA;
  workflow: string;
  event: string;
  sha: string;
  run_id: number;
  run_attempt: number;
  complete: boolean;
  problems: string[];
  files: ManifestFile[];
  failures: ManifestFailure[];
}
export interface ManifestBinding { workflow: string; event: string; sha: string; run_id: number; run_attempt: number }

/** `deltas` are the declared skips of docs/test-audit/2026-10-04/expected-deltas.tsv (a keyless lane declared empty is not a problem). */
export function buildManifest(receipts: Receipt[], bind: ManifestBinding, deltas: { rows: DeltaRow[]; errors: string[] } = { rows: [], errors: [] }, messages: Map<string, string> = new Map()): CiManifest {
  const side = buildSide('manifest', receipts, new Map([[String(bind.run_id), bind.run_attempt]]));
  const problems = compare(side, undefined, deltas).issues.map(i => i.detail);
  if (!receipts.length) problems.push('no receipts were downloaded (every receipts-* upload is missing)');
  const foreign = [...side.shas].filter(s => s && s !== bind.sha);
  if (foreign.length) problems.push(`receipts come from other commits (${foreign.map(s => s.slice(0, 12)).join(', ')}), not ${bind.sha.slice(0, 12)}`);
  const files = new Map<string, ManifestFile>();
  const failures: ManifestFailure[] = [];
  for (const id of side.identities.values()) {
    const key = `${id.lane}\u001f${id.file}\u001f${id.arm}`;
    const entry = files.get(key) ?? { file: id.file, lane: id.lane, arm: id.arm, executed: 0, failed: 0, skipped: 0 };
    if (id.status === 'pass' || id.status === 'fail') entry.executed++;
    else entry.skipped++;
    if (id.status === 'fail') {
      entry.failed++;
      const message = messages.get(`${id.file}\u001f${id.test}`);
      const safe = message !== undefined && redactMessage(message) === message;
      failures.push({ lane: id.lane, file: id.file, test: id.test, arm: id.arm, ...(message === undefined ? {} : { ...(safe ? { signature: failureSignature(message) } : {}), message: redactMessage(message).slice(0, 500) }) });
    }
    files.set(key, entry);
  }
  const byKey = (a: { lane: string; file: string; arm: string }, b: { lane: string; file: string; arm: string }) =>
    a.file.localeCompare(b.file) || a.lane.localeCompare(b.lane) || a.arm.localeCompare(b.arm);
  return {
    schema: MANIFEST_SCHEMA, ...bind, complete: problems.length === 0, problems,
    files: [...files.values()].sort(byKey),
    failures: failures.sort((a, b) => byKey(a, b) || a.test.localeCompare(b.test)),
  };
}

/**
 * The stress gate's failure signature (scripts/stress/run.ts `failureSignature`):
 * the first four non-empty lines of the failure message with ANSI codes,
 * temp paths, UUIDs and numbers masked, capped at 200 characters. An
 * exemption record matches a stress failure only when this is identical;
 * test/scripts/nightly-issue.test.ts pins it against the gate's contract.
 */
export function failureSignature(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' ')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 200);
}

const redactMessage = (text: string) => text
  .replace(/\b(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]*@/gi, '$1:***@')
  .replace(/\b(PGPASSWORD|[A-Z_]*(?:TOKEN|API_KEY|SECRET))=\S+/g, '$1=***');

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, r: string) => (r[0] === '#' ? String.fromCodePoint(r[1] === 'x' ? parseInt(r.slice(2), 16) : Number(r.slice(1))) : ENTITY[r] ?? w));

/** First JUnit failure message per failing test (`file\u001ftest`), paired in report order as the stress gate pairs them. */
export function junitMessages(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith('.junit.xml')) continue;
      const xml = readFileSync(path, 'utf8');
      let failed;
      try { failed = parseJUnit(xml).filter(c => c.status === 'fail'); } catch { continue; }
      const messages: string[] = [];
      for (const [, body] of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const m = /<(?:failure|error)\b[^>]*?message="([^"]*)"/.exec(body ?? '');
        if (m || /<(?:failure|error)\b/.test(body ?? '')) messages.push(decode(m?.[1] ?? 'failure without a message'));
      }
      failed.forEach((c, i) => {
        const file = c.file.includes('test/') ? c.file.slice(c.file.indexOf('test/')) : c.file;
        const key = `${file}\u001f${c.test}`;
        if (!out.has(key) && messages[i] !== undefined) out.set(key, messages[i]!);
      });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Validate a downloaded manifest against the run it must describe; a mismatch is a problem string, never a silent pass. */
export function checkManifest(value: unknown, bind: Pick<ManifestBinding, 'sha' | 'run_id' | 'run_attempt'>): { manifest?: CiManifest; problem?: string } {
  const m = value as Partial<CiManifest> | null;
  if (!m || typeof m !== 'object') return { problem: 'the manifest is not a JSON object' };
  if (m.schema !== MANIFEST_SCHEMA) return { problem: `the manifest schema is '${String(m.schema)}', expected '${MANIFEST_SCHEMA}'` };
  if (m.sha !== bind.sha || m.run_id !== bind.run_id) return { problem: `the manifest describes run ${String(m.run_id)} at ${String(m.sha).slice(0, 12)}, not run ${bind.run_id} at ${bind.sha.slice(0, 12)}` };
  if (m.run_attempt !== bind.run_attempt) return { problem: `the manifest comes from attempt ${String(m.run_attempt)}; the run's latest attempt is ${bind.run_attempt} (re-run all jobs so the manifest is rebuilt)` };
  if (!Array.isArray(m.files) || !Array.isArray(m.failures) || !Array.isArray(m.problems) || typeof m.complete !== 'boolean') return { problem: 'the manifest is missing its files, failures, problems or complete fields' };
  return { manifest: m as CiManifest };
}

/** Files that executed at least one test and failed none, across every lane and arm that ran them. */
export function passedFiles(manifest: CiManifest): Set<string> {
  const failed = new Set(manifest.files.filter(f => f.failed > 0).map(f => f.file));
  return new Set(manifest.files.filter(f => f.executed > 0 && !failed.has(f.file)).map(f => f.file));
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--receipts-dir');
  const out = flag('--out');
  const env = process.env;
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!dir || !out || !Number.isInteger(runId) || !Number.isInteger(attempt) || !env.GITHUB_SHA) {
    console.error('usage: bun scripts/ci-manifest.ts --receipts-dir <dir> --out <file> [--summary <file>] [--deltas <tsv>]');
    console.error('Why: the manifest is bound to GITHUB_SHA, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT, which only an Actions job sets.');
    console.error(`Fix: run it inside the executed-receipts job, or export those variables for a local check. Docs: ${MANIFEST_DOCS}`);
    return 2;
  }
  const receipts = existsSync(dir) ? loadReceiptDir(dir) : [];
  const deltasPath = flag('--deltas') ?? DEFAULT_DELTAS;
  const deltas = existsSync(deltasPath) ? parseDeltas(readFileSync(deltasPath, 'utf8')) : { rows: [], errors: [] };
  const manifest = buildManifest(receipts, { workflow: env.GITHUB_WORKFLOW ?? '', event: env.GITHUB_EVENT_NAME ?? '', sha: env.GITHUB_SHA, run_id: runId, run_attempt: attempt }, deltas, junitMessages(dir));
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const line = `ci-manifest: ${manifest.files.length} file/lane/arm entries, ${manifest.failures.length} failing tests, ${manifest.complete ? 'complete' : `INCOMPLETE (${manifest.problems.length} problems; nightly-watch will not clear failures from this run)`}.`;
  console.log(line);
  const summary = flag('--summary');
  if (summary) appendFileSync(summary, `${line} Docs: ${MANIFEST_DOCS}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
