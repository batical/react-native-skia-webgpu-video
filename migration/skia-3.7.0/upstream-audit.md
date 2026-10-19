# Audit Skia 3.6.1 → 3.7.0 / WebGPU 0.16.0 → 0.17.0 — 19 octobre 2026

Audit des **archives npm publiées**, comparées fichier par fichier (`npm pack`, hors `lib/` et web), puis migration du dépôt. Les mesures et contrôles exécutés sont dans [verification.md](verification.md).

## Versions retenues

**`react-native-skia@3.7.0` + `react-native-webgpu@0.17.0`**, sur Graphite **157.0.0** et **`react-native-webgpu-dawn@157.0.0`**. C'est la première montée des binaires depuis 3.4.4 : Skia passe de `chrome/m154` à `chrome/m157`, et Dawn au commit `ada567700e` (441 commits après celui de m154).

| Paquet | Versions publiées depuis la migration précédente |
| --- | --- |
| Skia | 3.6.2 (17 oct., 09:53 UTC), 3.6.3 (16:55), 3.7.0 (18 oct., 19:51) |
| WebGPU | 0.16.1 (17 oct., 09:48 UTC), 0.17.0 (18 oct., 20:04) |

- **Les deux paquets doivent monter ensemble.** Le podspec et Gradle de WebGPU refusent une app dont Skia et WebGPU résolvent deux Dawn différents. WebGPU 0.16.x épingle Dawn 154.3.0 et 0.17.0 épingle 157.0.0, comme Skia 3.7.0. `npm ls` ne montre qu'un `react-native-webgpu-dawn@157.0.0`, dédupliqué.
- Les dépendances pair n'ont pas bougé : Skia demande RN ≥ 0.79, Reanimated ≥ 4 et Worklets ≥ 0.7 ; WebGPU demande RN ≥ 0.81, Reanimated ≥ 4.2.1 et Worklets ≥ 0.7.2.
- WebGPU fixe désormais un plancher Android à l'API 26 (`androidMinSdkVersion`). L'exemple et la bibliothèque exigent déjà l'API 28.
- Notre code natif (`cpp/`, `android/cpp`, `ios/`) n'inclut aucun en-tête Skia ou Dawn : il ne dépend des deux paquets qu'à travers JS.

## Changements Skia

