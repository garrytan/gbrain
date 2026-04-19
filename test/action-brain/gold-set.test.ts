import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractCommitments,
  type StructuredCommitment,
  type WhatsAppMessage as ExtractorWhatsAppMessage,
} from '../../src/action-brain/extractor.ts';

interface WhatsAppMessage {
  ChatName: string;
  SenderName: string;
  Timestamp: string;
  Text: string;
  MsgID: string;
}

type ExpectedType = 'owed_by_me' | 'waiting_on';

interface ExpectedCommitment {
  who: string;
  action: string;
  type: ExpectedType;
}

interface BaselineCommitment {
  who: string | null;
  owes_what: string;
  type: 'commitment' | 'follow_up' | 'delegation' | 'decision' | 'question';
  confidence?: number;
  source_message_id?: string | null;
}

interface GoldSetRow {
  id: string;
  message: WhatsAppMessage;
  expectedCommitments: ExpectedCommitment[];
  baselineCommitments: BaselineCommitment[];
}

interface FakeResponse {
  content: Array<
    | {
        type: 'tool_use';
        name: string;
        input: unknown;
      }
    | {
        type: 'text';
        text: string;
      }
  >;
}

const OWNER_ALIASES = ['abhinav bansal', 'abbhinaav', 'abhi', 'abhinav'];
const CHECKED_IN_GOLD_SET_PATH = resolve(import.meta.dir, 'fixtures/gold-set.jsonl');
const PRIVATE_GOLD_SET_PATH = process.env.ACTION_BRAIN_PRIVATE_GOLD_SET_PATH;
const EXTRACT_COMMITMENTS_TOOL = 'extract_commitments';

class DeterministicGoldSetClient {
  public readonly calls: Array<{ model: string; prompt: string; msgId: string }> = [];
  private readonly rowsByMsgId: Map<string, GoldSetRow>;

  constructor(
    rows: GoldSetRow[],
    private readonly options: { dropOneCommitmentFromRowId?: string } = {}
  ) {
    this.rowsByMsgId = new Map(rows.map((row) => [row.message.MsgID, row]));
  }

  messages = {
    create: async (params: { model: string; messages: Array<{ content: string }> }): Promise<FakeResponse> => {
      const prompt = params.messages[0]?.content ?? '';
      const msgId = extractMsgId(prompt);
      const row = this.rowsByMsgId.get(msgId);

      if (!row) {
        throw new Error(`No deterministic gold-set fixture row for MsgID ${msgId}`);
      }

      let baseline = row.baselineCommitments;
      if (this.options.dropOneCommitmentFromRowId === row.id && baseline.length > 0) {
        baseline = baseline.slice(1);
      }

      this.calls.push({ model: params.model, prompt, msgId });

      return {
        content: [
          {
            type: 'tool_use',
            name: EXTRACT_COMMITMENTS_TOOL,
            input: {
              commitments: baseline.map(toStructuredCommitment),
            },
          },
        ],
      };
    },
  };
}

function loadGoldSet(path: string): GoldSetRow[] {
  const raw = readFileSync(path, 'utf8');
  const rows: GoldSetRow[] = [];

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = JSON.parse(trimmed) as Partial<GoldSetRow>;
    if (!parsed.id || !parsed.message || !Array.isArray(parsed.expectedCommitments) || !Array.isArray(parsed.baselineCommitments)) {
      throw new Error(`Invalid gold-set row at line ${index + 1}`);
    }

    rows.push(parsed as GoldSetRow);
  }

  return rows;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractMsgId(prompt: string): string {
  const match = prompt.match(/"MsgID":"([^"]+)"/);
  if (!match) {
    throw new Error(`Could not extract MsgID from prompt: ${prompt}`);
  }
  return match[1];
}

function toStructuredCommitment(commitment: BaselineCommitment): StructuredCommitment {
  return {
    who: commitment.who,
    owes_what: commitment.owes_what,
    to_whom: null,
    by_when: null,
    confidence: commitment.confidence ?? 0.9,
    type: commitment.type,
    source_message_id: commitment.source_message_id ?? null,
  };
}

function isOwnerName(name: string): boolean {
  const normalized = normalizeText(name);
  return OWNER_ALIASES.some((alias) => normalized.includes(alias));
}

function responsibilityType(who: string | null): ExpectedType {
  const normalizedWho = who ?? '';
  return isOwnerName(normalizedWho) ? 'owed_by_me' : 'waiting_on';
}

function namesMatch(expectedWho: string, predictedWho: string | null): boolean {
  if (!predictedWho) return false;

  const expected = normalizeText(expectedWho);
  const predicted = normalizeText(predictedWho);
  if (!expected || !predicted) return false;

  if (predicted.includes(expected) || expected.includes(predicted)) {
    return true;
  }

  return isOwnerName(expected) && isOwnerName(predicted);
}

function actionsMatch(expectedAction: string, predictedAction: string): boolean {
  const expected = normalizeText(expectedAction);
  const predicted = normalizeText(predictedAction);
  if (!expected || !predicted) return false;

  return predicted.includes(expected) || expected.includes(predicted);
}

