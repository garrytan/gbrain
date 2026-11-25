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
one. A facts-fence row keeps a `profile.<facet>` metric only on the profile's own page or the holding page `remember`
would put it on; anywhere else the row is kept without a metric. Profile facts are not metrics, so `find_trajectory`, `gbrain eval trajectory` and the founder scorecard skip
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

- `entity`: your page's slug and how it was found (`basis`), never the email or account that identified you;
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
