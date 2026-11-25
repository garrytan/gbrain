**The mention pass matches names about three times faster on brains with many names that share a first word.**

### Changed
- The mention pass (`gbrain extract --stale` and the upkeep that runs it) finds the same mentions with less work. Before, it ran the Korean and Japanese name-boundary checks for every name that shares a first word with the text, even names that did not match there. Now it compares the rest of the name first, and it works out once per page whether a name is written only in Hangul or only in Katakana. On a 10,000-page test brain where 3,000 names share a first word, matching every page went from about 3.7 s to 1.2 s. Nothing to do on upgrade.
