# Vérification de la migration Skia 3.7.4 / WebGPU 0.19.0 — 23 octobre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette migration :
- sur l'hôte ;
- sur **iPhone 15 Pro** (iOS 27.0.1) ;
- sur **Pixel 8a** (Android 17).

Tous les builds sont en Release. Les changements amont et les décisions sont dans l'[audit](upstream-audit.md).

> **Choix en attente.** Deux variantes de l'export Android sans EGL ont été mesurées : Skia dessine directement dans la texture de la fenêtre (« fenêtre directe »), ou dans deux textures à nous, copiées ensuite dans la fenêtre (« fenêtre + copie »). L'arbre de travail contient la seconde. Le choix n'est pas fait.

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.7.4, WebGPU 0.19.0 ; un seul `react-native-webgpu-dawn@157.0.0` |
| `apply-skia-canvas-patch.mjs` | Patch appliqué, puis « already applied » au second passage ; 3 fichiers, 8 éditions |
| `test-skia-patch-syntax.mjs` | Passé : les en-têtes patchés compilent contre Graphite et Dawn m157 |
| `test-skia-provider-ownership.mjs` | Passé, avec et sans sanitizers, sur la fabrique amont d'`ImageProvider` |
| Jest | **237/237 tests, 11 suites** |
| `tsc --noEmit`, `test:native`, `test:package`, `benchmark:test` | OK, OK, 5/5, 122/122 |
| `publint --strict` | OK |

## Natif

- **iOS :** `pod install` (Ruby 3.2.0) ; `Podfile.lock` ne change que sur Skia et WebGPU. Le build Release signé réussit.
- **iPhone 15 Pro, tests natifs :** 58 cas, **56 réussis, 0 échec**. Les 2 cas ignorés sont des diagnostics optionnels (`RNSKV_COLOR_DIAGNOSTICS`, `RNSKV_DECODE_BENCHMARK`).
- **Android :** le build Release arm64 réussit. Le bundle JS de chaque APK a été vérifié (Skia 3.7.4 et le code de la fenêtre présents).
- **Tests instrumentés Android : pas encore exécutés.** Le Pixel s'est déconnecté avant le lancement.

## Builds Android comparés

Le Pixel 8a a été mesuré en Release, sur secteur, état thermique *nominal* au départ de chaque run (attendu avant chaque lancement) et pendant tous les échantillons.

| Build | Skia / WebGPU | Export GPU Android |
| --- | --- | --- |
| `371` | 3.7.1 / 0.17.0 (`main`, beta.3) | AHB prêté + EGL |
| `374egl` (diagnostic) | 3.7.4 / 0.19.0 | AHB prêté + EGL, le code de `main` |
| `374b` | 3.7.4 / 0.19.0 | Fenêtre directe, espace colorimétrique corrigé |
| `374c` | 3.7.4 / 0.19.0 | Fenêtre + copie, espace colorimétrique corrigé |

Une première version de la fenêtre directe (`374`), sans la correction de l'espace colorimétrique, a été mesurée deux fois. Ses fichiers étaient en plage complète (voir plus bas). Ses temps ne sont pas retenus.

## Pixels (Pixel 8a)

Profil `interop` : décodage GPU contre décodage CPU sur 10 cas, puis export GPU contre export readback sur une mire et un clip décodé tourné.

| Build | Décodage, 10 cas | Écart max par cas | Export : mire / vidéo |
| --- | --- | --- | --- |
| 3.7.0 (19 oct.) | 10/10 | 1,1,0,0,1,1,0,0,1,1 | 0 / 0 |
| `374` (sans correction) | 10/10 | 1,1,0,0,1,1,0,0,1,1 | 1 / 1 |
| `374b` | 10/10 | 1,1,0,0,1,1,0,0,1,1 | **0 / 0** |
| `374c` | 10/10 | 1,1,0,0,1,1,0,0,1,1 | **0 / 0** |

**Espace colorimétrique.** Sans correction, ffprobe lit sur un export par la fenêtre `yuvj420p`, `color_range=pc`, `color_transfer=iec61966-2-1`, primaires et matrice BT.709. Le même cas exporté par `371` donne `yuv420p`, `tv`, `bt709` partout. Avec la correction (`374b`), l'export HEVC 1080p fait 1 096 125 octets comme en `371`. Son flux vidéo et ses images décodées ont la même empreinte md5 : seule la date de création du conteneur MP4 diffère. Dans les 7 cas mesurés, `374b` et `374c` produisent exactement le nombre d'octets de `371`.

