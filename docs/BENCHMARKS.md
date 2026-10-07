# Comparer Skia Video et Skia 3 / WebGPU

Le dossier `benchmark/` contient un programme commun aux deux applications. Il reproduit les 31 compositions de l'ancien écran de stress, ajoute 28 cas de régression, trois lectures continues en copy et leurs trois variantes direct : **65 workloads déterministes**, version **`2026-10-07.1`**. Les sources vidéo, les seeks, les pauses, les tailles demandées et les séquences de montage sont identiques pour les deux versions.

Les essais physiques du **7 octobre sous Skia 3.0.3** ont passé **50/50 XCTest natifs**, sans échec ni skip, puis **5/5 cas du smoke candidat**. [ios-native-device-verification.json](../benchmark/ios-native-device-verification.json) conserve la preuve native. Ces smokes sont fonctionnels ; les premiers relevés d'un cas avant activation de l'application sont exclus du timing A/B. Le [comparatif physique court](PERFORMANCE_AB_IPHONE_303.md) a ensuite couvert huit scénarios en ABBA : **48/48 réussites candidat, 47/48 référence**, avec réserve thermique au premier passage de la référence et qualification stricte failed conservée. Cela ne qualifie pas tous les 65 workloads.

Le [diagnostic physique prolongé](PERFORMANCE_SOAK_IPHONE_303.md) a passé **3/3 blocs et sondé 300 exports**, avec croissance RSS/empreinte physique et ressources suivies finales à zéro. Le collecteur de repos a dépassé son délai sans fichier, tandis que la référence a subi un SIGTRAP natif sans JSON comparable. Aucun repos absent n'est remplacé par zéro ou un gain chiffré. Les tests 3.0.3 sont arrêtés à la demande utilisateur ; le manifeste courant **Skia 3.0.6 / WebGPU 0.12.1** a passé son premier run de **50 XCTest natifs sur iPhone**, sans échec ni skip, terminé à **08:23:15 UTC** : [preuve versionnée](../benchmark/ios-native-device-306-verification.json). Le run initial a aussi passé **154 Jest dans 8 suites** ; le transport TypeScript optimisé a ensuite passé **157 Jest**, les **4 tests du patch**, Bob et publint strict. La [preuve fonctionnelle du simulateur](../benchmark/ios-simulator-306-functional-verification.json) conserve **14/14 cas ciblés**, une répétition chacun, **27 exports / 1320 frames sondés** et compteurs suivis settled à zéro. Les pixels et l’immutabilité visuelle held restent non validés. Le smoke physique optimisé a ensuite passé **5/5 cas**. La [comparaison initial/optimisé 3.0.6](PERFORMANCE_IPHONE_306_OPTIMIZATION.md) conserve **96/96 exécutions, 24 fichiers / 1440 frames sondés**, avec **3260 relevés fair/normal/active** et 120 points settled à zéro pour les quatre compteurs suivis. L’empreinte physique au pic baisse d’environ 11 % en lecture 4K ; le RSS reste proche, les petits pipelines export sont plus lents et aucun gain global de vitesse n’est établi. Qualification stricte incomplete : nominal non satisfait et validateurs médias incomplets ; aucun palier physique qualifié.

Le premier smoke physique du **6 octobre** reste historique : **0 réussite, 1 échec, 4 non exécutés**, avec des réservations et décodeurs encore présents après fermeture. Il conserve de vrais relevés RSS, mais ne qualifie aucune performance ni absence de fuite. Sa correction et les mesures du [simulateur](IOS_SIMULATOR_TESTS.md) restent distinctes des nouveaux runs iPhone. Les tests exécutés sur l'hôte vérifient le programme de comparaison, pas la vitesse de Skia ou la mémoire des pilotes.

Les [diagnostics physiques Android 3.0.6](ANDROID_DEVICE_306.md) conservent les différents binaires testés sur Pixel 8a. Le binaire AHardwareBuffer a passé **24/24 essais**, trois répétitions des huit scénarios H.264 1080p, H.264/HEVC 4K et export H.264 en copy/direct, avec les réservations finales à zéro après fermeture stricte. Les **986 relevés** sont nominal/normal/active, sans échantillon perdu ; **6 exports / 360 frames** ont été sondés. L'oracle CPU/AHB séparé a passé **10/10 cas et 66 560 canaux SDR échantillonnés**, avec erreur maximale zéro ; les **6 tests natifs AHB** passent sans skip. Les checkpoints CPU restent conservés : **0/24 réussites strictes** initialement, puis **8/8 opérations sans OOM mais 0/8 fermetures strictes** avec scoped-copy. Cette dernière référence n'a qu'une tentative par cas ; aucun gain A/B contre Skia 2 ou qualification mémoire longue n'en est déduit.

Une série Android distincte a passé **4/4 cas de cycle de vie**, une répétition chacun : pause/reprise, retrait d'items de la frame map, pause/attente puis cinq seeks, et `4k-x8-lazy-direct`. Ce dernier a effectué ses huit opérations, **25 cycles de churn et 40 remontages**, puis sondé un export **1080×1080 H.264 de 360 frames sur 12 secondes**, avec PTS exacts et progression 360/360. Ses pics atteignent **800,25 Mio RSS / 1 037,91 Mio PSS** ; le RSS settled reste à **785,82 Mio**, alors que les réservations suivies sont à zéro. Les **1 267 relevés** de cette série sont nominal/normal/active, sans perte. Les seeks n'ont pas de validation pixels/PTS natifs ; le nom `held-image-survives-seek` ne prouve pas l'immutabilité d'une SkImage distincte. Les cinq tests JNI CPU ont repassé sur le même binaire. Cette portée ne remplace pas la suite complète ni une endurance longue.

## Couverture de l'existant

L'inventaire complet est dans [`baseline-test-inventory.json`](../benchmark/baseline-test-inventory.json). Il pointe vers chaque fichier, méthode et ligne du dépôt source au commit `334348ffeee8a4f6887fd1f663f8cf584f579911`.

