**Every agent you connect can now read your sizes, diet, allergies and constraints in one call.**

### Added
- `remember` takes a `facet` (`size.<item>`, `brand`, `diet`, `allergy`, `style`, `constraint`, `schedule`, `household`, `other`). With no `entity`, the fact goes on your own profile: `memory/owner` on a single-user brain, the owner's entity for the brain owner, a member's own member page for a member credential. Allergy facts are private unless you name a visibility.
- `context_pack {profile: true}` returns your profile as one block (facets, constraints, relationships from your page's links, unfaceted preferences and a withheld count), read at the caller's scope and packed into `budget_tokens`. `gbrain profile [--json]` prints it, on a local brain or a thin client.
- On a brain with no members, an agent you connected without binding it to you saves profile facts on your profile but cannot read the private ones (allergies) back. They stay private, and that agent is now told so: `remember` and `context_pack` add a `profile_private_hidden` notice naming `gbrain access owner set`, and `withheld` counts the hidden facts, so a missing allergy never reads as none.
- When your profile is your own person page, profile facts are saved in and read from that page's source, so a fact saved from another source is never lost from the profile; a credential that cannot write that source is refused instead.
- Guide: `docs/guides/profile.md`.

### Changed
- The claim metric prefix `profile.` is now reserved for profile facts. A hand-written one is refused (`profile_metric_reserved`), an unknown facet is refused with the list (`profile_facet_unknown`), a member cannot save a profile fact on another page (`profile_entity_not_self`), a member CLI under `GBRAIN_ENFORCED_MEMBER` cannot pass `facet`, and extracted facts never carry it. A Rust brain refuses the profile up front (`engine_capability_missing`). `find_trajectory`, `gbrain eval trajectory` and the founder scorecard skip profile facts.

<!-- behavior-change: portable_profile_core_p1 -->
