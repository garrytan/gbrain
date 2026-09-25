# Regex Discipline Convention

When to reach for a regex/heuristic vs. when to let the model do the judgment.

The rule: the model doing knowledge work judges FIRST. A regex is earned ONLY
after you have seen enough real data (small sample first — see
`skills/conventions/test-before-bulk.md`) to confirm the signal is rote,
repetitive, and 100% deterministic. A regex is a compression of a pattern you
already verified by looking — never a substitute for looking. Premature regex
(writing a pattern off the bat, before reading the data, to do work that
requires judgment) is the anti-pattern.

## The One Question

Before writing ANY regex / keyword-score / pattern-filter, answer:

> **Is this signal 100% deterministic and rote — or does it require judgment?**

- **Deterministic & rote** → regex is the right tool. (ISO timestamp
  extraction, `\.mp3$` file filtering, splitting on a known delimiter,
  magic-byte detection, a URL shape, a YAML frontmatter fence, an ID format
  you have confirmed is consistent.)
- **Requires judgment** → the model does it. ("Is this clip a highlight," "is
  this message important," "does this paragraph contain the thesis," "is this
  person a real contact," "is this a good title," sentiment / theme /
  quality.) A regex here rewards surface features — keyword density, length,
  punctuation — and misses the actual thing.

If you can't answer the question, you have not seen enough data yet. Go look
first.

**A sharper restatement of the same test:** did a MACHINE emit this exact
string, or could a HUMAN phrase it a hundred ways? A machine-emitted string in
one shape (a calendar prefix, an exact domain, a bot template, a URL/token
shape) is a regex tell. A phrase a human writes — and especially one an
adversary could imitate — is judgment. The two phrasings agree: "100%
deterministic and rote" and "a machine emitted it in one shape" are the same
bar.

## The Earned-Regex Sequence

A regex is **earned**, not assumed:

1. **Do the work as the model on a small real sample.** This is the
   test-before-bulk discipline (`skills/conventions/test-before-bulk.md`).
   Read the actual data. Make the judgments yourself.
2. **Notice a tell that is genuinely mechanical** — a pattern that holds 100%
   across the sample, with no judgment in the loop, that you can state
   precisely. ("Every message from that system is `noreply@acme-example.com`."
   "Every transcript segment line starts with `**[mm:ss]**`.")
3. **THEN write the regex** to compress that confirmed-deterministic step — to
   save tokens on the rote part, NOT to make the judgment.
4. **Keep the judgment with the model.** The regex pre-filters or
   post-formats; the model still decides anything that isn't mechanical.

Skipping steps 1–2 and jumping to step 3 is premature regex. That's the bug.

## Division of Labor

| Layer | Tool | Why |
|-------|------|-----|
| Find/format the rote, deterministic part | regex | Cheap, exact, no judgment needed |
| Decide anything requiring taste/meaning/quality | model | Judgment doesn't compress to a pattern |
| Confirm a tell is *actually* rote before trusting regex | model + small-sample test | You must SEE the data first |

Regex is a scalpel for parsing, not a brain for judging. Use it to *carry out*
a decision the model already made, never to *make* the decision.

## Red Flags (you are about to write premature regex)

- You're writing a `score()` function with keyword lists and weights to rank
  *quality*.
- You haven't read a representative sample of the source data yet.
- The pattern is meant to *decide* something a smart human would call a
  judgment call.
- You're reaching for regex because it's faster than reading, not because the
  signal is rote.
- The thing you're matching has exceptions you're already hand-waving
  ("mostly it's…").
- **The thing you're matching is exactly what an adversary would imitate**
  (phishing keywords, spoofed brand names, urgency language). A regex on
  adversary-controlled phrasing is a hole, not a filter.
- You'd be embarrassed to defend the pattern against the 10 counterexamples
  you haven't looked for.

If any fire: stop, read a small sample, let the model judge, and only regex
the mechanical residue — if any.

## Green Lights (regex is the right call)

- Extracting a format you've confirmed is consistent (timestamps, file
  extensions, IDs, URLs).
