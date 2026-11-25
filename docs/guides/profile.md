# Your portable profile

Your profile is what your agents should know about you before they shop, book or plan for you: sizes, diet,
allergies, brands, style, hard constraints, schedule and household facts. GBrain keeps it as ordinary facts on your
own page, so every connected agent reads the same profile with one call, and nothing about it needs a git
repository or an API key.

## Save a profile fact

Save it with `remember` and a `facet`. With no `entity`, the fact goes on your own profile.

```bash
gbrain remember "Allergic to peanuts" --facet allergy --provenance "told me, 2026-11-25"
gbrain remember "Shoe size 10 US" --facet size.shoe --provenance "told me, 2026-11-25"
```

Over MCP it is the same call: `remember {fact: "Eats vegetarian", facet: "diet", provenance: "..."}`.

A `remember` without `facet` works exactly as before: it is never moved onto your profile.

## Facets

| Facet | For |
|---|---|
| `size.<item>` | a size, e.g. `size.shoe`, `size.shirt` (the item is lowercase letters, digits, `-` or `_`) |
| `brand` | brands you buy or avoid |
| `diet` | what you eat |
| `allergy` | allergies; saved private unless you pass `visibility` or `share` |
| `style` | taste in clothes, design, writing |
| `constraint` | hard limits an agent must respect ("no red-eye flights") |
| `schedule` | standing times ("school pickup at 3pm on weekdays") |
| `household` | facts about the household as a whole |
| `other` | anything else |

The facet becomes the fact's typed claim metric, `profile.<facet>`. That prefix is reserved: a hand-written
`claim_metric: "profile.diet"` is refused (`profile_metric_reserved`, with the same call using `facet` as the fix),
an unknown facet is refused with the list (`profile_facet_unknown`), and facts extracted from conversations never get
one. A facts-fence row keeps a `profile.<facet>` metric only on the profile's own page or, for `memory/owner` or a
member page, the holding page `remember` would put it on; anywhere else the row is kept without a metric. Profile facts are not metrics, so `find_trajectory`, `gbrain eval trajectory` and the founder scorecard skip
them.

## Who a profile belongs to

- On a single-user brain, your profile lives on `memory/owner` (or on your own person page when one carries your
  email). When it is your person page, profile facts are saved in that page's source and read from it, whatever source
  the call starts in. A credential that cannot write that source is refused (`permission_denied`, naming the source)
  instead of saving the fact where the profile never reads it, and passing another `source_id` with `facet` is refused
  (`profile_entity_not_self`).
- The brain owner's profile is the owner's entity, the one `gbrain identity` names. The trusted local CLI and a
  credential bound to the owner (`gbrain access owner set`) read and write it. The read also covers `memory/owner`
  and the owner member's page, so facts saved before you named an owner or matched a person page stay in the profile.
- A member credential's profile is its own member page, `memory/members/<member>`. A member never writes a profile
  fact onto another page and never reads the owner's profile: `remember` with `facet` and another `entity` is refused
  (`profile_entity_not_self`), and a member CLI under `GBRAIN_ENFORCED_MEMBER` cannot pass `facet` at all.
- A credential that is neither the owner nor a member (one asserting an audience, or an unbound credential on a brain
  with members) has no profile: its read returns `entity: null` and its facet writes are refused.

The owner can still save a faceted fact about someone else, such as a child's shoe size, by naming that person's page
as `entity`.

## Read it

```bash
gbrain profile            # readable summary
gbrain profile --json     # the block as JSON
gbrain profile --budget-tokens 400   # pack into 400 tokens; the rest is counted as withheld
```

An agent calls `context_pack {profile: true}` (add `budget_tokens` to cap it). The response's `profile` block has:

- `entity`: your page's slug and how it was found (`basis`), never the email or account that identified you; the slug
  is `null` when your page is in a source this credential cannot read;
