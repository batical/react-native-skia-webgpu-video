# Audit isolé Skia 3.0.6 / WebGPU 0.12.1 — 7 octobre 2026

Audit de sources, manifestes et archives officielles uniquement. Aucun build, aucune action appareil ni modification des dépendances de l'application mesurée. Les benchmarks physiques du parent restent Skia 3.0.3 / WebGPU 0.11.0. Les résultats de la migration doivent être conservés séparément.

## Cible actuelle, vérifiée après la publication 3.0.6

**Skia 3.0.6 + react-native-webgpu 0.12.1.** La proposition précédente 3.0.5 + 0.12.0 ci-dessous est historique, supplantée à la demande de l'utilisateur.

- Archive npm Skia3.0.6 : `/private/tmp/react-native-skia-3.0.6.tgz`, extraction `/private/tmp/rnskv-skia-306-package/package`.
- Archive npm Graphite iOS154.1.0 : `/private/tmp/react-native-skia-graphite-apple-ios-154.1.0.tgz`. Le contenu réel `package/libs/.dawn-version` est **`dawn-chrome-m154a`**, pas seulement une déclaration de documentation.
- Archive npm WebGPU0.12.1 : `/private/tmp/react-native-webgpu-0.12.1.tgz`, extraction `/private/tmp/rnskv-webgpu-0121-package/package`. Son manifeste annonce **`chrome-m154a`**, commit Dawn **`3d786993a7ded64c4ebb4884b9b079db9ad0e580`**.
- Diff de tous les fichiers des tarballs Skia3.0.5 et3.0.6 : **seul package.json diffère**, avec version et dépendances Graphite154.1.0. Toutes les observations API et empreintes de sources/patch3.0.5 ci-dessous s'appliquent à3.0.6 ; versionner le patch et son manifeste3.0.6.
- [Release officielle3.0.6](https://github.com/wcandillon/react-native-skia/releases/tag/v3.0.6), publiée7octobre07:10UTC : livraison Graphite154.1.0 (#4151), RTTI Android (#4145), token de release SwiftPM (#4150). Aucune nouvelle API JavaScript supplémentaire dans le paquet comparé.

### Ce que change WebGPU0.12.1 par rapport à0.12.0

Comparaison exhaustive des deux tarballs : dix fichiers changés, uniquement le manifeste, Package.swift, les bibliothèques Dawn Android/Apple et un Info.plist. **Aucune source de binding C++ ou JS modifiée.** Liste conservée dans `/private/tmp/rnskv-webgpu-0120-0121-changed.json`.

Le tagm154a reste basé sur le même commit Dawn, avec un correctif Tint rétroporté. Le [patch officiel au tag exact](https://github.com/wcandillon/react-native-webgpu/blob/dawn-chrome-m154a/packages/webgpu/scripts/dawn-patches/tint-looprange-function-variable.patch) remplace l'index de boucle porté par OpPhi par une variable de fonction, pour éviter un blocage GPU observé sur Pixel8/Mali-G715, pilote r54p3/Android17. Ce tag désigne une fabrication corrigée du moteur Dawn, **pas une nouvelle version du standard WebGPU**. Aucun gain iPhone n'en découle sans mesure.

[Release Dawnm154a](https://github.com/wcandillon/react-native-webgpu/releases/tag/dawn-chrome-m154a), publiée7octobre04:19UTC. Les réponses officielles API sont sauvegardées dans `/private/tmp/rnskv-dawn-m154a-release.json` et `/private/tmp/rnskv-dawn-m154a-patches.json`.

## Revue indépendante de la durée de vie du brouillon3.0.6

Brouillon audité en lecture seule : `/private/tmp/rnskv-skia-306-migration/src/frameInterop.ts`, `gpuDevice.ts`, `gpu.ts`. La correction du mécanisme d'erreur est réalisée par l'autre agent ; les résultats de tests unitaires qu'il rapporte ne constituent pas une validation GPU native.

### Synchronisation normale démontrée dans les sources natives

La [révision du sous-module Skia de3.0.6](https://api.github.com/repos/wcandillon/react-native-skia/contents/externals/skia?ref=v3.0.6) est `2466dcf3937437e217e7f284afe0e1aae15891ce`. Sources officielles copiées pour lecture dans `/private/tmp/rnskv-graphite-154-source`.

1. `RNWebGPU::importDevice` emprunte le WGPUDevice Skia avec `wgpuDeviceAddRef` ; aucun second device n'est créé.
2. Skia `RNDawnUtils` et `GPUDevice::getQueue` prennent tous deux `device.GetQueue()` : même queue Dawn.
3. `VideoFrameBlit` soumet son blit sur cette queue. Les commandes Graphite enregistrées ensuite y passent après lui.
4. [DawnQueueManager.cpp](https://chromium.googlesource.com/skia/+/2466dcf3937437e217e7f284afe0e1aae15891ce/src/gpu/graphite/dawn/DawnQueueManager.cpp#116) soumet son command buffer puis crée `OnSubmittedWorkDone(WaitAnyOnly)`. `Context::submit(SyncToCpu::kYes)` attend cette soumission via `WaitAny`, sur l'instance qui active TimedWaitAny. Sur succès natif, les deux leases CVPixelBuffer sont relâchées après cette attente.
5. [Surface_Graphite.cpp](https://chromium.googlesource.com/skia/+/2466dcf3937437e217e7f284afe0e1aae15891ce/src/gpu/graphite/Surface_Graphite.cpp#61) implémente le snapshot par `makeImageCopy`, avec stockage distinct. Réécrire l'upload et le staging après l'attente ne réécrit donc pas les pixels publiés.

**Coût exact du chemin natif conservateur : trois écritures GPU plein cadre** : source native→upload, upload→stage, stage→snapshot. Par rapport à3.0.3, c'est une passe et une texture upload supplémentaires. Ne pas promettre un gain de performance ni résumer ce chemin à seulement deux copies. Le cache borne à une texture upload par runtime et la compte dans son budget ; les objets/cache internes Dawn restent à mesurer au niveau du processus.

### Cas d'échec identifié, puis correction opt-in relue

Une première vérification craignait qu'un recording vide ne couvre pas le blit. La source Graphite montre qu'un **recording valide, même vide**, passe par `QueueManager::addRecording→setupCommandBuffer`, donc crée normalement une soumission/attente. Le clear explicite ajouté par l'agent demeure une intention défensive lisible ; il produit un LoadOp::kClear qui modifie bien la cible et n'est pas éliminé comme une absence de dessin.

Le problème avéré est plus précis : **`RNDawnContext::submitRecording` ignore `InsertStatus` et le booléen renvoyé par `submit`**. `Recorder::snap()` peut retourner null en cas de préparation de ressources ratée ; `insertRecording` peut échouer sans exception ; `submit` peut ne créer aucune nouvelle soumission. Dans ce cas, le JS peut interpréter un retour normal de `flush(true)` comme un drain alors que seule une ancienne soumission, ou aucune, a été attendue. Un test mock qui fait lever `flush` ne prouve pas ce cas natif.

Recommandation transmise : garde native ciblée sur recording nul, InsertStatus et submit dans le patch3.0.6, afin que les échecs remontent au mécanisme de rétention `pendingSources` avant la fermeture des leases. Ne pas assimiler cela à restaurer NativeBuffer ni à un nouveau backend d'export. La validation physique du nouveau couple reste obligatoire ; aucune garantie générale de récupération après device-loss n'est démontrée par cette seule garde.

### Correction du brouillon relue indépendamment

L'agent migration a ajouté `enableCheckedSubmissions()` par wrapper surface, activé dans `getVideoCanvas`. Cette méthode refuse les surfaces sans recorder Graphite. Le flag ne modifie pas les autres surfaces Skia. `flush()` et la soumission interne de `makeImageSnapshot()` passent alors par `submitRecordingChecked`, qui refuse un recording nul, vérifie `InsertStatus`, puis vérifie le booléen de `submit`. Les signatures correspondent aux headers exacts (conversion bool et message std::string). Aucun défaut bloquant identifié dans cette revue du chemin normal et du patch ciblé.

Le patch n'est **pas encore compilé ni exécuté sur iPhone au moment de cette revue**. Les échecs remontant depuis Dawn après la soumission restent soumis au contrat natif de device-loss ; ne pas transformer cette revue en garantie générale de récupération.

Cas de retry supplémentaire signalé à l'agent : réimporter exactement une frame déjà retenue dans `pendingSources` doit refuser l'import sans relâcher son lease original dans `finally`. Le wrapper WebGPU conserve également une référence CVPixelBuffer, mais garder les deux leases jusqu'au drain rend le contrat strict et vérifiable.

---

## Historique de l'audit3.0.5 (APIs identiques à3.0.6)

# Audit isolé Skia 3.0.5 / WebGPU — 7 octobre 2026

Audit de sources et de manifestes uniquement. Aucune installation, modification du dépôt gelé, compilation ou action appareil. Les mesures physiques en cours restent celles de Skia 3.0.3 / WebGPU 0.11.0. Ce document ne qualifie pas le nouveau couple en fonctionnement ou en performances.

## Couple proposé

**Skia 3.0.5 + react-native-webgpu 0.12.0**, puis tests séparés après le benchmark 3.0.3.

| Version WebGPU | Dawn annoncé | Observation |
| --- | --- | --- |
| 0.11.0 installé | chrome-m154 | Compatible avec le Dawn Skia actuel ; `copyExternalImageToTexture` ne sait traiter que les ImageBitmap. |
| 0.12.0 publié | chrome-m154 | Implémente le chemin officiel NativeVideoFrame → texture, nécessaire pour suivre l'exemple Skia 3.0.5 sans shader/import manuel. |
| 0.12.1 latest npm au moment de l'audit | chrome-m154a | Même `dawnCommit`, mais autre tag d'artifact. Le podspec Skia 3.0.5 exige l'égalité exacte avec `dawn-chrome-m154` de ses binaires 154.0.1. Ne pas contourner cette garde. |

Les trois déclarent le commit Dawn `3d786993a7ded64c4ebb4884b9b079db9ad0e580`. Skia 3.0.5 fixe les paquets `react-native-skia-graphite-*` à 154.0.1. Le paquet iOS 154.0.1 déjà installé porte `libs/.dawn-version = dawn-chrome-m154` ; le couple 3.0.5 / 0.12.0 est donc cohérent au niveau des versions déclarées. Cela ne remplace pas une compilation et une exécution natives.

Sources isolées :

- `/private/tmp/rnskv-skia-305-package/package`
- `/private/tmp/rnskv-webgpu-0120-package/package`
- `/private/tmp/react-native-webgpu-0.12.1.tgz` (archive seulement)

SHA-256 des archives npm :

```
react-native-skia-3.0.5.tgz
1dbc0b134b5406053d09f2e0be017d777e0090a4793705bfb9a8fa4408ccae88
react-native-webgpu-0.12.0.tgz
59d38228027fad7fba661a65c3e3a1f781efea7be3f5b1f97e285dd1f927f327
react-native-webgpu-0.12.1.tgz
7b3abeffa92ea0f90d89f0dc46ffeef373b40efeb175deaa299c38d410864994
```

## Changements d'API exacts

| Skia 3.0.3 | Skia 3.0.5 | Action dans notre bibliothèque |
| --- | --- | --- |
| `Image.MakeImageFromNativeTexture(pointer)` | `Image.MakeImageFromGPUTexture(textureOrPointer)` | Adapter `src/gpu.ts`. Le type `GPUTextureHandle` accepte `{nativePointer: bigint}` **ou** `bigint`, pas uniquement l'objet GPUTexture. |
| `Surface.MakeFromNativeTexture(pointer)` | `Surface.MakeFromGPUTexture(textureOrPointer)` | Adapter `src/gpu.ts`. Même contrat de référence ; `RENDER_ATTACHMENT` requis. |
| `Image.MakeNativeTextureFromImage(image)` | `Image.MakeGPUTextureFromImage(image)` | Renommage pour tout consommateur ; retourne encore un pointeur avec une référence à adopter exactement une fois via WebGPU `adoptTexture`. |
| `Image.MakeImageFromNativeBuffer(CVPixelBuffer/AHB)` | Méthode encore présente mais Web-only ; **throw explicite sur iOS/Android** | Refaire l'import de `src/frameInterop.ts`. Le nom présent ne signifie pas compatibilité native. |
| `Skia.NativeBuffer` | Supprimé de l'API Skia | Ne pas restaurer via patch. L'export de notre candidat n'y appelle déjà pas. |
| `MakeImageFromNativeTextureUnstable`, `getNativeTextureUnstable` | Supprimés des wrappers/types | Nettoyer les anciennes références de mocks/comments, puis rechercher les vrais appels éventuels dans les consommateurs. |
| Native `RNDawnContext::MakeImageFromBuffer` et plateformes `makeNativeBuffer`/`releaseNativeBuffer` | Supprimés | Notre production native n'inclut pas ces APIs ; ses CVPixelBuffer et codecs peuvent rester. |

Références source : `src/skia/types/GPUTexture.ts`, `cpp/api/JsiGPUTexture.h`, `JsiSkImageFactory.h`, `JsiSkSurfaceFactory.h`, `JsiSkSurface.h` du paquet 3.0.5. `gpuTextureFromValue` ajoute une référence via `wgpuTextureAddRef`, puis `Acquire` ; le producteur conserve la sienne. Une image/surface garde donc l'objet texture en vie, mais **`texture.destroy()` invalide le stockage même si des références restent**.

La release officielle 3.0.5 décrit le déplacement de l'API NativeBuffer vers WebGPU : https://github.com/wcandillon/react-native-skia/releases/tag/v3.0.5 (#4139). La release 3.0.4 décrit le correctif Android TextureView #4129 ; elle ne corrige pas la fermeture canvas ni le snapshot nul : https://github.com/wcandillon/react-native-skia/releases/tag/v3.0.4.

## Chemin de migration conseillé pour l'import iOS

Conserver le contrat existant d'image possédée, immuable pour le consommateur, et l'export avec readback. Cette migration ne doit pas être mêlée au prototype de sortie directe vers l'encodeur.

1. Créer/importer le device Skia sur le runtime RN principal et le partager selon le mécanisme Worklets natif existant. Capturer également l'instance native `RNWebGPU` dans une closure créée sur ce runtime, après installation.
2. Sur le runtime consommateur, `installWebGPU()` installe les constantes et `navigator.gpu`. Il **n'installe pas** `globalThis.RNWebGPU`. Le helper JS exporté `createVideoFrameFromNativeBuffer` n'est pas un worklet et lit ce global : ne pas supposer qu'il s'appelle tel quel depuis le runtime export/UI. L'instance `RNWebGPU` capturée est un NativeObject sérialisable : `RNWebGPUManager.cpp:79–85` enregistre son constructeur/brand avant de créer l'instance.
3. Appeler cette instance native capturée avec notre `texture.nativeBuffer` (un **CVPixelBufferRef**). `AppleVideoPlayer.mm::wrapCVPixelBuffer` obtient son IOSurface, retient le CVPixelBuffer, et crée un `NativeVideoFrame` avec `handle` IOSurface et `release()` explicite. Ce n'est pas le même pointeur que le `handle` attendu par `importSharedTextureMemory`.
4. Allouer/réutiliser un intermédiaire GPU borné sur le device Skia, avec `RENDER_ATTACHMENT | TEXTURE_BINDING` et un format pris en charge, par exemple BGRA8Unorm. WebGPU 0.12.0 `queue.copyExternalImageToTexture({source: nativeFrame}, {texture}, [width,height])` copie via `VideoFrameBlit` et soumet son rendu. Garder `rotation: 0` et ne pas inverser les lignes pour conserver le transport brut : notre `drawVideoFrame` applique déjà la rotation du média. Ne pas l'appliquer deux fois.
5. Envelopper l'intermédiaire avec `MakeImageFromGPUTexture`, dessiner vers le staging Skia existant, créer le snapshot possédé, puis effectuer le drain GPU existant sur le même device avant de libérer les sources et de réécrire l'intermédiaire.
6. Disposer le wrapper SkImage temporaire ; libérer le `NativeVideoFrame` WebGPU et notre frame native après le drain. Remplacer l'image publiée seulement lorsque toutes les étapes précédentes ont réussi. Conserver son snapshot précédent en cas d'échec.

Pourquoi conserver le staging : `MakeImageFromGPUTexture` est une **vue de texture**, pas une copie immuable. Publier cette vue puis réécrire la texture lors du frame suivant modifierait les pixels d'une image encore détenue, notamment en pause ou après un seek. Une autre conception peut utiliser des textures dédiées par image et un pool prouvant l'absence de consommateurs ; ce serait un changement de durée de vie plus large, inutile pour la première migration.

### Mémoire et erreurs

- Compter le nouvel intermédiaire GPU dans le budget vidéo, en plus du staging et du snapshot. Le réduire à une quantité fixe, le reconstruire après drain lors d'un changement de dimensions, et fermer explicitement ses consommateurs avant `destroy()`.
- Conserver notre frame native en vie jusqu'au drain même si l'amont dit que son wrapper peut être relâché au retour de la copie. Cette réserve protège le contrat du décodeur connu ; ne pas réduire simultanément la synchronisation pendant la migration.
- Préparer la ressource de drain avant la copie. Une erreur après une soumission GPU ne prouve pas l'absence de travail en cours. Les états d'erreur doivent garder la frame, l'intermédiaire et leurs réservations jusqu'à une fermeture prouvée, avec une file bornée, comme les `pendingSources` existants.
- `VideoFrameBlit` met en cache le shader/layout/sampler/pipeline par format et par device ; il crée un uniform buffer de 80 octets et un bind group par copie. Ces allocations natives et caches ne sont pas tous représentés par nos seuls compteurs de textures. Mesurer le processus reste indispensable.
- `GPUExternalTexture::destroy` termine l'accès et annule ses références natives explicitement après `queue.Submit`. Le chemin officiel évite d'introduire dans notre JavaScript un `GPUSharedTextureMemory` par frame sans méthode `dispose`/`destroy` (situation de la 0.11.0).
- Le chemin Android actuel de notre backend fournit `kind: 'rgba'` ; sa construction `Skia.Data.fromBytes` puis `MakeImage` reste disponible. Ne pas prétendre le convertir aux AHardwareBuffer dans cette adaptation.
- Les formats de sortie vidéo/HDR ne s'élargissent pas du seul fait que WebGPU gère RGBA16Float ou RGB10A2. Conserver les garanties SDR existantes.

`VideoFrameBlit` vérifie `RENDER_ATTACHMENT`, le format et les dimensions. Il appelle `GPUExternalTexture::Create`, dessine puis `queue.Submit` et `external.destroy`. Une validation de source n'atteste pas les chemins d'échec sous pression mémoire : prévoir tests d'import raté, allocation ratée, annulation, seek et nettoyage répété.

## Patch de durée de vie encore requis

Les fichiers canvas/type de 3.0.5 sont byte-identiques aux fichiers AVANT le patch 3.0.3. Le canvas retient encore `_surface`; il n'a pas `dispose()`. `JsiSkSurface::makeImageSnapshot` n'a toujours pas de garde avant la construction/remplacement du wrapper image lorsque l'allocation retourne null.

Les substitutions du manifeste3.0.3 trouvent toutes leur cible exactement une fois dans3.0.5. Générer un **nouveau manifeste versionné3.0.5**, sans désactiver les contrôles de version/empreinte. Voici les empreintes SHA-256 calculées en mémoire en appliquant les mêmes substitutions, sans écrire dans les dépendances :

| Fichier | Avant3.0.5 | Après substitutions existantes |
| --- | --- | --- |
| cpp/api/JsiSkCanvas.h | a9b8d2552df8ba3c073c32d8e811945986ef8342fdcbfea168249cf0234e2dd1 | 2758ab28fbc73fd59923720ba8594796d3e80a987adfd12bd59c16590797af13 |
| src/skia/types/Canvas.ts | a9c2abc2f79de8ce16497dd693e7ff96b9be93fa33dff6f1b513259af780d8d1 | 226b25b561ad39a6812c8d5f8990e5ac9c078d3283f2bad90e725f077d84efd7 |
| lib/typescript/src/skia/types/Canvas.d.ts | ca8ce8e58c1fc94508fd9d298c038316409734cef2b39ac6b7281b2c3958150a | b1878eafa831d6c3d7a47f4329a94dd64cef4bae5281cc144d3258a5c4a1021c |
| cpp/api/JsiSkSurface.h | 35d21a97e8ad91761da1553613ce9d52e153c4bede935dab2dfba4bcbbb425d1 | e554ffcaaa9a885ebd75f2b4e2609b5df16cf68c89a5200c172275a66ab61754 |

## Validation à réserver au nouveau couple

Validation TypeScript/mocks dans la copie isolée, puis compilation native séparée ; ensuite pixels/couleurs/rotation, stabilité du snapshot de pause, transitions/seek, annulation et reprise, changements de résolution, nettoyage à répétition et mémoire physique. Rejouer le catalogue courant65 et les exports longs après le protocole3.0.3. Conserver des identités de versions/binaire distinctes dans les résultats ; aucun résultat3.0.3 ne doit être réétiqueté3.0.5.

Cette migration résout une rupture d'API. Elle ne supprime pas le `readPixels` de l'export et ne constitue pas le prototype de sortie directe évoqué dans les notes amont. L'intérêt de ce prototype et celui des fonctionnalités ML/3D restent à discuter après les résultats. L'annonce d'une future version WebGPU Google reste non identifiée et ne fonde aucune décision dans cet audit.
