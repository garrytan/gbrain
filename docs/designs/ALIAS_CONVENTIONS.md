# Alias conventions: the declared-name grammar spec

Status: written before any calibration document of the entity-recall fix wave
was read, and committed before its first development run. The grammar in
`src/core/mentions/aliases.ts` implements this list. It is drawn from how
people and record systems write other names for an organization, account,
product line or person: style guides, legal drafting, CRM and support-desk
exports, company filings and ordinary business prose. No phrase here is copied
from a benchmark generator; when a benchmark phrasing is covered, it is
covered because it is an instance of a general form below.

Every fixture uses placeholder names (`Acme Example`, `Widget Co`,
`Quormiro Capital`, `Dana Example`). Each convention has a positive fixture and,
where precision is at risk, a negative one, in
`test/mentions-policy-aliases.test.ts`.

## What counts as a name

A captured alias is one of:

- **Quoted.** Up to 4 words inside straight or curly double quotes, or single
  quotes, directly after a cue or a label: `also known as "Blue Harbor"`.
- **Unquoted run.** After a cue or a label, a run of up to 4 tokens, each a
  capitalized word (`Blue`, `O'Neil`, `Widget&Co`) or a code token (an
  uppercase letter or digit followed by letters, digits, `-`, `.`, `&`; at least
  one uppercase letter or digit: `QUCO`, `ZX-41`, `A1B2`). The run ends at
  punctuation other than an inner `-`, `.`, `&` or `'`, at a lowercase word, at
  the end of the line, or at a possessive `'s` (the possessive itself is never
  part of the name).

A capture is rejected when:

- it is followed by a possessive (`also known as Blue Harbor's team` names a
  team, not the account);
- every token is a common capitalized word: weekdays, months, quarters and
  half-years (`Q3`, `H1`, `FY26`), department and body names (`Board`,
  `Finance`, `Legal`, `Sales`, `Marketing`, `Engineering`, `Operations`,
  `Support`, `HR`, `IT`), and generic planning nouns (`Plan`, `Report`,
  `Team`, `Project`, `Update`, `Review`), with a leading `The` ignored;
- the cue belongs to another entity in the same sentence: a relational noun
  (`competitor`, `rival`, `partner`, `parent`, `subsidiary`, `affiliate`,
  `vendor`, `supplier`, `customer`, `client`, `acquirer`, `investor`) appears
  between the start of the sentence and the cue (`our competitor, also known
  as Blue Harbor` declares nothing for this page);
- the existing post-filters reject it (`aliasRejection`: under 4 characters
  unless it is a short code the page declares for itself, below; a generic
  token; the first word of the page's own multi-word name) or it equals the
  page's own name;
- it equals another live page's exact title in the same source (the existing
  reader and gazetteer guard).

A single-token alias matches only as written (`case_sensitive`); a multi-word
alias matches case-insensitively, like a multi-word title.

## Prose cues

A cue is followed by an optional `:`, `,`, `(` or `-`, an optional article
(`the`, `a`), and a quoted name or an unquoted run.

| Convention | Cue forms | Positive fixture | Negative fixture |
|---|---|---|---|
| Also known as | `also known as`, `a.k.a.`, `aka`, `AKA` | `Widget Co, also known as Blue Harbor, renewed.` → `Blue Harbor` | `aka the usual` → nothing (lowercase) |
| Known as | `known as`, `known internally as`, `internally known as`, `known to the team as`, `better known as`, `widely known as` | `Acme Example, known internally as Project Kestrel` → `Project Kestrel` | `known as a leader` → nothing |
| Nickname | `nicknamed`, `nickname`, `nicknames` | `The account is nicknamed "Copper Fox".` → `Copper Fox` | — |
| Goes by | `goes by`, `went by`, `going by` | `Dana Example goes by DEX in chat.` → `DEX` | `goes by the book` → nothing |
| Called | `also called`, `sometimes called`, `often called`, `commonly called`, `is called` | `also called Northwind Ops` → `Northwind Ops` | `the team calls it a success` → nothing (`calls` is not a cue) |
| Referred to | `referred to as`, `commonly referred to as`, `often referred to as` | `commonly referred to as "Atlas North"` → `Atlas North` | `referred to as needed` → nothing |
| Former names | `formerly`, `formerly known as`, `previously known as`, `f/k/a`, `fka`, `née` | `Widget Co (formerly Gearbox Labs)` → `Gearbox Labs` | `formerly the head of sales` → nothing |
| Trading names | `trading as`, `t/a`, `doing business as`, `d/b/a`, `dba` | `Quormiro Capital LLC d/b/a Quormiro Partners` → `Quormiro Partners` | — |
| Short names | `short name`, `short for`, `abbreviated`, `abbreviated as` | `Short name: QCAP` → `QCAP` | — |
| Codes | `code name`, `codename`, `account code`, `ticker`, `customer code`, `account ID` | `Account code: QUCO` → `QUCO` | — |
| Alias | `alias`, `aliases` | `alias "Red Kite"` → `Red Kite` | — |
| Calls it (quoted only) | `calls it`, `call it`, `called it` followed by a quoted name | `the team also calls it "Copper Fox"` → `Copper Fox` | `the team calls it a success` → nothing |

## Label and value forms

A label is a short phrase (up to 6 words) that ends in `:` and contains a
label noun: `nickname`, `alias`, `aka`, `also known as`, `short name`,
`trading name`, `trade name`, `brand name`, `former name`, `previous name`,
`legal name`, `display name`, `dba`, `code name`, `codename`, `account code`,
`customer code`, `ticker`. Extra words around the noun are allowed, because
record systems qualify their fields (`Internal nickname:`, `Team alias:`,
`Nickname (sales):`, `Former legal name:`). The value is split on `,`, `;`,
`/` and ` or `, and each part is captured as a quoted name or an unquoted run.

