/**
 * gbrain candidate scorecard — narrow proof-first candidate compare view.
 *
 * Prototype scope:
 *   - local text/JSON import only; no mailbox connector baked into gbrain
 *   - deterministic scoring against the role brief
 *   - anonymized candidate ids in output
 *   - evidence snippets instead of unsupported narrative claims
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scrubPii } from '../core/eval-capture-scrub.ts';

export const CANDIDATE_SCORECARD_SCHEMA_VERSION = 1;

export type CandidateCriterionId =
  | 'hostaway_daily_surface'
  | 'portfolio_match'
  | 'guest_comms_ownership'
  | 'reservation_hygiene'
  | 'vendor_maintenance_coordination'
  | 'owner_update_support'
  | 'repeat_guest_direct_booking_support'
  | 'listing_revenue_data_support'
  | 'messy_issue_example'
  | 'timezone_hours_rate';

export interface CandidateFitCriterion {
  id: CandidateCriterionId;
  label: string;
  weight: number;
  must_have?: boolean;
}

export interface CandidateFitBrief {
  schema_version: number;
  role_kind: 'hostaway_str_ops_va';
  criteria: CandidateFitCriterion[];
  source_summary: {
    active_listings: number | null;
    channels: string[];
    requires_hostaway_daily_surface: boolean;
    rejects_generic_va: boolean;
  };
}

export type CandidateCriterionStatus = 'strong' | 'partial' | 'weak';

export interface CandidateCriterionScore {
  id: CandidateCriterionId;
  label: string;
  weight: number;
  status: CandidateCriterionStatus;
  points: number;
  evidence: string[];
}

export interface CandidateFitScorecard {
  schema_version: number;
  candidate_id: string;
  fit_score: number;
  recommendation: 'strong_fit' | 'possible_fit' | 'weak_fit';
  criteria: CandidateCriterionScore[];
  red_flags: Array<{
    kind:
      | 'hostaway_gap'
      | 'missing_messy_issue'
      | 'missing_channel_data'
      | 'growth_claim_without_ops_proof';
    text: string;
  }>;
}

export interface CandidateFitCompare {
  schema_version: number;
  brief: CandidateFitBrief;
  candidates: CandidateFitScorecard[];
}

export function buildCandidateFitBriefFromText(text: string): CandidateFitBrief {
  const lower = text.toLowerCase();
  const activeListings = extractActiveListings(lower);
  return {
    schema_version: CANDIDATE_SCORECARD_SCHEMA_VERSION,
    role_kind: 'hostaway_str_ops_va',
    criteria: [
      { id: 'hostaway_daily_surface', label: 'Hostaway daily working surface', weight: 22, must_have: true },
      { id: 'portfolio_match', label: 'Comparable STR portfolio', weight: 8 },
      { id: 'guest_comms_ownership', label: 'Guest comms ownership', weight: 14 },
      { id: 'reservation_hygiene', label: 'Reservation hygiene', weight: 12 },
      { id: 'vendor_maintenance_coordination', label: 'Vendor / maintenance coordination', weight: 10 },
      { id: 'owner_update_support', label: 'Owner-update support', weight: 8 },
      { id: 'repeat_guest_direct_booking_support', label: 'Repeat-guest / direct-booking support', weight: 8 },
      { id: 'listing_revenue_data_support', label: 'Listing / revenue support from data', weight: 10 },
      { id: 'messy_issue_example', label: 'Messy issue handled end to end', weight: 5 },
      { id: 'timezone_hours_rate', label: 'Timezone, hours, and rate evidence', weight: 3 },
    ],
    source_summary: {
      active_listings: activeListings,
      channels: ['airbnb', 'vrbo', 'direct'].filter((c) => lower.includes(c)),
      requires_hostaway_daily_surface: /hostaway-heavy|hostaway heavy|daily working surface|lived inside hostaway/.test(lower),
      rejects_generic_va: /not looking for a generic|generic str va|no need to force/i.test(text),
    },
  };
}

export function computeCandidateFitScorecard(args: {
  brief: CandidateFitBrief;
  candidateId: string;
  resumeSummary: string;
}): CandidateFitScorecard {
  const text = args.resumeSummary;
  const lower = text.toLowerCase();
  const criteria = args.brief.criteria.map((criterion) => scoreCriterion(criterion, text));
  const total = Math.round(criteria.reduce((sum, c) => sum + c.points, 0));
  const redFlags = buildRedFlags(criteria, lower);
  const recommendation =
    total >= 80 && !redFlags.some((f) => f.kind === 'hostaway_gap') ? 'strong_fit'
      : total >= 55 ? 'possible_fit'
        : 'weak_fit';

  return {
    schema_version: CANDIDATE_SCORECARD_SCHEMA_VERSION,
    candidate_id: sanitizeCandidateId(args.candidateId),
    fit_score: total,
    recommendation,
    criteria,
    red_flags: redFlags,
  };
}

export function buildCandidateFitCompare(args: {
  brief: CandidateFitBrief;
  candidates: Array<{ id: string; resumeSummary: string }>;
}): CandidateFitCompare {
  const candidates = args.candidates
    .map((candidate) => computeCandidateFitScorecard({
      brief: args.brief,
      candidateId: candidate.id,
      resumeSummary: candidate.resumeSummary,
    }))
    .sort((a, b) => b.fit_score - a.fit_score || a.candidate_id.localeCompare(b.candidate_id));
  return {
    schema_version: CANDIDATE_SCORECARD_SCHEMA_VERSION,
    brief: args.brief,
    candidates,
  };
}

function scoreCriterion(criterion: CandidateFitCriterion, text: string): CandidateCriterionScore {
  const lower = text.toLowerCase();
  const status = classifyCriterion(criterion.id, lower);
  const multiplier = status === 'strong' ? 1 : status === 'partial' ? 0.5 : 0;
  return {
    id: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    status,
    points: Math.round(criterion.weight * multiplier),
    evidence: evidenceFor(criterion.id, text),
  };
}

function classifyCriterion(id: CandidateCriterionId, lower: string): CandidateCriterionStatus {
  switch (id) {
    case 'hostaway_daily_surface':
      if (/light exposure to hostaway|hostaway.*training|familiar with hostaway/.test(lower)) return 'weak';
      if (lower.includes('hostaway') && /daily|pms|working surface|inbox triage|reservation/.test(lower)) return 'strong';
      return lower.includes('hostaway') ? 'partial' : 'weak';
    case 'portfolio_match':
      if (/(?:supported|managed|portfolio).{0,40}\b(?:[5-9]|[1-9]\d+)\b.{0,40}(?:\bstr\b|short-term|listings|properties|homes|condos)/.test(lower)) return 'strong';
      if (/(\bstr\b|short-term|listings|properties|airbnb|vrbo)/.test(lower)) return 'partial';
      return 'weak';
    case 'guest_comms_ownership':
      if (/(owned|managed|handled).{0,80}(guest|inbox|messages|arrival|stay issue|post-stay|escalation)/.test(lower)) return 'strong';
      if (/(guest|inbox|messages|arrival|stay issue|post-stay|escalation)/.test(lower)) return 'partial';
      return 'weak';
    case 'reservation_hygiene':
      if (/no .{0,80}reservation/.test(lower)) return 'weak';
      if (/reservation/.test(lower) && /(modified|inquiry|cancel|contact field|handoff|channel notes|hygiene)/.test(lower)) return 'strong';
      if (/reservation|calendar/.test(lower)) return 'partial';
      return 'weak';
    case 'vendor_maintenance_coordination':
      if (/no .{0,80}(vendor|maintenance)/.test(lower)) return 'weak';
      if (/(coordinated|managed|owned|handled).{0,60}(vendor|maintenance|repair|cleaner|technician|ac failure)/.test(lower)) return 'strong';
      if (/vendor|maintenance|repair|cleaner|technician|service coordination/.test(lower)) return 'partial';
      return 'weak';
    case 'owner_update_support':
      if (/no .{0,80}owner/.test(lower)) return 'weak';
      if (/owner/.test(lower) && /(update|summary|clean summary|report)/.test(lower)) return 'strong';
      if (/owner/.test(lower)) return 'partial';
      return 'weak';
    case 'repeat_guest_direct_booking_support':
      if (/(repeat|ota household)/.test(lower) && /(hostaway|reservation|evidence|outreach)/.test(lower)) return 'strong';
      if (/(direct booking|direct-booking)/.test(lower) && /(hostaway evidence|reservation|evidence tied|outreach)/.test(lower)) return 'strong';
      if (/repeat|direct booking|direct-booking|ota/.test(lower)) return 'partial';
      return 'weak';
    case 'listing_revenue_data_support':
      if (/no .{0,80}(channel-data|channel data|reservation.*data|data examples)/.test(lower)) return 'weak';
      if (/(reservation|channel|property-level|listing|revenue).{0,60}(data|patterns|reviewed|analysis)/.test(lower)) return 'strong';
      if (/listing|revenue|channel|data/.test(lower)) return 'partial';
      return 'weak';
    case 'messy_issue_example':
      if (/no .{0,80}(messy|guest issue|issue example)/.test(lower)) return 'weak';
      if (/(same-day|messy|end to end|closed the loop|handled).{0,80}(issue|failure|reservation|guest|ac|maintenance)/.test(lower)) return 'strong';
      if (/issue|failure|reservation problem|guest problem/.test(lower)) return 'partial';
      return 'weak';
    case 'timezone_hours_rate':
      if (/(timezone|et overlap|\bhours\b|available)/.test(lower) && /(\$\d+|\brate\b|\/hr|per hour)/.test(lower)) return 'strong';
      if (/(timezone|\bhours\b|available|\$\d+|\brate\b|\/hr|per hour)/.test(lower)) return 'partial';
      return 'weak';
  }
}

function evidenceFor(id: CandidateCriterionId, text: string): string[] {
  const snippets = splitSentences(text)
    .filter((sentence) => sentenceMatches(id, sentence.toLowerCase()))
    .slice(0, 2)
    .map((sentence) => sanitizeEvidence(sentence));
  return snippets;
}

function sentenceMatches(id: CandidateCriterionId, lower: string): boolean {
  switch (id) {
    case 'hostaway_daily_surface': return lower.includes('hostaway');
    case 'portfolio_match': return /\bstr\b|short-term|listings|properties|homes|condos|portfolio|airbnb|vrbo/.test(lower);
    case 'guest_comms_ownership': return /guest|inbox|messages|arrival|stay|post-stay|escalation/.test(lower);
    case 'reservation_hygiene': return /reservation|modified|inquiry|cancel|contact field|handoff|calendar/.test(lower);
    case 'vendor_maintenance_coordination': return /vendor|maintenance|repair|cleaner|technician|ac failure|service coordination/.test(lower);
    case 'owner_update_support': return /owner/.test(lower);
    case 'repeat_guest_direct_booking_support': return /repeat|direct booking|direct-booking|ota/.test(lower);
    case 'listing_revenue_data_support': return /listing|revenue|channel|data|property-level/.test(lower);
    case 'messy_issue_example': return /messy|same-day|issue|failure|end to end|closed the loop/.test(lower);
    case 'timezone_hours_rate': return /timezone|\bhours\b|available|\$\d+|\brate\b|\/hr|per hour|overlap/.test(lower);
  }
}

function buildRedFlags(
  criteria: CandidateCriterionScore[],
  lower: string,
): CandidateFitScorecard['red_flags'] {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const flags: CandidateFitScorecard['red_flags'] = [];
  if (byId.get('hostaway_daily_surface')?.status !== 'strong') {
    flags.push({
      kind: 'hostaway_gap',
      text: 'Hostaway is not proven as a daily working surface.',
    });
  }
  if (byId.get('messy_issue_example')?.status === 'weak') {
    flags.push({
      kind: 'missing_messy_issue',
      text: 'No concrete messy guest or reservation issue is evidenced.',
    });
  }
  if (byId.get('listing_revenue_data_support')?.status === 'weak') {
    flags.push({
      kind: 'missing_channel_data',
      text: 'No reservation/channel-data evidence is provided.',
    });
  }
  if (/(growth va|direct booking campaign|campaigns|growth)/.test(lower) &&
      (byId.get('hostaway_daily_surface')?.status !== 'strong' ||
        byId.get('repeat_guest_direct_booking_support')?.status !== 'strong')) {
    flags.push({
      kind: 'growth_claim_without_ops_proof',
      text: 'Growth/direct-booking claim is not tied back to Hostaway ops evidence.',
    });
  }
  return flags;
}

function extractActiveListings(lower: string): number | null {
  const m = lower.match(/(\d+)\s+active\s+listings/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PRODUCT_WORDS = new Set([
  'Hostaway', 'Airbnb', 'VRBO', 'Direct', 'OTA', 'STR', 'PMS', 'ET',
  'Philippines',
]);

const SAFE_CANDIDATE_ID_RE = /^candidate(?:[_-][a-z0-9]+)*$/;

function sanitizeCandidateId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return 'candidate';
  if (SAFE_CANDIDATE_ID_RE.test(normalized)) return normalized;
  return `candidate_${sha8(normalized)}`;
}

function sanitizeEvidence(sentence: string): string {
  let out = scrubPii(sentence.trim());
  out = out.replace(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g, (match) => {
    const parts = match.split(/\s+/);
    return parts.some((p) => PRODUCT_WORDS.has(p)) ? match : '[redacted]';
  });
  out = out.replace(/\b[A-Z][A-Za-z0-9&._-]{2,}\b/g, (token) => (
    PRODUCT_WORDS.has(token) || token === 'REDACTED' ? token : '[redacted]'
  ));
  out = out.replace(/(?:\[redacted\]\s+){2,}/g, '[redacted] ');
  return out.length <= 240 ? out : out.slice(0, 237) + '...';
}

interface CandidateInputFile {
  id?: string;
  resume_summary?: string;
  resumeSummary?: string;
}

interface RunOpts {
  sub: 'scorecard';
  briefFile: string;
  candidateFiles: string[];
  json?: boolean;
}

const HELP = `Usage: gbrain candidate scorecard --brief-file <txt> --candidate-file <json|txt> [--candidate-file <json|txt>] [--json]

Builds an anonymized candidate compare view from a role brief and local resume
summaries. JSON candidate files may include {"id":"candidate_a","resume_summary":"..."}.
Plain-text candidate files use the filename stem as the candidate id.

Examples:
  gbrain candidate scorecard --brief-file brief.txt --candidate-file a.json --candidate-file b.json --json
`;

function parseArgs(args: string[]): RunOpts | { help: true } | { error: string } {
  if (args[0] === '--help' || args[0] === '-h') return { help: true };
  if (args[0] !== 'scorecard') return { error: `Unknown candidate subcommand: ${args[0] ?? '(none)'}. Did you mean "candidate scorecard"?` };
  const opts: RunOpts = { sub: 'scorecard', briefFile: '', candidateFiles: [] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--brief-file') { opts.briefFile = args[++i] ?? ''; continue; }
    if (a === '--candidate-file') { opts.candidateFiles.push(args[++i] ?? ''); continue; }
    return { error: `Unknown flag: ${a}` };
  }
  if (!opts.briefFile) return { error: '--brief-file is required.' };
  if (opts.candidateFiles.length === 0) return { error: 'At least one --candidate-file is required.' };
  if (opts.candidateFiles.some((f) => !f)) return { error: '--candidate-file requires a path.' };
  return opts;
}

export async function runCandidate(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error('');
    console.error(HELP);
    process.exit(1);
  }

  const briefText = readFileSync(parsed.briefFile, 'utf8');
  const brief = buildCandidateFitBriefFromText(briefText);
  const candidates = parsed.candidateFiles.map((path) => readCandidateFile(path));
  const compare = buildCandidateFitCompare({ brief, candidates });

  if (parsed.json) {
    console.log(JSON.stringify(compare, null, 2));
    return;
  }

  for (const candidate of compare.candidates) {
    console.log(`${candidate.candidate_id}: ${candidate.fit_score}/100 (${candidate.recommendation})`);
    for (const flag of candidate.red_flags) {
      console.log(`  [${flag.kind}] ${flag.text}`);
    }
  }
}

function readCandidateFile(path: string): { id: string; resumeSummary: string } {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(raw) as CandidateInputFile;
    return {
      id: parsed.id ?? stem(path),
      resumeSummary: parsed.resume_summary ?? parsed.resumeSummary ?? '',
    };
  }
  return { id: stem(path), resumeSummary: raw };
}

function stem(path: string): string {
  return path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'candidate';
}

function sha8(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}
