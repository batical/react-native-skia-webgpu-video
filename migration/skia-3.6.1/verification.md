# Vérification de la migration Skia 3.6.1 / WebGPU 0.16.0 — 16 octobre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette migration :
- sur l'hôte ;
- sur **iPhone 15 Pro** (iOS 27.0.1) ;
- sur **Pixel 8a** (Android 17).

Tous les builds sont en Release. Les changements amont et les décisions sont dans l'[audit](upstream-audit.md).

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.6.1, WebGPU 0.16.0 ; un seul `react-native-webgpu-dawn@154.3.0` dédupliqué |
| `apply-skia-canvas-patch.mjs` | Patch appliqué ; les sept fichiers ont la même empreinte qu'en 3.4.4 |
| `test-skia-patch-syntax.mjs`, `test-skia-provider-ownership.mjs` | Passés |
| Jest | **217/217 tests, 10 suites** (212 avant cette passe) |
| `tsc --noEmit`, `test:package`, `benchmark:test` | OK, 5/5, 112/112 |
| `npm run build`, `check-package` (publint strict) | OK |

Les tests JS modélisent l'ordre des appels et la durée de vie des ressources. Ils ne prouvent pas les pixels calculés par le GPU.

## Natif

- **iOS :**
  - `pod install` (Ruby 3.2.0) installe Graphite 154.3.0 et affiche `Dawn versions match (react-native-webgpu-dawn 154.3.0)`.
  - **50/50 XCTests natifs** passent sur simulateur (iPhone 17e, iOS 26.4) sur l'arbre migré, avant la passe Android. Aucun autre run simulateur n'a été fait.
- **Android :** le build Release arm64 de l'exemple réussit, et Gradle résout le Dawn partagé pour les deux paquets. Les tests instrumentés de la bibliothèque n'ont pas été relancés : ses sources natives n'ont pas changé dans cette passe.

## Pixel 8a

Protocole :
- **Builds :** APK Release signés par la clé de debug, construits sur ce poste.
- **Référence :** APK construit depuis `main` (f5e39a8), le code du chemin `ImageReader` mesuré le 15 octobre.
- **Runner :** `test-android-device-run.mjs`, catalogue `2026-10-07.1` profil `full`, trois répétitions par cas.
- **Conditions :** état thermique *nominal*, sur secteur.
- **Preuves :** le JSON compact est [`benchmark/android-device-361-ab.json`](../../benchmark/android-device-361-ab.json).

### Pixels

Le profil `interop` compare le décodage GPU au décodage CPU (EGL) sur 13 patchs 8×8 de deux images, avec une tolérance de 3 :
- 5 fichiers : 638×358, 1080p tourné à 90°, portrait 1080×1920, 4K H.264 et 4K HEVC ;
- 2 modes chacun, soit 10 cas.

Le contrôle d'export compare ensuite l'export GPU au readback CPU sur la mire à quatre quadrants. Cette passe y ajoute un **cas vidéo** : `h264-1080p-rot90`, décodé puis dessiné plein cadre en 1080×1920. Côté GPU, il traverse le décodage `ImageReader` et l'import en place ; il est comparé au readback CPU sur les mêmes 13 patchs, avec une tolérance de 8.

| Build | Décodage, 10 cas | Écart max | Export : mire / vidéo |
| --- | --- | --- | --- |
| 3.6.1, migration seule | **0/10** | 14 à 55 | Mire OK ; cas vidéo absent de ce build |
| 3.6.1 + blit YUV (`yuvBlit.ts`) | 10/10 | 0 à 1 | Mire OK |
| 3.6.1 + import en place à l'export | 10/10 | 0 à 1 | Mire OK, vidéo écart **0** |
| 3.6.1 final | 10/10 | 0 à 1 | Mire OK, vidéo OK |

Les tailles de fichier vont dans le même sens :
- **Migration seule :** HEVC 1080p 1 068 000 octets, contre 1 161 982 en 3.4.4.
- **Avec le blit :** 1 162 102 octets, soit le niveau de 3.4.4 à 0,01 % près.
- **H.264 :** 153 312 octets avec la migration seule, 163 241 avec le blit, contre 163 216 en 3.4.4.

### Export (médianes de trois, ms)

| Cas | 3.4.4 | 3.6.1 seule | + blit YUV | + import en place |
| --- | --- | --- | --- | --- |
| `native-hevc-1080p-rot270` (180 images) | 3 795 | 3 797 | 3 820 | **2 996** |
| `encode-h264-copy` (60 images) | 1 253 | 1 323 | 1 327 | **1 165** |
| `4k-x8-lazy-maxLongSide1280` (360 images, décodage EGL) | 12 026 | 12 270 | 12 314 | 12 537 |
| `4k-x8-lazy` (360 images, 4K à taille native) | 13 530 | — | — | **9 989** (build final) |
| `4k-x3-simultaneous` (150 images) | 8 847 (2 runs sur 3) | — | — | **5 763** (build final, 3/3) |

