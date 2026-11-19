**The automatic purge on a brain without a write owner now removes a purged page's text from the write journal, including writes made while the brain had a write owner.**

### Fixed
- When a brain that once ran with a write owner purges an expired page without one, the journal entries written for that page are now redacted in the same transaction. Before, their stored requests, and the text of the page's timeline entries, stayed in the journal after the page was gone. All three ways such a brain hard-deletes a page are covered: the bulk expiry, the per-page expiry under the belief ledger, and a concept rebuild that replaces a held concept. Journal entries of other pages that quote the purged page are still swept only by an explicit `gbrain delete --purge`.
