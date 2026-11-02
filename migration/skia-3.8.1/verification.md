# Vérification de la migration Skia 3.8.1 / WebGPU 0.19.2 — 1er novembre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette migration. Tous les builds sont en Release.

## Changements amont

- **3.8.0** ([#4323](https://github.com/wcandillon/react-native-skia/pull/4323)) renomme les factories sans alias. Nos appels deviennent `Skia.Image.MakeFromGPUTexture` (ex-`MakeImageFromGPUTexture`, dans `gpu.ts` et `exportFrames.ts`) et `Skia.Image.MakeRaster` (ex-`MakeRasterImage`, dans `frameInterop.ts`). Les mocks des tests suivent. [#4327](https://github.com/wcandillon/react-native-skia/pull/4327) retire `SkiaPictureView`, que la bibliothèque et l'exemple n'utilisent pas.
- **3.8.1** et **WebGPU 0.19.2** ([#4341](https://github.com/wcandillon/react-native-skia/pull/4341), [WebGPU #595](https://github.com/wcandillon/react-native-webgpu/pull/595)) activent le toggle Dawn `vulkan_monolithic_pipeline_cache` sur Android : un seul `VkPipelineCache` par device. Cela corrige un crash du pilote PowerVR (MediaTek mt6855) pendant la compilation des pipelines Graphite ([#4340](https://github.com/wcandillon/react-native-skia/issues/4340)), et les pipelines qui partagent des binaires compilent plus vite. Les deux paquets portent le même toggle dans leur création de device, d'où la montée commune.
- Les autres corrections de la 3.8.1 (alpha de `plusLighter`/`plusDarker`, Skottie, `fontVariations`) ne touchent pas nos chemins.
- **Dawn/Graphite restent en 157.0.0.** Les trois fichiers patchés (`RNDawnContext.h`, `JsiSkSurface.h`, `JsiSkApi.h`) sont identiques octet pour octet à ceux de la 3.7.4. Seuls la version du patch et son nom changent.
- PR amont : [#4276](https://github.com/wcandillon/react-native-skia/pull/4276) toujours ouverte, [#4274](https://github.com/wcandillon/react-native-skia/pull/4274) fermée (le correctif est entré par #4277). Le patch ne rétrécit pas.

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.8.1, WebGPU 0.19.2 ; un seul `react-native-webgpu-dawn@157.0.0` |
| `apply-skia-canvas-patch.mjs` | Patch appliqué, puis « already applied » au second passage |
| `test-skia-patch-syntax.mjs` | Passé : les en-têtes patchés compilent contre Graphite et Dawn m157 |
| Jest | **238/238 tests, 11 suites** |
| `tsc --noEmit`, `test:package`, `benchmark:test` | OK, 5/5, 122/122 |
| `test:native` ; `--pure-only --asan` (comme la CI) | Passé ; passé avec sanitizers |
| `npm run build`, `publint --strict` | OK, OK |

## Natif

- **iOS :** `pod install` (Ruby 3.2.0) ; `Podfile.lock` ne change que sur Skia et WebGPU. Le build Release signé réussit.
- **Android :** `assembleRelease` arm64 réussit, après suppression du bundle JS généré. L'APK contient le bundle renommé (`MakeFromGPUTexture`), et `librnskia.so`, `libreact-native-webgpu.so` et `libwebgpu_dawn.so` contiennent le toggle `vulkan_monolithic_pipeline_cache`.

## Reste à faire

- **iPhone 15 Pro :** tests natifs et profil `smoke`. Le premier lancement n'a pas démarré : téléphone verrouillé.
- **Pixel 8a :** contrôle `interop` (à relancer à chaque mise à jour WebGPU), profil `smoke` et un export 4K. Le changement natif de cette version ne concerne qu'Android. Le Pixel n'était pas branché.
