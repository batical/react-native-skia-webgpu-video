# YUV ou RGBA : le format des frames décodées

Mesures du 21 octobre 2026 sur **iPhone 15 Pro** (iOS 27.0.1) et **Pixel 8a** (Android 17), builds Release, Skia 3.7.1 / WebGPU 0.17.0. Ce document explique l'option `framePixelFormat`, ce que chaque format coûte et rend, et les pièges trouvés en la mesurant. Le détail des runs est dans le [rapport de vérification beta.3](VERIFICATION_0.1.0-beta.3.md).

## En bref

- **Android** décode en YUV depuis le début (`ImageReader`), et c'est nettement le meilleur choix. Forcer `rgba` (la passe OpenGL) divise par trois la vitesse des exports 4K et fait perdre près des deux tiers des frames d'une preview 4K 60 fps.
- **iOS** décodait jusqu'ici en BGRA (VideoToolbox convertit chaque frame). En NV12, une frame 4K pèse **12,4 Mo au lieu de 33,2 Mo**, et le décodeur garde cinq frames d'avance au lieu d'une ou deux dans le même budget. **`auto` passe donc en `yuv` sur iOS aussi** ; `rgba` reste disponible. ⏳ *Performance à froid : à compléter.*
- **Le rendu est le même** pour la vidéo de caméra (Rec.709 ou HLG) : écart moyen de 0 à 0,8 niveau sur 8 bits entre les deux formats. Un fichier étiqueté Display P3 ou avec la fonction de transfert sRGB est converti en Rec.709 par `rgba` sur iOS, pas par `yuv` (ni par Android, dans aucun format).

## L'option

```ts
const composition = { duration, items, framePixelFormat: 'yuv' }; // 'auto' | 'yuv' | 'rgba'
```

| | iOS | Android |
| --- | --- | --- |
| `yuv` | AVAssetReader sort le NV12 du décodeur. La preview l'importe comme texture externe à chaque frame et le convertit en RGB dans une passe de rendu ; l'export le convertit dans une texture par clip | `ImageReader` (pistes 8 bits SDR à leur taille encodée ; les autres restent en `rgba`), converti en RGB par la même passe |
| `rgba` | VideoToolbox convertit en BGRA ; l'export GPU échantillonne l'IOSurface en place, sans copie | Passe OpenGL vers un `AHardwareBuffer` RGBA |
| `auto` (défaut) | `yuv` | `yuv` |

L'option ne concerne que les compositions (preview et export) : le lecteur d'un clip seul, `useVideoPlayer`, reste en BGRA sur iOS.

La conversion YUV → RGB applique la matrice YCbCr et la plage de chaque buffer, sans convertir la fonction de transfert ni les primaires : c'est ce qui évite d'éclaircir les tons moyens à chaque export (voir `yuvBlit.ts`). Le HDR est d'abord ramené en SDR Rec.709 par la plateforme, dans les deux formats.

## Mesures

### Décodeur seul (iOS)

XCTest `DecodeThroughputTests` : AVAssetReader lit les 360 frames d'un clip HEVC 4K 60 fps, sans React Native ni GPU, en alternant les formats sur trois tours. Téléphone en état thermique *serious* (sur chargeur sans fil).

| Format | Débit | CPU par frame | Taille d'une frame |
| --- | --- | --- | --- |
| BGRA + propriétés Rec.709 | 105–127 fps | 0,42–0,47 ms | 33,2 Mo |
| NV12 + propriétés Rec.709 | 93–139 fps | 0,45–0,55 ms | 12,4 Mo |
| NV12 brut | 120–137 fps | 0,47–0,62 ms | 12,4 Mo |

La conversion BGRA est faite par le matériel : elle ne coûte presque rien en débit. La différence est la **mémoire**, et ce qu'elle permet : la file du décodeur de la preview est plafonnée à 64 Mo, soit une ou deux frames d'avance en BGRA 4K, cinq en NV12.

### Preview, Pixel 8a (60 Hz, état thermique nominal)

Profil `sync` : chaque frame porte son numéro, lu à chaque vsync. « Exact » est la part des vsyncs qui montrent la frame due.

