# Brain markdown format: contract for the Rust port

Source: gbrain at commit 8bbfd0b5e8 (VERSION 0.60.733.0). Paths are relative to
the gbrain repo root (gbrain (`github.com/garrytan/gbrain`)) unless absolute. Line numbers come
from the working tree on that commit.

Where this doc says "probe", the claim was checked by running the repo's own
modules under bun (local probe scripts, not committed, read-only; nothing in
the repo was modified). Everything else is from reading the code, marked
"read" where I read the function but did not run it.

## 0. Summary for the port

- The markdown file is the canonical copy of a page's content, tags, facts,
  takes, links and timeline. The database is a derived index that can be rebuilt
  from files, except for the DB-only categories listed in
  `docs/architecture/system-of-record.md` (per-page version history, receipts,
  withdrawals, belief ledger, credentials, job queues).
- A page file is: optional YAML frontmatter fence, then a body. The body is
  `compiled_truth`, then optionally a timeline section after a sentinel line.
  Structured rows live in markdown tables inside HTML-comment fences
  (`facts`, `takes`, `links`).
- Reading is lenient (quotes ambiguous scalars, recovers some broken blocks,
  synthesizes frontmatter for bare files at import). Writing is canonical
  (`js-yaml` dump, fixed key order, `<!-- timeline -->` sentinel).
- Byte-level parity matters in three places: the frontmatter YAML the writer
  emits, the slug grammar, and the content-hash input (JSON of an insertion-ordered
  object, SHA-256). Section 9 lists the concrete traps.

## 1. Brain repo directory layout

### 1.1 Roots, names, and what counts as a file

- A page for slug `S` in source `default` is `<root>/S.md`. A page in any other
  source is `<root>/.sources/<source_id>/S.md` (`src/core/markdown.ts:1389-1397`,
  `resolvePageFilePath`; write side `src/core/write-through.ts:418`).
- `<root>` is the source's `local_path` (`sources.local_path`), or
  `sync.repo_path` when the source has none (`src/core/write-through.ts:376-395`,
  `resolvePageWriteTarget`). A Git-root scope inside a monorepo is handled by
  `sourceGitScope` and `resolveRecordedSourceFilePath`
  (`src/core/markdown.ts:1444-1492`).
- Slug root modes `git-root` (slug carries the subdirectory prefix) and
  `source-root` (slug is relative to the source) are persisted per source
  (`src/core/write-through.ts:382-390`, comment; `markdown.ts:1399-1500`).
- Markdown extensions: `.md` and `.mdx` (`isMarkdownFilePath`,
  `src/core/sync.ts:289-291`).
- Code extensions admitted by the `code` and `auto` strategies:
  `CODE_EXTENSIONS` (`src/core/sync.ts:87-129`). It includes `.json`, `.yaml`,
  `.yml`, `.toml`, `.html`, `.css`, `.sql`, `.sh`, `.tf`, `.hcl` and about 35
  language extensions. Under `auto`, a top-level `.json` file is imported as a
  code page, not skipped.
- Image extensions: `png jpg jpeg gif webp heic heif avif`
  (`src/core/sync.ts:275-287`). Admitted only when
  `GBRAIN_EMBEDDING_MULTIMODAL === 'true'` (`src/core/sync.ts:294-296`).
- The sync strategy default inside `classifySync` is `markdown`
  (`src/core/sync.ts:657`). Sources can store their own `strategy`
  (`SYNC_STRATEGIES` at `src/core/sync.ts:50`: `markdown`, `code`, `auto`).

### 1.2 Top-level directories (convention, not enforced)

Nothing in the importer requires a particular top-level directory. The layout
below is the recommended schema, not a constraint:

- `docs/GBRAIN_RECOMMENDED_SCHEMA.md:115-161` shows `people/`, `companies/`,
  `deals/`, `meetings/`, `projects/`, `ideas/`, `concepts/`, `writing/`,
  `programs/`, `org/`, `civic/`, `media/`, `personal/`, `household/`,
  `hiring/`, `sources/`, `prompts/`, `inbox/`, `archive/`. Each directory has a
  `README.md` resolver, and the root has `RESOLVER.md`, `schema.md`, `index.md`,
  `log.md`. Those scaffolding names are skipped by sync (section 1.3).
- Type from path: `GBRAIN_BASE_PATH_PREFIXES` (`src/core/markdown.ts:1072-1095`,
  the hardcoded pre-v0.38 table). Matching is substring on `'/' + lowercased
  path` (`inferTypeWithPrefixes`, `markdown.ts:1214-1226`), so `people/` matches
  at any depth, and the first row in table order wins. Entries include
  `people/`, `person/` (person); `companies/`, `company/` (company); `deals/`
  (deal); `yc/`; `civic/`; `projects/` (project); `sources/`, `source/`;
  `media/`; `emails/`, `email/`; `slack/`; `cal/`, `calendar/`
  (calendar-event); `notes/`, `note/` (note); `meetings/`, `meeting/`
  (meeting); `life/events/` (event); `life/diary/` (diary); `wiki/analysis/`,
  `wiki/guides/`, `wiki/hardware/`, `wiki/architecture/`, `wiki/concepts/`,
  `writing/`. Anything else is `concept`.
- Pack-driven types: `src/core/schema-pack/base/gbrain-base-v2.yaml` (the
  fresh-install default, per `docs/architecture/type-taxonomy.md`). Its
  `page_types[].path_prefixes` are used when the caller passes `activePack` to
  `parseMarkdown` (`markdown.ts:459`, `inferTypeAndSubtypeFromPack` at
  `markdown.ts:1155-1212`). Examples: `person` = `people/`, `person/`
  (`gbrain-base-v2.yaml:66-70`); `extract_receipt` = `extracts/`
  (`:408-412`); `facts`, `question`, `code`, `stored-object` have no prefixes.
- Two type tables therefore coexist. Callers that do not pass `activePack`
  get the hardcoded table. Which production callers pass it is an open question
  (section 9).

### 1.3 Pruned and ignored paths

Evaluated per relative path, segment by segment, by `classifySync`
(`src/core/sync.ts:656-680`). The checks run in this order:

1. Strategy: is the extension admitted (1.1)?
2. Malformed name: `hasMalformedPathSegment` (`sync.ts:526-530`). Control
   characters (`\x00-\x1f`) anywhere reject. Square brackets reject only on
   `.md`/`.mdx` paths, so `app/[id]/page.tsx` still imports as code.
3. Pruned directory: `isPathPruned` (`sync.ts:466-472`):
   - any segment in `PRUNE_DIR_NAMES` (`sync.ts:366-388`): `node_modules`,
     `vendor`, `dist`, `build`, `venv`, `.raw`. `ops` was removed on purpose
     (`sync.ts:382-387`); do not re-add it.
   - any segment ending in `.raw`;
   - any dot-prefixed segment (`.git`, `.obsidian`, `.sources`, `.raw`, and so
     on). `includeHidden` globs can waive only the dot rule
     (`sync.ts:444-465`).
   - Note: `.sources/<id>/` is dot-pruned when the default source walks the repo
     root. A non-default source walks its own root, so its files are not
     affected.
4. Metafile: `isSyncMetafile` (`sync.ts:579-584`). `SYNC_SKIP_FILES` are
   `schema.md`, `index.md`, `log.md`, `README.md`, `RESOLVER.md`, skipped at
   any depth. `SYNC_ROOT_SKIP_FILES` are `AGENTS.md` and `CLAUDE.md`, skipped only
   at the root (`sync.ts:566-573`). A nested skip-named file becomes a page when
   `sync.metafile_pages` is `typed` (the default, `sync.ts:591-595`) and its
   frontmatter has a top-level non-null `type:` or `title:` with no conflicting
   `slug:` (`metafileIsPage`, `sync.ts:627-645`).
5. `--include` / `--exclude` globs (`sync.ts:676-677`).

The full-sync walker follows the same rules (`src/commands/import.ts:1294-1330`,
`isCollectibleForWalker`). The FS walker `walkBrainRepo` skips every dot entry
and `node_modules` and keeps `.md` only (`src/core/disk-walk.ts:38-60`).

### 1.4 `gbrain.yml`

- Location: the brain repo root. This repo's own example is
  `gbrain.yml (gbrain repo root)`.
- The reader is a hand-rolled parser, not a YAML library
  (`src/core/storage-config.ts:1-30` explains why gray-matter was dropped).
  It reads only a top-level `storage:` section with these list keys:
  - `db_tracked`: directories kept in git (human-curated).
  - `db_only`: directories kept in the database only; gbrain writes them to disk
    as a cache and gitignores them. `gbrain export --restore-only` repopulates
    them.
  - `keep_db` (optional): directories where drifted pages are reconciled to the
    database copy by the canonical owner host (`storage-config.ts:17-22`).
  - Deprecated aliases `git_tracked` (= `db_tracked`) and `supabase_only`
    (= `db_only`), accepted with a one-time warning (`storage-config.ts:31-35`).
- List forms: block lists, or one-line flow lists `[a/, 'b/']`. A flow list over
  several lines, a nested list, or an unquoted value containing a space is not
  parsed (`parseFlowList`, `storage-config.ts:70`; `docs/storage-tiering.md:38`).
