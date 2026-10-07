# Mesures du candidat sur simulateur iOS

Cette passe initiale concerne la révision `621c20f…`, avant la correction des pools autorelease sur les appels synchrones du thread Worklets. Elle est conservée comme historique ; les nouvelles preuves de la révision `486b12a…` figurent dans [PERFORMANCE_SIMULATOR.md](PERFORMANCE_SIMULATOR.md). Les tableaux de ces quinze répétitions restent inchangés, et les diagnostics de 300 exports et de repos sont présentés séparément. Aucun gain statistique n'est déduit entre les passes.

Mesures réelles du 2026-10-06T16:16:28.332Z au 2026-10-06T16:19:41.747Z, en Release sur simulateur iPhone19,2, iOS 27.0. Candidat 0.1.0-alpha.0, Skia 3.0.3, WebGPU 0.11.0, RN 0.86.2. Trois répétitions réussies pour chacun des cinq cas.

Horloge : performance.now. Écran déclaré : 60 Hz, PixelRatio 3. Conditions natives constantes : nominal / normal. Budget déclaré : 512 Mio. Workloads 2026-10-06.4.

Hôte vérifié : MacBookPro18,3, Apple M1 Pro, 16 Gio, macOS 27.0.1 (26A434). Source : sysctl hw.model/hw.memsize/machdep.cpu.brand_string and sw_vers.

Les tableaux donnent la médiane des trois répétitions et leur plage [min–max]. Ces mesures concernent uniquement le candidat sur le GPU et les codecs du Mac ; elles ne sont ni une comparaison A/B ni une qualification de performance sur iPhone.

## Lecture

| Cas | Callbacks de dessin/s | p95 CPU, borne supérieure (ms) | p95 espacement, borne supérieure (ms) | Callbacks / frames attendues manquantes par répétition |
| --- | --- | --- | --- | --- |
| single-h264-1080p30-audio.mp4 | 59.93 [59.90–59.96] | 0.25 [0.25–0.25] | 25.00 [25.00–25.00] | 229/0, 229/0, 229/0 |
| single-h264-4k30.mp4 | 59.87 [59.85–59.90] | 0.25 [0.25–0.25] | 25.00 [25.00–25.00] | 229/0, 229/0, 228/0 |
| single-hevc-4k30.mp4 | 59.85 [59.82–59.86] | 0.25 [0.25–0.25] | 33.33 [25.00–33.33] | 229/0, 229/0, 229/0 |

Preview : 720×720 pixels physiques. Le p95 est la borne supérieure du bucket d’histogramme, pas une valeur précise. La mesure dite CPU est la durée murale du callback de dessin et de son observation, y compris ses appels natifs et attentes éventuelles ; elle ne mesure pas une consommation CPU par profilage. Elle exclut une partie du décodage/import de frame et ne mesure pas la fin des commandes GPU. La cadence décrit des callbacks/s ; plusieurs callbacks peuvent redessiner la même frame vidéo. Le nombre de frames décodées/perdues et le temps GPU ne sont pas collectés.

## Export

| Cas | Dimensions / frames par fichier | Fichiers sondés | Pipeline export hors sonde (ms) | Sonde séparée (ms) |
| --- | --- | --- | --- | --- |
| encode-h264-copy | 640×360 / 60 | 3 | 265.39 [249.91–630.34] | 19.97 [19.78–20.05] |
| repeated-mixed-size-exports | 640×360 / 18 | 21 | 93.69 [89.86–97.25] | 10.24 [10.16–10.52] |
| repeated-mixed-size-exports | 1920×1080 / 18 | 21 | 229.07 [226.93–236.51] | 29.15 [29.12–30.19] |
| repeated-mixed-size-exports | 720×1280 / 18 | 18 | 136.40 [135.55–138.14] | 16.80 [16.67–16.92] |

63 fichiers ont été exportés puis sondés. Pour les tailles alternées, chaque répétition fournit d’abord sa médiane par taille ; le tableau résume ensuite ces trois médianes. Le chronomètre d’encodage comprend le pipeline export de la bibliothèque, sa préparation, le décodage, le rendu, la lecture CPU, l’encodeur et sa fermeture ; il exclut la sonde AVFoundation. Les métadonnées, nombres de frames, dimensions, codec et PTS exacts ont été vérifiés. Les validateurs de pixels/audio du catalogue restent indisponibles.

