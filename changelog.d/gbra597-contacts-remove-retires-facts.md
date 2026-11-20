**Removing an Apple Contacts source now takes its company, job title and group rows off person pages first.**

### Fixed
- Removing or purging an `apple-contacts` source (`gbrain sources remove`, `sources purge`, the expired-archive sweep, the `sources_remove` operation and the managed remove and purge) retires the Facts rows it wrote on people pages before the source is deleted. Those rows live in the people pages' own sources, so before this they stayed behind. The remove preview says how many rows go. A refused remove changes nothing, and if a row can't be retired (no page slug, or its people source is archived) the remove stops with nothing retired and the source still registered.
