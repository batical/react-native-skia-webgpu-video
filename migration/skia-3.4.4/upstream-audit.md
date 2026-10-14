# Audit Skia 3.0.6 → 3.4.4 / WebGPU 0.12.1 → 0.14.2 — 14 octobre 2026

Audit des **archives npm publiées**, comparées fichier par fichier, puis migration du dépôt. Les références `3.4.4/…` et `wgpu-0.14.2/…` désignent les sources de ces archives ; elles sont identiques aux sources installées par `npm install`. Une validation native sur simulateur est consignée séparément, dans [verification.md](verification.md). Aucune mesure sur appareil physique n'a encore été faite pour ce couple.

## Versions retenues

**`react-native-skia@3.4.4` + `react-native-webgpu@0.14.2`**, avec Graphite **154.3.0** et un Dawn unique, **`react-native-webgpu-dawn@154.3.0`**. Le tag déclaré reste `chrome-m154a`.

- **Pourquoi 3.4.4 plutôt que 3.4.3 :** 3.4.3 est publiée le 14 octobre à 11:18 UTC, 3.4.4 à 17:19 UTC. Entre les deux, seuls changent le registre des cibles des vues Graphite (StrictMode, `RNSkGraphiteTarget.h`, `RNSkJsiViewApi.h`, `SkiaGraphiteView.tsx`) et deux fichiers web. Aucun fichier de notre patch n'est touché : son empreinte et ses éditions sont identiques pour les deux versions.
- **Le couple Dawn change de mécanisme.** En 3.0.6, Skia comparait une chaîne de tag (`libs/.dawn-version`) au champ `dawn` de WebGPU. En 3.4.4, les deux paquets dépendent de `react-native-webgpu-dawn`, et le podspec Skia refuse l'installation si leurs versions résolues diffèrent. `pod install` confirme sur l'exemple : `Dawn versions match (react-native-webgpu-dawn 154.3.0)`. **Skia 3.0.6 avec WebGPU 0.14.x passerait l'ancien contrôle de tag tout en liant un Graphite 154.1.0 sur un Dawn 154.3.0 : ne pas livrer ce mélange.**
- **Les headers Skia (`cpp/skia`) sont identiques entre 3.0.6 et 3.4.4**, tout comme les headers Dawn (seul `tint` est retiré). Les budgets Graphite décrits dans les [notes amont](../../docs/UPSTREAM_NOTES.md) ne changent donc pas au niveau des headers. Les binaires sont en revanche reconstruits (154.1.0 → 154.3.0) et doivent être requalifiés.
- **Conditions de build :** `node` doit être disponible pendant `pod install` et Gradle, et `node_modules` doit être accessible en écriture : les podspecs y copient les xcframeworks. Les dépendances pair de WebGPU 0.14.2 (RN ≥ 0.81, Worklets ≥ 0.7.2, Reanimated ≥ 4.2.1) et celles de Skia (RN ≥ 0.79) restent compatibles avec RN 0.86.2 / Reanimated 4.5.3 / Worklets 0.11.3.

## Changements cassants traités

| 3.0.6 / 0.12.1 | 3.4.4 / 0.14.2 | Dans ce dépôt |
| --- | --- | --- |
| `Skia.Image.MakeImage` | `Skia.Image.MakeRasterImage` (`3.4.4/src/skia/types/Image/ImageFactory.ts:68`) | Chemin de compatibilité RGBA iOS de `frameInterop.ts` renommé, mocks Jest compris |
| `Skia.Surface.Make` | `Skia.Surface.MakeRaster` | Non utilisé |
| `image.makeNonTextureImage()` (nullable) | `makeRasterImageSync()` (lève une erreur) / `makeRasterImage()` (Promise, thread JS uniquement) | Non utilisé ; ne pas appeler la variante Promise depuis un worklet |
| `__box` sur chaque prototype Skia **et** WebGPU | Helpers natifs : `globalThis.__skiaWorkletHelpers` (`RNSkManager.cpp:69`), et `__webgpuWorkletHelpers` côté WebGPU | Aucun appel direct. Le transport des objets WebGPU capturés par `gpuDevice.ts` passe désormais par le sérialiseur de WebGPU seul : à vérifier en natif (voir plus bas) |
| Entiers WebGPU convertis sans contrôle | `[EnforceRange]` : NaN, infini, négatif ou hors bornes lèvent `TypeError` (`wgpu-0.14.2/cpp/rnwgpu/EnforceRange.h`) | Nos tailles sont déjà validées avant `createTexture` / `writeTexture` |
| `canvas.drawPoints([])` lève une erreur | Ne dessine rien | Aucun effet |

