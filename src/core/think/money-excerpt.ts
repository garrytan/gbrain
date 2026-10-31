/** Preserve a unique, explicitly labelled monetary answer before clipping a page.
 * This selects evidence, never an amount to assert: ambiguous rows retain the
 * normal lexical window and the model still has to interpret the source.
 */
const MONEY_QUESTION = /\b(?:how\s+much|amount|total|price|cost|balance|fee|refund)\b/i;
const ACTIONS = [
  /\bdeposit(?:s|ed|ing)?\b/i,
  /\breimburs(?:e|es|ed|ement|ements|ing)\b/i,
  /\brefund(?:s|ed|ing)?\b/i,
  /\bcharg(?:e|es|ed|ing)\b/i,
  /\b(?:pay|pays|paid|payment|payments|paying)\b/i,
  /\b(?:cost|costs|costing|price|prices|pricing)\b/i,
  /\b(?:owe|owes|owed|owing)\b/i,
  /\bbalances?\b/i, /\bfees?\b/i, /\bpremiums?\b/i, /\brent\b/i,
];
const CURRENCY = /(?:[$€£¥]\s*\d[\d,.]*|\d[\d,.]*\s*(?:USD|EUR|GBP|JPY)\b)/gi;

export function moneyAnswerOffset(content: string, question: string): number | null {
  if (!MONEY_QUESTION.test(question)) return null;
  const wanted = ACTIONS.filter(pattern => pattern.test(question));
  if (wanted.length === 0) return null;
  const candidates: number[] = [];
  let previous: { text: string; end: number } | undefined;
  for (const line of content.matchAll(/[^\r\n]+/g)) {
    const text = line[0];
    if (!text.trim()) continue;
    const amounts = [...text.matchAll(CURRENCY)];
    const labelled = wanted.some(pattern => pattern.test(text)) || (
      previous !== undefined && line.index - previous.end <= 160 && /:\s*$/.test(previous.text) &&
      wanted.some(pattern => pattern.test(previous!.text))
    );
    if (labelled) for (const amount of amounts) candidates.push(line.index + amount.index);
    previous = { text, end: line.index + text.length };
  }
  // Several amounts can refer to different events, claims or subtotals. Do not
  // silently choose one just because its row occurs first.
  return candidates.length === 1 ? candidates[0]! : null;
}
