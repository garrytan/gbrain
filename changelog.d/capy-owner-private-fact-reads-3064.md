**The brain owner's remote credential now reads an inline page's private fact rows in get_page `as_of` the same way get_page and fetch show them.**

<!-- behavior-change: owner_private_fact_reads_gst3064 -->

### Fixed
- A direct remote call from a credential bound to the brain owner, speaking for itself with no room declared, now gets the Facts fence as stored from get_page `as_of` on an inline page, and the Takes fence too when it carries no holders list. Before, that read dropped the private rows that get_page and fetch show the same caller, while returning the same revision.
- get_page, fetch, the segmented markdown view and `as_of` on inline pages now share one rule for what the owner reads in a page body. Members, unbound tokens, agent jobs and room-declared reads read as before.
- Known limit: `known_as_of` (on get_page and get_versions) still reads the stored markdown without the owner's private rows and without the withdrawal overlay, as before; a segmented `as_of` edition still pages through the read view.
- Known limit, unchanged: an owner's edit or delete of a private Facts row through remote put_page does not stick yet (the stored row is kept beside the edit); use the local CLI until the follow-up lands.
