#!/bin/bash
source /var/tmp/rx/env.sh; cd /var/tmp/rx
kind=$1; tag=$2; prof=$3
export HOME=/var/tmp/rx/h-$kind GBRAIN_HOME=/var/tmp/rx/h-$kind
extra=""; [ -n "$prof" ] && extra="--cpu-prof --cpu-prof-dir=$prof"
a=$(./pgcpu.sh)
/usr/bin/time -f 'wall=%e user=%U sys=%S rss_kb=%M' -o time-$tag.txt bun $extra /code/garrytan/gbrain/src/cli.ts sync --source notes --no-pull --no-embed > sync-$tag.log 2>&1
echo rc=$? >> time-$tag.txt
b=$(./pgcpu.sh); echo "pg_server_cpu=$(echo "$b - $a" | bc)" >> time-$tag.txt
cat time-$tag.txt
