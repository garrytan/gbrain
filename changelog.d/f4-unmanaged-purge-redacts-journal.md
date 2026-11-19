**The automatic purge on a brain without a write owner now removes a purged page's text from the write journal, including writes made while the brain had a write owner.**

### Fixed
- When a brain that once ran with a write owner purges an expired page without one, the journal entries it wrote for that page are now redacted in the same transaction. Before, their stored request still held the page's text after the page itself was gone. Both expiry paths are covered, with and without the belief ledger. An explicit `gbrain delete --purge` already did this.
