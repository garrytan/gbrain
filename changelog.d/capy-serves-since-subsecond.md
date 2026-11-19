**An unbound token minted just before a brain starts serving several people now gets its 14-day grace, even when the second member is added in the same second.**

### Fixed
- `access.serves_since` is now recorded to the microsecond (migration v327) and credential creation times are read to the millisecond. Before, a token minted in the same second as the second member, but before it, was refused with `requester_scope_required` instead of reading in its grace. A token minted after the switch is still refused, and a value an older gbrain stored at whole seconds is kept and gives the same answers as before.
