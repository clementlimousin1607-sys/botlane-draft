#!/usr/bin/env bash
# Publie Botlane Draft sur GitHub Pages, dans un dépôt public de ton compte GitHub.
# Premier lancement : crée le dépôt, active Pages (déploiement par GitHub Actions) et pousse.
# Lancements suivants : commit + push des changements ; le workflow "Publier le site" redéploie.
# Usage : ./deploy.sh [nom-du-depot]      (MSG="mon message" ./deploy.sh pour choisir le message de commit)
set -euo pipefail
cd "$(dirname "$0")"
REPO="${1:-botlane-draft}"

command -v gh >/dev/null || { echo "Installe la CLI GitHub : https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https --scopes workflow
# Le scope "workflow" est nécessaire pour pousser .github/workflows/
gh auth status 2>&1 | grep -q "'workflow'" || gh auth refresh --scopes workflow
gh auth setup-git
LOGIN=$(gh api user -q .login)
sed -i "s/GITHUB_LOGIN/${LOGIN}/g" README.md
ID=$(gh api user -q .id)
URL="https://${LOGIN}.github.io/${REPO}/"

if [ ! -d .git ]; then
  git init -q -b main
  # Dépôt public perso : identité GitHub (adresse noreply) plutôt que l'identité git globale
  git config user.name "$LOGIN"
  git config user.email "${ID}+${LOGIN}@users.noreply.github.com"
fi
git add -A
git diff --cached --quiet || git commit -qm "${MSG:-$(git rev-parse -q --verify HEAD >/dev/null && echo "Mise à jour $(date +%F)" || echo "Botlane Draft")}"

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source=. --remote=origin \
    --description "Quel ADC ou support prendre dans ta draft League of Legends" --homepage "$URL"
  # Pages en mode "GitHub Actions" : le workflow pages.yml publie index.html, data.json et docs/
  if gh api -X POST "repos/${LOGIN}/${REPO}/pages" -f build_type=workflow >/dev/null 2>&1; then
    git push -u origin main
  else
    git push -u origin main
    gh api -X POST "repos/${LOGIN}/${REPO}/pages" -f build_type=workflow >/dev/null
    gh workflow run pages.yml --ref main
  fi
else
  git push
fi

echo
# Attend la publication : les tests tournent avant, et un échec laisse l'ancien site en ligne.
SHA=$(git rev-parse HEAD); RUN=""
echo "Publication en cours (1 à 2 minutes)…"
for _ in $(seq 1 30); do
  RUN=$(gh run list --workflow pages.yml --commit "$SHA" -L 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)
  [ -n "$RUN" ] && break; sleep 4
done
if [ -z "$RUN" ]; then
  echo "Publication introuvable pour ce commit : vérifie l'onglet Actions sur GitHub."
elif gh run watch "$RUN" --exit-status >/dev/null 2>&1; then
  echo "✅ Site publié : ${URL}"
  echo "Documentation : ${URL}docs/"
else
  echo "❌ La publication a échoué : le site en ligne n'a PAS changé."
  echo "Détail : gh run view $RUN --log-failed"
  exit 1
fi
