# Prior art and source provenance

## Credit

Credit to [praggybuilds](https://github.com/praggybuilds) for the community
[`hermes-gbrain-pointer`](https://github.com/praggybuilds/hermes-gbrain-pointer)
provider, [GBrain issue #6216](https://github.com/garrytan/gbrain/issues/6216),
and its documentation of profile-scoped credentials and context-preserving
background work. The community provider's catalog submission is
[Hermes #134204](https://github.com/NousResearch/hermes-agent/pull/134204).
This draft does not claim to originate the Hermes-native GBrain provider idea.

## Bounded comparison

The review compared the original supplied draft's integration files and the
published GBrain candidate `1db67090d821d5a5ad7e1b25498b39004c872444` with
community commit `8a033c30382dc7a9869c8649293be3e65f9cc7b6`:

- [Community implementation](https://github.com/praggybuilds/hermes-gbrain-pointer/blob/8a033c30382dc7a9869c8649293be3e65f9cc7b6/__init__.py)
- [Community README](https://github.com/praggybuilds/hermes-gbrain-pointer/blob/8a033c30382dc7a9869c8649293be3e65f9cc7b6/README.md)
- [Community license](https://github.com/praggybuilds/hermes-gbrain-pointer/blob/8a033c30382dc7a9869c8649293be3e65f9cc7b6/LICENSE)

No substantial distinctive copied or adapted source block was identified in
that comparison. Small overlaps were ordinary Python or standard-library
patterns, including imports, logging, a dataclass declaration, and refusing an
HTTP redirect. An additional parent-run comparison of whitespace-normalized,
nonblank source lines against both the original bundle and the published
candidate found no substantial verbatim block.

The community implementation is a read-only pointer-search provider; this
draft separates its HTTP MCP client and includes context-pack/delta handling,
explicit memory tools, and opt-in capture. Those differences are not proof of
independent authorship. The original automated drafting/research history was
not available, and this was not an exhaustive origin analysis of every file or
every historical revision. It must not be summarized as “zero reuse proved.”

## License handling

The inspected community project carries the MIT License, copyright
`(c) 2026 praggybuilds`. Its copyright and permission notice must be retained
when copying or substantially adapting its source. This bounded review did not
identify a copied component to attribute as such; the prior-art credit above
is explicit regardless. If later work incorporates community code, identify
the derived files/sections and retain the applicable complete MIT notice in
the distributed package. Do not substitute a link or design acknowledgment for
required source-license notices.
