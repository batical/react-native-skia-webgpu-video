# Endurance d’export sur iPhone — Skia 3.0.3

Le candidat a terminé **3/3 répétitions de 100 exports**, avec **300 fichiers sondés**, du 2026-10-07T08:03:12.123Z au 2026-10-07T08:06:20.428Z. La mémoire du processus augmente entre les répétitions ; le collecteur de repos a ensuite dépassé son délai sans relevés. Aucun palier stable ni absence de fuite n’est démontré. La référence a subi un crash natif avant de produire son JSON : aucune comparaison chiffrée d’endurance n’est disponible.

Cible physique : iPhone 15 Pro (iPhone16,1), iOS 27.0.1, RN 0.86.2, Release. Candidat 0.1.0-alpha.0, Skia 3.0.3 / WebGPU 0.11.0, workload 2026-10-07.1, profil soak. Un seul processus a exécuté les trois blocs ; aucun relevé de repos associé n’a été obtenu. Budget vidéo suivi : 512 Mio ; ce n’est pas un plafond de mémoire totale.

Source H.264 638×358, compositions de 0,6 s. Tailles alternées : 640×360 (102 fichiers), 1920×1080 (99), 720×1280 (99). Chaque fichier contient **18 frames H.264 à 30 fps**, de 0 à 17/30 s. Les dimensions, codec, compte, durée, rotation et timestamps monotones/exacts ont été revérifiés pour les 300 sondes. Cela ne remplace pas une validation visuelle/colorimétrique des pixels.

## Mémoire par répétition

| Bloc | Statut / fichiers sondés | RSS initial / pic / final (Mio) | Empreinte physique initiale / pic / finale (Mio) | Owned / réservations / décodeurs / buffers en vol finaux |
| --- | --- | --- | --- | --- |
| 1 | passed / 100 | 52.53 / 246.48 / 193.66 | 22.02 / 284.60 / 192.94 | 0 / 0 / 0 / 0 |
| 2 | passed / 100 | 193.66 / 349.47 / 330.97 | 192.94 / 385.41 / 326.56 | 0 / 0 / 0 / 0 |
| 3 | passed / 100 | 330.97 / 444.89 / 408.53 | 326.56 / 477.02 / 402.03 | 0 / 0 / 0 / 0 |

Collecte demandée toutes les 100 ms, 1723 relevés, aucun relevé tronqué. Conditions : 1528 nominal, 195 fair ; tous les relevés sont au premier plan et en alimentation normale. L’état thermique devient fair pendant le dernier bloc : les durées de ce diagnostic ne constituent pas une performance thermique nominale ni un A/B.

RSS : mach task_info resident_size. Empreinte physique : task_vm_info phys_footprint. Ce sont deux mesures distinctes du processus entier, pas la mémoire de cette bibliothèque seule ; elles ne s’additionnent pas. Les pics sont échantillonnés et peuvent manquer une allocation brève. Les fins suivent le délai de stabilisation prévu, sans preuve de libération de tous les caches. Le retour des réservations suivies à zéro ne permet pas d’attribuer le RSS ou l’empreinte au heap, au GC ou au GPU. La mémoire GPU totale et le heap natif séparé ne sont pas mesurés.

## Repos demandé : collecteur en échec

Le run demandait 180 s de relevés natifs au repos, mais aucun fichier de repos n’a été obtenu avant le délai du runner. Le journal final conserve **failed** et **Native idle collector did not finish before its deadline**, terminé à 2026-10-07T08:11:30.431Z. Le runner a ensuite arrêté son application de test (stoppedAfterFailure: true). Les 300 sondes déjà enregistrées restent valides ; le statut global de l’expérience, incluant le repos, reste en échec.

Ce délai dépassé concerne le collecteur de repos : il ne constitue ni un crash natif observé, ni une preuve de palier, ni une mesure mémoire à 180 s. Aucun zéro, courbe de repos ou pourcentage n’est substitué aux valeurs absentes. La demande ultérieure de passer à Skia 3.0.6 explique l’absence de nouvelle investigation ou réexécution de ce test 3.0.3 ; elle n’est pas la cause du timeout déjà enregistré.

## Crash de la référence

La référence Skia 2.10.1 a subi un **SIGTRAP / EXC_BREAKPOINT** à 2026-10-07T08:01:30.9561Z, dans **GrResourceCache::removeResource(GrGpuResource*)**, pendant la destruction d’une surface Ganesh sur le thread GC **hades**. Le PID, le bundle, le conteneur d’exécutable et l’UUID binaire ont été rapprochés des preuves de ce run. Aucun JSON de benchmark ni relevé de repos comparable n’a été émis. Le nom d’un fichier restant suggère la 68e demande d’export du premier bloc ; ce n’est pas un compte d’exports réussis ou vérifiés.

La cause précise de l’invariant Ganesh violé reste inconnue. Ce crash n’est ni une preuve de fuite ni une terminaison Jetsam, et ne justifie aucun nombre mémoire ou pourcentage d’amélioration inventé. Le fork historique reste inchangé. Les huit cas du [comparatif physique court](PERFORMANCE_AB_IPHONE_303.md) et les résultats du simulateur restent des expériences distinctes.

## Traçabilité

Exécutable candidat SHA-256 : b829983937bb0a1e092a40c78ab2b9e4753af72aee86c6007ffeae1698aa2d38. Bundle JavaScript SHA-256 : a967d60fb422ca6b307df0be19c3fafe3ec66187ec9c95c73bfc3f0038a7506a. Ces deux identités concordent avec celles des deux passages candidats du comparatif court. Le manifest et les hashes des 14 fixtures embarquées ont été vérifiés contre ceux du résultat.

- iphone-soak-candidate-303.local.json — SHA-256 ab4d191346800fc6f87085e723155b42d42aa9d0c475d96e5bab1518f73ab617.
- iphone-soak-candidate-303-execution.local.json — SHA-256 8e4f538bd94136ff3112b753fb380b35e7d4cce9bc41a28ef07038cbbb5bd20e.
- iphone-soak-baseline-303-crash-analysis.local.json — SHA-256 79c10f971cfcfec404eb8d29001e2b782e99dff08078f4cf26694fb57ef9c024.

Les JSON originaux et leurs identités privées restent dans benchmark/results/*.local.json, ignorés par Git. Les valeurs de PID, runId, UDID et les chemins du conteneur ne sont pas reproduits ici. Les résultats concernent exclusivement Skia 3.0.3 / WebGPU 0.11.0 ; le brouillon isolé de migration vers Skia 3.0.6 / WebGPU 0.12.1 n’est pas qualifié par cette passe.
