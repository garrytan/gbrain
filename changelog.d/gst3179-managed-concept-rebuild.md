**Brains whose writes go through the write owner now rebuild a concept that a purge hid, and the write owner checks nothing changed before it writes.**

### Fixed
- On a brain with a write owner, the purge that removes a hidden concept now checks, inside the write owner's own transaction, that the page is still hidden at the same moment and that nobody wrote anything on it since. If either check fails, the page is left alone.
- The rebuilt concept is published only if every note it was built from is still there at the version synthesis read. Otherwise nothing is written, and the next synthesis run tries again.
- On brains with a write owner, links from other pages to a rebuilt concept come back as new links at the cycle's next link extraction; they are not carried over with their old details.
- On brains without a write owner, the rebuilt concept's derivation links are written in the same transaction as the page.
- The rebuild's purge travels as its own kind of maintenance request, so a write owner on an older gbrain refuses the rebuild until it is upgraded, instead of purging without these checks.
- A secret recorded on a hidden concept keeps it hidden unless another copy sits on a live page or in a commit, so a rebuild never leaves the only copy on a deleted page.
- A failed read of the held-concept list no longer stops the purge preview or the cycle. It logs a warning and reports nothing held.