| Groupe | Cas nommés | Vérification attendue |
| --- | ---: | --- |
| Jest : API, hooks, export, crop/rotation et images | 40 | Mêmes assertions sur les sources ancienne et nouvelle |
| C++ : politique de seek et fenêtres des décodeurs | 20 | Exécution sur l'hôte, dont les fenêtres aléatoires |
| Android : tailles et fenêtres | 12 | Tests JVM existants |
| Android : lectures, compositions, export, codecs, erreurs et textures | 40 | Instrumentation physique ; les paramètres multiplient le nombre réel de cas |
| iOS : décodeurs, preview, export, tailles, slow motion et encodeurs | 50 | 50 réussis sans échec ni skip sur simulateur, puis sur iPhone physique le 7 octobre ; première tentative iPhone historique 45/50 avant correctifs |

Les cas Android paramétrés représentent **86 exécutions** avant les skips de codecs : `MediaTest` comporte neuf profils, `DirectTextureTest` cinq et `PlayerTest` deux modes. Les profils incluent les rotations 90/180/270°, HEVC, 4K, 60 fps et les dimensions 638×358.

L'inventaire distingue l'assertion native reproduite, le workload associé et la preuve d'exécution. Il associe les 162 cas nommés à un fichier et une assertion candidate. Les 50 méthodes XCTest iOS ont été portées avec leurs noms d'origine, compilées avec les vrais headers du SDK iPhoneSimulator puis liées dans la cible de test iPhone Release. Leur compilation ne vaut pas exécution sur cible.

Les assertions natives sur les pixels, les indices de frame, les threads et la fermeture des décodeurs restent dans les suites. Un workload commun ne les remplace pas. Trois assertions iOS sur l'ancien recyclage des textures ont été remplacées par des assertions explicites de lease : les pixels d'une frame détenue survivent au seek et à la fermeture du producteur, les deux leases de preview bornent les buffers en vol, puis la libération du consommateur permet le prochain buffer. L'inventaire indique ce changement de sécurité ; le test « retirer après quatre frames » conserve son nom pour retrouver sa provenance.

Les 65 workloads actuels couvrent :

- toutes les compositions de l'écran `StressTest`, en mode eager/lazy et copy/direct ;
- crossfades, huit clips 4K, trois clips simultanés et vingt clips courts ;
- audio mixé, volume, source audio absente et start après la fin du fichier ;
- seeks dans les deux directions, scrub fixe ou pendant la lecture, seek avant ready, seek après la fin et reprise ;
- pause avec horloge immobile, reprise, retrait des items fermés de la frame map et image détenue pendant un seek ;
- trois lectures continues sans seek, en H.264 1080p, H.264 4K et HEVC 4K, chacune en copy et direct, distinctes des scénarios historiques ;
- hold, pacing, 40 cycles de création/libération et 25 cycles courts de churn ;
- export H.264/HEVC, codec inconnu, copy/direct, annulation avant/pendant l'export ;
- vingt exports de tailles alternées et une composition de 120 clips ;
- LUT, compute, Three.js et Core ML, quand leurs adaptateurs de rendu sont installés.

Un fichier manquant ou un adaptateur absent donne un **skip explicite**. Le cas reste dans le catalogue. Il n'est jamais retiré pour rendre les résultats plus favorables.

## Deux builds séparés

Construire deux applications identiques en mode release :

1. L'application de référence contient `@azzapp/react-native-skia-video` et sa version Skia 2 effective.
2. L'application candidate contient `react-native-skia-webgpu-video`, `react-native-skia` et `react-native-webgpu`.

Utiliser le même appareil, la même version de React Native, les mêmes assets et la même fréquence d'écran. Les deux noms de paquet Skia ne doivent pas être installés ensemble. Les importations du harness sont injectées depuis le build actif ; aucun module du harness ne charge les deux backends.

Le fallback Android testé conserve le readback RGBA EGL, puis une copie native synchrone vers un ArrayBuffer CPU privé réutilisable, `queue.writeTexture` et un snapshot Graphite indépendant. Il évite l'image raster, son cache amont et la matérialisation de `texture.data` lors du rendu normal. La voie AHardwareBuffer testée négocie ses capacités avant décodage, rend le codec dans un AHB RGBA, puis effectue le blit WebGPU et le snapshot indépendant ; elle évite le readback CPU des frames d'entrée. L'export garde dans les deux cas son readback CPU puis l'entrée native de l'encodeur. Aucun de ces chemins ne garantit une vidéo intégralement sans copie. Conserver le transport effectif de chaque binaire dans son JSON et distinguer les [réservations Java/JSI et caches Skia](UPSTREAM_NOTES.md#android--éviter-le-cache-dimages-raster-du-provider) : les relevés des anciens fallbacks ne qualifient pas le binaire AHB.

## Protocole actuel sur iPhone

Le [guide physique](IOS_DEVICE_TESTS.md) donne les scripts de compilation séparés et [`test-ios-device-ab-run.mjs`](../scripts/test-ios-device-ab-run.mjs), qui utilise des produits signés `Release-iphoneos` déjà construits. Les deux builds mesurent les mêmes cas et les mêmes paramètres sur un processus neuf, avec trois répétitions ; les lectures au repos proviennent du collecteur natif de l'iPhone. Les JSON originaux, l'identité des binaires/fixtures et les interruptions de récupération restent conservés par label.

Le workload `2026-10-07.1` ajoute les variantes `steady-playback-h264-1080p30-audio-direct`, `steady-playback-h264-4k30-direct` et `steady-playback-hevc-4k30-direct`, avec les mêmes temps que leurs variantes copy. `encode-h264-direct` conserve le mode direct demandé à l'export. Ce choix d'API ne remplace pas le transport réellement annoncé par le backend : la référence et le candidat peuvent effectuer des copies différentes, et le candidat 3.0.3 conserve son chemin de référence avec readback CPU à l'export. Les [résultats physiques courts](PERFORMANCE_AB_IPHONE_303.md) et le [diagnostic de 300 exports](PERFORMANCE_SOAK_IPHONE_303.md) sont des expériences distinctes ; leur preuve ne s'étend pas à la migration 3.0.6.

## Protocole A/B sur simulateur

