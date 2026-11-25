**Deleting the shadow folder while a restore drill or an eval-gates fetch is running is now noticed on every filesystem.**

### Fixed
- The restore drill and the eval-gates fetch (`gbrain engine shadow drill`) check, before each write, that the shadow folder and its `drills/` folder are still the ones they started in. On ext4 a folder that was deleted and recreated could look like the old one, because the filesystem hands the freed inode number straight back. A drill or fetch could then write into a shadow you had just replaced, instead of ending as `shadow_gone`. They now keep both folders open for the length of the run, which stops the filesystem reusing the number, and nothing is written into your folders to do it.
- A restore drill that fails while it takes its lock (for example on a full disk) no longer leaves those folders held open.
