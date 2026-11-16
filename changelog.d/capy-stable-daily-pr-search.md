**The daily stable check sees merged important fixes again, and stops with a clear error if it ever loses access to pull requests.**

### Fixed
- The daily stable check's GitHub token can read pull requests again. A recent permissions change had left it unable to see any pull request, so the search for merged `stable:important` fixes came back empty and the check reported nothing to promote.
- Each run now logs how many labelled pull requests the search found. If the search sees no merged pull request at all, the check stops red and names the missing `pull-requests: read` permission instead of quietly reporting nothing.
