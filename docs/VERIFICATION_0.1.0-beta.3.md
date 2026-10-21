# Vérification de la 0.1.0-beta.3 — 21 octobre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette version :
- sur l'hôte ;
- sur **iPhone 15 Pro** (iOS 27.0.1) ;
- sur **Pixel 8a** (Android 17).

Tous les builds sont en Release, sur Skia 3.7.1 / WebGPU 0.17.0, inchangés depuis la beta.2. L'analyse du format des frames est dans [FRAME_PIXEL_FORMAT.md](FRAME_PIXEL_FORMAT.md).

## Ce qui change

- **Horloge de `drawFrame`** (iOS, Android) : `currentTime` vaut l'heure à laquelle les frames dessinées ont été choisies. Lue plus tard, elle avançait jusqu'à une frame sur la vidéo à 60 fps, et les overlays calculés d'après elle étaient décalés d'autant.
- **`splitImportAndDraw`** ne perd plus une frame sur deux quand une nouvelle frame arrive à chaque vsync.
- **Android 15+** : une preview en lecture demande à l'écran sa fréquence maximale. Le Pixel ne descend plus à 30 Hz, et monte à 120 Hz quand le réglage de l'utilisateur le permet.
- **iOS** : la file de décodage de la preview tourne en priorité *user-interactive* au lieu d'*utility*.
- **`framePixelFormat`** (`'auto' | 'yuv' | 'rgba'`) : `auto` vaut `yuv` sur les deux plateformes. Sur iOS, le décodeur sort désormais du NV12 (12,4 Mo par frame 4K au lieu de 33,2 Mo de BGRA). `rgba` reste disponible.
- **Diagnostic** : `getResourceStats()` donne sur iOS les refus de l'anneau de frames, les files de décodage vides et les ticks de décodage lents.
- **App de test** : profil `sync` (exactitude des frames, seeks, exports, couleurs, rendu de vrais médias), option `--frame-pixel-format` des lanceurs, `--case` pour iOS, clé `CADisableMinimumFrameDurationOnPhone` (120 Hz sur ProMotion).

## Hôte

