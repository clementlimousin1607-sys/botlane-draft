#!/usr/bin/env bash
# Met à jour les stats sur ta machine, à partir de l'API Riot (voir scripts/sources/riot.mjs).
#
#   ./stats.sh --key       enregistre ta clé API Riot (demandée sans l'afficher)
#   ./stats.sh [minutes]   collecte pendant N minutes (60 par défaut) et met à jour data.json
#   ./deploy.sh            publie ensuite le site
#
# Les parties s'additionnent d'un lancement à l'autre (dossier .stats-cache/, jamais publié).
# Ctrl+C arrête la collecte en gardant les parties déjà lues.
set -euo pipefail
cd "$(dirname "$0")"
KEY_FILE="$HOME/.config/botlane-draft/riot-key"

if [ "${1:-}" = "--key" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  read -rsp "Colle ta clé API Riot (RGAPI-…) puis Entrée : " KEY; echo
  [[ "$KEY" == RGAPI-* ]] || { echo "Ça ne ressemble pas à une clé Riot (RGAPI-…)."; exit 1; }
  (umask 077; printf '%s' "$KEY" > "$KEY_FILE")
  echo "Clé enregistrée dans $KEY_FILE (lisible par toi seul)."
  exit 0
fi

[ -s "$KEY_FILE" ] || { echo "Pas de clé : lance d'abord ./stats.sh --key"; exit 1; }
MIN="${1:-60}"
[[ "$MIN" =~ ^[0-9]+$ ]] || { echo "Usage : ./stats.sh [minutes] ou ./stats.sh --key"; exit 1; }
echo "Collecte pendant $MIN min au plus (Ctrl+C pour arrêter plus tôt)…"
STATS_MAX_MINUTES="$MIN" node scripts/update-stats.mjs --source riot
echo
git diff --quiet data.json && echo "data.json n'a pas changé." || echo "data.json mis à jour. Pour publier : ./deploy.sh"