- Splitting/tokenizing on a known, stable delimiter.
- Magic-byte / binary-shape detection.
- Post-formatting a value the model already chose (slugify a title, normalize
  whitespace).
- A pre-filter that narrows candidates for the model — explicitly NOT the
  final decision, and only after you've verified the filter doesn't drop real
  positives.

## Never Regex What an Attacker Can Imitate

When the input is adversary-influenced (inbound messages, webhook payloads,
anything a stranger can send), the bar is higher than "rote": the tell must be
something the adversary *cannot* forge cheaply. "Action required," "verify
your account," "sign this document" are precisely what a credential-harvesting
attacker writes on purpose — a keyword regex that acts on those words is a
regex the attacker can drive. "Is this a real request or a spoof" requires
checking sender-domain-vs-claimed-identity, thread state, and account context
— exactly the judgment the model does and a subject-line regex cannot. When
the thing you're matching is what an adversary would imitate, a regex isn't
just imprecise — it's a hole.

## Cautionary Tales

### 1. The audio-clip ranking pipeline (scoring as judgment)

A pipeline tried to pick highlight clips from long recordings with a regex
`score()` that counted topic-vocabulary keywords. Result: every clip scored
99–100 (useless for ranking), titles grabbed the first throwaway sentence,
themes were incoherent, and it missed nearly every genuine highlight. When a
model pass read the transcripts directly and judged, the scores spread 73–92
and the real highlights surfaced. "Is this a good clip" is judgment. It was
never a regex job. The regex's only legitimate use would have been finding
rough candidate *windows* for the model to consider — and even that wasn't
worth it; reading the transcript was faster and better.

### 2. The inbox classifier (classification as judgment) — the adversarial twist

An inbound-message pipeline ran deterministic regex rules FIRST and only let
the residue fall through to the model classifier. That ordering is correct
*only for machine-emitted tells*. The trap: keyword regexes crept in to make
**judgment** calls before the model ever looked — a school-mail filter
matching `parent|birthday|grade|library` (which match a huge slice of
non-school mail), a press-inquiry phrase soup (`can you talk|following
up.*story` — reporters phrase it a hundred ways, newsletters trip it
constantly), a newsletter heuristic keying on `team@`/`hello@` localparts
(real humans use those), and a financial-action subject regex (`action
required|sign.*document`) that matched exactly what phishing imitates. The
classifier prompt could be perfect and still be bypassed by a brittle pattern
upstream.

The earned tells in that same pipeline prove the rule by contrast: calendar
`Accepted:`/`Declined:` prefixes (the calendar system emits them verbatim),
exact machine senders (`noreply@acme-example.com`), a bot's fixed message
template, unsubscribe-URL/token shapes. Every one is a string a *machine*
emitted in *one* shape — not a phrase a human (or an attacker) could write a
hundred ways.

**The unifying test across both failures:** could a *human* phrase this a
hundred ways, and could an *adversary* imitate it? If yes → judgment, model.
Only a string a *machine* emitted in exactly one shape is a regex tell.

## Where This Bites in GBrain

The shipped surfaces this convention protects:

- **Enrichment** (`skills/enrich/SKILL.md`) — notability, compiled truth, and
  which facts matter are judgment calls. Don't keyword-score entity relevance.
- **Signal detection** (`skills/signal-detector/SKILL.md`) — "is this original
  thinking" is the audio-clip failure shape. Score signals with the model, not
  keyword lists.
- **Webhook transforms** (`skills/webhook-transforms/SKILL.md`) — inbound
  external events are adversary-influenced input. Classify with machine tells
  + model judgment; never with keyword regexes an outsider can imitate.

## Relationship to Other Conventions

- **Test before bulk** (`skills/conventions/test-before-bulk.md`) is the
  mechanism for "seeing enough data first." You cannot legitimately decide a
  signal is deterministic without it. The two are two halves of one rule:
  look before you compress, compress only the rote.
- **Cross-modal review** (`skills/cross-modal-review/SKILL.md`) catches
  premature regex after the fact: a heuristic-scored output shows no spread
  (everything maxed). If your scores don't spread, suspect a regex doing a
  judge's job.
