**Atom extraction disables hidden SDK retries when it enforces a cost cap.**

### Fixed
- Under a cost cap, the SDK makes one attempt per provider call. Temporary HTTP conflicts and service failures that reach the extraction loop leave the input eligible for a later retry.
