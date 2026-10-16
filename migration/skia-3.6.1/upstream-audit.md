# Audit Skia 3.4.4 → 3.6.1 / WebGPU 0.14.2 → 0.16.0 — 16 octobre 2026

Audit des **archives npm publiées**, comparées fichier par fichier (`npm pack`, hors `lib/` et web), puis migration du dépôt. Les mesures et contrôles exécutés sont dans [verification.md](verification.md).

## Versions retenues

**`react-native-skia@3.6.1` + `react-native-webgpu@0.16.0`**, toujours sur Graphite **154.3.0** et **`react-native-webgpu-dawn@154.3.0`**. Les binaires Skia et Dawn sont donc les mêmes qu'en 3.4.4 : seules changent les couches C++/Java/TS des deux paquets.

| Paquet | Versions publiées depuis la migration précédente |
| --- | --- |
| Skia | 3.5.0 (15 oct., 09:35 UTC), 3.6.0 (13:43), 3.6.1 (20:47) |
| WebGPU | 0.15.0 (15 oct., 10:02 UTC), 0.15.1 (13:36), 0.15.2 (20:20), 0.16.0 (16 oct., 12:13) |

- `pod install` et Gradle confirment le Dawn partagé : `Dawn versions match (react-native-webgpu-dawn 154.3.0)`.
- Les dépendances pair n'ont pas bougé (Skia : RN ≥ 0.79, Reanimated ≥ 4, Worklets ≥ 0.7 ; WebGPU : RN ≥ 0.81, Reanimated ≥ 4.2.1, Worklets ≥ 0.7.2).
- **Pourquoi 0.16.0, publiée le jour même :** son import d'un buffer natif « une fois, puis un accès par frame » (`createNativeBufferExternalTexture`) est ce qui permet de corriger la régression de couleurs Android apparue en 0.15.0 (plus bas), et d'en tirer l'import en place à l'export.

## Changements Skia

| Version | Changement | Dans ce dépôt |
| --- | --- | --- |
| 3.5.0 | Présentation des `SkiaView` réécrite : une frame que la fenêtre ne prend pas reste en file, rien n'est rejoué tant que l'app est en arrière-plan, la vue reprend au retour (`RNSkView.h`, `SkiaView.mm`) | Concerne l'aperçu, pas l'export |
| 3.5.0 | `Canvas` perd `onSize` (et le frame callback Reanimated qui mesurait la vue à chaque frame). `useCanvasSize()` rend `{ size, onLayout }` sans `ref`. `CanvasRef.size` lit la taille de façon synchrone | Non utilisés |
| 3.6.0 | `makeImageFromView` et `Skia.Image.MakeImageFromViewTag` sont supprimés, avec les services de capture natifs (iOS et Android, `-ljnigraphics`) | Non utilisés ; l'équivalent est `drawElementImageToTexture` de WebGPU |
| 3.6.1 | Android : un `SurfaceView` Skia qui présente plus vite que 40 fps vote la fréquence maximale de l'écran (`Surface.setFrameRate`), et retire ce vote après 500 ms sans animation | Aperçu Android seulement. Une vidéo à 30 fps ne déclenche pas le vote |

**Patch local.** Les sept fichiers touchés par [`react-native-skia+3.6.1.patch`](../../patches/react-native-skia+3.6.1.patch) ont la même empreinte `before` en 3.4.4 et en 3.6.1. Le patch et ses 62 éditions sont donc repris tels quels, seule la version du manifeste change. Ces fichiers étant identiques, chaque partie du patch reste nécessaire, pour les raisons de l'[audit 3.4.4](../skia-3.4.4/upstream-audit.md) :
- `canvas.dispose()` ;
- les soumissions vérifiées ;
- le snapshot nul ;
- `ImageProvider::Make` ;
- `__rnskvTrimRecorderCache`.

## Changements WebGPU

