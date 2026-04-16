import Anthropic from '@anthropic-ai/sdk';
import type { ActionType } from './types.ts';

export interface WhatsAppMessage {
  ChatName: string;
  SenderName: string;
  Timestamp: string;
  Text: string;
  MsgID: string;
}

export interface StructuredCommitment {
  who: string | null;
  owes_what: string;
  to_whom: string | null;
  by_when: string | null;
  confidence: number;
  type: ActionType;
  source_message_id?: string | null;
}

export interface ExtractCommitmentsOptions {
  client?: AnthropicLike;
  model?: string;
  timeoutMs?: number;
}

export interface QualityGateCase {
  id: string;
  messages: WhatsAppMessage[];
  expected: StructuredCommitment[];
}

export interface QualityGateCaseResult {
  id: string;
  matched: boolean;
  expectedCount: number;
  predictedCount: number;
  missing: string[];
  unexpected: string[];
}

export interface QualityGateEvaluation {
  model: string;
  passRate: number;
  passed: boolean;
  threshold: number;
  totalCases: number;
  passedCases: number;
  cases: QualityGateCaseResult[];
}

export interface QualityGateResult {
  escalated: boolean;
  primary: QualityGateEvaluation;
  final: QualityGateEvaluation;
}

export interface RunCommitmentQualityGateOptions extends ExtractCommitmentsOptions {
  threshold?: number;
  fallbackModel?: string;
}

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

const EXTRACTION_TOOL_NAME = 'extract_commitments';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_THRESHOLD = 0.9;

interface AnthropicLike {
  messages: {
    create: (params: AnthropicCreateParams, options?: AnthropicRequestOptions) => Promise<AnthropicMessageResponse>;
  };
}

interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock | { type: string; [key: string]: unknown };

interface AnthropicToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  tools: Array<{
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: boolean;
    };
  }>;
  tool_choice: { type: 'tool'; name: string };
  messages: Array<{ role: 'user'; content: string }>;
}

let anthropicClient: AnthropicLike | null = null;

export async function extractCommitments(
  messages: WhatsAppMessage[],
  options: ExtractCommitmentsOptions = {}
): Promise<StructuredCommitment[]> {
  if (messages.length === 0) {
    return [];
  }

  const client = options.client ?? getClient();
  const model = options.model ?? HAIKU_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await withTimeoutSignal(timeoutMs, (signal) =>
      client.messages.create(buildExtractionRequest(model, messages), { signal })
    );
    const rawCommitments = parseCommitmentsFromResponse(response);
    return normalizeCommitments(rawCommitments);
  } catch (err) {
    // Queueing/retry behavior lives in pipeline orchestration; extractor never throws on model failures.
    // Log so operators can distinguish "no commitments found" from "extraction failed".
    console.error('[action-brain] Extraction failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function runCommitmentQualityGate(
  goldSet: QualityGateCase[],
  options: RunCommitmentQualityGateOptions = {}
): Promise<QualityGateResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const primaryModel = options.model ?? HAIKU_MODEL;
  const fallbackModel = options.fallbackModel ?? SONNET_MODEL;

  const primary = await evaluateQualityGate(goldSet, {
    ...options,
    model: primaryModel,
    threshold,
  });

  if (primary.passRate >= threshold || goldSet.length === 0) {
    return {
      escalated: false,
      primary,
      final: primary,
    };
  }

  const fallback = await evaluateQualityGate(goldSet, {
    ...options,
    model: fallbackModel,
    threshold,
  });

  return {
    escalated: true,
    primary,
    final: fallback,
  };
}

interface EvaluateQualityGateOptions extends ExtractCommitmentsOptions {
  threshold: number;
}

async function evaluateQualityGate(
  goldSet: QualityGateCase[],
  options: EvaluateQualityGateOptions
): Promise<QualityGateEvaluation> {
  const model = options.model ?? HAIKU_MODEL;
  const cases: QualityGateCaseResult[] = [];

  for (const testCase of goldSet) {
    const predicted = await extractCommitments(testCase.messages, {
      client: options.client,
      model,
      timeoutMs: options.timeoutMs,
    });
    const comparison = compareCommitments(testCase.expected, predicted);

    cases.push({
      id: testCase.id,
      matched: comparison.matched,
      expectedCount: testCase.expected.length,
      predictedCount: predicted.length,
      missing: comparison.missing,
      unexpected: comparison.unexpected,
    });
  }

  const passedCases = cases.filter((c) => c.matched).length;
  const totalCases = cases.length;
  const passRate = totalCases === 0 ? 1 : passedCases / totalCases;

  return {
    model,
    passRate,
    passed: passRate >= options.threshold,
    threshold: options.threshold,
    totalCases,
    passedCases,
    cases,
  };
}

