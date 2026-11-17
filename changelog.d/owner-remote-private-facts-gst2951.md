**The brain owner's own remote agents now get the owner's private facts from trajectories, ontology reads and write attribution, as they already did from recall, query and think.**

<!-- behavior-change: owner_remote_fact_ops_gst2951 -->

### Fixed
- `find_trajectory`, `ontology_get`, `ontology_conflicts` and `volunteer_chronicle` decided fact visibility from the raw remote flag, so a credential bound to the brain owner got world facts only and a trajectory built from private facts came back empty. They now use the same owner rule as recall and think. `get_write_attribution` finds a private fact for the owner's admin credential the same way.
- The owner also gets facts taken from a private page it can read on the ontology reads and in write attribution, as `find_trajectory` and recall already allowed.
- A newer observation from a diary page no longer hides the older value behind it on `ontology_get` and `volunteer_chronicle`, and no longer makes a false conflict on `ontology_conflicts`. Diary observations are left out before each value resolves, for every remote caller, and still never reach one.
- Nothing widens for anyone else: another member, a labelled-only member, an unbound token, a call with no credential and the owner speaking for an audience of several read no private fact they did not read before. Page rules, member access and source grants still apply to the owner, and withdrawn facts stay out of every read.
