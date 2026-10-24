# YUV ou RGBA : le format des frames décodées

Mesures du 21 octobre 2026 sur **iPhone 15 Pro** (iOS 27.0.1) et **Pixel 8a** (Android 17), builds Release, Skia 3.7.1 / WebGPU 0.17.0. Ce document explique l'option `framePixelFormat`, ce que chaque format coûte et rend, et les pièges trouvés en la mesurant. Le détail des runs est dans le [rapport de vérification beta.3](VERIFICATION_0.1.0-beta.3.md).

## En bref

- **`auto` vaut `yuv` sur les deux plateformes** ; `rgba` reste disponible.
- **Android** décode en YUV depuis le début (`ImageReader`), et c'est nettement le meilleur choix. Forcer `rgba` (la passe OpenGL) divise par deux à trois la vitesse des exports 4K, et fait perdre près des deux tiers des frames d'une preview 4K 60 fps.
- **iOS** décodait jusqu'ici en BGRA (VideoToolbox convertit chaque frame). En NV12, une frame 4K pèse **12,4 Mo au lieu de 33,2 Mo**. Le décodeur garde cinq frames d'avance au lieu d'une ou deux, la preview 4K perd moins de frames, et les cas qui dépassaient le budget mémoire passent. Seul coût mesuré : **environ 2 à 4 ms de plus par frame à l'export**, visible sur les exports longs ou à petite sortie.
- **Le rendu est le même** pour la vidéo de caméra (Rec.709 ou HLG). Un fichier étiqueté Display P3 ou avec la fonction de transfert sRGB est converti en Rec.709 par `rgba`, pas par `yuv`.

## L'option

```ts
const composition = { duration, items, framePixelFormat: 'yuv' }; // 'auto' | 'yuv' | 'rgba'
```

| | iOS | Android |
| --- | --- | --- |
| `yuv` | AVAssetReader sort le NV12 du décodeur. La preview l'importe comme texture externe à chaque frame et le convertit en RGB dans une passe de rendu ; l'export le convertit dans une texture par clip | `ImageReader` (pistes 8 bits SDR, à toute taille de frame, plafonnée ou explicite comprise ; les autres restent en `rgba`), converti en RGB et mis à la taille de la frame par la même passe |
| `rgba` | VideoToolbox convertit en BGRA ; l'export GPU échantillonne l'IOSurface en place, sans copie | Passe OpenGL vers un `AHardwareBuffer` RGBA |
| `auto` (défaut) | `yuv` | `yuv` |

L'option ne concerne que les compositions (preview et export) : le lecteur d'un clip seul, `useVideoPlayer`, reste en BGRA sur iOS.

La conversion YUV → RGB applique la matrice YCbCr et la plage de chaque buffer, sans convertir la fonction de transfert ni les primaires : c'est ce qui évite d'éclaircir les tons moyens à chaque export (voir `yuvBlit.ts`). Le HDR est d'abord ramené en SDR Rec.709 par la plateforme, dans les deux formats.

## Mesures

### Décodeur seul (iOS)

XCTest `DecodeThroughputTests` : AVAssetReader lit les 360 frames d'un clip HEVC 4K 60 fps, sans React Native ni GPU, en alternant les formats sur trois tours. Téléphone en état thermique *serious*.

| Format | Débit | CPU par frame | Taille d'une frame |
| --- | --- | --- | --- |
| BGRA + propriétés Rec.709 | 105–127 fps | 0,42–0,47 ms | 33,2 Mo |
| NV12 + propriétés Rec.709 | 93–139 fps | 0,45–0,55 ms | 12,4 Mo |
| NV12 brut | 120–137 fps | 0,47–0,62 ms | 12,4 Mo |

La conversion BGRA est faite par le matériel et ne coûte presque rien en débit. La différence est la **mémoire**, et ce qu'elle permet : la file du décodeur de la preview est plafonnée à 64 Mo, soit une ou deux frames d'avance en BGRA 4K, cinq en NV12.

### Preview

Profil `sync` : chaque frame porte son numéro, lu à chaque vsync. « Exact » : part des vsyncs qui montrent la frame due ; « frames » : frames distinctes affichées.

