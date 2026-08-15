#!/usr/bin/env node
/**
 * Import an envelope-v0 file (a JSON serialization of AI chat history; format
 * spec: github.com/memvelope/memvelope) into a brain repo as one Markdown page
 * per conversation, which `gbrain sync` ingests.
 *
 * Usage:
 *   node scripts/envelope-to-gbrain.mjs <envelope.mve.json> [outDir]
 *
 * Zero dependencies. Deterministic. No network. It does NOT call gbrain — it
 * only writes Markdown files.
 *
 * All-or-nothing. Both integrity checks below run BEFORE the first write, so a
 * refused import leaves no partial output behind to be mistaken for a whole one.
 *
 *   1. Declared counts. envelope-v0 requires `meta.conversation_count` and
 *      `meta.message_count`: the envelope states its own totals. Each is judged
 *      on its own. One that disagrees with what the file actually contains, or
 *      that is present but is not a non-negative integer, refuses the import
 *      (exit 2) — a mismatch means the envelope is truncated, hand-edited, or
 *      from a broken converter, and nothing here can tell which part is
 *      missing. A count that is simply absent cannot be checked against
 *      anything; the envelope imports, and stderr names the field whose half of
 *      the check was skipped.
 *   2. Existing target files. A file already occupying a target filename is
 *      only overwritten when it is safe: byte-identical content (a re-import),
 *      or a page this importer wrote from the SAME conversation id (a refreshed
 *      export legitimately updating its own page). Anything else — a foreign
 *      file, or one of our pages whose conversation id cannot be matched — is a
 *      conflict, and the import is refused (exit 2).
 *
 * Output layout:
 *   - One page per conversation, filename = date + conversation id, so shared
 *     titles cannot collide. The filename is that PAIR: a duplicated id whose
 *     two copies carry different `created_at` DATES lands on two files and
 *     nothing collides. A DUPLICATE ID IS NOT THE ONLY WAY TO REACH ONE
 *     FILENAME, though: both halves are slugged — lowercased, every
 *     non-alphanumeric run collapsed to a single `-`, leading and trailing `-`
 *     stripped, and only THEN truncated at 60 characters — so two DISTINCT ids
 *     can map to one name whenever their SLUGS agree on the first 60
 *     characters. Say it on the slug and not on the id, because the raw ids
 *     predict nothing in either direction: `AbC-123` and `abc-123` differ at
 *     character 1 and collide, `x_y` and `x-y` differ at character 2 and
 *     collide, while sixty `-` followed by `a` and sixty `-` followed by `b`
 *     agree on all of their first 60 characters and do NOT collide (the strip
 *     leaves `a` and `b`). This is the same class check 2 already names below —
 *     "truncation at 60 chars, or characters that slug away" — except that
 *     check 2 REFUSES it at exit 2 while the tiebreak below resolves it,
 *     discarding one of two UNRELATED conversations while stderr calls the id
 *     "not unique" and asks for a deduplication that cannot be performed. Real
 *     ChatGPT and Claude exports carry lowercase UUIDs, which `slug` passes
 *     through unchanged, so this is hand-authored-envelope territory rather
 *     than producer output — but that is an observation about vendor data, not
 *     a guarantee: the converter copies `raw.uuid` / `raw.conversation_id`
 *     verbatim and validates nothing, and nothing here distinguishes the two
 *     while resolving a collision.
 *     When two conversations do map to one filename, the copy with the later
 *     `updated_at` is kept and the other is discarded. That rule needs an
 *     orderable `updated_at` on BOTH copies naming two different INSTANTS;
 *     equal instants — which includes two different STRINGS that name one
 *     instant, such as `09:00:00Z` and `14:30:00+05:30` — or a value that is
 *     missing or unreadable on EITHER side, fall back to array order — the
 *     later copy in `conversations[]` wins, as it always did. Either way
 *     stderr names both values and which copy went, and stdout reports
 *     DISTINCT files written, not write calls.
 *   - `id` is `string | null` in envelope-v0 and a converter must not synthesize
 *     one, so null is a conforming shape, not malformed input. Such a
 *     conversation falls back to a POSITIONAL filename (`conv-N`) — a function
 *     of array position, not of identity. That is precisely why check 2 refuses
 *     to overwrite an id-less page: two unrelated exports both put their first
 *     conversation at `conv-1`, and nothing in either file can distinguish
 *     "this conversation, updated" from "a different conversation entirely".
 *     BE PLAIN THAT THE TWO CHECKS DISAGREE HERE: within ONE envelope that name
 *     is not refused but resolved — a positional `conv-1` and any real id that
 *     SLUGS to `conv-1` share a filename, the `updated_at` tiebreak above picks
 *     between them, and stderr reports a duplicate id where one of the two
 *     conversations has no id at all (with the id-less copy second, it prints
 *     `conversation id null is not unique`). It is the same conflation check 2
 *     exists to forbid — two unrelated conversations resolved against one
 *     positional name — though here it is loud and evidence-bearing, with
 *     `updated_at` present on both copies and three stderr lines, rather than
 *     the evidence-free overwrite check 2 refuses at exit 2. Note also that
 *     `id: null` is not the only way INTO the positional namespace: `slug`
 *     falls back to `conv-N` for any id that slugs to empty (`"___"`), and such
 *     a page records that non-null id in frontmatter, so check 2 sees it as an
 *     identity mismatch rather than as an id-less page. None of these are
 *     producer-reachable — a vendor id of `conv-1` or `___` is not — but
 *     `id: null` is.
 *   - Frontmatter: `type: conversation` (keeps pages eligible for
 *     conversation-facts extraction and chronicle behavior after sync), the
 *     source provider, the conversation id, `origin: memvelope/envelope-v0`,
 *     and the `messages:` array described below.
 *   - Page `date` is the first 10 chars of the conversation's ISO-8601
 *     `created_at`.
 *
 * THE BODY IS WRITTEN FOR GBRAIN'S OWN CONVERSATION PARSER.
 *
 * Every page here declares `type: conversation`, which is what opens the gate to
 * conversation-facts extraction, chronicle eligibility, and the
 * conversation_format_coverage check.
 *
 * ELIGIBLE IS NOT AUTOMATIC, and the difference is the whole reason to say this
 * out loud. The path that accepts these pages is `gbrain
 * extract-conversation-facts` (src/commands/extract-conversation-facts.ts) — a
 * command somebody starts, whether by hand, as a background job, or through a
 * `doctor` remediation. Its autopilot wrapper is the
 * `conversation_facts_backfill` cycle phase, and that phase is opt-in and OFF
 * by default (`cycle.conversation_facts_backfill.enabled`, default false —
 * src/core/cycle/conversation-facts-backfill.ts). A plain `gbrain sync` does
 * not start either one.
 *
 * What the type buys is ADMISSION to that command, not a trigger for it, and it
 * is one admission among several: `ALLOWED_TYPES` there is `conversation`,
 * `meeting`, `slack`, `email`, `imessage`, `imessage-daily`, and the command
 * defaults to the whole list. A page typed outside that set is ineligible
 * rather than merely un-run — which is the reason to declare `conversation`
 * here — but `conversation` is not privileged within it.
 *
 * Sync's own generic facts backstop is a SEPARATE gate and it does not accept
 * these pages on the type at all: `conversation` is absent from `ELIGIBLE_TYPES`
 * in src/core/facts/eligibility.ts. It has a slug escape hatch ORed with the
 * type test — `RESCUE_SLUG_PREFIXES = ['meetings/', 'personal/', 'daily/']` —
 * so a page written into an outDir that syncs under one of those prefixes IS
 * picked up by a plain sync, provided its body clears the 80-character
 * `MIN_BODY_CHARS` floor. The default outDir (`./brain/conversations`) is not
 * one of them, so on the default path nothing extracts facts from these pages
 * until the command above runs.
 *
 * Until 2026-08-02 the body then presented a
 * turn header — `**Assistant** (2025-11-02T14:22:51.000Z · m2):` — matching NONE
 * of the 17 built-in patterns in `src/core/conversation-parser/builtins.ts`
 * (`gbrain conversation-parser list-builtins` counts them). The
 * extractor parsed zero messages, incremented `pages_skipped`, and said nothing:
 * pages stored and searchable, no facts ever extracted from any of them.
 *
 * The header is now the one shape that parser reads:
 *
 *   **Me** (2025-11-02 14:22):
 *
 *   message text, on the following lines
 *
 * matching the `imessage-slack` built-in. That pattern's regex accepts
 * `YYYY-MM-DD` plus `H:MM` and an OPTIONAL AM/PM — a full RFC 3339 timestamp
 * does not match it (the `T` alone is enough to miss), and neither does anything
 * appended after the time. So the header can carry a wall clock and nothing
 * else, and per-message identity has to live in frontmatter:
 *
 *   messages:
 *     - id: "m1"
 *       ts: "2025-11-02T14:22:51.000Z"
 *     - id: "m2"
 *       ts: "2025-11-02T14:24:03.000Z"
 *
 * TO READ IDENTITY BACK, a consumer parses the page's YAML frontmatter and
 * indexes `messages` BY POSITION: `messages[i]` is the i-th turn of the body, in
 * body order. There is no id in the body to join on. Both fields are copied from
 * the envelope verbatim — `id` is the message id, `ts` the original RFC 3339
 * timestamp (or `null`, which envelope-v0 permits). The body header is derived
 * FROM `ts` and is lossier than it by construction: minute resolution, UTC, and
 * a fallback whenever `ts` is null OR is a string this script will not read a
 * clock out of — a date with no time, a basic-format `20251102T142251Z`, an
 * impossible `2025-02-30`, anything non-string. `ts` is the record; the header
 * is the anchor, and only the record is lossless.
 *
 * Worth being plain about how much the array rescues: for a CONFORMING envelope
 * `id` is positional by spec (`m1`, `m2`, … restarting per conversation), so it
 * is derivable from the index and carries no information the position does not.
 * `ts` is the genuinely new value here. The `id` is recorded anyway because the
 * spec is what makes it derivable, and a non-conforming or future producer is
 * not bound by it.
 *
 * Every value TAKEN FROM THE ENVELOPE is JSON-encoded, so every timestamp
 * envelope-v0 can carry — `string | null` — is QUOTED or the bare `null`. (The
 * handful of fixed keys this script writes itself — `type: conversation`,
 * `origin:`, an absent `date: null`, an empty `messages: []` — are literals
 * under its own control, not envelope data.) Unquoted, an RFC 3339
 * scalar is read by js-yaml as a JS `Date`: microseconds truncate, a `+05:30`
 * offset is normalised away, the lexical form changes — and gbrain's own
 * `coerceFrontmatterString` (src/core/markdown.ts) slices a Date to its first
 * 10 characters, losing the time of day entirely. It is sticky, too: a Date
 * re-serializes unquoted and stays a Date on every later round trip.
 * `test/envelope-to-gbrain.test.ts` fails if a timestamp is ever emitted
 * unquoted, and carries a sentinel proving that guard fires.
 *
 * The precise claim, because "everything is quoted" would be false: JSON
 * quotes STRINGS. A non-conforming envelope whose `ts` is a number emits
 * `ts: 1762093371000` — unquoted, and a YAML integer rather than a Date, so it
 * is lossless and carries no `Date` hazard, but it is not a quoted scalar
 * either. Same for a non-string `id`, and a missing `id` (the schema requires
 * one) emits `id: null`, which is indistinguishable from a legitimate
 * `ts: null`. Coercing non-conforming types is deliberately not attempted here;
 * the behavior is pinned by test so it cannot drift unnoticed.
 *
 * The array survives a gbrain rewrite SEMANTICALLY, not textually.
 * `serializeMarkdown` re-emits `id: "m1"` as `id: m1` and `ts: "…"` as
 * `ts: '…'` — values and order identical, quoting style not. Anything that
 * reads this page by parsing YAML is fine; anything that reads it by scanning
 * lines must not assume double quotes.
 *
 * 24-hour, not 12-hour-with-AM/PM. Both match `imessage-slack`, and both were
 * measured to reconstruct all 24 hours exactly, so the tie is broken elsewhere:
 * 24-hour is a substring of the envelope's own `ts` (no hour arithmetic, so the
 * 12/0 boundary cannot be got wrong), it sorts chronologically within a day
 * where 12-hour does not, and it needs no AM/PM marker to disambiguate. The
 * pattern's `time_format: '12h_ampm'` declaration is not a constraint here.
 * Outside builtins.ts it is read in exactly one place — `list-builtins` prints
 * it (src/commands/conversation-parser.ts) — and never by the parser: parse.ts
 * converts off the CAPTURED AM/PM group, which is optional and absent for a
 * 24-hour clock, so `to24h(hour, undefined)` returns the hour unchanged.
 *
 * The stdout receipt reports MESSAGES as well as pages. Counting only pages hid
 * every message-level loss by construction: a conversation that arrives with
 * one turn instead of forty still writes exactly one page.
 *
 * Exit codes: 0 success · 1 usage or unrecognized format · 2 refused import
 * (declared-count mismatch, or a target file that must not be overwritten).
 *
 * Known limits:
 *   - Check 2 is check-then-write, not atomic. Two imports running
 *     SIMULTANEOUSLY into one directory can both pass the check before either
 *     writes, and one then clobbers the other. Measured 2026-08-02 over three
 *     independent sets of 40 trials of two concurrent conflicting imports: 19,
 *     22, and 24 refused out of 40 — roughly half, and it is a race, so expect
 *     the number to move. Against the previous script the same experiment
 *     refused 0 of 40. Closing it needs a lock file, which is a larger change
 *     than this guard. Sequential runs are what this CLI is for, and are what
 *     check 2 covers.
 *   - An id-less conversation cannot be REFRESHED in place. A changed re-import
 *     of an `id: null` export is refused rather than applied, because nothing
 *     in either file distinguishes it from a different conversation at the same
 *     array position. Import it into a fresh directory. This is a deliberate
 *     trade: the same ambiguity, resolved the other way, is what silently
 *     destroyed the earlier import.
 *   - Identity is matched on the conversation id alone, while the filename is
 *     date + id. A conversation whose `created_at` changes between exports
 *     therefore lands on a NEW filename and orphans its earlier page rather
 *     than updating it — duplication, not loss, and true of this script before
 *     these guards existed too.
 *   - THE `updated_at` TIEBREAK IS WITHIN ONE ENVELOPE. It decides which of two
 *     copies in the SAME file survives, and it has no effect across runs: check
 *     2 treats any existing page carrying this conversation's id as this
 *     export's own page to refresh, so importing an OLDER export after a newer
 *     one replaces the newer page at exit 0 with no warning at all. The
 *     identical stale/fresh pair is decided one way inside an envelope and the
 *     other way across two of them. Both rules are deliberate — the cross-run
 *     one is what makes a re-import able to update its own page — but the
 *     asymmetry is real and the cross-run direction is the silent one.
 *   - A file carrying this importer's own frontmatter shape is treated as this
 *     importer's page. There is no signature, so a hand-written lookalike is
 *     indistinguishable from the real thing.
 *   - A PARSER-LEGIBLE PAGE IS NOT THE SAME AS AN EXTRACTED ONE. parse.ts
 *     accepts a page only when at least 5% of its non-blank lines anchor a turn
 *     (SCORING_MIN_ACCEPTANCE), so a conversation of very long turns still
 *     lands on `no_match` and still extracts nothing. Measured 2026-08-02 on
 *     envelopes built by the reference converter, two turns per side: 25
 *     paragraphs per assistant turn parses (density 0.070, 4 of 4 messages), 40
 *     paragraphs does not (0.046, 0 messages). The exact crossover, measured
 *     line by line: 18 non-blank lines per turn parses (0.0526), 19 does not
 *     (0.0499) — the H1 counts in the denominator too. So turns averaging more
 *     than ~18 non-blank lines of prose fall below the floor. That threshold
 *     lives in gbrain's parser, not here — this script cannot raise it, and
 *     long-form assistant answers sit close to it.
 *   - ★ A PASTED TRANSCRIPT CAN REPLACE THE WHOLE CONVERSATION, and nothing
 *     reports it. This is the sharpest limit here and it is not fixable from
 *     this script.
 *
 *     A message whose own text contains lines shaped like SOME OTHER export
 *     format — anyone who has pasted a Slack, Discord, Telegram or IRC snippet
 *     into a chat — puts those lines in the body too. parse.ts picks ONE
 *     pattern per page, scored on the first 10 body lines
 *     (SCORING_HEAD_LINES), and only re-scores against the full body when that
 *     head score falls under 0.3. So the pasted block only has to win the head
 *     window; the length of the real conversation is irrelevant. Measured, with
 *     four `**[09:0N] Colleague N:**` lines quoted inside message 1:
 *
 *       real turns  pasted lines  winner            frontmatter / body turns
 *                2             2  imessage-slack        2 / 2
 *                2             3  telegram-bracket      2 / 3
 *                4             4  telegram-bracket      4 / 4   <- counts AGREE
 *               40             4  telegram-bracket     40 / 4
 *
 *     In the last row all forty real turns are gone and four fabricated
 *     speakers at fabricated times reach the fact extractor in their place —
 *     at exit 0, with `phase: regex_match`, so `pages_skipped` stays 0 and
 *     `gbrain doctor` reports `conversation_format_coverage` OK.
 *
 *     Comparing `frontmatter.messages.length` against the parsed turn count
 *     catches three of those four rows and NOT the 4/4 one, where the counts
 *     agree while every speaker and timestamp is fabricated. Count is a
 *     smoke alarm, not a proof. Closing this needs a change in parse.ts —
 *     fenced-code awareness, or per-pattern scoring that does not let a
 *     ten-line window speak for the page.
 *   - Neither does the parser respect fenced code blocks: a turn header inside
 *     ``` ``` ``` still anchors a turn. `inferTitleFromBody` in markdown.ts
 *     tracks fences; parse.ts does not.
 *   - `messages[i]` is positional. The body carries no id to join on, so an
 *     edit that inserts or removes a turn in the body without editing the
 *     frontmatter silently re-points every id after it — and so does any of the
 *     parser behavior above.
 *   - THE DATE IS THE UTC CALENDAR DAY, NOT THE USER'S. The page `date` and
 *     every turn header are read off a timestamp already normalised to UTC, so
 *     a conversation held in the evening west of Greenwich files on the
 *     FOLLOWING day, and one held in the early morning east of it files on the
 *     PREVIOUS day. Measured here, importing under TZ=America/Los_Angeles a
 *     conversation that happened at 19:30 on Sunday 2 November 2025 in
 *     California:
 *
 *       created_at "2025-11-03T03:30:00.000Z"
 *         -> date: "2025-11-03"   (a Monday)
 *         -> **Me** (2025-11-03 03:30):
 *
 *     Anything that groups, windows or reports these pages by day inherits that
 *     shift. The importing machine's own zone changes nothing — the output
 *     above is identical under every TZ, deliberately.
 *
 *     NOT FIXABLE HERE, and the reason is not neglect: the offset is not in the
 *     file this script reads. envelope-v0 renders every timestamp as
 *     `YYYY-MM-DDTHH:mm:ss.sssZ` — "always UTC, always the `Z` designator"
 *     (SPEC.md rule 3) — so an offset a source export DID carry is normalised
 *     away before the envelope reaches this script. Where a source carries no
 *     designator at all, that same rule explains why it is read as UTC rather
 *     than guessed: "The source's true offset is unknowable, and UTC is the
 *     only machine-independent choice."
 *
 *     Recovering the user's own day would therefore take a FORMAT change — a
 *     conversation-level offset envelope-v0 does not have — and on the evidence
 *     available there would usually be nothing to put in it. Across the
 *     reference converter's own input corpus, 13 conversations carry 26
 *     conversation-level timestamps: 20 are bare unix-epoch numbers (ChatGPT
 *     `create_time`/`update_time`, which cannot express a zone at all), 4 end
 *     in `Z`, 2 carry no designator, and NONE carries a numeric offset. What is
 *     NOT available is guessing from the IMPORTING machine's zone: that would
 *     make one envelope produce different pages on two laptops, which is the
 *     determinism this script is built on.
 *   - MINUTE RESOLUTION IS THE CEILING, and it is the parser's, not this
 *     format's. Every branch of `buildIso` in parse.ts hardcodes `:00` seconds,
 *     and no built-in pattern captures a seconds group — `signal-export`
 *     matches seconds in its regex and still discards them. So two turns in the
 *     same minute come back with identical timestamps: `claude-basic` m1
 *     (15:02:00) and m2 (15:02:31) both parse to `2026-06-14T15:02:00Z`.
 *     Anything downstream that orders or windows on the PARSED timestamp sees a
 *     tie. The frontmatter `ts` keeps full resolution and is the only place on
 *     the page that has it.
 *
 * Memory: the whole envelope is held in memory (no streaming); envelopes are
 * far smaller than the vendor exports they serialize.
 *
 * Verify:
 *   node scripts/envelope-to-gbrain.mjs test/fixtures/memvelope/sample.mve.json /tmp/out
 *     -> expect "wrote 1 markdown page(s) (4 message(s))"
 *   bun test test/envelope-to-gbrain.test.ts
 *
 * STATUS:
 *   - 2026-07-03, pre-guard behavior, live-verified against gbrain v0.42.56.0:
 *     the sample fixture -> 1 page; a real 662MB Claude export -> 353
 *     conversations = 353 distinct pages (no collisions), searchable after sync
 *     with provenance and message-id citations intact.
 *   - 2026-08-02, the two guards above: verified against all 12 golden fixtures
 *     from the memvelope reference converter and against fresh envelopes
 *     produced by running that converter over synthetic ChatGPT and Claude
 *     exports. All 19 import at exit 0 with zero stderr bytes, and 18 of them
 *     reproduce every message text byte-verbatim. The exception is the
 *     lone-surrogate golden fixture, where an unpaired `U+D800` becomes
 *     `U+FFFD` on UTF-8 write — behavior of `writeFileSync`, unchanged by these
 *     guards and identical on the previous script. Neither guard has been run
 *     against a full-size real export.
 *   - 2026-08-02, the parser-legible format above. Measured on two throwaway
 *     HOME-redirected PGLite brains fed the SAME 13 conversations, one written
 *     the old way and one the new:
 *       `gbrain conversation-parser scan <slug>`, run once per page (it takes
 *       one slug; there is no aggregate form):
 *                                          13/13 pages `no_match`, 0 messages
 *                                       -> 13/13 `imessage-slack`, 33 messages
 *       `gbrain extract-conversation-facts --dry-run`
 *                                          "Skipped 13 page(s)" (pages_skipped)
 *                                       -> 0 skipped; every page segments and
 *                                          reaches the extractor
 *       `gbrain doctor` conversation_format_coverage
 *                                          warn: "13/13 ... match NO built-in
 *                                          pattern"
 *                                       -> ok: "13 pages: imessage-slack=13"
 *     Over all 12 golden fixtures from the reference converter: exit 0, zero
 *     stderr bytes, 33/33 messages parsed, and every `id`/`ts` recovered from
 *     frontmatter byte-identical to the envelope. Every message text is on disk
 *     verbatim except the lone-surrogate fixture noted above; the parser's own
 *     output additionally collapses blank lines WITHIN a message, so a
 *     multi-paragraph turn comes back joined by single newlines.
 *     Not verified: any full-size real export, and any brain with a chat model
 *     configured — the extractor was reached but its LLM call could not run.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXIT_REFUSED = 2;

const [, , envelopePath, outDir = './brain/conversations'] = process.argv;
if (!envelopePath) {
  console.error('usage: node envelope-to-gbrain.mjs <envelope.mve.json> [outDir]');
  process.exit(1);
}

const env = JSON.parse(readFileSync(envelopePath, 'utf8'));
if (env.memvelope !== 'envelope-v0') {
  console.error(`not an envelope-v0 file (memvelope field = ${JSON.stringify(env.memvelope)})`);
  process.exit(1);
}

const slug = (s, fallback) =>
  (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback).slice(0, 60);

/** A frontmatter value, emitted as JSON.
 *
 *  JSON is valid YAML flow syntax, so this is total for any JSON-serializable
 *  value — and, for the thing that matters here, a string always comes out
 *  QUOTED. An unquoted RFC 3339 scalar is read back as a JS `Date`, which is
 *  lossy (microseconds truncated, offset normalised away) and sticky (it
 *  re-serializes unquoted, so it stays a Date on every later round trip). */