Le build de référence utilise les sources du fork au commit `334348ffeee8a4f6887fd1f663f8cf584f579911`, sans modification de son algorithme. Le test historique de lecture/seek a reproduit un crash de cette version dans la concurrence entre lecture et annulation de `AVAssetReader`. Conserver ce crash comme résultat fonctionnel ; il ne fournit pas de durée de performance exploitable pour la suite interrompue.

Pour mesurer les parties exécutables sur les deux versions, `.5` ajoute les IDs `steady-playback-h264-1080p30-audio`, `steady-playback-h264-4k30` et `steady-playback-hevc-4k30`. Ils demandent quatre secondes de composition, les décodeurs eager, le mode copy et une preview de 720×720 pixels, puis une mesure continue de 3,8 secondes. Leur propriété `seekBeforePerf: false` est consignée dans le catalogue. Le runner conserve le seek avant mesure pour tous les autres cas. Les 59 cas précédents, leurs données aléatoires et leurs opérations restent présents. Une lecture continue réussie ne répare ni ne valide le seek historique.

Construire et installer les deux applications Release avant les mesures. [`test-ios-ab-run.mjs`](../scripts/test-ios-ab-run.mjs) ne compile rien : il arrête les deux applications de test, lance un processus neuf pour la version choisie, attend le JSON, puis en conserve les octets originaux avec les hashes du binaire, du bundle et des fixtures. Un crash sans JSON ou un délai dépassé reste un échec d'exécution. Ne lancer aucune compilation, suite native lourde ou autre mesure en parallèle.

```sh
RNSKV_SIMULATOR="SIMULATOR_UDID"
run_skia_comparison() {
  node scripts/test-ios-ab-run.mjs --simulator "$RNSKV_SIMULATOR" \
    --backend "$1" --label "$2" --profile full --repetitions 3 \
    --case steady-playback-h264-1080p30-audio \
    --case steady-playback-h264-4k30 \
    --case steady-playback-hevc-4k30 \
    --case encode-h264-copy --case repeated-mixed-size-exports
}
run_skia_comparison baseline ab-baseline-1
run_skia_comparison candidate ab-candidate-1
run_skia_comparison candidate ab-candidate-2
run_skia_comparison baseline ab-baseline-2
```

Les labels sont réservés de manière exclusive ; choisir de nouveaux noms pour une autre expérience. Vérifier les conditions thermiques et ménager une pause entre les lancements si elles ne sont plus nominales. Le même collecteur natif demande le RSS toutes les 100 ms dans les deux applications ; les deux exports utilisent un runtime Worklets distinct du runtime JavaScript de l'écran. Cette fréquence peut néanmoins manquer un pic court et ne mesure pas le temps GPU.

Le rapport [`benchmark-ab-summary.mjs`](../scripts/benchmark-ab-summary.mjs) garde les deux paires séparées et fournit aussi les médianes des six répétitions par version. Il déduit l'ordre réel des timestamps, refuse le chevauchement des fenêtres et conserve le verdict du comparateur strict : une validation média absente demeure incomplète, un échec ou une régression demeure signalé.

```sh
node scripts/benchmark-ab-summary.mjs \
  --pair AB benchmark/results/ab-baseline-1.local.json benchmark/results/ab-candidate-1.local.json \
  --pair BA benchmark/results/ab-baseline-2.local.json benchmark/results/ab-candidate-2.local.json \
  --output docs/PERFORMANCE_AB_SIMULATOR.md \
  --json benchmark/results/ab-summary.local.json
```

Le diagnostic prolongé est une expérience séparée : utiliser `--profile soak --case repeated-mixed-size-exports --repetitions 3 --idle-seconds 180`. Il produit 300 exports et des relevés du même processus au repos. Les relevés au repos proviennent de `ps` sur macOS ; leur source reste distincte du `mach task_info` embarqué. Ils n'autorisent aucune attribution aux caches, au ramasse-miettes ou aux textures sans profilage supplémentaire.

## Fixtures locales et identité des fichiers

Générer les fichiers une seule fois sur macOS, puis transférer **ces mêmes fichiers binaires** dans les deux builds :

```sh
swift scripts/benchmark-make-media.swift /private/tmp/skia-video-fixtures
node scripts/benchmark-fixture-manifest.mjs /private/tmp/skia-video-fixtures /private/tmp/skia-video-fixtures/manifest.json
swift scripts/benchmark-probe-media.swift /private/tmp/skia-video-fixtures /private/tmp/skia-video-fixtures/manifest.json /private/tmp/skia-video-fixtures/probe.json
```

Le générateur est dérivé du générateur original Azzapp sous licence MIT. Il utilise AVFoundation, dessine les numéros de frame et les marqueurs d'orientation, crée de l'audio, ajoute les rotations 180/270° et produit une présentation slow motion par edit list. Il produit quatorze fichiers. L'option `--only=h264-638x358.mp4,h264-720p-rot180.mp4` permet une génération partielle en conservant les mêmes motifs et couleurs que la génération complète.

Les quatorze fichiers ont réellement été générés dans `example/fixtures`, dont H.264/HEVC 4K, HLG 10 bits, 60 fps, les rotations 90/180/270° et les pistes audio. Le lecteur AVFoundation a contrôlé les dimensions, codecs, durées, rotations, présence d'audio, comptes de frames et timestamps décodés de tous les fichiers : les quatorze sondes ont réussi. Leurs chemins, tailles, SHA-256 et observations sont enregistrés dans [`fixture-generation-status.json`](../benchmark/fixture-generation-status.json). Les quatorze médias réellement embarqués dans le build Release courant du simulateur, ainsi que le manifest, ont les mêmes tailles et SHA-256 que les sources : [`fixture-bundle-verification.json`](../benchmark/fixture-bundle-verification.json). Les treize premiers avaient aussi été vérifiés dans le build iPhone initial ; refaire cette vérification pour tout nouveau binaire.