function getClient(): AnthropicLike {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

function buildExtractionRequest(model: string, messages: WhatsAppMessage[]): AnthropicCreateParams {
  return {
    model,
    max_tokens: 1_000,
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description: 'Extract commitments and obligations from WhatsApp messages into structured records.',
        input_schema: {
          type: 'object',
          properties: {
            commitments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  who: {
                    type: ['string', 'null'],
                  },
                  owes_what: {
                    type: 'string',
                  },
                  to_whom: {
                    type: ['string', 'null'],
                  },
                  by_when: {
                    type: ['string', 'null'],
                  },
                  source_message_id: {
                    type: ['string', 'null'],
                  },
                  confidence: {
                    type: 'number',
                  },
                  type: {
                    type: 'string',
                    enum: ['commitment', 'follow_up', 'decision', 'question', 'delegation'],
                  },
                },
                required: ['owes_what'],
                additionalProperties: false,
              },
            },
          },
          required: ['commitments'],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          'Extract commitments from this WhatsApp message batch.',
          'Return only commitments that imply an obligation, follow-up, decision, question, or delegation.',
          'Set source_message_id to the exact MsgID of the message that supports each commitment.',
          'Use null for unknown who or due date fields.',
          JSON.stringify({ messages }),
        ].join('\n\n'),
      },
    ],
  };
}

function parseCommitmentsFromResponse(response: AnthropicMessageResponse): unknown[] {
  const blocks = Array.isArray(response.content) ? response.content : [];

  for (const block of blocks) {
    if (isToolUseBlock(block) && block.name === EXTRACTION_TOOL_NAME) {
      return parseCommitmentsFromUnknown(block.input);
    }
  }

  // Fallback: recover from text JSON if tool output was malformed.
  for (const block of blocks) {
    if (isTextBlock(block)) {
      const parsed = safeJsonParse(block.text);
      if (parsed !== null) {
        return parseCommitmentsFromUnknown(parsed);
      }
    }
  }

  return [];
}

function parseCommitmentsFromUnknown(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  const commitments = value.commitments;
  return Array.isArray(commitments) ? commitments : [];
}

function normalizeCommitments(rawCommitments: unknown[]): StructuredCommitment[] {
  const normalized: StructuredCommitment[] = [];

  for (const raw of rawCommitments) {
    const commitment = normalizeCommitment(raw);
    if (commitment) {
      normalized.push(commitment);
    }
  }

  return normalized;
}

function normalizeCommitment(raw: unknown): StructuredCommitment | null {
  if (!isRecord(raw)) {
    return null;
  }

  const owesWhat = readString(raw.owes_what);
  if (!owesWhat) {
    return null;
  }

  return {
    who: readNullableString(raw.who),
    owes_what: owesWhat,
    to_whom: readNullableString(raw.to_whom),
    by_when: normalizeTimestamp(raw.by_when),
    confidence: normalizeConfidence(raw.confidence),
    type: normalizeActionType(raw.type),
    source_message_id: readNullableString(raw.source_message_id),
  };
}

function normalizeActionType(value: unknown): ActionType {
  if (typeof value !== 'string') {
    return 'commitment';
  }

  switch (value) {
    case 'commitment':
    case 'follow_up':
    case 'decision':
    case 'question':
    case 'delegation':
      return value;
    default:
      return 'commitment';
  }
}

function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return clamp(parsed, 0, 1);
}

function normalizeTimestamp(value: unknown): string | null {
  const timestamp = readNullableString(value);
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // Reject implausible LLM-generated timestamps (>5 years from now in either direction)
  const now = Date.now();
  const fiveYears = 5 * 365.25 * 24 * 60 * 60 * 1000;
  if (date.getTime() < now - fiveYears || date.getTime() > now + fiveYears) {
    return null;
  }

  return date.toISOString();
}

function compareCommitments(
  expected: StructuredCommitment[],
  predicted: StructuredCommitment[]
): { matched: boolean; missing: string[]; unexpected: string[] } {
  const expectedSet = new Set(expected.map(toCommitmentKey));
  const predictedSet = new Set(predicted.map(toCommitmentKey));

  const missing = [...expectedSet].filter((entry) => !predictedSet.has(entry));
  const unexpected = [...predictedSet].filter((entry) => !expectedSet.has(entry));

  return {
    matched: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}

function toCommitmentKey(commitment: StructuredCommitment): string {
  return [
    normalizeForKey(commitment.who),
    normalizeForKey(commitment.owes_what),
    normalizeForKey(commitment.to_whom),
    normalizeForKey(commitment.by_when),
    commitment.type,
  ].join('|');
}

function normalizeForKey(value: string | null): string {
  if (!value) {
    return '';
  }

  if (isIsoTimestamp(value)) {
    return value.slice(0, 10);
  }

  return value.trim().toLowerCase();
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function withTimeoutSignal<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fn(controller.signal).finally(() => {
    clearTimeout(timeout);
  });
}

function readString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function readNullableString(value: unknown): string | null {
  const normalized = readString(value);
  return normalized.length > 0 ? normalized : null;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === 'tool_use' && typeof (block as { name?: unknown }).name === 'string';
}

function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === 'text' && typeof (block as { text?: unknown }).text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
