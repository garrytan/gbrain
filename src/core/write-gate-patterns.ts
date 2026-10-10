/**
 * #5575 write gate: the deterministic instruction detector's pattern table.
 *
 * Pure data, no model call (P8 zero-LLM write contract). Four reason
 * families: `override` (instruction overrides, from `think/sanitize.ts`
 * INJECTION_PATTERNS and `transcripts/render.ts` IMPERATIVE_RES),
 * `standing_instruction` (rules addressed to an agent: "from now on ...",
 * "assistant, always ...", "when asked about X say Y"), `exfiltration`
 * (forwarding or leaking data to an address or URL as a standing rule, a
 * templated exfil URL, revealing the system prompt) and `credential` (asking
 * for keys, passwords and tokens to be shared).
 *
 * Patterns run against text `normalizeForGate` already prepared: NFKC,
 * zero-width and bidi controls removed, lowercased, whitespace collapsed to
 * single spaces with paragraph breaks kept as `\n`. Every quantifier is
 * bounded so a match spans at most `MAX_MATCH_CHARS` characters
 * (`scripts/check-write-gate-regex.ts` proves both in `bun run verify`), and
 * `anchors` is a cheap substring prefilter: a pattern only runs on a window
 * containing one of them.
 */
import { INJECTION_DETECTION_PATTERNS } from './think/sanitize.ts';
import { IMPERATIVE_RES } from './transcripts/render.ts';

export type WriteGateReasonFamily = 'override' | 'standing_instruction' | 'exfiltration' | 'credential';
export const WRITE_GATE_REASON_FAMILIES: readonly WriteGateReasonFamily[] = ['override', 'standing_instruction', 'exfiltration', 'credential'];

export interface WriteGatePattern {
  name: string;
  family: WriteGateReasonFamily;
  rx: RegExp;
  /**
   * Prefilter: the pattern runs only on a window containing one of these.
   * Each anchor is lowercase words (or `@`); a window "contains" it when it
   * has a whole word equal to the anchor's longest word, so every word of an
   * anchor must appear exactly (not as a prefix) in any text the pattern matches.
   */
  anchors: readonly string[];
  /** A second prefilter group: the window must also contain one of these. */
  requires?: readonly string[];
  /** A match directly preceded by a negation ("never", "not", "n't", "no") does not count. */
  negatable?: boolean;
  /**
   * Context before the match: the pattern counts only where this `$`-anchored
   * regex matches the `MAX_PRECEDING_CHARS` characters before it, and its
   * optional `neg` group (a negation word) did not take part. Lets a pattern
   * start scanning at its rare token (an address, a "from now on", a
   * credential noun) instead of a common verb.
   */
  preceded?: RegExp;
}

/** Longest text a single pattern can match; windows overlap by this much (plus the preceding context). */
export const MAX_MATCH_CHARS = 480;
/** Longest context a `preceded` regex may need before a match. */
export const MAX_PRECEDING_CHARS = 260;
/** Bound substituted for `+` and `*` in the cloned rewrite patterns. */
export const CLONE_QUANTIFIER_BOUND = 24;

/**
 * Rewrite unbounded `+` / `*` quantifiers to `{1,max}` / `{0,max}`. Escapes
 * and character classes are copied verbatim, so `\+` and `[+*]` keep their
 * meaning; a lazy `?` after the quantifier stays valid.
 */
export function boundQuantifiers(source: string, max = CLONE_QUANTIFIER_BOUND): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') { out += source.slice(i, i + 2); i++; continue; }
    if (ch === '[') {
      let j = i + 1;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
      continue;
    }
    out += ch === '+' ? `{1,${max}}` : ch === '*' ? `{0,${max}}` : ch;
  }
  return out;
}

const CLONE_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  'new-instructions': ['new', 'updated', 'revised'], 'do-anything-now-phrase': ['now', 'mode'], 'dan-mode': ['mode'],
  'print-system': ['print', 'output', 'reveal', 'show'], 'role-jailbreak': ['you'],
};
const CLONE_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  'ignore-prior': ['ignore'], 'forget-everything': ['forget'], disregard: ['disregard'], 'new-instructions': ['instruction', 'instructions'],
  'system-prompt': ['system'], 'role-jailbreak': ['now', 'actually', 'really'], 'do-anything-now-phrase': ['anything', 'developer'],
  'dan-mode': ['dan'], 'print-system': ['system', 'instruction', 'instructions', 'hidden'],
};
const IMPERATIVE_META: ReadonlyArray<{ name: string; anchors: readonly string[]; requires?: readonly string[] }> = [
  { name: 'imperative-ignore-previous', anchors: ['ignore', 'disregard', 'forget'] },
  { name: 'imperative-act-now', anchors: ['now'], requires: ['must', 'should'] },
  { name: 'imperative-new-system-prompt', anchors: ['system'] },
];