La fixture `h264-slow-motion.mov` est désormais autonome : 180 frames présentées sur neuf secondes avec une vraie edit list. Ses timestamps ont été vérifiés après suppression du fichier source utilisé pour la construire. Une simple vidéo réencodée au ralenti ne reproduit pas cette présentation. Si cette fixture est absente d'un autre build, le cas conserve un skip explicite ; les tests iOS génèrent aussi leur propre présentation dans la suite.

Le manifest contient les tailles, codecs, durées attendues et les SHA-256 calculés sur les octets. Le lecteur sonde les médias réellement produits et décode leurs frames pour vérifier les timestamps ; une observation de métadonnées seule ne valide pas la précision HDR ou les pixels d'orientation. Toute modification de fichier oblige à recréer le manifest et à refaire les deux runs. Le comparateur refuse des hashes différents. Les tests natifs gardent leurs propres générateurs déterministes et assertions, à exécuter dans chaque build.

## Monter le même écran dans l'application

`benchmark/screen.mjs` fournit `createBenchmarkScreen`. Ajouter `mjs` à `resolver.sourceExts` de Metro et conserver le plugin Babel Worklets/Reanimated configuré dans l'application.

Exemple d'intégration dans le build candidat :

```js
import React from 'react';
import * as native from 'react-native';
import * as skia from 'react-native-skia';
import * as reanimated from 'react-native-reanimated';
import * as video from 'react-native-skia-webgpu-video';
import Blob from 'react-native-blob-util';
import { createBenchmarkScreen } from './benchmark/screen.mjs';

const files = {
  outputPath: async (id, repetition, cycle) =>
    `${Blob.fs.dirs.CacheDir}/benchmark-${id}-${repetition}-${cycle}.mp4`,
  stat: (path) => Blob.fs.stat(path),
  remove: async (path) => {
    if (await Blob.fs.exists(path)) await Blob.fs.unlink(path);
  },
  writeResult: (result) => Blob.fs.writeFile(
    `${Blob.fs.dirs.DocumentDir}/benchmark-results.json`,
    JSON.stringify(result),
    'utf8'
  ),
  // probe: native metadata reader returning codec, width, height, fps and duration.
};

export const BenchmarkScreen = createBenchmarkScreen({
  React, native, skia, reanimated, video, files,
  // memory: {
  //   sample: async () => nativeProcessMemoryReadings,
  //   operatingConditions: async () => nativeThermalAndPowerReadings,
  // },
  // validation: native pixel/audio/timestamp checks, outside timed draw callbacks.
});
```

Dans le build de référence, seules les importations `video` et `skia` changent. Le même écran et les mêmes `options` sont utilisés.

Passer à l'écran :

```js
const options = {
  profile: 'full',       // smoke / full / soak
  repetitions: 3,
  memorySamplePeriodMs: 100,
  memoryBudgetBytes: 512 * 1024 * 1024, // même limite demandée dans les deux builds
  fixtureDirectory: DEVICE_FIXTURE_DIRECTORY,
  fixtureManifest: VERIFIED_MANIFEST,
  environment: {
    deviceId: ACTUAL_DEVICE_ID,
    deviceModel: ACTUAL_MODEL,
    executionTarget: ACTUAL_EXECUTION_TARGET, // 'device' ou 'simulator'
    measurementClock: 'performance.now', // horloge utilisée par le même écran
    platform: native.Platform.OS,
    osVersion: ACTUAL_OS_VERSION,
    reactNativeVersion: ACTUAL_RN_VERSION,
    buildMode: 'release',
    displayRefreshRate: ACTUAL_DISPLAY_HZ,
    thermalState: MEASURED_THERMAL_STATE_OR_UNAVAILABLE,
    powerMode: ACTUAL_POWER_MODE,
  },
  backend: {
    name: 'webgpu',
    version: ACTUAL_LIBRARY_VERSION,
    skiaVersion: ACTUAL_SKIA_VERSION,
    paths: video.getVideoResourceStats?.().backend ?? DECLARED_BACKEND_PATHS,
  },
};
```

Les constantes ci-dessus viennent de l'application ou de l'appareil. Ne pas copier un faux identifiant, une version supposée ou un état thermique « nominal » non mesuré. Le profil `soak` porte les scrubs à 2 000 seeks et les cycles à 100. Le profil `smoke` ne qualifie pas la matrice complète.

Depuis le workload `2026-10-06.3`, la mesure demande une preview de **720×720 pixels physiques** dans les deux builds. À PixelRatio 3, le Canvas fait environ 240×240 points. Le résultat conserve les dimensions demandées, logiques et réellement dessinées ; un écart de résolution invalide la comparaison. Chaque répétition monte un enfant possédant son hook et son Canvas, le démonte, puis attend l'accusé de traitement de la queue UI avant les relevés de stabilisation. Les anciennes mesures à 720 points ne sont pas compatibles avec ce workload.

Le moteur candidat utilise par défaut un budget de réservations de 256 Mio. `memoryBudgetBytes` applique une limite explicite avant le premier cas via `configureVideoMemory({ maxBytes })`. Le résultat conserve la limite demandée, son application effective et la limite native rapportée. L'ancien backend n'a pas cette API : le JSON indique son absence et le comparateur signale la différence d'application. Une limite demandée différente rend les runs incompatibles.

Une frame 4K BGRA/RGBA 8 bits représente environ 31,6 Mio. Dans le chemin d'export CPU actuel, la surface de rendu, les deux réservations de readback et les trois buffers de l'encodeur peuvent réserver environ 190 Mio avant les frames natives, les images et les caches de codec/pilote. Les cas avec plusieurs clips 4K peuvent donc atteindre le budget de 256 Mio ; ils doivent signaler une limite de ressources et garder les dimensions demandées. La limite de 512 Mio de l'exemple est une configuration explicite du benchmark, à consigner dans les deux runs ; elle ne garantit pas que l'appareil dispose de cette mémoire physique. Le scénario qui demande `maxLongSide: 1280` reste un scénario distinct : aucune réduction silencieuse de qualité ne rend un cas 4K réussi.

L'écran mesure l'heure de composition et les IDs visibles pour attendre un seek. L'exactitude de l'index de frame repose sur les tests natifs et le validateur de pixels : afficher le bon item au bon temps n'est pas une preuve que ses pixels sont ceux attendus.

