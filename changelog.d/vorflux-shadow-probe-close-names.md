**The shadow-off cost test no longer fails on a busy machine.**

### Fixed
- The test that checks shadow mode off adds no database statements compared two runs by the exact name of each cached statement they closed. A busy machine could change which earlier statements were cached, so the names differed even when every statement sent was the same, and the test failed about half the time under load. The test now renames closed statements the same way it already renamed prepared ones, so it fails only on a real difference in what is sent.
