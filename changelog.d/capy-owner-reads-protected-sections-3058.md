**The brain owner's own remote credential now reads private fact rows, held rows, graph-hop context and every take holder the way the local CLI does.**

<!-- behavior-change: owner_remote_reads_protected_gst3058 -->

### Fixed
- get_page and fetch give a credential bound to the brain owner, speaking for itself, the Facts fence as stored, and the Takes fence too when the credential carries no holders list. A credential with a list reads takes through takes_list, as before. A segmented page's `view: 'markdown'` now reads for such an owner credential as it does for the local CLI.
- With no holders list, the owner credential reads every holder wherever a read filters takes by holder, among them takes_list, takes_search, takes_scorecard, takes_calibration, search, query, recall, delta, think and synthesize; synthesize now reads world takes only for a non-owner with no list.
- traverse_graph hops give the owner the stored edge context; one with a holders list still skips evidence pages that hold takes.
- Both HTTP transports now give an owner-bound credential with no holders list every holder; every other credential keeps `['world']`.
- With a room declared, the owner credential reads world takes and gated hop text, as before this PR, until GST-3066 marks those operations. Its get_page keeps the Facts rows, and a whole-body read or `view: 'markdown'` whose body carries private or held rows is marked `room_access: {readable: false, reason: 'private_label'}`. The mark is per page. Held rows inside read-view windows and in a holders-list owner's segmented markdown view are not marked, as on master (GST-3066).
- The local CLI's `--room` marks change too: a page whose body carries private rows, held rows or takes is now marked `private_label`.
- Known limit: an owner's edit or delete of a private Facts row through remote put_page does not stick yet (the old row is restored); use the local CLI until the follow-up lands.
