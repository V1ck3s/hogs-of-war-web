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
  format d'écran** de 4:3 à 21:9 ;
- le code que le jeu charge en cours de partie (modules de bataille, lecteur
  de cinématiques) est **compilé en natif en arrière-plan** (gcc) et conservé
  en cache.

```
navigateur ──WebSocket──► stream/server ──► jeu natif (Xvfb + OpenGL, PulseAudio)
   ▲  H.264 + Opus (WebCodecs)              │ x11grab → x264 (zerolatency)
   └─────────────────────────────────────── │ pulse   → Opus 20 ms
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
taille, sa résolution ou son format (16:9, 21:9, 4:3, 16:10, portrait — avec
bandes noires si nécessaire), nette sur les écrans haute densité. L'écran de
l'hôte fixe le champ de vision : sur un écran 21:9 le jeu montre un champ de
bataille plus large (pas d'étirement). L'hôte choisit aussi la qualité (480p,
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
| `CDG_RENDERER` | `opengl` | `software` : moteur de rendu PS1 logiciel du runtime (serveur sans GPU) |
| `CDG_OVERCLOCK` | 200 | vitesse du CPU émulé en % (100 = d'origine) ; à 200 % les attentes actives sont court-circuitées |
| `CDG_60HZ` | 1 | mode 60 Hz de Frontschweine (batailles à 30 i/s au lieu de 25) ; 0 = 50 Hz PAL d'origine |

Performances : le jeu doit tenir le temps réel côté serveur, sinon le son
diffusé a des trous. Mesures sur la machine de développement (CPU virtuel QEMU
générique à 1,8 GHz, sans GPU, ~3 à 4 fois plus lent qu'un processeur de
bureau récent) : cinématique 37 i/s sur 60, bataille ~15 i/s. Le profil montre
~45 % du temps dans le rendu OpenGL logiciel (llvmpipe) : un serveur avec GPU
(`LIBGL_ALWAYS_SOFTWARE=0`) ou un CPU moderne suffit pour 60 i/s. La première
visite de chaque partie du jeu alimente le cache de compilation native
(`cochons/build/cache`) ; les visites suivantes sont plus rapides.

## Tests

```bash
npm test                       # analyseurs H.264/Ogg, arbitre de la manette
node tests/e2e.mjs             # Chromium : salon, vidéo + son décodés, clavier → jeu, 2 joueurs
```

## Mentions légales

Projet de fan non officiel et non commercial. *Hogs of War* / *Cochons de
Guerre* appartiennent à leurs ayants droit. Le dépôt ne contient aucune donnée
du jeu : l'exploitant du serveur compile le jeu à partir de **son propre
disque**. Réservez le serveur à votre usage et à celui de vos amis.
