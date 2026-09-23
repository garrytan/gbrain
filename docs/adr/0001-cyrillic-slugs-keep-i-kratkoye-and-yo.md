---
status: accepted
---

# Cyrillic slugs keep `й` and `ё`

The shared slug grammar decomposed text to NFD and stripped every combining
mark to fold Latin accents (`é` → `e`). On Cyrillic the same rule cut the
breve off `й` and the diaeresis off `ё`, so "российской" became "россиискои".
We keep `й` and `ё` intact: in Cyrillic they are separate letters, not letters
with an accent. The carve-out is narrow — two marks on a Cyrillic base;
everything else, including the Cyrillic stress mark, folds like an ordinary
accent (exact wording under Consequences).

## Considered Options

A compromise: keep `й` but fold `ё` → `е`, because Russian writing uses `ё`
and `е` interchangeably and "Пётр"/"Петр" must be one person. Rejected: a rule
of "some letters are kept, others are not" does not follow from any property
of the character, has to be memorized, and still does not solve the whole
problem — it does not merge "Наталия"/"Наталья" either.

## Consequences

"Пётр" and "Петр" produce different slugs: the Slug reports what was written.
The Alias layer merges the pair. `normalizeAlias` treats `ё` as `е` and
drops a Cyrillic stress mark, and `enrichEntity` does two things without which
the fold would merge nothing: a new page claims its own name as an alias, and
before creating a page it asks the Alias layer first. So the second spelling appends to the existing Entity
instead of forking a twin. The split is deliberate: the Slug owns the identity
of the record, the Alias owns the identity of the Entity.

Both halves are bounded, because `page_aliases` is shared across the Brain:

* **Reads are narrowed to the Entity's namespace.** The index is type-blind:
  `projects/атлас.md` can claim the alias `Атлас` too. An Entity lives under
  `people/` or `companies/` only, so a hit outside its own prefix is ignored —
  otherwise a company mention would land in a project note, timeline entry and
  backlink included.
* **Writes happen only on the trusted path, and at promotion.** A quarantined
  stub (`trusted: false`) publishes no alias: exact lookup, hybrid search and
  `resolveEntityRef` all read the index, and an unreviewed extractor guess must
  not get a vote in resolution before review. `extraction_review promote`
  publishes it — into the frontmatter and into `page_aliases` — in the same
  transaction as the status flip, unioned with any aliases the owner added by
  hand. The stub has no file on disk, so no later sync would do it. Trusted
  extraction needs both a local caller and `--trusted-extraction`, so
  quarantine is the default path; without promotion publishing the alias, the
  main consequence of this ADR would never fire on a normal install.

A third cost has no gate yet. `page_aliases` is unique on
`(source_id, alias_norm, slug)`, so two pages may claim one name, and
`tryAliasExact` returns null when two live pages match. A trusted stub
`companies/атлас` claiming its name can therefore switch off the alias-exact
arm for an unrelated `projects/атлас` with the same alias, and
`resolveEntitySlug` falls through to fuzzy. `enrichEntity` itself is
unaffected: it falls back to `resolveSlugWithAlias(candidateSlug)` and finds
its own page. The right fix is alias priority (hand-written over automatic),
not dropping the self-claim; until then this is a known trade-off.

`normalizeAlias` is used beyond `page_aliases`: it is also the dedup key in
salience, volunteer context, exact lookup and hybrid search, so `ё`/`е` merge
there as well. For Russian that is the intended behavior — two spellings of
one name are one person everywhere.

`й` is NOT folded into `и`. Only `ё` and `е` are interchangeable in Russian
writing; folding `й` would merge different names.

The carve-out is exactly two marks, U+0306 and U+0308, and only when the
nearest non-mark character before them is Cyrillic — so a stress mark sitting
between the letter and its breve (`и` + U+0301 + U+0306) still yields `й`. The
Cyrillic acute (U+0301, the dictionary stress mark) folds like an ordinary
accent, so a stressed and a bare spelling stay one slug (and one alias key).
Ukrainian `ї` and Belarusian `ў` decompose through U+0308/U+0306 and survive too.

The rule protects a letter by the mark it gets under NFD, not by being a
letter. Macedonian `ѓ` (U+0453) and `ќ` (U+045C) decompose through U+0301 and
therefore fold to `г` and `к`. They are separate letters of the Macedonian
alphabet, so this is wrong for them; Macedonian is out of scope here. The fix
is to add U+0301 to the carve-out for those specific bases, not for all of
Cyrillic.

### Where the rule lives

`cjk.ts:SLUG_MARK_STRIP_RE`, applied through `cjk.ts:foldSlugText`, the one
letter fold shared by all four slug grammars: `sync.ts:slugifySegment`,
`enrichment-service.ts:slugifyEntity`, `entities/resolve.ts:slugify` and
`link-extraction.ts:normalizeBasename`. The last is the twin of the first
(#4985): if the two fold marks differently, a page's slug and its basename
index key diverge and every `[[wikilink]]` to a name with `й` or `ё` stops
resolving. Pinned by `test/cyrillic-slug-grammar.test.ts`.

`entities/resolve.ts:slugify` moved from `[^a-z0-9]` to the shared keep-set as
part of this. That affects every non-Latin script, not only Cyrillic: before,
any such name produced an empty resolve key and all of them collided on it.

### Upgrading an existing Brain

Alias rows re-key automatically: migration v164 (`page_aliases_cyrillic_fold`)
applies the same `ё` → `е` and stress-mark folds to stored `alias_norm` values,
so stored and queried keys agree without a manual `gbrain reindex --aliases`.

Page slugs do not re-key by migration. A file whose name contains `й` or `ё`
now slugs differently (`андреи` → `андрей`); the page re-keys on its next touch
or one `gbrain sync --full`, and the old-slug twin is not retired for you.
`gbrain orphans` lists the twin only if it has no links in either direction;
otherwise find it by its folded spelling (`й` → `и`, `ё` → `е`,
e.g. `gbrain get people/андреи`). Rename or delete it once.