Profil HEVC 1080p, en ms par image :

| Étape | 3.4.4 | 3.6.1 en place |
| --- | --- | --- |
| Import | 6,57 | 3,40 |
| Attente GPU | 2,46 | 1,77 |
| Buffer encodeur (`target`) | 1,58 | 1,26 |
| Encodage | 4,25 | 4,28 |
| Décodage | 2,74 | 2,79 |
| Total | 19,2 | 15,0 |

Lecture :
- **La montée de version seule ne fait rien gagner** : H.264 est même 5 % plus lent, avec des plages qui se recouvrent presque.
- **L'import unique par buffer n'accélère pas non plus.** Le coût de l'import venait de la copie du snapshot et de l'attente CPU par clip, pas de l'import AHB.
- **L'import en place gagne 21 % en HEVC 1080p et 7 % en H.264.** Les trois répétitions de chaque cas sont sous les trois de 3.4.4.
- **Le cas réduit à 1280 décode par EGL** et ne passe pas par ce chemin. Il est inchangé, à la dispersion près.

**4K à taille native.** Le premier run en place de `4k-x8-lazy` exporte en 10,0 s, contre 13,5 s en 3.4.4.
- **Échec du nettoyage.** Le run échoue au contrôle strict qui suit l'export : il reste une réservation de 12 441 600 octets, le bail d'une frame `ImageReader` 4K.
- **Cause.** Android re-loue une image tenue à chaque décodage, alors qu'iOS renvoie le même objet. Le chemin en place ne fermait pas ce second bail.
- **Correction.** `ownExportFrames` ferme désormais ce bail en double, sur Android seulement. Un test Jest couvre ce cas.
- **Relance.** Le build final passe **6/6**, nettoyage strict compris :
  - `4k-x8-lazy` : 9 796 à 10 215 ms, contre 13 486 à 13 681 ms en 3.4.4 (−26 %) ;
  - `4k-x3-simultaneous` : 5 614 à 5 837 ms, contre 8 657 à 9 037 ms (−35 %). La troisième répétition 3.4.4 avait échoué pendant la lecture (« Preview operation timed out »), avant l'export.
  - Ce run a commencé en état thermique *fair* : le téléphone avait chauffé pendant les séries précédentes. Le gain est donc plutôt sous-estimé.
  - Profil 3×4K : l'import passe de 36,6 à 10,0 ms par image. Une partie de la conversion se retrouve dans l'attente GPU (de 2,7 à 8,9 ms) : elle ne bloque plus le CPU clip par clip.

## Appareil iOS : iPhone 15 Pro

Protocole :
- **Conditions :** iPhone 15 Pro (iPhone16,1), iOS 27.0.1, Release, au premier plan, état thermique *nominal* pour chaque run.
- **Runner :** `test-ios-device-ab-run.mjs`, trois répétitions par cas.
- **Ordre :** 3.4.4, 3.6.1, 3.6.1 final, puis 3.4.4 à nouveau.
- **Preuves :** le JSON compact est [`benchmark/ios-device-361-ab.json`](../../benchmark/ios-device-361-ab.json).

| Cas (médiane, ms) | 3.4.4 (1) | 3.6.1 | 3.6.1 final | 3.4.4 (2) |
| --- | --- | --- | --- | --- |
| `native-hevc-1080p-rot270` | 734 | 728 | 790 | 731 |
| `encode-h264-copy` | 174 | 169 | 168 | 223 |
| `4k-x8-lazy-maxLongSide1280` | 2 718 | 2 734 | 2 682 | 2 795 |

Lecture :
- **iOS est neutre.** Le chemin d'export iOS ne change pas dans cette migration.
- **Les écarts entre séries vont dans les deux sens**, jusqu'à 8 % en HEVC et 28 % en H.264, et la référence 3.4.4 varie elle-même autant.
- **Le profil par image est le même dans les quatre séries** : HEVC 1080p 3,74 à 3,78 ms, H.264 1,97 à 2,08 ms. Les écarts de temps total viennent donc de la mise en place et de la finalisation de l'encodeur, hors boucle d'image.
- **Octets produits :** identiques entre versions (HEVC 379 829, 8×4K 700 699). Le H.264 alterne entre 51 534 et 52 081 octets dans les deux versions.
- **Build mesuré :** « 3.6.1 final » précède le changement Android du bail en double, sans effet sur iOS.
