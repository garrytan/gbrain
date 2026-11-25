**Link extraction and the mention pass use less CPU and find exactly the same links and mentions.**

### Changed
- Hiding already-matched link text before the next link pattern runs now copies whole slices of the page. It used to rebuild the page one character at a time. On a 10,000-page test brain this step went from about 184 ms to 6 ms.
- The mention pass now splits a page into words in one pass instead of two. On the same brain this step went from about 706 ms to 423 ms. Tokens, offsets and lengths are unchanged.
- Nothing to do on upgrade. A new parity test compares both helpers with the old code on thousands of mixed-script texts.
