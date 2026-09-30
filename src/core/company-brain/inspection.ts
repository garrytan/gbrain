import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseDataFrontmatter } from '../data-frontmatter.ts';
import { parseMarkdown } from '../markdown.ts';
import { extractEntityRefs, LINK_EXTRACTOR_VERSION_TS, unwrapWikilink } from '../link-extraction.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { buildSourceLocalReferenceIndex, frontmatterReferenceHints } from '../source-local-reference-index.ts';
import { slugifyPath } from '../sync.ts';
import { OperationError } from '../ops/contract.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';
import { EMBED_SKIP_KEY } from '../embed-skip.ts';
import { loadResolvedPackByName } from '../schema-pack/load-active.ts';
import { invalidatePackCache, type ResolvedPack } from '../schema-pack/registry.ts';
import { SchemaPackManifestSchema } from '../schema-pack/manifest-v1.ts';
import { runFilePlaneLintRules } from '../schema-pack/lint-rules.ts';
import { inspectUncommitted, inspectionLimits, inventoryCommittedRevision, readCommittedBlob, resolveCommittedRevision, safeRepositoryPath } from './revision.ts';
import {
  COMPANY_BRAIN_MAX_METADATA_BYTES, COMPANY_BRAIN_PLAN_VERSION, COMPANY_BRAIN_PROFILE,
  type CompanyBrainPlan, type InspectCompanyBrainOptions, type InspectionEntry, type InspectionFinding,
  type InspectionPage, type InspectionReference, type PlanValidationResult,
} from './types.ts';

const scaffoldFiles = new Set(['readme.md', 'agents.md', 'claude.md', 'resolver.md', 'skill.md', 'changelog.md', 'contributing.md', 'license', 'license.md', 'license.txt', 'package.json', 'bun.lock', 'gbrain.yml']);
const scaffoldDirectories = new Set(['skills', 'scripts', 'templates', 'schema', 'schema-packs', 'node_modules']);
const distinctiveTypes = new Set(['customer', 'competitor', 'supplier', 'distributor', 'decision', 'weekly', 'strategy', 'sales', 'brand', 'ops', 'finance', 'runbook']);

function canonical(value: unknown, maxBytes = COMPANY_BRAIN_MAX_METADATA_BYTES): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 2_000_000 || depth > 40) throw new OperationError('request_too_large', 'Metadata is too deeply nested or complex.');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > maxBytes) throw new OperationError('request_too_large', 'Metadata exceeds its byte limit.');
      return item;
    }
    if (item instanceof Date) return item.toISOString();
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new OperationError('invalid_params', 'Metadata must be finite, acyclic JSON data.');
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(value => visit(value, depth + 1));
    else {
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new OperationError('invalid_params', 'Unsafe metadata key.');
        bytes += Buffer.byteLength(key);
        output[key] = visit((item as Record<string, unknown>)[key], depth + 1);
      }
      result = output;
    }
    seen.delete(item);
    return result;
  };
  const encoded = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(encoded) > maxBytes) throw new OperationError('request_too_large', 'Metadata exceeds its byte limit; narrow selection.');
  return encoded;
}

export function companyBrainDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function resolvedCompanySchemaDigest(pack: ResolvedPack): string {
  return companyBrainDigest(pack.manifest);
}

function patterns(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 256 || values.some(value => typeof value !== 'string' || value.length > 1024 ||
    !safeRepositoryPath(value.replace(/\/$/, '')) || value.startsWith('!'))) {
    throw new OperationError('invalid_params', 'Selection must use bounded repository-relative globs without traversal or negation.');
  }
  return [...new Set(values.map(value => value.endsWith('/') ? `${value}**` : value))].sort();
}

function selectionPolicy(include: string[], exclude: string[]): (path: string) => string | null {
  const includes = include.map(pattern => new Bun.Glob(pattern));
  const excludes = exclude.map(pattern => new Bun.Glob(pattern));
  return path => {
    if (excludes.some(glob => glob.match(path))) return 'explicit_exclude';
    if (includes.length) return includes.some(glob => glob.match(path)) ? null : 'outside_include';
    const parts = path.split('/');
    if (parts.some(part => part.startsWith('.')) || parts.slice(0, -1).some(part => scaffoldDirectories.has(part.toLowerCase())) ||
      scaffoldFiles.has(parts.at(-1)!.toLowerCase())) return 'profile_scaffolding';
    return null;
  };
}