| Version | Changement | Dans ce dépôt |
| --- | --- | --- |
| 0.15.0 | **La conversion YUV → RGB des textures externes est faite par Dawn**, avec l'espace colorimétrique de la frame : matrice, plage, primaires et fonction de transfert. La destination est sRGB par défaut. `GPUExternalTexture.yuvToRgbMatrix` est supprimé. `copyExternalImageToTexture` d'une `NativeVideoFrame` passe par cette conversion | **Régression de couleurs Android**, voir plus bas |
| 0.15.0 | `NativeVideoFrame.acquireFenceFd` : la fence du producteur sur Android, attendue par `importExternalTexture` | Nos frames sont créées par `createVideoFrameFromNativeBuffer`, sans fence ; le natif attend déjà la fence producteur (API 33+) |
| 0.15.0 | Le module natif s'installe au premier import : les constantes `GPUTextureUsage`, `GPUShaderStage`… ne sont plus `undefined` selon l'ordre des imports | Les constantes sont capturées dans `gpuDevice.ts` |
| 0.15.0 | `drawElementImageToTexture` sans copie CPU (HardwareRenderer sur Android 13+, IOSurface sur iOS) et `afterScreenUpdates`. `createTestVideoFrame(w, h, "nv12")` | Non utilisés |
| 0.15.2 | Android : `WebGPUView` vote la fréquence d'affichage comme Skia 3.6.1 | Non utilisé |
| 0.16.0 | **`createNativeBufferTexture` / `createNativeBufferExternalTexture`** : un buffer natif importé une fois, puis `beginAccess()` / `endAccess()` par usage. `endAccess()` rend une seule fence (les sync-fd fusionnés sur Android). C'est le modèle de la couche Android de Dawn | Adopté pour les frames décodées Android (`yuvBlit.ts`) |
| 0.16.0 | `importExternalTexture` accepte `cropOrigin`, `cropSize` et `sourceColorSpace` | `sourceColorSpace` est ce qui corrige la régression |
| 0.16.0 | Vulkan : un accès à un buffer initialisé l'acquiert en layout `GENERAL` au lieu d'`UNDEFINED`, qui autorisait le pilote à jeter son contenu (`NativeFrameImport.cpp`) | Corrige un risque latent de l'import des frames `ImageReader` ; nos imports de buffers encodeur (non initialisés) restent en `UNDEFINED` |
| 0.16.0 | `device.adapterInfo`, `GPUExtent2D` | Non utilisés |

Inchangés pour nous : `importSharedTextureMemory` et l'import IOSurface en place sur iOS, `GPUSharedFence.export()` des buffers encodeur Android, `createVideoFrameFromNativeBuffer`, et l'étiquette `"bgra8"` des formats YUV propres aux fabricants.

## Régression trouvée : couleurs des frames décodées sur Android

**Constat.** Avec la migration seule, le contrôle `interop` du Pixel 8a échoue sur 10/10 cas : écart maximal de 14 à 55 contre la référence CPU (EGL), au lieu de 0 à 1 en 3.4.4.

**Cause.** Les frames `ImageReader` passaient par `copyExternalImageToTexture`. Depuis 0.15.0, Dawn convertit leur YUV avec la matrice et la plage suggérées par le pilote, comme avant. Mais il convertit aussi :
- leur fonction de transfert (SMPTE 170M, déduite de la matrice) vers sRGB ;
- leurs primaires vers celles de sRGB.

Le chemin EGL de référence et le décodage iOS (VideoToolbox en BGRA) n'appliquent que la matrice. Résultat :
- les tons moyens éclaircissent : d'après les deux courbes, un gris à 50 % monte d'environ 12 niveaux ;
- un export ré-encodé dans une piste BT.709 éclaircirait encore à chaque nouvel export.

`copyExternalImageToTexture` n'a pas d'option pour l'espace source.

