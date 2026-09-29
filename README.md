# Botlane Draft

Quel ADC ou quel support prendre dans ta draft League of Legends : notes par matchup, synergies de duo et conseils de lane, selon la méta du patch en cours.

- **Appli** : https://clementlimousin1607-sys.github.io/botlane-draft/
- **Documentation** : https://clementlimousin1607-sys.github.io/botlane-draft/docs/ (utilisation, calcul des notes, format des données, mise à jour hebdo)

## En local

```bash
python3 -m http.server 8000          # puis http://localhost:8000
node --test "scripts/**/*.test.mjs"
node scripts/validate-data.mjs
./stats.sh --key                     # une fois : ta clé API Riot personnelle
./stats.sh 60                        # stats de l'API Riot, cumulées d'un lancement à l'autre
```

## Publier

```bash
./deploy.sh            # premier lancement : crée le dépôt public et active GitHub Pages
```

| Dossier | Contenu |
|---|---|
| `index.html` | L'appli (moteur de notes, icônes, liste des champions) |
| `data.json` | Données du patch : META, COUNTERS, profils, duos, conseils, patch notes |
| `docs/` | Documentation en ligne |
| `scripts/` | Validation et mise à jour des stats, tests |
| `.github/workflows/` | Publication Pages et mise à jour hebdomadaire des stats |

Botlane Draft isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
