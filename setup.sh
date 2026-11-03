#!/usr/bin/env bash
# One-time: creates GitHub repo, links Vercel, sets the key, deploys, and turns on auto-deploy.
set -euo pipefail
NAME="${1:-zweisprachig}"

need(){ command -v "$1" >/dev/null || { echo "Missing $1 → $2"; exit 1; }; }
need git  "xcode-select --install"
need gh   "brew install gh"
need node "brew install node"
VC="npx --yes vercel@latest"   # no global install needed

gh auth status >/dev/null 2>&1 || gh auth login
$VC whoami >/dev/null 2>&1 || $VC login

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Get a free key: https://aistudio.google.com/apikey"
  read -rsp "Paste GEMINI_API_KEY: " GEMINI_API_KEY; echo
fi

# Git + GitHub
[ -d .git ] || git init -b main
git add -A
git diff --cached --quiet || git commit -m "chore: initial release"
gh repo view "$NAME" >/dev/null 2>&1 || gh repo create "$NAME" --public --source . --remote origin --push
git push -u origin main || true

# Vercel
$VC link --yes --project "$NAME"
for env in production preview development; do
  $VC env rm GEMINI_API_KEY "$env" --yes >/dev/null 2>&1 || true
  printf "%s" "$GEMINI_API_KEY" | $VC env add GEMINI_API_KEY "$env" >/dev/null
done
$VC git connect --yes || echo "(Connect repo manually in Vercel → Settings → Git if this failed)"
URL=$($VC --prod --yes | tail -n1)

echo
echo "✅ Live: $URL"
echo "From now on: git push → auto-deploy. Branches/PRs → preview links."
