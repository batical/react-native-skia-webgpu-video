# Vérification de la migration Skia 3.4.4 / WebGPU 0.14.2 — 14 octobre 2026

Ce document liste ce qui a **réellement** été exécuté sur ce poste (Xcode 27.0, simulateur iPhone 17e sous iOS 26.4, Release), puis sur **iPhone 15 Pro** (voir [Appareil iOS](#appareil-ios--iphone-15-pro)). Aucune exécution sur appareil Android. Les chiffres simulateur ne qualifient ni la vitesse ni la mémoire sur appareil : le simulateur décode la vidéo en logiciel, et son GPU comme son encodeur diffèrent de ceux d'un iPhone.

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.4.4, WebGPU 0.14.2 ; un seul `react-native-webgpu-dawn@154.3.0` dédupliqué |
| `apply-skia-canvas-patch.mjs` | Patch appliqué sur le paquet installé |
| `test-skia-patch-syntax.mjs` | Headers patchés compilés contre Graphite/Dawn 3.4.4 (syntax-only, arm64 simulateur) |
| `test-skia-provider-ownership.mjs` | Factory `ImageProvider` patchée : référence de construction adoptée |
| Jest | **204/204 tests, 9 suites** (199 avant les ajouts de cette passe) |
| `tsc --noEmit` | OK |
| `test:package` | 5/5 |
| `benchmark:test` | 112/112 |

Les tests JS modélisent l'ordre des appels et la rétention des ressources. Ils ne prouvent pas les pixels calculés par le GPU.

## Natif iOS, simulateur

- **`pod install`** (Ruby 3.2.0) : Graphite 154.3.0 installé pour iOS, tvOS et macOS. Sortie : `Dawn versions match (react-native-webgpu-dawn 154.3.0)`.
- **50/50 XCTests natifs**, Release, sur l'arbre migré. Ces messages ont été vus pendant ce run :
  - 455 lignes système `(Fig) signalled err=-12900` (le code de `kVTPropertyNotSupportedErr`).
  - Un run identique sans `alwaysCopiesSampleData = NO` produit les mêmes 455 lignes et les mêmes 50/50 succès. Ces messages ne viennent donc pas de ce changement.
  - Aucun run XCTest antérieur n'était conservé pour comparer.
- **Profil smoke de l'app (5 cas, une répétition) : tous réussis**, y compris `encode-h264-copy` et `4k-x8-lazy-maxLongSide1280`, qui exportent 60/60 et 360/360 images.
  - Le sérialiseur worklet 3.4.4/0.14.2 transporte donc bien le device et les objets WebGPU vers le runtime d'export et le runtime UI.
  - Le profil par étape (`onProfile`) fonctionne aussi en natif.

## Attribution sur simulateur

Les deux cas d'export ont été rejoués **trois fois chacun**, avec la même installation de fixtures. Le JSON compact est dans [`benchmark/ios-simulator-344-export-ab.json`](../../benchmark/ios-simulator-344-export-ab.json).
- La **référence** est construite depuis `git archive HEAD` : Skia 3.0.6 / WebGPU 0.12.1, avec le code d'export du commit a2a01ae.
- **A** : la montée de version seule.
- **B** : A + fermeture immédiate des imports et des fences encodeur.
- **C** : l'arbre final, avec les frames décodées en place et `alwaysCopiesSampleData = NO`.

| Variante | `encode-h264-copy` médiane | 4K ×8 (1280) médiane | Pic suivi pendant l'export 4K | Octets produits |
| --- | --- | --- | --- | --- |
| Référence 3.0.6 | 199,6 ms | 3 356,5 ms | 7 réservations / 34,54 Mio | 101 073 / 1 258 136 |
| A | 240,7 ms | 3 328,7 ms | 7 / 34,54 Mio | identiques |
| B | 234,5 ms | 3 374,3 ms | 7 / 34,54 Mio | identiques |
| C | 202,0 ms | 3 259,5 ms | 4 à 5 / 23,99 à 27,51 Mio | identiques |

Lecture :
- **Sur simulateur, aucune variante n'est plus rapide de façon mesurable.** Les écarts restent dans la dispersion des trois répétitions, et ni la montée de version ni cette passe ne revendiquent de gain de vitesse.
- **L'import en place est bien actif en C.** La texture d'upload et les images possédées disparaissent du budget : de 7 à 4 ou 5 réservations, environ −10 Mio suivis à 1280×720.
- **Les fichiers ont la même taille à l'octet près** dans les quatre variantes. C'est un indice d'images encodées identiques, pas une validation des pixels : aucun validateur média n'est branché sur simulateur.
- **Le run du 8 octobre (2 889 ms pour `encode-h264-copy`) précède le commit a2a01ae** et ne sert pas de référence. Le gain d'environ ×14 visible entre ce run et les variantes vient de l'export GPU de ce commit, pas de Skia 3.4.4.
- **La lecture est identique entre A, B et C** : 721 images sans perte, seeks médians de 155 à 182 ms.

### Où part le temps (C + `onProfile`, ms par image, trois répétitions)

| Cas | Total | Décodage | Attente GPU | Import des frames | Buffer encodeur | Encodage | Dessin JS | Yield |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4K ×8 → 1280 | 8,9 à 9,0 | 4,7 à 5,0 | 1,5 | 1,0 | 0,8 à 0,9 | 0,5 | 0,1 | 0,1 |
| 640×360 | 2,4 à 3,0 | 0,15 à 0,26 | 0,7 à 0,8 | 0,4 à 0,6 | 0,6 à 0,7 | 0,4 à 0,5 | 0,1 | 0,1 |

**Sur simulateur**, le décodage logiciel domine l'export multi-clips. Hors décodage, les imports WebGPU par image (frames d'entrée et buffer encodeur) coûtent plus que l'attente GPU elle-même. Sur iPhone, le décodage matériel change ces proportions : refaire ce profil sur appareil avant de choisir la prochaine optimisation (voir les [pistes de l'audit](upstream-audit.md#pistes-suivantes-non-implémentées)).

## Appareil iOS : iPhone 15 Pro

Conditions :
- iPhone 15 Pro (iPhone16,1), iOS 27.0.1, Release, au premier plan, état thermique *nominal* pour chaque run.
- Runner `test-ios-device-ab-run.mjs`, catalogue `2026-10-07.1` profil `full`, trois répétitions par cas.
- Ordre : nouvelle version (c2), référence 3.0.6 construite depuis a2a01ae (base), puis nouvelle version (c3).
- Le JSON compact est dans [`benchmark/ios-device-344-export-ab.json`](../../benchmark/ios-device-344-export-ab.json) ; les fichiers bruts restent en `benchmark/results/*.local.json`.

| Cas (sortie) | 3.0.6 médiane | 3.4.4 c2 / c3 médianes | Écart |
| --- | --- | --- | --- |
| `native-hevc-1080p-rot270` (1080×1080, 180 images) | 956,4 ms | 735,1 / 738,4 ms | −23 %. Les six répétitions 3.4.4 (731 à 790 ms) sont toutes sous les trois de 3.0.6 (952 à 1 003 ms). |
| `encode-h264-copy` (640×360, 60 images) | 235,1 ms | 210,0 / 174,8 ms | −11 à −26 %, mais les plages se recouvrent en partie |
| `4k-x8-lazy-maxLongSide1280` (1080×1080, 360 images) | 2 946,3 ms | 2 734,8 / 2 852,4 ms | −3 à −7 %, plages proches |
| `4k-x3-simultaneous` | arrêt sur budget | arrêt sur budget | Les trois runs atteignent le budget mémoire pendant la **lecture** (« iOS decoder queue »), avant l'export : comportement identique dans les deux versions |

Les octets produits sont identiques entre versions pour chaque cas. `encode-h264-copy` alterne 51 534 et 52 073 octets, y compris au sein de la référence. Aucun validateur de pixels n'a tourné.

**Attribution.** Cette série compare l'ensemble « 3.4.4 + passe export » à 3.0.6, sans séparer les deux sur appareil. Sur simulateur, ni la montée de version seule ni la fermeture immédiate des imports n'étaient plus rapides (voir plus haut). Le gain appareil est donc probablement dû surtout à l'import en place, sans que ce soit démontré ici.

### Profil appareil (ms par image, c2 et c3)

| Cas | Total | Décodage | Attente GPU | Buffer encodeur (`target`) | Encodage | Import | Dessin + yield |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HEVC 1080p | 3,8 à 3,9 | 0,27 à 0,29 | 1,6 à 1,7 | 1,0 à 1,15 | 0,53 à 0,55 | 0,16 à 0,18 | ≈ 0,1 |
| 8 × 4K → 1280 | 7,4 à 7,8 | 4,8 à 5,2 | 1,4 à 1,5 | 0,17 à 0,21 | 0,53 à 0,56 | 0,19 à 0,24 | ≈ 0,15 |
| 640×360 | 1,9 à 2,2 | 0,28 à 0,33 | 0,8 à 0,9 | 0,3 à 0,44 | 0,34 à 0,40 | 0,07 à 0,08 | ≈ 0,1 |

Lecture :
- **Sur iPhone, les imports en place sont devenus marginaux** (0,1 à 0,2 ms), contrairement au simulateur.
- **Ce qui reste :**
  - l'attente GPU de chaque image (1,4 à 1,7 ms) ;
  - en 1080p, l'acquisition du buffer encodeur, autour de 1 ms. Elle inclut l'attente du pool plafonné à trois buffers, que l'encodeur scrute toutes les 2 ms ;
  - le décodage, dès que les sources sont en 4K (environ 5 ms).
- **Le dessin de ce benchmark est presque gratuit.** Dans une vraie composition, mesurer `drawMs` avec `onProfile` : textes, images raster et effets s'y ajoutent.

## Android

**Après la passe export Android (soir du 14 octobre)** :
- `validate.sh build` réussit à nouveau. La bibliothèque arm64 contient les symboles `EncoderTargets` et le transport `ahardwarebuffer-egl-sample`.
- Les **43 tests JVM** sont cette fois réellement réexécutés (0 échec).
- Jest passe **208/208 tests, 10 suites**, dont 4 nouveaux tests Android :
  - import par pointeur AHB et sync-fd transmis à l'encodeur ;
  - repli si le buffer n'est pas RGBA ;
  - échec sur une fence non sync-fd ;
  - entrée toujours copiée.
- **Rien n'a été exécuté sur un appareil Android.**

### Pixel 8a, 15 octobre 2026 (Android 17)

**Tests natifs instrumentés de la bibliothèque** (`connectedDebugAndroidTest`, 102 exécutions) :
- 97 réussies et 5 échouées en run complet.
- Isolés, `NativeRgbaBufferTest` et `CompositionExportTest` passent.
- `MediaTest` (5 échecs) et `BigMontageTest` (2 échecs) échouent **à l'identique sur la copie de HEAD** (a2a01ae, sans les changements de cette passe). Tous ces échecs portent sur le budget du chemin CPU RGBA (`Video memory budget exceeded: android-frame-rgba`) ou sur un compteur de budget lu avant la fin du GC.
- Ces tests n'exercent ni Skia ni l'encodeur GPU. Ces échecs sont antérieurs à la migration et restent à traiter séparément.

**Profil `interop` de l'exemple** (APK nouvelle version, Release signé debug) :
- Décodage CPU vs AHB : **10/10 cas**, écart maximal de canal 0, sous Skia 3.4.4 / WebGPU 0.14.2.
- Contrôle d'export ajouté ([`example/export-pixel-check.ts`](../../example/export-pixel-check.ts)) : **réussi**.
  - Une mire à quatre quadrants (rouge, vert, bleu, blanc) est exportée par le nouveau chemin (`encodeTransport: "ahardwarebuffer-egl-sample"`), puis par le readback CPU (`cpu-rgba-upload`).
  - Les deux fichiers sont décodés, et quatre patchs 8×8 sont échantillonnés dans chacun.
  - Chaque couleur est exacte (255/0/0, 0/255/0, 0/0/255, 255/255/255) et à sa place : **orientation et canaux corrects**.
  - L'écart entre les deux chemins est de 0.

**Mesures d'export** :
- Commande : `scripts/test-android-device-run.mjs`, catalogue `2026-10-07.1` profil `full`, trois répétitions par cas.
- JSON compact : [`benchmark/android-device-344-export-ab.json`](../../benchmark/android-device-344-export-ab.json).
- Une app tierce (`com.azzapp.app_dev`) lisait une vidéo en arrière-plan pendant une partie des runs, et partageait donc le décodeur matériel. Elle était en pause à la fin.

| Cas (médiane) | 3.0.6 readback | 3.4.4 sortie GPU, décodage EGL (c1 / c2 / c3) | + décodage `ImageReader` |
| --- | --- | --- | --- |
| `native-hevc-1080p-rot270` (180 images) | 6 351,6 ms | 5 902,1 / 5 690,7 / 5 802,9 ms | **3 717,5 ms** |
| `encode-h264-copy` (60 images) | 1 750,0 ms | 1 740,4 / 1 739,8 / 1 715,2 ms | **1 285,3 ms** |
| `4k-x8-lazy-maxLongSide1280` (360 images, mise à l'échelle donc EGL) | 12 602,7 ms | 12 085,7 / 12 023,7 / 12 054,1 ms | 12 166,8 ms |

Lecture :
- **La sortie GPU seule gagne 3 à 10 %.**
- **`ImageReader` gagne 25 à 36 %** sur les cas à taille native. Les plages des trois répétitions ne se recouvrent pas.
  - Le profil passe de 11,4–11,9 à 2,6–2,9 ms de décodage par image en HEVC 1080p, et de 8,9–9,8 à 2,9–3,2 ms en 640×360.
- **Ce qui reste en HEVC 1080p** (ms par image) : import (blit YUV + snapshot) 6,3–6,6, encodage 4,2–4,3, attente GPU 2,4–2,5, décodage 2,6–2,9.
- **Tailles de fichier.** Les octets produits sont identiques entre 3.0.6 et les builds EGL. Avec `ImageReader`, les fichiers grossissent de 5 % en HEVC et de 16 % en 640×360, alors que le contrôle de pixels donne un écart de 0 à 1 sur les patchs.
  - Hypothèse non vérifiée : le chemin GL rééchantillonnait l'image d'un texel contre le débordement bilinéaire, et l'image plus nette se compresse moins.
- **Un échec hors export** : une répétition 4K de c3 (build EGL) a échoué pendant la *lecture* (« Too many missing settled frames »), avant son export.

**4K à taille native** (deux builds 3.4.4, `ImageReader` puis décodage EGL, trois répétitions) :

| Cas (export 1080×1080) | Décodage EGL | `ImageReader` |
| --- | --- | --- |
| `4k-x8-lazy` (8 clips 4K successifs, 360 images) | 23 763 / 25 097 ms | 13 529 / 13 472 ms (−44 %) |
| `4k-x3-simultaneous` (3 clips 4K simultanés, 150 images) | 20 569 à 21 198 ms | 8 737 à 9 033 ms (−58 %) |

- **Profil par image :**
  - décodage : de 31–33 à 8,5 ms en 8×4K, et de 70–74 à 7,3–8,1 ms en 3×4K ;
  - import (blit + snapshot 4K) : de 21 à 16 ms, et de 50–51 à 36–37 ms.
- **La répétition 1 de `4k-x8-lazy` échoue dans les deux builds**, au même endroit : la lecture, à l'étape `preview:seek-settle` (« Preview operation timed out »), avant l'export. C'est une fragilité antérieure du seek en 4K lazy, pas un effet d'`ImageReader`.

**Contrôle `interop` avec `ImageReader`** :
- 10/10 cas, écart maximal de canal 0 à 1 face à la référence CPU EGL. Cela couvre la rotation 90°, le portrait 1080×1920, et la 4K H.264 et HEVC.
- Le contrôle d'export passe aussi : quadrants 254/0/0, 0/254/0, 0/0/255, 255/255/255, avec un écart nul entre chemins.
- Sur ce Pixel, le décodeur rend le format gralloc propre au fabricant `0x123`. RN WebGPU l'étiquette `"bgra8"`, mais Dawn l'importe en `OpaqueYCbCrAndroid`. Les gardes vérifient donc le format réel côté natif, pas l'étiquette.

Protocole de mesure sur Pixel 8a, avec les APK signés par la clé de debug dans `example/android/app/build/qualification/` :

```sh
node scripts/test-android-device-run.mjs --serial SERIAL --apk example/android/app/build/qualification/candidate-344.apk \
  --label pixel-344-export-c1 --case encode-h264-copy --case native-hevc-1080p-rot270 --case 4k-x8-lazy-maxLongSide1280
# puis la référence 3.0.6 (readback), puis à nouveau la nouvelle version
```

Avant toute mesure, lancer `android/scripts/validate.sh instrument SERIAL` pour les tests natifs, puis vérifier visuellement un export : orientation et couleurs.

`android/scripts/validate.sh build` réussit en 5 min 52 s : APK Debug et Release de l'exemple, AAR et APK d'instrumentation de la bibliothèque, arm64-v8a. Gradle résout le Dawn partagé pour les deux paquets (`react-native-skia: Dawn versions match (react-native-webgpu-dawn 154.3.0)`, `react-native-webgpu: Dawn from …/react-native-webgpu-dawn`). La tâche `testDebugUnitTest` est restée *up-to-date*, car les sources Android de la bibliothèque n'ont pas changé : ses 43 résultats JVM (0 échec) sont ceux du run précédent, pas une nouvelle exécution. Aucun test instrumenté ni aucune session sur Pixel n'ont été lancés : la voie AHardwareBuffer, le readback d'export 3.4.4 et le correctif de fences Vulkan restent à qualifier sur appareil.
