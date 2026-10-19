# Vérification de la migration Skia 3.7.0 / WebGPU 0.17.0 — 19 octobre 2026

Ce document liste ce qui a **réellement** été exécuté pour cette migration :
- sur l'hôte ;
- sur **iPhone 15 Pro** (iOS 27.0.1) ;
- sur **Pixel 8a** (Android 17).

Tous les builds sont en Release. Les changements amont et les décisions sont dans l'[audit](upstream-audit.md).

## Hôte

| Contrôle | Résultat |
| --- | --- |
| `npm install` (lockfile npm) | Skia 3.7.0, WebGPU 0.17.0 ; un seul `react-native-webgpu-dawn@157.0.0` dédupliqué |
| `apply-skia-canvas-patch.mjs` | Patch appliqué, puis « already applied » au second passage ; 61 éditions |
| `test-skia-patch-syntax.mjs`, `test-skia-provider-ownership.mjs` | Passés : le patch compile contre les en-têtes Graphite et Dawn m157 |
| Jest | **217/217 tests, 10 suites** |
| `tsc --noEmit`, `test:package`, `benchmark:test` | OK, 5/5, 112/112 |
| `npm run build`, `check-package` (publint strict) | OK |

Les tests JS modélisent l'ordre des appels et la durée de vie des ressources. Ils ne prouvent pas les pixels calculés par le GPU. ESLint n'est pas une dépendance du dépôt et n'a pas été lancé.

## Natif

- **iOS :** `pod install` (Ruby 3.2.0) installe Skia 3.7.0 et WebGPU 0.17.0 ; `Podfile.lock` ne change que sur ces deux versions. Le build Release signé pour l'iPhone réussit. Aucun run simulateur pour cette version.
- **Android :** le build Release arm64 réussit, et Gradle affiche `Dawn versions match (react-native-webgpu-dawn 157.0.0)` pour les deux paquets. Les tests instrumentés de la bibliothèque n'ont pas été relancés : ses sources natives n'ont pas changé.

**Piège rencontré : bundle JS Android périmé.** Le premier APK 3.7.0 avait les binaires natifs 3.7.0, mais **le bundle JS de 3.6.1**, identique octet pour octet à celui de l'APK précédent. La tâche Gradle `createBundleReleaseJsAndAssets` ne suit pas le `node_modules` racine et s'est jugée à jour. Le harness l'a révélé en déclarant Skia 3.6.1. Les deux runs faits avec cet APK sont écartés et renommés `-stalejs`. L'APK mesuré ci-dessous a été reconstruit après suppression du bundle généré ; son bundle contient bien 3.7.0. Xcode refait toujours son bundle : l'app iOS déclare bien 3.7.0.

## Pixel 8a

Protocole :
- **Builds :** APK Release signés par la clé de debug, construits sur ce poste.
- **Référence :** `candidate-361-final.apk`, l'APK final de la campagne 3.6.1 (code de `main` 9d1ac51).
- **Runner :** `test-android-device-run.mjs`, catalogue `2026-10-07.1` profil `full`, trois répétitions par cas.
- **Conditions :** sur secteur, état thermique *nominal* au départ de chaque run, attendu avant chaque lancement.
- **Preuves :** le JSON compact est [`benchmark/android-device-370-ab.json`](../../benchmark/android-device-370-ab.json).

### Pixels

Le profil `interop` compare le décodage GPU au décodage CPU (EGL) sur 13 patchs 8×8 de deux images, avec une tolérance de 3 :
- 5 fichiers : 638×358, 1080p tourné à 90°, portrait 1080×1920, 4K H.264 et 4K HEVC ;
- 2 modes chacun, soit 10 cas.

Il compare ensuite l'export GPU au readback CPU, sur une mire à quatre quadrants et sur un clip décodé tourné.

| Build | Décodage, 10 cas | Écart max par cas | Export : mire / vidéo |
| --- | --- | --- | --- |
| 3.6.1 final (16 oct.) | 10/10 | 1,1,0,0,1,1,0,0,0,0 | écart 0 / 0 |
| **3.7.0** | **10/10** | 1,1,0,0,1,1,0,0,1,1 | **écart 0 / 0** |

Dawn 157 ne change donc pas les couleurs des frames décodées : les écarts restent à 0 ou 1 niveau. Les deux derniers cas (4K HEVC) passent de 0 à 1.

### Export (médianes de trois, ms)

La référence 3.6.1 a été mesurée le matin même pour les trois premiers cas. Les deux cas 4K natifs n'ont pas été refaits en 3.6.1, pour gagner du temps : ils sont comparés au run du 16 octobre, qui avait démarré en état *fair*.

| Cas | 3.6.1 | 3.7.0 | Octets 3.6.1 → 3.7.0 |
| --- | --- | --- | --- |
| `native-hevc-1080p-rot270` (180 images) | 3 023 | 2 918 | 1 162 102 → **1 096 125** (−5,7 %) |
| `encode-h264-copy` (60 images) | 1 175 | 1 233 | 163 241 → 161 131 (−1,3 %) |
| `4k-x8-lazy-maxLongSide1280` (360 images, décodage EGL) | 12 186 | 12 517 | identiques (1 753 180) |
| `4k-x8-lazy` (360 images, 4K natif) | 9 989 (16 oct.) | 9 837 | 1 669 852 → 1 660 114 |
| `4k-x3-simultaneous` (150 images) | 5 763 (16 oct.) | 5 551 | 1 182 530 → 1 197 361 |

