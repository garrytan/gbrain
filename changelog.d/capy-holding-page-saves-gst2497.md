### Saving a fact to a holding page is faster and keeps less history

**Saving a fact to a holding page (memory/unattributed, or a folder's holding page) no longer slows down and fills the database as the page grows (GST-2497).** Each save used to read the page's whole facts table about seventeen times and store another full copy of the page, so a page with thousands of facts took over a second per save and every save added a copy of it.
- One save now reads the table at most three times: a parse of a given table is reused, and every caller gets its own copy.
- A holding page keeps its newest five saved versions, the way large pages already do. Every fact row stays, the page still holds every row, and Git keeps every state where the brain has a repository. An older holding page sheds extra versions in batches of at most 100 on its next saves. `get_versions` and `gbrain revert` see only the five; an `as_of` read of the page says its history is incomplete, and `gbrain repair unwithdrawn-facts` lists that page's candidates as ambiguous (`--include-ambiguous` restores them).
- After a sync, the held-fact move no longer plans a move on every sync when a folder rule covers a holding page but not the entity of a row on it. A rule that narrows a held row below its holding page's readers still moves it right after the sync.
- On Postgres, the held-fact move's plan reads the write-through setting under the same deadline as its other reads, so a session holding the config table no longer keeps a sync past its preparation budget.

<!-- behavior-change: holding_page_versions_gst2497 -->