## Mémoire

Le budget vidéo suivi n'inclut pas les budgets de cache Graphite : Skia 3.0.3 configure par défaut 256 Mio par Recorder et 256 Mio pour le Context. Ce sont des budgets de cache, pas des allocations permanentes mesurées ni une attribution de ce RSS. [UPSTREAM_NOTES.md](UPSTREAM_NOTES.md) conserve les références exactes et le point futur d'inspection/configuration amont ; la bibliothèque ne purge pas les caches ni ne modifie le device partagé de l'application.

| Cas | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS après fermeture (Mio) | Pic owned estimé (Mio) | Owned après fermeture (Mio) |
| --- | --- | --- | --- | --- | --- |
| single-h264-1080p30-audio.mp4 | 189.20 [148.80–220.72] | 342.69 [267.63–360.78] | 148.80 [143.08–220.69] | 67.24 [67.24–67.24] | 0.00 [0.00–0.00] |
| single-h264-4k30.mp4 | 157.61 [143.08–158.88] | 516.95 [515.61–519.39] | 158.88 [157.61–161.30] | 225.44 [225.44–225.44] | 0.00 [0.00–0.00] |
| single-hevc-4k30.mp4 | 147.02 [144.00–161.30] | 629.58 [628.33–635.64] | 147.02 [144.00–148.91] | 225.44 [225.44–225.44] | 0.00 [0.00–0.00] |
| encode-h264-copy | 219.02 [148.91–253.78] | 293.27 [256.61–305.23] | 253.78 [219.02–264.00] | 8.76 [8.76–8.76] | 0.00 [0.00–0.00] |
| repeated-mixed-size-exports | 386.39 [264.00–446.31] | 699.81 [632.23–792.03] | 446.30 [386.39–527.16] | 50.95 [50.95–50.95] | 0.00 [0.00–0.00] |

Les exports alternés présentent une croissance du RSS à expliquer : 386.39 → 446.30 → 527.16 Mio après fermeture des trois répétitions, depuis 264.00 Mio avant la première. Les réservations suivies reviennent à zéro, mais aucun palier du processus n'est démontré. Une session prolongée avec attribution des allocations est nécessaire pour distinguer caches persistants et fuite ; cette passe ne permet pas de trancher.

RSS : resident_size par mach task_info, à l’échelle du processus. Owned : estimations des réservations de la bibliothèque. Tous les cas terminent avec zéro octet/réservation/décodeur/buffer en vol suivi. Les pics sont seulement ceux des échantillons disponibles ; une allocation brève entre deux relevés peut être absente. La fermeture attend le démontage et un délai de stabilisation ; aucun fence GPU général n’est fourni par le harness. Le RSS comprend les caches et allocations opaques des codecs/pilotes ; zéro owned ne prouve pas une absence de fuite.

La mémoire est échantillonnée toutes les 100 ms demandées ; les relevés natifs asynchrones peuvent arriver plus tard. Ce collecteur plus fréquent ajoute son propre coût, identique dans les répétitions de cette passe. La mémoire GPU totale, le heap natif et le heap JavaScript ne sont pas collectés. Les répétitions partagent un processus : les caches des cas antérieurs influencent le RSS et l’ordre des cas est conservé. Aucun palier de mémoire physique à long terme ni gain par rapport à la référence n’est démontré.

Les traces de création/fermeture de la bibliothèque sont désactivées en Release avec RNSV_TRACE_LIFECYCLE. Des traces système du codec HEVC Apple du simulateur peuvent subsister ; elles ne viennent pas du code JavaScript.

## Preuves

- simulator-performance.local.json — SHA-256 8217d099ae301a0f31227f10ee85492e69668c88ecdf1ad6442a89e766261e83.
- performance-host.local.json — SHA-256 4ff6a17dfbbe93dbe4de556c33b56b970c1f4787f01d088dca6dd1829e36f69b.
- final-functional-source.local.json — SHA-256 a85a154a74b198568a775438c2411f7264b400b446d5e8a60ea7b2aba061bbe9.

