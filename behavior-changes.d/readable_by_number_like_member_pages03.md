---
kind: action
---
A page whose readable_by list names a member id that looks like a number (readable_by: [alice-example, 001]) was readable by nobody before, because the old frontmatter typing read 001 as the number 1 and a list with a non-text entry denies everyone. Values are now kept as written, so 001 is the member id member:001 and that member can read the page, as the file says. This happens on upgrade with no edit to the file: the one-time re-read after the upgrade stores the list as written. Nothing beyond what the file names gets access. To keep such a page closed to that member, remove the entry from readable_by before you upgrade.
