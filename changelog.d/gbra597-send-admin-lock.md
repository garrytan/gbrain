**Changing GBrain Helper's send settings at the Mac no longer holds up sends, and a Touch ID approval applies only to the settings it was shown for.**

### Fixed
- Turning sending on, adding a send key and raising a limit ask for Touch ID. The helper used to hold its settings lock for the whole dialog, which can take up to two minutes, so any send arriving then waited. It now asks with no lock held, and sends keep working while the dialog is open.
- After the owner approves, the helper takes the lock, reads the settings again and applies the change only if they still match what the dialog was built from. If another change landed in the meantime it applies nothing and answers `overloaded`, and the owner runs the command again.
- A send now reads its settings, checks the kill switch and its key, and takes the limits under the same lock admin uses to save. A send that arrives while a key is being replaced is checked against the new key.
- `send-setup --off`, `send-key remove` and lowering a limit always write the keychain item, so a failed write is reported as an error rather than taken as done.
- `send-key add` and `send-limits set` wait for the helper's Touch ID wait plus a minute.