Les rendus d'extension s'injectent par `extensions: { lut: { drawFrame }, compute: { drawFrame }, three: { drawFrame }, coreml: { drawFrame } }`. Les ressources se créent au début de la session, se libèrent à sa fermeture et restent soumises au même budget. Une fonction de dessin export synchrone seule ne constitue pas encore un pipeline ML asynchrone. Un adaptateur doit préparer ses résultats au temps de composition demandé ; le cas reste skip tant que cet adaptateur n'existe pas.

## Ce que le JSON mesure

| Champ | Signification |
| --- | --- |
| `drawHistogram` | Temps CPU passé dans le callback de dessin ; buckets fixes, stockage constant |
| `callbackGapHistogram` | Intervalles entre callbacks ; pas une mesure des présentations écran |
| `exportMs` | Pipeline complet : encodage, vérification du fichier, sonde des métadonnées et suppression ; sans l'attente de stabilisation préalable |
| `encodeMs`, `probeMs` | Durée de la promesse d'export et durée de contrôle du fichier mesurées séparément |
| `framesCompleted`, `expectedFrames`, `progressEvents` | Progression monotone et nombre de frames demandé |
| `actualOutput` | Codec, dimensions et timestamps sondés dans le fichier exporté |
| `rssBytes`, `pssBytes`, `nativeHeapBytes`, `gpuBytes` | Lectures d'un collecteur identifié, ou `value: null` avec une raison |
| `ownedBytes`, `ownedResources` | Réservations internes de la bibliothèque ; estimations distinctes des allocations physiques |
| `decoderCount`, `inFlightFrames` | Compteurs natifs exposés par le backend, quand disponibles |
| `memoryBudget` | Limite identique demandée et disponibilité de son application par chaque backend |
| `collection.preview` | Pixels physiques demandés/dessinés, taille logique, PixelRatio et étapes de fermeture |
| `operatingConditions` des points mémoire | État thermique/alimentation mesuré à chaque relevé, ou raison d'indisponibilité |
| `diagnostic`, `cleanupDiagnostic` | Stack bornée, opération et étape d'échec ; erreur d'origine séparée de l'erreur de fermeture |

Le nombre de frames perdues et le temps GPU sont `null` tant qu'un compteur réel n'est pas branché. Une différence d'espacement entre callbacks n'est pas automatiquement une frame perdue. Les histogrammes donnent des quantiles approximatifs à leur borne supérieure. Garder ce coût de mesure identique dans les deux builds.

Le harness conserve des résumés et des histogrammes, jamais les frames ni les textures. Les points mémoire sont bornés à 2 048 par cas par défaut ; une troncature est enregistrée et rend la comparaison incomplète. Le relevé asynchrone conserve la phase et l'heure de sa demande même s'il revient après le démontage. Un échec de collecte des conditions ne supprime pas un relevé RSS réussi.

Les sorties temporaires sont supprimées après la fin ou le rejet de l'export. En cas d'export qui dépasse le délai et ne termine pas son annulation, y compris dans le scénario de tailles alternées, les cas suivants sont bloqués et le JSON demande de redémarrer le processus : aucune fermeture fictive n'est rapportée. Une réserve possédée restant après fermeture bloque aussi les cas suivants. Le cas « audio absent » ne valide que l'erreur attendue de piste audio absente ; un échec GPU, codec ou une limite mémoire reste un échec.

## Collecter la mémoire physique

Sur Android, le collecteur hôte continue à fonctionner même si l'ancien export bloque le runtime JavaScript :

```sh
node scripts/benchmark-sample-android.mjs DEVICE_SERIAL APPLICATION_ID /private/tmp/android-memory.jsonl 1000
```

Arrêter avec Ctrl-C à la fin du run. Il relève RSS, PSS et la contribution PSS du Native Heap quand elles sont accessibles. GL/EGL mtrack reste une mesure graphique partielle et n'est jamais renommé « mémoire GPU totale ». Les permissions et les pilotes peuvent rendre certaines mesures indisponibles.

Le fichier est ensuite aligné aux phases du résultat. Mesurer le décalage d'horloge appareil moins hôte avant le run ; le script exige cette valeur plutôt que de supposer une synchronisation :

```sh
node scripts/benchmark-merge-memory.mjs device-results.json /private/tmp/android-memory.jsonl merged-results.json MEASURED_CLOCK_OFFSET_MS
```

La fusion conserve les relevés indépendants pendant un export qui bloque le runtime JS, afin de garder ses pics RSS/PSS. Le résultat possède une timeline explicite des phases ; un relevé dont la collecte traverse une frontière de phase est exclu. Les points JS peuvent être complétés par le relevé de la même phase situé à moins de trois secondes. Le début, la fin, la durée de collecte et l'écart d'alignement sont enregistrés ; le stockage fusionné reste borné. Une ancienne timeline absente ou des conditions thermiques/alimentation non mesurées pendant un long blocage rendent la comparaison incomplète. Une fréquence trop faible peut manquer un pic court : utiliser les compteurs natifs de pic et un profil système en complément.

Sur iOS physique, les deux applications isolées fournissent le **RSS** via `mach task_info resident_size` et l'**empreinte physique** via `task_vm_info phys_footprint`, dans deux champs distincts de `memory.sample`. Le RSS n'est pas renommé footprint ni mémoire GPU totale ; ces valeurs ne s'additionnent pas. Les relevés au repos doivent être produits par l'iPhone et liés au même run/processus, sans `ps` du Mac. Utiliser Allocations/Leaks et Metal pour attribuer les allocations natives et GPU. Le heap JavaScript ne permet pas de conclure sur les CVPixelBuffers, les textures, les buffers de codec ou la mémoire d'un modèle Core ML.

Le mot `settled` désigne une phase après démontage effectif de l'enfant React/Canvas et traitement de sa fermeture sur la queue UI. Cet accusé ne prouve pas la libération des caches du pilote : les allocations physiques restent mesurées séparément. Si le backend ne fournit pas de fin de travaux explicite, le JSON le signale. Cette attente n'autorise pas à recycler un buffer encore utilisé par le GPU.

