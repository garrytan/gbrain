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
import { loadConfigSnapshot } from './config-snapshot.ts';
import { assessContentSanity, ContentSanityBlockError, type ContentSanityResult } from './content-sanity.ts';
import { carryStoredQuarantineOverride, dropClassifierMarkers, hasCurrentQuarantineOverride, QUARANTINE_OVERRIDE_KEY, withQuarantineOverride } from './quarantine-override.ts';
import { logContentSanityAssessment } from './audit/content-sanity-audit.ts';
import { buildEmbedSkipMarker, EMBED_SKIP_KEY } from './embed-skip.ts';
import { buildContentFlagMarker, buildQuarantineMarker, CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';
import { ATOMS_SCAN_HASH_KEY } from './utils.ts';
import { applyTrustAllowRules } from './trust/allow-rules.ts';
import {
  assessPageForGate, DEFAULT_WRITE_GATE_CONFIG, parseWriteGateConfig, writeGateDetail, writeGateRejectedError,
  type WriteGateAssessment, type WriteGateConfig, type WriteGateInput,
} from './write-gate.ts';
import { clearStalePageGateReceipts, recordPageGateReceipt } from './write-gate-store.ts';
import { loadOperatorLiterals } from './content-sanity-literals.ts';
import { classifyImportHold, contentSizeHold, parseMarkdown, type ContentHold, type ParseOpts, type ParsedMarkdown } from './markdown.ts';
import { isCodeFilePath } from './sync.ts';
import { contentHash } from './utils.ts';
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
  /** #5575 `write_gate.external_mode` / `write_gate.agent_mode` (DB plane, local-only); absent = defaults. */
  writeGate?: WriteGateConfig;
}

/**
 * Effective content-sanity config: env > file > DB > defaults. A transient
 * engine error falls back to file/env values. `GBRAIN_NO_SANITY=1` is read
 * directly because loadConfig() is null on config-less PGLite setups. The
 * write-gate keys ride the same lift; an unreadable value falls back to the
 * defaults (flag for both), never to `off`.
 */
