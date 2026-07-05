/**
 * orchestrator/medical-terms.ts — the "key medical terms must be accurate" engine.
 *
 * The temporal backtest (backtest.ts) does NOT score the model's next-step estimate
 * word-for-word. It scores whether the estimate names the right KEY MEDICAL TERMS
 * (drugs, procedures, red-flag symptoms, dispositions, …). This module is that
 * comparison: a lexicon-based term extractor + a set-overlap scorer.
 *
 * COMPOSABLE / INJECTABLE by design:
 *   - `TermExtractor` is a plain function; the default is `makeLexiconExtractor(
 *     DEFAULT_MEDICAL_LEXICON)`. Swap in a real UMLS / scispaCy extractor later
 *     without touching the backtest.
 *   - `scoreTerms` is pure set math over the extractor's output.
 *
 * Not a clinical NLP system — a deterministic, dependency-free, reviewable default
 * so the backtest runs in a plain unit test. The lexicon is deliberately small and
 * obvious; extend it (or replace the extractor) as coverage needs grow.
 */

/** Coarse clinical category of a term. `critical` terms drive the pass/fail bar. */
export type TermCategory =
  | 'symptom'
  | 'red_flag'
  | 'medication'
  | 'procedure'
  | 'vital'
  | 'diagnosis'
  | 'disposition'
  | 'other';

/** A resolved medical term (canonical form + how it should be weighed). */
export interface MedicalTerm {
  canonical: string;
  category: TermCategory;
  /** Must-be-present terms — a missed critical term fails the step. */
  critical: boolean;
}

/** One lexicon row: a canonical term, its category, and surface variants. */
export interface TermLexiconEntry {
  canonical: string;
  category: TermCategory;
  /** Default critical-ness by category if omitted (see CRITICAL_BY_DEFAULT). */
  critical?: boolean;
  /** Extra surface forms / abbreviations that map to `canonical`. */
  synonyms?: string[];
}

export type TermExtractor = (text: string) => MedicalTerm[];

/**
 * Categories whose terms are, by default, the ones that "must be accurate": a
 * prediction that omits a drug/procedure/red-flag/disposition the real next step
 * called for is a substantive miss, even if the softer symptom words overlap.
 */
const CRITICAL_BY_DEFAULT: Record<TermCategory, boolean> = {
  medication: true,
  procedure: true,
  red_flag: true,
  disposition: true,
  diagnosis: false,
  symptom: false,
  vital: false,
  other: false,
};

/**
 * Normalize free text for matching: NFKC, lowercase, strip punctuation to spaces
 * (keep intra-word hyphens), collapse whitespace, pad with spaces so surface forms
 * can be matched on word boundaries via substring test.
 */
