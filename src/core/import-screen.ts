/**
 * #5988: the one content screen every ingestion path shares. It decides,
 * without preparing or writing anything, whether content is importable or a
 * deterministic content refusal (size, unreadable or ambiguous frontmatter,
 * a frontmatter slug that names another page, a content-sanity reject, and on
 * coordinated paths a facts or takes fence the canonical projection would
 * refuse, #6188). Managed sync freezes, managed sync and import publication,
 * and `importFromContent` (put_page, capture, legacy import) all call it, so a
 * file is held or refused for the same reason everywhere.
 */
import type { BrainEngine } from './engine.ts';
import { loadConfig, loadConfigWithEngine } from './config.ts';
import { assessContentSanity, type ContentSanityResult } from './content-sanity.ts';
import { dropClassifierMarkers, hasCurrentQuarantineOverride, QUARANTINE_OVERRIDE_KEY, withQuarantineOverride } from './quarantine-override.ts';
import { CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';
import { ATOMS_SCAN_HASH_KEY } from './utils.ts';
import { loadOperatorLiterals } from './content-sanity-literals.ts';
import { classifyImportHold, contentSizeHold, parseMarkdown, type ContentHold, type ParseOpts, type ParsedMarkdown } from './markdown.ts';
import { isCodeFilePath } from './sync.ts';
import { opError, type OperationError } from './ops/contract.ts';
import type { Action } from './agent-output.ts';
import { fenceFixText, fenceLocationFromMessage, fenceRefusal } from './fence-repair/refusal.ts';
import type { FenceMessageLocation } from './fence-repair/reasons.ts';
import { fenceIssuesWire, fenceStep, type FenceIssueWire } from './fence-repair/tier1.ts';
import type { FenceCtx, FenceFix, FencePage, FenceReason } from './fence-repair/types.ts';
import { effectiveVisibility } from './search/private-visibility.ts';

export const MAX_FILE_SIZE = 5_000_000; // 5MB

type ContentSanityConfig = NonNullable<NonNullable<ReturnType<typeof loadConfig>>['content_sanity']>;

export interface ImportSanityConfig {
  cs: ContentSanityConfig;
  disabled: boolean;
  extraLiterals: ReturnType<typeof loadOperatorLiterals>;
  junkDisposition: 'quarantine' | 'reject';
}

/**
 * Effective content-sanity config: env > file > DB > defaults. A transient
 * engine error falls back to file/env values. `GBRAIN_NO_SANITY=1` is read
 * directly because loadConfig() is null on config-less PGLite setups.
 */
export async function loadImportSanityConfig(engine: BrainEngine): Promise<ImportSanityConfig> {
  const baseCfg = loadConfig();
  let effectiveCfg = baseCfg;
  try {
    effectiveCfg = await loadConfigWithEngine(engine, baseCfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] content-sanity: DB config lift failed (${msg}); falling back to file/env\n`);
  }
  const cs = effectiveCfg?.content_sanity ?? {};
  const disabled = cs.disabled === true || process.env.GBRAIN_NO_SANITY === '1';
  return {
    cs, disabled,
    extraLiterals: cs.junk_patterns_enabled !== false && !disabled ? loadOperatorLiterals() : [],
    junkDisposition: cs.junk_disposition === 'reject' ? 'reject' : 'quarantine',
  };
}

/** Frontmatter keys only the content-quality gate, the extract_atoms phase and the operator's clear may set. */
export const GATE_OWNED_FRONTMATTER_KEYS = [QUARANTINE_KEY, CONTENT_FLAG_KEY, EMBED_SKIP_KEY, ATOMS_SCAN_HASH_KEY, QUARANTINE_OVERRIDE_KEY] as const;

/**
 * #1699/#6259 trust boundary, fail closed: incoming content loses every
 * gate-owned marker unless an owner-tier path passes `preserveGateMarkers`
 * (owner sync and file import, reindex, file repair, reconcile, the cycle
 * derivers, `quarantine clear/scan`). Otherwise any writer, a local put_page,
 * a connector or an ingest lane included, could hide a page from search
 * (`quarantine`), inject text into the agent's warning channel
 * (`content_flag.detail`), stop its embedding (`embed_skip`), suppress atom
 * mining (`atoms_scan_hash`) or forge a cleared state (`quarantine_override`).
 * A preserving path keeps its own override only while it binds the content,
 * and a current override drops classifier markers the content still carries.
 */
export function stripGateOwnedMarkers(parsed: Pick<ParsedMarkdown, 'frontmatter' | 'title' | 'type' | 'compiled_truth' | 'timeline'>, opts: { preserveGateMarkers?: boolean }): void {
  if (opts.preserveGateMarkers !== true) {
    for (const key of GATE_OWNED_FRONTMATTER_KEYS) delete parsed.frontmatter[key];
    return;
  }
  if (Object.hasOwn(parsed.frontmatter, QUARANTINE_OVERRIDE_KEY) && !hasCurrentQuarantineOverride(parsed)) delete parsed.frontmatter[QUARANTINE_OVERRIDE_KEY];
  dropClassifierMarkers(parsed as ParsedMarkdown);
}

/** #6259: a page carrying a current `quarantine_override` keeps the classifier's verdict off (see quarantine-override.ts). */
export function assessImportSanity(page: Pick<ParsedMarkdown, 'compiled_truth' | 'timeline' | 'title' | 'type'> & { frontmatter?: Record<string, unknown> }, cfg: ImportSanityConfig): ContentSanityResult {
  return withQuarantineOverride(assessContentSanity({
    compiled_truth: page.compiled_truth,
    timeline: page.timeline ?? '',
    title: page.title,
    bytes_warn: cfg.cs.bytes_warn,
    bytes_block: cfg.cs.bytes_block,
    max_markup_ratio: cfg.cs.max_markup_ratio,
    prose_check_enabled: cfg.cs.prose_check_enabled,
    page_kind: page.type,
    extra_literals: cfg.extraLiterals,
    // #4702: the file plane is hand-edited JSON.
    disabled_patterns: Array.isArray(cfg.cs.disabled_patterns) ? cfg.cs.disabled_patterns : undefined,
  }), page);
}

/**
 * A refusal the screen returns: a hold code, `content_rejected` for an
 * operator-configured sanity reject, or `invalid_fence` (coordinated paths)
 * with its location-only `fence`.
 */
export interface ContentRefusal extends Omit<ContentHold, 'code' | 'reason'> {
  code: ContentHold['code'] | 'content_rejected' | 'invalid_fence';
  reason?: ContentHold['reason'] | FenceReason;
  fence?: FenceMessageLocation;
  /** #6188 (D18): every issue that blocks the write, location and class only. */
  fence_issues?: FenceIssueWire[];
}

/**
 * #6188: what the fence step decided for importable content. Absent when the
 * fences compile (or the page has none). `fixes` non-empty: Tier 1 rewrote
 * `before` into `after`. `issues` non-empty (lenient paths only): a residual
 * fence imported as written, reported as a warning.
 */
export interface FenceScreen {
  before: FencePage;
  after: FencePage;
  fixes: FenceFix[];
  issues: FenceIssueWire[];
}

/** The Tier 1 context a screen knows without the database: page visibility and the pack's takes kinds. */
export function screenFenceCtx(page: Pick<ParsedMarkdown, 'type' | 'frontmatter'>, activePack?: ParseOpts['activePack']): FenceCtx {
  const kinds = (activePack as { takes_kinds?: readonly string[] } | undefined)?.takes_kinds;
  return { pageVisibility: effectiveVisibility({ kind: 'page', page }), ...(kinds?.length ? { takesPackKinds: kinds } : {}) };
}

export interface ImportScreenInput {
  /** The decoded text exactly as it would be imported. */
  content: string;
  /** Filename for parsing; it also decides code vs Markdown. */
  path: string;
  /** Raw byte length when the bytes differ from the UTF-8 encoding of `content`. */
  byteLength?: number;
  expectedSlug?: string | null;
  slugExempt?: (declared: string) => boolean;
  slugConflictMessage?: (found: string, expected: string) => string;
  activePack?: ParseOpts['activePack'];
  /**
   * The working tree already holds bytes whose import equals the current
   * page (a repaired file published but not yet committed). Checked before
   * any content refusal, so such a file is never refused or held.
   */
  published?: () => boolean;
  /** Pre-loaded config: a junk hit under `junk_disposition: reject` refuses as `content_rejected`. */
  sanity?: ImportSanityConfig;
  /**
   * #6188 (E8): the fence step. Both modes run Tier 1 on a fence the canonical
   * projection would refuse and admit what it fixes (`fences` on the result).
   * A residual fence refuses `invalid_fence` with `fence_issues` on
   * `coordinated` paths (managed sync, managed import, managed file repair,
   * put_page) and is importable with the issues as a warning on `lenient`
   * paths (legacy sync, `importFromFile`, direct content imports). Unset:
   * no fence step.
   */
  fences?: 'coordinated' | 'lenient';
  /** #6188: `fences.normalize`; false treats a fixable fence as residual. Default true. */
  normalize?: boolean;
}

export type ImportScreenResult =
  | { status: 'published' }
  | { status: 'importable'; parsed: ParsedMarkdown | null; fences?: FenceScreen }
  | { status: 'refused'; refusal: ContentRefusal };

/** The screen admitted content because Tier 1 rewrote a fence (callers then read `fences.normalize`). */
export function screenNormalized(result: ImportScreenResult): boolean {
  return result.status === 'importable' && !!result.fences?.fixes.length;
}

export function screenImportContent(input: ImportScreenInput): ImportScreenResult {
  if (input.published?.()) return { status: 'published' };
  const codeFile = isCodeFilePath(input.path);
  const size = contentSizeHold(input.byteLength ?? Buffer.byteLength(input.content, 'utf-8'), MAX_FILE_SIZE, codeFile);
  if (size) return { status: 'refused', refusal: size };
  if (codeFile) return { status: 'importable', parsed: null };
  const parsed = parseMarkdown(input.content, input.path, { validate: true, ...(input.activePack ? { activePack: input.activePack } : {}) });
  const hold = classifyImportHold(parsed, { expectedSlug: input.expectedSlug, slugExempt: input.slugExempt, slugConflictMessage: input.slugConflictMessage });
  if (hold) return { status: 'refused', refusal: hold };
  let fences: FenceScreen | undefined;
  if (input.fences) {
    const before = { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '' };
    const step = fenceStep(before, screenFenceCtx(parsed, input.activePack), { normalize: input.normalize !== false });
    if (step.status === 'residual') {
      const issues = fenceIssuesWire([...step.issues, ...step.fixable]);
      if (input.fences === 'coordinated') return { status: 'refused', refusal: { ...fenceRefusal(step.location), fence_issues: issues } };
      fences = { before, after: before, fixes: [], issues };
    } else if (step.status === 'normalized') {
      fences = { before, after: step.page, fixes: step.fixes, issues: [] };
    }
  }
  if (input.sanity && !input.sanity.disabled && input.sanity.junkDisposition === 'reject') {
    const result = assessImportSanity(parsed, input.sanity);
    if (result.shouldQuarantine) return { status: 'refused', refusal: { code: 'content_rejected', message: `Content rejected by sanity gate: ${result.reason_messages.join('; ')}` } };
  }
  return { status: 'importable', parsed, ...(fences ? { fences } : {}) };
}

/**
 * The typed refusal a publication path throws. `legacy_error` keeps the wire
 * `error` the site always returned, so stored receipts keep matching
 * `isContentRefusal`. `detail` names the key and line, never a value.
 */
export function contentRefusalError(refusal: ContentRefusal, suggestion: string, opts: { legacy_error?: string; fix?: Action } = {}): OperationError {
  const where = [refusal.key ? `key ${refusal.key}` : '', refusal.line !== undefined ? `line ${refusal.line}` : ''].filter(Boolean).join(', ');
  const error = opError(refusal.code, refusal.message, suggestion, {
    ...(refusal.reason ? { reason: refusal.reason } : {}), ...(where ? { detail: where } : {}), ...opts,
  });
  if (refusal.fence) error.fence = { ...refusal.fence };
  if (refusal.fence_issues?.length) error.fenceIssues = refusal.fence_issues.map(issue => ({ ...issue }));
  return error;
}

/**
 * A stored receipt only keeps the wire code and message. Recover the typed
 * refusal from them (the message names the cause, key and line), so a
 * replayed or awaited write reports the same code, reason and next step.
 */
export function contentRefusalFromReceipt(code: string | null | undefined, message: string | null | undefined): (Omit<ContentRefusal, 'message'> & { suggestion: string }) | null {
  if (!isContentRefusal(code, message)) return null;
  const text = message ?? '';
  const fence = fenceLocationFromMessage(code, text);
  if (fence) return { code: 'invalid_fence', reason: fence.reason, ...(fence.fence && fence.section ? { fence: fence as FenceMessageLocation } : {}),
    suggestion: `The content itself was refused, so resubmitting it unchanged refuses again. ${fenceFixText(fence)} Then submit the corrected content with a new request_id.` };
  const key = /key "([^"\n]{1,200})"/.exec(text)?.[1];
  const lineText = /\bat line (\d+)/.exec(text)?.[1];
  const line = lineText === undefined ? undefined : Number(lineText);
  const typed = CONTENT_REFUSAL_CODES.has(code!) ? code as ContentRefusal['code']
    : /^Invalid YAML frontmatter/.test(text) ? 'invalid_frontmatter'
    : /slug/.test(text) ? 'frontmatter_slug_conflict'
    : /PAGE_JUNK_PATTERN/.test(text) ? 'content_rejected' : 'file_too_large';
  const reason = typed !== 'invalid_frontmatter' ? undefined
    : /ambiguous protected key/.test(text) ? 'ambiguous_protected_key' as const
    : /ambiguous identity key/.test(text) ? 'ambiguous_identity_key' as const
    : /continues on unquoted lines|appears more than once|opens \[ or \{/.test(text) ? 'needs_interpretation' as const : 'yaml_parse' as const;
  const where = line !== undefined ? `frontmatter line ${line}${key ? ` (key "${key}")` : ''}` : 'the frontmatter';
  const suggestion = typed === 'invalid_frontmatter' ? `The content itself was refused, so resubmitting it unchanged refuses again. Correct ${where}: one line per key with its whole value quoted, then submit the corrected content with a new request_id.`
    : typed === 'frontmatter_slug_conflict' ? 'The content declares a slug that conflicts with its path. Remove the `slug:` line or make it match, then submit with a new request_id.'
    : typed === 'content_rejected' ? 'The content-sanity gate rejects this content under the operator\'s junk_disposition=reject setting. Remove the matched junk, then submit with a new request_id.'
    : 'The content is over the import size limit. Split it into smaller pages, then submit each with its own request_id.';
  return { code: typed, ...(reason ? { reason } : {}), ...(key ? { key } : {}), ...(line !== undefined ? { line } : {}), suggestion };
}

const CONTENT_REFUSAL_CODES = new Set(['invalid_frontmatter', 'frontmatter_slug_conflict', 'file_too_large', 'content_rejected']);
const LEGACY_CONTENT_MESSAGES: Array<[code: string, pattern: RegExp]> = [
  ['invalid_params', /^Invalid YAML frontmatter(?::| at line \d| in )/],
  ['invalid_params', /^The frontmatter slug "[^"\n]*" in [^\n]+ conflicts with its path, which expects slug "[^"\n]*"\./],
  ['invalid_params', /^Frontmatter slug "[^"\n]*" does not match path-derived slug "[^"\n]*"/],
  ['invalid_params', /^Content too large \(\d+ bytes, max \d+\)/],
  ['invalid_params', /^File too large \(/],
  ['invalid_params', /^Code file too large \(\d+ bytes\)/],
  ['request_too_large', /^Sync file exceeds the bounded import size\.$/],
  ['storage_error', /^Publication failed \(PAGE_JUNK_PATTERN\)\. Inspect owner diagnostics\.$/],
];

/**
 * True when a stored refusal (receipt `error_code` + `error_message`) is a
 * deterministic content refusal no retry can fix: the new typed codes, the
 * #6188 fence grammar (`Fence <reason>: ...` under wire `invalid_params` or
 * `take_row_collision`), and the exact strings older gbrain versions stored
 * for the same causes. Cursor-size and admission-capacity
 * `request_too_large`, every transient or conflict code, and any other
 * `invalid_params` message never match.
 */
export function isContentRefusal(code: string | null | undefined, message: string | null | undefined): boolean {
  if (!code) return false;
  if (CONTENT_REFUSAL_CODES.has(code)) return true;
  const text = message ?? '';
  return LEGACY_CONTENT_MESSAGES.some(([legacy, pattern]) => legacy === code && pattern.test(text)) || fenceLocationFromMessage(code, text) !== null;
}
