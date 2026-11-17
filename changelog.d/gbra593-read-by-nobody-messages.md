**The access commands now say when a page is left readable by no member, and what to run.**

### Fixed
- `gbrain access member disable` lists the pages naming the member that no enabled member reads remotely any more, with the `gbrain repair visibility --slug <slug> --readers <member>,<owner>` write that gives one back.
- `gbrain access who-can-read` explains a page no enabled member reads remotely, whether because its readers name only disabled or removed members or because its `readable_by` and the folder rules covering it admit nobody in common.
- `gbrain access rule add` (and the other rule edits) warns in its preview about pages the change leaves readable by no member, such as a page written into a person's folder before that folder's rule named them.
- `gbrain auth list` shows a token bound to a disabled or removed member as `refused`; `--json` keeps `status` and adds `member_status`.
- A thin client whose credential is bound to a disabled member now says so (`access_member_disabled`) instead of "credentials may have been revoked".

<!-- behavior-change: auth_list_member_status_gbra593 -->
