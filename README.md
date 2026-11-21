# Cochons de Guerre en ligne

Le jeu PlayStation **Cochons de Guerre** (*Hogs of War*, Infogrames, 2000),
jouable à plusieurs en ligne dans le navigateur.

Le projet est basé sur le **CD français** du jeu (version PAL, référence
**SLES-02766**), et uniquement sur lui. Le code du jeu y est traduit en C par
recompilation statique ([psxrecomp](https://github.com/RetroPortingToolKit/psxrecomp)),
puis compilé en WebAssembly. Chaque joueur fait tourner le jeu dans son
navigateur : l'IA de la version PlayStation, les textes, voix et sons
français sont ceux du disque. Le serveur envoie le disque aux navigateurs et
relaie les commandes des joueurs, qui jouent en lockstep : chaque navigateur
calcule exactement la même partie.

En plus du jeu original : affichage large de 4:3 à 32:9 (chaque joueur a sa
propre forme d'écran), chargements instantanés et IA ennemie plus rapide.

## Démarrage

Il vous faut votre propre copie du **CD français** : le fichier `.cue`, ses
trois pistes `.bin` et le fichier `.sbi`, ou une archive `.zip` qui les
contient. Le `.sbi` est indispensable : le CD français est protégé (LibCrypt)
et, sans ce fichier, le jeu ne se comporte pas comme l'original. Aucune autre
version du jeu n'est acceptée (le disque est vérifié).

```bash
git clone --recurse-submodules https://github.com/V1ck3s/hogs-of-war-web.git
cd hogs-of-war-web
# mettez votre CD dans le dossier disc/
./start.sh
```

Puis ouvrez **http://localhost:8090**, créez un salon et envoyez le lien
d'invitation à vos amis (pour jouer hors de votre réseau, le port 8090 doit
être joignable depuis Internet).

`start.sh` fait tout le reste et ne refait que ce qui manque ou a changé :

1. extrait le CD s'il est dans une archive `.zip` ;
2. installe les paquets système manquants (il demande avant d'utiliser
   `sudo apt-get`) et, une seule fois, Emscripten (environ 2 Go, dans
   `.cache/emsdk`) ;
3. vérifie le CD, en fait une copie de travail dans `cochons/disc/` et
   traduit le code du jeu en C (`cochons/generated/`) ;
4. compile le jeu en WebAssembly (`cochons/build-web/`), y compris le code
   que le jeu charge en cours de partie, reconstruit à partir du CD
   (`cochons/tools/build_caps.py`) ;
5. prépare les fichiers envoyés aux navigateurs (`online/game/`) et démarre
   le serveur.

La première fois, comptez de 20 minutes à une heure selon la machine. Si le
script est interrompu, relancez-le : il reprend où il s'était arrêté. Ensuite,
il démarre le serveur en quelques secondes.

Système : Linux (testé sur Debian 13), 2 Go de mémoire au minimum et environ
6 Go d'espace disque. Les paquets utilisés sont `git python3 cmake ninja-build
clang nodejs npm xz-utils bzip2` (Python 3.11 et Node.js 18 au minimum).

Variables utiles : `PORT` (8090), `HOST` (0.0.0.0), `CDG_JOBS` (nombre de
compilations en parallèle ; par défaut d'après la mémoire), `EMSDK` (un
Emscripten déjà installé), `CDG_BUILD_ONLY=1` (tout préparer sans démarrer le
serveur), `CDG_YES=1` (installer les paquets sans demander).

## Contenu du dépôt

| Dossier | Rôle |
|---|---|
| `cochons/` | configuration de la recompilation du CD français (adresses, correctifs, mods) |
| `online/` | serveur de jeu et page web (lockstep, streaming du disque, tests) |
| `psxrecomp/` | le moteur de recompilation et d'exécution (sous-module, branche `psxrecomp` de ce dépôt) |
| `web/`, `stream/` | essais précédents (émulation dans le navigateur, streaming vidéo), remplacés par `online/` |

Les dossiers `disc/`, `cochons/disc/`, `cochons/generated/`, `cochons/build*/`,
`online/game/` et `.cache/` sont produits à partir de votre CD et ne sont
jamais versionnés.

## Mentions légales

Ce dépôt ne contient aucune donnée du jeu : pas d'image disque, pas de code
exécutable ni de ressources du jeu original, pas de BIOS PlayStation (le BIOS
libre OpenBIOS fourni avec psxrecomp est utilisé). Le code traduit est produit
sur votre machine à partir de votre propre CD.

*Hogs of War* et *Cochons de Guerre* sont des marques de leurs propriétaires
respectifs ; PlayStation est une marque de Sony Interactive Entertainment. Ce
projet est un projet de fan, non officiel et non commercial, sans lien avec
eux.

## Licence

[PolyForm Noncommercial License 1.0.0](LICENSE) : vous pouvez utiliser,
modifier et partager ce projet pour tout usage non commercial. Le moteur
psxrecomp est publié séparément sous les mêmes conditions par son auteur.

## Crédits

- [psxrecomp](https://github.com/RetroPortingToolKit/psxrecomp), de Matthew
  Stanley et de l'équipe RetroPortingToolKit, PolyForm Noncommercial 1.0.0
