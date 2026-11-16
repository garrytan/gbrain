---
important: security
---
**A remote `remember` that restates a confirmed private fact as world is now stored private until the brain's operator accepts it, as page writes to that fact's own page already were.**

<!-- behavior-change: remember_restated_private_hold_2875 -->

### Fixed
- A remote caller that remembered the exact claim of a private fact on the same entity, more trusted than itself, got a new world copy that every other connected client could read, so an agent that knew a private claim could publish it. The new fact is now stored private with a trust proposal that carries the widening; `gbrain trust review` lists it and `gbrain trust confirm tp<N>` makes it world. Remembers with no private copy on that entity, with a world copy already present, or with an explicit private visibility are unchanged.