**Horodatage.** Chaque export est sondé : nombre d'images égal à la demande, temps monotones et chacun à moins de 1 ms de `n/fps`. Tous les exports des quatre builds passent.

## Export (Pixel 8a, médianes de trois, ms)

| Cas | `371` | `374egl` | `374b` | `374c` |
| --- | --- | --- | --- | --- |
| `encode-h264-copy` (640×360, 60 images) | 1 276 | 1 302 | 1 187 | **1 065** (−17 %) |
| `encode-hevc-copy` (640×360, 60 images) | 1 280 | 1 280 | 1 203 | **1 121** (−12 %) |
| `native-hevc-1080p-rot270` (180 images) | 3 092 | 3 151 | 2 797 | **2 664** (−14 %) |
| `native-h264-720p-rot180` | 3 215 | 3 164 | 2 887 | **2 674** (−17 %) |
| `4k-x8-lazy-maxLongSide1280` (décodage EGL) | 12 617 | 12 562 | 12 119 | **12 077** (−4 %) |
| `4k-x3-simultaneous` (150 images) | 5 778 | 5 804 | 6 033 | 6 068 (+5 %) |
| `4k-x8-lazy` (360 images, 4K natif) | 10 759 | 10 508 | 12 004 | 12 575 (+17 %) |

Profil par image, en ms (répétition médiane) :

| Étape | HEVC 1080p `371` | HEVC 1080p `374c` | 8×4K natif `374egl` | 8×4K natif `374c` |
| --- | --- | --- | --- | --- |
| Décodage | 2,84 | 2,74 | 8,40 | 8,53 |
| Import | 3,58 | 3,62 | 5,51 | 5,79 |
| Cible (`target`) | 1,39 | 0,06 | 1,66 | 0,09 |
| Attente GPU | 1,78 | 1,47 | 6,80 | 11,97 |
| Encodage | 4,38 | 4,11 | 4,15 | 5,50 |
| Total | 15,4 | 13,4 | 28,4 | 33,7 |

Lecture :
- **La montée de Skia et WebGPU seule est neutre** : `374egl` reste à ±3 % de `371` sur les 7 cas.
- **L'export sans EGL accélère les exports 1080p et plus petits**, de 6 à 10 % en fenêtre directe et de 12 à 17 % avec la copie. La cible ne coûte presque plus rien : `374c` réutilise deux surfaces Skia au lieu d'envelopper une texture à chaque image, et ne prête plus de buffer.
- **Il ralentit le 8×4K natif** de 12 % (directe) à 17 % (copie), et le 3×4K simultané d'environ 5 %. Le temps perdu est de l'attente GPU, pas du travail de dessin. Il n'apparaît que lorsque le décodeur matériel décode du 4K pendant l'encodage. **La cause n'est pas établie.** L'hypothèse d'une attente du buffer rendu par l'encodeur a été testée par la variante avec copie : elle ne corrige pas ce cas. Une trace Perfetto des deux chemins sur ce cas est l'étape suivante.
- **Un run `374egl` a eu une répétition en échec** sur `4k-x8-lazy` : la mesure de lecture n'a trouvé aucune image stabilisée. Son export a réussi. L'échec n'a pas été revu sur les autres builds.
- **Pendant la première minute de `374`**, un script interrogeait le téléphone par adb toutes les 0,3 s. Ses temps ne sont pas retenus de toute façon.

## Aperçu (Pixel 8a)

Rappels de dessin par seconde pendant la lecture, médiane de trois :

| Cas | `371` | `374egl` | `374b` | `374c` |
| --- | --- | --- | --- | --- |
| `4k-x8-lazy` | 58,4 | 58,3 | 58,4 | 58,0 |
| `4k-x3-simultaneous` | 33,6 | 29,7 | 27,9 | 29,5 |

L'export sans EGL ne touche pas l'aperçu. Le 3×4K simultané baisse dans **tous** les builds 3.7.4, `374egl` compris : c'est un effet de Skia 3.7.4 (présentation Android sur un thread dédié, pool de recorders), pas de cette migration. Ce sont des rappels de dessin, pas des images présentées, et un seul run par build : à confirmer.