const yamlJson = (v) => JSON.stringify(v === undefined ? null : v);

/** The date a turn header is allowed to carry: exactly `YYYY-MM-DD`. */
const HEADER_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What `deriveDateContext()` in gbrain's conversation parser falls back to when
 *  a page carries no date at all. Reusing it means a dateless conversation's
 *  headers introduce no value gbrain would not have chosen for itself. */
const EPOCH_DATE = '1970-01-01';

/** The RFC 3339 shapes this script will read a wall clock out of.
 *
 *  Deliberately NOT `new Date(string)`: for a date-time with no zone
 *  designator, ECMAScript parses local time, so the same envelope would import
 *  differently on two machines and this script claims to be deterministic.
 *  Groups: 1=Y 2=M 3=D 4=hh 5=mm, then an optional offset 6=sign 7=hh 8=mm. */
const TS_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * The `YYYY-MM-DD HH:MM` a turn header carries, or null when the message's `ts`
 * cannot supply one.
 *
 * 24-hour, and UTC. `imessage-slack` — the pattern these headers are written
 * for — declares `timezone_policy: 'inline_utc'`, i.e. gbrain reads the inline
 * clock AS UTC. So a `+05:30` timestamp must be shifted before it is written;
 * emitting the local wall clock would record every fact 5.5 hours off. A `Z`
 * timestamp, or one with no designator at all, is already taken as UTC and its
 * digits are copied straight across, after the calendar check below — no
 * arithmetic on the common path, so no hour can be shifted by a conversion.
 */