## Comparer et interpréter

```sh
node scripts/benchmark-compare.mjs baseline.json candidate.json comparison.json
```

Le comparateur refuse des fichiers dont l'appareil, l'OS, React Native, le mode release, la cible appareil/simulateur, l'horloge de mesure, la période de collecte mémoire, PixelRatio, les fixtures, la seed, les dimensions, les codecs demandés ou les opérations diffèrent. Chaque répétition doit contenir toutes les opérations, validations et phases mémoire requises dans les deux builds. Il vérifie chaque fichier contre les dimensions, le codec, le compte de frames et les timestamps demandés : deux sorties également erronées ne deviennent pas un succès. Il conserve les modes et le chemin de transport pour expliquer les changements ; la disponibilité différente de l'API de budget et les changements de transport restent des informations de comparaison.

Il compare les médianes d'au moins trois répétitions et fournit les variations absolues et en pourcentage. Les seuils initiaux sont des détecteurs de régression à calibrer avec la variance des appareils :

| Mesure | Déclenchement initial |
| --- | --- |
| Durée d'export | Hausse supérieure à 10 % **et** 100 ms |
| p95 du callback de dessin | Hausse supérieure à 15 % **et** 1 ms |
| Pic mémoire | Hausse supérieure à 10 % **et** 8 Mio, à collecteur identique |
| Croissance après warmup | Pente supérieure à 1 Mio/min **et** gain supérieur à 8 Mio |

Les tendances de croissance utilisent au moins trois cycles distincts après les dix premiers cycles, avec des indices explicites et des timestamps croissants. Plusieurs relevés d'une même fermeture comptent pour un seul cycle ; le relevé final des exports alternés est rattaché au dernier export. Un export isolé ne fournit aucune preuve de warmup et ne déclenche pas une alerte de croissance après warmup. Les pics RSS restent comparés indépendamment. Elles donnent le pic, le gain et la pente ; elles ne remplacent pas une analyse des allocations. Un palier de cache pilote peut subsister après fermeture. Pour chaque session terminée, vérifier séparément que les ressources propres à la session reviennent à zéro ou à un cache global explicitement borné.

Codes de sortie : `0` = mesures comparables dans les limites ; `1` = régression ou échec ; `2` = fichiers incompatibles / invalides ; `3` = comparaison incomplète. Un skip, moins de trois répétitions, des métadonnées non sondées ou l'absence de mémoire physique ne donnent jamais un succès de qualification.

Alterner l'ordre A/B puis B/A, laisser refroidir entre les runs, garder le même mode d'alimentation et vérifier les états thermiques à chaque relevé. L'application iPhone fournit ces lectures via `NSProcessInfo` dans `memory.operatingConditions`. Des conditions inconnues, un état thermique non nominal ou un changement d'alimentation rendent les conclusions de performance incomplètes ; les erreurs de pixels et la croissance mémoire restent des constats à analyser. Le collecteur fait partie du coût du test et doit être identique dans les deux builds. Aucun seuil fixe ne garantit l'absence de fuite : il faut aussi une longue session et l'inspection des compteurs / allocations.

Les quatre traces natives de création/fermeture du candidat sont derrière `RNSV_TRACE_LIFECYCLE`, désactivé en Release. La référence conserve les traces originales d'ouverture/fermeture de fenêtre lazy afin de tester le fork inchangé. Ce coût clairsemé reste une différence d'instrumentation à consigner, notamment pour les exports lazy ; ce ne sont pas des traces par frame. Les avertissements `unrecognised property keys` viennent du codec HEVC Apple du simulateur (`VCPHEVC.videocodec`), y compris dans les XCTest HEVC qui passent. Ils ne justifient aucun patch JavaScript ; isoler ce bruit du codec si nécessaire pendant les mesures. Les mesures du candidat seul ne démontrent aucun gain par rapport à la référence.

## Vérifications exécutées sur l'hôte

```sh
node --test test/comparison/*.test.mjs
node scripts/benchmark-inventory.mjs
node scripts/test-jvm-host.mjs
node scripts/test-native.mjs --asan
node scripts/test-ios-parity-syntax.mjs
node scripts/test-skia-patch-syntax.mjs
swiftc -typecheck -module-cache-path /private/tmp/skia-benchmark-swift-cache scripts/benchmark-make-media.swift
```

Les **112 tests du harness, du rapport A/B et de leurs preuves passent**, sans échec ni skip. Ils vérifient la déterminisation, la couverture de l'ancien écran, les montages/démontages effectifs, les pixels physiques demandés, les fixtures, l'annulation de tous les chemins d'export, les progressions invalides, la pause/reprise, les seeks, les frame maps et la classification des erreurs. Les régressions supplémentaires couvrent la télémétrie et les diagnostics bornés, les relevés asynchrones et externes, les conditions thermiques, les champs d'identité manquants et les résultats erronés identiques entre deux backends. Dix-sept nouvelles régressions vérifient l'horloge mobile et l'identité des frames pendant les seeks en lecture. Quatre tests vérifient le recorder XCTest ; son self-test séparé valide 24 assertions de rejet des preuves incomplètes ou périmées.

Le run historique de l’alpha **3.0.3** compte **138 tests Jest réussis dans 6 suites**, dont six nouvelles régressions autorelease avec le vrai Babel/runtime. La preuve hôte renouvelée le **6 octobre à 16:36:02 UTC** contient **170 assertions**. Avec les **50 XCTest sur simulateur**, tous passés sans skip à **16:36:31 UTC**, elle couvre **122 cas historiques sur 162** : 72 cas hôte et 50 sur simulateur, fingerprint `486b12a…`. Ces mêmes 50 cas ont aussi passé sur l'iPhone physique le **7 octobre à 07:23:57 UTC**, sans nouveau nom ajouté au dénominateur historique. Les 40 cas Android appareil restent à exécuter. La première tentative iPhone 45/50 est historique, avant correctifs. Les nouvelles régressions Jest ne changent pas le nombre de cas historiques.