## iPhone 15 Pro

Protocole : `test-ios-device-ab-run.mjs`, trois répétitions par cas, ordre 3.7.4, 3.7.1, 3.7.4, hors chargeur, état *nominal* sur tous les échantillons. Une première tentative a échoué avant toute mesure, le téléphone s'étant verrouillé (`*-locked`).

| Cas (médiane, ms) | 3.7.4 (1) | 3.7.1 | 3.7.4 (2) |
| --- | --- | --- | --- |
| `4k-x8-lazy-maxLongSide1280` | 2 683 | 2 690 | 2 739 |
| `native-hevc-1080p-rot270` | 737 | 730 | 749 |
| `encode-h264-copy` | 217 | 177 | 185 |

- **iOS est neutre en médiane** ; les octets produits sont identiques entre versions pour le 8×4K et le HEVC.
- **Répétitions lentes en 3.7.4 :** 4 sur 18, contre 0 sur 9 en 3.7.1. Pour le HEVC à 930 ms, toute la boucle ralentit (attente GPU 423 contre 295 ms) : un ralentissement passager du système. Pour le H.264 à 254 et 275 ms, la boucle par image est identique ; 30 à 90 ms de plus se passent hors de la boucle, à la préparation ou à la fermeture de l'export. Non expliqué.
- **Profil `smoke` 3.7.4 :** 5/5 cas réussis.

## Reprise du 24 octobre (Pixel 8a)

`371` a été reconstruit depuis `main`, `374c` depuis l'arbre de travail (fenêtre + copie). Ordre des runs : `374c`, `371`, `374c`, `371`, `374c`. Téléphone sur secteur, état *nominal* avant chaque lancement et sur tous les échantillons. Le premier run `374c` a été lancé avant l'ajout des cas 4K. Un run `374c` a été interrompu par un toucher de l'écran (activité fermée à 10:00:48) et relancé ; le run interrompu n'a produit aucun résultat.

**Cas ajoutés.** Aucun cas n'exportait en 4K : tous les cas de composition sortent en 1080×1080, et le « 4k » des noms désigne les sources. Deux cas sont ajoutés en fin de catalogue ; les 62 cas d'origine gardent leur empreinte :
- fixture `real-bridge-4k30-long` : `real-bridge-h264-3840x2160-30` (44 Mb/s) bouclée cinq fois par copie de flux, soit 30 s et 900 images à 1/30 s ;
- `export-4k-h264` et `export-4k-hevc` : ce clip seul, exporté en 3840×2160 à 40 Mb/s.

Médianes de toutes les répétitions (`371` : 6 ; `374c` : 9, ou 6 pour les cas 4K) :

| Cas | `371` | `374c` | Écart | Attente GPU, ms/image |
| --- | --- | --- | --- | --- |
| `export-4k-h264` (1 clip 4K → 4K, 900 images) | 25 385 | 24 709 | **−3 %** | 8,4 → 8,8 |
| `export-4k-hevc` | 25 910 | 24 300 | **−6 %** | 8,6 → 8,7 |
| `4k-x8-lazy` (8 clips 4K → 1080) | 9 881 | 12 255 | **+24 %** | 5,6 → 10,5 |
| `4k-x8-lazy-maxLongSide1280` | 12 762 | 12 062 | −5 % | 2,5 → 2,1 |
| `4k-x3-simultaneous` | 5 682 | 5 808 | +2 % | 8,9 → 11,1 |
| `native-h264-720p-rot180` | 3 152 | 2 672 | −15 % | 2,1 → 1,3 |
| `native-hevc-1080p-rot270` | 3 175 | 2 751 | −13 % | 1,9 → 1,5 |
| `encode-h264-copy` | 1 257 | 1 120 | −11 % | 1,9 → 1,4 |
| `encode-hevc-copy` | 1 288 | 1 109 | −14 % | 2,0 → 1,3 |

