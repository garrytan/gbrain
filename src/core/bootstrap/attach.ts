/**
 * `gbrain bootstrap attach` — machine-two adoption of an existing agent
 * workspace [CX-P1.5, CX2-1].
 *
 * A cloned repo carrying an `initialized: true` agent.json enters attach mode:
 * this module VALIDATES the manifest and writes the machine-local install
 * receipt, then returns the structured todo-list (register source, hooks
 * repair, mcp add, verify) that the CLI dispatcher executes. Attach itself
 * performs no host registration and no engine work — orchestration lives in
 * the dispatcher so each step stays independently testable and resumable.
 *
 * Discriminator rules [CX2-1]:
 *  - `initialized: false` → an unrendered TEMPLATE clone; attach refuses and
 *    points at `bootstrap render` (render flips the sentinel).
 *  - no agent.json → not an agent workspace at all.
 *
 * Receipt semantics [CX2-12]: the receipt written here has
 * `brain_created_by_bootstrap: false` — attach adopts an existing brain (or
 * the dispatcher inits one and flips the flag itself). If THIS machine already
 * holds a receipt for the SAME workspace, its `brain_created_by_bootstrap`,
 * `created_paths`, and `registrations` are preserved (attach after a local
 * bootstrap must not launder away uninstall's ownership record). A receipt for
 * a DIFFERENT workspace is replaced — the receipt file is machine-scoped,
 * last-attach-wins (v1 is single-workspace-per-machine).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';
import { realpathOrResolve } from '../path-confine.ts';
import {
  guardReceiptOverwrite,
  readManifest,
  readReceipt,
  writeReceipt,
  type AgentManifest,
  type InstallReceipt,
} from './format.ts';
import { gitOriginUrl } from './status.ts';
import { type RepoReceipt } from './repo.ts';
import { BootstrapError } from './lock.ts';

export type AttachStepKind = 'register_source' | 'hooks_repair' | 'mcp_add' | 'verify';

export interface AttachStep {
  kind: AttachStepKind;
  description: string;
}

export interface AttachWorkspaceOptions {
  /** The gbrain home receiving the install receipt (default: configDir()). */
  gbrainHomeDir?: string;
  /** Target harness for the hooks/MCP steps' descriptions. */
  harness?: 'claude-code' | 'codex' | 'opencode';
  /** Recorded as the receipt's created_by (the attaching binary's version). */
  createdBy?: string;
}

export interface AttachWorkspaceResult {
  manifest: AgentManifest;
  receipt: InstallReceipt;
  /** Ordered todo-list for the dispatcher. Attach only validated + wrote the
   * receipt; every step here is still TO BE RUN. */
  steps: AttachStep[];
}

export function attachWorkspace(workspaceDir: string, opts: AttachWorkspaceOptions = {}): AttachWorkspaceResult {
  const state = readManifest(workspaceDir);
  switch (state.state) {
    case 'absent':
      throw new BootstrapError(
        'NOT_A_WORKSPACE',
        `not an agent workspace (no agent.json in ${workspaceDir}) — clone a bootstrapped workspace, or run \`gbrain bootstrap render\` to create one`,
      );
    case 'template':
      throw new BootstrapError(
        'TEMPLATE_UNINITIALIZED',
        'this is an uninitialized template — run `gbrain bootstrap render` (attach is for clones of an already-bootstrapped workspace)',
      );
    case 'invalid':
      throw new BootstrapError('MANIFEST_INVALID', `agent.json is invalid: ${state.reason}`);
    case 'newer_format':
      throw new BootstrapError(
        'NEWER_FORMAT',
        `agent.json format_version ${state.manifest.format_version} is newer than this gbrain understands — upgrade gbrain first`,
      );
    case 'initialized':
      break;
  }
  const manifest = state.manifest;

  const gbrainHomeDir = opts.gbrainHomeDir ?? configDir();
  const resolvedWs = realpathOrResolve(workspaceDir);
  // Pre-write guard [CX2-12]: a receipt from a NEWER gbrain refuses (upgrade
  // first — readReceipt alone would return null and silently clobber its
  // created_paths/registrations); an unreadable receipt is backed up loudly.
  const guard = guardReceiptOverwrite(gbrainHomeDir);
  if (guard.brokenBackupPath) {
    console.error(`WARNING: the install receipt was unreadable; backed it up to ${guard.brokenBackupPath} and wrote a fresh one.`);
  }
  const existing = readReceipt(gbrainHomeDir);
  const sameWorkspace = existing !== null && realpathOrResolve(existing.workspace_dir) === resolvedWs;

  // Record repo_url from the adopted origin so the no-daemon push gate
  // (repoPhaseComplete) recognizes the repo phase as done on this machine —
  // otherwise the per-turn/session-end pushes defer FOREVER after an attach
  // (the ONLY install path in a cloud sandbox, where `bootstrap repo` is
  // refused). This does NOT bypass the privacy gate: workspacePush still runs
  // the visibility ladder at push time and fails closed on a public/
  // unverifiable origin. Preserve an existing repo_url on a same-workspace
  // re-attach; else adopt the current github origin.
  const existingRepoUrl = sameWorkspace ? (existing as RepoReceipt).repo_url : undefined;
  const originUrl = gitOriginUrl(resolvedWs);
  // Record the origin as repo_url whenever one exists — github or self-hosted.
  // repoPhaseComplete binds by owner/name for github and by exact URL otherwise;
  // either way workspacePush still runs the visibility ladder at push time, so a
  // non-verifiable origin stays fail-closed (refused unless the operator sets the
  // escape hatch). Recording it only clears the "repo phase ran" gate.
  const adoptedRepoUrl = existingRepoUrl ?? (originUrl ?? undefined);
  const receipt: RepoReceipt = {
    receipt_version: 1,
    workspace_dir: resolvedWs,
    source_id: manifest.source_id,
    agent_name: manifest.agent_name,
    created_at: sameWorkspace ? existing.created_at : new Date().toISOString(),
    created_by: opts.createdBy ?? (sameWorkspace ? existing.created_by : 'attach'),
    // Never true from attach alone: attach adopts an existing brain [CX2-12].
    // Preserved when a local bootstrap already claimed brain ownership.
    brain_created_by_bootstrap: sameWorkspace ? existing.brain_created_by_bootstrap : false,
    created_paths: sameWorkspace ? existing.created_paths : [],
    registrations: sameWorkspace ? existing.registrations : [],
    ...(adoptedRepoUrl ? { repo_url: adoptedRepoUrl } : {}),
  };
  // writeReceipt assumes the bootstrap/ subdir exists; attach runs on a fresh
  // machine where nothing has created it yet.
  mkdirSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true });
  writeReceipt(gbrainHomeDir, receipt);

  const harness = opts.harness ?? 'claude-code';
  const steps: AttachStep[] = [
    {
      kind: 'register_source',
      description: `register ${resolvedWs}/brain as gbrain source '${manifest.source_id}' (gbrain sources add)`,
    },
    {
      kind: 'hooks_repair',
      description: `re-render machine-local hook wiring for ${harness} (bootstrap hooks --harness ${harness} --repair)`,
    },
    {
      kind: 'mcp_add',
      description: `register the gbrain MCP server with ${harness} (GBRAIN_SOURCE=${manifest.source_id})`,
    },
    {
      kind: 'verify',
      description: 'run `gbrain bootstrap verify` to confirm the attached workspace end-to-end',
    },
  ];

  return { manifest, receipt, steps };
}
