// #25 — the wording every dream prompt that writes page text shares, so a
// Russian transcript yields Russian pages (CONTEXT.md "Исходный язык",
// ADR-0002). Prompt-only by design: the model, not code, decides the language.

import { slugifyText } from '../cjk.ts';

/**
 * The page-language rule. `input` names what the page is written from, e.g.
 * "the transcript" or "the reflections".
 */
export function sourceLanguageRule(input: string): string {
  return `Write all prose — titles, bodies, lessons and summaries — in the language most of ${input} is written in; never translate it into English or any other language. Keep names, product names, commands and technical terms exactly as the text writes them.`;
}

/**
 * Script-neutral slug characters. "alphanumeric" reads as ASCII to models, so
 * they transliterated or translated Cyrillic slugs; the slug grammar keeps
 * letters of every script (ADR-0001).
 */
export const SLUG_CHARS_RULE = 'lowercase letters of any script, digits and hyphens';

/**
 * Allowing every script is not enough: without this, a model writing a
 * Russian page still picked an English slug (seen on the oneshot synthesize
 * path, which is the default).
 */
export const SLUG_LANGUAGE_RULE = 'the topic words of a slug are written in the language of the page title';

/**
 * extract_atoms' Concept label rule. A label is the key atoms cluster on, so a
 * technical topic gets a descriptive label in the atoms' language even when
 * the text uses an English term ("очереди-сообщений", not "queue").
 */
export const CONCEPT_LABEL_RULE = `concepts are kebab-case TOPIC labels used to cluster atoms into concept
pages (e.g. "очереди-сообщений", "captive-portal"), made of
${SLUG_CHARS_RULE}, in the same language as the atoms — never entity or
brand names. Name a technical topic descriptively in that language even when
the text uses an English term for it. Use the same label for the same topic
across atoms; prefer a label you already used over coining a near-synonym.`;

/**
 * A Concept label is kept only when the slug grammar leaves it unchanged:
 * letters of every script survive, and `concepts/<label>` is exactly the slug
 * the concept page lands on.
 */
export function isConceptLabel(label: string): boolean {
  return label.length > 0 && slugifyText(label, Number.MAX_SAFE_INTEGER) === label;
}