| Cas | `yuv` | `rgba` |
| --- | --- | --- |
| HEVC 4K 60 fps | **96,9 % exact**, 344/360 frames | 18,4 %, 132/360 |
| HEVC 4K 30 fps | **100 %**, 179/180 | 38,1 %, 123/180 |
| H.264 4K 30 fps | **98,8 %**, 177/180 | 38,4 %, 128/180 |
| Vraie vidéo 4K 60 fps (fleurs, 60 Mbit/s) | **335/360** | 145/360 |
| HEVC 1080p 60 fps | 99,4 % | 92,7 % |
| 30 fps, 24 fps, coupe | 99,7–100 % | 99,7–100 % |

### Export, Pixel 8a

| Cas | `yuv` | `rgba` |
| --- | --- | --- |
| 4K 60 → 4K 60 | **5,0 s** | 15,6 s |
| 4K 30 → 4K 30 | **3,2 s** | 8,7 s |
| 4K 60 → 1080p 30 | **2,4–2,9 s** | 8,0–8,2 s |
| 640×360 30 → 30 | 2,5 s | 4,1 s |

Chaque frame exportée a été relue : la bonne frame source dans tous les cas, dans les deux formats.

### Preview et export, iPhone 15 Pro

⏳ *Mesures à froid en cours, en alternant les formats.*

### Mémoire

⏳ *Pics de mémoire de la suite `full` dans chaque format, à compléter.*

## Rendu

Trois contrôles, la même frame décodée dans chaque format :

- **Mire SMPTE** (H.264 et HEVC 1080p, étiquetées Rec.709) comparée à ffmpeg : écart maximal de **0 niveau en `yuv`, 1 en `rgba`**, sur les deux téléphones.
- **Vraie vidéo** : trois clips tirés de photos d'appareil (panoramique, grain, débits de téléphone, étiquetés Rec.709) comparés à ffmpeg sur une grille de 6×4 points à trois instants. ⏳ *Résultats finaux à compléter.*
- **Fixtures du benchmark** (rotations, HDR HLG 10 bits, portrait, 638×358, slow motion) : `yuv` contre `rgba`. Écart moyen de 0 à 0,8 niveau. Les maxima de 5 à 17 niveaux sont ponctuels, sur des bords nets entre aplats saturés, où VideoToolbox (ou la passe OpenGL) et la passe GPU n'interpolent pas la chrominance de la même façon.

## Pièges trouvés

**VideoToolbox réétiquette sans convertir.** Avec une sortie NV12, demander les propriétés Rec.709 fait étiqueter le buffer en BT.709 sans convertir les échantillons. Pour une vidéo SD sans étiquette, codée en BT.601, le GPU appliquait alors la mauvaise matrice : le bleu d'un jaune décalé de 11 niveaux, 4,7 en moyenne sur un clip 320×240. Le XCTest `ColorMatrixDiagnosticsTests` le montre : le BGRA de VideoToolbox correspond au NV12 converti en BT.601 (écart 0,4), pas en BT.709 (6,3). Correction : en NV12, seules les pistes HDR ou BT.2020 reçoivent ces propriétés (pour le tone mapping) ; les autres gardent l'étiquette réelle du décodeur, que le GPU applique.

**Les étiquettes Display P3 et sRGB.** Le format `rgba` d'iOS convertit vers Rec.709 ce que le fichier déclare : primaires P3, fonction de transfert sRGB. Le format `yuv` n'applique que la matrice et la plage, comme Android dans les deux formats. Sur une vidéo étiquetée P3, les deux formats diffèrent donc sur iOS (jusqu'à 34 niveaux sur un magenta saturé). La vidéo de caméra n'est pas concernée ; certains enregistrements d'écran ou exports d'éditeurs le sont. ⏳ *Mesure sur la fixture `tagged-p3-flowers` à compléter.*

**La file de décodage iOS tournait en priorité *utility*.** Sur un iPhone chaud, iOS la reléguait sur les cœurs basse consommation : des gels de 300 à 500 ms. Elle tourne désormais en *user-interactive* ; le même run passe de 56 à 244 frames sur 360 en 4K 60 fps.

## Recommandation

⏳ *À compléter avec les mesures iOS à froid : choix de `auto` sur iOS.*