| Version | Changement | Dans ce dépôt |
| --- | --- | --- |
| 3.6.2 | Un sous-arbre suspendu dans un `Canvas` est masqué au lieu de lever une erreur | Non utilisé |
| 3.6.2 | Android : les vues support (`TextureView`, `SurfaceView`) sont fixées au montage | Aperçu Android seulement |
| 3.6.2 | **Plus de crash sans Vulkan.** Le GPU est sondé une fois, sur un thread natif, au chargement du module ; `Skia.gpu` dit lequel est utilisé, ou pourquoi il n'y en a pas. `DawnContext::getInstance()` lève alors une erreur au lieu d'abandonner. Une perte du device (reset pilote, mémoire GPU épuisée) n'abandonne plus le processus : les canvases gardent leur dernière image et les appels GPU échouent | Un export sur device perdu échoue avec une erreur au lieu de tuer l'app. Le patch local hérite de ce comportement (voir plus bas) |
| 3.6.2 | Le manifeste Android de Skia déclare **Vulkan 1.1 comme fonctionnalité requise** (`android.hardware.vulkan.version`, `required="true"`) | Fusionné dans le manifeste des apps : le Play Store ne les propose plus aux appareils sans Vulkan 1.1, sur lesquels cette bibliothèque ne fonctionnait de toute façon pas |
| 3.6.3 | **Le producteur de rendu garde une frame d'avance sur l'affichage** au lieu de zéro (`RNSkGraphiteProducer`). Sur un Pixel 8 à 120 Hz, un canvas `SurfaceView` présentait une image sur deux (66 fps) ; il en présente 110 | Aperçu seulement, pas l'export |
| 3.7.0 | Skia m157, Dawn 157.0.0 | Voir plus bas |
| 3.7.0 | **Android : Dawn demande trois images FIFO à la swapchain au lieu de deux** (patch Dawn [#4257](https://github.com/wcandillon/react-native-skia/pull/4257)) | **Canvas plus fluide sur Android 10**, voir plus bas |
| 3.7.0 | Android : la robustesse Dawn reste activée (`disable_robustness` n'est plus demandé). Sans elle, le compilateur de shaders Adreno 740 plantait | S'applique aussi à nos shaders WGSL, voir plus bas |
| 3.7.0 | Graphite : un runtime effect dont une variable locale s'appelle comme un paramètre de `main` (`pos`, `inColor`, `destColor`) ne plante plus | Corrige les `drawFrame` des utilisateurs qui déclarent un tel shader ; la bibliothèque n'en crée pas |
| 3.7.0 | **Vue support Android nommée explicitement.** La prop `opaque` de premier niveau disparaît, `android.surfaceType` devient `android.backingView`. `android.opaque` existe désormais aussi pour une `TextureView` | Aucune de ces props n'est utilisée dans `src/`, l'exemple ou le README |

### Canvas plus fluide sur Android 10

**Le problème, mesuré en amont.** Sur Android 10, le thread principal attendait dans `dequeueBuffer` à chaque frame présentée par un canvas opaque :
- Dawn demandait deux images en FIFO ;
- le chargeur Vulkan d'Android ne laisse l'app tenir que `minImageCount - 1` buffers à la fois ;
- Android 10 ne rend le buffer affiché qu'après avoir composé la frame suivante, quelques millisecondes après le vsync.

Chaque frame attendait donc la libération de la précédente. Android 14 n'a pas cette attente.

**Le correctif.** Dawn 157.0.0, livré par `react-native-webgpu-dawn`, demande trois images en FIFO sur Android, le triple buffering qu'Android applique à ses propres fenêtres. Dawn borne ce nombre aux capacités de la surface.

**Mesures de l'amont**, Mi MIX 3 sous Android 10, sur une trace d'environ 1,9 s :

| Scène | Attente `dequeueBuffer` avant | Après |
| --- | --- | --- |
| Un canvas opaque animé | 407 ms (médiane 3,6 ms par frame de 16,7 ms) | 65 ms |
| Quatre canvases opaques | 503 ms | 138 ms |

- Le nombre de frames par 10 s ne change pas, ni sur le Mi MIX 3 ni sur un Galaxy S23 (Android 14). Le thread principal récupère ce temps.
- **Coût :** un buffer de plus par canvas sous Android 10, soit 8,8 Mio pour un canvas plein écran en 1080×2111.

**Pour ce dépôt :**
- Le correctif est dans le binaire Dawn partagé. Il couvre donc toutes les swapchains de l'app : les canvases Skia, y compris notre aperçu vidéo, et les canvases WebGPU. Il ne demande aucun changement de code.
- **Nous ne l'avons pas mesuré nous-mêmes** : aucun appareil Android 10 n'était disponible. Le Pixel 8a, sous Android 17, n'avait pas cette attente.
- L'export n'utilise pas de swapchain : il n'est pas concerné.

### Robustesse Dawn sur Android

Nos shaders WGSL tournent sur le device de Skia (`Skia.getNativeDevice()`, [`gpuDevice.ts`](../../src/gpuDevice.ts)) :
- le blit YUV des frames `ImageReader` ([`yuvBlit.ts`](../../src/yuvBlit.ts)) ;
- la conversion en place à l'export ([`exportFrames.ts`](../../src/exportFrames.ts)).

Avec la robustesse, Tint ajoute des contrôles de bornes à leurs accès aux buffers et aux textures. Ces shaders ne lisent qu'une texture externe et un buffer d'uniformes : le surcoût attendu est faible. Il est mesuré sur le Pixel dans la [vérification](verification.md).

### Patch local

Sur les sept fichiers touchés par le patch :
- **cinq ont la même empreinte qu'en 3.6.1** : `JsiSkCanvas.h`, `Canvas.ts`, `Canvas.d.ts`, `JsiSkSurface.h` et `RNImageProvider.h` ;
- **`RNDawnContext.h` et `JsiSkApi.h` changent**, pour la sonde GPU et `Skia.gpu`.

Le nouveau [`react-native-skia+3.7.0.patch`](../../patches/react-native-skia+3.7.0.patch) garde **61 des 62 éditions**. La seule retirée ajoutait `#include <stdexcept>` à `RNDawnContext.h`, que 3.7.0 inclut désormais. Toutes les autres ancres sont trouvées une seule fois.

Points relus dans les deux fichiers modifiés :
- `submitRecordingChecked` utilise toujours `_mutex`, `fGraphiteContext->insertRecording` et `submit` ;
- `__rnskvTrimRecorderCache` appelle `DawnContext::getInstance()`, qui lève désormais une erreur sans GPU. Un appel JSI la propage en `Error` JS : c'est le comportement voulu.

Chaque partie du patch reste nécessaire, pour les raisons de l'[audit 3.4.4](../skia-3.4.4/upstream-audit.md) :
- `canvas.dispose()` ;
- les soumissions vérifiées ;
- le snapshot nul ;
- `ImageProvider::Make` ;
- `__rnskvTrimRecorderCache`.

Le patch compile contre les en-têtes Graphite et Dawn m157 (`test-skia-patch-syntax.mjs`).

## Changements WebGPU

| Version | Changement | Dans ce dépôt |
| --- | --- | --- |
| 0.16.1 | Android : vue support fixée au montage | Non utilisé |
| 0.16.1 | Les constructeurs traversent les runtimes worklet | Rien à changer |
| 0.16.1 | Bibliothèque Android construite à son plancher API 26 | L'exemple est en API 28 |
| 0.17.0 | Dawn 157.0.0 | Même Dawn que Skia 3.7.0 |
| 0.17.0 | `ImageBitmap` traverse les runtimes worklet | Non utilisé |
| 0.17.0 | Vue support Android nommée explicitement, comme Skia | Non utilisé |
| 0.17.0 | `installWebGPU()` installe aussi les constructeurs des classes WebGPU sur le runtime appelant (`instanceof` fonctionne en worklet) | Appelé dans `gpuDevice.ts` ; un coût au premier appel par runtime, sans effet sur notre code, qui ne fait pas d'`instanceof` |

Les en-têtes de l'API native n'ont pas changé entre 0.16.0 et 0.17.0, hors Dawn. Restent donc inchangés pour nous :
- `createNativeBufferExternalTexture` et son `sourceColorSpace` ;
- `importSharedTextureMemory` et l'import IOSurface en place sur iOS ;
- `GPUSharedFence.export()` des buffers encodeur Android ;
- `createVideoFrameFromNativeBuffer`.

Le seul ajout à la liste des features est `shared-buffer-memory-host-pointer`, que nous n'utilisons pas.

**Risque principal :** les 441 commits Dawn touchent la conversion YUV et l'import des buffers natifs. Comme après WebGPU 0.15, le contrôle `interop` du Pixel est relancé : il compare les pixels décodés et exportés au chemin CPU.

## Conseil pour l'aperçu sur Android

L'aperçu vidéo du README utilise un `<Canvas>` par défaut, soit une `TextureView` translucide. Il profite des deux correctifs de pacing sans changement :
- les trois images de swapchain (3.7.0) ;
- la frame d'avance du producteur (3.6.3).

Une app dont l'aperçu couvre tout le canvas peut aussi déclarer `android={{ opaque: true }}`, qui évite le mélange alpha de la `TextureView`, ou `android={{ backingView: "SurfaceView" }}` pour le chemin direct du compositeur. Une `SurfaceView` ne suit pas les transformations et les animations de vue comme une `TextureView`. Ces options n'ont pas été mesurées ici.
