#!/usr/bin/env bash
# Déploie le relais Claude sur Cloudflare Workers et branche index.html dessus.
# Prérequis : un compte Cloudflare (offre gratuite), une clé API Anthropic, gh connecté.
# Usage : worker/setup.sh [identifiant-github] [nom-du-depot]
set -euo pipefail
cd "$(dirname "$0")"
LOGIN="${1:-$(gh api user -q .login)}"
REPO="${2:-botlane-draft}"

# Origine autorisée et URL de data.json : https://<login>.github.io/<depot>/
sed -i "s#GITHUB_LOGIN#${LOGIN}#g; s#github.io/botlane-draft/#github.io/${REPO}/#" wrangler.toml
npm install --no-fund --no-audit
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

OUT=$(npx wrangler deploy 2>&1 | tee /dev/stderr)
URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.workers\.dev' <<<"$OUT" | head -1)
[ -n "$URL" ] || { echo "URL du Worker introuvable dans la sortie de wrangler deploy"; exit 1; }

if npx wrangler secret list 2>/dev/null | grep -qw ANTHROPIC_API_KEY; then
  echo "Clé ANTHROPIC_API_KEY déjà enregistrée (pour la changer : npx wrangler secret put ANTHROPIC_API_KEY)."
else
  echo "Colle ta clé API Anthropic (console.anthropic.com, rubrique API keys) :"
  npx wrangler secret put ANTHROPIC_API_KEY
fi

sed -i "s#<meta name=\"ai-endpoint\" content=\"[^\"]*\">#<meta name=\"ai-endpoint\" content=\"${URL}/\">#" ../index.html
echo
echo "Relais en ligne : ${URL}/"
echo "index.html pointe maintenant dessus. Publie avec : ../deploy.sh"
