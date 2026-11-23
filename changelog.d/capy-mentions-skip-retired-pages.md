**The mention pass records why it stopped and keeps draining on a large source, and mention links no longer land on pages merged into another page.**

<!-- behavior-change: mention_pass_bounded_gst3609 -->
<!-- behavior-change: mentions_skip_retired_pages_gst3609 -->

### Fixed
- A throw or an abort inside the mention pass (alias refresh, name-list save or reconcile) now leaves the source's mention index status `failed` with the step and the error, instead of a silent `pending`. The next pass that finishes clears it.
- The scan for pages naming a newly added name now stops at half the time left in the run. The name list is still saved, and the pages it did not reach are marked for the reconcile, which drains them in resumable batches. Before, the scan had no time limit, so on a large source it could use every run and nothing drained. A run with no time left skips the scan and still writes its status, and a source whose changed name list it could not save stays `pending` and keeps its last pass time.
- A page marked `merged_into`, `superseded_by` or `canonical: false` (or with a status naming it an alias or redirect) is left out of the mention name list, so its title, aliases and X handle stop collecting mentions. Text naming that person or company links to the page that claims the name instead, and the next mention pass moves existing mention links off the retired page. Before, the retired page kept collecting mentions, and when it and the page it points to claimed the same alias or handle, neither linked.
