# Brain Routing Convention

Cross-cutting rules for which brain and which source an operation targets.
Applies to every skill that reads or writes brain pages. **Full mental model
lives in `docs/architecture/brains-and-sources.md` — read it once.**

## The two axes (one-line summary)

- **Brain** = which DATABASE. `--brain`, `GBRAIN_BRAIN_ID`, `.gbrain-mount`.
- **Source** = which REPO INSIDE the database. `--source`, `GBRAIN_SOURCE`,
  `.gbrain-source`.

Orthogonal. Pick one on each axis per operation.

## Default behavior (ALWAYS)

Start in the brain + source resolved by the environment:

1. Run `gbrain mounts list` if you haven't seen the user's mounts yet.
2. Trust the resolver. If the user is in `~/team-brains/media/`, their
   `.gbrain-mount` pins brain=media-team. Don't override that silently.
3. For every brain op, pass the resolved brain id explicitly when calling
   tools (even if it matches the default). Makes routing visible in logs.

Bare `gbrain query "X"` routes to the default brain's default source. That
is the right answer 90% of the time. Don't cross the boundary without a
reason.

## When to switch brain

Switch brain (`--brain <id>`) when:

- The user's question is specifically about a team the user belongs to
  ("what did team X decide?", "what's the status of project Y at team X?").
  Switch BEFORE searching, not after a failed search in host.
- The user is asking you to ingest data that belongs to a specific team
  (meeting notes from a team meeting, letters from a team's pipeline). The
  data owner determines the brain.
- The user explicitly names a team/brain ("check the media-team brain
  for...").

Do NOT switch brain when:

- The user asks a general question that might pull from anywhere. Start in
  host, then cross-query on-demand if host doesn't have it.
- You're unsure. Stay in host, surface what you found, let the user point
  you at a specific brain.

## When to switch source

Switch source (`--source <id>`) when:

- The user is working in a specific repo (the `.gbrain-source` dotfile
  usually handles this — don't fight it).
- The user asks about something scoped to a repo ("what's in my gstack
  notes about retry policy?").
- You're writing a page that logically belongs to one repo. The data
  origin determines the source.

Do NOT switch source when:

- The user's intent crosses repos. Keep `federated=true` sources for
  cross-source search.
- You'd lose a cross-repo match by isolating.

## Cross-brain queries (latent-space federation)

v0.19 does NOT do deterministic cross-brain federation. No SQL fan-out. No
unified ranking. The AGENT federates.

Pattern when the user asks something that might span brains:

1. Query host with the obvious query.
2. Check `gbrain mounts list` for relevant brain ids.
3. If you think another brain has the answer, re-query THAT brain
   explicitly (`--brain <id>`).
4. Synthesize across results. Cite `<brain>:<source>:<slug>` so the user
   can trace.

Never silently mix brains. Every finding is citable to its brain.

## Writing across brains

Writing is stricter than reading. ASK before writing cross-brain.

- A fact about a team's work → team's brain, not host.
- A fact the user confirmed about a person ONLY they know → host/personal,
  not a team brain.
- An enrichment discovered from public data → usually host unless the user
  says otherwise.

If you're about to `put_page --brain <team-brain>`, confirm with the user
unless they explicitly said "save this to team-X". Default brain for
writes is the user's personal brain.

## Citations with brain context

Standard citation format stays the same (`[Source: ...]`), but when pages
come from a mounted brain, add the brain context for human traceability:

- Single-brain query: `[Source: Meeting, 2026-04-10]` (unchanged).
- Cross-brain synthesis: `[Source: media-team:meetings/2026-04-10]` or
  `[Source: policy-team:research/retry-budgets]`.

This matches v0.18.0's source-aware citation (`[source-id:slug]`) extended
with a brain prefix when relevant.

## Decision table

| Situation | Brain | Source |
|---|---|---|
| User cd's into a team-brain checkout and asks a general question | dotfile-resolved team brain | dotfile-resolved source |
| User asks "what did team X decide?" | `team-x` explicitly | resolver default |
| User asks "what are we doing across all teams?" | fan out across mounts, agent-driven | resolver default |
| User asks "add this to my gstack notes" | host | `gstack` |
| User asks "save this meeting note for team X" | `team-x` (confirm if ambiguous) | team's meetings source |
| User asks "write me an essay" | host (personal) | `essays` |
| Unknown — can't classify | stay in host, ask the user | resolver default |

## Anti-patterns

- Silently jumping brains to "find" an answer when the user clearly meant
  host. That's an audit-trail hole.
- Writing to host when the data is clearly team-owned ("the team's plans
  are now in your personal brain" = bad surprise).
- Cross-brain federation in a single query without citations that name the
  source brain. The user cannot trace the answer back.
- Ignoring `.gbrain-mount` / `.gbrain-source` dotfiles. They're load-bearing
  context — the user set them up for a reason.

## Read more

- `docs/architecture/brains-and-sources.md` — the full mental model with
  topology diagrams (single-person, personal-with-repos, CEO-class with
  multiple team brains).
- `skills/conventions/brain-first.md` — reads the brain BEFORE asking.
- `skills/conventions/quality.md` — citation format (extended here with
  brain prefix).