Avec Skia 3.4.x, WebGPU 0.14.x est de fait nécessaire au-delà du seul contrôle Dawn. Le sérialiseur de WebGPU 0.12.1 reconnaissait ses objets par prototype et `Symbol.toStringTag`. Or Skia 3.4.4 installe aussi `toStringTag`, et ce contrôle pouvait donc revendiquer des objets Skia. En 0.14.2, la reconnaissance se fait par l'état natif (`hasNativeState<NativeObjectBase>`).

## Patch local : nécessaire en 3.4.4, rebasé

Le patch passe de `react-native-skia+3.0.6.patch` à [`react-native-skia+3.4.4.patch`](../../patches/react-native-skia+3.4.4.patch) : 7 fichiers, 31 hunks. Le manifeste gardé [`skia-canvas-patch.json`](../../scripts/skia-canvas-patch.json) est régénéré : chaque édition est unique au moment où l'installateur l'applique, et la relecture complète reproduit l'empreinte `after`.

| Partie | État amont 3.4.4 | Décision |
| --- | --- | --- |
| `canvas.dispose()` | Toujours absent. L'amont libère désormais `_surface` dans `~JsiSkCanvas` via le `Dispatcher` du thread créateur (`JsiSkCanvas.h:599`). | Conservé ; `dispose()` passe désormais par ce même dispatcher hors du thread créateur |
| Soumissions vérifiées | `submitRecording` ignore toujours le statut d'`insertRecording` et le retour de `submit` (`RNDawnContext.h:220`) | Conservé tel quel |
| Snapshot nul | `makeImageSnapshot` ne le vérifie toujours pas | Conservé |
| `ImageProvider::Make` | Toujours `sk_ref_sp(new ImageProvider)` (`RNImageProvider.h:24`, fichier identique à 3.0.6). L'amont l'utilise aussi dans `makeRecorder()`, donc pour chaque Recorder de vue Graphite et pour le Recorder d'upload `thread_local` de `makeTextureImage`. | Conservé, avec une portée plus large qu'en 3.0.6 |
| `__rnskvTrimRecorderCache` | `JsiSkApi.h` identique | Conservé ; il ne vide pas le Recorder d'upload de `makeTextureImage`, qui est distinct |

Contrôles passés après `npm install` : `apply-skia-canvas-patch.mjs`, puis compilation syntaxique des headers patchés contre Graphite et Dawn 3.4.4 (`test-skia-patch-syntax.mjs`) et test de propriété du provider (`test-skia-provider-ownership.mjs`). Ces tests ne valident pas l'exécution GPU.

## Améliorations amont utiles pour la vidéo

1. **Readback sans verrou global.** En 3.0.6, `DawnContext::MakeRasterImage` gardait le mutex du contexte en tournant sur `tick()`/`checkAsyncWorkCompletion()` jusqu'à la fin du readback. Cela bloquait toutes les vues Skia et occupait un cœur. En 3.4.4, `readPixels` lit seulement le rectangle demandé, puis attend sur une condition hors verrou (`RNDawnContext.h:74,104`). Un thread dédié interroge le contexte avec un intervalle croissant de 1 à 4 ms (`:454`). `canvas.readPixels` lit désormais directement dans la destination (`JsiSkImage.h:308`), sans image raster intermédiaire.
   - **Pour nous :** l'export Android par readback ne fige plus la preview. Ce même intervalle peut ajouter quelques millisecondes par image, à mesurer.