function headerClock(ts) {
  if (typeof ts !== 'string') return null;
  const m = TS_SHAPE.exec(ts.trim());
  if (m === null) return null;
  const [, year, month, day, hour, minute, sign, offsetHour, offsetMinute] = m;
  const [y, mo, d, h, mi] = [year, month, day, hour, minute].map(Number);
  // The regex counts digits; it does not know a calendar. Without this it
  // accepts `2025-99-99T99:99` — and `imessage-slack` MATCHES a header built
  // from those digits, so gbrain stores an instant no calendar contains.
  // `2025-02-30` is worse: it yields a VALID Date silently shifted to March 2.
  // `created_at` is already validated before it reaches a header (see
  // `pageDate`); the per-message clock is the same untrusted surface and is
  // used far more often. Numbers only — no string parsing, so no
  // engine-dependent interpretation of the input; and the UTC setters rather
  // than `Date.UTC`, which applies MakeFullYear and would read a four-digit
  // year of `0050` as 1950.
  if (h > 23 || mi > 59) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(y, mo - 1, d);
  utc.setUTCHours(h, mi, 0, 0);
  // A date that does not survive its own round trip was never a date: month 99
  // and February 30 both roll, and the roll is what this catches.
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    return null;
  }
  // No offset: the digits are already UTC by this script's policy, so they are
  // copied across rather than reformatted. This is the common path, and it does
  // no arithmetic at all.
  if (sign === undefined) return `${year}-${month}-${day} ${hour}:${minute}`;
  const [oh, om] = [offsetHour, offsetMinute].map(Number);
  if (oh > 23 || om > 59) return null;
  utc.setUTCMinutes(utc.getUTCMinutes() - (oh * 60 + om) * (sign === '-' ? -1 : 1));
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  // The year is padded to four digits like every other field: the pattern's
  // regex requires `\d{4}`, so an unpadded `49` would emit a header that does
  // not parse at all — a turn silently merged into its neighbour.
  return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`;
}

/** The RFC 3339 shapes a CONVERSATION-level `updated_at` is ordered by.
 *
 *  Deliberately a second regex rather than `TS_SHAPE`: that one exists to build
 *  a turn header, whose resolution is the minute, so it discards seconds. Two
 *  exports of one conversation are routinely closer together than that, and the
 *  reference converter emits milliseconds always (SPEC.md rule 3 renders every
 *  timestamp as `YYYY-MM-DDTHH:mm:ss.sssZ`), so seconds and fraction are
 *  captured here.
 *  Groups: 1=Y 2=M 3=D 4=hh 5=mm 6=ss 7=.fff, then an offset 8=sign 9=hh 10=mm. */
const UPDATED_AT_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * The instant `updated_at` names, in epoch milliseconds, or null when the value
 * is not one this script will order by.
 *
 * A NUMBER, not a string comparison: `2026-06-09T02:00+05:30` sorts above
 * `2026-06-08T23:00Z` lexically and is two and a half hours EARLIER as an
 * instant. And not `new Date(string)`: a date-time with no zone designator is
 * parsed as LOCAL time by ECMAScript, so the same pair of envelopes would
 * resolve differently on two machines, which this script promises not to do. No
 * designator means UTC here, matching both `headerClock` and the spec, whose
 * reasoning is that the source's true offset is unknowable.
 *
 * Same calendar discipline as `headerClock`: the regex counts digits, so
 * `2026-02-30` reaches it as a well-formed string that `Date` silently rolls to
 * March 2. A value that does not survive its own round trip is not a date, and
 * an envelope is third-party input.
 */
function updatedAtInstant(value) {
  if (typeof value !== 'string') return null;
  const m = UPDATED_AT_SHAPE.exec(value.trim());
  if (m === null) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] = m;
  const [y, mo, d, h, mi] = [year, month, day, hour, minute].map(Number);
  if (h > 23 || mi > 59) return null;
  // 60 is a leap second, which RFC 3339 permits and which names a real instant.
  // It is added AFTER the calendar check below, since `23:59:60` legitimately
  // rolls the date and that roll must not be read as an impossible date.
  const s = second === undefined ? 0 : Number(second);
  if (s > 60) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(y, mo - 1, d);
  utc.setUTCHours(h, mi, 0, 0);
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
    return null;
  }
  // Kept as a number rather than pushed back through `Date`, so a
  // sub-millisecond fraction still participates in the comparison — down to
  // whatever a double has left at epoch scale, which is roughly a microsecond
  // in this century. The reference producer emits exactly three fractional
  // digits (SPEC.md rule 3), so nothing it can write reaches that floor.
  let ms = utc.getTime() + s * 1000 + (fraction === undefined ? 0 : Number(fraction) * 1000);
  if (sign !== undefined) {
    const [oh, om] = [offsetHour, offsetMinute].map(Number);
    if (oh > 23 || om > 59) return null;
    ms -= (oh * 60 + om) * 60000 * (sign === '-' ? -1 : 1);
  }
  return ms;
}

/**
 * Which of two conversations sharing one target filename is kept.
 *
 * `later` is the one further along `conversations[]`; before this existed it
 * simply won, and that is the defect. A merged re-export is the mainstream
 * path — the memvelope CLI's own USAGE tells users to pass every downloaded
 * file at once, the spec forbids the converter from re-sorting them, and folder
 * expansion sorts by FILENAME. Every automatic duplicate-namer a browser or OS
 * applies to a second download of `conversations.json` inserts a character that
 * sorts below `.` (` (1)`, `(1)`, `-1`, ` 2`), so the RE-EXPORT sorts first and
 * the ORIGINAL sorts last. Array order was therefore not arbitrary: it was
 * deterministically wrong, and it kept the stale copy every time.
 *
 * `updated_at` is what decides instead. It is a required conversation key in
 * envelope-v0, both vendor paths of the reference converter populate it
 * (ChatGPT `update_time`, Claude `updated_at`), and nothing here read it.
 *
 * THE FALLBACK, and why it is array order rather than a cleverer guess:
 *
 *   - Equal instants. Nothing distinguishes the two copies, so the rule that
 *     was there before decides. Changing it would only trade one arbitrary
 *     answer for another, and this one is already pinned by test.
 *   - Comparable on only ONE side — absent (the spec allows `null` with no
 *     fallback), non-string, or a string this script will not order by. Both
 *     copies came out of ONE converter run, so the asymmetry is the vendor's:
 *     one source export carried the field for this conversation and the other
 *     did not. Nothing in that fact says which export is newer — a vendor may
 *     have started emitting the field or stopped — so preferring the copy that
 *     HAS a timestamp is a guess dressed as a rule. The tiebreak is applied
 *     only when BOTH copies carry an orderable `updated_at`.
 *
 *     BE PLAIN ABOUT WHAT THAT COSTS. On that slice this rule changes nothing:
 *     array order decides, and array order is the same deterministically-wrong
 *     answer described above, so the stale copy still wins. `updated_at: null`
 *     is producer-reachable — `converter.js` ends both normalizers'
 *     `updated_at` with `|| null` — though it occurs in 0 of the 13
 *     conversations in the reference corpus. What this rule buys on that slice
 *     is only that the outcome is LOUD: stderr prints both values and says
 *     array order decided.
 *   - `created_at` is deliberately not a secondary key. It is when the
 *     conversation began, which is identical in both copies of a re-export and
 *     says nothing about which export is newer.
 *   - THE REDUCTION IS PAIRWISE, folded over `conversations[]` in order. With
 *     every copy orderable that is a true maximum. With three or more copies
 *     where one is NOT orderable, the fold loses transitivity and the freshest
 *     copy overall can still be discarded: `[later, absent, earlier]` keeps
 *     `earlier`, because neither comparison had evidence on both sides. That is
 *     the fallback above doing exactly what it says rather than a separate
 *     defect, and it is what the previous script did too.
 *
 * Either way a collision is a collision: one copy is discarded, and stderr says
 * which, why, and with what values.
 */
function keepsLaterInArray(earlier, later) {
  const a = updatedAtInstant(earlier);
  const b = updatedAtInstant(later);
  if (a === null || b === null || a === b) return { keepLater: true, byUpdatedAt: false };
  return { keepLater: b > a, byUpdatedAt: true };
}

/** The file's contents, or null if it does not exist. Any other error is the
 *  caller's problem to fail on — an unreadable target must never be silently
 *  treated as an absent one, because "absent" is the answer that permits a
 *  write. */
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** The conversation identity recorded in a page this importer previously wrote,
 *  or null if the file is not recognizably one of ours.
 *
 *  A deliberate line scan rather than a YAML parse: this script has no
 *  dependencies, and anything it cannot confidently recognize must fall
 *  through to "foreign" — the answer that refuses the overwrite. `{ id: null }`
 *  means "ours, but written from a conversation that carried no id", which is
 *  a different thing from "not ours" and must not be collapsed into it.
 *
 *  The id scalar is accepted in every shape a YAML round trip produces, not
 *  only the JSON this importer writes. gbrain rewrites pages it holds —
 *  `export --dir`, the DB-only restore path, and put_page write-through all
 *  re-emit frontmatter through gray-matter, which writes a UUID as a plain
 *  unquoted scalar and an all-digit or boolean-looking id single-quoted.
 *  Recognizing only our own JSON meant every one of those rewrites turned the
 *  page "foreign" and a later refresh refused the whole envelope, advising
 *  the user to delete gbrain's own copy. */
function idScalar(rawValue) {
  if (rawValue.startsWith('"')) {
    // Our own emitted shape (JSON is valid YAML flow syntax).
    try {
      const value = JSON.parse(rawValue);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  if (rawValue.startsWith("'")) {
    // YAML single-quoted: the only escape is a doubled quote.
    if (rawValue.length < 2 || !rawValue.endsWith("'")) return null;
    const body = rawValue.slice(1, -1).replace(/''/g, '\u0000');
    if (body.includes("'")) return null;
    const value = body.replace(/\u0000/g, "'");
    // An empty id is not a shape this importer ever writes; stay foreign,
    // exactly as the JSON-only reader did.
    return value === '' ? null : value;
  }
  // Plain scalar. `null`/`~`/empty are YAML null, not a string id — and this
  // importer never writes the key for a null id, so that shape stays foreign.
  if (rawValue === '' || rawValue === 'null' || rawValue === '~') return null;
  return rawValue;
}

function existingPageIdentity(raw) {
  // A page we wrote can pick up cosmetic byte changes without ceasing to be
  // ours: a git checkout with core.autocrlf, a cross-platform sync, an editor
  // that adds a BOM. Refusing to recognize those made a whole envelope
  // unimportable over a line ending, so normalize them away before the scan.
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const ID_KEY = 'memvelope_conversation_id: ';
  let ours = false;
  let id = null;
  for (const line of text.slice(4, end).split('\n')) {
    if (line === 'origin: memvelope/envelope-v0') {
      ours = true;
    } else if (line.startsWith(ID_KEY)) {
      const value = idScalar(line.slice(ID_KEY.length));
      if (value === null) return null;
      id = value;
    }
  }
  return ours ? { id } : null;
}

const conversations = env.conversations || [];

// ---------------------------------------------------------------------------
// Check 1 — the envelope's own declared counts, before anything is written.
//
// Each count is judged on its own. Treating "either field exists" as "the
// envelope is checkable" gave a half-declared envelope a half check and total
// silence, which is the very defect this guard exists to close.
// ---------------------------------------------------------------------------

/** How a declared count is to be read: a usable number, absent, or present but
 *  not a count at all. The third case must not collapse into the second —
 *  saying "declares no count" about a file that declares a broken one is a
 *  false statement, and it would be printed over a real truncation. */
function readDeclaredCount(value) {
  if (value === undefined) return { state: 'absent' };
  if (Number.isInteger(value) && value >= 0) return { state: 'declared', value };
  return { state: 'malformed' };
}

const actualConversations = conversations.length;
const actualMessages = conversations.reduce((sum, c) => sum + (c.messages || []).length, 0);
const counts = [
  { field: 'meta.conversation_count', raw: env.meta?.conversation_count, actual: actualConversations },
  { field: 'meta.message_count', raw: env.meta?.message_count, actual: actualMessages },
].map((c) => ({ ...c, ...readDeclaredCount(c.raw) }));

const malformed = counts.filter((c) => c.state === 'malformed');
if (malformed.length) {
  // envelope-v0 types both counts as non-negative integers. A count that is
  // present but is not one cannot be compared, and an envelope this malformed
  // is not a file to trust with an unchecked import.
  console.error('refusing to import: the envelope declares a count that is not a non-negative integer.');
  for (const c of malformed) console.error(`  ${c.field} = ${JSON.stringify(c.raw)}`);
  console.error('Nothing was written. Re-export, or correct the declared counts if the contents are known-good.');
  process.exit(EXIT_REFUSED);
}

const mismatched = counts.filter((c) => c.state === 'declared' && c.value !== c.actual);
if (mismatched.length) {
  // Fail closed. The counts are the envelope's own statement of what it holds,
  // and they disagree with what it holds — so the file is not what it claims,
  // and nothing here can tell which conversations or turns went missing. A
  // partial import that exits 0 is how an archive silently becomes a fragment.
  console.error("refusing to import: the envelope's declared counts disagree with its contents.");
  // Print both counts, not only the failing one: seeing which half agrees is
  // what tells a truncated download apart from a broken converter.
  for (const c of counts) {
    const declared = c.state === 'declared' ? c.value : 'not declared';
    console.error(`  ${c.field} declared ${declared}, envelope contains ${c.actual}`);
  }
  console.error('This envelope is truncated, hand-edited, or from a broken converter. Nothing was written. Re-export, or correct the declared counts if the contents are known-good.');
  process.exit(EXIT_REFUSED);
}

const absent = counts.filter((c) => c.state === 'absent');
if (absent.length) {
  // envelope-v0 requires both fields, so this file is already non-conforming.
  // Import it anyway — hand-authored envelopes are useful — but never let an
  // unchecked import look identical to a checked one on the way past. Naming
  // the missing field matters: with one count present, only half the envelope
  // was verified, and the receipt alone cannot show which half.
  console.warn(
    `warning: envelope declares no ${absent.map((c) => c.field).join(' and no ')} (envelope-v0 requires both) — integrity check skipped for ${absent.length === 2 ? 'conversations and messages' : absent[0].field.replace('meta.', '').replace('_count', 's')}; a truncated envelope would import silently.`,
  );
}

// ---------------------------------------------------------------------------
// Render every page in memory first. Rendering has no side effects, so the
// conflict check below can see the complete set of target files — including the
// final content of any filename an envelope writes more than once — while the
// output directory is still untouched.
// ---------------------------------------------------------------------------
const pages = new Map();
let collisions = 0;
for (const [i, c] of conversations.entries()) {
  const date = (c.created_at || '').slice(0, 10);
  // Name the file by the conversation's own id, so two conversations that share
  // a date and title can never silently overwrite each other. The KEY IS THE
  // PAIR: date and id together name the file, and the date is not merely a
  // human/chronological prefix — a conversation whose `created_at` changes
  // between exports lands on a new filename, which is the "orphans its earlier
  // page" limit in the header. Positional fallback keeps names unique and
  // deterministic when an envelope omits an id.
  // One predicate for "this conversation carries its own id", shared by the
  // filename, the frontmatter below, and the conflict check further down.
  // Keeping it in a single place is what stops them disagreeing about whether
  // an id exists.
  const hasId = typeof c.id === 'string' && c.id.trim() !== '';
  const convId = hasId ? c.id.trim() : `conv-${i + 1}`;
  // `date` is third-party, exactly like `convId`, so it gets the same slug()
  // treatment. Interpolating it raw let a `created_at` of `../…` resolve the
  // join below outside outDir and write there.
  const name = `${slug(date, '0000-00-00')}-${slug(convId, `conv-${i + 1}`)}.md`;
  const messages = c.messages || [];
  // The date a turn header falls back to when its own message carries no usable
  // `ts`. `date` is third-party and only length-limited, so it is validated
  // rather than trusted: a `created_at` of "1\nowner: z" slices to ten
  // characters that include a newline, and interpolating that into a header
  // would break the turn it is supposed to anchor.
  const pageDate = HEADER_DATE.test(date) ? date : EPOCH_DATE;
  // ONE fallback for an absent title, shared by the frontmatter and the H1.
  // They used to disagree — "Untitled conversation" above, "Conversation" in
  // the body — which is two different names for the same missing thing, and
  // `parseMarkdown` prefers the body's H1 when frontmatter has no title.
  const title = c.title || 'Untitled conversation';
  // gbrain reads YAML frontmatter + markdown body; keep provenance in frontmatter.
  // Emit `type: conversation` so gbrain stores these as conversation pages rather
  // than defaulting to the generic `concept`. gbrain is open-typed — it takes an
  // explicit frontmatter `type` verbatim — and its conversation-aware features
  // (conversation-facts extraction, the conversation_format_coverage check,
  // chronicle eligibility) key off `type == 'conversation'`.
  const front = [
    '---',
    'type: conversation',
    // Every interpolated value below is quoted. An envelope is a third-party
    // file, so any string carrying a newline would otherwise close its scalar
    // and inject arbitrary frontmatter keys into the page gbrain ingests — or
    // duplicate an existing key, which makes the parse throw and silently
    // strips every provenance field from the page.
    `title: ${JSON.stringify(title)}`,
    // `date` is the first 10 chars of the envelope's `created_at`; 10 is plenty
    // to smuggle a newline plus a short key. Absent stays an unquoted YAML null.
    `date: ${date ? JSON.stringify(date) : 'null'}`,
    `source: ${JSON.stringify(env.meta?.source_provider || 'unknown')}`,
    // Omit the key entirely when the envelope carries no id, rather than
    // emitting the literal `undefined` or a synthesized `conv-N` — the positional
    // fallback names the file, but it is not a memvelope conversation id and
    // must not be recorded as one.
    // The id VERBATIM, not the trimmed form used for the filename. The spec has
    // converters copy ids exactly, and recording the trimmed one made two ids
    // differing only by surrounding whitespace indistinguishable on disk — so
    // the conflict check below read them as one conversation and let the second
    // import destroy the first.
    ...(hasId ? [`memvelope_conversation_id: ${JSON.stringify(c.id)}`] : []),
    'origin: memvelope/envelope-v0',
    // Per-message identity. It cannot ride in the turn header: the only header
    // shape gbrain's parser reads carries `YYYY-MM-DD HH:MM` and nothing else,
    // so a message id and a full RFC 3339 timestamp have to live here or be
    // thrown away. Order is the body's order, so `messages[i]` is the i-th turn.
    //
    // An array of maps, deliberately. Not a map keyed by id: order IS the
    // join — `messages[i]` is body turn i — and a mapping discards it. (The
    // duplicate-id argument belongs to CONVERSATION ids, which the spec says
    // consumers must tolerate; message ids are positional per spec and unique
    // within their conversation.) And not one packed string per message, which
    // asks a consumer to split on a space and breaks the moment an id has one.
    //
    // An explicit `[]` rather than an omitted key: omission is
    // indistinguishable from a page written before this format existed, and a
    // consumer reading identity back needs to tell those apart.
    ...(messages.length === 0
      ? ['messages: []']
      : [
          'messages:',
          ...messages.flatMap((m) => [`  - id: ${yamlJson(m.id)}`, `    ts: ${yamlJson(m.ts)}`]),
        ]),
    '---',
    '',
  ].join('\n');
  const body = messages
    .map((m) => {
      // The message's OWN date, not the conversation's: `imessage-slack` is an
      // inline-date pattern precisely so a conversation spanning midnight lands
      // its turns on the right days.
      const clock = headerClock(m.ts) || `${pageDate} 00:00`;
      return `**${m.role === 'user' ? 'Me' : 'Assistant'}** (${clock}):\n\n${m.text}`;
    })
    // No `---` rule between turns. A horizontal rule is a non-blank line that
    // matches no pattern, so the parser appends it to the preceding message:
    // every extracted message text ended `...\n---`. It also diluted the
    // match-density score the parser's acceptance floor is computed from.
    .join('\n\n');
  const rendered = {
    // The H1 is the ONLY place a third-party string reaches the body, and the
    // body is now parsed. A title carrying a newline used to look merely
    // untidy; since the turn headers became legible it manufactures a TURN, and
    // one that lands ahead of every real one — so `messages[0]` in frontmatter
    // names content the user never sent and every id after it is off by one.
    // The heading is flattened to a single line for that reason; the verbatim
    // title, newlines and all, is still recorded in the frontmatter above.
    content: front + `# ${title.replace(/\s*[\r\n]+\s*/g, ' ')}\n\n` + body + '\n',
    messageCount: messages.length,
    // The conversation's OWN id, verbatim, or null. Never the positional
    // fallback: that is a filename, not an identity, and treating it as one is
    // the whole bug. Verbatim rather than trimmed for the same reason — see the
    // frontmatter note above.
    conversationId: hasId ? c.id : null,
    // Carried only to break a filename collision. It is NOT written to the
    // page — no frontmatter key holds it, by design and separately tracked.
    updatedAt: c.updated_at,
  };
  const earlier = pages.get(name);
  if (earlier === undefined) {
    pages.set(name, rendered);
    continue;
  }
  // Never lose a page silently: two conversations mapping to the same filename
  // (an envelope carrying duplicate ids — which the spec permits, since merging
  // never deduplicates — or DISTINCT ids that slug alike, which the header
  // describes and which this warning's wording does not cover) means one of
  // them is discarded. Warn loudly rather than overwrite in silence, and report
  // the count of DISTINCT files written — not the number of write calls, which
  // is what hid the old title-collision bug.
  collisions += 1;
  const { keepLater, byUpdatedAt } = keepsLaterInArray(earlier.updatedAt, rendered.updatedAt);
  // Name the decision AND its inputs. "Overwriting the earlier page" was the
  // whole message before, and it would now be false half the time — the reader
  // has to be able to check which copy survived rather than assume the old
  // rule still applies.
  const verdict = byUpdatedAt
    ? `keeping the copy whose updated_at is later (${JSON.stringify(keepLater ? rendered.updatedAt : earlier.updatedAt)}) over ${JSON.stringify(keepLater ? earlier.updatedAt : rendered.updatedAt)}`
    : `updated_at cannot order these two copies (${JSON.stringify(earlier.updatedAt ?? null)} and ${JSON.stringify(rendered.updatedAt ?? null)}), so array order decides — overwriting the earlier page`;
  console.warn(`warning: filename collision on "${name}" — conversation id ${JSON.stringify(c.id)} is not unique; ${verdict}.`);
  if (keepLater) pages.set(name, rendered);
}