function finding(plan: CompanyBrainPlan, severity: InspectionFinding['severity'], code: string, message: string, path?: string, line?: number): void {
  const item: InspectionFinding = { severity, code, message };
  if (path !== undefined) item.path = path;
  if (line !== undefined) item.line = line;
  plan.findings.push(item);
}

function readPage(content: string, entry: InspectionEntry, plan: CompanyBrainPlan, pack: ResolvedPack | null): void {
  const path = entry.path;
  const raw = parseDataFrontmatter(content).data;
  canonical(raw, Math.min(plan.limits.maxMetadataBytes, 256 * 1024));
  if (Object.hasOwn(raw, QUARANTINE_KEY) || Object.hasOwn(raw, EMBED_SKIP_KEY)) {
    entry.disposition = 'unsupported';
    entry.reason = 'hidden_input';
    finding(plan, 'error', 'hidden_input', 'A reserved search-hiding marker is present. Review it or exclude this file before connecting; markers are never cleared automatically.', path);
  }
  const slug = slugifyPath(path);
  const parsed = parseMarkdown(content, path, { validate: true, expectedSlug: slug, activePack: pack?.manifest });
  for (const error of parsed.errors ?? []) {
    const warning = error.code === 'MISSING_OPEN' || error.code === 'EMPTY_FRONTMATTER';
    finding(plan, warning ? 'warning' : 'error', error.code.toLowerCase(),
      warning ? 'Typed frontmatter is missing; add explicit metadata to avoid inferred semantics.' : `Markdown validation failed (${error.code}); correct the source file before connecting.`, path, error.line);
  }
  if (!slug || !safeRepositoryPath(slug) || (typeof raw.slug === 'string' && !safeRepositoryPath(raw.slug))) {
    finding(plan, 'error', 'unsafe_slug', 'The page has no safe normalized slug.', path);
  }
  if (raw.aliases != null && !(typeof raw.aliases === 'string' || (Array.isArray(raw.aliases) && raw.aliases.every(value => typeof value === 'string')))) {
    finding(plan, 'error', 'invalid_aliases', 'Aliases must be a string or a list of strings.', path);
  }
  const aliases = normalizeAliasList(raw.aliases);
  if (aliases.some(alias => /[\x00-\x1f\x7f]/.test(alias))) finding(plan, 'error', 'invalid_aliases', 'Aliases contain control characters.', path);
  const type = parsed.type as string;
  const declaration = pack?.manifest.page_types.find(item => item.name === type);
  if (pack && !declaration) {
    entry.disposition = 'unsupported';
    entry.reason = 'unknown_type';
    finding(plan, 'error', 'schema_incompatible', 'The page type is not declared by the company schema; select a compatible schema or exclude this file.', path);
  }
  if (!parsed.typeExplicit) finding(plan, 'warning', 'inferred_type', 'Page type is inferred from the path rather than explicitly asserted.', path);
  if (declaration?.path_prefixes.length && !declaration.path_prefixes.some(prefix => path.startsWith(prefix))) {
    finding(plan, 'warning', 'nonstandard_layout', 'Explicit type is preserved outside its conventional schema directory.', path);
  }
  const audience: string[] = [];
  if (raw.audience != null) {
    const values = Array.isArray(raw.audience) ? raw.audience : [raw.audience];
    if (values.some(value => typeof value !== 'string' || value.trim() === '')) {
      finding(plan, 'error', 'restricted_audience', 'Audience metadata cannot be represented by the supported destination policy.', path);
    } else {
      audience.push(...new Set((values as string[]).map(value => value.trim().toLowerCase())));
      if (audience.some(value => !['internal', 'public', 'world'].includes(value))) {
        finding(plan, 'error', 'restricted_audience', 'This audience requires an explicit compatible destination policy; no access grant will be inferred.', path);
      }
    }
  }
  if (raw.visibility != null && !['private', 'public', 'world'].includes(String(raw.visibility))) {
    finding(plan, 'error', 'restricted_audience', 'Unrecognized visibility metadata requires a destination-policy decision.', path);
  }
  if (raw.visibility === 'private') audience.push('private');
  const verificationDate = raw.last_verified ?? raw.verified;
  let verified: string | null = null;
  if (verificationDate instanceof Date) verified = verificationDate.toISOString().slice(0, 10);
  else if (typeof verificationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(verificationDate) &&
    !Number.isNaN(Date.parse(verificationDate)) && new Date(verificationDate).toISOString().slice(0, 10) === verificationDate) verified = verificationDate;
  if (!verified) finding(plan, 'warning', 'missing_verification_date', 'No valid verification date is recorded; imported assertions are not independent verification.', path);
  if (raw.owner == null || raw.owner === '' || (Array.isArray(raw.owner) && raw.owner.length === 0)) {
    finding(plan, 'warning', 'missing_owner', 'No ownership metadata is recorded.', path);
  }
  const references: InspectionReference[] = [];
  for (const ref of extractEntityRefs(`${parsed.compiled_truth}\n${parsed.timeline}`)) {
    let target = ref.slug;
    if (ref.sameDir || ref.upLevels) {
      target = posix.join(posix.dirname(slug), '../'.repeat(ref.upLevels ?? 0), target);
    }
    const item: InspectionReference = { kind: 'markdown', target, resolution: ref.sourceId ? 'cross_source' : 'unresolved' };
    if (ref.sourceId) item.source_id = ref.sourceId;
    references.push(item);
  }
  const fields = new Map<string, string>();
  for (const mapping of pack?.manifest.frontmatter_links ?? []) {
    if (mapping.page_type === type) for (const field of mapping.fields) if (!fields.has(field)) fields.set(field, mapping.link_type);
  }
  for (const [field, linkType] of fields) {
    if (raw[field] == null) continue;
    for (const value of Array.isArray(raw[field]) ? raw[field] as unknown[] : [raw[field]]) {
      const target = typeof value === 'string' ? value : value && typeof value === 'object' ?
        (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).slug ?? (value as Record<string, unknown>).title : null;
      if (typeof target !== 'string' || !target.trim()) {
        finding(plan, 'error', 'invalid_link_metadata', 'A relationship field must contain a string or a named reference.', path);
        continue;
      }
      const unwrapped = unwrapWikilink(target);
      const qualified = /^([a-zA-Z0-9_-]+):(.+)$/.exec(unwrapped);
      const item: InspectionReference = { kind: 'frontmatter', field, link_type: linkType,
        target: qualified?.[2] ?? unwrapped, resolution: qualified ? 'cross_source' : 'unresolved' };
      if (qualified) item.source_id = qualified[1];
      references.push(item);
    }
  }
  entry.page = { slug, type, type_explicit: parsed.typeExplicit ?? false, title: parsed.title, aliases, audience, verified,
    content_sha256: createHash('sha256').update(content).digest('hex'), references };
}

