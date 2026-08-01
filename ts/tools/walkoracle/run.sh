#!/usr/bin/env bash
# Diff the TS walk implementation against the Go engine's, frame for frame.
#
# Copies the REAL walk tables out of the repo root (so the data can never drift),
# builds the reference harness, runs both sides over every spot/heading pair, and
# diffs. Exits non-zero on any difference.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/../../.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/main.go" "$work/"
cp "$root/walk_data.go" "$root/calcpath_data.go" "$work/"
( cd "$work" && go mod init walkoracle >/dev/null 2>&1 && go run . > go-walk.txt )

npx tsx "$here/../walk-check.ts" > "$work/ts-walk.txt"

if diff -q "$work/go-walk.txt" "$work/ts-walk.txt" >/dev/null; then
  echo "walk oracle: $(wc -l < "$work/go-walk.txt") sequences identical (go == ts)"
else
  echo "walk oracle: DIVERGED"
  diff "$work/go-walk.txt" "$work/ts-walk.txt" | head -20
  exit 1
fi
