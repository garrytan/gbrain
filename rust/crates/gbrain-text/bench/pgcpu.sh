#!/bin/bash
# total Postgres server CPU seconds: postmaster self + reaped children + live children
pm=$(head -1 /var/tmp/rx/pg/data/postmaster.pid)
tck=$(getconf CLK_TCK)
tot=$(awk '{print $14+$15+$16+$17}' /proc/$pm/stat)
for c in $(cat /proc/$pm/task/*/children); do t=$(awk '{print $14+$15}' /proc/$c/stat 2>/dev/null); tot=$((tot + ${t:-0})); done
echo "scale=2; $tot/$tck" | bc
