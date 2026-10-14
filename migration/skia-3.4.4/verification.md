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

Protocole prévu sur Pixel 8a, avec les APK signés par la clé de debug dans `example/android/app/build/qualification/` :

```sh
node scripts/test-android-device-run.mjs --serial SERIAL --apk example/android/app/build/qualification/candidate-344.apk \
  --label pixel-344-export-c1 --case encode-h264-copy --case native-hevc-1080p-rot270 --case 4k-x8-lazy-maxLongSide1280
# puis la référence 3.0.6 (readback), puis à nouveau la nouvelle version
```

Avant toute mesure, lancer `android/scripts/validate.sh instrument SERIAL` pour les tests natifs, puis vérifier visuellement un export : orientation et couleurs.

`android/scripts/validate.sh build` réussit en 5 min 52 s : APK Debug et Release de l'exemple, AAR et APK d'instrumentation de la bibliothèque, arm64-v8a. Gradle résout le Dawn partagé pour les deux paquets (`react-native-skia: Dawn versions match (react-native-webgpu-dawn 154.3.0)`, `react-native-webgpu: Dawn from …/react-native-webgpu-dawn`). La tâche `testDebugUnitTest` est restée *up-to-date*, car les sources Android de la bibliothèque n'ont pas changé : ses 43 résultats JVM (0 échec) sont ceux du run précédent, pas une nouvelle exécution. Aucun test instrumenté ni aucune session sur Pixel n'ont été lancés : la voie AHardwareBuffer, le readback d'export 3.4.4 et le correctif de fences Vulkan restent à qualifier sur appareil.
