import { hasCJK } from '../cjk.ts';

export interface ChineseQueryView {
  normalized: string;
  lexicalQueries: string[];
  since?: Date;
  until?: Date;
}

const PROJECT_TERMS: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: '负责人', aliases: ['谁负责', '负责人是谁', '责任人', 'owner'] },
  { canonical: '延期', aliases: ['延误', '推迟', '拖期', '逾期'] },
  { canonical: '风险', aliases: ['隐患', '卡点', '阻塞', '障碍'] },
  { canonical: '进展', aliases: ['进度', '状态', '推进情况'] },
  { canonical: '交付', aliases: ['上线', '发布', '落地'] },
];

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const out = new Date(value);
  out.setDate(out.getDate() + days);
  return out;
}

function parseRelativeWindow(
  query: string,
  now: Date,
): { query: string; since?: Date; until?: Date } {
  const today = startOfDay(now);
  const rules: Array<{
    pattern: RegExp;
    range: () => { since: Date; until: Date };
  }> = [
    { pattern: /最近\s*7\s*天/g, range: () => ({ since: addDays(today, -6), until: addDays(today, 1) }) },
    { pattern: /最近\s*30\s*天/g, range: () => ({ since: addDays(today, -29), until: addDays(today, 1) }) },
    { pattern: /今天/g, range: () => ({ since: today, until: addDays(today, 1) }) },
    { pattern: /昨天/g, range: () => ({ since: addDays(today, -1), until: today }) },
    { pattern: /前天/g, range: () => ({ since: addDays(today, -2), until: addDays(today, -1) }) },
    {
      pattern: /本周/g,
      range: () => {
        const mondayOffset = (today.getDay() + 6) % 7;
        const since = addDays(today, -mondayOffset);
        return { since, until: addDays(since, 7) };
      },
    },
    {
      pattern: /上周/g,
      range: () => {
        const mondayOffset = (today.getDay() + 6) % 7;
        const until = addDays(today, -mondayOffset);
        return { since: addDays(until, -7), until };
      },
    },
    {
      pattern: /本月/g,
      range: () => ({
        since: new Date(today.getFullYear(), today.getMonth(), 1),
        until: new Date(today.getFullYear(), today.getMonth() + 1, 1),
      }),
    },
    {
      pattern: /上月/g,
      range: () => ({
        since: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        until: new Date(today.getFullYear(), today.getMonth(), 1),
      }),
    },
    { pattern: /最近/g, range: () => ({ since: addDays(today, -29), until: addDays(today, 1) }) },
  ];

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(query)) continue;
    rule.pattern.lastIndex = 0;
    const range = rule.range();
    return {
      query: query.replace(rule.pattern, ' ').replace(/\s+/g, ' ').trim(),
      ...range,
    };
  }
  return { query };
}

/**
 * Deterministic Chinese query normalization. It never calls a model and keeps
 * the original meaning available as a lexical variant.
 */
export function normalizeChineseQuery(
  input: string,
  now: Date = new Date(),
): ChineseQueryView {
  const normalized = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!hasCJK(normalized)) {
    return { normalized, lexicalQueries: normalized ? [normalized] : [] };
  }

  const window = parseRelativeWindow(normalized, now);
  let canonical = window.query;
  for (const group of PROJECT_TERMS) {
    for (const alias of group.aliases) {
      canonical = canonical.split(alias).join(group.canonical);
    }
  }
  canonical = canonical.replace(/\s+/g, ' ').trim();

  const variants = new Set<string>();
  if (window.query) variants.add(window.query);
  if (canonical) variants.add(canonical);
  for (const group of PROJECT_TERMS) {
    if (!canonical.includes(group.canonical)) continue;
    for (const alias of group.aliases.slice(0, 2)) {
      variants.add(canonical.replace(group.canonical, alias));
      if (variants.size >= 4) break;
    }
    if (variants.size >= 4) break;
  }
  if (variants.size === 0 && normalized) variants.add(normalized);

  return {
    normalized: canonical || normalized,
    lexicalQueries: [...variants].slice(0, 4),
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
  };
}