// ---------------------------------------------------------------------------
// Check 2 — target files that already exist and were not written by this run.
// `pages` is per-process and the default outDir is a fixed literal, so without
// this a second import into the same directory clobbered the first in silence.
// Only the exact target filenames are examined: unrelated markdown sitting in
// the output directory is none of this script's business.
// ---------------------------------------------------------------------------
const conflicts = [];
for (const [name, page] of pages) {
  const existing = readIfPresent(join(outDir, name));
  // Absent, or already exactly what we are about to write (a re-import of the
  // same envelope). Rewriting identical bytes changes nothing.
  if (existing === null || existing === page.content) continue;
  const identity = existingPageIdentity(existing);
  if (identity === null) {
    // Say what is true — the file was not recognized. Asserting that this
    // importer did not write it is a claim this code is in no position to make,
    // and it is wrong for any page of ours that has been edited since.
    conflicts.push(`  ${name} — already exists and could not be recognized as a page written by this importer.`);
  } else if (identity.id === null) {
    // Ours, but written from an id-less conversation, so its filename encodes
    // array position rather than identity. An update and a wholly different
    // conversation are indistinguishable here; guessing either way risks
    // destroying an import.
    conflicts.push(`  ${name} — written by this importer from a conversation with no id, so it cannot be matched to this envelope's conversation. Refusing to guess.`);
  } else if (identity.id !== page.conversationId) {
    // Distinct ids that slug to one filename (truncation at 60 chars, or
    // characters that slug away). Rare, but silently fatal if permitted.
    conflicts.push(`  ${name} — holds conversation ${JSON.stringify(identity.id)}, but this envelope maps ${JSON.stringify(page.conversationId)} to the same filename.`);
  }
  // Otherwise: same conversation id, different content — a refreshed export
  // updating its own page. That is exactly what re-importing is for.
}