**Pixel 8a**, 60 Hz, état thermique *nominal* :

| Cas | `yuv` | `rgba` |
| --- | --- | --- |
| HEVC 4K 60 fps | **96,9 % exact**, 344/360 frames | 18,4 %, 132/360 |
| HEVC 4K 30 fps | **100 %**, 179/180 | 38,1 %, 123/180 |
| H.264 4K 30 fps | **98,8 %**, 177/180 | 38,4 %, 128/180 |
| Vraie vidéo 4K 60 fps (fleurs, 60 Mbit/s) | **335/360** | 145/360 |
| HEVC 1080p 60 fps | 99,4 % | 92,7 % |
| 30 fps, 24 fps, coupe | 99,7–100 % | 99,7–100 % |

**iPhone 15 Pro**, 120 Hz, quatre runs alternés `rgba` / `yuv` / `rgba` / `yuv`, tous en état *serious* (le téléphone n'a pas refroidi entre les runs ; l'alternance répartit cette chaleur sur les deux formats). Deux valeurs par format :

| Cas | `yuv` | `rgba` |
| --- | --- | --- |
| HEVC 4K 60 fps (frames, sans lecture du numéro) | **311, 294** /360 | 241, 261 |
| HEVC 4K 60 fps (exact, une frame sur quatre lue) | **77 %, 90 %** | 46 %, 48 % |
| Vraie vidéo 4K 60 fps (frames) | **270, 327** /360 | 234, 284 |
| HEVC 4K 30 fps du benchmark (frames) | **235, 239** /240 | 223, 224 |
| Vraie vidéo 4K 30 fps (frames) | 173, 178 /180 | 173, 169 |
| 30, 60 fps et HEVC 1080p 60 fps (exact) | 73–95 % | 71–91 % |

En 1080p et en 30 fps, les écarts entre formats restent dans la dispersion d'un run à l'autre, très forte sur un téléphone chaud.

### Export

Chaque frame exportée a été relue : la bonne frame source dans tous les cas, dans les deux formats, sur les deux téléphones.

| Cas | Pixel `yuv` | Pixel `rgba` | iPhone `yuv` | iPhone `rgba` |
| --- | --- | --- | --- | --- |
| 4K 60 → 4K 60 | **5,0 s** | 15,6 s | 4,2–4,3 s | 4,1–4,5 s |
| 4K 30 → 4K 30 | **3,2 s** | 8,7 s | 2,3 s | 2,4–2,7 s |
| 4K 60 → 1080p 30 | **2,4–2,9 s** | 8,0–8,2 s | 1,4–2,2 s | 1,7 s |
| HEVC 1080p 60 → 640×360 | 4,1 s | 8,9 s | 0,9–1,4 s | **0,5 s** |
| Montage de 120 clips (suite `full`) | **63,5 s** | 95,9 s | 18,1 s | **14,0 s** |

Sur iOS, l'export en `yuv` importe chaque frame NV12 et la convertit dans une texture, là où le BGRA est lu en place. Ce surcoût d'environ 2 à 4 ms par frame est invisible en 4K, où le décodage domine, mais pèse sur les sorties petites ou les exports longs. Pour un export iOS où la vitesse prime sur la mémoire, `framePixelFormat: 'rgba'` reste le plus rapide.

### Mémoire

Pics de la suite `full` (une répétition par format). Pixel : PSS ; iPhone : empreinte physique.

| Cas | Pixel `yuv` | Pixel `rgba` | iPhone `yuv` | iPhone `rgba` |
| --- | --- | --- | --- | --- |
| Lecture continue 4K | **438–458 Mio** | 554–602 | **336–343 Mio** | 400–405 |
| Clip seul 4K | 698–707 | 795–830 | **601–639** | 657–677 |
| 8 clips 4K, paresseux | **766–785** | 1 020–1 037 | **571–573** | 670–683 |
| 3 clips 4K simultanés | 1 507 | 1 314 | **734, passe** | arrêté par le budget |
| 8 clips 4K, eager | 1 562, passe | arrêté par le budget | 1 089, passe | arrêté par le budget |

