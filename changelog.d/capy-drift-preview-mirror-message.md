**On a read-only mirror, `gbrain repair file-drift --held` now says why it could not read a held note's file instead of printing a bare error code.**

### Fixed
- When a held note's file on a read-only mirror can't be read losslessly (invalid UTF-8, or frontmatter YAML that only parses through recovery), the preview now shows the reason after the code, such as `invalid_params: Canonical file metadata cannot be parsed losslessly; repair its syntax before previewing.`, instead of `invalid_params` alone. Writable sources already showed it.
