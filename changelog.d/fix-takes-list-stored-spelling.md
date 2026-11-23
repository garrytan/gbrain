**`gbrain takes list` and `gbrain takes revisit` now find a page by the name it is stored under.**

### Fixed
- `gbrain takes list Companies/Acme-Example` lists the takes of a page stored with capitals or decomposed accents, where it printed no takes before. It picks the page the way `gbrain get` and the `takes_list` tool do: the name as typed, then its lowercase, then its normal form, a live page before a deleted one. It still reads every source, and a name already in normal form lists what it listed before.
- `gbrain takes revisit Companies/Revisit-Example` opens the file of that page instead of answering "Page not found". A page that records its file opens that file, never another file that happens to sit under the typed name; a recorded file outside the source folder is refused, and no file is ever created.
- When two pages are stored under spellings of one name and neither is the name typed, both commands stop and name the two spellings instead of guessing.
