# Vérification de la migration Skia 3.9.1 / WebGPU 0.21.0 — 4 novembre 2026

**Résultat : Skia 3.9.1, avec un correctif de l'aperçu de notre côté.**
- Telle quelle, la 3.9.1 faisait perdre un tiers des images à l'aperçu iPhone des sources 4K60 en taille native (voir « Régression » et « Bisection » plus bas).
- La cause est dans notre aperçu : il attendait le GPU sur le thread UI à chaque image et à chaque import. Le correctif (voir « Correctif de l'aperçu ») soumet sans attendre et rend les tampons du décodeur quand le GPU a fini.
- Avec le correctif, le profil `sync` de l'iPhone revient au niveau de la 3.8.1 (43/58), et l'aperçu tourne deux fois plus vite en 4K60 (~120 rappels par seconde au lieu de 60).
- Reste le 4K60 en RGBA sur iPhone, au niveau de la 3.9.1 sans correctif. Ce n'est pas le format par défaut.

Ce document liste ce qui a **réellement** été exécuté pour cette migration. Tous les builds sont en Release. La base de comparaison est `main` (`502fef2`, Skia 3.8.1 / WebGPU 0.19.2), construite dans un worktree séparé et mesurée le même jour sur les mêmes téléphones.

## Changements amont

- **Dawn et Graphite passent de 157.0.0 à 157.1.0.** Skia 3.9.x et WebGPU 0.20+ dépendent tous deux de `react-native-webgpu-dawn@157.1.0`. La montée est donc commune : un seul Dawn est résolu.
- **3.9.0, readbacks asynchrones** ([#4368](https://github.com/wcandillon/react-native-skia/pull/4368)) :
  - `canvas.readPixels`, `image.readPixels`, `encodeToBytes` et `encodeToBase64` renvoient une `Promise`.
  - `makeRasterImageSync` disparaît, ainsi que `DawnContext::readPixelsSync` et `MakeRasterImage` côté C++.
  - `canvas.readPixels` ne prend plus de tableau de destination ni de pas de ligne : il remplit un tableau neuf, copié sur le runtime appelant.
  - La promesse se résout sur le runtime qui l'a demandée, y compris un runtime de worklet créé par l'application, comme celui de l'export.
- **3.9.0, autres changements :**
  - iOS retient le travail GPU tant que l'application est en arrière-plan (toggle Dawn `metal_suspend_submissions_in_background`, [#4373](https://github.com/wcandillon/react-native-skia/pull/4373)). Les soumissions sont différées au lieu d'être refusées.
  - Le GPU est sondé au premier usage au lieu d'un thread dédié ([#4366](https://github.com/wcandillon/react-native-skia/pull/4366)).
  - `Skia.gpu.foreground` apparaît.
  - Sur les GPU Imagination, les `TransientAttachments` ne sont plus demandées ([#4375](https://github.com/wcandillon/react-native-skia/pull/4375)).
- **3.9.1 :**
  - Une vue présente une seule recording par vsync et remet les autres en file ([#4386](https://github.com/wcandillon/react-native-skia/pull/4386)).
  - Toutes les frames d'une vue sont enregistrées sur le même thread de rendu ([#4389](https://github.com/wcandillon/react-native-skia/pull/4389)).
- **WebGPU 0.20.0 et 0.21.0 :** pas de GPU en arrière-plan sur iOS ([#580](https://github.com/wcandillon/react-native-webgpu/pull/580)), promesses résolues sur le runtime demandeur ([#598](https://github.com/wcandillon/react-native-webgpu/pull/598)) et cache des pipelines Dawn conservé d'un lancement à l'autre ([#594](https://github.com/wcandillon/react-native-webgpu/pull/594)).
- **Patch local :**
  - Sur les trois fichiers patchés, `JsiSkSurface.h` est identique octet pour octet. `RNDawnContext.h` et `JsiSkApi.h` changent en amont, mais les 8 ancres du patch s'y retrouvent chacune une fois.
  - Le corps du patch est identique à celui de la 3.8.1 ; seuls les décalages de hunks changent.
  - Les fonctions internes dont dépendent les soumissions vérifiées (`generationOf`, `trimThreadRecorders`, `getRecorder`, `insertRecording`) sont toujours là.
  - [#4276](https://github.com/wcandillon/react-native-skia/pull/4276) est toujours ouverte : le patch ne rétrécit pas.

## Changements de code

- **Export, chemin de secours par readback CPU** (`src/exportVideoComposition.ts`) :
  - La lecture est demandée dans la portée synchrone du dessin.
  - L'image est encodée une fois la promesse résolue, hors de cette portée.
  - Le tampon de readback réutilisable disparaît, puisque Skia alloue un tableau à chaque image. La réservation mémoire reste à 2 × la taille d'une image.
  - Le contrôle passe de `instanceof Uint8Array` à `ArrayBuffer.isView`, qui vaut pour un tableau de n'importe quel realm.
  - Le chemin GPU direct, utilisé par défaut sur iPhone et Pixel, n'est pas touché.
- **Tests Jest :** les mocks de `readPixels` suivent la nouvelle signature. Le test « un seul tampon de readback réutilisé » devient « chaque image encode les pixels que sa lecture a rendus ».
- **Aperçu** (`src/videoCompositionPlayer.ts`, `src/frameInterop.ts`, `src/memory.ts`) : voir « Correctif de l'aperçu ».
- **Contrôles de l'exemple** (`android-interop-smoke.ts`, `export-pixel-check.ts`, `frame-sync-check.tsx`) : les lectures sont attendues.
  - Dans l'aperçu, `readFrameCodes` ne peut pas attendre dans `drawFrame`. Le tirage est donc noté « en attente » (`-3`), puis résolu par numéro d'image distincte une fois la lecture arrivée.
  - Le coût mesuré sur le thread UI (`readbackMs`) n'est plus que celui de la demande, et non plus l'aller-retour GPU.
  - Une erreur du lecteur est désormais rapportée comme échec du cas. Avant, elle remettait le lecteur à `null`, ce qui annulait le cas sans rapport : le profil attendait indéfiniment (vu sur appareil, run bloqué 10 minutes).

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.9.1 et WebGPU 0.21.0 ; un seul `react-native-webgpu-dawn@157.1.0` |
| `apply-skia-canvas-patch.mjs` | Patch appliqué, puis « already applied » au second passage |
| `test-skia-patch-syntax.mjs` | Passé contre Graphite et Dawn m157.1 |
| Jest | **247/247 tests, 11 suites** (238 avant la migration ; 9 tests ajoutés pour le correctif de l'aperçu) |
| `tsc --noEmit`, `test:package`, `benchmark:test` | OK, 5/5, 122/122 |
| `test:native` ; `--pure-only --asan` | Passé ; passé avec sanitizers |
| `npm run build`, `publint --strict` | OK, OK |

## Pixel 8a (Android 17)

- **Build :** `assembleRelease` arm64 après suppression du bundle JS généré. L'APK contient le nouveau code d'export. Il est signé avec la clé de debug, comme les précédents.
- **`interop` :** passé.
  - Les 10 cas de décodage sont identiques aux migrations précédentes (écart maximal par cas : 1,1,0,0,1,1,0,0,1,1).
  - Export GPU contre export par readback : le chemin readback est bien emprunté (`readbackTransportUsed`), les couleurs sont en place et les deux chemins concordent, sur la mire comme sur la vidéo. C'est la vérification sur appareil du readback asynchrone.
- **`smoke` :** 5/5.
- **`sync`, 3.9.1 contre 3.8.1 lancés le même jour :**
  - Une seule différence de statut. `preview-24` échoue sur l'irrégularité de cadence (6,1 % contre 3,8 %, seuil 5 %) avec 100 % d'images exactes : c'est le pulldown 24 → 60 Hz.
  - Les 16 exports sont exacts sur les deux builds. Les cas de couleurs et de rendu sont identiques.
  - L'aperçu 4K60 HEVC est meilleur : 93,6 → 96,6 % d'images exactes, 333 → 348 images distinctes sur 360. En RGBA HEVC 60 : 85,2 → 99,4 %.
  - Les échecs restants existaient déjà en 3.8.1 comme le 21 octobre : critères stricts de diagnostic.
- **A/B d'export :** ordre 3.9.1, 3.8.1, 3.9.1, 3.8.1 ; trois répétitions par cas ; état thermique 0 avant chaque run. Médianes en ms :

| Cas | 3.8.1 | 3.9.1 | Écart |
| --- | --- | --- | --- |
| `encode-h264-copy` | 869 | 838 | −3,6 % |
| `encode-hevc-copy` | 866 | 862 | −0,4 % |
| `native-hevc-1080p-rot270` | 2 006 | 2 009 | 0 % |
| `native-h264-720p-rot180` | 1 754 | 1 792 | +2,2 % |
| `4k-x8-lazy-maxLongSide1280` | 6 856 | 6 951 | +1,4 % |
| `4k-x8-lazy` | 6 943 | 7 000 | +0,8 % |
| `4k-x3-simultaneous` | 3 471 | 3 424 | −1,4 % |
| `export-4k-hevc` (900 images 4K) | 22 127 | 22 183 | +0,3 % |

- **Lecture de l'A/B :**
  - Le profil par image (décodage, import, attente GPU, encodage) est inchangé à ±0,3 ms.
  - Le rythme de l'aperçu est inchangé : ~58,5 rappels par seconde, et 29,5 → 30,4 pour 3×4K.
  - Deux répétitions du premier run 3.9.1 ont échoué dans la phase de lecture, avec « Too many missing settled frames during playback » (`4k-x8-lazy`, `4k-x8-lazy-maxLongSide1280`). Elles n'ont pas d'export mesuré.
  - Ces échecs ne se reproduisent pas dans le second run 3.9.1. Le même échec était apparu une fois pendant la campagne 3.7.4.

## iPhone 15 Pro

- **Signature :** l'application de test est désormais signée par l'équipe FAHBE (`--team 459X9GHXRP`). L'équipe personnelle gratuite exigeait de faire à nouveau confiance au certificat. L'ancienne copie, signée par l'autre équipe, a été désinstallée.
- **Tests natifs :** **58 exécutés, 0 échec, 2 ignorés**.
- **`smoke` :** 5/5.
- **A/B d'export :** ordre 3.9.1, 3.8.1, 3.9.1, 3.8.1 ; trois répétitions ; 96/96 répétitions réussies ; état thermique *nominal* partout. Médianes en ms :

| Cas | 3.8.1 | 3.9.1 | Écart |
| --- | --- | --- | --- |
| `encode-h264-copy` | 175 | 177 | +1,5 % |
| `encode-hevc-copy` | 183 | 178 | −2,4 % |
| `native-hevc-1080p-rot270` | 736 | 736 | 0 % |
| `native-h264-720p-rot180` | 745 | 746 | 0 % |
| `4k-x8-lazy-maxLongSide1280` | 2 740 | 2 773 | +1,2 % |
| `4k-x8-lazy` | 3 054 | 3 061 | +0,2 % |
| `4k-x3-simultaneous` | 2 045 | 2 049 | +0,2 % |
| `export-4k-hevc` | 20 386 | 20 360 | −0,1 % |

### Régression : aperçu des sources 4K en taille native sur iOS

- **Rappels de dessin pendant la lecture :**
  - `4k-x3-simultaneous` (A/B) : 48,9 → 41,6 par seconde (−15 %), dans les deux runs. Aucune image source n'est manquée (`missingFrames` 0 sur les 12 répétitions ; source à 30 i/s).
  - `4k-x8-lazy` monte de 103,9 à 111,1.
- **Contrôle `sync`**, lancé deux fois dans les deux ordres. Images distinctes affichées et rappels par seconde :

| Cas | 3.8.1 (1) | 3.9.1 (1) | 3.8.1 (2) | 3.9.1 (2) |
| --- | --- | --- | --- | --- |
| `preview-4k-hevc-60-noread` | 353/360, 59,7 | **248/360, 40,6** | 356/360, 60 | **203/360, 32,9** |
| `preview-4k-hevc-60-1920-noread` | 352/360, 118,7 | 356/360, 119,6 | 357/360, 120,2 | 357/360, 120,5 |
| `preview-real-bridge-4k30` | 179/180, 115,2 | **145/180, 24,9** | 179/180, 88,2 | 179/180, 88,2 |
| `preview-real-hevc-4k30` | 238/240, 119 | 239/240, 83,7 | 239/240, 119,9 | 239/240, 115,6 |

- **Lecture :**
  - Le 4K60 HEVC en taille native perd 30 à 45 % de ses images en 3.9.1, à chaque run.
  - Le 4K30 H.264 à 44 Mb/s décroche une fois sur deux.
  - Les mêmes sources réduites à 1920 ne bougent pas.
  - `drawFrame` coûte 0,1 ms et l'état thermique reste *nominal* : la limite n'est pas dans le JS.
  - Les autres cas `sync` iOS (1080p et moins, couleurs, 16 exports exacts) sont au niveau de 3.8.1.
- **Confirmation, téléphone sur USB, application active, état *nominal*, trois manches alternées après un cas d'échauffement :** sur `preview-4k-hevc-60-noread`, 3.8.1 affiche 353, 357 et 358 images sur 360 à 60 rappels par seconde ; 3.9.1 en affiche 241, 237 et 241 à 39 par seconde.
  - Les deux groupes ne se recouvrent pas.
  - Deux runs 3.8.1 lancés pendant un verrouillage de l'écran (`applicationState` *inactive*, « Interrupted ») ont été écartés.
  - Quand le cas 4K60 est le premier du run, il démarre pendant le lancement de l'application et varie fortement sur les deux versions : ces runs ne sont pas retenus.
- **Trace Instruments (Metal System Trace, application lancée par `xctrace`), segment 4K60 de 6 s :**

| | 3.8.1 | 3.9.1 |
| --- | --- | --- |
| Passe fragment qui échantillonne la surface 3840×2160, p50 | 3,58 ms | 3,58 ms |
| Occupation GPU de l'application | 34 % | 22 % |
| Présentations | 55,4/s, intervalle p50 16,9 ms (2 vsyncs pour 304 sur 333) | 41,8/s, intervalle p50 24,9 ms (3 vsyncs pour 182 sur 247) |
| Passes 4K rendues | 356 | 230 |

- **Lecture de la trace :**
  - Le GPU n'est pas saturé : environ 4,7 ms par command buffer au p95, pour un vsync de 8,3 ms. La passe 4K coûte le même temps dans les deux versions.
  - 3.8.1 suit la source à 60 i/s, une image tous les 2 vsyncs à 120 Hz.
  - 3.9.1 ne prépare une image que tous les 3 vsyncs. Il ne jette pas d'images rendues : il en rend moins.
  - La limite est donc dans la chaîne de production des images (ordonnancement ou latence entre image décodée, dessin, recording et présentation), pas dans la puissance GPU.
- **Suspects, non démontrés :** les changements du thread de rendu de la 3.9.1.
  - [#4386](https://github.com/wcandillon/react-native-skia/pull/4386) : une recording présentée par vsync, les autres remises en file.
  - [#4389](https://github.com/wcandillon/react-native-skia/pull/4389) : toutes les frames d'une vue enregistrées sur le même thread.
  - Android n'est pas touché, et s'améliore même en 4K60.
- **Bisection avec la 3.9.0.**
  - Montage : worktree de `main` avec les changements de cette migration, Skia épinglé en 3.9.0.
  - Les trois fichiers patchés sont identiques à ceux de la 3.9.1 ; seule la version du patch change. WebGPU 0.21.0 et Dawn 157.1.0 sont inchangés.
  - Protocole : deux manches alternées 3.9.0, 3.9.1, 3.8.1, avec échauffement, application active et état *nominal*.

| `preview-4k-hevc-60-noread` | 3.8.1 | 3.9.0 | 3.9.1 |
| --- | --- | --- | --- |
| Images distinctes sur 360 | 353, 354 | **355, 352** | 249, 246 |
| Rappels par seconde | 59,6 ; 59,9 | **60,4 ; 60,7** | 40,7 ; 40,2 |

- **Lecture de la bisection :**
  - `preview-60` et `preview-real-bridge-4k30` sont au même niveau dans les trois versions.
  - **La régression entre avec la 3.9.1.** Les readbacks asynchrones et le reste de la 3.9.0 n'y sont pour rien.
  - Restent quatre changements de la 3.9.1, tous dans le thread de rendu ou la vue iOS : #4386, #4389, [#4388](https://github.com/wcandillon/react-native-skia/pull/4388) (pleine fréquence sur une vue recyclée) et [#4324](https://github.com/wcandillon/react-native-skia/pull/4324) (vue native hors de sa superview).

### Cause côté bibliothèque : l'attente GPU bloquante de l'aperçu

- **Le mécanisme.** L'aperçu (`src/videoCompositionPlayer.ts`) dessine chaque image dans sa surface hors écran, sur le thread UI (`useFrameCallback`), puis appelle `surface.flush(true)`.
  - Cet appel attend sur le CPU la fin du travail GPU, sur le contexte Graphite que les vues Skia partagent.
  - En 3.9.1, la vue présente une recording par vsync. L'attente du thread UI s'allonge alors jusqu'à manquer un vsync sur trois.
- **Expérience.** Worktree de la 3.9.1 où seul ce `flush(true)` devient `flush(false)` : soumission sans attente. Mesure uniquement, sans le report des libérations qu'un vrai correctif demande. Deux manches alternées avec la 3.9.1 telle quelle :

| `preview-4k-hevc-60-noread`, Skia 3.9.1 | Images distinctes sur 360 | Rappels par seconde |
| --- | --- | --- |
| Code actuel (`flush(true)`) | 247, 223 | 40,2 ; 36,0 |
| `flush(false)` | **355, 355** | **118,6 ; 118,4** |

- **Lecture de l'expérience :**
  - Sans l'attente bloquante, la 3.9.1 tient le 4K60. Elle fait même mieux que la 3.8.1, plafonnée à 60 rappels par seconde parce que le thread UI attendait le GPU à chaque image.
  - `preview-60` et `preview-real-bridge-4k30` ne bougent pas.
  - **La régression se corrige donc de notre côté.**
- **Ce que le correctif doit garder.** L'attente protège ce que l'image dessinée échantillonne encore sur le GPU :
  - le contexte rendu par `afterDrawFrame` ;
  - les images sources remplacées, libérées au vsync suivant par `releaseVideoFrameImage`.
  - Il faut donc soumettre sans attendre, puis reporter l'attente et ces libérations au vsync suivant ou à la fin du travail GPU, comme l'attente vérifiée différée de l'export Android.

## Correctif de l'aperçu

### Ce qui a été essayé

| Variante | 4K60 HEVC sur iPhone, images sur 360 | Verdict |
| --- | --- | --- |
| Attente du dessin reportée au vsync suivant | 249, 250, 201 | Aucun gain : une attente bloquante à chaque vsync coûte un vsync, où qu'elle soit. |
| Dessin sans attente, sauf avec `afterDrawFrame` (attente de l'import conservée) | YUV : 355, 354, 354 ; RGBA : une manche sur deux à 235–318 | Bon en YUV ; l'attente de l'import, sur tout le contexte, cale encore. |
| Import sans attente, sans borne mémoire | YUV : 356 ; RGBA : « Video memory budget exceeded: iOS decoder queue » | Les tampons gardés (33 Mo en 4K BGRA) dépassent le budget de 256 Mo. |
| **Version retenue** : import sans attente, borné par le budget | YUV : 354 à 358 ; RGBA : comme la 3.9.1 | Voir plus bas. |

### Version retenue

- **Dessin** (`videoCompositionPlayer.ts`) : `surface.flush(false)`.
  - L'image dessinée n'échantillonne que des images possédées par Skia, que le travail GPU garde en vie.
  - Attente conservée quand `afterDrawFrame` rend un contexte de l'appelant (contrat inchangé : `afterDrawFrame(N)` avant `beforeDrawFrame(N + 1)`).
  - Attente forcée après 6 dessins de suite sans attente ni achèvement GPU constaté, pour borner la file du GPU (une image d'une vidéo à 24 i/s couvre 5 vsyncs à 120 Hz).
- **Import** (`frameInterop.ts`) : la copie part sans attente.
  - Le tampon du décodeur est rendu quand `device.queue.onSubmittedWorkDone()` se résout, depuis le rappel de la promesse lui-même : rien ne dépend d'un import suivant, et un décodeur en pause ou en recherche n'attend jamais un tampon gardé.
  - Les achèvements constatés comptent comme des attentes pour la borne du dessin (un achèvement couvre tout le travail soumis avant).
  - On attend comme avant si l'appareil ne peut pas rapporter l'achèvement, si 2 imports sont déjà dehors, ou si le budget ne le permet pas.
  - Budget : un tampon d'au plus 1/16 du budget, et de la place laissée pour 2 images du décodeur. Avec 256 Mo, une image 4K NV12 (12 Mo) reste dehors, une 4K BGRA (33 Mo) est attendue.
  - Nettoyage (`clearVideoFrameImages`, changement de taille, fin d'un producteur YUV Android) : une attente, puis tous les tampons rendus. Un rapport tardif ne rend rien deux fois.
  - Les imports YUV Android gardés par producteur (6) dépassent toujours les imports dehors (2) : celui qu'on évince n'est jamais encore lu.
- **Tests Jest ajoutés :** dessin sans attente et borne de 6 ; achèvement d'un import compté comme une attente ; rendu au rapport, dans l'ordre ; borne de 2 ; nettoyage avec attente ; rapport rejeté ; budget refusé ; pas de promesse possible. Chacun échoue sur le code d'avant.

### Résultats sur iPhone 15 Pro

- **Profil `sync` complet** (même build que l'APK Android final) : **43/58**, comme la 3.8.1 (3.9.1 sans correctif : 39/58). 16/16 exports exacts.

| Cas | 3.8.1 | 3.9.1 | 3.9.1 + correctif |
| --- | --- | --- | --- |
| `preview-4k-hevc-60-noread` | 353, 60/s | 248, 41/s | **357, 120/s** |
| `preview-4k-hevc-60-sampled` | 355, 60/s | 216, 35/s | **355, 117/s** |
| `preview-4k-hevc-60-yuv-noread` | 354, 60/s | 241, 40/s | **358, 120/s** |
| `preview-real-flowers-4k60` | 354, 60/s | 212, 34/s | **354, 119/s** |
| `preview-real-bridge-4k30` | 179, 115/s | 145, 25/s | **178, 120/s** |
| `preview-4k-hevc-60-rgba-noread` | 354, 60/s | 237, 40/s | 238, 39/s |
| `preview-4k-hevc-60-rgba-sampled` | 354, 60/s | 241, 40/s | 229, 38/s |

- **Trois manches des cas 4K** (avant le plafond par tampon, sans effet sur le YUV) : 4K60 YUV à 354–356 images à ~118 rappels par seconde dans les trois. 1080p60 et 4K30 à 355–359 et 178–179.
- **`smoke`** 5/5 ; **tests natifs** 58 exécutés, 0 échec.
- Deux cas réussissent leurs images (357 et 356 sur 360, 100 % exactes) mais échouent sur « aucune image sautée » (1 et 3). Ces critères stricts font échouer d'autres cas en 3.8.1 : le total est le même.
- Deux runs n'ont pas compté : une installation Wi-Fi au-delà des 30 s du runner, et un écran verrouillé.

### Résultats sur Pixel 8a

- **`interop`** passé (export par readback asynchrone compris), **`smoke`** 5/5.
- **Profil `sync` :** **36/58** (3.8.1 : 35, 3.9.1 sans correctif : 34). 16/16 exports exacts. Couleurs et rendus identiques.
  - Le 4K60 tient comme avant (`preview-4k-hevc-60-noread` 351, `-sampled` 348).
  - Le RGBA 4K60 progresse : `rgba-noread` 144 → 183, `rgba-sampled` 138 → 172.
  - `preview-real-bridge-4k30` passe (179/180).
  - `yuv-noread` passe de 336 à 323 sur un seul run.
  - L'écran du Pixel est à 60 Hz : les rappels plafonnent à 60 par seconde dans les trois versions.
- **A/B de l'aperçu et de l'export** (deux runs × trois répétitions, comparés aux runs 3.8.1 du matin, sans relancer la 3.8.1). 36/36 répétitions réussies :

| Cas | Rappels/s 3.8.1 → corrigé | Recherche p50 (ms) | Export (ms) |
| --- | --- | --- | --- |
| `4k-x3-simultaneous` | **29,5 → 54,9** | 82 → 76 | 3 471 → 3 433 |
| `4k-x8-lazy` | 58,6 → 58,5 | 187 → 186 | 6 943 → 6 894 |
| `4k-x8-lazy-maxLongSide1280` | 58,6 → 58,7 | 165 → 165 | 6 856 → 6 842 |
| `native-hevc-1080p-rot270` | 58,4 → 58,7 | 34 → 34 | 2 006 → 2 017 |
| `native-h264-720p-rot180` | 58,5 → 58,5 | 34 → 35 | 1 754 → 1 848 |
| `encode-h264-copy` | — | — | 869 → 801 |

- **Lecture de l'A/B :**
  - Le 3×4K simultané presque double son rythme d'aperçu : les trois imports par image n'attendent plus le GPU.
  - Les exports ne passent pas par le code changé. Leur écart vient de l'encodeur matériel : 2,80 → 3,23 ms par image pour `native-h264-720p-rot180`, avec des runs qui se recouvrent (1 678–1 834 contre 1 709–1 863 ms).

## Format des frames : `yuv` rattrape `rgba`, `rgba` déprécié

- **Export iOS, `yuv` contre `rgba`** (même build, deux répétitions) : plus d'écart depuis l'import NV12 en place de la beta.4.
  - `long-montage-120-clips` : 7 692 ms contre 7 778 ms.
  - `shorts-x20-lazy` : 1 298 contre 1 354.
  - `montage-all-crossfade-lazy` : 2 191 contre 2 122.
  - `native-hevc-1080p-rot270` : 737 contre 728.
  - `encode-h264-copy` : 180 contre 178.
  - La conversion NV12 coûte ~0,9 ms de GPU par image sur des sources 4K ; le décodage NV12 en gagne ~0,8.
- **Couleurs P3/sRGB sur iOS.** `TrackNeedsSDRConversion` (`ios/RNSVColorSpace.h`) demandait déjà à AVFoundation la conversion vers Rec.709 en NV12 pour le HDR et le BT.2020. Elle la demande aussi pour les primaires Display P3 et DCI-P3 et la fonction de transfert sRGB, comme le fait la sortie BGRA.
  - `render-tagged-p3-flowers`, écart `yuv`/`rgba` : max 26, moyenne 5,72 → max 7, moyenne 0,82, au niveau des clips Rec.709.
  - Les autres fichiers ne bougent pas.
  - Essai écarté : laisser Dawn appliquer les primaires de la frame. Les fichiers SD sans étiquette sont alors pris pour du Rec.601 et convertis (`render-h264-638x358` : max 1 → 24), ce que la sortie BGRA ne fait pas.
  - Tests natifs iOS : 58 exécutés, 0 échec.
- **`framePixelFormat: 'rgba'` est déprécié** dans la documentation (types, README, `docs/FRAME_PIXEL_FORMAT.md`). Il reste accepté. `auto` reste `yuv`. Android garde le RGBA en interne pour le HDR et le 10 bits.

## Suite instrumentée Android (Pixel 8a)

- **`connectedDebugAndroidTest` complète :** 127 tests, **126 réussis**. Avant cette migration (20 octobre), la suite échouait sur 8 à 13 tests (« Video memory budget exceeded »).
- **Le seul échec, `BigMontageTest.aLazyPreviewOfEight4KClipsPlaysThrough`, est antérieur à la migration.**
  - Il échoue sur `shown > 150` : 39 et 40 images à l'heure, 0 manquante.
  - Lancé seul sur `main` (3.8.1, worktree temporaire), il échoue de la même façon : 38 et 41 images.
  - C'est un test natif (lecteur Java) qui ne passe pas par le code TypeScript modifié.

## Non vérifié

- **Export iOS mis en arrière-plan pendant l'exécution.** Avec #4373, Dawn retient les soumissions au lieu de perdre le device. Une soumission vérifiée avec attente CPU (`SyncToCpu::kYes`) devrait donc attendre le retour au premier plan au lieu d'échouer. Ce n'est pas testé.
- **Coût du chemin de readback CPU.** Il alloue et copie désormais un tableau par image. Il n'est utilisé que si l'export GPU direct est indisponible, ce qui n'est le cas ni sur l'iPhone ni sur le Pixel. Sa vitesse n'est pas mesurée.
- **4K60 en RGBA sur iPhone :** toujours au niveau de la 3.9.1 sans correctif (~235 images sur 360). Ses tampons de 33 Mo gardent l'attente bloquante pour protéger le budget mémoire. Le chemin par défaut sur iOS est le YUV.
- **Lecteur simple** (`useVideo`, `videoPlayer.ts`) : il n'attend pas le GPU lui-même et n'est pas touché ; ses imports passent par le même `frameInterop.ts`. Pas mesuré séparément.
