**GBrain Helper can now be installed on a Mac with one script, `apple/helper/scripts/install.sh`, which builds, signs and starts it and keeps its macOS permissions across reinstalls.**

### Added
- `apple/helper/scripts/install.sh` builds the helper, signs it with a certificate made on the Mac, installs `~/Applications/GBrain Helper.app` and registers its background agent, with no dialog. Every later run, and `--repair`, signs with the same certificate, so Full Disk Access, Automation and keychain access carry over. If the app is installed but its signing keychain is gone, it stops and changes nothing.
- `gbrain-apple-helper register` registers the app's background agent with macOS and says whether it is on or waiting to be switched on in Login Items.
- The helper's macOS CI job now runs the script: install, reinstall, repair and the refusal without a keychain, checking the signature stays the same and the helper answers `/health`.
