/**
 * Bundled bootstrap assets [ENG-6].
 *
 * `bin/gbrain` ships via `bun build --compile`, so filesystem-relative template
 * resolution (the init.ts `dirname(dirname(__dirname))` pattern) breaks inside
 * the compiled binary. Every template and the question bank are embedded with
 * Bun's `import ... with { type: 'file' }` — the same mechanism as the
 * tree-sitter WASMs in src/core/chunkers/code.ts. In dev the import resolves to
 * the source-tree path; in the compiled binary to a bundler-synthesized path.
 * Either way `readFileSync(path)` works.
 *
 * A compiled-binary e2e asserts `bootstrap render` works with no repo checkout.
 */

import { readFileSync } from 'node:fs';

// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import QUESTIONS_JSON from '../../../templates/bootstrap/questions.json' with { type: 'file' };
// @ts-ignore
import T_AGENTS from '../../../templates/bootstrap/AGENTS.md.template' with { type: 'file' };
// @ts-ignore
import T_SOUL from '../../../templates/bootstrap/SOUL.md.template' with { type: 'file' };
// @ts-ignore
import T_USER from '../../../templates/bootstrap/USER.md.template' with { type: 'file' };
// @ts-ignore
import T_MEMORY from '../../../templates/bootstrap/MEMORY.md.template' with { type: 'file' };
// @ts-ignore
import T_CLAUDE from '../../../templates/bootstrap/CLAUDE.md.template' with { type: 'file' };
// @ts-ignore
import T_GITHUB from '../../../templates/bootstrap/GITHUB.md.template' with { type: 'file' };
// @ts-ignore
import T_HEARTBEAT from '../../../templates/bootstrap/HEARTBEAT.md.template' with { type: 'file' };
// @ts-ignore
import T_ACCESS from '../../../templates/bootstrap/ACCESS_POLICY.md.template' with { type: 'file' };
// @ts-ignore
import T_MEMORY_README from '../../../templates/bootstrap/memory-README.md.template' with { type: 'file' };
// @ts-ignore
import T_GITIGNORE from '../../../templates/bootstrap/gitignore.template' with { type: 'file' };
// @ts-ignore
import T_CLOUD_SETUP from '../../../templates/bootstrap/cloud-setup-script.sh' with { type: 'file' };

/** Where each rendered file lands, relative to the workspace root. */
export interface BootstrapTemplate {
  /** Asset path (dev: repo path; compiled: bundler path). */
  assetPath: string;
  /** Destination relative to the workspace. */
  dest: string;
  /** Group for `render --only`. */
  group: 'identity' | 'contract' | 'scaffold';
}

/** The cloud environment setup script [D16] — NOT a rendered template (it is
 * pasted into the cloud env config, never written into the workspace). Lives
 * as a template file deliberately: inline script strings in src modules would
 * bleed their dashed tokens into the CLI flag registry. */
export function loadCloudSetupScript(): string {
  return readFileSync(T_CLOUD_SETUP as unknown as string, 'utf8');
}

export const BOOTSTRAP_TEMPLATES: BootstrapTemplate[] = [
  { assetPath: T_AGENTS as unknown as string, dest: 'AGENTS.md', group: 'contract' },
  { assetPath: T_CLAUDE as unknown as string, dest: 'CLAUDE.md', group: 'contract' },
  { assetPath: T_SOUL as unknown as string, dest: 'SOUL.md', group: 'identity' },
  { assetPath: T_USER as unknown as string, dest: 'USER.md', group: 'identity' },
  { assetPath: T_MEMORY as unknown as string, dest: 'MEMORY.md', group: 'identity' },
  { assetPath: T_HEARTBEAT as unknown as string, dest: 'HEARTBEAT.md', group: 'contract' },
  { assetPath: T_ACCESS as unknown as string, dest: 'ACCESS_POLICY.md', group: 'contract' },
  { assetPath: T_GITHUB as unknown as string, dest: 'GITHUB.md', group: 'contract' },
  { assetPath: T_MEMORY_README as unknown as string, dest: 'memory/README.md', group: 'scaffold' },
  { assetPath: T_GITIGNORE as unknown as string, dest: '.gitignore', group: 'scaffold' },
];

export function readTemplate(t: BootstrapTemplate): string {
  return readFileSync(t.assetPath, 'utf8');
}

/**
 * Tokens that are NOT interview/consent keys — they are derived at render time
 * from runtime state. The templates↔question-bank CI bijection treats
 * (bank keys ∪ DERIVED_TOKENS) as the full legal token set.
 */
/** The literal GITHUB_REPO_URL placeholder rendered into GITHUB.md until
 * `bootstrap repo` replaces it — defined ONCE here because repo.ts's
 * `updateGithubMd` splice and render.ts's DERIVED_DEFAULTS must byte-match. */
export const GITHUB_URL_PLACEHOLDER = '(not yet created — bootstrap repo sets this)';

export const DERIVED_TOKENS = [
  /** Set by `bootstrap repo` after the private remote exists; renders as a
   * placeholder note until then. */
  'GITHUB_REPO_URL',
  /** From config `dream.synthesize.corpus_retention_days` (default 30). */
  'CORPUS_RETENTION_DAYS',
] as const;

export interface QuestionSpec {
  batch?: number;
  required?: boolean;
  consent?: boolean;
  /** Silent consent: resolved from `default` at install time, NEVER prompted.
   * Used for consents where installing gbrain-for-your-agent is itself the
   * consent and the alternative defeats the product (per-turn hooks, search
   * mode). Off-ramps (a `--flag`, `GBRAIN_HOOKS=0`, `gbrain search modes`)
   * replace the prompt. */
  silent?: boolean;
  phase?: string;
  question?: string;
  default?: string;
  allowed?: string[];
  maxLength: number;
  rejectValues?: string[];
  shape?: 'list';
  /** persist:false keys (PROVIDER_KEY) NEVER touch state/interview.json [CX2-13]. */
  persist?: boolean;
  sink?: 'config';
  pushIfVague?: string;
}

export interface QuestionBank {
  version: number;
  maxQuestions: number;
  interviewKeys: string[];
  consentKeys: string[];
  questions: Record<string, QuestionSpec>;
}

let bankCache: QuestionBank | null = null;

export function loadQuestionBank(): QuestionBank {
  if (!bankCache) {
    bankCache = JSON.parse(readFileSync(QUESTIONS_JSON as unknown as string, 'utf8')) as QuestionBank;
  }
  return bankCache;
}