/** One character inside a sentence (a fast class for the scanning regexes). */
const SENT = '[^.!?]';
/** One character inside a clause: also stops at a table cell boundary. */
const CLAUSE = '[^.!?|]';
/**
 * One character inside a sentence for `preceded` contexts, which run only on the text before a rare-token
 * match: a `.`, `!` or `?` ends the sentence only when followed by whitespace, so an address, a URL or "3.5"
 * earlier in the sentence does not cut the context short.
 */
const CTX = '(?:[^.!?]|[.!?](?=\\S))';
/** Past participles of the send-it-there verbs, for passive rules ("must be emailed to ..."). */
const PASSIVE_EXFIL = "(?:forwarded|sent|emailed|e-mailed|mailed|cc[’']?d|cced|bcc[’']?d|copied|posted|uploaded|transferred|wired|shared|leaked|synced|mirrored|reported|submitted|routed|rerouted|redirected|exported|remitted|delivered)";
/** "to <address>", allowing a few words before it ("to the portal at https://..."), or "shared with <address>". */
const TO_ADDRESS_HEAD = `\\b(?:to|with) ${'(?:[a-z-]{1,20} )?'.repeat(4)}`;
const FUTURE = '(?:from now on|going forward|henceforth|from this point (?:on|forward)|in (?:all )?future (?:answers|responses|replies|conversations|sessions|chats))';
const AGENT = '(?:ai assistant|assistant|chatbot|ai agent|agent|llm|claude|chatgpt|gpt|gemini|copilot|grok|bot|ai)';
/** In a vocative ("instructions for the model:") "model" addresses the agent too. */
const AGENT_V = '(?:ai assistant|assistant|chatbot|ai agent|agent|llm|claude|chatgpt|gpt|gemini|copilot|grok|bot|ai|(?:language )?model)';
const SPEECH = '(?:say|tell|respond|reply|answer|recommend|mention|claim|state|describe|refer|suggest|output|report|deny|confirm|praise|promote|call|treat|use|ignore|include)';
const ACTION = '(?:forward|send|email|e-mail|cc|bcc|share|reveal|upload|post|transfer|wire|pay|delete|remove|run|execute|invoke|book|buy|approve|grant|disclose)';
const STRICT_SPEECH = '(?:say|tell|respond|reply|answer|recommend|mention|claim|state|deny|reveal|disclose|describe|suggest|output)';
const EXFIL_VERB = '(?:forward|send|email|e-mail|cc|bcc|copy|post|upload|transfer|wire|share|leak|exfiltrate|sync|mirror|report|submit|route|reroute|redirect|export|remit|deliver|'
  + PASSIVE_EXFIL + ')';
const STANDING = '(?:always|from now on|going forward|moving forward|henceforth|whenever|every time|automatically|silently|secretly|quietly|without (?:telling|notifying|asking)|all future|any future|every future|in (?:the )?future|effective immediately|until further notice|from this point(?: on| forward)?|new (?:policy|rule|procedure|process))';
/** An email address (whole host), or a URL / www host, so a rule after it ("... to x@a.b.c from now on") still reads on. */
const ADDRESS = `(?:[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,30}${'(?:\\.[a-z0-9-]{1,30})?'.repeat(3)}\\.[a-z]{2,24}|(?:https?:\\/\\/|www\\.)[^\\s<>"']{1,120})`;
const CREDENTIAL = '(?:api[ _-]?keys?|passwords?|passphrases?|credentials?|secret keys?|access tokens?|auth(?:entication)? tokens?|bearer tokens?|refresh tokens?|private keys?|ssh keys?|seed phrases?|recovery (?:codes?|phrases?)|2fa codes?|one-time (?:codes?|passwords?)|session (?:cookies?|tokens?)|\\.env files?)';