Lecture :
- **Un export 4K est plus rapide en 3.7.4.** Les deux builds écrivent les mêmes octets, 900 images, horodatages exacts, en 3840×2160 H.264 ou HEVC.
- **Seul le montage de 8 clips 4K en pleine résolution régresse**, de 24 % aujourd'hui. Hier l'écart était de 17 % : `371` a été plus rapide aujourd'hui (9,9 s contre 10,8 s), alors que `374c` reste entre 12,2 et 12,6 s. L'attente GPU double.
- **Ce qui ne suffit pas à déclencher la régression :**
  - une sortie 4K (`export-4k-*`) ;
  - le décodage et l'import d'une image 4K à chaque image (même cas) ;
  - la succession de 8 clips avec ouverture de décodeurs (`maxLongSide1280` : mêmes clips, −5 %).

  Ce qui distingue `4k-x8-lazy` : des clips 4K successifs en pleine résolution, réduits vers une sortie 1080, en contenu synthétique. La cause n'est toujours pas établie.
- **Lecture de `4k-x8-lazy` :** 2 répétitions sur 3 ont échoué au premier run `374c` (« no valid settled frames », l'export a réussi). Les 6 répétitions suivantes de `374c` et les 6 de `371` ont réussi.

## Cause de la régression 8×4K (Perfetto, Pixel 8a)

Traces des deux builds sur `4k-x8-lazy`, avec les événements d'ordonnancement, les compteurs `gpufreq` et les tranches atrace `gfx` et `video` :
- **L'encodeur n'est pas en cause.** À chaque acquisition de la swapchain, le buffer qu'il rend est déjà libre (`HWC release fence … has signaled`).
- **Le travail GPU par image est le même** dans les deux builds : la conversion YUV 4K et le dessin, environ 16 ms à 160 MHz.
- **La boucle d'export était entièrement sérialisée.** Le CPU attendait le GPU après chaque dessin, puis le GPU s'éteignait pendant que le CPU décodait l'image suivante. Le régulateur Mali, bistable, restait alors à 160 MHz pendant 75 % du temps actif en 3.7.4. En 3.7.1, le blit EGL ajoutait assez de travail pour qu'il monte à 386–531 MHz.
- **Le mode « performance fixe » d'Android** (`cmd power set-fixed-performance-mode-enabled`) fige le CPU mais pas le GPU : l'écart d'attente GPU reste le même, et la fréquence GPU aussi.

## Améliorations du 24 octobre

Trois changements, non commités, mesurés chacun sur le Pixel :
1. **Attente GPU différée.** Sur le chemin fenêtre, le dessin est soumis sans attente (`flush(false)`). L'attente vérifiée se fait une fois l'image suivante décodée, avant toute libération, et au début de `finish()`. Le GPU dessine l'image N pendant que le CPU décode l'image N+1. Les baux du décodeur ne sont toujours rendus qu'après cette attente.
2. **`ImageReader` pour les tailles plafonnées ou explicites.** `maxLongSide` et `resolution` ne repassent plus par le rendu EGL : le codec garde ses buffers YUV, et la conversion WebGPU les met à la taille de la frame (`yuvFrameRegion`). Les octets de ces exports changent, puisque la réduction bilinéaire se fait maintenant en WebGPU ; le contrôle de pixels passe.
3. **Indices de performance Android (ADPF).** Le thread d'export ouvre une session `APerformanceHint` (cible : un quart du budget d'une image) et rapporte la durée de chaque image, avec sa part GPU depuis Android 15 ([ExportHintSession](../../android/cpp/ExportHintSession.cpp)). `dumpsys performance_hint` montre la session pendant l'export.

Médianes en ms : 3.7.1 sur 9 répétitions (3 runs), 3.7.4 commité sur 9, version finale sur 6 (2 runs, `374g` et `374i`). État thermique *nominal* partout.

| Cas | 3.7.1 | 3.7.4 commité | Final | vs 3.7.1 |
| --- | --- | --- | --- | --- |
| `4k-x8-lazy` (8 clips 4K → 1080) | 9 775 | 12 255 | **6 969** | **−29 %** |
| `4k-x8-lazy-maxLongSide1280` | 12 677 | 12 062 | **6 953** | **−45 %** |
| `4k-x3-simultaneous` | 5 636 | 5 808 | **3 452** | **−39 %** |
| `native-h264-720p-rot180` | 3 074 | 2 672 | **1 816** | **−41 %** |
| `native-hevc-1080p-rot270` | 3 120 | 2 751 | **2 080** | **−33 %** |
| `encode-h264-copy` | 1 251 | 1 120 | **854** | **−32 %** |
| `encode-hevc-copy` | 1 272 | 1 109 | **849** | **−33 %** |
| `export-4k-h264` (1 clip 4K → 4K) | 25 280 | 24 709 | **23 014** | −9 % |
| `export-4k-hevc` | 25 754 | 24 300 | **22 339** | −13 % |

