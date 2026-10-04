---
name: brain-link-discipline
version: 1.0.0
description: |
  When you report a brain page to the user — created, edited, committed, or
  relayed from a subagent — a working link is part of the deliverable, in the
  SAME message. Derive the path mechanically (git ls-files --full-name), push
  BEFORE linking, verify the link resolves when a hosted remote exists, and
  degrade through a defined fallback chain when it doesn't. Inside brain
  pages the rule inverts: relative links preserve the link graph; absolute
  URLs are for chat deliverables only.
triggers:
  - "give me the link"
  - "where is the page"
  - "why does this link 404"
  - "brain link discipline"
  - "rewrite subagent paths"
  - "report the pages you created"
  - "send me a clickable link"
  - "link the page in the same message"
mutating: true
writes_pages: false
upstream: brain-link-on-commit@fc834ee + brain-link-report@fc834ee
# brain_first: exempt — this skill governs outbound-message link formatting
# and performs no entity/fact lookups. Its only network call is an HTTP
# existence check against the user's own hosted git remote (link
# verification, not data retrieval). Declarative opt-out.
brain_first: exempt
---

# brain-link-discipline — The Link Is Part of the Deliverable

> **Convention:** see [_output-rules.md](../_output-rules.md) — the
> Deterministic Links section carries the cross-skill canon (in-page relative
> vs in-message verified, plus the fallback chain). This skill carries the
> mechanics: path derivation, push-before-link ordering, verification, the
> subagent-relay rewrite, and bulk-list formatting.
>
> **Convention:** [conventions/brain-first.md](../conventions/brain-first.md)
> states the one-line principle ("every brain page reference in output should
> use a clickable link format appropriate to the deployment"). This skill is
> that line's full expansion.

This is a reporting convention the harness routes brain-page delivery
messages through — a standing rule to apply when composing such messages,
not a mechanical guarantee enforced by tooling.

## The rule (same message)

If you commit and push a brain page, the link goes in the SAME message that
reports the work. Every time. No "let me commit and push" without the link
landing in that same reply once the push succeeds. The user should never
have to ask "give me the link" or "where is the page."

This applies to:

- Any message reporting a created or edited brain page
- Bulk reports ("5 pages created" — every page gets its own link line)
- Referencing a brain page in normal conversation
- Relaying subagent results that mention brain paths (rewrite first — see below)

The most common link bug is committing a brain page and forcing the user to
go find it. The link is a deliverable, not a follow-up.

## Scope split: in-message vs in-page (the inversion)

The two output surfaces take OPPOSITE link forms:

| Surface | Link form | Why |
|---|---|---|
| Chat message to the user | Absolute, verified URL (or the fallback chain below) | Repo-relative paths aren't clickable in chat surfaces |
| Inside a brain page body | RELATIVE markdown link: `[Alice Example](../people/alice-example.md)` | gbrain's link extraction builds the links/backlinks graph — which powers relational retrieval — from filesystem-relative links. An absolute URL between two brain pages is invisible to that graph |

**Never write absolute URLs for page-to-page references inside a brain
page.** Absolute URLs in a page body are for genuinely external targets
only. Frontmatter `related:` / `people:` keys stay bare relative paths
(machine-parsed, not rendered prose). After a link-heavy write,
`gbrain check-backlinks check` audits the graph and `gbrain sync --no-pull`
makes the pages searchable.

## Deriving the path mechanically

The repo-relative path a hosted git remote serves is relative to the **git
repo root** (`git rev-parse --show-toplevel`), NOT your current working
directory. When the repo root sits above your working directory, hand-
stripping your cwd prefix silently drops the intermediate directory segment
and every link you build 404s. Never hand-strip a prefix. Derive:

```bash
# From anywhere inside the repo, prints the EXACT path the remote serves:
cd "$(dirname <file>)" && git ls-files --full-name "$(basename <file>)"
# e.g. people/alice-example.md
```

Then assemble:

```
https://<host>/<owner>/<repo>/blob/<branch>/<that-exact-path>
```

- `<host>/<owner>/<repo>` from `git remote get-url origin`
- `<branch>` from `git rev-parse --abbrev-ref HEAD` (or the remote's default branch)
- `/blob/` for files, `/tree/` for directories (GitHub-style hosts)

## Sequence (push BEFORE link)

1. Write/edit the brain file.
2. `git add <file> && git commit -m "..." && git push`
3. **Verify the push landed** — the push output must show the ref update
   (e.g. `abc123..def456  main -> main`). A hosted URL 404s until the push
   completes.
4. **In the SAME message that reports the commit, output the link** — as a
   clickable markdown link or bare URL, never a backticked code span.

## Verify before linking (when a hosted remote exists)

Before including a hosted-remote link in a user-facing message, confirm the
path exists on the remote. GitHub example (private repos need a token):

```bash
curl -sf -o /dev/null -w '%{http_code}' \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/contents/<repo-relative-path>"
```

Only send the link on `200`. If you just pushed and the host API is lagging,
the push output proving the ref moved is sufficient evidence — but never
invent or guess a URL.

**Send the token only to its issuing host.** The `Authorization: token` header
above targets `api.github.com` because the remote is a github.com remote. Never
send `$GITHUB_TOKEN` to a host you derived from `git remote get-url origin`
without confirming it is the token's issuing host: a doctored or unexpected
remote (`origin` pointed at an attacker's host, an enterprise/self-hosted host
the token isn't scoped to) would harvest the credential. For a github.com
remote, use `api.github.com`. For any other remote, verify UNAUTHENTICATED (a
public-repo existence check needs no token) or skip verification and fall back
to the ref-update evidence from the push. When in doubt, don't send the token.

## Fallback chain (in order)

1. **Hosted git-remote URL (verified).** The brain repo has a remote on a
   host that renders files → build and verify as above.
2. **Repo-relative path + scope note.** No hosted remote (the default PGLite
   brain often has none, or the repo is local-only) → give the repo-relative
   path (`people/alice-example.md`) and say plainly that it's a local path
   in the brain repo.
3. **`gbrain publish` output as an attachable HTML ARTIFACT.** `gbrain
   publish <page-path>` emits a self-contained LOCAL HTML file (its output
   line is `Published: <local-path>`). Offer to attach or send that file —
   NEVER present it as a URL, because it isn't one. Use `--password` for
   sensitive content.

## Subagent-relay rewrite rule

Subagents run in local context and return LOCAL paths. Relaying a subagent
completion verbatim is the #1 source of link bugs: the subagent reports
`media/books/widget-co-notes.md` (or an absolute path into the brain
checkout) and the relay parrots it. Before converting a subagent completion
into a user-facing reply, rewrite every brain-page path through the same
derivation + fallback chain above.

When spawning subagents that will write brain pages, include in their task
prompt:

> Report brain pages as repo-relative paths from `git ls-files --full-name`.
> The parent rewrites them into links before relaying.

## Bulk lists

One link per line, full URL (or fallback form), no backticks:

```
Created 3 pages:
- https://github.com/<owner>/<repo>/blob/main/people/alice-example.md
- https://github.com/<owner>/<repo>/blob/main/people/charlie-example.md
- https://github.com/<owner>/<repo>/blob/main/companies/acme-example.md
```

## Scope note: links resolve for repo members only

Hosted-remote links into a private brain repo open only for people with
repo access. That's fine for the user's own chat surface; it is NOT a
shareable link for an outside audience. For outside sharing, fall through
to the `gbrain publish` artifact (step 3 of the fallback chain).

## Contract

This skill guarantees:

- Every outbound message reporting a brain-page write carries the link (or
  fallback form) in that same message — the user never has to ask.
- Links are built mechanically from git data (`git ls-files --full-name`,
  `git remote get-url origin`), never composed from memory.
- No hosted URL is sent before the push lands; verification (or ref-update
  evidence) precedes the link.
- Subagent relays are rewritten before delivery.
- In-page cross-references stay relative, preserving the links/backlinks
  graph.
- Routing matches the canonical triggers in the frontmatter.
- Privacy contract preserved: no real names, no fork-specific filesystem
  path literals, no upstream-fork references.

## Output Format

Hosted remote (verified):

> Done — pushed.
> https://github.com/<owner>/<repo>/blob/main/concepts/widget-co-pricing.md
>
> Changes committed ([abc1234](https://github.com/<owner>/<repo>/commit/abc1234)):
> - concepts/widget-co-pricing.md (edit) — reworked the pricing section

No hosted remote (fallback steps 2–3):

> Saved `concepts/widget-co-pricing.md` in the brain repo (local path — this
> brain has no hosted remote). Want a shareable HTML render? I can generate
> one with `gbrain publish` and attach the file.

## Anti-Patterns

- ❌ "Committed and pushed." — no link.
- ❌ "The page is live at `/absolute/local/path/...`" — local absolute path
  instead of a link or repo-relative fallback.
- ❌ Committing, then waiting for the user to ask for the link.
- ❌ Relaying a subagent result containing local brain paths verbatim.
- ❌ Outputting hosted URLs BEFORE `git push` has landed (they 404 until the
  push completes — push first, verify the ref moved, then link).
- ❌ Presenting `gbrain publish` output as a URL. It emits a local HTML file
  path; offer it as an attachable artifact.
- ❌ Hand-stripping a cwd prefix to build the repo-relative path. Use
  `git ls-files --full-name`.
- ❌ Absolute URLs for page-to-page references INSIDE a brain page — breaks
  the links/backlinks graph that relational retrieval depends on.
- ❌ Backticked paths in chat where a clickable link was possible.
- ❌ Guessing or reconstructing a URL from memory.

## Dedup (sharp boundaries)

- `skills/publish/SKILL.md` — owns HOW to generate a shareable HTML
  artifact (stripping, encryption, output options). brain-link-discipline
  only decides WHEN to fall back to it, and forbids promising its output as
  a URL.
- `skills/_output-rules.md` (Deterministic Links) — carries the cross-skill
  CANON: deterministic construction, the in-page/in-message scope split, the
  fallback chain. This skill carries the per-message MECHANICS: derivation,
  ordering, verification, relay rewriting, bulk formatting.
- `skills/conventions/brain-first.md` — states the one-line clickable-link
  principle inside the lookup convention; this skill is its expansion for
  delivery messages.
- `skills/conventions/subagent-routing.md` — how to route work to
  subagents. This skill adds the path-rewrite obligation at the relay
  boundary; subagent-routing says nothing about link/path rewriting.
- `skills/citation-fixer/SKILL.md` — fixes broken citations INSIDE existing
  brain pages. Not about outbound message links.
- `skills/reports/SKILL.md` — saves/loads report pages. When a report
  delivery message references brain pages, that message follows this
  discipline; the reports skill itself carries no link rules.
