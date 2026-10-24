# Audit Skia 3.7.1 → 3.7.4 / WebGPU 0.17.0 → 0.19.0 — 23 octobre 2026

Audit des **archives npm publiées**, comparées fichier par fichier (`npm pack`), puis migration du dépôt. Les contrôles exécutés sont dans [verification.md](verification.md).

## Versions retenues

**`react-native-skia@3.7.4` + `react-native-webgpu@0.19.0`**, toujours sur Graphite **157.0.0** et **`react-native-webgpu-dawn@157.0.0`** : aucun binaire Skia ni Dawn ne change.

| Paquet | Versions publiées depuis la migration précédente |
| --- | --- |
| Skia | 3.7.2 (20 oct.), 3.7.3 (22 oct.), 3.7.4 (23 oct., 09:20 UTC) |
| WebGPU | 0.19.0 (23 oct., 10:35 UTC) ; la 0.18.0 n'a pas été publiée sur npm |

Les dépendances pair ne bougent pas.

## Le changement qui motive la migration : l'export Android sans EGL

WebGPU 0.19.0 ajoute `RNWebGPU.MakeWebGPUCanvasContextFromNativeWindow(window, width, height)` ([#588](https://github.com/wcandillon/react-native-webgpu/pull/588), issue [#583](https://github.com/wcandillon/react-native-webgpu/issues/583)) : un contexte de canvas qui présente dans une `ANativeWindow` qui n'est pas une vue, par exemple la `Surface` d'entrée d'un encodeur `MediaCodec`.

**Avant**, l'export GPU Android passait par trois étapes :
1. Skia dessinait dans un `AHardwareBuffer` prêté par l'encodeur (`EncoderTargets.cpp`), importé dans WebGPU ;
2. la fin de l'accès WebGPU exportait des sync-fd, que le contexte EGL de l'encodeur attendait (`eglWaitSyncKHR`) ;
3. ce contexte EGL recopiait le buffer dans la `Surface` du codec par un dessin OpenGL, et fixait l'horodatage avec `eglPresentationTimeANDROID`.

**Maintenant**, Skia dessine directement dans la texture courante de la swapchain Vulkan de Dawn sur la `Surface` du codec. `present()` la met en file pour l'encodeur. Il n'y a plus de buffer prêté, de sync-fd, de contexte EGL ni de copie.

**L'horodatage.** Le codec lit le temps de chaque image sur le buffer reçu. `eglPresentationTimeANDROID` et la couche Vulkan d'Android (`VK_GOOGLE_display_timing`) ne font que le poser sur la fenêtre avant la mise en file ; la fenêtre le garde pour le buffer suivant. Le natif appelle donc `ANativeWindow_setBuffersTimestamp` juste avant `present()`. Cette fonction est dans le LL-NDK : `libnativewindow.so` l'exporte depuis Android 10, mais le NDK ne la déclare pas. Elle est résolue par `dlsym` ; si elle manque, l'export GPU est refusé au moment du sondage et l'export repasse en readback.

**Ce qui reste en OpenGL sur Android :**
- le readback CPU de secours (`encodeFrameRgba`) dessine toujours dans la `Surface` par EGL. Son contexte est désormais créé au premier frame readback, puisqu'une fenêtre n'a qu'un producteur à la fois ;
- le décodage `rgba` et les pistes non 8 bits SDR passent toujours par `GLFrameExtractor`. Aucune API amont ne permet encore de s'en passer.

### Décisions

- **Le chemin `EncoderTargets` (AHB + EGL) est supprimé**, pas gardé en second recours : la fenêtre ne dépend pas de l'interop AHB, et le readback reste le recours.
- **L'export GPU reste proposé seulement avec l'interop AHB** (`gpuDirectExport` = interop négociée). La fenêtre n'en a pas besoin, mais l'interop sert aussi à échantillonner les frames décodées sur place, et la désactiver est la façon dont le contrôle `interop` force l'export readback de référence.
- **Sondage sans image perdue.** Le sondage ouvre le contexte, prend la première texture, l'efface et attend le GPU. La première image de l'export dessine dans cette même texture : rien n'atteint l'encodeur pendant le sondage. S'il échoue, `unconfigure()` rend la fenêtre avant que le readback n'y connecte EGL.
- **Images perdues silencieusement.** Si la swapchain ne rend pas de texture, `getCurrentTexture()` de WebGPU renvoie une texture hors écran et `present()` jette l'image, sans erreur. L'encodeur compte les images présentées : `finishWriting` échoue si le fichier en contient moins. La file bornée de l'encodeur (4 images, 15 s) échoue déjà avant, si plusieurs images se perdent.
- **Espace colorimétrique.** La couche Vulkan d'Android étiquette la fenêtre selon l'espace de la swapchain : sRGB, plage complète. Le codec encodait alors en plage complète et étiquetait le fichier ainsi (`yuvj420p`, `color_range=pc`, `color_transfer=iec61966-2-1`), avec des fichiers 3 à 11 % plus gros. EGL laissait l'espace inconnu, et le codec produisait du Rec.709 en plage limitée. Le natif remet donc l'espace à `ADATASPACE_UNKNOWN` avant chaque `present()` (une swapchain recréée étiquette à nouveau la fenêtre). Le flux encodé redevient identique bit pour bit à celui du chemin EGL, voir la [vérification](verification.md).
- **Fermeture.** `unconfigure()` est appelé avant `encoder.dispose()` : une `Surface` d'entrée de `MediaCodec` garde ses buffers tant que la swapchain vit.
- Le contexte est configuré en FIFO (forcé par WebGPU) et opaque, avec les usages `RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC` : Graphite en a besoin pour les modes de fusion qui lisent la destination.

## Changements Skia

| Version | Changement | Dans ce dépôt |
| --- | --- | --- |
| 3.7.2 | CocoaPods : chemins d'en-têtes préservés ; mémoire du compilateur Android réduite ; device Dawn gardé sur l'émulateur quand un snapshot de vue importe un AHB | Build seulement |
| 3.7.3 | **La `Surface` possède son `Canvas`** ([#4278](https://github.com/wcandillon/react-native-skia/pull/4278)) : un seul canvas par surface, et `surface.dispose()` le détache, après quoi dessiner lève une erreur | **Remplace notre `SkCanvas.dispose()`** ([#4275](https://github.com/wcandillon/react-native-skia/pull/4275), fermée) |
| 3.7.3 | **Chaque recorder est le seul propriétaire de son image provider** ([#4277](https://github.com/wcandillon/react-native-skia/pull/4277), empilée sur notre [#4274](https://github.com/wcandillon/react-native-skia/pull/4274)) | **Remplace notre correctif `ImageProvider::Make()`** |
| 3.7.3 | Perte du device exposée en JS (`Skia.gpu.lost`) ; `DawnContext::submitRecording` prend le recorder et renvoie `false` quand la recording ne tourne pas (device perdu, recording refusée) | Notre soumission vérifiée est réécrite dessus, voir plus bas |
| 3.7.3 | iOS : `rnskia_getWGPUInstance` reste lié ([#4306](https://github.com/wcandillon/react-native-skia/pull/4306)), donc WebGPU partage l'instance Dawn de Skia | Le travail asynchrone du device importé (`importDevice(Skia.getNativeDevice())`) se règle sur iOS |
| 3.7.3 | Encodage d'image : lève une erreur sur natif comme sur web | Non utilisé |
| 3.7.4 | **Pool de recorders au lieu d'un recorder par `Canvas`** ([#4309](https://github.com/wcandillon/react-native-skia/pull/4309)), cache de textures d'images partagé (128 Mo pour le processus) | Les recorders des runtimes worklet ne sont pas réduits par Skia : notre `__rnskvTrimRecorderCache` reste utile pour le runtime d'export |
| 3.7.4 | **Android : les canvases présentent sur un thread dédié** ([#4318](https://github.com/wcandillon/react-native-skia/pull/4318)), plus sur le thread principal | Aperçu Android seulement |
| 3.7.4 | Reconciler React 19.2 | Non utilisé par la bibliothèque |

## Changements WebGPU 0.19.0

| Changement | Dans ce dépôt |
| --- | --- |
| `MakeWebGPUCanvasContextFromNativeWindow` ([#588](https://github.com/wcandillon/react-native-webgpu/pull/588)) | Export Android, voir plus haut |
| Le travail asynchrone d'un device importé tourne sur l'instance qui le possède ([#590](https://github.com/wcandillon/react-native-webgpu/pull/590)) ; Android trouve l'instance Dawn de Skia dans `librnskia.so` ([#582](https://github.com/wcandillon/react-native-webgpu/pull/582)) | Device partagé de la bibliothèque |
| `GPUCanvasConfiguration.colorSpace` respecté sur iOS ([#586](https://github.com/wcandillon/react-native-webgpu/pull/586)) | Non utilisé |

## Le patch local

Il passe de **7 fichiers et 62 éditions à 3 fichiers et 8 éditions** ([`skia-canvas-patch.json`](../../scripts/skia-canvas-patch.json), [`react-native-skia+3.7.4.patch`](../../patches/react-native-skia+3.7.4.patch)).

| Partie | 3.7.1 | 3.7.4 |
| --- | --- | --- |
| `SkCanvas.dispose()` (`JsiSkCanvas.h`, types) | 49 + 2 éditions | **Retirée** : `surface.dispose()` détache le canvas en amont. La bibliothèque n'appelle plus `canvas.dispose()` |
| `ImageProvider::Make()` (`RNImageProvider.h`) | 1 édition | **Retirée** : corrigé en amont. `test-skia-provider-ownership.mjs` vérifie maintenant la fabrique amont |
| Soumissions vérifiées (`JsiSkSurface.h`, `RNDawnContext.h`) | 7 éditions | **Gardées, réécrites** : `submitRecordingChecked(recorder, sync)` lève une erreur quand la recording ne peut pas être créée, quand le device est perdu, quand Graphite la refuse ou quand la soumission échoue. L'amont renvoie `false` ou journalise. `makeImageSnapshot()` ne lève plus que sur une surface vérifiée |
| `__rnskvTrimRecorderCache` (`JsiSkApi.h`) | 2 éditions | **Gardé, réduit** : soumission vérifiée synchrone, puis `DawnContext::trimThreadRecorders(0, true)` de l'amont |

**PR amont :**
- [#4274](https://github.com/wcandillon/react-native-skia/pull/4274) est **redondante** : son commit est entré par #4277. Elle peut être fermée.
- [#4275](https://github.com/wcandillon/react-native-skia/pull/4275) est **fermée**, remplacée par #4278.
- [#4276](https://github.com/wcandillon/react-native-skia/pull/4276) est **toujours utile mais en conflit** : `flush()` ignore encore le `false` de `submitRecording`. À refaire sur le nouveau code, par exemple en levant une erreur dans `flush()` quand `submitRecording` renvoie `false`.
