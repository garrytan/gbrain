**The Google token socket is harder to misuse: turning writes off stops a write that was still waiting for its token, a throttled approval can be sent again, and the owner sees who a paused calendar invite would reach.**

### Fixed
- A write that was waiting for its token when `google.broker_act` was turned off is no longer sent.
- If Google throttles a call the owner approved or confirmed, the approval is kept, so the call can be repeated after `retry_after_s` within the prompt's 10 minutes.
- The repeat of a safety pause the owner already confirmed goes through even when 64 calls are waiting.
- A throttled call reserved before UTC midnight gives its place back to the day it was charged to, so the next day's cap stays exact.
- A mint with `"fresh": true` skips the socket's cached read-only token, for a caller Google answered with a 401.
- For an account on a public mail domain (gmail.com, icloud.com, outlook.com, yahoo.com, aol.com, proton.me and their aliases), every invitee but the account itself counts as outside for the safety pause.
- `gbrain google approvals` shows a paused invite's outside addresses before its arguments, marks arguments cut at 600 characters, and indents Google's prompt text so it can't pose as another field.
- `gbrain google mint status` notes each non-root peer uid that can't open the 0600 socket in this release.
- A client whose connection the socket closes, or that can't open it, gets `peer_refused` at once instead of waiting 2 minutes; a `call` cut off that way gets `outcome_unknown`, since it may have been sent.
- A socket that fails to start after taking its bind lock now releases the lock.
- A write Google accepted whose outcome can't be saved to disk is still reported as a success, with a warning.
- The Google connect guide and llms.txt now link the token socket guide.
