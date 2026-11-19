**Turning GBrain Helper's sending off now wins over a text already in progress and over a Touch ID dialog still open.**

### Fixed
- Each send checks the kill switch and its key again right before it hands the text to Messages, under the lock the settings are saved under. A text that had passed its first check while `send-setup --off` or `send-key remove` ran is now refused instead of sent.
- `send-setup --off` no longer waits for an earlier `send-setup` that is still showing its Touch ID dialog, and an approval given after the switch went off answers `send_disabled` instead of turning sending back on.
- When the helper answers `send-setup --off` with an error, the command now says what answered (for example that the helper was busy) instead of blaming the keychain.