Les cas « eager » qui s'arrêtaient sur le budget en `rgba` vont jusqu'au bout en `yuv`, d'où une mémoire plus haute sur ceux-là.

## Rendu

Trois contrôles, la même frame décodée dans chaque format :

- **Mire SMPTE** (H.264 et HEVC 1080p, étiquetées Rec.709) comparée à ffmpeg : écart maximal de **0 niveau en `yuv`, 1 en `rgba`**, sur les deux téléphones.
- **Vraie vidéo** : trois clips tirés de photos d'appareil (panoramique, grain, débits de téléphone, étiquetés Rec.709) comparés à ffmpeg sur 24 points à trois instants. Écart moyen de **0,07 à 0,16 en `yuv`** sur les deux téléphones (max 1). En `rgba` : 0,15 à 0,48 sur le Pixel, 0,5 à 0,8 sur l'iPhone (max 5).
- **Fixtures du benchmark** (rotations, HDR HLG 10 bits, portrait, 638×358, slow motion) : `yuv` contre `rgba`, écart moyen de 0 à 0,8 niveau. Les maxima de 5 à 17 niveaux sont ponctuels, sur des bords nets entre aplats saturés, où VideoToolbox (ou la passe OpenGL) et la passe GPU n'interpolent pas la chrominance de la même façon.

## Pièges trouvés

**VideoToolbox réétiquette sans convertir.** Avec une sortie NV12, demander les propriétés Rec.709 fait étiqueter le buffer en BT.709 sans convertir les échantillons. Pour une vidéo SD sans étiquette, codée en BT.601, le GPU appliquait alors la mauvaise matrice : le bleu d'un jaune décalé de 11 niveaux, 4,7 en moyenne sur un clip 320×240. Le XCTest `ColorMatrixDiagnosticsTests` le montre : le BGRA de VideoToolbox correspond au NV12 converti en BT.601 (écart 0,4), pas en BT.709 (6,3). Correction : en NV12, seules les pistes HDR ou BT.2020 reçoivent ces propriétés (pour le tone mapping) ; les autres gardent l'étiquette réelle du décodeur, que le GPU applique. Écart après correction : max 1 (638×358) et 3 (320×240), moyenne 0,15 à 0,32.

**Les étiquettes Display P3 et sRGB.** `rgba` convertit vers Rec.709 ce que le fichier déclare (primaires P3, fonction de transfert sRGB) : VideoToolbox sur iOS, la passe OpenGL sur Android. `yuv` n'applique que la matrice et la plage. Sur un clip étiqueté P3 (fixture `tagged-p3-flowers`), `yuv` reste à 0,2 niveau de ffmpeg (qui ignore aussi les primaires), `rgba` s'en écarte de 5,8 en moyenne sur l'iPhone (max 26) et de 1,3 sur le Pixel (max 16). La vidéo de caméra n'est pas concernée ; certains enregistrements d'écran ou exports d'éditeurs le sont.

**Les fixtures héritaient des étiquettes des photos.** ffmpeg recopiait dans les clips de test les primaires P3, la fonction de transfert sRGB ou le profil ICC des photos sources, malgré `-color_primaries bt709`. Le script force désormais les étiquettes avec `setparams` et retire le profil ICC, puis les vérifie avec `ffprobe`.

**La file de décodage iOS tournait en priorité *utility*.** Sur un iPhone chaud, iOS la reléguait sur les cœurs basse consommation : des gels de 300 à 500 ms. Elle tourne désormais en *user-interactive* ; le même run passe de 56 à 244 frames sur 360 en 4K 60 fps.

## Recommandation

Garder `auto` (`yuv`). Choisir `rgba` sur iOS seulement pour :
- un export où la vitesse compte plus que la mémoire ;
- des fichiers étiquetés Display P3 ou sRGB dont on veut la conversion colorimétrique.

Pistes pour la suite :
- réduire le coût de l'import NV12 à l'export sur iOS, par exemple en réutilisant les imports d'un même IOSurface ;
- mesurer à froid, sur plusieurs répétitions, les écarts 1080p de l'iPhone qui restent dans le bruit.