export function normalizeForMatch(text: string): string {
  const lowered = text.normalize('NFKC').toLowerCase();
  const cleaned = lowered
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ') // punctuation → space, keep hyphen
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${cleaned} `;
}

/** Normalize a single surface form (no padding). */
function normalizeSurface(surface: string): string {
  return normalizeForMatch(surface).trim();
}

/**
 * Does `haystack` (a padded, normalized string) contain `surface` as a whole word
 * or phrase? Tolerates a trailing plural `s` on the last token so "referral" and
 * "referrals" both hit.
 */
function containsSurface(paddedHaystack: string, surface: string): boolean {
  if (!surface) return false;
  if (paddedHaystack.includes(` ${surface} `)) return true;
  // simple plural tolerance
  if (paddedHaystack.includes(` ${surface}s `)) return true;
  if (surface.endsWith('s') && paddedHaystack.includes(` ${surface.slice(0, -1)} `)) return true;
  return false;
}

/**
 * Build an extractor from a lexicon. Returns each canonical term at most once,
 * in lexicon order, whose canonical or any synonym appears as a whole word/phrase.
 */
export function makeLexiconExtractor(lexicon: TermLexiconEntry[]): TermExtractor {
  // Pre-normalize surface forms once.
  const prepared = lexicon.map((e) => ({
    canonical: e.canonical,
    category: e.category,
    critical: e.critical ?? CRITICAL_BY_DEFAULT[e.category],
    surfaces: [e.canonical, ...(e.synonyms ?? [])].map(normalizeSurface).filter(Boolean),
  }));

  return (text: string): MedicalTerm[] => {
    const hay = normalizeForMatch(text);
    const out: MedicalTerm[] = [];
    const seen = new Set<string>();
    for (const e of prepared) {
      if (seen.has(e.canonical)) continue;
      if (e.surfaces.some((s) => containsSurface(hay, s))) {
        seen.add(e.canonical);
        out.push({ canonical: e.canonical, category: e.category, critical: e.critical });
      }
    }
    return out;
  };
}

/**
 * Default clinical lexicon. Deliberately small + obvious (cardiac, mental-health,
 * general-medicine — the three seed skill areas). This is a stand-in for a real
 * medical ontology; grow it or replace the extractor entirely via injection.
 */
export const DEFAULT_MEDICAL_LEXICON: TermLexiconEntry[] = [
  // --- red-flag symptoms (critical) ---
  { canonical: 'chest pain', category: 'red_flag', synonyms: ['chest pressure', 'chest tightness', 'angina'] },
  { canonical: 'shortness of breath', category: 'red_flag', synonyms: ['dyspnea', 'sob', 'difficulty breathing', 'breathlessness'] },
  { canonical: 'suicidal ideation', category: 'red_flag', synonyms: ['suicidal', 'suicidal thoughts', 'thoughts of suicide', 'wanting to die'] },
  { canonical: 'self-harm', category: 'red_flag', synonyms: ['self harm', 'self-injury', 'cutting'] },
  { canonical: 'syncope', category: 'red_flag', synonyms: ['fainting', 'passed out', 'loss of consciousness'] },
  { canonical: 'sepsis', category: 'red_flag', synonyms: ['septic'] },
  { canonical: 'anaphylaxis', category: 'red_flag', synonyms: ['anaphylactic'] },

  // --- softer symptoms (non-critical) ---
  { canonical: 'palpitations', category: 'symptom', synonyms: ['racing heart', 'heart racing'] },
  { canonical: 'fever', category: 'symptom', synonyms: ['pyrexia', 'febrile', 'high temperature'] },
  { canonical: 'nausea', category: 'symptom', synonyms: ['nauseous', 'feeling sick'] },
  { canonical: 'insomnia', category: 'symptom', synonyms: ['trouble sleeping', 'cannot sleep', "can't sleep", 'sleeplessness'] },
  { canonical: 'fatigue', category: 'symptom', synonyms: ['tiredness', 'exhaustion', 'low energy'] },
  { canonical: 'anxiety', category: 'symptom', synonyms: ['anxious', 'panic'] },
  { canonical: 'low mood', category: 'symptom', synonyms: ['depressed mood', 'sadness', 'feeling down'] },
  { canonical: 'dizziness', category: 'symptom', synonyms: ['dizzy', 'lightheaded', 'light-headed'] },

  // --- diagnoses (non-critical by default, but named) ---
  { canonical: 'depression', category: 'diagnosis', synonyms: ['major depressive disorder', 'mdd'] },
  { canonical: 'hypertension', category: 'diagnosis', synonyms: ['high blood pressure', 'htn'] },
  { canonical: 'myocardial infarction', category: 'diagnosis', synonyms: ['heart attack', 'mi', 'stemi', 'nstemi'] },
  { canonical: 'atrial fibrillation', category: 'diagnosis', synonyms: ['afib', 'a-fib', 'af'] },
  { canonical: 'pneumonia', category: 'diagnosis', synonyms: [] },
  { canonical: 'diabetes', category: 'diagnosis', synonyms: ['diabetic', 'dm', 't2dm', 'type 2 diabetes'] },

  // --- medications (critical) ---
  { canonical: 'aspirin', category: 'medication', synonyms: ['asa', 'acetylsalicylic acid'] },
  { canonical: 'nitroglycerin', category: 'medication', synonyms: ['gtn', 'glyceryl trinitrate', 'nitrates', 'ntg'] },
  { canonical: 'sertraline', category: 'medication', synonyms: ['zoloft'] },
  { canonical: 'fluoxetine', category: 'medication', synonyms: ['prozac'] },
  { canonical: 'ssri', category: 'medication', synonyms: ['selective serotonin reuptake inhibitor'] },
  { canonical: 'lorazepam', category: 'medication', synonyms: ['ativan'] },
  { canonical: 'metoprolol', category: 'medication', synonyms: ['beta blocker', 'beta-blocker'] },
  { canonical: 'lisinopril', category: 'medication', synonyms: ['ace inhibitor'] },
  { canonical: 'metformin', category: 'medication', synonyms: [] },
  { canonical: 'warfarin', category: 'medication', synonyms: ['coumadin'] },
  { canonical: 'anticoagulation', category: 'medication', synonyms: ['anticoagulant', 'doac', 'apixaban', 'rivaroxaban'] },
  { canonical: 'antibiotics', category: 'medication', synonyms: ['antibiotic', 'amoxicillin', 'ceftriaxone'] },

  // --- procedures / tests (critical) ---
  { canonical: 'ecg', category: 'procedure', synonyms: ['ekg', 'electrocardiogram', '12-lead'] },
  { canonical: 'troponin', category: 'procedure', synonyms: ['cardiac enzymes', 'trop'] },
  { canonical: 'chest x-ray', category: 'procedure', synonyms: ['cxr', 'chest xray', 'chest radiograph'] },
  { canonical: 'blood pressure', category: 'vital', synonyms: ['bp'] },
  { canonical: 'blood glucose', category: 'procedure', synonyms: ['blood sugar', 'glucose check', 'bgl'] },
  { canonical: 'blood cultures', category: 'procedure', synonyms: ['blood culture'] },
  { canonical: 'phq-9', category: 'procedure', synonyms: ['phq9', 'depression screen', 'phq'] },
  { canonical: 'suicide risk assessment', category: 'procedure', synonyms: ['risk assessment', 'columbia', 'c-ssrs', 'safety assessment'] },
  { canonical: 'vital signs', category: 'vital', synonyms: ['vitals', 'observations', 'obs'] },
  { canonical: 'oxygen saturation', category: 'vital', synonyms: ['spo2', 'o2 sat', 'oxygen sats', 'pulse oximetry'] },

  // --- dispositions (critical — the actual "next step") ---
  { canonical: 'psychiatry referral', category: 'disposition', synonyms: ['refer to psychiatry', 'psychiatric referral', 'mental health referral', 'refer psychiatry'] },
  { canonical: 'cardiology referral', category: 'disposition', synonyms: ['refer to cardiology', 'cardiac referral'] },
  { canonical: 'admission', category: 'disposition', synonyms: ['admit', 'hospitalize', 'hospitalise', 'inpatient'] },
  { canonical: 'emergency escalation', category: 'disposition', synonyms: ['call 119', 'call 911', 'escalate to emergency', 'ambulance', 'emergency department', 'ed transfer'] },
  { canonical: 'safety plan', category: 'disposition', synonyms: ['safety planning', 'crisis plan'] },
  { canonical: 'follow-up', category: 'disposition', synonyms: ['follow up', 'review appointment', 'recheck', 're-check'] },
  { canonical: 'discharge', category: 'disposition', synonyms: ['discharged', 'send home'] },
];

/** The default extractor over the default lexicon. */
export const extractMedicalTerms: TermExtractor = makeLexiconExtractor(DEFAULT_MEDICAL_LEXICON);

/**
 * Resolve explicit term names (from a fixture's expected set) into MedicalTerms via
 * the default lexicon, so a hand-written expectation is scored on the same footing
 * as extracted text. An unknown name is returned as an `other`/non-critical term.
 */
export function resolveTerms(names: string[], extractor: TermExtractor = extractMedicalTerms): MedicalTerm[] {
  const out: MedicalTerm[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const hit = extractor(name);
    if (hit.length > 0) {
      for (const t of hit) {
        if (!seen.has(t.canonical)) {
          seen.add(t.canonical);
          out.push(t);
        }
      }
    } else {
      const canonical = normalizeSurface(name);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        out.push({ canonical, category: 'other', critical: false });
      }
    }
  }
  return out;
}

export interface TermScore {
  /** matched / actual (1 if there were no actual terms). */
  recall: number;
  /** matched / predicted (1 if the prediction named no terms). */
  precision: number;
  /** harmonic mean of precision & recall. */
  f1: number;
  /** recall over CRITICAL actual terms only — the primary "must be accurate" gate. */
  criticalRecall: number;
  /** canonical actual terms the prediction got right. */
  matched: string[];
  /** canonical actual terms the prediction missed. */
  missed: string[];
  /** canonical terms the prediction named that the actual next step did not. */
  extra: string[];
  /** the subset of `missed` that were critical (drug/procedure/red-flag/disposition). */
  criticalMissed: string[];
  actualTerms: string[];
  predictedTerms: string[];
  /** criticalRecall ≥ criticalThreshold AND recall ≥ recallThreshold. */
  passed: boolean;
}

export interface ScoreOpts {
  extractor?: TermExtractor;
  /** Fraction of ALL actual terms that must be matched to pass (default 0.5). */
  recallThreshold?: number;
  /** Fraction of CRITICAL actual terms that must be matched (default 1.0 — all). */
  criticalThreshold?: number;
}

function harmonic(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Pure set math over two already-extracted term lists. */
export function scoreTerms(
  predicted: MedicalTerm[],
  actual: MedicalTerm[],
  opts: ScoreOpts = {},
): TermScore {
  const recallThreshold = opts.recallThreshold ?? 0.5;
  const criticalThreshold = opts.criticalThreshold ?? 1.0;

  const predSet = new Set(predicted.map((t) => t.canonical));
  const actualByName = new Map(actual.map((t) => [t.canonical, t] as const));

  const matched: string[] = [];
  const missed: string[] = [];
  const criticalMissed: string[] = [];
  for (const t of actualByName.values()) {
    if (predSet.has(t.canonical)) {
      matched.push(t.canonical);
    } else {
      missed.push(t.canonical);
      if (t.critical) criticalMissed.push(t.canonical);
    }
  }
  const extra = [...predSet].filter((n) => !actualByName.has(n));

  const actualCount = actualByName.size;
  const criticalCount = [...actualByName.values()].filter((t) => t.critical).length;

  const recall = actualCount === 0 ? 1 : matched.length / actualCount;
  const precision = predSet.size === 0 ? 1 : matched.length / predSet.size;
  const f1 = harmonic(precision, recall);
  const criticalRecall =
    criticalCount === 0 ? 1 : (criticalCount - criticalMissed.length) / criticalCount;

  const passed = criticalRecall >= criticalThreshold && recall >= recallThreshold;

  return {
    recall,
    precision,
    f1,
    criticalRecall,
    matched: matched.sort(),
    missed: missed.sort(),
    extra: extra.sort(),
    criticalMissed: criticalMissed.sort(),
    actualTerms: [...actualByName.keys()].sort(),
    predictedTerms: [...predSet].sort(),
    passed,
  };
}

/**
 * Score a free-text prediction against the free-text actual next step. Extracts key
 * medical terms from both and compares — NOT a word-for-word match. This is the
 * default scorer the backtest uses.
 */
export function scoreMedicalTerms(
  predictedText: string,
  actualText: string,
  opts: ScoreOpts = {},
): TermScore {
  const extractor = opts.extractor ?? extractMedicalTerms;
  return scoreTerms(extractor(predictedText), extractor(actualText), opts);
}
