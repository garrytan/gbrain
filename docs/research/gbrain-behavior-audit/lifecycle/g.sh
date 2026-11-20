#!/usr/bin/env bash
# g.sh <brainname> args...  -> runs gbrain on /var/tmp/audit/lifecycle/<brainname>
N="$1"; shift
exec /var/tmp/audit/brain.sh /var/tmp/audit/lifecycle/"$N" "$@"
