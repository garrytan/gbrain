/**
 * Setup template receipts (agent platform plan, H2 finding d8; lane 5's O1 reuses this shape). A template run
 * (`gbrain setup <harness> --shape household`) records what it did here, one JSON file per run under
 * <configDir>/setup-receipts/, 0600 in a 0700 folder. A receipt names its target (template, harness, brain and source)
 * so `--status` and `--resume` never act on another brain or source, and it keeps each key's issuance (the token row)
 * apart from its delivery (the 0600 key file): a resume that finds a key issued but never delivered refuses instead of
 * issuing a second one. A receipt holds no token value, only names, paths and times.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { configDir } from '../core/config.ts';
import { brainIdentity } from '../core/context/capture-consent.ts';
import { opError } from '../core/ops/contract.ts';

export const RECEIPT_DIR = 'setup-receipts';
export const RECEIPT_VERSION = 1;

export type ReceiptStepState = 'done' | 'pending' | 'failed';

export interface ReceiptKey {
  member: string;
  token_name: string;
  path: string;
  /** The token row was written (the key exists on the brain). */
  issued: { at: string } | null;
  /** The key was written to its 0600 file at path. */
  delivered: { at: string } | null;
}

export interface TemplateReceipt {
  version: typeof RECEIPT_VERSION;
  id: string;
  template: string;
  harness: string | null;
  /** brainIdentity(): a hash of the config directory this run wrote through. */
  brain: string;
  source_id: string;
  created_at: string;
  updated_at: string;
  /** The template's inputs, so a resume runs the same shape whatever flags it is given. */
  params: Record<string, unknown>;
  steps: Array<{ id: string; state: ReceiptStepState; at?: string; detail?: string }>;
  keys: ReceiptKey[];
  error?: { code: string; message: string };
}

export const receiptDir = (): string => join(configDir(), RECEIPT_DIR);

export function newReceipt(template: string, target: { harness: string | null; source_id: string }, params: Record<string, unknown>, steps: string[]): TemplateReceipt {
  const now = new Date().toISOString();
  const id = `${template}-${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
  return { version: RECEIPT_VERSION, id, template, harness: target.harness, brain: brainIdentity(), source_id: target.source_id, created_at: now, updated_at: now,
    params, steps: steps.map(s => ({ id: s, state: 'pending' })), keys: [] };
}

/** Writes the receipt atomically, 0600 in a 0700 folder. */
export function saveReceipt(r: TemplateReceipt, dir: string = receiptDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  r.updated_at = new Date().toISOString();
  const path = join(dir, `${r.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const RECEIPT_ID_RE = /^[a-z][a-z0-9-]{0,80}-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function parse(path: string): TemplateReceipt | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as TemplateReceipt;
    return r && r.version === RECEIPT_VERSION && typeof r.id === 'string' && Array.isArray(r.steps) && Array.isArray(r.keys) ? r : null;
  } catch { return null; } // silent-read-ok: a missing or unreadable receipt file is no receipt; loadReceipt refuses setup_receipt_not_found
}

/** One receipt by id; refuses setup_receipt_not_found when it is missing or unreadable. */
export function loadReceipt(id: string, template: string, dir: string = receiptDir()): TemplateReceipt {
  const r = RECEIPT_ID_RE.test(id) ? parse(join(dir, `${id}.json`)) : null;
  if (r && r.template === template) return r;
  throw opError('setup_receipt_not_found', `No ${template} setup receipt "${id}" is on this machine (${dir}).`,
    `Read the newest receipt with gbrain ${template} template --status, or run the template again with --yes (every step is idempotent).`);
}

/** The newest receipt of `template` for this brain, narrowed to a source and harness when given; null when there is none. */
export function latestReceipt(template: string, filter: { source_id?: string; harness?: string | null } = {}, dir: string = receiptDir()): TemplateReceipt | null {
  if (!existsSync(dir)) return null;
  const brain = brainIdentity();
  const all = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => parse(join(dir, f))).filter((r): r is TemplateReceipt => !!r
    && r.template === template && r.brain === brain && (filter.source_id === undefined || r.source_id === filter.source_id)
    && (filter.harness == null || r.harness === filter.harness));
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * Refuses setup_receipt_target_mismatch when a receipt was written for another brain, source or harness than the one
 * this command names: a status or resume never reads or changes a target the person did not name.
 */
export function assertReceiptTarget(r: TemplateReceipt, target: { source_id?: string; harness?: string | null }): void {
  const wrong = [
    ...(r.brain !== brainIdentity() ? [`brain (it was written through another config directory)`] : []),
    ...(target.source_id !== undefined && target.source_id !== r.source_id ? [`source (it is for ${r.source_id}, not ${target.source_id})`] : []),
    ...(target.harness != null && r.harness != null && target.harness !== r.harness ? [`harness (it is for ${r.harness}, not ${target.harness})`] : []),
  ];
  if (!wrong.length) return;
  throw opError('setup_receipt_target_mismatch', `Setup receipt ${r.id} names another ${wrong.join(' and ')}; nothing was read or written.`,
    `Run it for the receipt's own target: gbrain ${r.template} template --status --receipt ${r.id} --source ${r.source_id}${r.harness ? ` --harness ${r.harness}` : ''}.`);
}

export const stepState = (r: TemplateReceipt, id: string): ReceiptStepState | undefined => r.steps.find(s => s.id === id)?.state;

export function markStep(r: TemplateReceipt, id: string, state: ReceiptStepState, detail?: string): void {
  const step = r.steps.find(s => s.id === id) ?? (r.steps.push({ id, state }), r.steps.at(-1)!);
  step.state = state;
  step.at = new Date().toISOString();
  if (detail) step.detail = detail; else delete step.detail;
}

/** The receipt's key entry for `member`, created when missing. */
export function receiptKey(r: TemplateReceipt, member: string, token_name: string, path: string): ReceiptKey {
  const found = r.keys.find(k => k.member === member);
  if (found) { found.token_name = token_name; found.path = path; return found; }
  const k: ReceiptKey = { member, token_name, path, issued: null, delivered: null };
  r.keys.push(k);
  return k;
}