function asExtractorMessages(message: WhatsAppMessage): ExtractorWhatsAppMessage[] {
  return [
    {
      ChatName: message.ChatName,
      SenderName: message.SenderName,
      Timestamp: message.Timestamp,
      Text: message.Text,
      MsgID: message.MsgID,
    },
  ];
}

async function computeRecallMetrics(
  rows: GoldSetRow[],
  options: { dropOneCommitmentFromRowId?: string } = {}
): Promise<{
  totalExpected: number;
  totalMatched: number;
  totalPredicted: number;
  falsePositives: number;
  recall: number;
  precision: number;
  extractorCalls: number;
}> {
  const deterministicClient = new DeterministicGoldSetClient(rows, options);
  let totalExpected = 0;
  let totalMatched = 0;
  let totalPredicted = 0;
  let falsePositives = 0;

  for (const row of rows) {
    const predicted = await extractCommitments(asExtractorMessages(row.message), {
      client: deterministicClient,
      ownerName: 'Abhinav Bansal',
      ownerAliases: ['Abbhinaav', 'Abhi', 'Abhinav'],
    });

    const matchedPredictedIndexes = new Set<number>();
    totalExpected += row.expectedCommitments.length;
    totalPredicted += predicted.length;

    for (const expected of row.expectedCommitments) {
      for (let i = 0; i < predicted.length; i += 1) {
        if (matchedPredictedIndexes.has(i)) continue;

        const candidate = predicted[i];
        const whoMatch = namesMatch(expected.who, candidate.who);
        const actionMatch = actionsMatch(expected.action, candidate.owes_what);
        const typeMatch = responsibilityType(candidate.who) === expected.type;

        if (whoMatch && actionMatch && typeMatch) {
          matchedPredictedIndexes.add(i);
          totalMatched += 1;
          break;
        }
      }
    }

    falsePositives += predicted.length - matchedPredictedIndexes.size;
  }

  const recall = totalExpected === 0 ? 1 : totalMatched / totalExpected;
  const precision = totalPredicted === 0 ? 1 : totalMatched / totalPredicted;

  return {
    totalExpected,
    totalMatched,
    totalPredicted,
    falsePositives,
    recall,
    precision,
    extractorCalls: deterministicClient.calls.length,
  };
}

function hasBaselineCommitment(row: GoldSetRow): boolean {
  return row.baselineCommitments.length > 0;
}

function pickRegressionDropRowId(rows: GoldSetRow[]): string {
  const preferred = rows.find((row) => row.id === 'gold-008' && hasBaselineCommitment(row));
  if (preferred) {
    return preferred.id;
  }

  const fallback = rows.find(hasBaselineCommitment);
  if (!fallback) {
    throw new Error('Expected at least one row with baseline commitments for regression gate test');
  }

  return fallback.id;
}

describe('action-brain checked-in gold set recall gate', () => {
  test('loads the checked-in 13-message JSONL fixture', () => {
    const rows = loadGoldSet(CHECKED_IN_GOLD_SET_PATH);
    expect(rows.length).toBe(13);

    const expectedCount = rows.reduce((sum, row) => sum + row.expectedCommitments.length, 0);
    expect(expectedCount).toBeGreaterThan(0);
  });

  test('enforces >=90% recall on the checked-in evaluation set via extractor path', async () => {
    const rows = loadGoldSet(CHECKED_IN_GOLD_SET_PATH);
    const metrics = await computeRecallMetrics(rows);

    console.log(
      `[gold-set] expected=${metrics.totalExpected} matched=${metrics.totalMatched} ` +
      `predicted=${metrics.totalPredicted} false_positives=${metrics.falsePositives} ` +
      `recall=${metrics.recall.toFixed(3)} precision=${metrics.precision.toFixed(3)}`
    );

    expect(metrics.extractorCalls).toBe(rows.length);
    // CI gate for GIT-175: fail the unit lane when recall drops below 90%.
    expect(metrics.recall).toBeGreaterThanOrEqual(0.9);
  });

  test('fails the gate when one expected commitment is dropped', async () => {
    const rows = loadGoldSet(CHECKED_IN_GOLD_SET_PATH);
    const dropRowId = pickRegressionDropRowId(rows);
    const metrics = await computeRecallMetrics(rows, { dropOneCommitmentFromRowId: dropRowId });

    expect(metrics.recall).toBeLessThan(0.9);
  });

  test('validates private gold-set contract when ACTION_BRAIN_PRIVATE_GOLD_SET_PATH is set', () => {
    if (!PRIVATE_GOLD_SET_PATH) {
      expect(true).toBe(true);
      return;
    }

    const privateRows = loadGoldSet(PRIVATE_GOLD_SET_PATH);
    expect(privateRows.length).toBeGreaterThanOrEqual(50);

    const expectedCount = privateRows.reduce((sum, row) => sum + row.expectedCommitments.length, 0);
    expect(expectedCount).toBeGreaterThan(0);
  });
});
