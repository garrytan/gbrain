/**
 * skillpack/trust-prompt.ts — first-install identity confirm + TOFU.
 *
 * Codex G4: every first scaffold of a third-party pack surfaces a
 * confirm prompt with full identity (name, author, source URL, pinned
 * commit / tarball SHA, tier). Subsequent scaffolds of the same
 * `(name, author, pinned_commit_or_tarball_sha)` triple skip the
 * prompt — they're already trusted (state.json carries the record).
 * Different author or different pin re-prompts.
 *
 * Pure-data prompt builder + a TTY/non-TTY adapter. Tests exercise
 * the builder shape; the adapter is exercised via e2e (where we
 * inject a fake reader).
 */

import { createInterface } from 'readline';

import type { ResolvedSource } from './remote-source.ts';
import type { SkillpackManifest } from './manifest-v1.ts';
import type { SkillpackState } from './state.ts';
import { isAlreadyTrusted } from './state.ts';

export type SkillpackTier = 'endorsed' | 'community' | 'experimental' | 'dead' | 'local';

export interface TrustPromptInput {
  manifest: SkillpackManifest;
  resolved: ResolvedSource;
  tier: SkillpackTier;
  state: SkillpackState;
}

export interface TrustPromptDecision {
  /** True when prompt was shown and user accepted, OR when skipped because already trusted. */
  trusted: boolean;
  /** Reason for the decision, useful for stderr log lines + tests. */
  reason:
    | 'already_trusted'
    | 'prompt_accepted'
    | 'prompt_rejected'
    | 'local_path_no_prompt'
    | 'trust_flag_bypassed'
    | 'non_tty_no_trust_flag';
}

/** Render the identity block shown to the user. Pure function. */
export function renderIdentityBlock(input: TrustPromptInput): string {
  const { manifest, resolved, tier } = input;
  const lines: string[] = [];
  lines.push('[skillpack] About to scaffold:');
  lines.push(`  Name:          ${manifest.name}`);
  lines.push(`  Version:       ${manifest.version}`);
  lines.push(`  Author:        ${manifest.author}`);
  lines.push(`  Source:        ${resolved.source}`);
  if (resolved.pinned_commit) {
    lines.push(`  Pinned commit: ${resolved.pinned_commit}`);
  }
  if (resolved.tarball_sha256) {
    lines.push(`  Tarball SHA:   sha256:${resolved.tarball_sha256}`);
  }
  lines.push(`  Tier:          ${tier}`);
  lines.push(`  Description:   ${manifest.description}`);
  return lines.join('\n');
}

export interface AskTrustOptions {
  /** If true, --trust flag was passed; auto-accept regardless of TTY. */
  trustFlag?: boolean;
  /** Inject a custom reader for testing. */
  readLine?: (question: string) => Promise<string>;
  /** Default reader uses readline against stdin. */
  isTTY?: boolean;
}

/** Default TTY-aware reader. */
function defaultReadLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveAns) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAns(answer);
    });
  });
}

/**
 * Decide whether the scaffold can proceed. Surfaces the identity block to the
 * user, runs the prompt, returns a structured decision.
 */
export async function askTrust(
  input: TrustPromptInput,
  opts: AskTrustOptions = {},
): Promise<TrustPromptDecision> {
  // Local-path sources skip the trust gate entirely. The user owns the
  // directory; they're already trusting whatever lives there.
  if (input.resolved.kind === 'local') {
    return { trusted: true, reason: 'local_path_no_prompt' };
  }

  // Already trusted check (codex G4 identity match).
  if (
    isAlreadyTrusted(input.state, {
      name: input.manifest.name,
      author: input.manifest.author,
      pinned_commit: input.resolved.pinned_commit,
      tarball_sha256: input.resolved.tarball_sha256,
    })
  ) {
    return { trusted: true, reason: 'already_trusted' };
  }

  const block = renderIdentityBlock({ ...input });
  process.stderr.write(block + '\n');

  if (opts.trustFlag) {
    process.stderr.write('[skillpack] --trust flag passed; proceeding without confirm prompt.\n');
    return { trusted: true, reason: 'trust_flag_bypassed' };
  }

  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!isTTY) {
    process.stderr.write(
      '[skillpack] non-TTY environment and no --trust flag; refusing to scaffold a new third-party source without explicit consent.\n',
    );
    return { trusted: false, reason: 'non_tty_no_trust_flag' };
  }

  const reader = opts.readLine ?? defaultReadLine;
  const answer = (await reader('Continue? [y/N]: ')).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    return { trusted: true, reason: 'prompt_accepted' };
  }
  return { trusted: false, reason: 'prompt_rejected' };
}
