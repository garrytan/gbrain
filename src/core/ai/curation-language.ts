/**
 * Configurable output-language policy for dream curation phases (issue #3357).
 *
 * gbrain's phase prompts (EXTRACTOR_SYSTEM, propose_takes, synthesize, …) carry
 * no output-language rule beyond "capture verbatim where possible", so on
 * non-English captures the model tends to emit English claim text — losing the
 * source-language framing of a bilingual brain.
 *
 * This appends a short directive to the phase system prompt, driven by the
 * `dream.curation.output_language` config (DB plane, like `models.tier.*`):
 *   - unset / "source" (default): match the detected dominant language of the input.
 *   - "off" / "none":             no directive (prior native behavior).
 *   - a language code ("ko","en","ja","zh",…): force that language.
 *
 * Prompts stay hardcoded; only the policy is config-driven — no fork of the
 * prompt text, and default behavior is unchanged for English users.
 */

const LANG_NAMES: Record<string, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
};

/**
 * Cheap, dependency-free dominant-language detection by script. Hangul-heavy
 * text → 'ko', otherwise 'en'. Intentionally conservative (a small amount of
 * Korean in mostly-Latin text still reads as 'ko', matching how a bilingual
 * user writes: Korean prose with Latin brand/entity names).
 */
export function detectDominantLanguage(text: string): string {
  let hangul = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  // Ratio-based so it works for short and long inputs alike (a small absolute
  // floor avoids classifying mostly-Latin text with a stray Hangul char as ko).
  return hangul >= 2 && hangul >= 0.15 * (hangul + latin) ? 'ko' : 'en';
}

type ConfigReader = { getConfig(key: string): Promise<string | null> } | null;

/**
 * Build the output-language directive to append to a curation phase's system
 * prompt. Returns '' when the policy is disabled or the engine is unavailable
 * (fail-open: never breaks a phase). `sampleText` is the phase input used for
 * "source" detection (e.g. the turn/page content).
 */
export async function curationLanguageDirective(
  engine: ConfigReader,
  sampleText: string,
): Promise<string> {
  let policy = 'source';
  try {
    const v = engine ? await engine.getConfig('dream.curation.output_language') : null;
    if (v && v.trim()) policy = v.trim().toLowerCase();
  } catch {
    /* config unavailable → keep default */
  }
  if (policy === 'off' || policy === 'none') return '';
  const lang = policy === 'source' ? detectDominantLanguage(sampleText) : policy;
  const name = LANG_NAMES[lang] ?? lang;
  return (
    `\n\nOUTPUT LANGUAGE: Write ALL generated text (fact claims, take claim_text, ` +
    `page prose, concept summaries) in ${name}, matching the source. Preserve proper ` +
    `nouns, brand names, numbers, and the user's exact wording verbatim; do NOT translate ` +
    `the user's content into another language.`
  );
}