/**
 * Literal spaces in a pattern source become `\s{1,4}` (and ` ?` becomes
 * `\s{0,4}`), so a doubled space or a hard-wrapped line cannot split a
 * phrase; character classes are copied verbatim.
 */
export function spaced(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') { out += source.slice(i, i + 2); i++; continue; }
    if (ch === '[') {
      let j = i + 1;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch !== ' ') { out += ch; continue; }
    if (source[i + 1] === '?') { out += '\\s{0,4}'; i++; } else out += '\\s{1,4}';
  }
  return out;
}

function own(name: string, family: WriteGateReasonFamily, source: string, anchors: readonly string[],
  extra: Pick<WriteGatePattern, 'requires' | 'negatable'> & { preceded?: string } = {}): WriteGatePattern {
  const { preceded, ...rest } = extra;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- sources are this module's literal table, vetted by scripts/check-write-gate-regex.ts (bounded, no nesting, no backrefs)
  return { name, family, rx: new RegExp(spaced(source), 'i'), anchors, ...rest, ...(preceded ? { preceded: new RegExp(`${spaced(preceded)}$`, 'i') } : {}) };
}

const AGENT_ANCHORS = ['assistant', 'chatbot', 'agent', 'llm', 'claude', 'chatgpt', 'gpt', 'gemini', 'copilot', 'grok', 'bot', 'ai'];
const STANDING_ANCHORS = ['always', 'from now on', 'going forward', 'moving forward', 'henceforth', 'whenever', 'every time', 'automatically', 'silently', 'secretly', 'quietly', 'without', 'future',
  'effective immediately', 'until further notice', 'from this point', 'new policy', 'new rule', 'new procedure', 'new process'];
const ADDRESS_ANCHORS = ['@', 'http', 'https', 'www'];
const FUTURE_ANCHORS = ['from now on', 'going forward', 'henceforth', 'from this point', 'future answers', 'future responses', 'future replies', 'future conversations', 'future sessions', 'future chats'];
const CREDENTIAL_ANCHORS = ['key', 'keys', 'api', 'apikey', 'password', 'passwords', 'passphrase', 'passphrases', 'credential', 'credentials', 'token', 'tokens', 'seed', 'recovery', '2fa', 'one-time', 'cookie', 'cookies', '.env'];
const MODAL_ANCHORS = ['always', 'never', 'must', 'should', 'do not', "don't", 'from now on', 'going forward', 'henceforth'];

