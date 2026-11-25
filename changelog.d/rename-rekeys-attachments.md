**A renamed page keeps its attachments: `gbrain files list` finds them under the page's new name.**

### Fixed
- Renaming a page (a renamed file synced from Git, or `gbrain repair rename-identity`) now moves the page's attachments to its new name, on every engine. Before, they stayed under the old name, so listing or verifying the page's attachments did not show them. Nothing was lost.
- An attachment saved with `gbrain files upload --page` (or `upload-raw`) now records its page, so it follows the page from then on; one saved before that follows a rename when the old name pointed to just that page; when that is not certain (the name was used before, or the database role cannot see every row), it stays and the rename logs it.
- The upgrade moves attachments an earlier rename left behind back to their page's current name. An attachment that was never tied to a page stays as it is.