**Correction** ([`src/yuvBlit.ts`](../../src/yuvBlit.ts)) :
- **Import.** Chaque buffer décodeur est importé une fois avec `createNativeBufferExternalTexture(frame, { rotation, sourceColorSpace: { primaries: "srgb", transfer: "srgb" } })`. Source et destination sont ainsi déclarées sRGB : il ne reste que la matrice YCbCr du pilote, comme en 0.14.2.
- **Blit.** Le shader reprend celui de `VideoFrameBlit.h` à l'identique : triangle plein écran, mêmes coordonnées dans la frame redressée, échantillonneur linéaire.
- **Cache.** Il y a un cache par producteur, d'au plus six imports (l'`ImageReader` en fait tourner quatre). Il est libéré quand le producteur quitte la composition, et avec la surface de staging.
- **Coût.** Chaque frame ne coûte plus qu'un `beginAccess` / `endAccess`, et une écriture d'uniformes quand le cadrage change.
- **Validation.** Écart maximal de 0 à 1 sur les 10 cas du Pixel ([vérification](verification.md#pixel-8a)).

Ce point mérite un signalement amont : `copyExternalImageToTexture` d'une `NativeVideoFrame` change désormais les couleurs d'une vidéo SDR, sans option pour l'éviter.

## Import en place à l'export Android

**Avant.** Pour chaque clip, chaque image exportée faisait :
1. un blit dans la texture d'upload partagée du runtime ;
2. un snapshot, c'est-à-dire une copie plein cadre ;
3. un `flush(true)`, une attente CPU de la fin du GPU ;
4. puis le dessin et un second `flush(true)`.

En HEVC 1080p, cet import coûtait 6,5 à 6,7 ms par image, le premier poste du profil.

**Maintenant** ([`src/exportFrames.ts`](../../src/exportFrames.ts)), comme l'import IOSurface en place sur iOS :
- **Conversion.** Une frame `ImageReader` est convertie dans une texture RGBA propre à son producteur, puis enveloppée par `MakeImageFromGPUTexture`. Il n'y a plus ni snapshot ni attente intermédiaire.
- **Ordre GPU.** La conversion est soumise sur la file partagée avant les recordings du dessin.
- **Libération.** L'attente vérifiée qui termine chaque image d'export couvre les deux. Le bail décodeur d'une image est rendu à l'import de la suivante, comme sur iOS.
- **Échec.** Une conversion soumise puis interrompue est vidée (draw + `flush(true)`) avant de rendre le bail.

**Hors de ce chemin :** les clips décodés par EGL (mise à l'échelle, HDR, 10 bits) gardent la copie de `frameInterop`.

**Résultat** ([vérification](verification.md#pixel-8a)) :
- HEVC 1080p −21 %, l'import passant de 6,6 à 3,4 ms par image ;
- 8×4K natifs −26 % ;
- 3×4K simultanés −35 %.

## Pistes suivantes, non implémentées

1. **Mise à l'échelle dans le blit YUV.** Les clips réduits (`maxLongSide`) restent en EGL, à 16–17 ms de décodage par image en 8×4K → 1280, contre environ 8,5 ms avec `ImageReader` à taille native. Le blit sait déjà échantillonner à une autre taille. Il suffirait de décoder à taille native et de réduire pendant la conversion, à requalifier : filtrage, et mémoire des buffers 4K.
2. **Buffers encodeur Android importés une fois** (`createNativeBufferTexture`). Le pool d'`EncoderTargets` nous appartient, ce qui économiserait l'import par image (poste `target`, environ 1 ms en HEVC 1080p).
3. **iOS, inchangé par cette migration :**
   - attente GPU par image (1,5 à 1,7 ms) : pipeline asynchrone de fences Metal ;
   - pool encodeur plafonné à trois buffers et scruté toutes les 2 ms.

   Voir les [pistes 3.4.4](../skia-3.4.4/upstream-audit.md#pistes-suivantes-non-implémentées).
