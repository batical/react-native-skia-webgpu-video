# Vérifier le fonctionnement sur le simulateur iOS

La priorité actuelle est de faire fonctionner la lecture, l'export et la fermeture sur le simulateur. Les actions sur l'iPhone sont arrêtées à la demande de l'utilisateur. La cible choisie est **iPhone 18 Pro, iOS 27** ; utiliser son identifiant fourni par Xcode ou `xcrun simctl list devices available`.

Le script de la racine utilise le même workspace et schéma que l'exemple iPhone, en **Release**, avec un bundle JavaScript embarqué. Il compile et installe uniquement sur le simulateur, sans signature de développement ni serveur Metro :

```sh
node scripts/test-ios-simulator.mjs --simulator SIMULATOR_UDID --launch --profile smoke
node scripts/test-ios-simulator.mjs --simulator SIMULATOR_UDID --launch --profile smoke --case single-h264-638x358.mp4 --repetitions 1
node scripts/test-ios-simulator.mjs --simulator SIMULATOR_UDID --native
```

`--native` exécute la cible contenant les 50 XCTest. `--case ID` isole un scénario et s'utilise avec `--profile smoke`, `full` ou `soak` ; répéter l'option pour sélectionner plusieurs cas. `--repetitions 1` permet d'abord de vérifier son fonctionnement ; la valeur par défaut est trois pour les mesures, mais une répétition ne qualifie pas une comparaison statistique. `--profile full` parcourt le catalogue complet ; `--profile soak` augmente les cycles. `--build-only` compile sans lancer. Le script affiche le dossier des logs et le rapport `.xcresult` du run natif.

Pour reproduire les cinq cas de performance sur trois répétitions :

```sh
node scripts/test-ios-simulator.mjs --simulator SIMULATOR_UDID --launch --profile full --repetitions 3 --case single-h264-1080p30-audio.mp4 --case single-h264-4k30.mp4 --case single-hevc-4k30.mp4 --case encode-h264-copy --case repeated-mixed-size-exports
```

Pour un diagnostic distinct de 300 exports, le profil soak applique 100 cycles par répétition à ce seul cas :

```sh
node scripts/test-ios-simulator.mjs --simulator SIMULATOR_UDID --launch --profile soak --case repeated-mixed-size-exports --repetitions 3
```

Conserver les trois sorties séparées : rapport XCTest, JSON des cinq cas mesurés et JSON du diagnostic long. Ne pas les fusionner en un succès du catalogue complet.

Le scénario **`single-h264-638x358.mp4` a d'abord réussi en Release**, sur une répétition : 240 callbacks de dessin, aucune frame attendue manquante, cinq seeks, boucle et hold. Le rapport est conservé dans `benchmark/results/simulator-h264.local.json` et indique `executionTarget: simulator`.

Le **profil smoke a ensuite réussi ses cinq scénarios**, sur une répétition : montage de huit clips 4K avec décodage borné à 1280, lecture H.264 simple, export H.264, annulation avant export et reprise après seek au-delà de la fin. Les réservations, décodeurs et buffers encodeur suivis reviennent à zéro après chaque cas. Les deux fichiers exportés ont été sondés : 360 frames en 1080×1080 et 60 frames en 640×360, H.264/30 fps avec timestamps exacts. Le rapport brut est conservé dans `benchmark/results/simulator-smoke.local.json`.

La confirmation native **actuelle a passé 50/50 XCTest, aucun échec ni skip**, terminée à **16:36:31 UTC**, après les correctifs d'horloge/replay et activation des scopes autorelease synchrones sur le thread Worklets. [ios-simulator-verification.json](../benchmark/ios-simulator-verification.json) conserve les 50 noms passés et les empreintes actuelles `486b12a…`. Le test eager vérifie l'horloge stable après complete, la reprise avec des frames du début et les `play()` répétés idempotents. Le test de la vraie fixture JPEG 1279×719 vérifie ses 30 indices, pixels et dimensions aux temps demandés ; les PTS bruts du fichier ont été vérifiés séparément sur macOS.

Le premier catalogue complet de **59 workloads sur une répétition**, version `.3`, achevé à **15:40:56 UTC**, a produit **50 réussites, 2 timeouts, 3 limites de budget et 4 extensions indisponibles**. Le budget de 512 Mio a refusé le montage eager de tous les médias, huit clips 4K eager et trois clips 4K simultanés. Les extensions LUT/compute/Three.js/Core ML ne sont pas branchées. Les 55 cas actifs rendent à zéro les octets, réservations, codecs et buffers en vol suivis, sans erreur de fermeture ni état signalé dangereux. `benchmark/results/simulator-full-first.local.json` conserve ce résultat du build précédent, d'empreinte `4a087400…` ; il ne s'agit pas d'un full sans échec.

