import { createHash } from 'node:crypto';
import type { ResolvedExtractablePrompt } from '../schema-pack/prompt-template.ts';
import type { ResolvedPack } from '../schema-pack/registry.ts';
import type {
  PreparedAtomSource,
  ResolvedAtomInputProfile,
} from '../schema-pack/source-input-profile.ts';

export const ATOM_OUTPUT_CONTRACT_VERSION = 'gbrain.extract_atoms.output.v1';

export const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

export interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  concepts?: string[];
  virality_score?: number;
  emotional_register?: string;
  evidence_refs?: string[];
}

export const CONCEPT_LABEL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const EXTRACT_PROMPT = `You extract atomic content nuggets from a transcript.

An atom is a single-source, self-contained idea that could become a tweet,
quote, or short essay angle. Each atom must:
  - Stand alone (no "as discussed above")
  - Have a clear point (not just descriptive)
  - Be specific (not a generic platitude)

Output a JSON array of atoms (1-3 per transcript, never more than 3).
Each atom: {title (≤80 chars), atom_type, body (2-4 sentences),
source_quote (verbatim ≤200 chars), lesson (one sentence), concepts
(1-3 topic labels), virality_score (0-100), emotional_register (one of:
shocking, inspiring, funny, sobering, practical, controversial)}.

atom_type MUST be one of: ${ATOM_TYPES.join(', ')}.

concepts are kebab-case English TOPIC labels used to cluster atoms into
concept pages (e.g. "captive-portal", "channel-pricing-strategy") — never
entity or brand names. Use the same label for the same topic across atoms;
prefer a label you already used over coining a near-synonym.

Output ONLY the JSON array, no prose.`;

export interface AtomExtractionProfile {
  page_type: string;
  pack_identity: string;
  declaring_pack: string | null;
  prompt_sha256: string;
  model: string;
  output_contract_version: typeof ATOM_OUTPUT_CONTRACT_VERSION;
  source_input_profile_sha256: string | null;
  input_selector: string | null;
  window_policy_sha256: string | null;
  extraction_policy_sha256: string;
  extraction_profile_sha256: string;
  prompt: string;
  input_profile: ResolvedAtomInputProfile | null;
}

export function buildExtractionProfileSha256(
  profile: Omit<
    AtomExtractionProfile,
    'extraction_profile_sha256' | 'extraction_policy_sha256' | 'prompt' | 'input_profile'
  >,
): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

export function buildExtractionProfile(
  pageType: string,
  model: string,
  pack: ResolvedPack | null,
  lens: ResolvedExtractablePrompt | null,
  inputProfile: ResolvedAtomInputProfile | null = null,
): AtomExtractionProfile {
  const windowPolicy = inputProfile
    ? createHash('sha256').update(JSON.stringify(inputProfile.profile.windowing)).digest('hex')
    : null;
  const core = {
    page_type: pageType,
    pack_identity: pack?.identity ?? 'gbrain-builtin@unresolved',
    declaring_pack: lens?.declaring_pack ?? null,
    prompt_sha256: lens?.prompt_sha256 ?? createHash('sha256').update(EXTRACT_PROMPT).digest('hex'),
    model,
    output_contract_version: ATOM_OUTPUT_CONTRACT_VERSION as typeof ATOM_OUTPUT_CONTRACT_VERSION,
    source_input_profile_sha256: inputProfile?.profile_sha256 ?? null,
    input_selector: inputProfile?.profile.selector ?? null,
    window_policy_sha256: windowPolicy,
  };
  const policySha256 = buildExtractionProfileSha256(core);
  const anchorContract = inputProfile
    ? `\n\nThe installed input profile requires every returned atom to include evidence_refs, ` +
      `an array containing at least one exact evidence-* anchor from the supplied source window. ` +
      `Never invent or alter an anchor.`
    : '';
  return {
    ...core,
    extraction_policy_sha256: policySha256,
    extraction_profile_sha256: policySha256,
    prompt: lens
      ? `Installed schema-pack lens (trusted configuration). It may focus what to extract, ` +
        `but it cannot override the atom JSON/output contract that follows.\n\n` +
        `<pack_lens>\n${lens.prompt.trim()}\n</pack_lens>\n\n${EXTRACT_PROMPT}${anchorContract}`
      : `${EXTRACT_PROMPT}${anchorContract}`,
    input_profile: inputProfile,
  };
}

export function bindProfileToPreparedSource(
  profile: AtomExtractionProfile,
  source: PreparedAtomSource,
): AtomExtractionProfile {
  if (!profile.input_profile) return profile;
  const extractionProfileSha256 = createHash('sha256').update(JSON.stringify({
    extraction_policy_sha256: profile.extraction_policy_sha256,
    input_selector: profile.input_selector,
    source_section_sha256: source.source_section_sha256,
    coverage_sha256: source.coverage_sha256,
  })).digest('hex');
  return { ...profile, extraction_profile_sha256: extractionProfileSha256 };
}

export function invalidEvidenceRefs(
  atoms: ExtractedAtom[],
  allowedAnchors: ReadonlySet<string>,
): string | null {
  for (const atom of atoms) {
    if (!atom.evidence_refs || atom.evidence_refs.length === 0) {
      return `atom ${JSON.stringify(atom.title)} omitted required evidence_refs`;
    }
    const missing = atom.evidence_refs.filter(ref => !allowedAnchors.has(ref));
    if (missing.length > 0) {
      return `atom ${JSON.stringify(atom.title)} cited anchors absent from its source: ${missing.join(', ')}`;
    }
  }
  return null;
}