Pour consigner les assertions hôte dans l'inventaire, enregistrer un run Jest complet et réussi, puis lancer `node scripts/benchmark-record-host-verification.mjs PASSED_JEST_JSON` et régénérer l'inventaire. Ce script réexécute les tests C++ et JVM, conserve les commandes et résultats, et lie la preuve aux hashes des sources et de `test/utils/serializedUiRuntime.ts`. Il refuse un JSON Jest antérieur à une modification de ce helper. Toute modification de source invalide ce statut jusqu'à une nouvelle vérification. Les fichiers JUnit/Hamcrest sont lus dans le cache local ou via `RNSV_JUNIT_JAR`/`RNSV_HAMCREST_JAR`, sans téléchargement automatique.

Pour consigner une nouvelle exécution native du simulateur, utiliser le `.xcresult` produit par le script iOS :

```sh
node scripts/benchmark-record-ios-simulator-verification.mjs RESULT.xcresult
node scripts/benchmark-inventory.mjs
```

Le recorder exige les 50 noms XCTest de la source, tous passés, aucun skip/échec, une cible Simulator réelle et des sources antérieures au début du build. Il lie la preuve aux hashes des sources, dépendances, projet et fixture. Le résultat actuel est dans [ios-simulator-verification.json](../benchmark/ios-simulator-verification.json) ; un run précédent réellement réussi a été rejeté parce qu'une source avait changé ensuite. La fixture JPEG 1279×719 y est identifiée par hash : ses 30 indices, pixels et dimensions aux temps demandés sont vérifiés par le test simulateur ; les PTS bruts du fichier ont été vérifiés séparément par AVFoundation sur macOS. Cela ne remplace pas les validateurs pixels/audio encore absents du catalogue applicatif.

Le runner natif exécute les 20 assertions C++ originales, 200 000 fenêtres aléatoires, 100 000 dispositions de buffers vérifiées contre les débordements, 40 000 réservations concurrentes, les callbacks JSI après destruction/teardown, 10 000 cycles de buffers iOS et un export H.264 réel de 120 frames. Ce dernier vérifie 60 frames rouges puis 60 bleues, les timestamps exacts et 100 seeks du lecteur. Les compteurs possédés reviennent à zéro ; les runs avec AddressSanitizer/UndefinedBehaviorSanitizer ont réussi. Ces tests de médias utilisent CoreVideo/AVFoundation sur macOS et nécessitent l'accès aux services IOSurface/VideoToolbox ; `--pure-only` n'exécute que les tests indépendants des médias. Les 21 tests JVM ont également réussi, dont les 12 assertions historiques.

Sur macOS, `test-native.mjs` compile aussi les 50 assertions XCTest portées et le vrai header du patch Canvas avec Skia 3 Graphite/Dawn et le SDK iPhoneSimulator. Les deux scripts de syntaxe se lancent séparément sans accès au service de codec. Ils ne déclarent aucune exécution des 50 XCTest ni aucun test GPU Dawn. Le générateur Swift utilise les mêmes API que l'ancien générateur ; le SDK macOS récent émet des avertissements de dépréciation, sans erreur de types.

L'application isolée `example/ios/ReactNativeSkiaWebGPUVideoExample.xcworkspace` et sa cible contenant les 50 XCTest ont passé le build complet Release pour l'architecture de l'iPhone connecté, incluant la liaison Skia 3 / Dawn / WebGPU, puis ont été signées et installées sur iPhone 15 Pro. Le build utilise les bundle IDs distincts `com.seb.skiawebgpuvideo.test` et `.tests`. [`ios-build-verification.json`](../benchmark/ios-build-verification.json) conserve la preuve du premier build sans signature. La confiance du certificat, la configuration UIScene et le linkage ont été corrigés. Le smoke initial du **6 octobre** avait ensuite échoué au premier montage avec `Cannot read property 'current' of undefined`. Le rapport local `benchmark/results/first-iphone-smoke.local.json` conserve les mesures et les quatre skips suivant cet échec. Le smoke actuel du **7 octobre a passé 5/5 cas**. Le module expose le RSS par `mach task_info`, les conditions thermiques/alimentation par `NSProcessInfo`, les fichiers de résultats et une sonde d'export AVFoundation ; il ne mesure pas la mémoire GPU totale.

[IOS_DEVICE_TESTS.md](IOS_DEVICE_TESTS.md) donne les étapes sur iPhone 15 Pro : exécution des 50 cas avec Cmd+U, profils de benchmark en Release avec Cmd+R et récupération des JSON dans `Documents/benchmark-results`. Le script `scripts/test-ios-device.mjs` reprend ces lancements. Sous 3.0.6, les applications Android Debug/Release, l’AAR Debug et l’APK d’instrumentation ont compilé ; la [preuve de compilation Android](../android/BUILD_VALIDATION.md) et les [diagnostics appareil](ANDROID_DEVICE_306.md) identifient chaque checkpoint. Le binaire AHB a passé **43 JVM, 6 tests natifs physiques et les 24 essais ciblés** ; la suite d'instrumentation entière, les sessions longues et la mémoire complète du pilote restent non qualifiées. Le code TypeScript courant passe **191 Jest dans huit suites et le contrôle des types**. La [preuve hôte de la révision iOS antérieure](../benchmark/host-verification.json) contient séparément **189 assertions : 157 Jest, 20 C++ et 12 JVM historiques**, sans qualifier ces changements suivants. Les résultats physiques 3.0.3 restent historiques. La preuve native 3.0.6 couvre les 50 XCTest du premier build iPhone ; les 14 cas optimisés sur simulateur et la [passe physique initial/optimisé 3.0.6](PERFORMANCE_IPHONE_306_OPTIMIZATION.md) sont des preuves distinctes. L'oracle Android ne valide que les pixels SDR échantillonnés ; audio, HDR et performances iOS nominales restent à qualifier.