Provenance consignée avant le run : fingerprint de production 621c20f63ff056996abd2beb22e107527ae3bbe4259252380680ff30eeeafd7c, SHA-256 main.jsbundle 5883d967064c8de054199e87df1567942bfa335f867a528daf4cbf3f2061cfe2, SHA-256 exécutable 0f9ceb1b115ed08f0156fcf3e2dde2f35a93c773bc3a8f6b826e90459d71e966. Le fichier de provenance conserve également les hashes App/harness.

Les JSON bruts restent dans benchmark/results/*.local.json, ignorés par Git. Les identifiants privés d’appareil ne sont pas reproduits ici.

## Diagnostic long séparé des mesures initiales

Ce run a redémarré l'application. Une tentative vmmap pendant ce diagnostic a été bloquée puis annulée ; aucune catégorie de heap n'a été collectée. Ses durées ne constituent pas une mesure comparative de performance.

Run distinct du 2026-10-06T16:23:51.771Z au 2026-10-06T16:28:01.091Z, 300 fichiers exportés/sondés sur trois répétitions. Ce run ne remplace ni ne fusionne les quinze répétitions des tableaux précédents. Les mêmes contrôles de Release/horloge/conditions/collecteurs, de séquence des tailles et de métadonnées/PTS sont appliqués.

| Répétition | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS final après fermeture (Mio) | Owned final / réservations / décodeurs / buffers en vol |
| --- | --- | --- | --- | --- |
| 1 | 197.06 | 716.56 | 350.38 | 0 / 0 / 0 / 0 |
| 2 | 350.41 | 679.52 | 317.23 | 0 / 0 / 0 / 0 |
| 3 | 317.61 | 703.64 | 294.20 | 0 / 0 / 0 / 0 |

Sur ces répétitions, le RSS final diminue ; aucune croissance continue n'est observée. Ce constat se limite à ce run. Ces valeurs restent des relevés du processus, demandés après un délai de stabilisation, sans attribution native/GPU exhaustive. Elles ne prouvent ni la libération de toutes les allocations opaques ni une absence de fuite à long terme.

Aucune attribution de heap/GPU n'est fournie par ce rapport. Les temps de ce diagnostic ne constituent pas une nouvelle mesure comparative de performance.

Preuve locale : simulator-mixed-soak.local.json — SHA-256 2aefd9cd36d2422d1e76a2165520194159dcaa04d1b26037f7269e33eb8b289c.

## Repos observé après le run initial

Le même processus est resté au repos entre deux lectures RSS par ps : 354.375 Mio à 343 s de durée de vie du processus ; 354.375 Mio à 409 s de durée de vie du processus. Les heures murales exactes de ces lectures n'ont pas été capturées ; le recordedAt du JSON correspond à leur consignation, pas à chaque mesure.

Ces relevés sont distincts des points settled après deux secondes et de leur collecteur mach task_info. Ils montrent que le RSS du processus a baissé au repos ; ils n'attribuent pas cette baisse au heap, au GC ou au GPU, et ne prouvent aucune libération précise de buffer.

Preuve locale : performance-idle-observations.local.json — SHA-256 b7ef37a9ddac4a4e4018a1bd30313b060e4eb06940952c499dc8096276eb2302.

## Repos observé après le diagnostic de 300 exports

Lecture RSS par ps du même processus au repos : 85.234 Mio, à 09:02 de durée de vie du processus, dans la fenêtre du 2026-10-06 16:32:49 UTC au 2026-10-06 16:32:52 UTC.

Le RSS du scénario est redescendu après un repos plus long : aucune rétention RSS permanente n'est détectée dans cette observation. Cela n'identifie ni le heap, ni le GC, ni le GPU responsables de cette baisse, et ne constitue pas une preuve d'absence de fuite dans tous les scénarios ou à long terme.

Preuve locale : mixed-soak-idle-observations.local.json — SHA-256 9399bfa3bdfcf9a9a1d23d8b3614b5bd612a3a03c37675096e884222d4a5d4c0.
