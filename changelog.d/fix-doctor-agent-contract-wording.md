**Doctor distinguishes internal errors from agent errors with no next-step suggestion.**

### Fixed
- The `agent_contract` warning only reports a missing suggestion when the recorded event explicitly says it was absent. The warning still counts an event that meets both conditions once in its total.