export async function loadImportSanityConfig(engine: BrainEngine): Promise<ImportSanityConfig> {
  const baseCfg = loadConfig();
  let effectiveCfg = baseCfg;
  // One whole-table read answers the DB config lift and the write-gate keys (#6007 statement budget).
  const snapshot = await loadConfigSnapshot(engine);
  const reader = snapshot ? {
    getConfig: async (key: string) => snapshot[key] ?? null,
    getAllConfig: async () => snapshot,
    listConfigKeys: async (prefix: string) => Object.keys(snapshot).filter(key => key.startsWith(prefix)),
  } : engine;
  const readKey = async (key: string) => { try { return await reader.getConfig(key); } catch { return null; } };
  const gateKeys = Promise.all([readKey('write_gate.external_mode'), readKey('write_gate.agent_mode')]);
  try {
    effectiveCfg = await loadConfigWithEngine(reader, baseCfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] content-sanity: DB config lift failed (${msg}); falling back to file/env\n`);
  }
  const [externalMode, agentMode] = await gateKeys;
  const cs = effectiveCfg?.content_sanity ?? {};
  const disabled = cs.disabled === true || process.env.GBRAIN_NO_SANITY === '1';
  return {
    cs, disabled,
    extraLiterals: cs.junk_patterns_enabled !== false && !disabled ? loadOperatorLiterals() : [],
    junkDisposition: cs.junk_disposition === 'reject' ? 'reject' : 'quarantine',
    writeGate: parseWriteGateConfig({ external_mode: externalMode, agent_mode: agentMode }),
  };
}

export interface ContentDispositionContext {
  slug: string;
  sourceId?: string;
  /** The incoming gate-owned markers were stripped (no `preserveGateMarkers`): a stored quarantine override may be carried (quarantine-override.ts). */
  stripped: boolean;
  /** #5575: tier and origin of this write; absent skips the write gate. */
  writeGate?: WriteGateInput;
}

export interface ContentDisposition {
  quarantined: boolean;
  flagged: boolean;
  flagReason?: 'markup_heavy' | 'oversized' | 'instruction_like';
  /** The write-gate assessment, when the caller passed `writeGate`. */
  gate: WriteGateAssessment | null;
  /** Records the gate's flag/quarantine receipt for the written page inside the publication transaction. */
  persistReceipt: (tx: BrainEngine, page: { existed: boolean }) => Promise<void>;
}

/**
 * The page disposition `importFromContent` applies before hashing: the v0.41
 * content-sanity gate (#1699) and the #5575 write gate, most severe wins.
 * Runs after parseMarkdown and the guardrail seam, before the hash compute,
 * so a marker it sets (`embed_skip`, `quarantine`, `content_flag`) reaches
 * the hash and the page write never short-circuits on hash equality.
 *
 * Content sanity:
 *   - kill-switch (`content_sanity.disabled` / `GBRAIN_NO_SANITY=1`): assess
 *     and audit as a bypass, loud stderr per offending ingest, write anyway.
 *   - hard-block (junk pattern or operator literal) under
 *     `junk_disposition: reject`: throw ContentSanityBlockError, the single
 *     throw point every wrapper (import errors, put_page envelope, sync
 *     failure record) already handles; otherwise quarantine (hidden, zero
 *     chunks, reviewable via `gbrain quarantine list`).
 *   - soft-block (oversize without a junk hit): `embed_skip` plus a
 *     `content_flag`, so chunks stay empty and old chunks are purged.
 *   - markup-heavy: `content_flag`, page stays searchable.
 * Write gate (only with `ctx.writeGate`; its own `write_gate.*` switches):
 *   - reject: throw `write_gate_rejected`.
 *   - quarantine: `quarantine` marker (reason `instruction_like`) unless
 *     content sanity already quarantined the page.
 *   - flag: `content_flag` (reason `instruction_like`) unless quarantined.
 *   - a write the gate allows drops a stale `instruction_like` marker.
 * Effective config: env > file > DB > defaults, read once per import with the
 * write-gate keys in the same lift (`loadImportSanityConfig`).
 */
export async function settleContentDisposition(engine: BrainEngine, parsed: ParsedMarkdown, ctx: ContentDispositionContext): Promise<ContentDisposition> {
  const { slug, sourceId } = ctx;
  let pageQuarantined = false;
  let pageFlagged = false;
  let pageFlagReason: ContentDisposition['flagReason'];
  const sanityCfg = await loadImportSanityConfig(engine);
  const sanityDisabled = sanityCfg.disabled;
  // Disposition for the high-confidence junk path: quarantine (hide) by
  // default, or reject (throw → sync-failure) when the operator opts in.
  const junkDisposition = sanityCfg.junkDisposition;
  const sanityResult = await carryStoredQuarantineOverride(engine, parsed, assessImportSanity(parsed, sanityCfg), { slug, sourceId, stripped: ctx.stripped });
  if (!sanityDisabled && !sanityResult.shouldQuarantine && sanityResult.flag_reason !== 'oversized' && (parsed.frontmatter[EMBED_SKIP_KEY] as { reason?: unknown } | undefined)?.reason === 'oversized') {
    delete parsed.frontmatter[EMBED_SKIP_KEY];
    if ((parsed.frontmatter[CONTENT_FLAG_KEY] as { reason?: unknown } | undefined)?.reason === 'oversized') delete parsed.frontmatter[CONTENT_FLAG_KEY];
  }

  if (sanityDisabled) {
    // Kill-switch active: loud stderr per offending ingest. Operator
    // explicitly opted into the bypass and gets noisy feedback every
    // time it fires so they remember the gate is off. Audit as a
    // bypass (page lands regardless).
    logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
      bypass: true,
    });
    if (sanityResult.shouldQuarantine || sanityResult.shouldFlag) {
      process.stderr.write(
        `[gbrain] content-sanity bypass (GBRAIN_NO_SANITY=1): ${slug} — ${sanityResult.reason_messages.join('; ')}\n`,
      );
    }
  } else if (sanityResult.shouldQuarantine) {
    // High-confidence junk (Cloudflare/CAPTCHA pattern or operator
    // literal). The detail names which fired.
    const detail = [
      ...sanityResult.junk_pattern_matches,
      ...sanityResult.literal_substring_matches,
    ].join(', ');
    const reason = sanityResult.junk_pattern_matches.length > 0
      ? 'junk_pattern'
      : 'literal_substring';
    if (junkDisposition === 'reject') {
      // Operator opted into hard-block. Throw with PAGE_QUARANTINE so
      // classifyErrorCode bins it. Existing exception flow at every
      // wrapper site (import errors counter, put_page MCP envelope,
      // sync failure record) fires through this single throw point.
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        disposition: 'reject',
      });
      throw new ContentSanityBlockError(sanityResult);
    }
    // Default: quarantine (hide). Page lands with the marker, writes
    // zero chunks (chunking guard below widens to isQuarantined), is
    // excluded from search via QUARANTINE_FILTER_FRAGMENT, reviewable
    // via get_page / `gbrain quarantine list`.
    parsed.frontmatter[QUARANTINE_KEY] = buildQuarantineMarker(reason, detail, {
      bytes: sanityResult.bytes,
    });
    pageQuarantined = true;
    logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
      disposition: 'quarantine',
    });
    process.stderr.write(
      `[gbrain] content-sanity quarantine: ${slug} — ${detail} (hidden from search, reviewable via 'gbrain quarantine list')\n`,
    );
  } else if (sanityResult.shouldFlag) {
    // Fuzzy markup-heavy OR oversize. The page stays usable; the agent
    // gets warned (Garry's paradigm — "this is odd, you decide").
    const flagReason = sanityResult.flag_reason!; // non-null when shouldFlag
    const flagDetail = sanityResult.reason_messages.join('; ');
    parsed.frontmatter[CONTENT_FLAG_KEY] = buildContentFlagMarker(flagReason, flagDetail, {
      ...(sanityResult.markup_ratio !== null ? { markup_ratio: sanityResult.markup_ratio } : {}),
      bytes: sanityResult.bytes,
    });
    pageFlagged = true;
    pageFlagReason = flagReason;
    if (flagReason === 'oversized') {
      // Oversize also skips embedding (existing embed_skip marker). The
      // chunking guard below honors it; tx.deleteChunks purges old chunks.
      parsed.frontmatter[EMBED_SKIP_KEY] = buildEmbedSkipMarker(sanityResult.bytes);
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        disposition: 'soft_block',
      });
      // #3893 (reimplemented from @y2688): console.warn, not bare stderr —
      // soft_block silently drops embedding, and console-level warns are
      // what operator log hooks and collectors can observe.
      console.warn(
        `[gbrain] content-sanity flag (oversized): ${slug} (${sanityResult.bytes} bytes) — page lands, embedding skipped, agent warned`,
      );
    } else {
      // markup_heavy: page ingests NORMALLY (keeps chunks, embeds). The
      // content_flag marker rides along for the agent warning.
      logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
        disposition: 'flag',
      });
      process.stderr.write(
        `[gbrain] content-sanity flag (markup_heavy): ${slug} (ratio ${sanityResult.markup_ratio?.toFixed(2)}) — stays searchable, agent warned\n`,
      );
    }
  } else if (sanityResult.reasons.includes('oversize_warn')) {
    // Warn tier: page lands normally; lint surface picks up too.
    logContentSanityAssessment(slug, sourceId ?? 'default', sanityResult, {
      disposition: 'warn',
    });
    process.stderr.write(
      `[gbrain] content-sanity warn: ${slug} (${sanityResult.bytes} bytes) — exceeds warn threshold, consider splitting\n`,
    );
  }
  const gate = ctx.writeGate ? await applyTrustAllowRules(engine, assessPageForGate(parsed, ctx.writeGate, sanityCfg.writeGate ?? DEFAULT_WRITE_GATE_CONFIG),
    { sourceId: sourceId ?? 'default', sourceUri: ctx.writeGate.origin?.source_uri ?? null }) : null;
  if (gate) {
    if (gate.verdict === 'reject') throw writeGateRejectedError(gate);
    const detail = writeGateDetail(gate);
    for (const key of [QUARANTINE_KEY, CONTENT_FLAG_KEY]) {
      if ((parsed.frontmatter[key] as { reason?: unknown } | undefined)?.reason === 'instruction_like') delete parsed.frontmatter[key];
    }
    if (gate.verdict === 'quarantine' && !pageQuarantined) {
      parsed.frontmatter[QUARANTINE_KEY] = buildQuarantineMarker('instruction_like', detail);
      pageQuarantined = true;
      process.stderr.write(`[gbrain] ${detail}: ${slug} quarantined (hidden from search, reviewable via 'gbrain quarantine list')\n`);
    } else if (gate.verdict === 'flag' && !pageQuarantined) {
      parsed.frontmatter[CONTENT_FLAG_KEY] = buildContentFlagMarker('instruction_like', detail);
      pageFlagged = true;
      pageFlagReason = 'instruction_like';
    }
  }
  return {
    quarantined: pageQuarantined, flagged: pageFlagged, ...(pageFlagReason ? { flagReason: pageFlagReason } : {}), gate,
    persistReceipt: async (tx, page) => {
      // A page created by this write has a fresh id, so no receipt can name it yet (#6007: no delete on create).
      if (gate?.ran && page.existed) await clearStalePageGateReceipts(tx, { slug, sourceId: sourceId ?? 'default', contentHash: gate.contentHash });
      if (gate) await recordPageGateReceipt(tx, { slug, sourceId: sourceId ?? 'default', assessment: gate, requestId: ctx.writeGate?.requestId ?? null });
    },
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
  code: ContentHold['code'] | 'content_rejected' | 'invalid_fence' | 'purged_content' | 'write_gate_rejected';
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
  /** #5575: the source's page purge tombstones (content hash -> purged slug), prefetched by the caller. */
  purgedPages?: ReadonlyMap<string, string>;
  /** #5575: tier and origin of this write; under `write_gate.external_mode: reject` (from `sanity`) a gate reject refuses `write_gate_rejected`. */
  writeGate?: WriteGateInput;
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
  const purgedAs = input.purgedPages?.size ? input.purgedPages.get(contentHash(parsed)) : undefined;
  if (purgedAs !== undefined) return { status: 'refused', refusal: { code: 'purged_content',
    message: `${input.path} carries the content of page ${purgedAs}, which the owner purged; it was not imported.` } };
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
  if (input.writeGate?.tier === 'external_untrusted' && input.sanity?.writeGate?.externalMode === 'reject') {
    const gate = assessPageForGate(parsed, input.writeGate, input.sanity.writeGate);
    if (gate.verdict === 'reject') return { status: 'refused', refusal: { code: 'write_gate_rejected', message: writeGateRejectedError(gate).message } };
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
    : /PAGE_JUNK_PATTERN/.test(text) ? 'content_rejected' : /which the owner purged/.test(text) ? 'purged_content' : 'file_too_large';
  const reason = typed !== 'invalid_frontmatter' ? undefined
    : /ambiguous protected key/.test(text) ? 'ambiguous_protected_key' as const
    : /ambiguous identity key/.test(text) ? 'ambiguous_identity_key' as const
    : /continues on unquoted lines|appears more than once|opens \[ or \{/.test(text) ? 'needs_interpretation' as const : 'yaml_parse' as const;
  const where = line !== undefined ? `frontmatter line ${line}${key ? ` (key "${key}")` : ''}` : 'the frontmatter';
  const suggestion = typed === 'invalid_frontmatter' ? `The content itself was refused, so resubmitting it unchanged refuses again. Correct ${where}: one line per key with its whole value quoted, then submit the corrected content with a new request_id.`
    : typed === 'frontmatter_slug_conflict' ? 'The content declares a slug that conflicts with its path. Remove the `slug:` line or make it match, then submit with a new request_id.'
    : typed === 'content_rejected' ? 'The content-sanity gate rejects this content under the operator\'s junk_disposition=reject setting. Remove the matched junk, then submit with a new request_id.'
    : typed === 'purged_content' ? 'This content was purged by the owner and stays out of the brain. Do not resubmit it; write new content, or ask the user to clear the tombstone on the brain host (gbrain pages unpurge).'
    : typed === 'write_gate_rejected' ? 'The write gate refuses this external instruction-like content under the operator\'s write_gate.external_mode=reject setting, so it refuses on every retry. Tell the user; changing that setting is their decision.'
    : 'The content is over the import size limit. Split it into smaller pages, then submit each with its own request_id.';
  return { code: typed, ...(reason ? { reason } : {}), ...(key ? { key } : {}), ...(line !== undefined ? { line } : {}), suggestion };
}

const CONTENT_REFUSAL_CODES = new Set(['invalid_frontmatter', 'frontmatter_slug_conflict', 'file_too_large', 'content_rejected', 'purged_content', 'write_gate_rejected']);
const LEGACY_CONTENT_MESSAGES: Array<[code: string, pattern: RegExp]> = [
  ['invalid_params', /^Invalid YAML frontmatter(?::| at line \d| in )/],
  ['invalid_params', /^The frontmatter slug "[^"\n]*" in [^\n]+ conflicts with its path, which expects slug "[^"\n]*"\./],
  ['invalid_params', /^Frontmatter slug "[^"\n]*" does not match path-derived slug "[^"\n]*"/],
  ['invalid_params', /^Content too large \(\d+ bytes, max \d+\)/],
  ['invalid_params', /^File too large \(/],
  ['invalid_params', /^[^\n]+ carries the content of page [^\n]+, which the owner purged; it was not imported\.$/],
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