2. **Dispatcher allégé.** En 3.0.6, chaque `JsiSkImage` et `JsiSkSurface` créait son propre objet `Dispatcher` et traitait la file. En 3.4.4, les images n'ont plus de dispatcher, et les surfaces utilisent celui du thread (`JsiSkDispatcher.h:31,48`). Une surface finalisée par le GC sur un autre thread est détruite sur son thread créateur. Nous créons des wrappers de surface et des images à chaque frame : ce coût baisse.
3. **`surface.asImage()`** (`JsiSkSurface.h:88`) donne une vue sans copie de la texture d'une surface Graphite.
   - Non adoptée dans `frameInterop` : sa texture d'upload est partagée par tous les producteurs d'un runtime, donc le snapshot reste nécessaire tant qu'il n'y a pas une texture par producteur.
4. **`image.makeTextureImage()`** (`JsiSkImage.h:339`) charge une image raster une seule fois pour tous les canvas, au lieu d'une fois par Recorder via le cache LRU de 256 images de l'`ImageProvider`. **Recommandé pour les images statiques dessinées à chaque frame dans `drawFrame`** (logos, stickers, texte rasterisé). Le Recorder d'upload est `thread_local`, distinct de celui que vide notre trim d'export.
5. **Android :**
   - Le device n'active plus qu'une seule feature de fence Vulkan partagée, `SharedFenceSyncFD` en priorité (`RNDawnUtils.h:168`). Sinon la création du device échouait sur Samsung Xclipse et sur l'émulateur.
   - `MSAARenderToSingleSampled` est désactivé sur Android (`RNDawnUtils.h:304`), à cause du crash Adreno amont #4158.
   - Ces deux points concernent directement notre voie AHardwareBuffer.
6. **`saveLayer` corrigé.** En 3.0.6, des bornes passées en objet JS simple pouvaient laisser un pointeur pendant (`JsiSkCanvas.h:353`). Ce bug touchait le code `drawFrame` des applications.
7. **Divers :**
   - `MakeVertices` accepte un `Float32Array`.
   - Les arguments `null` de `drawImage*` et `drawAtlas` sont acceptés.
   - Une Promise résolue après un reload est livrée sur le nouveau runtime.

### WebGPU 0.14.2

- **`GPUSharedTextureMemory.destroy()` et `GPUSharedFence.destroy()` sont nouveaux.** En 0.12.1, l'import IOSurface d'un buffer encodeur et les fences rendues par `endAccess` vivaient jusqu'au GC du runtime d'export. Or le pool encodeur est plafonné à trois buffers, et l'encodeur scrute cette limite toutes les 2 ms. Ces imports sont désormais fermés dès la fin de l'accès (voir plus bas).
- **`importSharedTextureMemory` lève une erreur dès l'import** si les propriétés de la mémoire sont invalides. La sonde GPU d'export échoue donc plus tôt.
- **Corrections :**
  - `beginAccess` transmet enfin `signaledValueCount`. Une fence sync-fd binaire doit utiliser `1n`.
  - `instanceof GPUError` couvre les sous-classes.
- **Inchangé :**
  - `createVideoFrameFromNativeBuffer` : il prend un `CVPixelBufferRef`, et `handle` est l'`IOSurfaceRef`.
  - `copyExternalImageToTexture`, `onSubmittedWorkDone`, `importDevice` et `installWebGPU`.
  - Côté Android, l'étiquette `"bgra8"` des AHB RGBA reste la même. Il n'y a toujours pas de fence producteur : on conserve donc le `glFinish` de `NativeHardwareBuffer.cpp`.

## Passe export iOS de cette migration

Avant cette passe, chaque image exportée faisait, **pour chaque clip** : wrapper `NativeVideoFrame`, blit WebGPU vers la texture d'upload, wrapper de surface Skia, snapshot GPU (copie plein cadre dans une nouvelle texture), puis `flush(true)`, une attente CPU de la fin du GPU. Venaient ensuite le dessin, un second `flush(true)` et l'encodage. Selon la documentation d'AVFoundation, la sortie du lecteur peut aussi copier chaque frame décodée avant de la livrer tant que `alwaysCopiesSampleData` reste à `YES`, sa valeur par défaut.