Les deux timeouts seek/scrub venaient du prédicat du harness, qui attendait une horloge fixe pendant la lecture. La version `.4` vérifie une horloge qui avance depuis le seek, un nouveau rendu, les items visibles et le changement d'identité native disponible. Après correction autorelease, **sept cas ciblés ont passé** entre **16:37:45 et 16:38:43 UTC** : les cinq du smoke et les deux seek/scrub, avec ressources suivies à zéro. `benchmark/results/simulator-functional-pooled.local.json` et `final-functional-source-pooled.local.json` conservent ce run et sa provenance `486b12a…` / bundle `eb434d2…`. Ce sont des réexécutions ciblées ; le full59 n'a pas été rejoué sur ce build.

Ces résultats confirment le comportement exécuté. La mesure actuelle sur **cinq cas, trois répétitions**, a passé **15/15 répétitions** entre **16:40:14 et 16:43:27 UTC**, avec **63 exports sondés**. Un diagnostic distinct a ensuite réussi **3/3 répétitions de 100 exports**, soit **300 fichiers sondés**, entre **16:44:32 et 16:47:41 UTC**. [PERFORMANCE_SIMULATOR.md](PERFORMANCE_SIMULATOR.md) conserve ces résultats et [PERFORMANCE_SIMULATOR_INITIAL.md](PERFORMANCE_SIMULATOR_INITIAL.md) les mesures antérieures et observations de repos. L'horloge enregistrée est `performance.now` et les relevés mémoire sont demandés toutes les **100 ms** ; ce collecteur ajoute son propre coût et peut manquer des pics entre deux relevés. Les ressources suivies reviennent à zéro, mais le RSS augmente après les exports alternés ; au repos après le long run, il redescend de 551,375 à 353,453 Mio, sans attribution ni palier démontré. Les validateurs pixels/audio du catalogue restent indisponibles. Aucun A/B, résultat d'iPhone ou palier mémoire à long terme n'est démontré.

Après une nouvelle exécution native, consigner le `.xcresult` affiché par le script :

```sh
node scripts/benchmark-record-ios-simulator-verification.mjs RESULT.xcresult
node scripts/benchmark-inventory.mjs
```

Le recorder refuse un résultat avec échec/skip, des noms XCTest manquants ou des sources modifiées après le début du build. Il ne relance pas le simulateur et ne transforme pas un ancien résultat en preuve des sources actuelles.

Les **quatorze fixtures communes réellement embarquées** et leur manifest ont été comparés aux sources : tailles et SHA-256 sont tous identiques. [fixture-bundle-verification.json](../benchmark/fixture-bundle-verification.json) conserve cette preuve du build Release du simulateur. La fixture JPEG 1279×719 réservée aux XCTest est distincte de ces quatorze médias du catalogue.

La stack réelle a identifié un accès à une SharedValue après transformation en worklet ; la fermeture liée à cette erreur a été corrigée, puis les réexécutions ont confirmé le montage et la restitution des réservations suivies. Le harness conserve `diagnostic` et `cleanupDiagnostic` séparément : opération, étape de montage, message et stack bornés. La cause d'origine survit à un échec secondaire de fermeture. Les 74 tests du harness incluent 17 régressions de validation du seek en lecture.

Les résultats sont dans **Documents/benchmark-results** du conteneur de l'application. Trouver le conteneur avec :

```sh
xcrun simctl get_app_container SIMULATOR_UDID com.seb.skiawebgpuvideo.test data
```

Conserver les JSON et les logs d'échec avant de réinstaller l'exemple. Les rapports bruts portant des identifiants d'appareil peuvent rester dans `benchmark/results/*.local.json`, ignorés par Git et absents du paquet publié.

Le simulateur vérifie le comportement de la bibliothèque sur le runtime iOS et le GPU du Mac. Il ne qualifie ni les codecs matériels de l'iPhone, ni sa consommation mémoire, thermique ou énergétique. Les tests physiques et le A/B restent une étape ultérieure ; aucun A/B n'est lancé dans la correction fonctionnelle actuelle.

Les quatre traces natives de création/fermeture sont désormais derrière `RNSV_TRACE_LIFECYCLE`, désactivé en Release. Les avertissements `unrecognised property keys` viennent du codec HEVC Apple du simulateur (`VCPHEVC.videocodec`), également dans les XCTest HEVC qui passent. Aucun patch JavaScript n'est justifié ; isoler ce bruit du codec si nécessaire lors des mesures et garder une instrumentation identique dans les deux builds pour un futur A/B.