function resolveReferences(plan: CompanyBrainPlan, pack: ResolvedPack | null): void {
  const slugs = new Map<string, InspectionEntry[]>();
  const index = buildSourceLocalReferenceIndex(plan.manifest.filter(entry => entry.disposition === 'included' && entry.page).map(entry => entry.page!));
  for (const entry of plan.manifest) {
    if (!entry.page) continue;
    const page = entry.page;
    const matching = slugs.get(page.slug) ?? [];
    matching.push(entry);
    slugs.set(page.slug, matching);
  }
  for (const entries of slugs.values()) if (entries.length > 1) {
    for (const entry of entries) finding(plan, 'error', 'slug_collision', 'Multiple selected paths normalize to the same page slug; rename or exclude a file.', entry.path);
  }
  for (const entry of plan.manifest) {
    if (!entry.page) continue;
    for (const alias of entry.page.aliases) {
      if (index.namedMatches(alias).length > 1) finding(plan, 'warning', 'ambiguous_alias', 'An alias or title names more than one selected page.', entry.path);
    }
    for (const ref of entry.page.references) {
      if (ref.resolution === 'cross_source') {
        finding(plan, 'warning', 'cross_source_reference', 'Cross-source references are not resolved by this profile.', entry.path);
        continue;
      }
      const hints = pack && ref.field ? frontmatterReferenceHints(pack.manifest, entry.page.type, ref.field) : undefined;
      const candidates = !safeRepositoryPath(ref.target) ? [] : ref.kind === 'frontmatter' ? index.resolveMatches(ref.target, hints) :
        index.exactMatches(slugifyPath(ref.target)).filter(slug => slug !== entry.page!.slug);
      ref.resolution = candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unresolved';
      const expectedType = ref.kind === 'frontmatter' ? pack?.manifest.link_types.find(item => item.name === ref.link_type)?.inference?.target_type : undefined;
      if (candidates.length === 1 && expectedType && slugs.get(candidates[0]!)?.[0]?.page?.type !== expectedType) {
        ref.resolution = 'unresolved';
        finding(plan, 'warning', 'target_type_mismatch', 'The relationship target does not have the type required by its field.', entry.path);
      } else if (candidates.length === 1) ref.resolved_slug = candidates[0];
      else finding(plan, 'warning', `${ref.resolution}_reference`, 'A relationship target is missing or ambiguous within the selected source.', entry.path);
    }
  }
  const supersedes = new Map<string, string[]>();
  for (const entry of plan.manifest) if (entry.page) supersedes.set(entry.page.slug, entry.page.references
    .filter(ref => ref.field === 'supersedes' && ref.resolved_slug).map(ref => ref.resolved_slug!));
  const visiting = new Set<string>();
  const complete = new Set<string>();
  for (const start of supersedes.keys()) {
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length) {
      const [slug, exit] = stack.pop()!;
      if (exit) { visiting.delete(slug); complete.add(slug); continue; }
      if (complete.has(slug)) continue;
      if (visiting.has(slug)) {
        finding(plan, 'warning', 'supersession_cycle', 'Decision supersession contains a cycle; current decision cannot be inferred.', slugs.get(slug)?.[0]?.path);
        continue;
      }
      visiting.add(slug);
      stack.push([slug, true]);
      for (const target of supersedes.get(slug) ?? []) stack.push([target, false]);
    }
  }
}

