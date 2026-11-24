**`gbrain think --save` and `--take` now work on a managed brain.**

### Fixed
- On a managed brain, `gbrain think --save` failed with `writer_coordinator_required` and `--take` was refused because the anchor page belongs to the managed checkout, so nothing was saved. Both now go through the persistence coordinator. The synthesis page and the take row are written as tracked requests at the trust tier of what the answer read, and the write gate judges the take at that same tier.
- A save or take that was accepted but is still publishing is no longer reported as a failure. The CLI prints the answer and then exits 10 with the request id to check, the `think` tool returns the answer with a `SAVE_PENDING` or `TAKE_PENDING` warning, and the dream cycle's auto-think counts the question as answered instead of paying for the same synthesis again.
- `think --take` now writes the take in the source you chose with `--source` (it always used `default`), and a `think` tool call with no source scope no longer refuses its take.
