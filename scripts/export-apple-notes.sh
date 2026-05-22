#!/bin/bash
# Export all Apple Notes to markdown files, then sync to gbrain
# Usage: bash scripts/export-apple-notes.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

EXPORT_DIR="${HOME}/.gbrain/apple-notes-export"
mkdir -p "$EXPORT_DIR"

echo "→ Exporting Apple Notes to $EXPORT_DIR ..."

osascript <<APPLESCRIPT
set exportDir to "$EXPORT_DIR"

tell application "Notes"
  set allFolders to every folder
  repeat with f in allFolders
    set folderName to name of f
    if folderName is not "Recently Deleted" then
      try
        set safeFolder to do shell script "printf '%s' " & quoted form of folderName & " | tr '/:' '--' | cut -c1-60"
        do shell script "mkdir -p " & quoted form of (exportDir & "/" & safeFolder)
        set allNotes to every note in f
        repeat with n in allNotes
          try
            set noteTitle to name of n
            set noteBody to ""
            try
              set noteBody to body of n
            end try
            set safeTitle to do shell script "printf '%s' " & quoted form of noteTitle & " | tr '/:*?\"<>|\\\\' '-' | cut -c1-80"
            set filePath to exportDir & "/" & safeFolder & "/" & safeTitle & ".md"
            set fullContent to "# " & noteTitle & "\n\n" & noteBody
            do shell script "printf '%s' " & quoted form of fullContent & " > " & quoted form of filePath
          on error errMsg
            -- skip problematic notes silently
          end try
        end repeat
      on error errMsg
        -- skip problematic folders silently
      end try
    end if
  end repeat
end tell
APPLESCRIPT

echo "→ Export complete."
echo ""

NOTE_COUNT=$(find "$EXPORT_DIR" -name "*.md" | wc -l | tr -d ' ')
echo "   Found $NOTE_COUNT notes"
echo ""

if $DRY_RUN; then
  echo "→ [dry-run] Folder structure:"
  find "$EXPORT_DIR" -type d | head -20
  echo ""
  echo "→ [dry-run] Sample files:"
  find "$EXPORT_DIR" -name "*.md" | head -10
else
  echo "→ Syncing to gbrain..."
  gbrain sync "$EXPORT_DIR"
  echo ""
  echo "Done! $NOTE_COUNT notes synced to gbrain."
fi