export async function inspectCompanyBrain(options: InspectCompanyBrainOptions): Promise<CompanyBrainPlan> {
  if (options.profile !== undefined && options.profile !== COMPANY_BRAIN_PROFILE) throw new OperationError('invalid_params', 'Only the company-brain profile is supported.');
  const limits = inspectionLimits(options.limits);
  const include = patterns(options.include);
  const exclude = patterns(options.exclude);
  const policy = selectionPolicy(include, exclude);
  const plan: CompanyBrainPlan = {
    schema_version: COMPANY_BRAIN_PLAN_VERSION, profile: COMPANY_BRAIN_PROFILE,
    profile_selection: options.profile === COMPANY_BRAIN_PROFILE ? 'explicit' : 'ambiguous',
    revision: null, schema: null, extractor_version: LINK_EXTRACTOR_VERSION_TS,
    selection: { include, exclude, defaults_version: 1 }, limits, manifest: [], uncommitted: [], audience_requirements: [],
    counts: { tracked: 0, included: 0, excluded: 0, unsupported: 0, dirty_eligible: 0, untracked: 0 }, findings: [], ready: false, plan_digest: '',
  };
  let pack: ResolvedPack | null = null;
  try {
    if (!options.pack) invalidatePackCache(COMPANY_BRAIN_PROFILE);
    pack = options.pack ?? await loadResolvedPackByName(COMPANY_BRAIN_PROFILE);
    SchemaPackManifestSchema.parse(pack.manifest);
    if (pack.manifest.name !== COMPANY_BRAIN_PROFILE) throw new Error();
    plan.schema = { name: pack.manifest.name, version: pack.manifest.version, identity: pack.identity, resolved_digest: resolvedCompanySchemaDigest(pack) };
    const lint = await runFilePlaneLintRules(pack.manifest);
    const lintCounts = new Map<string, { severity: InspectionFinding['severity']; count: number }>();
    for (const issue of [...lint.errors, ...lint.warnings]) {
      const previous = lintCounts.get(issue.rule);
      lintCounts.set(issue.rule, { severity: issue.severity, count: (previous?.count ?? 0) + 1 });
    }
    for (const [rule, result] of lintCounts) finding(plan, result.severity, result.severity === 'error' ? 'schema_incompatible' : 'schema_warning',
      `Resolved company schema reports ${rule} (${result.count}); review the selected schema.`);
  } catch { finding(plan, 'error', 'schema_incompatible', 'The company-brain schema could not be resolved and validated.'); pack = null; }
  try {
    plan.revision = await resolveCommittedRevision(options.path, options.revision);
    const entries = await inventoryCommittedRevision(plan.revision, limits);
    let metadataBytes = 0;
    for (const item of entries) {
      const reason = policy(item.path);
      const entry: InspectionEntry = { ...item, disposition: 'included', reason: 'selected_markdown' };
      if (!safeRepositoryPath(item.path)) {
        entry.disposition = 'unsupported'; entry.reason = 'unsafe_path';
        finding(plan, 'error', 'unsafe_path', 'Tracked path contains unsafe components or control characters.', item.path);
      } else if (reason) { entry.disposition = 'excluded'; entry.reason = reason; }
      else if (item.object_type !== 'blob' || !/^100(?:644|755)$/.test(item.mode)) {
        entry.disposition = 'unsupported'; entry.reason = 'non_regular_file';
        finding(plan, 'error', 'unsupported_file', 'Symlinks and submodules are never followed; exclude this entry before connecting.', item.path);
      } else if (!/\.mdx?$/i.test(item.path)) {
        entry.disposition = 'unsupported'; entry.reason = 'non_markdown';
        finding(plan, include.length ? 'error' : 'warning', 'unsupported_file', 'Only committed Markdown is supported; this file is not selected for import.', item.path);
      } else if (item.bytes === null || item.bytes > limits.maxFileBytes) {
        entry.disposition = 'unsupported'; entry.reason = 'file_too_large';
        finding(plan, 'error', 'request_too_large', 'Markdown exceeds the import file limit; split it into smaller files.', item.path);
      } else {
        try {
          const bytes = await readCommittedBlob(plan.revision, item, limits);
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(content)) {
            entry.disposition = 'unsupported'; entry.reason = 'lfs_pointer';
            finding(plan, 'error', 'unsupported_file', 'Git LFS pointers are not Markdown content. Commit the actual Markdown or exclude this path; no LFS download was attempted.', item.path);
          } else {
            readPage(content, entry, plan, pack);
            if (entry.page) entry.page.content_sha256 = createHash('sha256').update(bytes).digest('hex');
          }
        } catch (error) {
          entry.disposition = 'unsupported'; entry.reason = 'invalid_markdown';
          finding(plan, 'error', error instanceof OperationError ? error.code : 'invalid_markdown', 'Markdown or metadata cannot be safely parsed; correct this file before connecting.', item.path);
        }
      }
      plan.manifest.push(entry);
      metadataBytes += Buffer.byteLength(JSON.stringify(entry));
      if (metadataBytes > limits.maxMetadataBytes) throw new OperationError('request_too_large', 'Selection metadata exceeds its limit; narrow selection.');
    }
    plan.uncommitted = await inspectUncommitted(plan.revision, entries, path => policy(path) === null && /\.mdx?$/i.test(path), limits);
    if (plan.uncommitted.some(item => item.eligible)) finding(plan, 'error', 'source_not_ready', 'Eligible files have uncommitted changes; commit or exclude them and inspect again. Only committed bytes were inspected.');
    if (plan.uncommitted.some(item => item.kind === 'untracked')) finding(plan, 'warning', 'untracked_input', 'Untracked files were not read or imported. Git-ignored untracked files are outside this inventory.');
    resolveReferences(plan, pack);
    if (!options.profile) {
      const typed = plan.manifest.filter(entry => entry.page?.type_explicit && distinctiveTypes.has(entry.page.type));
      if (new Set(typed.map(entry => entry.page!.type)).size >= 2 || typed.some(entry => pack?.manifest.page_types
        .find(type => type.name === entry.page!.type)?.path_prefixes.some(prefix => entry.path.startsWith(prefix)))) plan.profile_selection = 'detected';
      else finding(plan, 'error', 'profile_ambiguous', 'The repository does not uniquely identify company-brain; select an explicit profile after reviewing the inventory.');
    }
    const after = await resolveCommittedRevision(options.path, options.revision);
    if (companyBrainDigest(after) !== companyBrainDigest(plan.revision)) finding(plan, 'error', 'plan_stale', 'The checkout identity or revision changed during inspection; inspect again.');
  } catch (error) {
    finding(plan, 'error', error instanceof OperationError ? error.code : 'invalid_source',
      error instanceof OperationError && error.code === 'request_too_large' ? 'Inspection exceeds the bounded entry or metadata limit; partition the repository or narrow selection.' : 'Inspect a committed local Git directory with a stable, safe root. No input was changed.');
  }
  for (const entry of plan.manifest) { plan.counts.tracked++; plan.counts[entry.disposition]++; }
  plan.counts.dirty_eligible = plan.uncommitted.filter(item => item.eligible).length;
  plan.counts.untracked = plan.uncommitted.filter(item => item.kind === 'untracked').length;
  plan.audience_requirements = [...new Set(plan.manifest.flatMap(entry => entry.page?.audience ?? []))].sort();
  if (plan.audience_requirements.includes('internal')) finding(plan, 'warning', 'destination_audience_required', 'Internal audience requires an explicitly approved company destination and review of its existing grants. No grants are mapped or changed.');
  if (plan.counts.included === 0) finding(plan, 'error', 'empty_selection', 'No supported Markdown pages were selected; an empty or all-excluded corpus is not connectable.');
  plan.ready = !plan.findings.some(item => item.severity === 'error');
  try {
    canonical(plan, limits.maxMetadataBytes);
  } catch {
    plan.manifest = []; plan.uncommitted = []; plan.audience_requirements = [];
    plan.counts = { tracked: 0, included: 0, excluded: 0, unsupported: 0, dirty_eligible: 0, untracked: 0 };
    plan.findings = [{ severity: 'error', code: 'request_too_large', message: 'Inspection metadata exceeds its limit; no complete inventory is available. Partition the repository or narrow selection.' }];
    plan.ready = false;
  }
  const { plan_digest: _, ...body } = plan;
  plan.plan_digest = companyBrainDigest(body);
  return plan;
}

