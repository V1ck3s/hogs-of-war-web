# Cochons de Guerre — en ligne (streaming)

**Cochons de Guerre** (*Hogs of War*, Infogrames, 2000) dans sa **version
PlayStation française**, jouée dans le navigateur **sans posséder le jeu** :
il tourne sur le serveur et il est diffusé en vidéo aux joueurs, qui jouent au
clavier (ou à la manette), seuls ou **à plusieurs à distance**.

## Ce qui tourne sur le serveur

Ce n'est pas un émulateur PlayStation. Le jeu est la **recompilation
statique** de la version française PS1 (SLES-02766), construite avec le même
framework et les mêmes réglages que le projet Frontschweine de ce dépôt
(`psxrecomp`) : le code MIPS du jeu est traduit en C et compilé en programme
Linux natif. La logique du jeu est donc exécutée nativement :

- **IA PS1**, règles, physique : c'est le code de la version PlayStation (pas
  celui de la version PC), exécuté nativement ;
- **textes, briefings, voix et sons français** : ceux du disque français ;
- rendu moderne : OpenGL, résolution interne ×1 à ×3 (480p/720p/1080p),
  écran large (« widescreen hack » de psxrecomp) adapté **à n'importe quel
  format d'écran** de 4:3 à 32:9 (super-ultralarge, ex. 5120x1440) ;
- le code que le jeu charge en cours de partie (modules de bataille, lecteur
  de cinématiques) est **compilé en natif en arrière-plan** (gcc) et conservé
  en cache.

```
navigateur ──WebSocket──► stream/server ──► jeu natif (Xvfb + OpenGL, PulseAudio)
   ▲  H.264 + Opus (WebCodecs)              │ x11grab → x264 (zerolatency)
   └─────────────────────────────────────── │ sortie SPU du jeu → Opus 20 ms
        état de la manette (clavier) ──────► port de contrôle TCP du runtime (manette 1)
```

## Jouer

