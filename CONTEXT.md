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

**Lexical arm**:
The search branch that matches words. Language-dependent: stemming and stop
words come from one configuration for the whole Brain.
_Avoid_: "full-text search", "FTS" — in conversation they drift away from "arm".

**Vector arm**:
The search branch that matches meaning through embeddings. Language-agnostic.

**Entity**:
A page representing a person or an organization, under `people/` or
`companies/`. Born from extraction out of text, not from syncing a file.

**Alias**:
An alternative spelling that leads to the same Entity. The layer where
different spellings of one name merge, without touching the Slug.
