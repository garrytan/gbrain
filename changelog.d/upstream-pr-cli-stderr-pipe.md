**CLI errors remain visible when stderr is piped.**

### Fixed
- Deliver human error messages before the CLI exits, so pipes and parent processes receive the complete diagnostic.
