export interface RetrievalQualityGateThresholds {
  top1_match_rate: number;
  recall_at_10: number;
}

export interface RetrievalQualityGateCaseInput {
  id: string;
  query: string;
  gold_slugs: string[];
  candidate_slugs: string[];
}

export interface RetrievalQualityGateInput {
  fixture_id: string;
  thresholds: RetrievalQualityGateThresholds;
  cases: RetrievalQualityGateCaseInput[];
}

export type RetrievalQualityGateStatus = 'passed' | 'failed';

export type RetrievalQualityGateFailureReason =
  | 'top1_miss'
  | 'recall_at_10_miss';

export interface RetrievalQualityGateCaseResult {
  id: string;
  query: string;
  status: RetrievalQualityGateStatus;
  gold_slugs: string[];
  candidate_slugs: string[];
  top1_slug: string | null;
  top1_match: boolean;
  recall_at_10: number;
  missing_gold_slugs: string[];
}

export interface RetrievalQualityGateFailure {
  id: string;
  query: string;
  top1_slug: string | null;
  missing_gold_slugs: string[];
  reason_codes: RetrievalQualityGateFailureReason[];
}

export interface RetrievalQualityGateReport {
  fixture_id: string;
  status: RetrievalQualityGateStatus;
  thresholds: RetrievalQualityGateThresholds;
  top1_match_rate: number;
  recall_at_10: number;
  cases: RetrievalQualityGateCaseResult[];
  failures: RetrievalQualityGateFailure[];
}

export function evaluateRetrievalQualityQrelsGate(
  input: RetrievalQualityGateInput,
): RetrievalQualityGateReport {
  const cases = input.cases.map(evaluateCase);
  const top1MatchRate = average(cases.map((testCase) => testCase.top1_match ? 1 : 0));
  const recallAt10 = average(cases.map((testCase) => testCase.recall_at_10));
  const aggregatePassed = top1MatchRate >= input.thresholds.top1_match_rate
    && recallAt10 >= input.thresholds.recall_at_10;

  return {
    fixture_id: input.fixture_id,
    status: aggregatePassed ? 'passed' : 'failed',
    thresholds: {
      top1_match_rate: input.thresholds.top1_match_rate,
      recall_at_10: input.thresholds.recall_at_10,
    },
    top1_match_rate: top1MatchRate,
    recall_at_10: recallAt10,
    cases,
    failures: cases.flatMap(caseFailure),
  };
}

function evaluateCase(input: RetrievalQualityGateCaseInput): RetrievalQualityGateCaseResult {
  const goldSlugs = uniqueSlugs(input.gold_slugs);
  const candidateSlugs = uniqueSlugs(input.candidate_slugs);
  const top10 = candidateSlugs.slice(0, 10);
  const top1Slug = candidateSlugs[0] ?? null;
  const goldSet = new Set(goldSlugs);
  const top10Set = new Set(top10);
  const missingGoldSlugs = goldSlugs.filter((slug) => !top10Set.has(slug));
  const top1Match = top1Slug !== null && goldSet.has(top1Slug);
  const recallAt10 = goldSlugs.length === 0
    ? 1
    : (goldSlugs.length - missingGoldSlugs.length) / goldSlugs.length;

  return {
    id: input.id,
    query: input.query,
    status: top1Match && missingGoldSlugs.length === 0 ? 'passed' : 'failed',
    gold_slugs: goldSlugs,
    candidate_slugs: candidateSlugs,
    top1_slug: top1Slug,
    top1_match: top1Match,
    recall_at_10: recallAt10,
    missing_gold_slugs: missingGoldSlugs,
  };
}

function caseFailure(testCase: RetrievalQualityGateCaseResult): RetrievalQualityGateFailure[] {
  const reasonCodes: RetrievalQualityGateFailureReason[] = [
    ...(!testCase.top1_match ? ['top1_miss' as const] : []),
    ...(testCase.missing_gold_slugs.length > 0 ? ['recall_at_10_miss' as const] : []),
  ];
  if (reasonCodes.length === 0) return [];

  return [{
    id: testCase.id,
    query: testCase.query,
    top1_slug: testCase.top1_slug,
    missing_gold_slugs: testCase.missing_gold_slugs,
    reason_codes: reasonCodes,
  }];
}

function uniqueSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of slugs) {
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
