#!/bin/bash
# append one line to the same 1,000 notes and commit (round $2)
cd /var/tmp/rx/$1
for i in $(seq 0 7 6999 | head -1000); do echo "Follow-up round $2 with Jennifer Smith." >> notes/n-$i.md; done
git add -A && git -c user.email=b@x -c user.name=b commit -qm "round $2"
