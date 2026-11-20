**The PGLite and Postgres engines now share one copy of the wanted-link, timeline-write, take-fence and code-traversal-cache SQL, with no change to what they do.**

### Changed
- Nine engine methods (`lockRegisteredSourceIds`, `replaceWantedLinkRows`, `removeTimelineRows`, `updateTimelineDetails`, `matchTakeRows`, `deleteTakeRows`, `getCodeTraversalCache`, `putCodeTraversalCache`, `clearCodeTraversalCache`) now exist on both engines. Each runs a statement that is byte-identical to the one the calling code still runs, and nothing calls them yet, so default brains behave exactly as before.
- The two mention version constants live in one small module that `mentions/pass.ts` and the graph ranking read from.