- `constraints`: `allergy` and `constraint` facts;
- `facets`: every other faceted fact;
- `preferences`: facts on your page saved with `kind: preference` and no facet;
- `relationships`: your page's typed links, with the line each came from;
- `withheld`: how many rows were left out: those that did not fit `budget_tokens`, plus, for an unbound credential on a
  brain with no members, the owner's private profile facts it cannot read (see below).

Each fact carries `fact_id`, `claim`, `provenance`, `content_origin`, `valid_from`, `visibility` and `confidence`.
Facts you stated yourself (`content_origin: user_said`) come first, then the newest. Every row is read at the
caller's own scope before anything is packed, so a member never learns a count of the owner's facts.

On a brain with no members, a remote credential bound to nobody speaks for the owner: its facet writes land on your
profile. It still reads world-visible facts only, so a private fact such as an allergy is saved but not read back by
that credential. Private facts stay private. Instead, `remember` adds a `profile_private_hidden` notice, and
`context_pack {profile: true}` counts those facts in `withheld` and adds the same notice and a `[notice]` line, so an
agent never reads a missing allergy as none. To let that agent read them, add yourself as a member, name yourself the
owner and bind the credential: `gbrain access member add <you>`, `gbrain access owner set <you>`, then
`gbrain auth rescope --token <name> --member <you>`.
The same block is rendered into the pack's `text` under its own heading, one labelled line per row: it is data about
you, not instructions. The read makes no model call.

## Import

`gbrain profile import` moves what another assistant remembers about you onto your own profile. It reads three formats
(`--format auto` picks one):

- `muse-memory`: a Markdown list such as Muse's `Memory.md`; a heading like `## Allergies` or `## Food` names the facet of
  the bullets under it;
- `claude-memories`: the memories JSON in a Claude data export (a list of memories, or `{"memories": [...]}`);
- `memory-text`: the `[YYYY-MM-DD] - memory` list an assistant prints when you ask it to list what it remembers about
  you; the date becomes the fact's `valid_from`.

```bash
gbrain profile import Memory.md                          # preview: what would be saved, and a hash
gbrain profile import Memory.md --yes --preview <hash>   # save exactly that preview
gbrain profile import --status <receipt>                 # what an apply saved, line by line
gbrain profile import --resume <receipt>                 # finish an apply that stopped
```

The preview saves nothing. It lists each fact with its line and facet, and names each dropped line by number: a line
that looks like a password, key or token is never saved or printed, a line over 2,000 characters is skipped, and so is
a line that is not a list item (in `memory-text`, not a dated memory or a list item). A date that is not a real
calendar date is left off its fact. In `claude-memories`, a plain sentence under a heading is a fact too. The hash covers the file,
how it was parsed, your profile, the credential doing the import and, locally, the brain and source it writes to, so the apply refuses with `preview_changed` if any
of them changed since the preview; preview again and apply the new hash. Scripts and agents pass `--yes --preview
<hash>`; nothing prompts. The printed apply and resume commands repeat `--brain` and `--source` when you passed them.
Locally, `--source <id>` picks the source the facts are saved in. A thin client refuses `--brain` and `--source`: the
remote brain saves them in the source your credential is granted. A file that is not valid JSON is refused before
anything is sent; the same words under two headings are kept once per facet.

Every imported fact is saved through `remember`, 20 at a time, as `content_origin: inferred` and `visibility: private`,
with provenance `imported from <file> (<format>), preview <hash>`. It lands on your own profile: the owner's page for the
owner, your member page for a member credential. A member can never import onto the owner's profile. An import never
replaces a fact you stated yourself (`user_said`), with or without a facet; a line that repeats a saved fact comes back as a
duplicate.

The apply keeps a receipt (`profile-imports/<hash>.json` in your gbrain config folder, readable only by you) with each
line's result. Running the same apply again, or `--resume` after it stopped, sends only what was never saved, and first
checks any write still finishing. A batch the brain refuses for its lines is recorded as failed lines and the import
moves on to the next batch. A line that failed is listed and not retried: fix it in the file, then preview and
apply again. The import exits 10 while writes are still finishing and 1 if anything failed or was left unsent.