1. Ouvrez l'adresse du serveur, entrez un nom, **Lancer une partie**.
2. Partagez le code du salon (ou le bouton **Copier le lien d'invitation**).
3. Les amis ouvrent le lien : même image, même son, aucune installation.
4. Dans le jeu : **MULTIJOUEUR**, un emplacement **JOUEUR** par participant.

Cochons de Guerre se joue **au tour par tour sur la manette 1** (chaque équipe
joue son tour sur la même manette, comme sur PlayStation). Le salon partage
cette manette : celui qui joue garde la main ; après 2 secondes sans action, le
prochain joueur qui appuie sur un bouton la prend. Le panneau (Échap) indique
qui a la manette.

| PlayStation | Clavier |
|---|---|
| Croix directionnelle | Flèches |
| Croix / Rond / Carré / Triangle | X (ou Espace) / C / S / D |
| L1 / R1 / L2 / R2 | E / R / F / G |
| Start / Select | Entrée / Retour arrière |

Touches modifiables (bouton **Touches**), manettes USB/Bluetooth reconnues.
Échap : panneau du salon · T : discuter · F11 : plein écran.

**N'importe quel écran** : l'image remplit la fenêtre quelle que soit sa
taille, sa résolution ou son format (16:9, 21:9, 32:9, 4:3, 16:10, portrait — avec
bandes noires si nécessaire), nette sur les écrans haute densité. L'écran de
l'hôte fixe le champ de vision : sur un écran 21:9 ou 32:9 le jeu montre un champ de
bataille plus large (pas d'étirement ; les menus 2D restent en 4:3 au centre).
En 32:9, mesuré sur ce serveur sans GPU en 360p : bataille à 44 Hz au lieu de
50 (le champ plus large coûte plus cher à rendre). L'hôte choisit aussi la qualité (480p,
720p, 1080p) et peut **accélérer** les tours des équipes CPU.

## Installer le serveur

Prérequis (Debian/Ubuntu) : `nodejs` (≥ 20), `ffmpeg`, `xvfb`, `xdotool`,
`pulseaudio`, `mesa` (ou un GPU), et la compilation du jeu :

```bash
# 1. compiler le jeu français (à partir de votre disque, jamais versionné)
python3 psxrecomp/psxrecomp_cli.py generate --project-root cochons --config cochons/game.toml \
        --disc "/chemin/Cochons de Guerre, Les (France).cue"
cmake -S cochons -B cochons/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DPSX_DEBUG_TOOLS=ON -DPSX_REWIND=OFF -DPSX_ENABLE_VULKAN=OFF -DPSXRECOMP_REQUIRE_GAME_C=ON
ninja -C cochons/build psx-runtime
ln -s ../disc cochons/build/disc

# 2. serveur de streaming
cd stream && npm install
CDG_TLS_CERT=cert.pem CDG_TLS_KEY=key.pem PORT=8443 npm start
```

`PSX_DEBUG_TOOLS=ON` est nécessaire : le serveur pilote la manette 1 par le
port de contrôle TCP local du runtime (écoute sur localhost uniquement).

**HTTPS obligatoire** hors de `localhost` : les navigateurs n'autorisent le
décodage vidéo (WebCodecs) que dans un contexte sécurisé. Fournissez un
certificat (`CDG_TLS_CERT` / `CDG_TLS_KEY`) ou placez le serveur derrière un
proxy HTTPS (Caddy, nginx) qui transmet `/ws` en WebSocket.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT`, `HOST` | 8090, 0.0.0.0 | adresse d'écoute |
| `CDG_GAME_DIR` | `../cochons/build` | dossier de l'exécutable du jeu |
| `CDG_GAME_BIN` | `Cochons_de_Guerre` | nom de l'exécutable |
| `CDG_MAX_ROOMS` | 1 | parties simultanées (une partie ≈ 1 cœur CPU + ~800 Mo) |
| `CDG_AUTOCOMPILE` | `../cochons/autocompile.sh` | compilation native en arrière-plan |
| `LIBGL_ALWAYS_SOFTWARE` | 1 | 0 pour utiliser le GPU du serveur |
| `CDG_SSAA` | auto | résolution interne ×1..×4 (auto : selon la qualité avec GPU, ×1 en rendu logiciel) |
| `CDG_AUDIO_SOURCE` | `spu` | `spu` : échantillons lus directement dans la sortie SPU du jeu (aucun silence inséré même si le serveur prend du retard) ; `pulse` : capture de la carte son (PulseAudio) |
| `CDG_RENDERER` | `opengl` | `software` : moteur de rendu PS1 logiciel du runtime (serveur sans GPU) |
| `CDG_OVERCLOCK` | 200 | vitesse du CPU émulé en % (100 = d'origine) ; à 200 % les attentes actives sont court-circuitées |
| `CDG_60HZ` | 1 | mode 60 Hz de Frontschweine (batailles à 30 i/s au lieu de 25) ; 0 = 50 Hz PAL d'origine |

### Mode production (temps réel)

Pour la mise en ligne, compilez le jeu **sans outils de debug et avec PGO**
(optimisation guidée par profil) : le serveur pilote alors la manette 1 par
des événements clavier XTest dans l'écran virtuel (aucun port de contrôle) et
capte le son par PulseAudio.

```bash
cd cochons
CC=clang CXX=clang++ cmake -S . -B build-prod -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DPSX_DEBUG_TOOLS=OFF -DPSX_PGO=generate -DPSX_REWIND=OFF -DPSX_ENABLE_VULKAN=OFF -DPSXRECOMP_REQUIRE_GAME_C=ON
ninja -C build-prod psx-runtime
ln -s ../disc build-prod/disc; ln -s ../build/extracted build-prod/extracted; ln -s ../build/cache build-prod/cache
# entraînement : lancer le jeu (intro, menus, une bataille) puis le quitter (Ctrl+C), LLVM_PROFILE_FILE=pgo/xxx.profraw
llvm-profdata merge -o build-prod/pgo/default.profdata build-prod/pgo/*.profraw
cmake -S . -B build-prod -DPSX_PGO=use && ninja -C build-prod psx-runtime
cc -O2 ../stream/native/xkeys.c -o ../stream/native/xkeys -lX11 -lXtst

# serveur
CDG_GAME_DIR=../cochons/build-prod CDG_RENDERER=software CDG_60HZ=0 CDG_OVERCLOCK=100 \
CDG_GAME_CPUS=0,1,2 CDG_AUX_CPUS=3 npm start
```

Mesures sur la machine de développement (processeur virtuel générique à
1,8 GHz, 4 cœurs, sans GPU), cadence du jeu côté serveur pendant une session
de streaming avec deux joueurs distants (`tests/realtime-remote.mjs`, qualité
« Native PS1 » 480×270) :

| Phase | Cadence (50 Hz visés) |
|---|---|
| Cinématique d'introduction, film d'entraînement | 49,8 – 50,1 Hz |
| Écran titre, bataille (mode démo) | 49,9 – 50,1 Hz |
| Menu principal (touches pressées) | 47,9 – 50,0 Hz |
| **Moyenne sur 195 s** | **49,92 Hz** |

Vidéo reçue 49,9 img/s, son reçu 179,8 s pour 180 s. Avec deux vrais
navigateurs Chromium (hôte + invité) qui décodent et affichent le flux sur la
même machine (`tests/realtime.mjs`, 270p) : 50,03 Hz en moyenne (minimum
49,7), 50,1 img/s et 181 s de son reçus par l'invité, 0 sous-alimentation de
la lecture audio ; le son décodé par son navigateur est transcrit en français
(p = 0,98). Le mode 60 Hz n'atteint pas le temps réel sur cette machine (52 Hz
mesurés en bataille sur 60) : utilisez `CDG_60HZ=0` sur un serveur modeste. Sans ces optimisations
(build de debug, OpenGL logiciel) la même machine plafonnait à ~15 Hz en
bataille. Avec un GPU (`LIBGL_ALWAYS_SOFTWARE=0`, `CDG_RENDERER=opengl`) les
qualités 720p/1080p rendent la scène en résolution interne ×2/×3.

Les tests `e2e.mjs` et `playthrough.mjs` utilisent le build de debug
(`cochons/build`) pour lire l'état réel de la manette dans le jeu.

## Tests

```bash
npm test                       # analyseurs H.264/Ogg, arbitre de la manette
node tests/e2e.mjs             # Chromium : salon, vidéo + son décodés, clavier → jeu, 2 joueurs
node tests/playthrough.mjs out # partie complète au clavier via le flux (21:9), l'invité joue en bataille
node tests/voices.mjs joueur.wav 240  # son décodé par le navigateur du joueur pendant l'intro
```

Vérification des voix côté joueur : `tests/voices.mjs` enregistre l'Opus
décodé par le navigateur ; transcrit avec whisper.cpp (`small`), langue
détectée **français**, par exemple : « La truffe c'est la force du porc qui
contrôle la truffe, contrôle le monde… nous allons regarder ensemble des
petits films très bien fichus pour mieux comprendre les enjeux de cette
guerre ! ».

```bash
# (fin)
```

## Mentions légales

Projet de fan non officiel et non commercial. *Hogs of War* / *Cochons de
Guerre* appartiennent à leurs ayants droit. Le dépôt ne contient aucune donnée
du jeu : l'exploitant du serveur compile le jeu à partir de **son propre
disque**. Réservez le serveur à votre usage et à celui de vos amis.
