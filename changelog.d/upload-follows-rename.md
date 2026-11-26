**An attachment uploaded while its page is being renamed is listed under the page's new name.**

### Fixed
- `gbrain files upload` (and the `file_upload` tool) records the attachment under the page's name at the moment it is saved, read by the page's id, and waits for a rename that is still in progress. Before, an upload that overlapped a rename kept the old name, so `gbrain files list` and `gbrain files verify` under the new name did not show it. Nothing was lost.
- The `gbrain repair slug-spelling` preview text for a source that is a subfolder of its Git repository in git-root slug mode now names the file rename inside the source's folder, the same rename its structured fix names.