Profil HEVC 1080p, en ms par image (répétition médiane) :

| Étape | 3.6.1 | 3.7.0 |
| --- | --- | --- |
| Import | 3,63 | 3,34 |
| Attente GPU | 1,85 | 1,66 |
| Buffer encodeur (`target`) | 1,33 | 1,35 |
| Encodage | 4,40 | 3,84 |
| Décodage | 2,82 | 2,76 |
| Total | 15,5 | 14,4 |

Lecture :
- **Android est neutre en vitesse.** Les écarts vont dans les deux sens, de −4 % à +5 %, et restent dans la dispersion des répétitions. Les 15 exports 3.7.0 et les 6 cas 4K passent, nettoyage strict compris.
- **La robustesse Dawn ne coûte rien de visible** : l'import, qui comprend notre blit YUV, ne ralentit pas (3,34 contre 3,63 ms en HEVC 1080p).
- **Les fichiers issus d'`ImageReader` changent de taille**, surtout en HEVC 1080p (−5,7 %). Le cas décodé par EGL produit exactement les mêmes octets. Le contrôle `interop` reste à ±1 sur les 10 cas, avec les mêmes écarts par fichier qu'en 3.6.1 : niveaux et couleurs sont justes. Il n'échantillonne cependant que 13 patchs 8×8 par image. L'hypothèse la plus probable est un changement du filtrage de la chrominance dans la texture externe de Dawn 157 ; **elle n'est pas vérifiée**. Une comparaison image entière des deux exports la confirmerait.
- **Aperçu de 3 clips 4K simultanés :** 30 à 35 callbacks de dessin par seconde en 3.7.0, contre 29 à 30 le 16 octobre. Ce sens est cohérent avec le producteur Skia qui garde une frame d'avance (3.6.3), mais ce sont des callbacks, pas des frames présentées, et la référence avait démarré en *fair*. Les autres cas restent à environ 58 par seconde, sur un écran à 60 Hz.

**Runs écartés :**
- deux runs sur l'APK au bundle JS périmé (`-stalejs`) ;
- deux contrôles `interop` interrompus. Le premier a été mis en arrière-plan par un geste sur le téléphone. Dans le second, Android 17 a relancé l'app après sa réinstallation, sans les paramètres du runner. Pendant la campagne, un script lançait ces deux commandes avant chaque run. Elles sont maintenant dans `test-android-device-run.mjs` : arrêt forcé de l'app et retour à l'accueil avant l'installation. Ce changement du runner n'a pas été relancé sur appareil.

**Version de la bibliothèque.** Elle passe à `0.1.0-alpha.1` après ces mesures, sans autre changement de code. Les apps mesurées déclarent encore `0.1.0-alpha.0`. L'exemple lit désormais cette version dans `package.json`.

## Appareil iOS : iPhone 15 Pro

Protocole :
- **Conditions :** iPhone 15 Pro (iPhone16,1), iOS 27.0.1, Release, au premier plan.
- **Runner :** `test-ios-device-ab-run.mjs`, trois répétitions par cas.
- **Référence :** l'app 3.6.1 finale archivée de la campagne précédente (`ios-361-final`).
- **Preuves :** le JSON compact est [`benchmark/ios-device-370-ab.json`](../../benchmark/ios-device-370-ab.json).

**Première série, écartée : téléphone sur chargeur sans fil.** Ordre 3.6.1, 3.7.0, 3.7.0, 3.6.1. Le téléphone passe en état thermique *fair* dès la fin du premier run. Les deux runs 3.7.0 sont 15 à 80 % plus lents. Toutes les étapes CPU ralentissent ensemble (décodage VideoToolbox, encodage, import, buffer encodeur), alors que l'attente GPU ne bouge pas. Le dernier run 3.6.1, lui aussi en *fair*, reste rapide. Cette série ne permet donc pas de conclure.

**Seconde série, retenue : hors chargeur**, ordre 3.7.0, 3.6.1, 3.6.1, 3.7.0, état *nominal* sur chaque échantillon :

| Cas (médiane, ms) | 3.7.0 (1) | 3.6.1 (1) | 3.6.1 (2) | 3.7.0 (2) |
| --- | --- | --- | --- | --- |
| `native-hevc-1080p-rot270` | 731 | 734 | 734 | 731 |
| `encode-h264-copy` | 171 | 211 | 173 | 168 |
| `4k-x8-lazy-maxLongSide1280` | 2 732 | 2 783 | 2 736 | 2 791 |

Lecture :
- **iOS est neutre**, comme attendu : le chemin d'export iOS ne change pas dans cette migration.
- **Le profil par image est le même** : HEVC 1080p 3,74 à 3,80 ms, 8×4K réduits 7,39 à 7,86 ms dans les deux versions.
- **Octets produits :** identiques entre versions (HEVC 379 829, 8×4K 700 699). Le H.264 alterne entre 51 534 et 52 081 octets dans les deux versions.
- **36/36 exports** réussis dans cette série, comme dans la première.

## Fluidité du canvas sur Android 10

Non mesurée ici : aucun appareil Android 10 n'était disponible. Le Pixel 8a, sous Android 17, n'a pas l'attente `dequeueBuffer` que corrige Dawn 157. Les mesures de l'amont sont dans l'[audit](upstream-audit.md#canvas-plus-fluide-sur-android-10).