if (conflicts.length) {
  console.error(`refusing to import: ${conflicts.length} target file(s) in ${outDir} would be overwritten with different content.`);
  for (const line of conflicts) console.error(line);
  console.error('Nothing was written. Import into a different output directory, or delete the listed file(s) if they are stale.');
  process.exit(EXIT_REFUSED);
}

// ---------------------------------------------------------------------------
// Write. Everything above has already passed, so this loop cannot refuse.
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
let messagesWritten = 0;
for (const [name, page] of pages) {
  writeFileSync(join(outDir, name), page.content);
  messagesWritten += page.messageCount;
}

console.log(`wrote ${pages.size} markdown page(s) (${messagesWritten} message(s)) to ${outDir} — point gbrain's sync at this directory.`);
if (collisions) {
  // "Overwritten" would now be false whenever the tiebreak kept the earlier
  // copy: that copy is never rewritten and the later one is never written at
  // all. "Discarded" is true in both directions, and the per-collision lines
  // above already say which copy went.
  console.warn(`warning: ${collisions} filename collision(s) — ${collisions} page(s) discarded. Deduplicate conversation ids in the envelope to avoid data loss.`);
}
if (messagesWritten !== actualMessages) {
  // The page count alone cannot show this: a discarded copy leaves the same one
  // file on disk, so only the message tally reveals the turns that went with it.
  //
  // "Discarded", not "overwritten", for the same reason as the summary line
  // above: since the tiebreak can keep the EARLIER copy, the losing copy is
  // sometimes never written at any point.
  //
  // Worded as a fact about the discarded copies, not as an announcement of
  // loss. Duplicate ids are conforming input — the spec has merging never
  // deduplicate — so converting an old export together with a newer one, which
  // is what the memvelope CLI tells users to do, lands here routinely with the
  // surviving page already holding every unique turn. An alarm that cries wolf
  // on the mainstream path teaches its reader to ignore the one that matters.
  console.warn(`warning: the discarded page(s) carried ${actualMessages - messagesWritten} message(s) that are not on disk (${actualMessages} read, ${messagesWritten} written). If they were earlier copies of the same conversation, the surviving page may already contain those turns; if not, this is real loss.`);
}
