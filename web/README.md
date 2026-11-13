# Cochons de Guerre — Web

Portage web et multijoueur en ligne de **Cochons de Guerre** (*Hogs of War*,
Infogrames, 2000), version PlayStation française (SLES-02766).

Le navigateur exécute le **code original du jeu PS1** dans une PlayStation
virtuelle compilée en WebAssembly (cœur [PCSX-ReARMed](https://github.com/libretro/pcsx_rearmed)
et frontend maison `core/frontend.c`). Tout ce qui fait le jeu PS1 est donc
conservé à l'identique :

- l'**intelligence artificielle** de la version PlayStation ;
- les **textes, briefings, voix et sons français** du disque français ;
- la musique (pistes audio CD) et les cinématiques.

Aucune donnée du jeu n'est fournie : chaque joueur charge **sa propre copie**
du disque, qui reste sur son ordinateur (le serveur ne la reçoit jamais).

## Démarrage rapide

```bash
cd web
npm install
npm start            # http://localhost:8080
```

Ouvrez la page, déposez les fichiers du disque (`.cue` + `.bin`, une image
`.chd`, ou directement l'archive `.zip`) et jouez. Le disque peut être
mémorisé dans le navigateur pour les sessions suivantes.

Le cœur WebAssembly précompilé est livré dans `public/core/`. Pour le
recompiler (Emscripten requis) :

```bash
source /chemin/vers/emsdk/emsdk_env.sh
npm run build:core   # clone PCSX-ReARMed (commit épinglé) et produit psx.js/psx.wasm
```

## Multijoueur en ligne

Le multijoueur est en **lockstep déterministe** : chaque joueur fait tourner
sa propre console à partir du même état, et seules les entrées de manette
circulent sur le réseau (quelques octets par image). L'image et le son restent
donc parfaits pour tout le monde, même avec une connexion modeste.

1. L'hôte clique sur **Créer un salon** et partage le code à 4 lettres (ou le
   lien « Copier le lien »).
2. Chaque ami charge son disque puis **Rejoindre** avec le code. L'hôte envoie
   l'état de sa console au nouvel arrivant (environ 1 Mo compressé) et tout le
   monde repart synchronisé, même en pleine partie.
3. Dans le jeu : **MULTIJOUEUR**, réglez un emplacement **JOUEUR 1…4** par
   participant (les autres sur CPU ou OFF).

Cochons de Guerre se joue au **tour par tour sur la manette 1** (vérifié : au
tour du joueur 2, c'est la manette 1 qui commande). Tous les participants
partagent donc la manette 1 par défaut, avec un arbitrage déterministe : celui
qui joue garde la main, et après 2 secondes sans action le prochain joueur qui
appuie sur un bouton la prend. L'hôte peut aussi attribuer d'autres manettes ou
passer quelqu'un en spectateur.

Réglages de l'hôte :

- **Délai réseau** (1 à 12 images, 4 par défaut = 80 ms) : à augmenter si la
  partie saccade avec des joueurs éloignés. Le jeu étant au tour par tour, un
  délai élevé reste confortable.
- **Vitesse du jeu** : ×1,5 à ×3 pour tout le salon, pratique pendant les
  longues réflexions de l'IA.

À chaque synchronisation, l'hôte recharge lui-même l'état qu'il envoie : les
états de PCSX-ReARMed n'enregistrent pas tout (lectures CD en cours, par
exemple), donc tout le monde repart exactement des mêmes octets.

Sécurité anti-désynchronisation : toutes les 250 images, chaque console envoie
une empreinte de sa RAM à l'hôte ; en cas d'écart, l'hôte resynchronise
automatiquement tout le salon.

Prérequis : tous les joueurs doivent avoir **la même version du disque**
(empreinte vérifiée à l'entrée du salon).

## Commandes

| PlayStation | Clavier (par défaut) |
|---|---|
| Croix / Rond / Carré / Triangle | X / C / S / D |
| L1 / R1 / L2 / R2 | E / R / F / G |
| Start / Select | Entrée / Retour arrière |
| Croix directionnelle | Flèches |

Les touches sont configurables (bouton **Touches**). Les manettes USB ou
Bluetooth sont reconnues automatiquement. En solo : **Tab** maintenu = avance
rapide (utile pendant les tours de l'IA), **F2/F4** = sauver/charger l'état,
**F11** = plein écran. La carte mémoire est enregistrée automatiquement dans le
navigateur.

## Protection LibCrypt (facultatif)

Le disque PAL est protégé par LibCrypt. Si vous possédez le fichier `.sbi`
correspondant à votre disque, ajoutez-le à la sélection (il est renommé
automatiquement pour accompagner le `.cue`). Sans lui le jeu démarre et se
joue normalement dans nos essais.

## Déploiement

Le serveur (`server/server.mjs`) sert les fichiers statiques et relaie les
messages des salons via WebSocket (`/ws`). Variables : `PORT` (8080), `HOST`
(0.0.0.0). Derrière un proxy HTTPS, transmettez l'en-tête `Upgrade` pour
`/ws` ; la page utilise automatiquement `wss://` en HTTPS.

```bash
docker build -t cochons-web web/
docker run -p 8080:8080 cochons-web
```

## Tests

```bash
npm test                                          # moteur lockstep (unitaires)
node tests/determinism.mjs "../disc-fr/<jeu>.cue" # 2 consoles, mêmes entrées => même RAM
node tests/sync-sweep.mjs "../disc-fr/<jeu>.cue" 1 # fidélité des états de synchronisation
node tests/netplay-sim.mjs "../disc-fr/<jeu>.cue" [état] # lockstep simulé, latence aléatoire
node tests/e2e.mjs ../disc-fr                     # Chromium : solo + partie en réseau à 2
node tools/headless.mjs "<jeu>.cue" --frames 3000 --shot-every 100 --out captures
```

## Architecture

```
public/
  index.html, css/            interface (en français)
  js/app.js                   boucle principale, audio, vidéo, salon
  js/worker.js                Web Worker : cœur PS1 (le disque est monté en WORKERFS, sans copie)
  js/lockstep.js              moteur d'entrées lockstep + arbitrage de la manette partagée
  js/net.js                   client WebSocket, paquets de synchronisation (gzip)
  js/disc.js                  CUE/BIN, CHD, ZIP (décompression en flux), empreinte du disque
  js/input.js                 clavier (positions physiques, AZERTY/QWERTY) et manettes
  js/audio-worklet.js         sortie audio 44,1 kHz
  core/psx.js, psx.wasm       PlayStation virtuelle (générés par core/build.sh)
server/server.mjs             fichiers statiques + salons + relais
core/frontend.c               frontend libretro minimal exporté vers JavaScript
tools/headless.mjs            exécution sans navigateur (Node) : captures, états, RAM
```

## Mentions légales

Projet de fan non officiel et non commercial. *Hogs of War* / *Cochons de
Guerre* sont des marques de leurs ayants droit ; PlayStation est une marque de
Sony Interactive Entertainment. PCSX-ReARMed est distribué sous licence GPLv2 ;
le cœur compilé `public/core/psx.wasm` en dérive et reste soumis à cette licence
(sources : <https://github.com/libretro/pcsx_rearmed>, plus `core/frontend.c`).
