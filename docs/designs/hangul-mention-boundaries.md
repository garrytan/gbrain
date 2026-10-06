# Hangul mention boundaries

The mention linker (`src/core/by-mention.ts`) matches a Hangul entity name only
when the name starts a word, keeps its written spacing, and ends at a
non-Hangul character or at a suffix that attaches to names: an optional title
or honorific (씨, 님, 대표, 선배 ...) followed by up to two particles or copula
forms (은, 에게서, 이었다, 야 ...). The exact lists live in
`HANGUL_NAME_TITLES` and `HANGUL_NAME_PARTICLES`.

So 지원이 왔다, 지원씨는 and 지원 대표가 link to an entity named 지원, while
지원하는 방법, 지원금 and 지원군 do not. Han and Kana names keep
character-substring matching, because those scripts do not separate words with
spaces.

## Measurement

The end rule replaced an earlier design with no end boundary at all. That
design reasoned that Korean particles attach directly to names, so any trailing
Hangul had to be allowed. The measurement below shows that this admitted
mostly word-internal false positives.

**Corpus.** 10,621 Korean Wikipedia paragraphs (KorQuAD 1.0 train and dev
contexts, 5.5M characters) plus 50,000 short Korean movie reviews (NSMC test
split, 1.8M characters). The reviews contribute informal, often unspaced text.
The corpora are public and are not committed here.

**Gazetteer.** 30 linkable titles: 20 common Korean given names, 5 full names,
3 two-syllable titles that are also common words, and 2 made-up company names.
Matches came from the real matcher (`buildGazetteer` on PGLite plus
`findMentionedEntities`), scanned one sentence at a time so every occurrence
counts.

**Labels.** gpt-6.1-sol labeled every match in context, assuming an entity with
that exact name exists:

- NAME: the string is used as a name.
- WORD: an ordinary word with the same spelling that stands as its own word,
  such as 우리 "we" or 지원 "support".
- INTERNAL: the string is only part of a longer word, such as 우리나라 or 지원하는.

| Matches (occurrences) | NAME | WORD | INTERNAL |
|---|---:|---:|---:|
| No end boundary (previous) | 74 | 1,536 | 1,041 |
| Suffix end rule (current) | 65 | 1,460 | 11 |

Without an end boundary, 39% of all Hangul matches (1,041 of 2,651) were
word-internal. The end rule removes 99% of them (1,030) and keeps 65 of 74 real
name mentions. Among NAME plus INTERNAL matches, precision rises from 7% to 86%.

**What the rule loses.** 9 of the 74 names are lost. Six come from unspaced
informal reviews, where the name runs straight into the next word (미래랑세주랑...).
The others carry a suffix outside the lists, such as `때문에` or a name followed
directly by a verb.

**What the rule keeps.** The 11 remaining INTERNAL matches are mostly a
romanized prefix (e지원) and 우리 측.

**What the rule cannot fix.** Homonyms (WORD) were 58% of matches before and
95% after, since most of what remains is the everyday word. A title that is
also an everyday word links wherever that word appears with normal spacing.
This is a property of the gazetteer, not of the boundary rule; on this
general-purpose corpus real names are rare. `gbrain extract mentions --explain
<name>` shows how a name was matched, and `mentions.ignore` stops a name from
linking.

**Existing brains.** `MENTION_EXTRACTOR_VERSION` moved to 2, so the next
mention pass (`gbrain extract --stale`, or autopilot) rescans every page once
and drops plain mention links the old rule made. The resume checkpoint of
`gbrain extract links --by-mention` uses a matcher tag inside `hashGazetteer`
(`hangul-boundaries-v2`), so an interrupted run restarts instead of resuming
with old results.

## Changelog

- 2026-10-05: measured the no-end-boundary design on a Korean corpus and added
  the title/particle/copula end rule.