Contribution de chaque étape (un run de chaque, mêmes cas) :

| Cas | 3.7.4 commité | + attente différée | + `ImageReader` plafonné | + ADPF |
| --- | --- | --- | --- | --- |
| `4k-x8-lazy` | 12 255 | 8 345 | 8 378 | 6 948 |
| `4k-x8-lazy-maxLongSide1280` | 12 076 | 11 942 | 7 424 | 6 904 |
| `native-h264-720p-rot180` | 2 646 | 2 447 | 2 614 | 1 851 |
| `export-4k-hevc` | 24 090 | 22 737 | 22 715 | 22 016 |

Lecture :
- **L'export 4K → 4K reste limité par l'encodeur 4K** : l'étape d'encodage passe à 14–16 ms par image.
- **Contrôles de correction :**
  - mêmes octets que le 3.7.4 commité pour tous les cas non plafonnés ;
  - nombre d'images et horodatages exacts ;
  - contrôle de pixels (`interop`) réussi sur chaque variante ;
  - Jest 238/238, tests benchmark 122/122, tests natifs et JVM réussis.
- **Tests instrumentés Android : 126/127.** Le seul échec, `BigMontageTest.aLazyPreviewOfEight4KClipsPlaysThrough` (33 images à l'heure sur 150 attendues), se reproduit sur `main` (37) : il dépend de l'état du téléphone, pas de la migration.
- **Octets variables d'une répétition à l'autre.** Certaines répétitions produisent un fichier un peu différent : 166 751 au lieu de 161 131 octets pour `encode-h264-copy`, deux fois sur dix. Les fichiers capturés montrent une image clé de plus (image 54), puis 6 images décodées très proches (PSNR ≥ 64,7 dB) ; aucune image n'est décalée ni fausse. C'est une décision de l'encodeur, qui touche aussi 3.7.1 (`4k-x3-simultaneous`, `4k-x8-lazy`).
- **Piste écartée : la lecture YUV directe par Graphite.** Elle supprime la passe de conversion (attente GPU 2,7 → 1,2 ms par image en 8×4K) sans changer la durée des exports, le codec limitant désormais le débit, et elle change les pixels. Voir [UPSTREAM_NOTES](../../docs/UPSTREAM_NOTES.md#piste-testée--graphite-échantillonne-le-yuv-du-décodeur--24-octobre-2026).

## Reste à faire

- Committer les trois améliorations ci-dessus.
- **iPhone 15 Pro, profil `smoke` de la version finale : 5/5** (`ios-374i-smoke-4`, état *nominal*). Exports : `4k-x8-lazy-maxLongSide1280` en 2 710 ms et `encode-h264-copy` en 134 ms, horodatages exacts.
  - Le run précédent, sur la même build, avait échoué une fois. Pendant la lecture, `importExternalTexture()` a refusé une image NV12 (IOSurface) après environ 6 s, et les 3 cas suivants ont été ignorés.
  - Ce chemin iOS n'est pas modifié par ces changements, et l'échec ne s'est pas reproduit. Il est survenu juste après un essai interrompu par un iPhone verrouillé.
  - Six runs `smoke` ont suivi, alternés entre la version finale et `6f2e2f9` (`ios-final-smoke-r1..3`, `ios-head-smoke-r1..3`) : tous 5/5, état *nominal*.
  - Sans reproduction, l'échec est le plus probablement lié au verrouillage du téléphone (iOS refuse le travail GPU d'une app qui n'est pas au premier plan). À surveiller lors des prochains passages iPhone.
- L'app iOS pèse maintenant 342 Mo, dont 166 Mo pour la fixture 4K longue. Sur un iPhone joint en Wi-Fi, son installation dépasse parfois le délai de 30 s que le runner impose à `devicectl` ; une deuxième tentative passe.
- Le module de benchmark lit la mémoire de l'app toutes les 100 ms (`Debug.getMemoryInfo`), ce qui occupe environ la moitié d'un cœur pendant toutes les mesures : à réduire pendant les exports chronométrés.
