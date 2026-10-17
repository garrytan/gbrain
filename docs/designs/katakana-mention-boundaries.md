# Short Katakana mention boundaries

The mention scanner checks two- and three-code-point names made entirely of
Katakana (including the long-vowel mark). This applies equally to titles and
aliases: changing a name's origin must not change its matching precision.

A candidate must occupy a contiguous span with the exact NFC spelling and
must not adjoin another Katakana character, a small Kana, a long-vowel mark
or a combining voicing mark. Thus `デン` is not a mention inside `インシデント`,
`デンタル` or `デンー`. Punctuation, the middle dot, Han, Latin and Hiragana
are boundaries: `「デン」`, `デン・カフェ`, `喫茶デン` and `デンに行った` retain
their matches. This is a script-span precision rule, not Japanese morphological
analysis; a short name inside a legitimate Katakana compound is also refused.
Use the compound's complete alias when it is a distinct intended name.

Longer and mixed-script names retain character-level matching. Han, Hiragana
and Hangul policy is unchanged. Compatibility normalization is not introduced:
halfwidth spellings do not become fullwidth aliases. Canonical decomposed
Katakana voicing marks are consumed with their base and normalized per token;
returned offsets still index the original UTF-16 body, including emoji.

Both maximal-munch selection and same-name sibling/source selection apply the
same boundary check. Ignored names, source isolation, self-links, code masking
and first-mention deduplication keep their existing semantics.

## Existing graphs

The explicit by-mention walk's resume fingerprint includes the matcher change,
so an explicitly requested walk does not resume under obsolete semantics.
`MENTION_EXTRACTOR_VERSION` is deliberately unchanged: installing this matcher
must not automatically schedule a whole-source repair of existing links.
New or edited origins use the corrected matcher through the normal pass.
Unchanged historical false positives remain until separately authorized
reconciliation. No production extraction or graph mutation is part of this fix.

The synthetic stored-edge regression exercises an edited origin and confirms
that its obsolete plain mention is removed while manual, Markdown and typed
NER edges survive. It does not claim there is an existing origin-page-scoped
operator repair command; any live historical cleanup needs a separate bounded
plan and authorization rather than a global rebuild or extractor-version bump.

Regression coverage: `test/by-mention-katakana-6843.test.ts` (pure matcher,
canonical normalization, real PGLite mention pass, explain and producer fences).