| Changement | Fichier | Effet attendu sur appareil, non mesuré |
| --- | --- | --- |
| Frames décodées échantillonnées en place via leur IOSurface : `importSharedTextureMemory` → `beginAccess(texture, true)` → `Skia.Image.MakeImageFromGPUTexture` | [`src/exportFrames.ts`](../../src/exportFrames.ts) | Plus de blit, de snapshot ni d'attente GPU par clip. Une seule attente vérifiée par image, celle du dessin |
| La frame N d'un producteur est libérée à l'import de sa frame N+1, donc après l'attente GPU de N. Une frame tenue (même `id`) reste ouverte. | idem | Au plus deux leases décodeur par producteur, soit la capacité native existante (`VideoFrameRing`, 2) |
| Repli : si le premier import en place échoue, avertissement puis chemin copiant de `frameInterop` pour toute la session. Une fois un import réussi, un échec est une erreur. | idem | Pas de régression sur un appareil sans cette interop |
| `endAccess` puis `fence.destroy()`, `texture.destroy()` et `memory.destroy()` pour les cibles encodeur | [`src/exportTarget.ts`](../../src/exportTarget.ts) | Buffers rendus au pool sans attendre le GC |
| `alwaysCopiesSampleData = NO` | [`ios/VideoCompositionItemDecoder.mm`](../../ios/VideoCompositionItemDecoder.mm) | Une copie CPU plein cadre de moins par frame décodée, en preview comme à l'export. Les frames ne sont que lues : imports GPU et verrous en lecture seule |
| `getBackendInfo().exportSource = "iosurface-in-place"` | [`ios/ReactNativeSkiaVideo.mm`](../../ios/ReactNativeSkiaVideo.mm) | Transport documenté dans les diagnostics |

Sur simulateur, aucune de ces modifications n'est plus rapide de façon mesurable, et la montée de version non plus. La seule différence mesurée est la mémoire suivie pendant l'export, qui baisse avec l'import en place. Les chiffres et un profil par étape sont dans la [vérification](verification.md). Une nouvelle option, `onProfile`, mesure les mêmes étapes dans une application ou sur appareil.

La sûreté repose sur deux faits :
- L'import n'écrit jamais dans la frame : accès déclaré initialisé, aucune cible de rendu Skia.
- La libération suit toujours un `flush(true)` vérifié : celui de l'image suivante, ou ceux de `finish` en fin de session ou en cas d'erreur.

Un `endAccess` qui échoue garde le lease et l'entrée suivis, puis empoisonne la session, comme pour les cibles encodeur. Les tests Jest ajoutés vérifient cet ordre et ces cas. Ils ne prouvent ni les pixels réellement échantillonnés par le GPU, ni le comportement des pools CoreVideo.

## Passe export Android (14 octobre, soir) — compilée, non mesurée

Avant cette passe, chaque image exportée sur Android faisait un aller-retour complet. Skia faisait un `readPixels` (copie GPU → CPU), puis un `ArrayBuffer` JSI passait dans un `ByteBuffer` Java, avec un repaquetage éventuel. Venait ensuite `glTexImage2D` (copie CPU → GPU) dans le contexte EGL privé de l'encodeur, puis le dessin dans la Surface de `MediaCodec`.

Nouveau chemin, équivalent du chemin iOS :

