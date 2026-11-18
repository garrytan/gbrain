**The brain owner's own remote credential now reads private fact rows, held rows, graph-hop context and every take holder the way the local CLI does.**

<!-- behavior-change: owner_remote_reads_protected_gst3058 -->

### Fixed
- A direct remote call from a credential bound to the brain owner, speaking for itself with no room declared, reads as the local CLI does. get_page and fetch give it the Facts fence as stored, and the Takes fence too when the credential carries no holders list; a segmented page's `view: 'markdown'` reads as for the local CLI then. A credential with a list reads takes through takes_list, as before.
- With no holders list that call reads every holder wherever a read filters takes by holder, among them takes_list, takes_search, takes_scorecard, takes_calibration, search, query, recall, delta, think and synthesize; synthesize now reads world takes only for a non-owner with no list.
- traverse_graph hops give that call the stored edge context; one with a holders list still skips evidence pages that hold takes.
- Both HTTP transports give an owner-bound credential with no holders list every holder; every other credential keeps `['world']`.
- Every other context reads as before: stdio, on-behalf-of audiences, attested actors, agent jobs and group chats (a declared room), until GST-3066. An agent job now reads its client's stored takes holders list, else world takes.
- With a room declared, a get_page whole-body read or `view: 'markdown'` whose returned body carries rows a world-only read strips is marked `room_access: {readable: false, reason: 'private_label'}`. The mark is per page; held rows inside read-view windows and in a segmented page's markdown view are not marked, as before (GST-3066). The local CLI's `--room` marks a page whose body carries private rows, held rows or takes the same way.
- Known limit: an owner's edit or delete of a private Facts row through remote put_page does not stick yet (the old row is restored); use the local CLI until the follow-up lands.
