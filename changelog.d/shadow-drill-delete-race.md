**`gbrain engine shadow stop --delete` can no longer be undone by a restore drill that is running at the same moment.**

### Fixed
- `gbrain engine shadow stop --delete` now waits its turn behind a running restore drill: while one runs it refuses (exit 1, `drill_running`) and changes nothing, so run it again once the drill ends. It takes the same lock even when no drill has run yet, so a first drill cannot start under the delete either. Before, the two could overlap and the drill could bring back an empty `drills/scratch/restored` folder inside the shadow directory you had just deleted.
- The restore drill checks that the shadow and the store it is about to open still exist, and opens nothing that is gone. A drill that finds its shadow deleted ends as `shadow_gone` and leaves nothing behind.
