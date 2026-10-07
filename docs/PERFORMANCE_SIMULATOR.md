# Mesures du candidat sur simulateur iOS

Cette passe concerne la révision `486b12a…`, après activation des scopes autorelease synchrones. La [passe initiale](PERFORMANCE_SIMULATOR_INITIAL.md), son diagnostic long et ses observations au repos restent archivés séparément. Aucun gain statistique n'est déduit entre les deux passes, et le comparatif avec l'ancienne bibliothèque reste différé.

Mesures réelles du 2026-10-06T16:40:14.850Z au 2026-10-06T16:43:27.826Z, en Release sur simulateur iPhone19,2, iOS 27.0. Candidat 0.1.0-alpha.0, Skia 3.0.3, WebGPU 0.11.0, RN 0.86.2. Trois répétitions réussies pour chacun des cinq cas.

Horloge : performance.now. Écran déclaré : 60 Hz, PixelRatio 3. Conditions natives constantes : nominal / normal. Budget déclaré : 512 Mio. Workloads 2026-10-06.4.

Hôte vérifié : MacBookPro18,3, Apple M1 Pro, 16 Gio, macOS 27.0.1 (26A434). Source : sysctl hw.model/hw.memsize/machdep.cpu.brand_string and sw_vers.

Les tableaux donnent la médiane des trois répétitions et leur plage [min–max]. Ces mesures concernent uniquement le candidat sur le GPU et les codecs du Mac ; elles ne sont ni une comparaison A/B ni une qualification de performance sur iPhone.

## Lecture

| Cas | Callbacks de dessin/s | p95 CPU, borne supérieure (ms) | p95 espacement, borne supérieure (ms) | Callbacks / frames attendues manquantes par répétition |
| --- | --- | --- | --- | --- |
| single-h264-1080p30-audio.mp4 | 59.90 [59.57–59.92] | 0.25 [0.25–0.25] | 25.00 [25.00–25.00] | 228/0, 229/0, 229/0 |
| single-h264-4k30.mp4 | 59.92 [59.90–59.96] | 0.25 [0.25–0.25] | 25.00 [25.00–25.00] | 229/0, 229/0, 229/0 |
| single-hevc-4k30.mp4 | 59.85 [59.84–59.85] | 0.25 [0.25–0.25] | 33.33 [33.33–33.33] | 229/0, 229/0, 229/0 |

Preview : 720×720 pixels physiques. Le p95 est la borne supérieure du bucket d’histogramme, pas une valeur précise. La mesure dite CPU est la durée murale du callback de dessin et de son observation, y compris ses appels natifs et attentes éventuelles ; elle ne mesure pas une consommation CPU par profilage. Elle exclut une partie du décodage/import de frame et ne mesure pas la fin des commandes GPU. La cadence décrit des callbacks/s ; plusieurs callbacks peuvent redessiner la même frame vidéo. Le nombre de frames décodées/perdues et le temps GPU ne sont pas collectés.

## Export

| Cas | Dimensions / frames par fichier | Fichiers sondés | Pipeline export hors sonde (ms) | Sonde séparée (ms) |
| --- | --- | --- | --- | --- |
| encode-h264-copy | 640×360 / 60 | 3 | 244.34 [238.24–393.71] | 19.82 [18.33–20.59] |
| repeated-mixed-size-exports | 640×360 / 18 | 21 | 95.21 [93.94–95.34] | 10.36 [10.34–10.45] |
| repeated-mixed-size-exports | 1920×1080 / 18 | 21 | 233.40 [231.19–235.77] | 28.80 [28.49–28.96] |
| repeated-mixed-size-exports | 720×1280 / 18 | 18 | 135.81 [133.48–138.93] | 16.73 [16.60–16.83] |

63 fichiers ont été exportés puis sondés. Pour les tailles alternées, chaque répétition fournit d’abord sa médiane par taille ; le tableau résume ensuite ces trois médianes. Le chronomètre d’encodage comprend le pipeline export de la bibliothèque, sa préparation, le décodage, le rendu, la lecture CPU, l’encodeur et sa fermeture ; il exclut la sonde AVFoundation. Les métadonnées, nombres de frames, dimensions, codec et PTS exacts ont été vérifiés. Les validateurs de pixels/audio du catalogue restent indisponibles.

## Mémoire

| Cas | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS après fermeture (Mio) | Pic owned estimé (Mio) | Owned après fermeture (Mio) |
| --- | --- | --- | --- | --- | --- |
| single-h264-1080p30-audio.mp4 | 255.63 [189.84–259.14] | 364.19 [360.58–366.91] | 259.14 [255.63–261.83] | 67.24 [67.24–67.24] | 0.00 [0.00–0.00] |
| single-h264-4k30.mp4 | 262.38 [261.83–262.98] | 621.25 [620.47–623.45] | 262.98 [262.38–265.38] | 225.44 [225.44–225.44] | 0.00 [0.00–0.00] |
| single-hevc-4k30.mp4 | 244.91 [241.73–265.38] | 725.78 [722.89–739.83] | 244.59 [241.73–244.91] | 225.44 [225.44–225.44] | 0.00 [0.00–0.00] |
| encode-h264-copy | 296.55 [244.59–327.97] | 371.48 [324.44–381.13] | 327.97 [296.55–338.72] | 7.89 [7.02–8.76] | 0.00 [0.00–0.00] |
| repeated-mixed-size-exports | 444.88 [338.72–502.45] | 787.50 [698.47–840.83] | 502.45 [444.88–574.17] | 50.95 [50.95–50.95] | 0.00 [0.00–0.00] |