- Directories end with `/`. Matching is by prefix with `matchesTierDir`
  (`storage-config.ts:332`). `db_only` lookups are case-insensitive
  (`storage-config.ts:479-499`, issue #3766).
- A directory in both tiers is an error (`StorageConfigError`, `docs/storage-tiering.md:39`).
- Derive-phase defaults are implicitly db-only, not written to `gbrain.yml`:
  `life/events/`, `atoms/`, `concepts/`, `extracts/`, `dream-cycle-summaries/`,
  `reports/drift-` (`storage-config.ts:469-484`).
- Effect of `db_only` on git: sync appends a managed block headed
  `# Auto-managed by gbrain (db_only directories)` to the root `.gitignore`
  (`src/commands/sync/gitignore.ts:178`). It is skipped when
  `GBRAIN_NO_GITIGNORE=1` (`gitignore.ts:64`) or when the repo is a submodule.

### 1.5 Sidecars, attachments, redirects

- `.raw/` sidecars. Three spellings exist in the code. All are dot or `.raw`
  paths, so sync never treats them as pages:
  - Export: `<dir>/.raw/<leaf>.json`, one JSON object keyed by raw source name,
    2-space indent plus a trailing newline (`src/core/export-stage.ts:67-87`,
    `src/commands/export.ts:161`).
  - `gbrain files upload --page`: `<pageDir>/.raw/<pageName>/<basename>`
    (`src/commands/files.ts:291-296`).
  - `docs/GBRAIN_RECOMMENDED_SCHEMA.md:441` and the comment at
    `src/core/sync.ts:410-411` use `<name>.raw/` or `.raw/` directories with
    per-source JSON. This is the documented convention; the code above is what
    actually writes.
- Binary attachments: stored under a `.raw/<page>/` sidecar in the repo, or in a
  storage backend (`src/core/storage/local.ts`, `s3.ts`, `supabase.ts`).
- Redirect pointers (`src/core/file-resolver.ts:1-40`). Resolution order is
  local file, then `.redirect.yaml`, then legacy `.redirect`, then a `.supabase`
  marker in a parent directory, then error.
  - `.redirect.yaml` (v0.9+): `target`, `bucket`, `storage_path`, `size`,
    `size_human`, `hash` (`sha256:...`), `mime`, `uploaded`, optional
    `source_url`, `type` (`file-resolver.ts:22-34`).
  - `.redirect` (legacy v0.8): `moved_to`, `bucket`, `path`, `moved_at`,
    `original_hash` (`file-resolver.ts:40-50`, parser at `:120-135`).
- Symlinks: `importFromFile` refuses a symlink (`src/core/import-file.ts:1048-1052`
  with `lstatSync`); images likewise (`:1885-1889`). A file that turns into a
  symlink is a `T` (typechange) in git, treated as modified; import then skips
  it, so old content stays indexed (`src/core/sync-delta.ts` header comment,
  `sync.ts:137-151`).

### 1.6 Per-directory and per-machine dotfiles (not brain content)

- `.gbrain-source`: one line, a source id, written in the current directory by
  `gbrain sources attach` (`src/commands/sources.ts:1161-1163`). Read by
  `src/core/source-resolver.ts:40`.
- `.gbrain-mount`: first line is a brain id. Walked up to 50 ancestors. Refused
  if it is a symlink, not owned by the user, or world-writable
  (`src/core/brain-resolver.ts:29-60`).
- Neither file is inside the brain repo's page namespace. Neither is synced.

## 2. Page file anatomy

### 2.1 Canonical write shape

`serializeMarkdown` (`src/core/markdown.ts:1018-1040`) writes:

```
---
type: <type>
title: <title>
<other frontmatter keys, insertion order>
tags:            <- only when tags is non-empty, always last
  - a
---

<compiled_truth>

<!-- timeline -->

<timeline>
```

Concretely: `yamlContent + '\n\n' + body + '\n'`. The body is
`compiled_truth`, then `\n\n<!-- timeline -->\n\n` plus the timeline if the
timeline is non-empty. If the timeline is empty but the compiled truth contains a
bare dated `## Timeline` section (section 2.5), it appends `\n\n<!-- timeline -->`
instead (`markdown.ts:1036-1037`, `needsEmptyTimelineSentinel` at `:1012`).

Probe (`serializeMarkdown({date:'2024-06-01'}, 'Body.', '- **2024-06-01** | x',
{type:'person', title:'T', tags:['a','b']})`) produced exactly:

```
---
type: person
title: T
date: '2024-06-01'
tags:
  - a
  - b
---

Body.

<!-- timeline -->

- **2024-06-01** | x
```

Notes for the port: the YAML comes from js-yaml `dump` (block style, two-space
sequence indent, quoting as in 2.3), and the closing fence is followed by one
blank line.

### 2.2 Read pipeline

`parseMarkdown` (`markdown.ts:319-332`) calls `parseMarkdownHead`
(`markdown.ts:355-446`), then `splitBody`, then `parsedMarkdownFields`
(`:449-488`). In order:

1. BOM stripped (`import-file.ts`, read via `readSourceFileSync(path, 'utf-8')`
   then `.replace(/^﻿/, '')`, line 1063). `splitFrontmatterBlock` keeps a
   BOM in the head (`markdown.ts:275-284`).
2. Lift: leading blank lines before the first fence are removed, but only when
   the first non-blank line is `---` (`stripLeadingBlanksBeforeFence`,
   `markdown.ts:260-267`; issue #4526).
3. Pre-quote pass, always run (`quoteAmbiguousFrontmatterScalars`,
   `markdown.ts:204-222`). For each top-level line matching
   `^([a-zA-Z_][a-zA-Z0-9_]*):[ \t]+(.+)$` (`markdown.ts:236`), when the value
   does not start with `'`, `"`, `[`, `{`, `|` or `>`, and contains `': '` or
   ends with `:`, the line is rewritten as `key: "value"`, with `\` and `"`
   escaped (`quoteAmbiguousFrontmatterLine`, `:233-248`). Issue #3708.
4. Strict parse: `matter(safeContent)` (`dataFrontmatter` from
   `src/core/data-frontmatter.ts`; `parseDataFrontmatter` at `:132-153`).
5. If the strict parse throws (and it is not a language-selector error), recovery
   runs (`recoverFrontmatter`, `src/core/frontmatter-recovery.ts:130`, `RECOVERY_VERSION = 1`
   at `:21`). It re-quotes only the suspect key line and its continuation lines.
   Recovered text is re-parsed (`markdown.ts:387-393`; issue #5988).
6. If still unparseable and validation is off, the frontmatter is `{}` and the
   whole file is body (`markdown.ts:443-445`). With `validate: true`, errors are
   collected instead (`collectValidationErrors`, `markdown.ts:619-795`).

### 2.3 YAML parsing rules

- Library: js-yaml 4.3.2 (`package.json:238`, `:278`; `node_modules/js-yaml`).
- Schema: `DEFAULT_SCHEMA.extend({ implicit: [calendarTimestamp] })`
  (`src/core/data-frontmatter.ts:30`). js-yaml's default schema is the core
  schema plus implicit `timestamp` and `merge` (`<<`), plus explicit tags
  `!!binary`, `!!omap`, `!!pairs`, `!!set` (verified in
  `node_modules/js-yaml/lib/schema/default.js`).
- Calendar check: `calendarTimestamp` (`data-frontmatter.ts:10-29`) rejects
  impossible calendar dates. Probe: `bad: 2024-02-30` stays the string
  `"2024-02-30"`, not March 1.
- Date values: a date-only scalar becomes a JS `Date` at UTC midnight. A
  datetime with an offset is converted to UTC. A naive datetime (no offset) is
  read as UTC but flagged with the `NAIVE_DATETIME` marker
  (`data-frontmatter.ts:19-25`) so `brain.timezone` can use the wall clock.
  Probe: `stamp: 2024-06-01T09:30:00` gave `2024-06-01T09:30:00.000Z`;
  `from: 2024-06-01 10:00:00 +02:00` gave `2024-06-01T08:00:00.000Z`.
- Aliases: at most 16 `*alias` tokens outside quoted strings
  (`MAX_FRONTMATTER_YAML_ALIASES`, `markdown.ts:804-812`). After loading, the
  expanded size must stay within text length plus 65,536
  (`MAX_YAML_ALIAS_EXPANSION`, `data-frontmatter.ts:40-79`). Past that,
  `YamlAliasBoundError`, reported as the intended refusal `yaml_alias_limit`.
- Duplicate mapping keys are an error. Probe: `a: 1` then `a: 2` gave
  `Malformed YAML frontmatter at line 3`. The error reports only the line, never
  the document text (`data-frontmatter.ts:138-144`).
- Scalars (probe): `1.0` loads as the number `1`; `1e3` as `1000`; `0x1F` as
  `31`; `0o17` as `15`; `.inf` as `Infinity`; `~` as `null`; `on` stays the
  string `"on"` (YAML 1.2 core booleans only).
- Anchors and aliases: loaded values are shared JS references. Probe:
  `x: &a [1,2]` / `y: *a` loads as two equal arrays. Dumping a value that is
  shared twice writes an anchor: `x: &ref_0` / `y: *ref_0` (probe).
- Language selector: the opening fence may be `---`, `---yaml`, `---yml`, or
  `---json`. Any other selector throws `FrontmatterLanguageError`
  (`data-frontmatter.ts:89-116`). `---json` makes the block JSON
  (`:138`).
- The frontmatter root must be a mapping. Anything else, including a sequence,
  throws `Frontmatter must be a YAML or JSON object` (`data-frontmatter.ts:145-147`).
- An empty block parses to `{}` (`data-frontmatter.ts:138`).
- Closing fence: `scanDataFrontmatter` requires a line that is exactly `---`
  with optional trailing spaces or tabs (`data-frontmatter.ts:118`). The
  validator matches a trimmed `---` line (`validatorFrontmatterFence`,
  `markdown.ts:603-611`). This differs for indented `  ---` (see section 9).
- Writer: `dumpFrontmatterYaml` (`data-frontmatter.ts:160-167`) calls js-yaml
  `dump` with default options (line width 80, insertion order, no sorting). It
  throws on `undefined` values, so the writer must omit the key instead.
  Probe results:
  - Strings that would re-parse as another type are quoted:
    `date: '2024-06-01'`, `'n': '007'`, `'yes': 'yes'`, `colon: 'a: b'`,
    `hash: '# x'`, `empty: ''`.
  - A long string with spaces folds into a `>-` block scalar wrapped at 80
    columns (probe with 150 characters).
  - Object key order is insertion order.

### 2.4 Frontmatter keys: type, reader, and status

No frontmatter key is required in a file. Defaults come from the parser and the
importer. "Lifted" means the key goes to a page column and is removed from the
stored frontmatter.

| Key | Type on disk | Read by / rule | Notes |
|---|---|---|---|
| `type` | string | `parsedMarkdownFields` (`markdown.ts:458-460`): explicit `type:` beats the pack, which beats the path table, which beats `concept`. Lifted. | Non-string values are flagged `NON_STRING_FIELD`. `typeExplicit` is kept for round-trip (`:477`). |
| `title` | string | Title precedence (`markdown.ts:470`): frontmatter `title:` > first H1 outside code (`inferTitleFromBody`, `:1237-1249`) > embedded-fence `title:` (`:295-303`) > filename humanized (`inferTitle`, `:1260-1267`) > `Untitled`. Lifted. | Non-strings coerced via `coerceFrontmatterString` (`:117-121`). A `Date` coerces to `YYYY-MM-DD` here, but to a full ISO string in the hash (see 9). |
| `tags` | array of scalars, or comma string | `extractTags` (`markdown.ts:1274-1281`). Lifted. `tags` is the only key that changes the body hash path specially (section 5.5). | Each tag is capped at 2688 UTF-8 bytes (`src/core/tag-limit.ts:11`; hold `tag_too_long`). |
| `slug` | string | Import: must match the path-derived slug, or be a normalization-equivalent spelling (`src/core/import-file.ts:1140-1175`, #3772). Used as the slug only when the path slugifies to empty (emoji-only names). Lifted. | Export stamps `slug:` when the slug cannot be derived from the path (`slugStampedFrontmatter`, `markdown.ts:1368-1373`). A conflicting slug is the hold `frontmatter_slug_conflict`. |
| `aliases` | string, or list; a comma string splits | `normalizeAliasList` (`src/core/search/alias-normalize.ts:41-55`), written to the page-alias table (`import-file.ts:231`). Kept in frontmatter. | Read by identity and link SQL (`src/core/link-extraction.ts:1839-1840`, `src/core/link-reconciliation.ts:25`, `src/core/engine-sql/exact-identity.ts:94`) and `import-file.ts:385`. Probe: the company fixture gives `["vector","vector-capital"]`. |
| `date` | date, datetime or string | Effective date precedence (`src/core/effective-date.ts:1-16`): `event_date`, then `date`, then `published`, then a leading filename date, then `created`, `created_at`, `date_created`, then `created_at` (row), then `updated_at`. For `daily/` and `meetings/` slugs the filename date moves to first. | Stored as an ISO string (see 9). |
| `event_date` | date | Top of the effective-date chain (`effective-date.ts`). | Meeting and event pages. |
| `published` | date | Effective-date chain, after `date`. | Writing pages. |
| `visibility` | string | Page privacy reads only the stored key `visibility` whose value is exactly lowercase `private` (`src/core/persistence/visibility-request.ts`, `keptPrivate`). A spelling like `Private` or a list is held `visibility_noncanonical` on sync and import (`:73-77`; `import-file.ts:351`). | PROTECTED key. |
| `readable_by` | list of identities | Guest pages: `GUEST_FRONTMATTER_KEYS` and the `readable_by` rule (`src/core/guests/admission.ts:28`, `:179`). | PROTECTED key. |
| `trust_tier` | string | Marker stamped by below-owner writes. Excluded from the content hash (`src/core/utils.ts:94-96`). | PROTECTED key. |
| `id` | string | Identity key for identity dedup and rename identity (`src/core/sync-rename-identity.ts:1-30`). | IDENTITY key; a duplicate is never resolved. |
| `source_id`, `source_slug`, `source_path` | string | Provenance and identity. `source_id` is an IDENTITY key. | Observed in 2-3 readers each. |
| `subtype` | string | Set by pack subtype rules (`resolveParsedSubtype`, `markdown.ts:490-503`). Stored. | |
| `legacy_type` | string | Original type kept when a page is retyped to `note` (`docs/architecture/type-taxonomy.md`). | Observed in 12 readers. |
| `dream_generated`, `dream_cycle_date`, `dream_created_cycle_date` | bool, date | Dream-cycle provenance (observed in 9 and 4 readers). | Semantics not documented here. |
| `captured_at`, `ingested_at` | timestamp | Per-call stamps. Excluded from the content hash (`src/core/utils.ts:80-96`). | |
| `quarantine`, `content_flag`, `embed_skip`, `atoms_scan_hash`, `quarantine_override` | mixed | Gate-owned. Stripped on non-owner imports (`src/core/import-screen.ts:299`, `GATE_OWNED_FRONTMATTER_KEYS`). Excluded from the hash. | `atoms_scan_hash` is the extract-atoms completion marker. |
| `pinned_question` | string | Question-page marker (`src/core/questions/pages.ts`). PROTECTED. | |
| `synthesized_by`, `derived_from`, `concepts`, `captured_via`, `event`, `access`, `confidentiality` | mixed | PROTECTED keys (`src/core/frontmatter-recovery.ts:28`). Never rewritten or guessed by recovery. | |
| `company`, `companies`, `founded`, `key_people`, `partner`, `investors`, `lead`, `attendees`, `sources`, `source`, `related`, `see_also` | string or list | Link fields, mapped to typed links (`FRONTMATTER_LINK_MAP`, `src/core/link-extraction.ts:1645-1670`). Values may be wrapped in `[[...]]` (`unwrapWikilink`, `:1983`). | Section 4. |
| `supersedes`, `status`, `retired_by`, `promoted_from`, `guest_group`, `guest_sender`, `saved_at` | mixed | Observed in readers (`import-file.ts:28` for guest keys). | Semantics not covered here. |
| `raw_transcript`, `transcript_import`, `transcript_archive` | mixed | Transcript import provenance. | Not covered here. |

Synthesized frontmatter at import (not in the file): when a file has no leading
`---`, `importFromFile` runs `applyInference` in memory (`import-file.ts:1110-1113`;
disabled only when `inferFrontmatter: false`, which the streamed and managed
paths pass). `inferFrontmatter` (`src/core/frontmatter-inference.ts:276-416`)
emits `title`, `type`, `date` (quoted), `source`, and `tags` as
`tags: ['a', 'b']`. The default type for an unmatched path is `note`
(`frontmatter-inference.ts:296-298`), which is not the parser's `concept`. The
file on disk is not changed unless `gbrain frontmatter generate --fix` is run.

Frontmatter-key classes, in code:

- PROTECTED (never recovered, folded, guessed):
  `visibility`, `derived_from`, `source_slug`, `synthesized_by`, `concepts`,
  `captured_via`, `event`, `pinned_question`, `access`, `confidentiality`,
  `readable_by`, `trust_tier` (`src/core/frontmatter-recovery.ts:28`).
- IDENTITY (a duplicate is never resolved): `slug`, `type`, `id`, `source_id`
  (`frontmatter-recovery.ts:30`).
- Gate-owned (see table).
- Hash-ephemeral (see 5.5).

### 2.5 Compiled truth versus timeline: exact split rule

`splitBody` (`src/core/markdown.ts:869-891`) runs on the body after the closing
fence. `parseMarkdown` trims both halves (`markdown.ts:328-329`).

Step 1, sentinel scan (`findTimelineSplitIndex`, `markdown.ts:900-906`). Lines
inside fenced code are skipped (`findLineOutsideFencedCode`, `fence-scan.ts`).
The first line that is one of these is the split, and the split line is dropped:

- Marker, always accepted at any position (`markdown.ts:938-942`):
  - `<!-- timeline -->` or `<!--timeline-->`, after trimming the line.
  - `--- timeline ---` (case-insensitive), or `---` whitespace `timeline`
    whitespace `---`.
- Dash `---`, accepted only when (a) there is non-blank content above it
  (`i > firstContentLineIndex`, `markdown.ts:926`) and (b) the next non-blank
  line is `## Timeline` or `## History`, case-insensitive, with optional
  trailing whitespace (`isTimelineHeadingAfterDash`, `:944-946`).
- A plain `---` followed by anything else is a horizontal rule, not a split.
  The source comment at `markdown.ts:866-867` says treating it as a split once
  truncated 83% of a wiki corpus.

Step 2, bare-section fallback (`findBareTimelineSection`, `markdown.ts:966-995`).
Used only when step 1 found nothing. The first `## Timeline` or `## History` line
(`/^##\s+(timeline|history)\b/i`, `:997-999`) qualifies only if all of these hold:

- it is not inside a code fence and not the first content line;
- every following line up to the next `## ` heading is blank, a dated bullet
  (`/^\s*[-*+]\s+\**\d{4}\b/`, `DATED_BULLET_RE`, `:950`), or an indented
  continuation (`/^\s{2,}\S/`) after at least one dated bullet;
- there is at least one dated bullet.

Then that section (heading included, next `## ` excluded) moves to the timeline,
and the rest of the body stays in compiled truth (`markdown.ts:879-888`). Any
other line in that section disqualifies this heading. The scan then tries the
next `## Timeline`.

Step 3: no split. Everything is compiled truth and the timeline is empty.

Serialization inverts this: `compiled_truth + "\n\n<!-- timeline -->\n\n" + timeline`
(section 2.1), so the canonical split is always the marker.

Timeline entries (what the DB extracts from the timeline text):
`parseTimelineEntries` (`src/core/link-extraction.ts:2217`) reads
`### YYYY-MM-DD — Title` headings (`TIMELINE_HEADING_RE`, `:2206`) and
`- **YYYY-MM-DD** | Source — Summary` bullets (also `--`/`-` separators; a Chinese
date form `- 2020年1月2日 | ...` at `timeline-citations.ts`). The `Source — Summary`
split applies to pipe-separated bullets only (`:2180-2190`, `findTimelineSourceDelimiter`).
A date must be a real calendar date. A materialized row carries the
`<!-- gbrain:materialized v1 <hash> -->` provenance line above it (section 2.6).

### 2.6 Fences and section markers (exact syntax)

Fences are HTML comments whose text is exactly the marker. Their inner text is
a markdown table. Fences are recognized only outside code (`locateOutsideCode`,
`src/core/fence-scan.ts`). Each body and each timeline section may hold at most
one fence of each kind (`docs/guides/fence-format.md`, Markers).

The complete reference is `docs/guides/fence-format.md` (generated from the
parser constants; drift is tested by `test/fence-format-reference.test.ts`). The
essentials follow.

**Facts fence** (`src/core/facts-fence.ts:86-87`):

```
## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Charlie Example's base salary is $210,000 | fact | 1.0 | private | medium | 2026-09-01 |  | daily/2026-09-15 |  |
| 2 | ~~Old claim~~ | fact | 1.0 | private | medium | 2025-06-01 | 2026-01-15 | companies/acme-example | superseded by #3 |
<!--- gbrain:facts:end -->
```

- The markers have THREE dashes after `<!`: `<!--- gbrain:facts:begin -->`.
  This is easy to get wrong in the port: the takes, links and facts constants all
  use the three-dash form (`takes-fence.ts:124-125`, `links-fence.ts:26-27`).
- Column set (`FACTS_FENCE_COLUMNS`, `facts-fence.ts:204-207`): `#`, `claim`,
  `kind`, `confidence`, `visibility`, `notability`, `valid_from`, `valid_until`,
  `source`, `context`, then the optional typed-claim columns `claim_metric`,
  `claim_value`, `claim_unit`, `claim_period`, then `attributed_to`. Columns
  may be read by header name in any order. Optional columns are listed in
  `FACTS_OPTIONAL_COLUMNS` (`:212`).
- Layouts written: narrow (10 cells), wide (14, adds typed-claim columns),
  attributed (15, adds `attributed_to`). A shortest row may drop trailing
  optional cells (`docs/guides/fence-format.md`, facts layouts).
- Vocabularies (`docs/guides/fence-format.md`, facts columns table): `kind` in
  `event, preference, commitment, belief, fact, idea`; `visibility` in
  `private, world` (default `private`); `notability` in `high, medium, low`
  (default `medium`); `confidence` a number 0 to 1 (default `1.0`); `attributed_to`
  in `user, assistant, other`.
- Strikethrough `~~claim~~` marks an inactive row (`stripStrikethrough`,
  `src/core/fence-shared.ts`). `context` holds `superseded by #N` or
  `forgotten: ...` on a struck row.
- The held-page holder `memory/unattributed` (`UNATTRIBUTED_MEMORY_SLUG`,
  `facts-fence.ts:58`) adds an `entity` column (16 cells).
- Placement: the first facts fence must be in compiled truth, above the timeline
  sentinel (`replaceOrInsertFactsFence`, `facts-fence.ts:908`, #4756). A fence
  below the sentinel is edited there only when the body has none
  (`factsFenceSection`, `:889-896`, #6686).

**Takes fence** (`src/core/takes-fence.ts:124-125`, example in
`test/fixtures/skill-evals/company-brainify/shared-now/people/charlie-example.md`):

```
## Takes

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | The user believes charlie-example is underperforming on on-call | take | brain | 0.7 | 2026-09 | meetings/2026-09-12-staff-sync |
| 2 | Payments v2 settlement ships in Q4 | bet | people/charlie-example | 0.6 | 2026-09 | projects/payments-v2 |
<!--- gbrain:takes:end -->
```

- Narrow layout, 7 cells: `# claim kind who weight since source`. Wide layout,
  13 cells, adds `resolved quality evidence value unit by`. Those six are read by
  header name (`docs/guides/fence-format.md`, takes columns).
- `kind` (`TAKE_KIND_VALUES`, `takes-fence.ts:170`): `fact`, `take`, `bet`, `hunch`.
  `who` (holder): `world`, `brain`, `people/<slug>`, `companies/<slug>`, or a
  bare lowercase slug (legacy, accepted). Grammar: `HOLDER_REGEX`
  (`takes-fence.ts:153-160`), built on the slug segment pattern.
- `weight`: 0 to 1, stored on a 0.05 grid. There is no default.
- `since`: `YYYY-MM` or `YYYY-MM-DD`, or a range `start → end`
  (`takes-fence.ts` header comment, lines 1-30).
- Append-only: rows are never renumbered; `superseded by #N` strikes a row.

**Links fence** (`src/core/links-fence.ts:26-27`, header at `:1-20`):

```
## Links

<!--- gbrain:links:begin -->
| to | type | source | valid_from | valid_until | context |
|---|---|---|---|---|---|
| companies/acme-example | works_at | manual | 2025-03-01 |  | met at a conference |
<!--- gbrain:links:end -->
```

- Columns: `to`, `type`, `source`, `valid_from`, `valid_until`, `context`
  (`links-fence.ts:40`). The header must contain `to` and only these names.
- `source` defaults to `manual` (`links-fence.ts:128`). Its shape must match
  `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (`LINK_SOURCE_RE`, `:41`).
- `MANAGED_LINK_SOURCES` (`links-fence.ts:36`): `markdown`, `frontmatter`,
  `mentions`, `wikilink-resolved`, `mcp-remote-mention`. A fence row cannot carry
  these; they are reconciled by the importer.
- Rendering sorts rows by `(to, type, source)` (`compareRows`, `:147`), so a
  clean fence round-trips byte-stable.
- Projection: rows become `links` with `link_source` = the row's source and
  `origin_field = links_fence` (`links-fence.ts:29`, `links-fence-projection.ts`).

**Timeline sentinel** `<!-- timeline -->` (section 2.5). It is a section
marker, not a fence.

**Materialized timeline row** (`src/core/timeline-marker.ts:1-13`):

```
<!-- gbrain:materialized v1 3f9a0c1d2e4b -->
- **2026-07-01** | legacy — Kickoff held before write-through
```

The 12-hex value is `sha256` of the normalized `[date, source, summary]` tuple,
truncated to 12 hex (`timeline-marker.ts:25-32`). It is provenance only: timeline
extractors skip it, and remote bodies and chunk text drop it
(`timeline-marker.ts:57-58`, `markdown-chunks.ts:23`). A marker whose hash no
longer matches the bullet below it marks nothing.

**Other `<!-- gbrain:... -->` markers.** These also appear in code:
`gbrain:pinned-question v1` (`src/core/questions/pages.ts:23`);
`gbrain:brain-first:begin/end` (`BRAIN_FIRST_BEGIN`/`END`); and
`gbrain:skills`, `gbrain:skillpack`, `gbrain:writeback-contract`,
`gbrain:ambient-writeback`, `gbrain:skill-pins` blocks, which the skill
installers write into agent instruction files. The installers are outside this
doc's scope.

**Cell encoding** (`src/core/fence-shared.ts`):

- A row starts and ends with `|`. A literal `|` in a cell is `\|`
  (`parseRowCells`, `:35-55`).
- A newline in a cell is `<br>` (`escapeFenceCell`, `:140`). Reading decodes
  `<br>`, `<br/>`, `<br />` case-insensitively to `\n` (`decodeFenceCell`,
  `:64-70`).
- A fence-marker string inside a cell is escaped so it never becomes a live
  marker: `gbrain:facts:begin` becomes `gbrain&#58;facts:begin`, and each
  additional encoding level adds `amp;` (`encodeFenceMarkers`, `src/core/fence-shared.ts:91`).
  Decoding removes exactly one level, so the codec is injective (#5395).
- A separator row is every cell matching `^[-:\s]+$` (`isSeparatorRow`).

## 3. Slugs

### 3.1 Path to slug (write-side and read-side)

`slugifyPath` (`src/core/sync.ts:775-780`), in order:

1. Remove one trailing `.md` or `.mdx`, case-insensitive (`/\.mdx?$/i`). So
   `people/x.MD` gives `people/x`.
2. Replace `\` with `/`.
3. Remove one leading `./` or `/`.
4. Split on `/`, apply `slugifySegment` to each segment, drop empty segments, and
   join with `/`.

`slugifySegment` (`src/core/sync.ts:730-750`), in order:

1. `NFD`.
2. Remove U+0300-U+036F (combining accents).
3. Remove Hebrew niqqud and cantillation, U+0591-U+05C7 (#3700).
4. `NFC`, which recomposes Hangul Jamo (v0.32.7) and makes NFD (macOS) and NFC
   (Linux) spellings of one name equal (#3417).
5. Remove emoji variation selectors, U+FE00-U+FE0F and U+E0100-U+E01EF
   (`SLUG_VARIATION_SELECTORS_RE`, `src/core/cjk.ts:52`).
6. `toLowerCase()`.
7. Remove every character outside `[\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}.\s_-]`
   (`SLUGIFY_KEEP_RE`, `sync.ts:728`, flag `gu`). Letters of any script survive,
   including CJK (category Lo). Emoji (category So) are removed, and so are
   brackets, quotes, `:`, `?`, and so on.
8. Replace each run of whitespace with `-`.
9. Collapse hyphen runs and strip leading and trailing hyphens
   (`foldSegmentHyphens`, `sync.ts:753-755`).

Probe results (`probe script probe5.ts`):

| Path | Slug |
|---|---|
| `Apple Notes/2017-05-03 ohmygreen.md` | `apple-notes/2017-05-03-ohmygreen` |
| `notes/v1.0.0.md` | `notes/v1.0.0` (dots kept) |
| `people/Jason "Jay" Strand.md` | `people/jason-jay-strand` |
| `🗂️ entities/x.md` | `entities/x` (emoji segment removed) |
| `会议/周报.md` | `会议/周报` (CJK kept) |
| `אבג/שָׁלוֹם.md` | `אבג/שלום` (niqqud stripped) |
| `Đức Nguyễn.md` | `đuc-nguyen` (stroke letter kept; see 3.3) |
| `people/_index.md` | `people/_index` (leading underscore kept) |
| `a  b/--c--.md` | `a-b/c` |
| `Café/naïve résumé.md` | `cafe/naive-resume` |
| `people/x.mdx` | `people/x` |
| `./people/x.md` | `people/x` |
| `stream/ünï.md` | `stream/uni` |

Code and image paths:

- `slugifyCodePath` (`sync.ts:786-794`): backslashes to `/`, strip a leading
  `./`, then in each segment replace `.` with `-` and apply `slugifySegment`,
  and join all segments with `-`. So `src/core/chunkers/code.ts` gives
  `src-core-chunkers-code-ts` (probe). The whole code path is one slug segment.
- `resolveSlugForPath` (`sync.ts:828-832`): an image keeps its path (lowercased,
  with `repoPrefix` prepended if given): `media/X/Pic.PNG` gives `media/x/pic.png`
  (probe). A code path uses `slugifyCodePath`; anything else uses `slugifyPath`.
  Each result is then lowercased.
- `pathToSlug(filePath, repoPrefix, {pageKind})` (`sync.ts:799-808`) prepends
  `repoPrefix/` and lowercases.

Emoji and non-slugifiable names: when `slugifyPath(relativePath)` is empty, the
importer uses the frontmatter `slug:` instead
(`src/core/import-file.ts:1140-1160`, the `expectedSlug === ''` branch). With no
frontmatter slug either, the file is skipped with "produces no usable slug".

Identifiers that look like paths but are not: `hyphenFoldedSlug` (`sync.ts:762`)
detects a slug with hyphen runs, which put_page and capture refuse (#7305).

### 3.2 Validation grammars (three different ones)

1. `validateSlug` (`src/core/utils.ts:39-56`): storage-level guard. Rejects an
   empty slug, a leading `/`, a `..` segment, control and C1 characters, bidi
   overrides (U+202A-U+202E, U+2066-U+2069), a backslash, and
   `%2e`, `%2f` or `%5c` (case-insensitive). It returns the slug lowercased.
   Probe: `people/Alice` returns `people/alice`; `x/..` throws.
2. `validatePageSlug` (`src/core/ops/context.ts:198-212`): the operation boundary
   (put_page and similar). Non-empty, at most 255 characters, and must match
   `OP_PAGE_SLUG_RE` (`src/core/page-slug-grammar.ts:23-25`):
   `^PART(:PART)*(\/PART(:PART)*)*$` with flags `iu`, where
   `PART = [\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}_][\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}._\-]*`.
   So a part starts with a letter, digit, combining mark or `_`, and continues
   with those plus `.`, `_`, `-`. A `:` separates parts inside a segment.
   A dot cannot lead a part, so `..` is impossible.
   Probe: `people/alice-example`, `a:b/c`, `_x/y`, `a/b.c`, `a..b` pass;
   `people/jane doe`, `people/Alice`, `..x`, `x/..` fail. Uppercase is refused
   here even though the flag is `i`, because `\p{Lu}` is not in the class.
3. Sync admission (`hasMalformedPathSegment`, `sync.ts:526-530`), applied to the
   path, not the slug. It is described in 1.3.

A comment at `page-slug-grammar.ts:6-22` explains why `.` and `_` are allowed
at the operation boundary: sync can produce slugs like `notes/v1.0.0` and
`people/my_file_name`, and the boundary must accept every slug sync can produce.

Legacy rows: `isLegacyStoredPageSlug` (`src/core/ops/context.ts:219-226`, #6212)
admits a stored slug that today's grammar refuses (for example `people/jane doe`),
but only to delete or restore that exact row, and only when it still passes
`validateSlug`.

### 3.3 Unicode and case: where the two grammars disagree

- `slugifySegment` folds accents and niqqud but not stroke letters (`đ`, `ø`, `ł`,
  `ß`): Unicode gives them no decomposition. `normalizeBasename`
  (`src/core/link-extraction.ts:1717-1733`) also runs `foldNonDecomposingLatin`
  (#4855, `src/core/latin-fold.ts`). So `Đức` is the page slug `đuc`, but the
  basename key for a `[[Đức]]` link is `duc` (probe). Both must be ported, and
  they are deliberately different.
- `normalizeBasename` strips variation selectors with the same regex as
  `slugifySegment` (`SLUG_VARIATION_SELECTORS_RE`, #4985).
- Both use `\p{...}` classes, so they need the `u` flag. Without it the class
  silently means the literal characters `p`, `L`, `l`, `{`, `}` (comment at
  `src/core/cjk.ts:30-42`).
- Case: slugs are lowercase canonical. `toLowerCase()` is the full Unicode
  mapping in JS, and Rust `str::to_lowercase` is also full, but the Unicode
  version of the `\p{}` tables may differ (section 9).

### 3.4 Source-scoped slugs

- The identity of a page is `(source_id, slug)` (for example
  `WHERE source_id = $1 AND slug = $2`, `src/core/write-through.ts:385`).
  Two sources may both have `people/alice`.
- The default source is `default`. Its file is `<root>/<slug>.md`. Any other
  source is `<root>/.sources/<source_id>/<slug>.md` (`markdown.ts:1389-1397`).
- A source's own sync walks its own root, so the slug is relative to that root
  (or to the Git root in `git-root` mode, which prefixes the subdirectory).
- Export collision keys use `exportPathKey`: NFC, then upper, then lower, then NFC
  (`src/core/export-stage.ts:37-45`). Two pages whose paths differ only in case
  or Unicode normalization collide, and export refuses with
  `export_path_collision`. The fix is to export one source at a time with
  `--source <id> --dir <other>`.

### 3.5 Reserved and special slugs

No enumerated reserved list for slugs was found. `validatePageSlug` checks shape
only. The names below are special in code:

- `memory/unattributed` (`UNATTRIBUTED_MEMORY_SLUG`, `src/core/facts-fence.ts:58`),
  the shared holding page for facts without an attributed entity. Per-folder
  holders are `<folder>/memory/unattributed` (`folderHoldingSlug`,
  `facts-fence.ts:72-75`).
- Derive-phase prefixes that are DB-only by default and never file-backed:
  `life/events/`, `atoms/`, `concepts/`, `extracts/`, `dream-cycle-summaries/`,
  `reports/drift-` (`storage-config.ts:469-484`).
- `.sources/` (section 3.4).
- Slugs from older writers that contain `/` inside frontmatter `slug:`. These are
  normalization-equivalent identities (#3772) and are accepted.
- The file names `schema.md`, `index.md`, `log.md`, `README.md`, `RESOLVER.md`
  (any depth) and `AGENTS.md`, `CLAUDE.md` (root) are not pages (1.3).

### 3.6 Export-escaped names

`exportPagePath` (`src/core/export-stage.ts:67-87`) keeps `<slug>.md` when every
part is a portable file name. Otherwise it escapes:

- Unsafe characters (`\`, control characters, DEL, `:`, `<`, `>`, `"`, `|`, `?`,
  `*`, and lone surrogates) become `~` (`UNSAFE_NAME_CHAR`, `export-stage.ts:44`).
- A Windows reserved device name (`con`, `aux`, `nul`, `com1`, `lpt1`, ...)
  gets a `~` after it (`RESERVED_DEVICE_NAME`, `src/core/portable-slug.ts:22`).
- A trailing dot or space gets a `~` appended.
- A name over `FILE_NAME_MAX_BYTES` (240, `portable-slug.ts:18`) is truncated and
  gets 8 hex characters of `sha256(slug)`. The page is then `restorable: false`.

An escaped page's file always carries a `slug:` stamp naming the real slug
(`exportHeader`, `src/core/export-snapshot.ts:81-85`), so import restores it.
Sidecars use the same escaping (`<dirs>/.raw/<leaf>.json`).

## 4. Links and backlinks

### 4.1 Link syntax recognized in bodies

Extraction is in `src/core/link-extraction.ts`. A page's body is scanned by
several regexes, and a span matched by an earlier pass is masked from later ones.

1. Markdown link to a page path (`ENTITY_REF_RE`, `:223-226`):
   `[Name](dir/slug)`, `[Name](dir/slug.md)`, `[Name](../dir/slug.md)`, or
   `[Name](/dir/slug)`. The first segment must match `[a-z0-9][a-z0-9_-]*`.
   An optional `#anchor` is ignored. This regex also accepts directories that are
   not in the old whitelist (issue #2576).
2. Same-directory markdown link (`SAME_DIR_MD_RE`, `:307`): `[Name](slug.md)`,
   `[Name](./slug.md)`, `[Name](../slug.md)`. The `.md` suffix is required. The
   target is resolved against the linking page's directory
   (`resolveMarkdownLinkSlug`, `:655`).
3. Directory wikilink (`WIKILINK_RE`, `:236-251`): `[[dir/slug]]`,
   `[[dir/slug|Label]]`, `[[dir/slug#Heading]]`. `dir` must be one of
   `people, companies, meetings, concepts, deal, civic, project, projects,
   source, media, yc, tech, finance, personal, openclaw, entities, reference`
   (`DIR_PATTERN`, `:196`).
4. Qualified wikilink (`QUALIFIED_WIKILINK_RE`, `:253-270`):
   `[[source-id:dir/slug]]`, where `source-id` matches
   `[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?`. It pins the target to one source.
5. Generic wikilink (`WIKILINK_GENERIC_RE`, `:279`): any `[[Name]]` without a
   directory. The name is resolved by basename (section 4.5) and flagged as
   needing resolution.
6. A wikilink inside a markdown link label is inert (`MARKDOWN_LABEL_WIKILINK_RE`,
   `:288`, #972).
7. Code references in prose: `src/...` paths matching `CODE_REF_REGEX` (`:330`),
   for code-ref edges.

Frontmatter link fields are read by `frontmatterLinks` (`:1083`) and
`extractFrontmatterLinks` (`:2013`), using the map in 4.2.

Timeline text can also carry links, since the body is scanned as one text.

### 4.2 Frontmatter link fields

`FRONTMATTER_LINK_MAP` (`src/core/link-extraction.ts:1645-1670`) maps a field to a
link type, direction and directory hint, optionally only for one page type:

| Field(s) | Page type | Link type | Direction | Directory hint |
|---|---|---|---|---|
| `company`, `companies` | person | `works_at` | outgoing | `companies` |
| `founded` | person | `founded` | outgoing | `companies` |
| `key_people` | company | `works_at` | incoming | `people` |
| `partner` | company | `yc_partner` | incoming | `people` |
| `investors` | company | `invested_in` | incoming | `companies`, `funds`, `people` |
| `investors` | deal | `invested_in` | incoming | `companies`, `funds`, `people` |
| `lead` | deal | `led_round` | incoming | `companies`, `funds`, `people` |
| `attendees` | meeting | `attended` | incoming | `people` |
| `sources` | any | `discussed_in` | incoming | `source`, `media` |
| `source` | any | `source` | outgoing | (already slug-shaped) |
| `related`, `see_also` | any | `related_to` | outgoing | (already slug-shaped) |

A value may be `[[name]]` (unwrapped by `unwrapWikilink`, `:1983`) or a plain name.
Names resolve through the dir hints, then basename, then search (`makeResolver`,
`:1777`).

### 4.3 Links fence

The `## Links` fence (section 2.6) holds authored edges. Rows carry
`link_source` = the row's `source` (default `manual`) and
`origin_field = links_fence`. The fence is authoritative for those rows. A body
with no fence projects nothing and removes nothing (`links-fence.ts:1-20`).

### 4.4 `link_source` values

The values seen in code (`grep` over `src/core`):

| `link_source` | Origin | Reconciled by |
|---|---|---|
| `markdown` | body markdown and wikilinks (4.1) | import, `extract links` |
| `frontmatter` | frontmatter link fields (4.2) | import |
| `wikilink-resolved` | generic wikilink resolved by basename | import |
| `mentions` | entity mentions (the mentions pass, `src/core/mentions/pass.ts`) | extract |
| `concept-provenance` | concept synthesis provenance (12 references) | cycle |
| `manual` | links fence rows and API-authored edges (default) | fence projection |
| `mcp-remote-mention` | remote mention writer | MCP |
| `legacy` | fallback in one `??` expression | historical |

`MANAGED_LINK_SOURCES` (`src/core/links-fence.ts:36`) lists the reconciled values
that a fence row may not carry. The DB CHECK on `link_source` is the regex
`^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (`links-fence.ts:41`, citing `src/schema.sql`).

### 4.5 Resolution and config toggles

- `makeResolver` (`link-extraction.ts:1777`) tries, in order: exact slug, dir hint
  candidates, then basename. Basename keys are the raw tail, the lowercased tail,
  and the slugified tail (`buildBasenameIndex`, `:1736`; `queryBasenameIndex`,
  `:1754`). A basename match is used only when unique, unless the caller allows
  several (`resolveBasenameMatches`, #972).
- `normalizeBasename` (`:1717-1733`): NFD, strip accents, NFC, remove variation
  selectors, lowercase, latin-fold, drop characters outside
  `[\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}\s-]`, whitespace to `-`, collapse hyphens.
- Toggles, each a config key read from the engine: `isAutoLinkEnabled` (`:2377`),
  `isAutoTimelineEnabled` (`:2390`), `isGlobalBasenameEnabled` (`:2413`,
  `link_resolution.global_basename`, #5749), and `isCrossSourceLinksEnabled`
  (`:2452`).
- Version: `LINK_EXTRACTOR_VERSION_TS = '2026-10-08T00:00:00Z'` (`:108`). Pages
  extracted before this stamp are re-extracted. A bump needs an entry in
  `EXTRACTOR_BUMP_NOTES` (`link-extraction-watermark.ts`).

### 4.6 Typed link inference

- Body links get a type from the verb near the link (`inferLinkType`, `:1491`;
  `traceLinkType`, `:1496`; verb rules at `:1390-1423`, with `joined [X] as <role>`
  reading as `works_at`, #3957 and the 2026-10-05T03 bump).
- Typed relation lines (`src/core/line-grammar.ts`) state their type directly. A
  verb that belongs to another link in the window does not type this one.
- Allowed link types for the pack: `link_types` in `gbrain-base-v2.yaml:425-470`
  (`partner_of`, `relates_to`, `mentions`, `discusses`, `owes_to`,
  `awaiting_reply_from`, `founded`, `works_at`, `invested_in`, `advises`,
  `sourced_from`, `derived_from`, `supersedes`, `redirects_to`, `attended`,
  `authored`, `attributed_to`).
- Temporal evidence (valid_from, valid_until) is derived from dated text on
  extraction (`link-temporal-evidence.ts`, 2026-10-05 bump).

### 4.7 Backlinks: computed, and sometimes written

- Backlinks are a query over the `links` table (DB), for example `get_backlinks`.
  They are not stored in the page file.
- `gbrain check-backlinks check|fix` (`src/commands/backlinks.ts`, header 1-10)
  is the one command that writes backlinks into files. It finds entity mentions
  with the canonical extractor (`extractEntityRefs`, imported at the top of the file), and
  for each target page without a back-link it adds one.
- The written form (`buildBacklinkEntry`, `backlinks.ts:80-91`):
  `- Referenced in [<source title>](<relative path>)`. The relative path has one
  `../` per target directory level. For a directory-shaped source the link drops
  `.md` (#1776). For a root-level source it keeps `.md`, because the extractor
  only parses `dir/name` and the filename check is the only thing that credits a
  root row.
- Placement (`insertBacklinkEntry`, `backlinks.ts:273-300`): under an existing
  `## Referenced by` heading (case-insensitive, `^## Referenced by`), at the end
  of that section. Otherwise a new `## Referenced by` section is inserted before
  the timeline split (or at EOF). The line ending (`\r\n` or `\n`) is copied from
  the body.
- Safety (`backlinks.ts:330-395`): per target page, under `withPageLock` (10 s),
  refuses a page whose frontmatter is already invalid, re-validates after the edit,
  and writes atomically with an on-disk verify (`atomicWriteFileSync`). A dry run
  writes nothing.
- A `fix` run is idempotent only through the extractor: the next `check` must
  credit the new row, which it does for `dir/name` links.

## 5. Import, sync, export, and write-back

### 5.1 Which files are syncable

Section 1.1 and 1.3 give the classifier. In short, `isSyncable(path, opts)`
(`src/core/sync.ts:686`) is true when `classifySync` returns null. The walker used
by `gbrain import` and `sync --full` (`isCollectibleForWalker`,
`src/commands/import.ts:1294`) uses the same checks, so full and incremental sync
agree (#2607).

The code path is the same for every source type: `importFromFile`
(`src/core/import-file.ts:1025`) sends `isCodeFilePath` paths to `importCodeFile`
(`:1241`), and everything else to the markdown path.

### 5.2 Size and ceiling limits

| Limit | Value | Source |
|---|---|---|
| Markdown page body (UTF-8 bytes) | `PAGE_MAX_BYTES = 24 * 1024^2` = 25,165,824 | `src/core/page-size-policy.ts:16` |
| Code file (UTF-8 bytes) | `CODE_FILE_MAX_BYTES = 5_000_000` | `page-size-policy.ts:26` |
| Full-file secret scan cap | `PUSH_SCAN_MAX_FILE_BYTES = 25 * 1024^2` | `page-size-policy.ts:23` |
| Inline threshold (large page) | `PAGE_INLINE_MAX_BYTES = 1024^2` | `page-size-policy.ts:35` |
| Import refusal (markdown) | `MAX_FILE_SIZE = PAGE_MAX_BYTES` (`import-screen.ts:44`) | `file_too_large` |
| Import refusal (code) | `importSizeLimit` (`import-screen.ts:47-49`) | `file_too_large` |
| Tag | `TAG_MAX_BYTES = 2688` | `src/core/tag-limit.ts:11` |
| Sync deletes per run | `DEFAULT_SYNC_MAX_DELETES = 500`, ratio `0.01` | `src/core/sync-reconcile.ts:29-30` |

A markdown file over the limit is refused as `file_too_large` before parsing
(`import-file.ts:1055-1060`). With the segmented-storage policy on, a markdown file
up to `policy.maxBytes` is streamed instead (`import-file.ts:1058`). A page between
the inline threshold and the ceiling is stored segmented but produces the same
file on export (section 5.6).

### 5.3 Git-based incremental sync

Anchor: `sources.last_commit` (`src/core/sync-anchor.ts:26-32`), advanced by the
sync path (the advance logic is in `sync-anchor.ts`, not re-read line by line).
The delta is `computeSyncDelta(repo, from, to)`
(`src/core/sync-delta.ts:134-176`):

1. `git cat-file -t <from>` fails: `{unavailable, anchor_missing}`. The anchor
   was garbage-collected after a history rewrite. The caller falls back to a full
   reconcile (#1970).
2. `git diff --name-status -M <from>..<to>` fails or exceeds the 30 s, 100 MiB
   budget (`DEFAULT_GIT_BYTES_RUNNER` in `src/core/sync-delta.ts`, which uses
   `execFileBounded` with a 30 s timeout and a 100 MiB buffer): `{unavailable, diff_failed}`.
3. Otherwise `buildSyncManifest(output)` (`sync.ts:211-260`), with detached-tree
   changes merged in when requested.

A non-ancestor anchor (force push, squash) is still diffable, because `A..B` is an
endpoint comparison, not a merge-base walk (#1970).

Status letters (`sync.ts:211-260`, `sync-delta.ts` header):

- `A`: added. `M`: modified. `T`: typechange (file to symlink or back), treated as
  modified. `U`: unmerged, treated as modified. `D`: deleted.
- `R<score>`: renamed from `old` to `new`, with the similarity score kept. `C`
  (copy, needs `-C`, which gbrain does not pass): the destination is added.
- Quoted paths (`"people/Jason \"Jay\" Strand.md"`) are unquoted by
  `unquoteGitPath` (`sync.ts:181-209`, #3897). Octal escapes are decoded as bytes,
  then UTF-8 once.
- Byte-exact variant: `git diff --raw -z -M` (`computeLosslessSyncDelta`,
  `sync-delta.ts:268-283`). `parseRawDiffZ` (`:214-265`) reads NUL-separated
  records. A non-UTF-8 path is `not_utf8`, a path with a control character is
  `control_character`, both recorded as unsupported (`sync-byte-paths.ts:24-37`).
  A gitlink (mode `160000`) never enters the manifest.
- Working tree (`--working-tree`): `diff --name-status -M HEAD` plus
  `ls-files --others --exclude-standard` (`sync-delta.ts:97-108`,
  `buildLosslessWorkingTreeManifest` at `:285-288`).

Renames (`src/core/sync-rename-identity.ts` header, #6729): git pairs renames by
similarity, which can be wrong. `confirmRenameIdentities` keeps a page's identity
across a rename only when:

- the pair is exact (`R100`, byte-identical), or
- both sides share a frontmatter `id` and no other file or live page carries it, or
- neither side has an `id`, and the frontmatter `slug:` or title matches, is
  unique across the range, and (for a title) no other live page has it.

A conflicting `id` vetoes. Any other inexact pair becomes a delete plus an add,
and is listed in `downgradedRenames`.

Deletes: `resolveSlugsForRemovedPaths` (`src/core/sync-git.ts:116-250`) maps a
deleted path to its page through `pages.source_path`. The slug is not always
derivable from the path, so the recorded path is authoritative. Deletes are
capped by `sync.max_deletes` (default 500) and `sync.max_delete_ratio` (default
0.01), read per source and then globally (`sync-reconcile.ts:29-80`). What happens
when the cap is exceeded is in `sync-reconcile.ts`, not re-verified here.

Full sync walks the tree. For a git repo it uses `git ls-files` with
`--exclude-standard` (`.gitignore` respected), then `isCollectibleForWalker`. For a
non-git directory it uses `walkBrainRepo`.

Skipped unchanged files: `importFromContent` compares the computed hash with the
stored `content_hash` and returns a no-op. The legacy-formula comparison is at
`src/core/import-file.ts:564`, and the main comparison at `:572`. `forceRechunk` and
`reindex --markdown` bypass the comparison (section 6).

### 5.4 Sync failure codes

Per-file failures are recorded in the sync ledger with a code from
`classifyErrorCode` (`src/core/sync-failure-ledger.ts:265-...`). Codes, in the order
the classifier checks them:

- Filesystem by errno (`FILE_ERRNO_CODES`, `:219-223`): `EACCES`, `EPERM`
  → `PERMISSION_DENIED`; `ENOENT`, `ELOOP`, `EISDIR`, `ENOTDIR`, `ENAMETOOLONG`,
  `EILSEQ` → `FILE_UNREADABLE`.
- Rename sentinel: `RENAME_RECONCILE`.
- Mode refusals: `strict_requires_managed`, `writer_coordinator_required`,
  `COLON_SLUG_WINDOWS_WRITE_THROUGH`.
- `SLUG_MISMATCH` (`:291`).
- Database: `DB_DUPLICATE_KEY`, `STATEMENT_TIMEOUT`.
- Frontmatter: `YAML_PARSE`, `YAML_DUPLICATE_KEY`, `MISSING_OPEN`, `MISSING_CLOSE`,
  `EMPTY_FRONTMATTER`, `NULL_BYTES`, `NESTED_QUOTES` (`:301-318`).
- Generic: `INVALID_UTF8`, `FILE_TOO_LARGE`, `SYMLINK_NOT_ALLOWED`.
- Takes fence: `TAKES_TABLE_MALFORMED`, `TAKES_HOLDER_INVALID`.
- Embedding: `EMBEDDING_NO_CREDS`, `EMBEDDING_NO_TOUCHPOINT`, and timeouts.

Hold codes, a separate deterministic refusal set (`HOLD_CODES`,
`src/core/markdown.ts:510`): `invalid_frontmatter`, `frontmatter_slug_conflict`,
`file_too_large`, `rename_held`, `parser_regression`, `tag_too_long`. Frontmatter
hold reasons (`INVALID_FRONTMATTER_REASONS`, `:512`): `yaml_parse`,
`needs_interpretation`, `ambiguous_identity_key`, `ambiguous_protected_key`. Plus
`visibility_noncanonical` (`visibility-request.ts:73-77`). A symlink is not a hold:
it is skipped with the error `Skipping symlink` (section 1.5).

A hold refuses that one file (it is not imported), and the sync run continues
(`markdown.ts:505-509`, the #5988 hold design). Failures are recorded in the
sync-failure ledger with the codes above.

Other refusals are listed in `docs/guides/write-refusals.md`.

### 5.5 Content hash: exact inputs

Two formulas exist.

Markdown pages (`importFromContent`, `src/core/import-file.ts:254`, hash at `:521`):

```
hash = sha256_hex( JSON.stringify({
  title, type, compiled_truth, timeline || '', frontmatter*, tags*
}) )
```

Inputs are the post-parse values after `sanitizeText` (`importScreened`,
`import-file.ts:383-385`), with these details (`src/core/utils.ts:80-155`):

- `title`, `type`: the parsed page columns.
- `compiled_truth`, `timeline`: the trimmed body halves (section 2.5), after
  `sanitizeText`.
- `frontmatter*`: the parsed frontmatter, with the keys in
  `HASH_EPHEMERAL_FRONTMATTER_KEYS` removed (`utils.ts:80-96`): `captured_at`,
  `ingested_at`, `quarantine`, `content_flag`, `embed_skip`, `atoms_scan_hash`,
  `trust_tier`. Also the top-level `tags` key. The parsed frontmatter has already
  lost `type`, `title`, `tags`, `slug` (`comparableFrontmatter`, `markdown.ts:1305`).
- `tags*`: `page.tags ?? frontmatter.tags`, each stringified, then sorted by JS
  default string sort (`utils.ts:141-155`).
- Key order is the object literal order above. Within `frontmatter*`, it is the
  order of the parsed YAML mapping.
- `sanitizeText` (`src/core/batch-rows.ts:99`, `sanitizeForJsonb` at `:88`) strips
  NUL and replaces lone surrogates with U+FFFD, before the hash.

Code pages (`importCodeFile`, `import-file.ts:1282-1289`):

```
hash = sha256_hex( JSON.stringify({
  title, type: 'code', content, lang, chunker_version: CHUNKER_VERSION,
  grammar_revision?   // only when GRAMMAR_REVISIONS[lang] exists
}) )
```

`content` is the raw file text (not the NUL-replaced storage text). `title` is
`<relativePath> (<lang>)`. `CHUNKER_VERSION = 8` and `GRAMMAR_REVISIONS` are in
`src/core/chunkers/code.ts:146-159`. Changing the chunker version therefore
changes every code hash, which forces a re-chunk.

Markdown hashes do not include the chunker version. A markdown chunker bump is
applied by `reindex --markdown` (`forceRechunk`), not by the hash.

Test vectors (verified with `sha256sum` against the exact strings):

- Input `{"title":"T","type":"person","compiled_truth":"Body.","timeline":"","frontmatter":{},"tags":[]}`
  gives `59e866fc8e052f348ebe4c166dc54de00efc794c731f54465b9cda35c573b373`.
- Input `{"title":"Ünïcode 名前","type":"concept","compiled_truth":"line1\nline2","timeline":"- 2024: x","frontmatter":{"zeta":1,"alpha":"a"},"tags":["a","b"]}`
  (the `\n` is an escaped newline in the JSON text) gives
  `2c858a579c612d35e54f0ad402e731ca5c95088f40a7c79d28b207c65f7ab34b`. This input
  came from `frontmatter` `{zeta, alpha, captured_at, trust_tier}` after the strip.
  The stored frontmatter is `zeta` then `alpha`, insertion order, not sorted.

A `Date` in frontmatter hashes as `JSON.stringify(date)`, which is the ISO string
with milliseconds and `Z` (`"2024-06-01T00:00:00.000Z"`). Section 9 covers this.

The `contentHashLegacy` formula (`utils.ts:158-166`, without the strip and tags)
is still compared once, so an old row can be stamped without a re-chunk
(`import-file.ts:564`).

### 5.6 Export and the round-trip rule

`gbrain export --dir <out>` (`src/commands/export.ts`) writes one markdown file per
page (`exportPagePath`, section 3.6), plus a `.raw/<leaf>.json` sidecar per page
with raw data. The output is staged and published atomically. A collision is an
error and nothing is published (`ExportPathCollision`, `export-stage.ts:90`).

The file text for an inline page is produced by `inlineExportMarkdown`
(`src/core/export-snapshot.ts:88-91`):

```
serializeMarkdown(frontmatter, compiled_truth, timeline, {type, title, tags})
```

- `frontmatter` is the stored page frontmatter (`page.frontmatter`, the DB JSON),
  with a `slug:` stamp when the slug needs one (`slugStampedFrontmatter`,
  `markdown.ts:1368-1373`, #3772 and #5966). Escaped pages always stamp.
- `type`, `title`, `tags`: from the page columns. Tags are the stored tag list.
- Withdrawal overlay: body text is overlaid with the source's withdrawals that
  apply to the page (`exportBodyLedger`, `export-snapshot.ts:100`).
- A segmented page is written by streaming the same pieces (`segmentedExportMarkdown`,
  `:109-...`). The bytes match an inline page of the same content.
- Sidecar JSON: `JSON.stringify(Object.fromEntries(raw.map(row => [row.source,
  row.data])), null, 2) + '\n'` (`export.ts:161`).

Round-trip rule. Export followed by import of the output must reproduce the same
`(source_id, slug)`, `type`, `title`, `tags`, frontmatter keys, `compiled_truth`
and `timeline`, and the same content hash. It does not need to reproduce the
original file's bytes. Known byte differences from the original file:

- A `date` written as a bare date is stored as a `Date` and written back as an ISO
  string, quoted (section 9).
- Key order follows the stored JSON, which follows the original YAML mapping order.
  An export of a page that was written by put_page follows put_page's key order.
- Serializer quoting and folding follow js-yaml's rules (section 2.3), so a
  hand-written file is rewritten with different quotes and wrapping.
- Frontmatter anchors and aliases are expanded into separate values; a value that
  was shared is dumped with `&ref_0` / `*ref_0` anchors (probe in section 2.3).
- Unfenced DB facts and withdrawn facts are not in the file (section 9).

What a Rust round-trip test should check, in order: slug, type, title, tags,
the hash over the parsed values, and the fences. Byte equality with the input
is not required. Byte equality with gbrain's own output is required for files that
gbrain wrote, because they are the canonical form.

### 5.7 Write-back: when gbrain modifies files

The system-of-record doc (`docs/architecture/system-of-record.md`) says canonical
Markdown is the source of truth for file-backed knowledge, and the database is a
rebuildable index for it. The places that write to brain files are:

1. put_page, capture, and write-through (`src/core/write-through.ts`). After the
   row commits, the page is rendered from the row with `serializePageToMarkdown`
   and written atomically (temp file, then rename;
   `write-through.ts` header). It is skipped when `sync.write_through` is off
   (`isWriteThroughDisabled`, `write-through.ts:236-245`). The file is the same
   bytes as an export of that row.
2. Fence rewrites: facts (`replaceOrInsertFactsFence`, `facts-fence.ts:908`),
   takes, and links (`replaceOrInsertLinksFence`, `links-fence.ts:161`). These
   only replace the fence text. A fence that does not parse cleanly is refused
   before any rewrite (`assertFenceRewritable`, `fence-shared.ts`, #6188).
3. Timeline write-through (`src/core/timeline-write-through.ts`) splices a timeline
   block and may add a `<!-- gbrain:materialized v1 ... -->` line (section 2.6).
4. `check-backlinks fix` (section 4.7).
5. `gbrain frontmatter generate --fix` and `repair frontmatter`: write synthesized
   frontmatter (`frontmatter-inference.ts` header). Plain import does not write.
6. Sync writes the managed `.gitignore` block for `db_only` directories
   (`src/commands/sync/gitignore.ts:178`).
7. Sync may create the first commit of an unborn repo, `gbrain: initial commit
   (auto-init by sync)`, with hooks disabled (`src/core/sync-git.ts:464-620`). It
   refuses to run on a repo with commits.
8. `files upload` writes a `.raw/<page>/` sidecar and a files row.
9. Export writes only to a fresh `--dir`, never into the source tree.

Concurrency and authority: a page write carries the caller's observed revision or
`force` (`docs/architecture/system-of-record.md`, "Page-write persistence boundary").
Writes go through the managed journal when managed activation is on; direct
writers fail closed (`docs/architecture/canonical-writers.md`). The lock
primitives are in `spec/tla/` (section 7).

Drift: when a file and the database disagree, writes refuse with `source_changed`
for the drifted page, unless the page is under a `keep_db` prefix (section 1.4).

### 5.8 Line grammar (typed relation and fact lines, opt-in)

`skills/conventions/line-grammar.md` defines lines that the importer can read as
typed links or facts. Settings: `line_grammar.enabled` (default false),
`line_grammar.allow_undeclared_types` (default false), and
`line_grammar.effective_ranges` (default true) (`src/core/line-grammar.ts:466-467`).
Parser: `parseLineGrammar` (`line-grammar.ts:286`).

- Relation line: `- works_at [[companies/acme-example]] (since 2024)`. Exactly one
  link after the relation type. The optional trailing `(context)` and
  `[Source: ...]` citation are stripped first (`stripTrailingCitation`, `:136`).
  The type is snake_case; `worksAt` and `works-at` normalize to `works_at`, and
  `"board member"` becomes `board_member` (`normalizeRelationType`, `:186`).
- Fact line: `- [preference] Prefers oat milk #coffee`. The category word maps
  `event`, `preference`, `commitment`, `belief`, `fact`, `idea` to fact kinds.
  Fact lines are searchable text but are not added to recall's facts.
- Validity range: `@effective[2022-03,2024-09)` (alias `@valid`). `[` and `]` are
  inclusive, `(` and `)` exclusive, an empty side is open. Dates are `YYYY`,
  `YYYY-MM`, or `YYYY-MM-DD`, UTC (`parseEffectiveQualifier`, `:218`).
- Lines under machine-written headings (Timeline, See also, Related, Sources,
  Links, Backlinks) are never read as relation lines.

## 6. Chunking contract (only where it touches stored format)

Chunks are rows in `content_chunks`, derived from the page. A chunk is never
written back to a file, so chunk boundaries never change file bytes, page hashes,
or exports. The parts that matter for the port:

- Markdown chunker: `chunkText` (`src/core/chunkers/recursive.ts`).
  `MARKDOWN_CHUNKER_VERSION = SAFE_FENCE_CHUNKER_VERSION = 4`
  (`recursive.ts:48`, `src/core/search/safe-chunks.ts:6`: "First markdown index
  built from the strict full-body fence sanitizer"). Written to
  `pages.chunker_version` at import (`import-file.ts:845`, `:860`).
- Chunk input: the body with materialized markers removed
  (`stripMaterializedMarkers`, `src/core/markdown-chunks.ts:23`), and with takes
  and facts fences removed (`stripFactsFence(stripTakesFence(body), ...)`,
  `markdown-chunks.ts:133`). So fence rows are in the page, not in the searchable
  chunk text, unless a fence overlay says otherwise (`fence-overlay.ts`).
  Remote bodies are also sanitized (`sanitizeRemoteBody`), and secrets are
  redacted (`redactFindings`) before chunking.
- Segmented pages: pages over the inline threshold are stored as segments
  (`src/core/page-body/*`). `SEGMENTED_CHUNKER_VERSION = 5`
  (`src/core/page-body/segment-chunks.ts:47`). The exported file for a segmented
  page is byte-identical to an inline page of the same content (section 5.6).
- Code chunker: `chunkCodeText` with tree-sitter grammars.
  `CHUNKER_VERSION = 8` (`src/core/chunkers/code.ts:146`) and
  `GRAMMAR_REVISIONS = {lua:1, typescript:2, tsx:2, javascript:2, python:2,
  ruby:2, elixir:1}` (`code.ts:157`). These are folded into the code content
  hash (section 5.5), so a bump re-imports every code file of that kind.
- Source-level stamp: `chunkerStamp()` (`code.ts:159`) joins the chunker version
  and grammar revisions into `sources.chunker_version`. A change makes the next
  sync walk every file and compare hashes.
- Re-chunk without a hash change: `reindex --markdown` sets `forceRechunk`
  (option documented in `import-file.ts`, v0.32.7 CJK wave), because markdown
  hashes do not include the chunker version.

## 7. Specs and contracts

- `spec/tla/README.md`: TLA+ models of two concurrency protocols, checked with TLC
  at small bounds (`bun run test:tla`). Each spec has `.cfg` files and a
  `mutants.json` that the code must also fail.
  - `spec/tla/drain-lease/DrainLease.tla`: the managed-sync drain lease. One drainer
    per source at a time. The lease is a row of `gbrain_cycle_locks`, and its
    `acquisition_token` is the fencing token. Code: `src/core/persistence/sync-lease.ts`,
    `src/core/db-lock.ts`. Postgres only.
  - `spec/tla/refresh-barrier/RefreshBarrier.tla`: the refresh write barrier and its
    deferred-write queue for one managed worktree. Code:
    `src/core/persistence/journal.ts`, `refresh-barrier.ts`, `worktree-refresh.ts`
    (design in `docs/designs/REFRESH_WRITE_BARRIER.md`, per the spec header).
  These do not define the file format. They define the locking and ordering a
  Rust port must keep if it implements managed sync.
- `docs/architecture/system-of-record.md`: the authoritative split. FS-canonical:
  takes, facts, links, timeline, tags (with the fence or frontmatter that holds
  each). Derived from files: `pages`, `content_chunks`, `page_versions`. DB-only by
  design: `raw_data`, runtime job state, credentials, receipts, withdrawal ledger,
  belief ledger, config keys such as `sync.repo_path`.
- `docs/architecture/canonical-writers.md` with its TSV censuses
  (`canonical-writers.tsv`, `coordinated-writes.tsv`, `managed-mutating-writers.tsv`).
  These list every engine call and SQL write to page bodies, frontmatter,
  visibility, tags, aliases, facts, takes, timeline rows and source identity, and
  which writers need the coordinator. The census is the Rust port's checklist for
  what must go through the same gate.
- `docs/architecture/type-taxonomy.md` and `docs/architecture/schema-packs.md`:
  the type set (`gbrain-base-v2`, 15 types plus `note`; the pack file itself says
  "16 total"), the pack format (`api_version: gbrain-schema-pack-v1`), and how packs
  extend types, path prefixes, subtypes, and link types.
- `docs/guides/fence-format.md`: generated fence reference (section 2.6). Its
  drift is tested by `test/fence-format-reference.test.ts`.
- `docs/takes-vs-facts.md`: takes are multi-holder beliefs with a weight, and facts
  are verifiable claims. Both are stored in fences and reconciled into tables.
- `docs/storage-tiering.md`: the `gbrain.yml` storage contract (section 1.4).
- `docs/protocol/MEMORY_VERBS_v1.md`: the write verbs and CLI exit status for writes
  (exit 10 for `write_pending`, `docs/architecture/system-of-record.md`).
- `docs/contracts/qm-memory-provider/v1.json` through `v5.json`: JSON contracts for
  one external memory provider's tools. The timeline and link write arguments
  (for example timeline `date: YYYY-MM-DD`, `summary` one line, `details`, `source`;
  link `to`) have the same shape as the timeline and link writers, so a port must
  keep them aligned. This is not a file format.
- `docs/contracts/public-surface.json`: the CI-enforced CLI and MCP surface. Not a
  file format; the peer MCP and CLI research covers it.
- `skills/_brain-filing-rules.md` (and `.json`): agent rules for where content goes.
  Format-relevant rules: `sources/` is only for bulk imports and raw feeds, never for
  content with a clear subject (section "What `sources/` Is Actually For"). Raw
  sources are kept in a `.raw/` sidecar when under 100 MB (text or PDF), and larger
  or media files go to storage with a `.redirect.yaml` pointer (section "Raw
  Source Preservation"). Every back-link is required (section "Iron Law: Back-Linking").
- `skills/conventions/`: agent conventions. `line-grammar.md` (section 5.8),
  `path-discipline.md`, `page-privacy.md` (write no designation by default), and
  `brain-routing.md` (source resolution). These describe writer behavior, not
  parser behavior.
- `templates/`: `ACCESS_POLICY.md.template`, `HEARTBEAT.md.template`,
  `SOUL.md.template`, `USER.md.template`, `bootstrap/`. These seed agent-facing
  files, not pages.
- `src/schema.sql`, table `pages` (how the file maps to columns): `source_id`
  (default `'default'`), `slug`, `type`, `page_kind` (`markdown`, `code`, `image`),
  `title`, `compiled_truth` and `timeline` (both `TEXT`, default `''`),
  `frontmatter` (`JSONB`, default `'{}'`), `content_hash`, `created_at`,
  `updated_at`, `deleted_at` (soft delete, 72 h before purge), `effective_date`
  and `effective_date_source` (`event_date`, `date`, `published`, `filename`,
  `fallback`), `import_filename`. Tags are a separate table, and aliases are a
  separate table. Mapping: frontmatter becomes `frontmatter`, the body splits into
  `compiled_truth` and `timeline`, and `title`, `type`, tags and slug become
  columns (section 2.4).

## 8. Annotated examples (real fixture files)

All four files were parsed with the repo's `parseMarkdown` and fence parsers (probe
`probe script probe4.ts`). The output is what the importer stores.

### 8.1 `test/fixtures/bootstrap-corpus/pages/companies__vector-co.md`

```markdown
---
type: company
title: Vector Co
aliases: [vector, vector-capital]
---

# Vector Co

An early-stage investment fund focused on memory-systems and robotics.

Vector Co backs [[companies/ridge-platform]] and [[companies/summit-robotics]], and
partner [[people/bob-placeholder]] sits on both boards.
```

- File name: `companies__vector-co.md`. The fixture naming replaces `/` in the slug
  with `__`; the importer uses the real path, so the slug is `companies/vector-co`
  (the README of that folder describes the synthetic corpus).
- Frontmatter: a flow sequence `[vector, vector-capital]`, which is a YAML flow
  list, not a string. Stored `frontmatter` is `{"aliases":["vector","vector-capital"]}`.
- `type: company` is explicit (`typeExplicit: true`).
- Title: `Vector Co` from frontmatter; the H1 would give the same value.
- No closing timeline sentinel, so `timeline` is empty and the whole body is
  `compiled_truth`, which starts `# Vector Co`.
- Body links: two directory wikilinks (`[[companies/ridge-platform]]`,
  `[[companies/summit-robotics]]`) and one (`[[people/bob-placeholder]]`). Each
  produces a `markdown` link (4.1). The `companies/` and `people/` directories
  are in `WIKILINK_RE`'s list.
- Parse result: no errors, no fences, zero facts, zero takes.

### 8.2 `test/fixtures/bootstrap-corpus/pages/meetings__2026-02-21-graph-traversal-review.md`

```markdown
---
type: meeting
title: graph traversal review
date: 2026-02-21
---

# graph traversal review — 2026-02-21

Attendees: [[people/bob-placeholder]], [[people/alice-example]].

## Notes

Walked through [[concepts/graph-traversal]] benchmarks for
[[companies/summit-robotics]]. ...
```

- `date: 2026-02-21` is a YAML date. It loads as `Date` at UTC midnight. Stored
  as `"2026-02-21T00:00:00.000Z"` (probe: `fm: {"date":"2026-02-21T00:00:00.000Z"}`).
  For `meetings/` the filename date comes first in the effective-date chain
  (section 2.4), and it is the same day.
- `attendees` is not in frontmatter here, so the `attendees` link rule
  (`FRONTMATTER_LINK_MAP`, meeting, `attended`) does not fire. The
  `Attendees:` line in the body is an ordinary markdown body with wikilinks.
- The H1 is the title source only when frontmatter has no `title:`. This file has
  one, so `title` is `graph traversal review` (lowercase, as written).
- Six wikilinks in the file (two in `Attendees`, four in the notes) become
  `markdown` links. `people/`, `concepts/` and `companies/` are in the list.

### 8.3 `test/fixtures/skill-evals/company-brainify/shared-now/people/charlie-example.md`

```markdown
---
type: person
title: Charlie Example
company: "acme-example"
role: Staff Engineer
score: 7
---
# Charlie Example

Staff Engineer on the payments platform at [[companies/acme-example]]. Built the payments v2 settlement service.
Work email: charlie@acme-example.com. Previously at widget-co; studied at a state university.

## Assessment

Strengths: deep knowledge of settlement systems.
Weaknesses: underperforming on on-call; others are picking up slack on incidents.

## Takes

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | The user believes charlie-example is underperforming on on-call | take | brain | 0.7 | 2026-09 | meetings/2026-09-12-staff-sync |
| 2 | Payments v2 settlement ships in Q4 | bet | people/charlie-example | 0.6 | 2026-09 | projects/payments-v2 |
<!--- gbrain:takes:end -->

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Charlie Example's base salary is $210,000 | fact | 1.0 | private | medium | 2026-09-01 |  | daily/2026-09-15 |  |
| 2 | Charlie Example built the payments v2 settlement service | fact | 1.0 | private | medium | 2026-08-01 |  | projects/payments-v2 |  |
<!--- gbrain:facts:end -->
```

- `company: "acme-example"` is quoted in the source. The value is the string
  `acme-example`.
- `score: 7` is a number (JS `7`, which hashes as `7`, not `7.0`).
- Frontmatter stored: `{"company":"acme-example","role":"Staff Engineer","score":7}`.
  `type`, `title` are lifted.
- The takes and facts fences sit in the body (compiled truth). Parser results:
  2 facts rows and 2 takes rows (the probe counted rows; it did not print the
  parser warnings). Holders `brain` and `people/charlie-example` match
  `HOLDER_REGEX`. The kinds `take`, `bet` and `fact` are in `TAKE_KIND_VALUES`.
- The `Assessment` and other `##` sections stay in compiled truth. Nothing is in
  the timeline (`timelineLen: 0`).
- Link from the body: `[[companies/acme-example]]` (`markdown` link).
- The facts table has the 10-cell narrow layout. The `source` cell `daily/2026-09-15`
  is free text (the source is not validated as a page).

### 8.4 `test/fixtures/short-code-alias/meetings/2026-10-10-joronex-call.md`

```markdown
---
title: "Call with JOF"
type: meeting
date: 2026-10-10
---
# Call with JOF, 2026-10-10

Attendees: Kofi, me.

- Their champion is busy with a reorg.
- Pricing: the right number is $26 per seat; the $11 in the quote was a typo. Seat count unchanged.
- Their champion is busy with a reorg.
```

- The title is quoted in the source; the quotes are YAML syntax, not part of the
  value (`Call with JOF`). The H1 `# Call with JOF, 2026-10-10` is not used,
  because a frontmatter title exists.
- No timeline sentinel, and the bullets are not dated, so the bare-section rule
  (2.5 step 2) does not apply. `timelineLen: 0`.
- Path `meetings/2026-10-10-joronex-call`. The effective date is `date:`. The
  filename date would come first for `meetings/`, and it is the same day here.
- The `Attendees: Kofi, me.` line is plain text (no link), so the attendee link
  rule does not fire.

## 9. Contract risks for the Rust port, and open questions

Each risk says what gbrain does, where, and what a port must do. Items marked
"probe" were checked by running the repo's modules.

### 9.1 YAML parsing

1. Library gap. gbrain uses js-yaml 4.3.2 with the calendar-checked timestamp type
   and merge keys (section 2.3). Rust YAML crates differ on YAML 1.1 booleans
   (`yes`, `on`), octal and `0o` integers, `.inf` and `.nan`, merge keys (`<<`),
   and explicit tags (`!!binary`, `!!omap`, `!!pairs`, `!!set`). Check every crate
   against the probe list in section 2.3 before choosing. Verify the current
   maintenance status of any candidate; `serde_yaml` is widely reported as
   unmaintained, so do not assume it is maintained.
2. Duplicate keys must be an error (probe: `Malformed YAML frontmatter`). Some Rust
   YAML crates keep the last value silently.
3. The alias bounds (16 aliases, 65,536 bytes of expansion) must be enforced
   before expansion, with the same intended-refusal code `yaml_alias_limit`.
4. Recovery and quoting are text transforms, not YAML features. Port
   `quoteAmbiguousFrontmatterLine` (`markdown.ts:233-248`) and the recovery pass
   (`frontmatter-recovery.ts`, `RECOVERY_VERSION = 1`) as text code, in the same
   order (quote pass, then strict parse, then recovery). Their regexes decide which
   files import at all.
5. Fence close matching differs: the reader requires a line that is exactly `---`
   (with trailing spaces or tabs, `data-frontmatter.ts:118`), while the validator
   trims the line (`markdown.ts:609`). A line `  ---` is a closer for the validator
   and not for the reader. A port must choose one; the reader decides the body.
6. Language selector: only `yaml`, `yml`, `json` (and the empty selector) are
   allowed. `---json` is parsed as JSON, so a Rust port must accept it.
7. Root value: a frontmatter block that is a list, a scalar, or a null root is an
   error, except an empty block, which is `{}`.

### 9.2 Dates and timestamps

8. A date-only scalar becomes a UTC-midnight instant (probe). The stored
   `frontmatter` then holds the ISO string `"2024-06-01T00:00:00.000Z"`, because
   `JSON.stringify` of a `Date` is the ISO string with milliseconds. The export of
   that page quotes the string (probe: `date: '2024-06-01T00:00:00.000Z'`), so a
   round trip changes the file bytes (section 5.6). A port must store and emit the
   same string, not the date-only form, to keep existing brains' hashes.
9. The same frontmatter `Date` renders differently in two places:
   `coerceFrontmatterString(Date)` gives `YYYY-MM-DD` (`markdown.ts:117-121`), used
   for `title`, `type`, `slug`. The hash and the JSON store give the full ISO string.
   Both must be reproduced.
10. Tags: `extractTags` maps a `Date` element with `String(date)` (`markdown.ts:1278`),
    which gives the long locale and timezone form (for example
    `Sat Jun 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)`), not ISO.
    The output depends on the machine's timezone. This is a bug to decide about
    (section 10).
11. Naive datetimes (no offset) are read as UTC instants but flagged with
    `NAIVE_DATETIME` (`data-frontmatter.ts:19-25`). The flag is a non-enumerable
    property, so it is lost when the value is stored as JSON. Effective-date code
    that needs the wall clock (`brain.timezone`) cannot see it after a DB round trip.
    Probe: `stamp: 2024-06-01T09:30:00` is stored as `09:30Z`.
12. Calendar validation: `2024-02-30` stays a string (probe). A port must not
    normalize it.
13. Effective-date range: an explicit frontmatter date accepts years from 1 to
    now plus one year, and drops the epoch-0 and `0001-01-01` placeholders
    (`src/core/effective-date.ts`, range rule in the header comment).

### 9.3 Hash byte compatibility

14. The hash is over `JSON.stringify` output. A port must reproduce:
    - Key order: insertion order from the YAML mapping, not sorted. The fixed
      outer order is `title`, `type`, `compiled_truth`, `timeline`, `frontmatter`,
      `tags`. A frontmatter key that is an integer-like string (for example `"10"`)
      is ordered before the others by JS objects, ascending, regardless of
      insertion. A port that uses an ordered map must mimic that for such keys.
    - Numbers: JS formatting. `1.0` hashes as `1`, `1e3` as `1000`, `0.1` as `0.1`,
      `1e21` as `1e+21`, `-0` as `0`. Rust `serde_json` writes `1.0` for a float.
      Use one number model and test it.
    - Strings: `JSON.stringify` escapes `"` and `\`, uses `\b \f \n \r \t`, writes
      other control characters as lowercase `\u00xx`, writes lone surrogates as
      `\udXXX`, and writes everything else (including U+2028 and non-ASCII) raw.
      Rust `serde_json` escapes the same set but test U+2028 and `\u007f`.
    - `null` stays `null`. `undefined` is dropped, but YAML cannot produce it.
15. Probe vectors (section 5.5) match `sha256sum` of the exact strings. Use them as
    the first unit test of the port.
16. Dropped keys: `HASH_EPHEMERAL_FRONTMATTER_KEYS` (`utils.ts:80-96`). A change to
    that list changes every hash. Treat the list as frozen.
17. The legacy formula (`contentHashLegacy`) must still be recognized for old rows
    (`import-file.ts:564`).
18. Code hash includes `chunker_version: 8` and grammar revisions. A port that
    chunks differently with the same version gets different hashes, so the chunker
    version must mean the same thing.

### 9.4 Unicode and slugs

19. Unicode tables: `\p{Ll}`, `\p{Lo}`, `\p{M}`, `\p{N}` and NFD and NFC depend on the
    Unicode version. Node's ICU and the Rust `regex` and `unicode-normalization`
    crates may differ for newly assigned characters. Pin one version and write
    tests for every script in the probe table (section 3.1).
20. Two slug functions differ by design: `slugifySegment` keeps stroke letters
    (`đ`), `normalizeBasename` folds them. Both must be ported (section 3.3).
21. Lowercasing: `toLowerCase` in JS and `str::to_lowercase` in Rust both use full
    mappings, and both are locale-independent here. Test `İ` (U+0130), which
    lowercases to two code points in both.
22. `validatePageSlug` rejects uppercase (probe), but `validateSlug` lowercases
    (probe). The port must keep both behaviors, or it will refuse slugs the
    importer accepts.
23. Surrogates: JS strings may hold lone surrogates, and `sanitizeText` replaces them
    with U+FFFD before the hash (`batch-rows.ts:88-100`). A Rust `String` cannot hold
    them, so the port must replace them at the same point, or invalid input differs.
24. Input decoding: files are read as `utf-8` (`import-file.ts:1063`). Node replaces
    invalid byte sequences with U+FFFD without an error. The sync ledger has an
    `INVALID_UTF8` code (`sync-failure-ledger.ts`), but the strict decoder was not
    located in this read. Open question: does a file with invalid UTF-8 import with
    replacement characters, or is it refused? A Rust port that refuses would differ.

### 9.5 Frontmatter semantics that differ silently

25. Inference at import (section 2.4): a file with no leading `---` gets
    `title`, `type`, `date`, `source`, `tags` synthesized in memory, with `type`
    `note` for an unmatched path. Parsed without inference, the same file would be
    `concept`. The Rust importer must apply the same default unless it deliberately
    changes behavior. Open question: is this default still wanted?
26. `visibility`: exact lowercase `private` is the only private value. A port that
    lowercases or trims the value would make a page private that gbrain treats as
    world-readable, or the reverse. Match `visibility-request.ts` exactly.
27. Two type tables. A call with no `activePack` uses the hardcoded
    `GBRAIN_BASE_PATH_PREFIXES`. A call with a pack uses the pack. Which production
    call sites pass the pack is not fully mapped here (section 10).
28. `type` and `title` are lifted from frontmatter. A stored copy from an older
    import (`#6454`) must not override the column on render.
29. The closing fence (9.1-5) and the leading blank-line lift (`#4526`) are
    behavior changes that the test corpus pins. A port needs the corpus.

### 9.6 Fences and tables

30. Markers have three dashes (`<!--- gbrain:facts:begin -->`). A port that writes
    two dashes creates markers gbrain does not read (the constants at
    `facts-fence.ts:86-87`, `takes-fence.ts:124-125`, `links-fence.ts:26-27`).
31. Cell escaping: `\|` for a pipe, `<br>` for a newline, and the `&#58;` and
    `&amp;` marker escape (section 2.6). Decoding must remove exactly one level.
32. Facts `kind` vocabulary (`event`, `preference`, `commitment`, `belief`, `fact`,
    `idea`) differs from the takes vocabulary (`fact`, `take`, `bet`, `hunch`).
    Keep them separate.
33. Fence placement: the first facts fence must sit above the timeline sentinel
    (`facts-fence.ts:908`). A port that appends at end of file puts the fence below
    the sentinel, and the reconcile refuses it (`FACTS_FENCE_BELOW_SENTINEL`, #4756).
34. A marker inside a fenced code block is ignored, and a mispaired code fence
    leaves every candidate live (`findTimelineSplitIndex` comment, `markdown.ts:900-906`).
    Port the same code-fence scanner (`fence-scan.ts`) rather than a regex.
35. Round-trip of fence rows: a clean fence renders deterministically (rows sorted,
    `links-fence.ts:147`), but a facts or takes fence is re-rendered from parsed rows,
    so a row the parser skipped is deleted by a rewrite. gbrain refuses such a
    rewrite (`assertFenceRewritable`). A port must refuse too.

### 9.7 Links

36. Wikilink directory whitelist (`DIR_PATTERN`, `link-extraction.ts:196`) versus the
    any-directory markdown form (`ANY_DIR_SEGMENT`). The two rules differ on
    purpose (#2576). Port both.
37. The `.md` suffix is stripped by ENTITY_REF_RE and SAME_DIR_MD_RE, but the comment
    on WIKILINK_RE says it strips `.md` too; the regex does not show that. Verify with
    a test before porting (open).
38. Link rows are derived; the file is canonical. Backlinks are never stored
    in the file except the `## Referenced by` section from `check-backlinks fix`.

### 9.8 Sync and git

39. Rename similarity: `git diff -M` pairs renames by similarity, and the threshold
    and algorithm belong to git. A Rust port that reads the diff by calling git gets
    the same pairs; one that computes its own gets different ones. Call git.
40. Git output: quoted paths and NUL-separated `--raw -z` output. Use `-z` and do not
    trust the quoted form.
41. Path bytes: non-UTF-8 and control-character paths are unsupported (not
    imported, recorded as holds). Linux allows non-UTF-8 names.
42. `ops/` must not be pruned (`sync.ts:382-387`). Re-adding it silently drops pages.
43. Dot-prune: the default source prunes `.sources/`, `.raw/`, `.obsidian/`, and any
    dotfile. A port must keep the dot rule, or it will import sidecars as pages.
44. The initial commit side effect: sync creates `gbrain: initial commit (auto-init
    by sync)` in an unborn repo (`sync-git.ts:464-620`). A port that does not
    replicate this must not create the repo itself, or it must refuse when commits
    exist.
45. The managed `.gitignore` block is rewritten on success. Its header text
    (`# Auto-managed by gbrain (db_only directories)`, `gitignore.ts:178`) is what
    gbrain writes, so a port should write the same text to keep existing repos stable.
46. Symlinks: refused by the importer, and a typechange to symlink leaves the old
    content indexed (section 1.5). Do not "fix" this in the port without a decision.

### 9.9 Export and round trip

47. The export frontmatter is the stored JSON, so every risk in 9.2 shows up in
    exports. Export is not byte-identical to a hand-written source file, only to
    gbrain's own output.
48. Frontmatter anchors: a value shared twice is dumped with `&ref_0` anchors
    (probe). A port that expands values instead writes different bytes. Gbrain's own
    output (no shared values) is unaffected.
49. js-yaml line folding: a long string with spaces is written as a `>-` folded block
    scalar at 80 columns (probe). A port that writes plain or quoted scalars gets
    different bytes for the same value. Decide whether byte equality with gbrain's
    own writer is required (section 10).
50. Export directory: `exportPagePath` escapes names. A collision check uses case and
    Unicode folding (`exportPathKey`). A port on a case-insensitive filesystem must
    run the same check.

### 9.10 Things that are fixed but easy to miss

51. `ops/` is ordinary content. The bundled daily-task-manager skill uses `ops/tasks`.
52. Frontmatter `aliases` may be a comma string. A port that accepts only lists
    loses aliases from existing pages.
53. Image pages keep the full path as the slug (`media/x/pic.png`), with no extension
    stripping. Other pages strip `.md` and `.mdx` only.
54. `slugifyPath` strips `.md` only once at the end, so `notes/x.md.md` gives
    `notes/x.md`. Probe not run; derived from the regex at `sync.ts:776`.

## 10. Open questions for the port owner

1. YAML library and writer fidelity. Decide whether gbrain's own output must be
   byte-identical to the js-yaml dump (quotes, folding at 80 columns, `&ref`
   anchors). Byte identity needs a port of js-yaml's dump rules. Semantic identity
   (same parse, same hash) is much smaller. Recommendation: semantic identity for
   reads, and a golden test set generated by the TypeScript writer for writes.
2. Date storage. Keep storing dates as ISO datetime strings (today's behavior), or
   store date-only for `YYYY-MM-DD` inputs. Changing this changes every existing
   hash. Recommendation: keep today's storage, since the port must read existing
   databases unchanged.
3. Naive datetime flag. Persist the wall-clock flag so `brain.timezone` works after a
   DB round trip (today it is lost), or keep the loss. This changes stored values only
   for naive datetimes.
4. Tags with dates. Decide whether `String(date)` (timezone-dependent, today) is a bug
   to fix, or a behavior to keep for existing data. Recommendation: fix to ISO for
   new writes and document it.
5. Type inference defaults. Keep the import-time `note` default for frontmatter-less
   files (today), or change it to `concept`. Keep one type table (the pack) and drop
   the hardcoded one, or keep both (today). Which call sites pass a pack needs a
   full grep before deciding.
6. Frontmatter inference at import. Keep it on by default (today), or require
   `gbrain frontmatter generate --fix` to write it.
7. `.raw/` spelling. Pick one canonical sidecar layout (three exist: section 1.5).
   Recommendation: the export layout `<dir>/.raw/<leaf>.json`, because it is the only
   one a restore reads.
8. Invalid UTF-8 handling (9.4-24). Confirm the current behavior with a test file.
9. `.md` stripping inside wikilinks (9.7-37). Confirm with a test file.
10. Whether to port the legacy `.redirect` format (v0.8) at all, or only
    `.redirect.yaml`.
11. Managed sync and locks. Whether the Rust port implements managed sync at all in
    this milestone. If yes, the TLA+ specs (section 7) define the lock behavior that
    must match.
12. Symlink typechange (9.8-46). Keep the current skip-and-keep-old-content behavior,
    or route to delete (the code comment calls this a follow-up).

## 11. Verification trail

- Probe scripts (read-only, outside the repo): `probe script probe.ts`,
  `probe2.ts`, `probe3.ts`, `probe4.ts`, `probe5.ts`.
- Hash vectors checked with `sha256sum` (section 5.5).
- Not run: the repository test suite. The fixtures were parsed directly.
- Not read in full: `src/core/fence-scan.ts`, `src/core/persistence/*` (managed
  write path), `src/core/latin-fold.ts`, `src/core/timeline-write-through.ts`, the
  full `gbrain.yml` parser, and the chunkers (only their version constants and
  input stripping). Items that depend on them are marked open.
- Line numbers are from commit 8bbfd0b5e8 in the working tree. Re-check them if the
  tree moves.