| Contrôle | Résultat |
| --- | --- |
| Jest | **237/237 tests, 11 suites** (dont les chemins NV12 de la preview et de l'export) |
| `tsc --noEmit`, `test:package`, `benchmark:test` | OK, 5/5, 122/122 |
| `test:native` (C++ hôte, validation native, syntaxe des 50 assertions iOS historiques) | OK |
| Tests JVM | 27/27 |
| `test-skia-patch-syntax.mjs`, `test-skia-provider-ownership.mjs` | OK |
| `npm run build`, `check-package` (publint strict) | OK |

## Exactitude de la lecture (profil `sync`)

Chaque frame des fixtures porte son numéro en code-barres, lu à chaque vsync dans `drawFrame` et comparé à l'horloge du player. « Exact » : part des vsyncs qui montrent la frame due. « Irr » : part des changements de frame décalés de plus de 3/4 de vsync. Écran à 60 Hz.

| Cas | Pixel, avant | Pixel, beta.3 | iPhone, avant | iPhone, beta.3 |
| --- | --- | --- | --- | --- |
| 30 fps | 93 % · irr 1,8 % | **99,4 %** · irr 1,8 % | 100 % | 100 % |
| 30 fps, `splitImportAndDraw` | 79 % · irr 81 % · 75 frames sautées | **99 %** · irr 0 % · 2 | 100 % | 100 % |
| 24 fps | 85 % · irr 21 % | **100 %** · irr 4,6 % | 100 % | 100 % |
| 60 fps | 51 % · 166 sautées | **99,4 %** · 2 | 80 % · 9 sautées | **100 %** |
| HEVC 1080p 60 fps | 66 % | **98,8 %** | 99,7 % (0,3 % au premier run) | **100 %** |

« Avant » : le code de `main` avec le seul profil `sync` ajouté. Les 2 à 9 frames sautées restantes tombent au démarrage d'une lecture.

**4K, `yuv` (défaut) contre `rgba`** :

| Cas | Pixel `rgba` | Pixel `yuv` | iPhone `rgba` | iPhone `yuv` |
| --- | --- | --- | --- | --- |
| HEVC 4K 60 fps | 18 % · irr 65 % · 205 sautées | **97 % · irr 0,3 %** · 9 | 66 % · irr 6,5 % · 64 | **97 % · irr 1,3 %** · 9 |
| HEVC 4K 30 fps | 38 % · irr 52 % | **100 %** · irr 0 % | 97 % · irr 1,9 % | **100 %** · irr 0 % |
| H.264 4K 30 fps | 38 % · irr 48 % | **99 %** · irr 0,6 % | 96 % · irr 6,9 % | **100 %** · irr 1,2 % |
| Vraie vidéo 4K 60 fps, 60 Mbit/s (frames distinctes) | 145/360 | **335/360** | 268/360 | 267/360 |

Le Pixel est resté à l'état thermique *nominal*. Les deux runs iPhone de ce tableau ont tourné téléphone chaud, *fair* pour `rgba` et *serious* pour `yuv`. Quatre runs alternés `rgba` / `yuv` / `rgba` / `yuv`, tous en *serious*, confirment l'avantage du `yuv` en 4K : en HEVC 4K 60 fps, 294–311 frames sur 360 contre 241–261, et 77–90 % d'exact contre 46–48 % en lisant une frame sur quatre. En 1080p et en 30 fps, les écarts restent dans la dispersion entre runs (73 à 95 % d'exact dans les deux formats). Détail dans [FRAME_PIXEL_FORMAT.md](FRAME_PIXEL_FORMAT.md#preview).

Les **seeks** tombent juste sur les deux plateformes : 22/22 sur chaque téléphone, y compris à ±0,5 ms d'une limite de frame. Sur Android, un seek en pause montre les frames intermédiaires décodées depuis la keyframe avant la bonne ; l'iPhone garde l'image précédente. Ce comportement n'a pas changé.

## Exports

Chaque frame exportée porte son numéro de sortie sous le code-barres source, et est relue après l'export. **Tous les exports sont exacts sur les deux téléphones et dans les deux formats** (30→30, 60→30, 30→60, 24→30, HEVC 60→60, coupe, 4K→4K en 30 et 60 fps, 4K→1080p) : la bonne frame source, aucune frame perdue ou dupliquée, et le décodeur du système compte le bon nombre de frames dans chaque fichier.

| Pixel 8a | `yuv` | `rgba` |
| --- | --- | --- |
| 4K 60 → 4K 60 | **5,0 s** | 15,6 s |
| 4K 30 → 4K 30 | **3,2 s** | 8,7 s |
| 4K 60 → 1080p 30 | **2,4–2,9 s** | 8,0–8,2 s |

| iPhone 15 Pro, runs alternés en *serious* | `yuv` | `rgba` |
| --- | --- | --- |
| 4K 60 → 4K 60 | 4,2–4,3 s | 4,1–4,5 s |
| 4K 30 → 4K 30 | 2,3 s | 2,4–2,7 s |
| HEVC 1080p 60 → 640×360 | 0,9–1,4 s | **0,5 s** |
| Montage de 120 clips (suite `full`) | 18,1 s | **14,0 s** |

Sur iOS, l'export `yuv` importe et convertit chaque frame NV12 au lieu de lire le BGRA en place : environ 2 à 4 ms de plus par frame, sensibles sur les exports longs ou à petite sortie.

## Rendu et couleurs

- **Mire SMPTE** (H.264 et HEVC 1080p, Rec.709) comparée à ffmpeg : écart maximal de 0 niveau en `yuv`, 1 en `rgba`, sur les deux téléphones.
- **Vraie vidéo** (trois clips tirés de photos d'appareil, étiquetés Rec.709) comparée à ffmpeg sur 24 points à trois instants : écart moyen de 0,07 à 0,16 en `yuv` sur les deux téléphones (max 1). En `rgba` : 0,15 à 0,48 sur le Pixel, 0,5 à 0,8 sur l'iPhone (max 5).
- **Clip étiqueté Display P3** : `yuv` reste à 0,2 de ffmpeg ; `rgba` convertit le gamut (iPhone : moyenne 5,8, max 26 ; Pixel : 1,3, max 16).
- **Fixtures du benchmark** (rotations, HDR HLG, portrait, SD, slow motion), `yuv` contre `rgba` : écart moyen de 0 à 0,8 niveau. Les maxima ponctuels de 5 à 17 sont sur des bords nets.
- **Pixel, `interop`** : décodage GPU contre CPU **10/10**, écarts maximaux 1,1,0,0,1,1,0,0,1,1, identiques à la 3.7.0. Export GPU contre readback : écart 0 sur la mire et sur la vidéo.

Correction faite pendant la vérification : en NV12, VideoToolbox réétiquetait en BT.709 une vidéo SD codée en BT.601 sans convertir ses échantillons (le bleu d'un jaune décalé de 11 niveaux). Seules les pistes HDR ou BT.2020 reçoivent désormais les propriétés de conversion. Voir [FRAME_PIXEL_FORMAT.md](FRAME_PIXEL_FORMAT.md#pièges-trouvés).

## Suite `full` (65 cas, 1 répétition par format)

| | Réussis | Échecs | Arrêtés par le budget | Non exécutés |
| --- | --- | --- | --- | --- |
| Pixel `rgba` (26 min, nominal) | 57 | 4 | — | 4 |
| Pixel `yuv` (24 min, nominal) | **58** | 3 | — | 4 |
| iPhone `rgba` (17 min, *fair* puis *serious*) | 58 | — | 3 | 4 |
| iPhone `yuv` (20 min, *nominal* à *serious*) | **61** | — | — | 4 |

Les 4 cas non exécutés sont les extensions LUT, compute, Three.js et Core ML, non branchées dans l'app.

**Pixel.** Les trois échecs communs aux deux formats existaient déjà dans la beta.2 : le build de `main` (`1eeaa3b`) échoue aux mêmes cas, 2 répétitions sur 2, avec les mêmes symptômes.

| Cas | Symptôme, `main` comme beta.3 |
| --- | --- |
| `seek-while-playing` | Après un seek en lecture dans une séquence 4K, l'horloge reste vers 4,0 s pendant 4 s |
| `long-montage-120-clips` | Après un seek en pause dans un montage paresseux de 120 clips, la frame du clip 83 n'arrive pas |
| `missing-file` | Android 17 répond « Failed to instantiate extractor », que le harness ne reconnaît pas comme une erreur de fichier manquant |

Le quatrième échec en `rgba`, `4k-x8-eager`, dépasse le budget mémoire ; il passe en `yuv`.

| Pixel, `rgba` → `yuv` | Export | Mémoire max (PSS) |
| --- | --- | --- |
| 8 clips 4K, paresseux | 29,0 → **12,9 s** | 1 020 → **766 Mio** |
| Montage en fondu, eager | 27,3 → **14,4 s** | 1 468 → **1 029 Mio** |
| 3 clips 4K simultanés | 23,2 → **7,3 s** | 1 314 → 1 507 Mio |
| Exports simples (`encode-*`) | 2,4–2,6 → **1,7–1,9 s** | ≈ égal |
| Lecture continue 4K | — | 554–602 → **438–458 Mio** |

**iPhone.** En `rgba`, trois cas s'arrêtent sur le budget de la file du décodeur : `montage-all-crossfade-eager`, `4k-x8-eager` et `4k-x3-simultaneous` (problème connu des versions précédentes). **En `yuv`, les trois passent**, et aucun cas n'échoue.

| iPhone, `rgba` → `yuv` | Mémoire physique max | Export |
| --- | --- | --- |
| Lecture continue 4K | 400–405 → **336–343 Mio** | — |
| 8 clips 4K, paresseux | 670–683 → **571–573 Mio** | 4,4–4,5 → 4,5–4,9 s |
| 3 clips 4K simultanés | budget dépassé → **734 Mio, passe** | — |
| Montage en fondu, paresseux | 650 → **585 Mio** | 4,3 → 3,6 s |
| 20 clips courts | ≈ | 3,3 → **2,5 s** |
| Montage de 120 clips | ≈ | **14,0** → 18,1 s |

## Tests natifs

- **iPhone, XCTest** : **56/58**, les deux autres étant des diagnostics qui ne tournent qu'à la demande. Six nouveaux tests : chaque frame d'un clip et d'un montage lues en NV12, le format annoncé par chaque frame, et la lecture de `framePixelFormat` (`auto` et `yuv` en NV12, `rgba` en BGRA, valeur inconnue refusée). Les deux diagnostics ont été lancés à part (débit du décodeur par format, étiquettes de couleur des clips sans étiquette).
- **Pixel, tests instrumentés** : **126/127** dans la suite complète. L'échec, `BigMontageTest.aLazyPreviewOfEight4KClipsPlaysThrough`, figure dans la référence connue (il échouait déjà sur `main` dans la suite complète). Lancée seule juste après, sur un Pixel aux cœurs à 85 °C après des heures de 4K, la classe échoue 2 fois sur 5 : le seuil de 150 frames à l'heure en 4K, et un `OutOfMemoryError` du tas Java après l'export eager de 8 clips 4K. Ces tests pilotent le décodeur Java sans `Looper`, chemin que cette version ne modifie pas. Ils n'ont pas été relancés à froid avant la release : l'attribution à la chaleur n'est pas confirmée.

## Runs écartés

- `iphone-full-rgba-interrupted-call` : appel téléphonique pendant le run.
- `iphone-full-yuv-interrupted-phone-in-use` : téléphone utilisé pendant le run.
- Les runs `sync` iPhone antérieurs à la correction des couleurs SD et à l'étiquetage forcé des clips photo ne servent pas pour le rendu.

Les résultats sont dans `benchmark/results/*.local.json`, fichiers locaux non versionnés.

## Toujours non qualifié

- Mémoire sur de longues sessions (dernière mesure en 3.0.6).
- HDR au-delà de la conversion HLG → SDR, son audible et synchronisation audio/vidéo.
- Les trois bugs Android de la suite `full` ci-dessus, et le seek dans une composition 4K paresseuse sur Pixel.
- Vraie vidéo 4K 60 fps à 60 Mbit/s sur iPhone chaud : 65 à 91 % des frames affichées selon les runs.
- Export iOS en `yuv` : environ 2 à 4 ms de plus par frame qu'en `rgba` (à optimiser).
- Aucune mesure iPhone à l'état thermique *nominal* pour la comparaison des formats : le téléphone est resté chaud toute la journée.
