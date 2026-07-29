# F1TV Downloader

Telecharge une ou plusieurs sessions F1TV (essais, qualifications, course...) en fichiers `.mkv` locaux, avec toutes les pistes audio disponibles (langues, radios equipe, etc.).

## Prerequis

- Node.js 20+
- [ffmpeg](https://ffmpeg.org/) installe et accessible dans le PATH
- [MKVToolNix](https://mkvtoolnix.download/) (commande `mkvmerge`) installe et accessible dans le PATH
- Un fichier de cookies F1TV au format Netscape (export navigateur), place a la racine du projet sous le nom `f1tv.formula1.com_cookies.txt` (ou un autre chemin indique dans `.env`)
- Une base MySQL `f1-history` contenant les tables `f1tv_saison` (saison -> f1tv_id, a renseigner manuellement) et `statsf1_grand_prix`

## Installation

```
npm install
cp .env.example .env
```

Puis completer `.env` :
- `F1TV_DEST_DIR` : dossier ou seront enregistrees les videos
- `F1TV_COOKIE_FILE` : chemin du fichier de cookies (par defaut `./f1tv.formula1.com_cookies.txt`)
- `F1TV_MAX_PARALLEL_AUDIO` : nombre de pistes audio telechargees en parallele (par defaut 3)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` : acces a la base MySQL

## Utilisation

```
node src/index.js -saison <annee> [-manche <numero>|all] [-session "<nom de la session>"] [-audio <code>|no] [-flux "<nom du flux>"]
```

- `-saison` : annee de la saison (ex : 2026) — obligatoire.
- `-manche` : numero de la manche / du Grand Prix (ex : 11). Omis ou `all` : toutes les manches de la saison sont traitees (table `statsf1_grand_prix`).
- `-session` : nom de la session tel qu'affiche par le script (ex : "Essais Libres 1", "Qualifications", "Course", "Pre-Race"...). Omis : le script affiche la liste des sessions disponibles pour la ou les manches, **sans rien telecharger**.
- `-audio` : optionnel. Un code langue (ex : `en`, `fr`) pour ne garder que cette piste audio ; `no` pour ne telecharger aucune piste audio (video seule). Omis : toutes les pistes audio disponibles sont incluses. Le fichier reste un `.mkv` dans tous les cas.
- `-flux` : optionnel. Choisit un autre angle/camera : `"Live Timing"`, `"Drivers Tracker"` ou `"F1 Live"` (voir `src/fluxMapping.js`). Omis : flux principal. Change aussi le nom du fichier final (ex : `... - Qualifications (Live Timing - F1TV).mkv`, ou `... - Live Timing (F1TV).mkv` pour la Course).

Exemples :

```
# Une seule video, toutes les pistes audio
node src/index.js -saison 2026 -manche 11 -session "Essais Libres 1"

# Liste les sessions disponibles pour la manche 11 (aucun telechargement)
node src/index.js -saison 2026 -manche 11

# Telecharge la course de chaque manche de la saison
node src/index.js -saison 2026 -manche all -session "Course"

# Liste les sessions disponibles pour toute la saison (aucun telechargement)
node src/index.js -saison 2026

# Uniquement la piste audio anglaise
node src/index.js -saison 2026 -manche 11 -session "Course" -audio en

# Video seule, sans aucune piste audio
node src/index.js -saison 2026 -manche 11 -session "Course" -audio no

# Autre angle/flux (Live Timing)
node src/index.js -saison 2026 -manche 11 -session "Course" -flux "Live Timing"
```

Si le fichier final existe deja dans `F1TV_DEST_DIR`, il n'est pas retelecharge (aucun appel a F1TV n'est meme fait) : on peut donc relancer la meme commande sans risque, par exemple pour completer une saison partiellement telechargee.

En cas de traitement multiple, un echec sur une session n'interrompt pas les autres : le script continue et affiche un recapitulatif (succes / deja presents / echecs) a la fin.

Le fichier genere suit la convention :
`[manche] GP [grand_prix] [saison] - [session] (F1TV).mkv`
(sans le suffixe session pour la Course).

## Fonctionnement

1. Lecture de `f1tv_id` pour la saison dans `f1tv_saison`.
2. Appel de la page F1TV de la saison pour trouver le Grand Prix correspondant a chaque manche demandee. Deux cas :
   - Saisons recentes : une page dediee au Grand Prix (`PageID`) liste toutes ses sessions (FP1, Qualifs, Course...).
   - Saisons anciennes : pas de page dediee, la page saison liste directement les videos disponibles (replay complet, resume).
3. Recherche de la/les session(s) demandee(s) et de leur `contentId` (filtrage par `MeetingKey` pour ignorer les sessions archivees d'autres annees portant le meme titre).
4. Recuperation de l'URL de la playlist HLS (maitre) pour chaque contentId.
5. Analyse de la playlist maitre : selection de la meilleure qualite video et de toutes les pistes audio alternatives (filtrees selon `-audio` si fourni).
6. Telechargement de la piste video, puis des pistes audio en parallele (jusqu'a `F1TV_MAX_PARALLEL_AUDIO` a la fois, via `ffmpeg`), puis assemblage en un seul `.mkv` avec `mkvmerge` (langues et noms de piste conserves).
7. Lecture du nom du Grand Prix dans `statsf1_grand_prix` pour nommer le fichier final, enregistre dans `F1TV_DEST_DIR`.

Les noms de session bruts renvoyes par F1TV sont normalises via une table de correspondance (`src/sessionNameMapping.js`), par exemple `REPLAY` -> `Course`, `HIGHLIGHTS` -> `Résumé`, `Emission d'Avant-Course` -> `Pre-Race`. Toute valeur absente de cette table est conservee telle quelle.

## Limites connues

- La table `f1tv_saison` doit etre renseignee manuellement (pas de recherche automatique du `f1tv_id`).
- Si le cookie F1TV expire, le script s'arrete avec un message clair : il faut regenerer le fichier de cookies en se reconnectant sur le site.
- L'ordre des sessions listees automatiquement (quand `-session` est omis) est approximatif (base sur un indice interne F1TV), pas garanti strictement chronologique.
