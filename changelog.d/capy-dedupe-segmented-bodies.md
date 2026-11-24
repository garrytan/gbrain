**`gbrain dedupe classes` and `gbrain dedupe sample` no longer stop on a chat page stored in segments.**

### Fixed
- `gbrain dedupe classes` and `gbrain dedupe sample` refused the whole run with `page_body_segmented` when the brain held a chat page stored in segments (a page over 1 MiB). Such a page is now read whole up to 24 MiB and its chat counts as evidence. A larger one, or one whose read fails, is set aside, its chat adds no evidence, and the run carries on. The output lists it on its own line, and `--json` carries it under `messaging.segmented_page` (`read`, `set_aside` and the `pages`).
