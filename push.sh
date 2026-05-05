#!/bin/bash
# One-line push for the price sheet.
# Usage:
#   ./push.sh                  → commit message: "update"
#   ./push.sh "what changed"   → commit message: that string
set -e
cd "$(dirname "$0")"
MSG="${1:-update}"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit — already up to date."
  exit 0
fi
git commit -m "$MSG"
git push origin main
echo ""
echo "Pushed. Live in ~30-60 sec at: https://apparelhotline.github.io/pricesheet/"