export async function validateCompanyBrainPlan(saved: unknown, options: InspectCompanyBrainOptions & { mode?: 'apply' | 'resume' }): Promise<PlanValidationResult> {
  const stale = (): PlanValidationResult => ({ valid: false, code: 'plan_stale', findings: [
    { severity: 'error', code: 'plan_stale', message: 'The saved plan does not match the approved input, selection, schema, or inspection version; inspect again.' },
  ] });
  try {
    canonical(saved);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return stale();
    const plan = saved as CompanyBrainPlan;
    if (plan.schema_version !== COMPANY_BRAIN_PLAN_VERSION || plan.profile !== COMPANY_BRAIN_PROFILE || !plan.revision || !plan.schema ||
      plan.extractor_version !== LINK_EXTRACTOR_VERSION_TS || plan.selection.defaults_version !== 1 ||
      (options.profile !== undefined && options.profile !== plan.profile) ||
      (options.revision !== undefined && options.revision !== plan.revision.commit)) return stale();
    const { plan_digest: digest, ...body } = plan;
    if (digest !== companyBrainDigest(body)) return stale();
    const fresh = await inspectCompanyBrain({ ...options,
      profile: plan.profile_selection === 'explicit' ? COMPANY_BRAIN_PROFILE : undefined,
      include: options.include ?? plan.selection.include, exclude: options.exclude ?? plan.selection.exclude,
      limits: options.limits ?? plan.limits, revision: options.mode === 'resume' ? plan.revision.commit : undefined });
    if (options.mode === 'resume') {
      const immutable = (value: CompanyBrainPlan) => ({ schema_version: value.schema_version, profile: value.profile,
        profile_selection: value.profile_selection, revision: value.revision, schema: value.schema, extractor_version: value.extractor_version,
        selection: value.selection, limits: value.limits, manifest: value.manifest, audience_requirements: value.audience_requirements });
      if (companyBrainDigest(immutable(fresh)) !== companyBrainDigest(immutable(plan)) || !plan.ready ||
        fresh.findings.some(item => item.severity === 'error' && item.code !== 'source_not_ready')) return stale();
    } else if (fresh.plan_digest !== plan.plan_digest) return stale();
    if (!plan.ready) return { valid: false, code: 'source_not_ready', findings: plan.findings, plan: fresh };
    return { valid: true, code: 'ok', findings: fresh.findings, plan: fresh };
  } catch { return stale(); }
}
