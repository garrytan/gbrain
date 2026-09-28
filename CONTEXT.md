# GBrain — domain language

A shared vocabulary for working on GBrain. Terms are named as they appear in
the code. If a word is used differently from what is written here, the
disagreement is about this file, not about a code comment.

## Language

**Brain**:
One database with its own content and access policy.
_Avoid_: "database", "instance", "store" — they do not separate a Brain from its Engine.

**Source**:
A named set of pages inside one Brain. Slugs are unique per
`(source_id, slug)`, not on their own.
_Avoid_: "repository", "collection", "namespace".

**Engine**:
What a Brain runs on: `pglite` or `postgres`. A property of the connection,
not of the data.
_Avoid_: "backend", "driver".

**Slug**:
The stable identifier of a page inside a Source. Derived from a file name or
from an entity name.
_Avoid_: "path", "key", "page id".

**Slug grammar**:
The rule that turns free text into a Slug: which characters are kept, which
fold, which are dropped. Every grammar shares one letter fold
(`cjk.ts:foldSlugText`).

**Exact-slug step**:
The check that runs before any fuzzy match: a value that already looks like a
Slug is looked up exactly. Its shape test must accept everything the Slug
grammar produces. Otherwise a real page is skipped and fuzzy matching may pick
a sibling.
_Avoid_: "slug-shape check", "step 1" — both depend on which resolver you mean.

**Lexical arm**:
The search branch that matches words. Language-dependent: stemming and stop
words come from one configuration for the whole Brain.
_Avoid_: "full-text search", "FTS" — in conversation they drift away from "arm".

**Vector arm**:
The search branch that matches meaning through embeddings. Language-agnostic.

**Entity**:
A page representing a person or an organization, under `people/` or
`companies/`. Born from extraction out of text, not from syncing a file.

**Atom**:
One standalone idea extracted by the dream cycle from a transcript or a
prose page (a meeting, an article, a note).
_Avoid_: "fact", "note" — facts and notes are separate kinds of record.

**Concept label**:
A short topic name that the dream cycle assigns to an Atom. Atoms that share
a label are gathered into one Concept. Written in the Исходный язык, and never
the name of an Entity or a product: a technical topic gets a descriptive label
("очереди-сообщений") even when the text uses the English term ("queue").
_Avoid_: "tag" — tags are set by people and do not gather Atoms.

**Concept**:
A page that sums up every Atom sharing one Concept label. Its Slug and title
come from the label.

**Исходный язык**:
The language of the text the dream cycle writes a page from: a transcript,
or the Atoms and reflections being summed up. Decided by the language most of
that text is written in. The page's prose follows it; names, product names,
commands and technical terms stay exactly as the author wrote them.
_Avoid_: "source language" — **Source** already means a set of pages.

**Alias**:
An alternative spelling that leads to the same Entity. The layer where
different spellings of one name merge, without touching the Slug.