/** The detector's own patterns (written bounded; the clones are bounded by `boundQuantifiers`). */
const OWN_PATTERNS: readonly WriteGatePattern[] = [
  own('ignore-your-instructions', 'override',
    `\\b(?:ignore|disregard|forget|bypass)\\b (?:all |any )?(?:of )?(?:your|the|these|those)? ?(?:previous|prior|above|earlier|preceding|original|initial|system|safety) ${SENT}{0,20}\\b(?:instructions?|prompts?|rules|guidelines|guardrails|directives|policies|context|messages?)\\b`,
    ['ignore', 'disregard', 'forget', 'bypass']),
  own('ignore-your-rules', 'override',
    '\\b(?:ignore|disregard|bypass)\\b (?:all )?your (?:instructions?|rules|guidelines|programming|system prompt|guardrails)\\b',
    ['ignore', 'disregard', 'bypass']),
  own('conceal-from-user', 'override',
    "\\b(?:do not|don't|never)\\b (?:tell|inform|notify|alert|warn|mention (?:this |it )?to|reveal (?:this |it )?to) (?:the )?(?:user|owner|human|operator)\\b",
    ['user', 'owner', 'human', 'operator']),
  own('conceal-standing-action', 'override',
    "\\b(?:never|do not|don't) (?:mention|tell|reveal|disclose|inform|notify|alert|flag) (?:(?:it|this|that|them) (?:to )?)?(?:the user|the owner|the human|me|it|this|that|them)\\b",
    ['never', "don't", 'not'], { requires: STANDING_ANCHORS, preceded: `\\b${STANDING}\\b${CTX}{0,160}` }),
  own('act-without-asking', 'standing_instruction',
    '\\bwithout (?:asking|checking(?: with)?|confirming(?: with)?|consulting|telling|notifying|alerting|informing) (?:the user|the owner|the human|me|anyone|anybody|first)\\b',
    ['without'], { requires: STANDING_ANCHORS, preceded: `\\b${STANDING}\\b${CTX}{0,160}` }),
  own('redacted-marker', 'override', '\\[redacted(?:-attr)?\\]', ['redacted']),
  own('from-now-on-lead', 'standing_instruction',
    `\\b${FUTURE}\\b${SENT}{0,100}\\b(?:${SPEECH}|${ACTION}|(?:is|are|must|should|shall|will) (?:to )?be (?:called|referred to|described|treated|considered|known|listed|presented|named|introduced))\\b`,
    FUTURE_ANCHORS),
  own('from-now-on-trail', 'standing_instruction',
    `\\b${FUTURE}\\b`,
    FUTURE_ANCHORS, { preceded: `\\b(?:${SPEECH}|${ACTION})\\b${CTX}{0,100}` }),
  own('agent-vocative-note', 'standing_instruction',
    `\\b(?:(?:note|message|reminder|instructions?|attention|attn|memo) (?:to|for) (?:the |any |all |my |our |your )?(?:ai |llm )?|(?:dear|hey|hello|attention|attn) (?:the )?)${AGENT_V}\\b(?:${CLAUSE}{0,200}\\b(?:always|never|must|should|do not|don't|from now on|going forward)\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})| ?[:,] ?(?:please )?(?:always |never |only )?(?:${SPEECH}|${ACTION}))\\b`,
    ['note', 'message', 'reminder', 'instruction', 'instructions', 'attention', 'attn', 'memo', 'dear', 'hey', 'hello'], { requires: [...AGENT_ANCHORS, 'model'] }),
  own('agent-vocative-any', 'standing_instruction',
    `\\b(?:to|for) (?:any|all|every) (?:ai |llm )?${AGENT_V}s? (?:reading|seeing|processing|handling|that reads|who reads)\\b${CLAUSE}{0,200}\\b(?:always|never|must|should|do not|don't|from now on|going forward)\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})\\b`,
    ['reading', 'seeing', 'processing', 'handling', 'reads'], { requires: ['any', 'all', 'every'] }),
  own('agent-standing-rule', 'standing_instruction',
    `\\b${AGENT}\\b(?: ?[,:]${CLAUSE}{0,200}\\b(?:always|never|must|should|do not|don't|from now on|going forward)\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})|${SENT}{0,40}\\b(?:always|never|from now on|going forward|henceforth)\\b${SENT}{0,40}\\b(?:${STRICT_SPEECH}|${ACTION})| (?:is|are|will be|shall be) (?:instructed |required |expected |supposed )?to (?:always |never |only )?(?:${SPEECH}|${ACTION}))\\b`,
    AGENT_ANCHORS, { requires: [...MODAL_ANCHORS, 'is', 'are', 'will', 'shall'] }),
  own('you-always-say', 'standing_instruction',
    `\\byou\\b${SENT}{0,30}\\b(?:always|never)\\b${SENT}{0,40}\\b${STRICT_SPEECH}\\b`,
    ['you'], { requires: ['always', 'never'] }),
  own('imperative-always-say', 'standing_instruction',
    `\\b(?:always|never) ${STRICT_SPEECH}\\b`,
    ['always', 'never'], { preceded: '(?:[.!?:;\\n] ?|- )(?:please )?' }),
  own('when-asked-say', 'standing_instruction',
    `\\b(?:asks?|asked|asking|inquires?|wants to know|comes? up|is brought up)\\b${SENT}{0,80}\\b(?:say|tell|respond|reply|answer|response|claim|state|insist|deny|recommend)\\b`,
    ['ask', 'asks', 'asked', 'asking', 'inquire', 'inquires', 'wants to know', 'come up', 'comes up', 'brought up'],
    { requires: ['say', 'tell', 'respond', 'reply', 'answer', 'response', 'claim', 'state', 'insist', 'deny', 'recommend'], preceded: `\\b(?:when|whenever|if)\\b${CTX}{0,60}` }),
  own('exfil-standing-lead', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}`, STANDING_ANCHORS,
    { requires: ADDRESS_ANCHORS, preceded: `\\b${STANDING}\\b${CTX}{0,80}\\b${EXFIL_VERB}\\b${CTX}{0,80}` }),
  own('exfil-standing-trail', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}${SENT}{0,80}\\b${STANDING}\\b`, STANDING_ANCHORS,
    { requires: ADDRESS_ANCHORS, preceded: `\\b${EXFIL_VERB}\\b${CTX}{0,80}` }),
  own('exfil-agent-addressed', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}`, AGENT_ANCHORS,
    { requires: ADDRESS_ANCHORS, preceded: `\\b${AGENT}\\b${CTX}{0,60}\\b${EXFIL_VERB}\\b${CTX}{0,80}` }),
  own('exfil-private-data', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}`,
    ['memory', 'memories', 'history', 'system prompt', 'private notes', 'user data', ...CREDENTIAL_ANCHORS],
    { requires: ADDRESS_ANCHORS, preceded: `\\b${EXFIL_VERB}\\b${CTX}{0,40}\\b(?:memor(?:y|ies)|conversation history|chat history|system prompt|private notes|user data|${CREDENTIAL})\\b${CTX}{0,60}` }),
  own('exfil-standing-direct', 'exfiltration', `\\b(?:cc|bcc|copy|loop in|e-?mail) (?:in )?${ADDRESS}`, ['cc', 'bcc', 'copy', 'loop', 'email', 'e-mail'],
    { requires: ADDRESS_ANCHORS, preceded: `\\b${STANDING}\\b${CTX}{0,80}` }),
  own('exfil-passive-now', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}`, ['now'],
    { requires: ADDRESS_ANCHORS, preceded: `\\bnow (?:be|get|gets) (?:[a-z]{1,15} )?${PASSIVE_EXFIL}\\b${'(?: [a-z-]{1,15})?'.repeat(2)} ?` }),
  own('exfil-private-data-passive', 'exfiltration', `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDRESS}`,
    ['memory', 'memories', 'history', 'system prompt', 'private notes', 'user data', ...CREDENTIAL_ANCHORS],
    { requires: ADDRESS_ANCHORS, preceded: `\\b(?:memor(?:y|ies)|conversation history|chat history|system prompt|private notes|user data|${CREDENTIAL})\\b${CTX}{0,60}\\b(?:be|get|gets|got) (?:[a-z]{1,15} )?${PASSIVE_EXFIL}\\b${CTX}{0,20}` }),
  own('exfil-templated-url', 'exfiltration',
    'https?:\\/\\/[^\\s)"\'<>]{1,200}[?&][a-z0-9_]{1,30}= ?(?:\\{|<|\\[|%7b|\\$\\{)',
    ['http', 'https']),
  own('credential-request', 'credential',
    `\\b${CREDENTIAL}\\b`,
    CREDENTIAL_ANCHORS, { requires: ['send', 'email', 'e-mail', 'share', 'reveal', 'paste', 'give', 'forward', 'upload', 'disclose', 'leak', 'dump', 'exfiltrate', 'tell'], preceded: "(?:(?<neg>\\bnever|\\bnot|n't|\\bno) )?\\b(?:send|email|e-mail|share|reveal|paste|give|forward|upload|disclose|leak|dump|exfiltrate|tell)\\b (?:me |us |them )?(?:all |any |a copy of )?(?:of )?(?:your|the|their|our|my|these|those|all|any) (?:[a-z0-9-]{1,20} )?" }),
];

/** The full detector table: bounded clones first, then the detector's own patterns. */
export const WRITE_GATE_PATTERNS: readonly WriteGatePattern[] = [
  ...INJECTION_DETECTION_PATTERNS.map(p => ({
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- bounded clone of a literal pattern, vetted by scripts/check-write-gate-regex.ts
    name: p.name, family: p.family, rx: new RegExp(boundQuantifiers(p.rx.source), p.rx.flags), anchors: CLONE_ANCHORS[p.name] ?? [],
    ...(CLONE_REQUIRES[p.name] ? { requires: CLONE_REQUIRES[p.name] } : {}),
  })),
  ...IMPERATIVE_RES.map((rx, i) => ({
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- bounded clone of a literal pattern, vetted by scripts/check-write-gate-regex.ts
    name: IMPERATIVE_META[i]!.name, family: 'override' as const, rx: new RegExp(boundQuantifiers(rx.source), rx.flags.replace('g', '')), anchors: IMPERATIVE_META[i]!.anchors,
    ...(IMPERATIVE_META[i]!.requires ? { requires: IMPERATIVE_META[i]!.requires } : {}),
  })),
  ...OWN_PATTERNS,
];