| Form | Positive fixture |
|---|---|
| Prose line | `Internal nickname: Copper Fox` → `Copper Fox` |
| Bold key-value | `- **Aliases:** Copper Fox, CFX` → `Copper Fox`, `CFX` |
| Plain key-value | `trading name: Northwind Ops` → `Northwind Ops` |
| Markdown table row | `\| Nickname \| Copper Fox \|` → `Copper Fox` |
| Markdown table row with qualified label | `\| Former legal name \| Gearbox Labs Inc \|` → `Gearbox Labs Inc` |

A table row qualifies when its first cell is a label (the `:` is optional
there) and its second cell is the value. A header row or a separator row
(`---`) never qualifies.

A label can also open a later sentence of a line, as record exports and
generated sheets often write several fields on one line (`Account: Widget Co.
Nickname used by the team: Copper Fox. Region: EMEA.`). Inside a line the label
must carry the label noun within its first two words and have at most 7
words, so `Account owner: Dana Example` or `Notes from the call: ...` never
qualify; the value ends at the sentence's end.

## Quoted and parenthetical alternate names

Legal drafting and filings introduce a defined short name in parentheses right
after the full name: `Quormiro Capital Holdings, Inc. ("Quormiro")`,
`Acme Example Ltd (the "Company")` (rejected: `Company` is generic),
`Widget Co (“Widget”)`. This form needs the page's own name (title, title
subject or a frontmatter alias) immediately before the parenthesis, optionally
followed by a corporate suffix and a comma, because a bare quoted term in
parentheses elsewhere in a page names many things. A parenthetical cue
(`(aka Blue Harbor)`, `(formerly Gearbox Labs)`, `(d/b/a Northwind Ops)`) is a
prose cue and needs no name.

## Short codes the page declares for itself

A name under 4 characters is kept only as a short code (`src/core/mentions/short-codes.ts`):

- **Shape.** 2 or 3 letters or digits with at least one capital letter: `JOF`,
  `J2`, `3M`, `JoF`. Lower-case words (`it`, `us`, `and`) never qualify.
- **Stoplist.** Capitalized English words and everyday business abbreviations
  never qualify, compared upper-cased (`IT`, `US`, `OK`, `AI`, `HR`, `CEO`,
  `API`, `SSO`, `SOC`, `B2B` and the rest of `SHORT_CODE_STOPLIST`).
- **Own-page declaration.** The page's own body declares it with an alias label
  (`Account code: JOF`, a mid-line `Short name: JOF`, a table row) or with one
  of these cues: `also called`, `a.k.a.` / `aka`, `known as` (with `also`,
  `better`, `widely`), `short for`. Before the cue, its sentence names nothing
  but the page: nothing at all (`Also called JOF in my notes`), a pronoun
  (`It is also called JOF`) or one of the page's own names (`Joffrey Foods,
  a.k.a. JOF`). `Widget Co, also called WCO` on another entity's page declares
  nothing for that page; other cues (`goes by`, `formerly`, `nicknamed`) never
  declare a short code.

A short code is a single token, so it is stored `case_sensitive` and links only
as written, as a whole token: "Call with JOF" links, "jof" does not.

| Positive fixture | Negative fixture |
|---|---|
| `Also called JOF in my notes.` | `Also called IT internally.` (stoplist) |
| `Joffrey Foods (a.k.a. JOF) renewed.` | `Widget Co, also called WCO, is a reseller.` (another entity's sentence) |
| `Account code: J2` | `It goes by JOF.` (cue outside the short-code list) |

## Escape hatches

- Brain config `mentions.alias_deny` (JSON array or comma list) and page
  frontmatter `alias_deny:` remove a derived alias.
- `mentions.multiword_aliases` (default on) limits captures to one token.
- The grammar change bumps `ALIAS_DERIVATION_VERSION` and
  `MENTION_EXTRACTOR_VERSION`, so every brain re-derives once on its next
  `gbrain extract --stale`.

## Out of scope

- Owner-based references ("Dana Example's freight account") need dated
  ownership and are a separate, measured follow-up (`TODOS.md`).
- Names declared only in free prose without a cue ("we just say Copper Fox")
  are not parsed; the entity card's `identity_excerpt` shows such lines
  verbatim instead.

## Changelog

- 2026-10-08: short codes (2-3 characters) the page declares for itself with an
  alias label or an `also called` / `a.k.a.` / `known as` / `short for` cue, with
  a stoplist of common capitals and acronyms. Origin: the Program Primary Hard
  root cause (gbrain-evals#109), where a company page said "Also called JOF in
  my notes" and mails naming "JOF" never linked to the company. The Cat 40 Hard
  development world has no codes under 4 characters, so its derived aliases are
  unchanged (5,690 on its account pages, all correct; 5,770 declared over all
  55,440 documents, none under 4 characters, before and after).

- 2026-10-08: added labels that open a later sentence of a line and the
  quoted-only "calls it" cue. Origin: the Cat 40 Hard development (calibration)
  world, whose account sheets write `Nickname used by the team: X` mid-line and
  `the team also calls it "X"`; both are general record-export and prose forms,
  measured on that development split only (nicknames derived 0 of 2,845 before,
  2,829 of 2,845 after, no false aliases among 5,690 derived on its entity pages).
