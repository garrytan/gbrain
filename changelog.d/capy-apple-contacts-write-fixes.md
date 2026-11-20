**Undoing an Apple Contacts change now puts back every copy of a removed phone or email, and keeps non-Gregorian birthdays.**

### Fixed
- Removing a phone or email that is on a card more than once (for example the same number written two ways) journals every copy it removes, with its label, so `gbrain-apple-helper contacts-restore --batch <id> --apply` puts all of them back. Before, only the first copy was recorded and the rest were lost on undo.
- GBrain Helper now reads, saves and restores a contact's non-Gregorian birthday (for example a Chinese-calendar birthday, leap month included), and keeps the calendar of every birthday and date. A deleted card restored from the journal or the daily copy keeps it, and `merge` refuses, changing nothing, when the card it would remove has one.
