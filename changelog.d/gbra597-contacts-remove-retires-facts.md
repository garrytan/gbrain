**Removing an Apple Contacts source now takes its company, job title and group rows off person pages first.**

### Fixed
- `gbrain sources remove` (and a managed remove or purge) on an `apple-contacts` source retires the Facts rows it wrote on people pages before the source is deleted. Those rows live in the people pages' own sources, so before this they stayed behind after the remove. The remove preview says how many rows go. If any row can't be retired, the remove stops and the source stays registered, so nothing is left half done.