1. **Pool natif.** [`EncoderTargets`](../../android/cpp/EncoderTargets.cpp) prête jusqu'à trois `AHardwareBuffer` RGBA (`GPU_COLOR_OUTPUT | GPU_SAMPLED_IMAGE`), réservés dans le budget vidéo. Un seul est prêté à la fois, via `encoder.acquireFrameBuffer()`.
2. **Rendu Skia dans le buffer.** JS importe l'AHB sur le device WebGPU partagé (`importSharedTextureMemory({handle: pointeur})`, sans `NativeVideoFrame`) et vérifie dimensions et format `rgba8unorm`. Il ouvre l'accès non initialisé et y dessine avec Skia (`MakeFromGPUTexture`), puis attend la fin par un `flush(true)` vérifié.
3. **Fences rendues à l'encodeur.** `endAccess` rend des fences sync-fd : fermer l'accès à un AHB soumet une libération que `flush(true)` n'a pas attendue. Chaque fence est exportée (`fence.export()`, descripteur dupliqué dont l'appelant est propriétaire), puis son wrapper est détruit. Les descripteurs partent avec la frame : `encodeFrame({kind: "native-buffer", nativeBuffer, fences}, t)`.
4. **Lecture côté encodeur.** Le natif prend la propriété des descripteurs et les ferme sur tous les chemins. Il attend chaque fence (`poll`, 5 s au plus ; `-1` signifie déjà signalée), puis rend courant le contexte EGL de l'encodeur et restaure celui de l'appelant. L'AHB devient une `EGLImage` liée à une texture `GL_TEXTURE_2D`, créée une seule fois par buffer. Le `TextureRenderer` existant la dessine dans la Surface de l'encodeur (`encodeTexture` Java) avec le même horodatage `eglPresentationTimeANDROID`.
5. **Recyclage du buffer.** Une fence EGL (`EGL_SYNC_FENCE_KHR`) marque la fin des lectures GL. Le buffer n'est reprêté qu'une fois ces lectures terminées : le GPU ne peut donc pas réécrire une frame encore échantillonnée.
6. **Sonde et repli.** La sonde de démarrage dessine dans un buffer prêté puis le rend. Si l'interop AHB n'a pas été négociée, si l'import échoue ou si le format n'est pas RGBA, l'export revient au readback CPU avec un avertissement, comme sur iOS. `getBackendInfo()` annonce `encodeTransport: "ahardwarebuffer-egl-sample"` et `gpuDirectExport` selon l'interop.

**Ce qui reste inchangé :** l'entrée Android garde son chemin copiant (blit WebGPU + snapshot) ; l'import en place des frames décodées reste propre à iOS.

**À vérifier sur appareil, non prouvé par le build ni par les tests JS :**
- l'orientation : la ligne 0 de l'AHB doit correspondre au haut de l'image, comme pour le readback ;
- les couleurs et les pixels ;
- la compatibilité des pilotes avec un AHB RGBA comme cible Vulkan et source EGL ;
- l'absence de déchirure sous charge ;
- la fermeture du pool à `dispose`.

## Pistes suivantes, non implémentées

1. **Priorités d'après le profil iPhone 15 Pro** (voir la [vérification](verification.md#appareil-ios--iphone-15-pro)) :
   - l'attente GPU par image (1,4 à 1,7 ms), point 2 ci-dessous ;
   - l'attente du pool encodeur, environ 1 ms en 1080p : point 4, et remplacer la scrutation par pas de 2 ms ;
   - le décodage des sources 4K, environ 5 ms : point 5.
   - Les imports en place ne coûtent plus que 0,1 à 0,2 ms par image : le point 3 n'est plus prioritaire.
2. **Pipeline asynchrone de sortie.** Soumettre sans attendre, puis transmettre au natif la fence `mtl-shared-event` rendue par `endAccess(target)` (`fence.export()`). L'encodeur attendrait l'événement Metal hors du thread JS avant `appendSampleBuffer`, ce qui ferait recouvrir le GPU de l'image N avec le décodage et le dessin de N+1. Il faut pour cela une interface native de l'encodeur et un ordre de libération des leases d'entrée prouvé.
3. **Garder l'import par IOSurface du pool encodeur.** Ne faire que `beginAccess`/`endAccess` à chaque image. À tester d'abord : une `MTLTexture` vivante sur une IOSurface pourrait empêcher `CVPixelBufferPool` de recycler le buffer.
4. **Taille du pool encodeur et réordonnancement.** Le plafond de trois buffers et les attentes de 2 ms peuvent brider H.264 High avec B-frames. Essayer `AVVideoAllowFrameReorderingKey` et un plafond dépendant de la résolution, à mesurer.
5. **Décoder en NV12.** Le décodage natif évite alors la conversion BGRA, et la conversion YUV se ferait au moment du blit WebGPU. C'est un gain potentiel en 4K, mais il faut requalifier les couleurs (plage, matrice, HDR → Rec.709).
