**Every agent you connect can now read your sizes, diet, allergies and constraints in one call.**

### Added
- `remember` takes a `facet` (`size.<item>`, `brand`, `diet`, `allergy`, `style`, `constraint`, `schedule`, `household`, `other`). With no `entity`, the fact goes on your own profile: `memory/owner` on a single-user brain, the owner's entity for the brain owner, a member's own member page for a member credential. Allergy facts are private unless you name a visibility.
- `context_pack {profile: true}` returns your profile as one block (facets, constraints, relationships from your page's links, unfaceted preferences and a withheld count), read at the caller's scope and packed into `budget_tokens`. `gbrain profile [--json]` prints it, on a local brain or a thin client.
- Guide: `docs/guides/profile.md`.

### Changed
- The claim metric prefix `profile.` is reserved: a hand-written one is refused (`profile_metric_reserved`), an unknown facet is refused with the list (`profile_facet_unknown`), a member cannot save a profile fact on another page (`profile_entity_not_self`), and extracted facts never carry it. `find_trajectory`, `gbrain eval trajectory` and the founder scorecard skip profile facts.

<!-- behavior-change: portable_profile_core_p1 -->