Les exports alternés présentent une croissance du RSS à expliquer : 444.88 → 502.45 → 574.17 Mio après fermeture des trois répétitions, depuis 338.72 Mio avant la première. Les réservations suivies reviennent à zéro, mais aucun palier du processus n'est démontré. Une session prolongée avec attribution des allocations est nécessaire pour distinguer caches persistants et fuite ; cette passe ne permet pas de trancher.

Le budget vidéo suivi n’inclut pas les budgets de cache Graphite : les headers livrés de Skia 3.0.3 définissent par défaut 256 Mio par Recorder et 256 Mio pour le Context. Ces budgets ne sont ni des allocations permanentes mesurées ni une attribution de ce RSS. [UPSTREAM_NOTES.md](UPSTREAM_NOTES.md) conserve les références et le point futur d’inspection/configuration amont. La bibliothèque ne purge pas globalement Graphite et ne modifie pas le device partagé de l’application.

RSS : resident_size par mach task_info, à l’échelle du processus. Owned : estimations des réservations de la bibliothèque. Tous les cas terminent avec zéro octet/réservation/décodeur/buffer en vol suivi. Les pics sont seulement ceux des échantillons disponibles ; une allocation brève entre deux relevés peut être absente. La fermeture attend le démontage et un délai de stabilisation ; aucun fence GPU général n’est fourni par le harness. Le RSS comprend les caches et allocations opaques des codecs/pilotes ; zéro owned ne prouve pas une absence de fuite.

La mémoire est échantillonnée toutes les 100 ms demandées ; les relevés natifs asynchrones peuvent arriver plus tard. Ce collecteur plus fréquent ajoute son propre coût, identique dans les répétitions de cette passe. La mémoire GPU totale, le heap natif et le heap JavaScript ne sont pas collectés. Les répétitions partagent un processus : les caches des cas antérieurs influencent le RSS et l’ordre des cas est conservé. Aucun palier de mémoire physique à long terme ni gain par rapport à la référence n’est démontré.

Les traces de création/fermeture de la bibliothèque sont désactivées en Release avec RNSV_TRACE_LIFECYCLE. Des traces système du codec HEVC Apple du simulateur peuvent subsister ; elles ne viennent pas du code JavaScript.

## Preuves

- simulator-performance-pooled.local.json — SHA-256 85bd8b3d78fc9a5ae35fbda6418b664aba27915846f673b25c480e15ceec8626.
- performance-host.local.json — SHA-256 4ff6a17dfbbe93dbe4de556c33b56b970c1f4787f01d088dca6dd1829e36f69b.
- final-functional-source-pooled.local.json — SHA-256 108be2c3032d9d073c9136109002e5550f6c02907aa6f3dc69eda81ab9eca55c.

Provenance consignée avant le run : fingerprint de production 486b12a722d317dd6bc5db720c1bb63e31c4ede7a2c07b5d19fa83422c1e78e8, SHA-256 main.jsbundle eb434d2ac98eb0246a25a7a05256f409caaf4ccfc484399c11f1653cd94ba878, SHA-256 exécutable 0f9ceb1b115ed08f0156fcf3e2dde2f35a93c773bc3a8f6b826e90459d71e966. Le fichier de provenance conserve également les hashes App/harness.

Les JSON bruts restent dans benchmark/results/*.local.json, ignorés par Git. Les identifiants privés d’appareil ne sont pas reproduits ici.

## Diagnostic long séparé des mesures initiales

Run distinct du 2026-10-06T16:44:32.449Z au 2026-10-06T16:47:41.140Z, 300 fichiers exportés/sondés sur trois répétitions. Ce run ne remplace ni ne fusionne les quinze répétitions des tableaux précédents. Les mêmes contrôles de Release/horloge/conditions/collecteurs, de séquence des tailles et de métadonnées/PTS sont appliqués.

| Répétition | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS final après fermeture (Mio) | Owned final / réservations / décodeurs / buffers en vol |
| --- | --- | --- | --- | --- |
| 1 | 199.45 | 695.64 | 418.58 | 0 / 0 / 0 / 0 |
| 2 | 418.69 | 821.84 | 553.73 | 0 / 0 / 0 / 0 |
| 3 | 554.06 | 877.48 | 627.16 | 0 / 0 / 0 / 0 |

Sur ces répétitions, le RSS final augmente ; une croissance reste à expliquer. Ce constat se limite à ce run. Ces valeurs restent des relevés du processus, demandés après un délai de stabilisation, sans attribution native/GPU exhaustive. Elles ne prouvent ni la libération de toutes les allocations opaques ni une absence de fuite à long terme.

Aucune attribution de heap/GPU n'est fournie par ce rapport. Les temps de ce diagnostic ne constituent pas une nouvelle mesure comparative de performance.

Preuve locale : simulator-mixed-soak-pooled.local.json — SHA-256 eb71a035d28b0edd507b48ce6eddf49a2d7836ec8bd73bc96ff050910dfe5e65.

## Repos observé après le diagnostic long

Lectures RSS par ps du même processus au repos :

- 551.375 Mio, à 05:40 de durée de vie du processus, dans la fenêtre du 2026-10-06 16:50:08 UTC au 2026-10-06 16:50:11 UTC.
- 353.453 Mio, à 08:42 de durée de vie du processus, dans la fenêtre du 2026-10-06 16:53:09 UTC au 2026-10-06 16:53:13 UTC.

Ces relevés sont distincts des points settled après fermeture. Ils décrivent le RSS du processus à ces instants, sans identifier le heap, le GC ou le GPU responsables de sa variation. Ils ne démontrent ni un palier stable ni une absence de fuite à long terme.

Preuve locale : mixed-soak-pooled-idle-observations.local.json — SHA-256 17c45ab84e114cdb26a68128d3b08a4d41c913391481ac375b41a9b4e4a6a2ac.
