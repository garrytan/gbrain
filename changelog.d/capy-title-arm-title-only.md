**Local searches on a very common word no longer spend the keyword time limit in the title step.**

### Fixed
- The title step of hybrid search now matches and ranks page titles only for local callers too, as it already did for remote callers. Before, a local search also matched the page's timeline there, so a word that sits in many timelines made the title step read all of them and run into the 8 s keyword statement limit on a large brain, a second time after the keyword step (#7082). Pages whose timeline holds the words are still found by keyword search, which searches timeline text.

<!-- behavior-change: title_arm_title_only_7082 -->
