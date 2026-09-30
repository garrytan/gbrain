#!/usr/bin/env bash

guard_candidates() {
  local file rc batch_count=0
  local -a batch=()
  while IFS= read -r file; do
    [ -n "$file" ] && [ -f "$file" ] || continue
    batch+=("$file")
    batch_count=$((batch_count + 1))
    if [ "$batch_count" -ge 128 ]; then
      if grep -l "$@" -- "${batch[@]}"; then
        :
      else
        rc=$?
        [ "$rc" -eq 1 ] || return "$rc"
      fi
      batch=()
      batch_count=0
    fi
  done
  if [ "$batch_count" -gt 0 ]; then
    if grep -l "$@" -- "${batch[@]}"; then
      :
    else
      rc=$?
      [ "$rc" -eq 1 ] || return "$rc"
    fi
  fi
}
