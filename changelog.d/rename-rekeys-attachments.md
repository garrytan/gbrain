**A renamed page keeps its attachments: `gbrain files list` finds them under the page's new name.**

### Fixed
- Renaming a page (a renamed file synced from Git, or `gbrain repair rename-identity`) now moves the page's attachments to its new name. Before, they stayed under the old name, so listing or verifying the page's attachments did not show them. Nothing was lost.
- The upgrade moves attachments an earlier rename left behind back to their page's current name. An attachment that was never tied to a page stays as it is.
