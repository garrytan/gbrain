**On a new brain, the first-session suggestion now lists the conversations setup just imported.**

### Fixed
- The "Recent pages in the brain" list in the first-session suggestion read only the source the session is bound to, while `gbrain setup`'s history import writes conversations into their own federated source (`conversations`). On a fresh install the list was always empty. It now reads the bound source and the sources it federates with, the same set the agent's unqualified searches read; a source set to `federated: false` still lists only its own pages. Agent policy and action records and the archive's per-day index pages are left out, so the three pointers are conversations or notes worth offering.
