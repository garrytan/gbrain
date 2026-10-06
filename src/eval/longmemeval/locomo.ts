/**
 * locomo.ts — converts LoCoMo conversations (`locomo10.json`) into the
 * LongMemEval question format `gbrain eval longmemeval` reads, so the
 * retrieval arms run unchanged on LoCoMo.
 *
 * One question per QA, excluding category 5 (adversarial; no evidence). The
 * haystack is the QA's whole conversation; `answer_session_ids` are the
 * sessions holding the QA's evidence dialog ids (`D3:5` → session 3). Session
 * ids are stable per conversation (`conv-44_s3`). Turns keep the speaker's
 * name as their role, so a rendered session reads `**Audrey:** …`; a shared
 * photo appends its caption. Dates use the LongMemEval format
 * (`2023/03/27 (Mon) 13:10`); the question date is the last session's date.
 *
 * The sealed split is converted only with `custodian: true`: development runs
 * never read those conversations.
 */

export const LOCOMO_SEALED_CONVERSATIONS: readonly string[] = ['conv-26', 'conv-30', 'conv-41', 'conv-42', 'conv-43', 'conv-49', 'conv-50'];

export const LOCOMO_CATEGORIES: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' };

interface LocomoTurn { speaker: string; dia_id: string; text: string; blip_caption?: string }
interface LocomoQa { question: string; answer?: string | number; evidence?: string[]; category: number }
export interface LocomoSample { sample_id: string; conversation: Record<string, unknown>; qa: LocomoQa[] }

export interface ConvertedQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  answer_session_ids: string[];
}

export interface LocomoConversion {
  questions: ConvertedQuestion[];
  /** Per conversation: QAs skipped as adversarial or for lack of usable evidence. */
  skipped: Record<string, { adversarial: number; no_evidence: number }>;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `1:10 pm on 27 March, 2023` → `2023/03/27 (Mon) 13:10`. */
export function locomoDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m) on (\d{1,2}) ([A-Za-z]+),? (\d{4})$/i);
  const month = m ? MONTHS.indexOf(m[5].toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`unrecognized LoCoMo session date: ${JSON.stringify(raw)}`);
  const hour = (Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  const day = Number(m[4]);
  const year = Number(m[6]);
  const weekday = DAYS[new Date(Date.UTC(year, month, day)).getUTCDay()];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}/${pad(month + 1)}/${pad(day)} (${weekday}) ${pad(hour)}:${m[2]}`;
}

export function convertLocomo(samples: readonly LocomoSample[], conversations: readonly string[], opts: { custodian?: boolean } = {}): LocomoConversion {
  if (conversations.length === 0) throw new Error('no conversations requested: pass an explicit conversation list');
  const sealed = conversations.filter(c => LOCOMO_SEALED_CONVERSATIONS.includes(c));
  if (sealed.length > 0 && !opts.custodian) throw new Error(`${sealed.join(', ')} ${sealed.length === 1 ? 'is' : 'are'} in the sealed LoCoMo split; only the eval custodian converts sealed conversations`);
  const byId = new Map(samples.map(s => [s.sample_id, s]));
  const unknown = conversations.filter(c => !byId.has(c));
  if (unknown.length > 0) throw new Error(`conversation(s) not in the input: ${unknown.join(', ')}`);

  const out: LocomoConversion = { questions: [], skipped: {} };
  for (const convId of conversations) {
    const conv = byId.get(convId)!.conversation;
    const numbers = Object.keys(conv).map(k => k.match(/^session_(\d+)$/)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b);
    if (numbers.length === 0) throw new Error(`${convId} has no sessions`);
    const sessionIds = numbers.map(n => `${convId}_s${n}`);
    const dates = numbers.map(n => locomoDate(String(conv[`session_${n}_date_time`] ?? '')));
    const sessions = numbers.map(n => (conv[`session_${n}`] as LocomoTurn[]).map(t => ({
      role: t.speaker,
      content: t.blip_caption ? `${t.text} [shares ${t.blip_caption}]` : t.text,
    })));
    const skipped = { adversarial: 0, no_evidence: 0 };
    byId.get(convId)!.qa.forEach((qa, i) => {
      if (qa.category === 5) { skipped.adversarial++; return; }
      const gold = [...new Set((qa.evidence ?? []).map(e => e.match(/^D(\d+):/)?.[1]).filter((n): n is string => n !== undefined).map(Number))]
        .filter(n => numbers.includes(n)).sort((a, b) => a - b).map(n => `${convId}_s${n}`);
      if (gold.length === 0) { skipped.no_evidence++; return; }
      out.questions.push({
        question_id: `${convId}_q${i}`,
        question_type: LOCOMO_CATEGORIES[qa.category] ?? `category-${qa.category}`,
        question: qa.question,
        answer: String(qa.answer ?? ''),
        question_date: dates[dates.length - 1],
        haystack_session_ids: sessionIds,
        haystack_dates: dates,
        haystack_sessions: sessions,
        answer_session_ids: gold,
      });
    });
    out.skipped[convId] = skipped;
  }
  return out;
}
