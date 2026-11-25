/**
 * Dedupe v2 (GST-3609): how the evidence on a pair combines into what would happen to it, and the classes it is counted
 * and sampled under. Pure.
 *
 * A pair links only on one exclusive signal (C1, C3, M1, X1) with the names agreeing, or on two strong signals of
 * different kinds (email E1 or E4, messaging M3, company plus shared history C4) with the names agreeing. Supporting
 * signals (E3, M2) never make the second signal; they only order the waiting list. Signals of one kind count once.
 * Any contradiction (C6, Mx, X2 beside other evidence) waits; X2 alone marks the pair probably different. A page
 * labelled family or about a minor, or whose title reads as a room, a team, a mailbox or a business, never links
 * automatically. C1's twin with disagreeing names (C2) links only on X1, or
 * on email plus messaging. Two pages in one source that share an id and a name (C7) collapse.
 */
import type { BaseClass } from './people.ts';
import type { EmailSignal } from './email.ts';
import type { MessagingSignal } from './messaging.ts';

export type Signal = 'C4' | EmailSignal | MessagingSignal | 'X0' | 'X1' | 'X2';
export type Verdict = 'link' | 'collapse' | 'wait' | 'different';

export const PAIR_CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'M1', 'X1', 'X2', 'C5+email+messaging', 'C5+email+C4', 'C5+messaging+C4'] as const;
export type PairClass = typeof PAIR_CLASSES[number];
export const VERDICTS: readonly Verdict[] = ['link', 'collapse', 'wait', 'different'];

export interface PairEvidence {
  base: BaseClass;
  names: boolean | null;
  signals: ReadonlySet<Signal>;
  /** Either page is labelled family or is about a minor. */
  sensitive: boolean;
  /** Either page's title reads as a room, a team, a mailbox or a business. */
  nonPerson?: boolean;
}

const kinds = (s: ReadonlySet<Signal>) => ({ email: s.has('E1') || s.has('E4'), messaging: s.has('M3'), history: s.has('C4') });

export function combine(e: PairEvidence): { verdict: Verdict; reason: string; score: number } {
  const s = e.signals;
  const k = kinds(s);
  const strong = [k.email, k.messaging, k.history].filter(Boolean).length;
  const score = strong * 10 + (s.has('E3') ? 1 : 0) + (s.has('M2') ? 1 : 0);
  const wait = (reason: string) => ({ verdict: 'wait' as const, reason, score });
  if (e.base === 'C6') return wait('contradicting evidence');
  if (s.has('Mx')) return wait('one handle under different names');
  const same = e.base === 'C1' || e.base === 'C3' || e.base === 'C7' || s.has('M1') || s.has('X1') || strong > 0;
  if (s.has('X2')) return same ? wait('the web names two different people') : { verdict: 'different', reason: 'the web names two different people', score };
  if (e.sensitive) return wait('family or minor page');
  if (e.nonPerson) return wait('not a person page');
  if (e.base === 'C7') return e.names === true ? { verdict: 'collapse', reason: 'same source, same name, shared id', score } : wait('names disagree');
  if (e.base === 'C2') {
    if (s.has('X1')) return { verdict: 'link', reason: 'shared email or phone, same web profile', score };
    if (k.email && k.messaging) return { verdict: 'link', reason: 'shared email or phone, email and messaging', score };
    return wait('names disagree');
  }
  if (e.names !== true) return wait('names disagree');
  if (e.base === 'C1') return { verdict: 'link', reason: 'an email or phone only they hold', score };
  if (e.base === 'C3') return { verdict: 'link', reason: 'an account id only they hold', score };
  if (s.has('M1')) return { verdict: 'link', reason: 'a chat handle only one page holds', score };
  if (s.has('X1')) return { verdict: 'link', reason: 'the same web profile from different clues', score };
  if (strong >= 2) return { verdict: 'link', reason: 'two independent kinds of evidence', score };
  return wait(strong ? 'one strong signal' : 'name only');
}

/** Every class a pair is counted and sampled under. A name-only pair with C4 counts as C4, not C5. */
export function classesOf(e: PairEvidence): PairClass[] {
  const s = e.signals;
  const k = kinds(s);
  const out: PairClass[] = [];
  if (e.base !== 'C5' || !k.history) out.push(e.base);
  if (k.history) out.push('C4');
  if (s.has('M1')) out.push('M1');
  if (s.has('X1')) out.push('X1');
  if (s.has('X2')) out.push('X2');
  if (e.base === 'C5') {
    if (k.email && k.messaging) out.push('C5+email+messaging');
    if (k.email && k.history) out.push('C5+email+C4');
    if (k.messaging && k.history) out.push('C5+messaging+C4');
  }
  return out;
}

export function parsePairClass(raw: string): PairClass | null {
  return PAIR_CLASSES.find(c => c.toLowerCase() === raw.trim().toLowerCase()) ?? null;
}