La cible XCTest iOS candidate est rattachée et le build signé est installé. Le run natif iPhone a produit 45 réussites/5 échecs avant correctifs, puis **50/50 réussites sans échec ni skip le 7 octobre** : [preuve physique](../benchmark/ios-native-device-verification.json). Sur simulateur, **50/50 XCTest passent**, après correction du replay et activation des scopes autorelease synchrones. **Sept cas ciblés** (smoke cinq cas et seek/scrub en lecture) ont passé le **6 octobre entre 16:37:45 et 16:38:43 UTC**, en workload `.4`, avec les ressources suivies revenues à zéro. `benchmark/results/simulator-functional-pooled.local.json` et `final-functional-source-pooled.local.json` conservent le run et sa provenance `486b12a…` / bundle `eb434d2…`. Les exports sont sondés avec dimensions et timestamps exacts ; les validateurs pixels/audio du catalogue restent indisponibles.

Le premier `full`, achevé à **15:40:56 UTC** sur le build d'empreinte `4a087400…`, a parcouru les 59 workloads sur une répétition :

| Statut | Nombre | Détail |
| --- | --- | --- |
| Réussi | 50 | Opérations fonctionnelles exécutées selon le harness |
| Échec | 2 | `seek-while-playing` et `scrub-while-playing` : timeout sur le prédicat `.3`, réexécutions `.4` réussies séparément |
| Limite de budget | 3 | `montage-all-crossfade-eager`, `4k-x8-eager`, `4k-x3-simultaneous` : budget déclaré de 512 Mio atteint |
| Extension indisponible | 4 | LUT, compute, Three.js et Core ML non branchés |

Le rapport brut `benchmark/results/simulator-full-first.local.json` conserve les 59 résultats `.3`. Les 55 cas actifs rendent à zéro les octets/réservations/codecs/buffers en vol suivis, sans `cleanupError` ni `unsafeToContinue`. Ces compteurs ne représentent pas toute la mémoire physique et n'effacent pas les deux échecs historiques. La version `.4` valide le seek contre l'horloge qui avance, un nouveau rendu, les items visibles et le changement d'identité native disponible ; elle n'invente aucun PTS natif. Les réexécutions ciblées ne remplacent pas un full59 du build actuel.

La mesure actuelle du **candidat simulateur Release** a réussi **15/15 répétitions**, entre **16:40:14 et 16:43:27 UTC**, sur cinq cas : H.264 1080p/audio, H.264 4K, HEVC 4K, export H.264 et exports de tailles alternées. Les **63 fichiers exportés ont été sondés**, et les ressources suivies sont à zéro après chaque répétition. [PERFORMANCE_SIMULATOR.md](PERFORMANCE_SIMULATOR.md) conserve ces résultats de la révision `486b12a…`. Le RSS des exports alternés progresse d'environ 445 à 574 Mio après fermeture au fil des trois répétitions ; zéro owned ne prouve pas un palier physique ni une absence de fuite.

Le diagnostic distinct de cette révision a réussi **3/3 répétitions de 100 exports**, soit **300 fichiers sondés**, entre **16:44:32 et 16:47:41 UTC**, sans profilage concurrent ni télémétrie tronquée. Ses ressources suivies reviennent à zéro, mais le RSS final progresse d'environ **419 à 554 puis 627 Mio** ; le pic échantillonné atteint **877 Mio**. Les relevés du même processus au repos sont conservés séparément : **551,375 puis 353,453 Mio**, environ cinq minutes après les exports pour le dernier. Cette récupération différée ne fournit aucune attribution heap/GC/GPU ni preuve de palier stable ou d'absence de fuite.

[PERFORMANCE_SIMULATOR_INITIAL.md](PERFORMANCE_SIMULATOR_INITIAL.md) conserve la passe antérieure `621c20f…`, son long run de 300 exports et les relevés au repos. Le RSS de ce long run diminue entre répétitions puis redescend à 85,234 Mio après repos. Cette observation ne fournit aucune attribution heap/GC/GPU et aucun gain statistique n'est déduit entre les passes.

Le run utilise `performance.now` et des relevés mémoire demandés toutes les **100 ms**, dont le coût fait partie des mesures. `scripts/benchmark-performance-summary.mjs` exige les trois répétitions passées, des identités/conditions/collecteurs constants, les dimensions réelles et les sondes exactes. Il distingue cadence des callbacks, durée murale de leur travail, pipeline export hors sonde et pics mémoire échantillonnés ; aucun temps GPU ni heap natif/JS n'est disponible. Pour régénérer le rapport à partir des preuves locales :

```sh
node scripts/benchmark-performance-summary.mjs benchmark/results/simulator-performance-pooled.local.json --host benchmark/results/performance-host.local.json --provenance benchmark/results/final-functional-source-pooled.local.json --long-run benchmark/results/simulator-mixed-soak-pooled.local.json --long-idle-observations benchmark/results/mixed-soak-pooled-idle-observations.local.json --output docs/PERFORMANCE_SIMULATOR.md
```

Le hardware hôte vérifié est un MacBookPro18,3, Apple M1 Pro, 16 Gio, macOS 27.0.1 ; ce n'est pas le hardware de l'iPhone simulé. Les chiffres candidat seul ci-dessus restent historiques au workload `.4` ; les runs A/B `.5` doivent être consignés séparément. Les mesures physiques restent différées.


## Comparaison prolongée achevée

Le diagnostic `.5` a terminé **300 exports par bibliothèque**, tous sondés : [résultats et repos](PERFORMANCE_AB_SOAK_SIMULATOR.md). Le RSS final des trois blocs vaut environ 308/315/300 Mio pour l’ancien, 416/553/626 Mio pour le nouveau. Après trois minutes de repos du même processus, le RSS mesuré par `ps` vaut **133,20 Mio contre 437,38 Mio**. Les ressources suivies du candidat sont à zéro, mais la rétention physique reste à expliquer ; aucun profil heap/GPU n’a été collecté. Cette passe confirme le besoin de traiter la consommation d’export avant la 3D/ML.

Les six runs comparatifs totalisent **66 exécutions de workloads et 852 fichiers sondés**, incluant les deux paires courtes et la session longue. L’ancien dépôt est conservé inchangé. Le premier crash historique de seek reste documenté séparément. [Preuve agrégée](../benchmark/ab-simulator-verification.json), [guide de migration](MIGRATION.md).
