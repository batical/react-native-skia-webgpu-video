#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildCases } from '../benchmark/cases.mjs';
import { validateFixtureManifest } from '../benchmark/fixtures.mjs';

export const PERFORMANCE_CASES = [
  'single-h264-1080p30-audio.mp4', 'single-h264-4k30.mp4',
  'single-hevc-4k30.mp4', 'encode-h264-copy', 'repeated-mixed-size-exports',
];
const timing = 'draw callback CPU time / callback spacing; GPU completion is separate';
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
};
const aggregate = (values) => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });
const same = (values, label) => check(new Set(values.map((value) => JSON.stringify(value))).size === 1, `${label} differ between repetitions/reports`);
const envIdentity = (report) => {
  const env = report.environment;
  for (const key of ['deviceId', 'deviceModel', 'platform', 'osVersion', 'reactNativeVersion',
    'buildMode', 'executionTarget', 'measurementClock', 'pixelRatio', 'displayRefreshRate', 'thermalState', 'powerMode'])
    check(env?.[key] != null, `Missing environment.${key}`);
  check(env.executionTarget === 'simulator' && env.platform === 'ios' && env.buildMode === 'release', 'Only iOS Simulator Release results are accepted');
  check(env.measurementClock === 'performance.now', 'Explicit performance.now measurement clock is required');
  check(finite(env.pixelRatio) && env.pixelRatio > 0 && finite(env.displayRefreshRate) && env.displayRefreshRate > 0, 'Invalid display metadata');
  check(['nominal', 'fair', 'serious', 'critical'].includes(env.thermalState) && ['normal', 'low-power'].includes(env.powerMode), 'Unknown operating conditions');
  return env;
};

export function histogramP95Upper(histogram) {
  check(Array.isArray(histogram?.bounds) && Array.isArray(histogram?.counts) &&
    histogram.counts.length === histogram.bounds.length + 1 && histogram.bounds.length > 0, 'Malformed timing histogram');
  check(histogram.bounds.every((value, index) => finite(value) && value > 0 && (!index || value > histogram.bounds[index - 1])), 'Invalid histogram bounds');
  check(histogram.counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    Number.isSafeInteger(histogram.total) && histogram.total > 0 &&
    histogram.counts.reduce((sum, count) => sum + count, 0) === histogram.total &&
    finite(histogram.maxMs) && finite(histogram.sumMs), 'Invalid histogram totals');
  const target = Math.ceil(histogram.total * 0.95);
  let count = 0;
  for (let index = 0; index < histogram.counts.length; index++) {
    count += histogram.counts[index];
    if (count >= target) return histogram.bounds[index] ?? histogram.maxMs;
  }
  throw new Error('Missing histogram percentile');
}

const reading = (point, field) => {
  const value = point.memory?.[field];
  check(finite(value?.value) && typeof value.source === 'string' && value.source, `Missing ${field} collector`);
  return value;
};
function memorySummary(entry, environment) {
  check(Array.isArray(entry.memorySamples) && entry.memorySamples.length >= 2, `${entry.id}: insufficient memory samples`);
  check(entry.collection?.memorySamplesDropped === 0, `${entry.id}: truncated memory telemetry`);
  const points = entry.memorySamples;
  check(points.some((point) => point.phase === 'running') && points.some((point) => point.phase === 'settled'), `${entry.id}: missing memory phase`);
  for (const point of points) {
    check(finite(point.elapsedMs) && finite(point.collectedAtElapsedMs) && point.collectedAtElapsedMs >= point.elapsedMs, `${entry.id}: invalid memory timestamps`);
    const conditions = point.operatingConditions;
    check(conditions?.thermalState === environment.thermalState && conditions.powerMode === environment.powerMode &&
      typeof conditions.source === 'string' && conditions.source, `${entry.id}: missing or changed operating conditions`);
  }
  const summary = {};
  for (const field of ['rssBytes', 'ownedBytes']) {
    const readings = points.map((point) => reading(point, field));
    same(readings.map((value) => value.source), `${entry.id}: ${field} collector sources`);
    const settled = points.filter((point) => point.phase === 'settled').sort((a, b) => a.elapsedMs - b.elapsedMs).at(-1);
    summary[field] = { initial: readings[0].value,
      sampledPeak: Math.max(...readings.map((value) => value.value)),
      finalSettled: reading(settled, field).value, source: readings[0].source };
  }
  const final = points.filter((point) => point.phase === 'settled').sort((a, b) => a.elapsedMs - b.elapsedMs).at(-1);
  summary.finalCounters = Object.fromEntries(['ownedResources', 'decoderCount', 'inFlightFrames'].map((field) => [field, reading(final, field).value]));
  check(summary.ownedBytes.finalSettled === 0 && Object.values(summary.finalCounters).every((value) => value === 0), `${entry.id}: tracked resources did not return to zero`);
  summary.unavailable = Object.fromEntries(['nativeHeapBytes', 'gpuBytes'].map((field) => {
    check(points.every((point) => point.memory?.[field]?.value == null), `${field} collector unexpectedly present; adapt this summary before reporting it`);
    return [field, [...new Set(points.map((point) => point.memory?.[field]?.reason ?? 'No collector attached'))]];
  }));
  return summary;
}

function exportSummary(outcome, requested, duration, label) {
  check(finite(outcome.encodeMs) && outcome.encodeMs > 0 && finite(outcome.probeMs), `${label}: missing separate encode/probe times`);
  const actual = outcome.actualOutput;
  const frames = Math.ceil(duration * requested.frameRate - 1e-9);
  check(actual?.width === requested.width && actual.height === requested.height && actual.fps === requested.frameRate &&
    actual.codec === requested.codec && actual.frameCount === frames && actual.presentationTimesExact === true && actual.timestampsMonotonic === true &&
    finite(actual.duration) && Math.abs(actual.duration - frames / requested.frameRate) < 1e-4 &&
    Math.abs(actual.firstPresentationTime) < 1e-6 && Math.abs(actual.lastPresentationTime - (frames - 1) / requested.frameRate) < 1e-4,
  `${label}: output probe disagrees with requested frames/dimensions/codec/PTS`);
  return { width: requested.width, height: requested.height, frames, encodeMs: outcome.encodeMs,
    probeMs: outcome.probeMs, totalExportAndProbeMs: outcome.exportMs ?? outcome.durationMs,
    codec: actual.codec, fps: actual.fps, presentationTimesExact: true };
}

export function summarizePerformance(reports, { onlyMixedDiagnostic = false } = {}) {
  check(Array.isArray(reports) && reports.length > 0, 'At least one result is required');
  const environments = reports.map(envIdentity);
  same(environments, 'Environment, simulator identity, clock or conditions');
  same(reports.map((report) => ({ schema: report.schema, workloadVersion: report.workloadVersion,
    seed: report.seed, backend: report.backend, fixtures: report.fixtureManifest, budget: report.memoryBudget })), 'Backend/workload/fixtures/budget');
  for (const report of reports) {
    check(report.schema === 1 && report.repetitions === 3 && typeof report.workloadVersion === 'string' &&
      report.startedAt && report.finishedAt && Date.parse(report.finishedAt) > Date.parse(report.startedAt), 'Complete three-repetition result required');
    check(report.memoryBudget?.applied === true && finite(report.memoryBudget.reportedMaxBytes) &&
      report.memoryBudget.reportedMaxBytes === report.memoryBudget.requestedMaxBytes, 'Explicit applied memory budget required');
    check(Array.isArray(report.cases) && Array.isArray(report.caseCatalog), 'Missing case results or catalog');
  }
  const all = reports.flatMap((report) => report.cases);
  const expectedCases = onlyMixedDiagnostic ? ['repeated-mixed-size-exports'] : PERFORMANCE_CASES;
  check(all.length === expectedCases.length * 3 && all.every((entry) => expectedCases.includes(entry.id)), 'Expected exactly the requested cases, three repetitions each');
  check(all.every((entry) => finite(entry.collection?.periodMs) && entry.collection.periodMs > 0), 'Recorded memory sampling period is required');
  same(all.map((entry) => entry.collection.periodMs), 'Memory sampling periods');
  const environment = environments[0];
  const cases = expectedCases.map((id) => {
    const entries = all.filter((entry) => entry.id === id).sort((a, b) => a.repetition - b.repetition);
    check(entries.length === 3 && entries.every((entry, index) => entry.repetition === index && entry.status === 'passed' &&
      !entry.cleanupError && !entry.unsafeToContinue), `${id}: three distinct passed repetitions with successful cleanup are required`);
    same(entries.map((entry) => entry.actualPaths), `${id}: actual transport paths`);
    same(entries.map((entry) => entry.operations.map((operation) => operation.operation)), `${id}: operations`);
    const catalogs = reports.flatMap((report) => report.caseCatalog.filter((scenario) => scenario.id === id));
    check(catalogs.length > 0, `${id}: missing scenario`);
    same(catalogs, `${id}: scenarios`);
    const scenario = catalogs[0];
    validateFixtureManifest(reports[0].fixtureManifest, scenario.composition.items.map((item) => item.fixture));
    for (const entry of entries) {
      check(entry.collection?.frameTiming === timing, `${id}: changed or missing timing definition`);
      check(!entry.validations?.some((validation) => validation.status === 'failed'), `${id}: failed media validation`);
      same([entry.operations.map((operation) => operation.operation), scenario.operations], `${id}: measured/catalog operations`);
    }
    const memory = entries.map((entry) => memorySummary(entry, environment));
    for (const field of ['rssBytes', 'ownedBytes']) same(memory.map((value) => value[field].source), `${id}: ${field} collector across repetitions`);
    const perf = entries.map((entry) => entry.operations.filter((operation) => operation.operation === 'perf'));
    let playback = null;
    if (perf.some((operations) => operations.length)) {
      check(perf.every((operations) => operations.length === 1), `${id}: missing or repeated playback measurement`);
      const measurements = perf.map(([operation], index) => {
        const preview = entries[index].collection.preview;
        check(preview?.resolutionUnit === 'physical-pixels' && preview.pixelRatio === environment.pixelRatio &&
          preview.actualPixelWidth === scenario.preview.width && preview.actualPixelHeight === scenario.preview.height &&
          preview.requestedPixelWidth === scenario.preview.width && preview.requestedPixelHeight === scenario.preview.height,
        `${id}: actual physical preview dimensions unavailable or changed`);
        check(finite(operation.durationMs) && operation.durationMs > 0 && Number.isSafeInteger(operation.draws) && operation.draws > 0 &&
          operation.drawHistogram?.total === operation.draws && operation.callbackGapHistogram?.total === operation.draws - 1 &&
          Number.isSafeInteger(operation.missingFrames) && operation.missingFrames >= 0 && operation.gpuTimeMs == null, `${id}: invalid playback telemetry`);
        return { callbacksPerSecond: operation.draws * 1000 / operation.durationMs,
          cpuP95UpperMs: histogramP95Upper(operation.drawHistogram), gapP95UpperMs: histogramP95Upper(operation.callbackGapHistogram),
          callbacks: operation.draws, missingFrames: operation.missingFrames };
      });
      same(perf.map(([operation]) => operation.drawHistogram.bounds), `${id}: CPU histogram bounds`);
      same(perf.map(([operation]) => operation.callbackGapHistogram.bounds), `${id}: spacing histogram bounds`);
      playback = { measurements, callbacksPerSecond: aggregate(measurements.map((value) => value.callbacksPerSecond)),
        cpuP95UpperMs: aggregate(measurements.map((value) => value.cpuP95UpperMs)),
        gapP95UpperMs: aggregate(measurements.map((value) => value.gapP95UpperMs)),
        width: scenario.preview.width, height: scenario.preview.height };
    }
    const exportRepetitions = entries.map((entry) => entry.operations.flatMap((operation) => {
      if (operation.operation === 'export') {
        same([operation.requestedOutput, scenario.output], `${id}: requested/catalog export`);
        return [exportSummary(operation, scenario.output, scenario.composition.duration, id)];
      }
      if (operation.operation === 'mixed-exports') {
        check(operation.exports?.length === scenario.exportCycles, `${id}: missing mixed exports`);
        return operation.exports.map((outcome, index) => {
          const requested = { ...scenario.output, ...[{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 720, height: 1280 }][index % 3] };
          same([outcome.output, requested], `${id}: mixed export/catalog size sequence`);
          return exportSummary(outcome, requested, scenario.composition.duration, id);
        });
      }
      return [];
    }));
    same(exportRepetitions.map((outcomes) => outcomes.map((value) => [value.width, value.height, value.frames, value.codec, value.fps])), `${id}: export sequences`);
    const dimensions = [...new Set(exportRepetitions[0].map((outcome) => `${outcome.width}×${outcome.height}`))];
    const exports = dimensions.map((dimension) => {
      const selected = exportRepetitions.map((outcomes) => outcomes.filter((value) => `${value.width}×${value.height}` === dimension));
      return { dimension, framesPerExport: selected[0][0].frames, sampleCount: selected.reduce((sum, values) => sum + values.length, 0),
        encodeMs: aggregate(selected.map((values) => median(values.map((value) => value.encodeMs)))),
        probeMs: aggregate(selected.map((values) => median(values.map((value) => value.probeMs)))) };
    });
    return { id, playback, exports, memory, memoryAggregate: Object.fromEntries(['rssBytes', 'ownedBytes'].map((field) => [field,
      Object.fromEntries(['initial', 'sampledPeak', 'finalSettled'].map((phase) => [phase, aggregate(memory.map((value) => value[field][phase]))]))])),
    unavailableValidations: [...new Set(entries.flatMap((entry) => (entry.validations ?? []).filter((value) => value.status !== 'passed').map((value) => value.check)))] };
  });
  return { environment: Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'deviceId')),
    workloadVersion: reports[0].workloadVersion, backend: reports[0].backend, memoryBudget: reports[0].memoryBudget,
    memorySamplePeriodMs: all[0].collection.periodMs,
    startedAt: reports[0].startedAt, finishedAt: reports.at(-1).finishedAt, cases };
}

const format = (value, digits = 2) => Number(value).toFixed(digits);
const range = (value, scale = 1, digits = 2) => `${format(value.median / scale, digits)} [${format(value.min / scale, digits)}–${format(value.max / scale, digits)}]`;
export function renderPerformance(summary, evidence, context = {}) {
  const env = summary.environment;
  const lines = ['# Mesures du candidat sur simulateur iOS', '',
    `Mesures réelles du ${summary.startedAt} au ${summary.finishedAt}, en Release sur simulateur ${env.deviceModel}, iOS ${env.osVersion}. Candidat ${summary.backend.version}, Skia ${summary.backend.skiaVersion}, WebGPU ${summary.backend.webgpuVersion}, RN ${env.reactNativeVersion}. Trois répétitions réussies pour chacun des cinq cas.`, '',
    `Horloge : ${env.measurementClock}. Écran déclaré : ${env.displayRefreshRate} Hz, PixelRatio ${env.pixelRatio}. Conditions natives constantes : ${env.thermalState} / ${env.powerMode}. Budget déclaré : ${format(summary.memoryBudget.reportedMaxBytes / 1048576, 0)} Mio. Workloads ${summary.workloadVersion}.`, '',
    'Les tableaux donnent la médiane des trois répétitions et leur plage [min–max]. Ces mesures concernent uniquement le candidat sur le GPU et les codecs du Mac ; elles ne sont ni une comparaison A/B ni une qualification de performance sur iPhone.', '',
    '## Lecture', '',
    '| Cas | Callbacks de dessin/s | p95 CPU, borne supérieure (ms) | p95 espacement, borne supérieure (ms) | Callbacks / frames attendues manquantes par répétition |',
    '| --- | --- | --- | --- | --- |'];
  if (context.host) {
    const host = context.host;
    check(typeof host.model === 'string' && typeof host.cpu === 'string' && finite(host.memoryBytes) &&
      typeof host.macOS === 'string' && typeof host.macOSBuild === 'string' && typeof host.source === 'string', 'Incomplete host machine evidence');
    lines.splice(6, 0, `Hôte vérifié : ${host.model}, ${host.cpu}, ${format(host.memoryBytes / 1073741824, 0)} Gio, macOS ${host.macOS} (${host.macOSBuild}). Source : ${host.source}.`, '');
  }
  for (const entry of summary.cases.filter((value) => value.playback)) {
    const value = entry.playback;
    lines.push(`| ${entry.id} | ${range(value.callbacksPerSecond)} | ${range(value.cpuP95UpperMs)} | ${range(value.gapP95UpperMs)} | ${value.measurements.map((measure) => `${measure.callbacks}/${measure.missingFrames}`).join(', ')} |`);
  }
  lines.push('', 'Preview : 720×720 pixels physiques. Le p95 est la borne supérieure du bucket d’histogramme, pas une valeur précise. La mesure dite CPU est la durée murale du callback de dessin et de son observation, y compris ses appels natifs et attentes éventuelles ; elle ne mesure pas une consommation CPU par profilage. Elle exclut une partie du décodage/import de frame et ne mesure pas la fin des commandes GPU. La cadence décrit des callbacks/s ; plusieurs callbacks peuvent redessiner la même frame vidéo. Le nombre de frames décodées/perdues et le temps GPU ne sont pas collectés.', '',
    '## Export', '', '| Cas | Dimensions / frames par fichier | Fichiers sondés | Pipeline export hors sonde (ms) | Sonde séparée (ms) |', '| --- | --- | --- | --- | --- |');
  for (const entry of summary.cases) for (const value of entry.exports)
    lines.push(`| ${entry.id} | ${value.dimension} / ${value.framesPerExport} | ${value.sampleCount} | ${range(value.encodeMs)} | ${range(value.probeMs)} |`);
  const exportCount = summary.cases.reduce((count, entry) => count + entry.exports.reduce((sum, value) => sum + value.sampleCount, 0), 0);
  lines.push('', `${exportCount} fichiers ont été exportés puis sondés. Pour les tailles alternées, chaque répétition fournit d’abord sa médiane par taille ; le tableau résume ensuite ces trois médianes. Le chronomètre d’encodage comprend le pipeline export de la bibliothèque, sa préparation, le décodage, le rendu, la lecture CPU, l’encodeur et sa fermeture ; il exclut la sonde AVFoundation. Les métadonnées, nombres de frames, dimensions, codec et PTS exacts ont été vérifiés. Les validateurs de pixels/audio du catalogue restent indisponibles.`, '',
    '## Mémoire', '', '| Cas | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS après fermeture (Mio) | Pic owned estimé (Mio) | Owned après fermeture (Mio) |', '| --- | --- | --- | --- | --- | --- |');
  for (const entry of summary.cases) {
    const rss = entry.memoryAggregate.rssBytes, owned = entry.memoryAggregate.ownedBytes;
    lines.push(`| ${entry.id} | ${range(rss.initial, 1048576)} | ${range(rss.sampledPeak, 1048576)} | ${range(rss.finalSettled, 1048576)} | ${range(owned.sampledPeak, 1048576)} | ${range(owned.finalSettled, 1048576)} |`);
  }
  const mixed = summary.cases.find((entry) => entry.id === 'repeated-mixed-size-exports');
  if (mixed && mixed.memory.at(-1).rssBytes.finalSettled > mixed.memory[0].rssBytes.initial) {
    lines.push('', `Les exports alternés présentent une croissance du RSS à expliquer : ${mixed.memory.map((value) => format(value.rssBytes.finalSettled / 1048576)).join(' → ')} Mio après fermeture des trois répétitions, depuis ${format(mixed.memory[0].rssBytes.initial / 1048576)} Mio avant la première. Les réservations suivies reviennent à zéro, mais aucun palier du processus n'est démontré. Une session prolongée avec attribution des allocations est nécessaire pour distinguer caches persistants et fuite ; cette passe ne permet pas de trancher.`);
  }
  if (summary.backend.skiaVersion === '3.0.3') lines.push('',
    'Le budget vidéo suivi n’inclut pas les budgets de cache Graphite : les headers livrés de Skia 3.0.3 définissent par défaut 256 Mio par Recorder et 256 Mio pour le Context. Ces budgets ne sont ni des allocations permanentes mesurées ni une attribution de ce RSS. [UPSTREAM_NOTES.md](UPSTREAM_NOTES.md) conserve les références et le point futur d’inspection/configuration amont. La bibliothèque ne purge pas globalement Graphite et ne modifie pas le device partagé de l’application.');
  lines.push('', 'RSS : resident_size par mach task_info, à l’échelle du processus. Owned : estimations des réservations de la bibliothèque. Tous les cas terminent avec zéro octet/réservation/décodeur/buffer en vol suivi. Les pics sont seulement ceux des échantillons disponibles ; une allocation brève entre deux relevés peut être absente. La fermeture attend le démontage et un délai de stabilisation ; aucun fence GPU général n’est fourni par le harness. Le RSS comprend les caches et allocations opaques des codecs/pilotes ; zéro owned ne prouve pas une absence de fuite.', '',
    `La mémoire est échantillonnée toutes les ${summary.memorySamplePeriodMs} ms demandées ; les relevés natifs asynchrones peuvent arriver plus tard. Ce collecteur plus fréquent ajoute son propre coût, identique dans les répétitions de cette passe. La mémoire GPU totale, le heap natif et le heap JavaScript ne sont pas collectés. Les répétitions partagent un processus : les caches des cas antérieurs influencent le RSS et l’ordre des cas est conservé. Aucun palier de mémoire physique à long terme ni gain par rapport à la référence n’est démontré.`, '',
    'Les traces de création/fermeture de la bibliothèque sont désactivées en Release avec RNSV_TRACE_LIFECYCLE. Des traces système du codec HEVC Apple du simulateur peuvent subsister ; elles ne viennent pas du code JavaScript.', '', '## Preuves', '');
  for (const value of evidence) lines.push(`- ${basename(value.path)} — SHA-256 ${value.sha256}.`);
  if (context.provenance) {
    const provenance = context.provenance;
    check(/^[a-f0-9]{64}$/.test(provenance.productionFingerprint ?? '') &&
      Date.parse(provenance.capturedAt) <= Date.parse(summary.startedAt), 'Missing or late build provenance');
    const bundle = provenance.builtArtifact?.['main.jsbundle'];
    const executable = provenance.builtArtifact?.ReactNativeSkiaWebGPUVideoExample;
    check([bundle, executable].every((artifact) => /^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '') &&
      Date.parse(artifact.mtime) < Date.parse(summary.startedAt)), 'Missing or late built artifact identity');
    lines.push('', `Provenance consignée avant le run : fingerprint de production ${provenance.productionFingerprint}, SHA-256 main.jsbundle ${bundle.sha256}, SHA-256 exécutable ${executable.sha256}. Le fichier de provenance conserve également les hashes App/harness.`);
  }
  lines.push('', 'Les JSON bruts restent dans benchmark/results/*.local.json, ignorés par Git. Les identifiants privés d’appareil ne sont pas reproduits ici.', '');
  return lines.join('\n');
}

export function renderMixedDiagnostic(summary, evidence) {
  const entry = summary.cases[0];
  check(summary.cases.length === 1 && entry.id === 'repeated-mixed-size-exports', 'Mixed-only diagnostic required');
  const files = entry.exports.reduce((sum, value) => sum + value.sampleCount, 0);
  return ['## Diagnostic long séparé des mesures initiales', '',
    `Run distinct du ${summary.startedAt} au ${summary.finishedAt}, ${files} fichiers exportés/sondés sur trois répétitions. Ce run ne remplace ni ne fusionne les quinze répétitions des tableaux précédents. Les mêmes contrôles de Release/horloge/conditions/collecteurs, de séquence des tailles et de métadonnées/PTS sont appliqués.`, '',
    '| Répétition | RSS initial (Mio) | Pic RSS échantillonné (Mio) | RSS final après fermeture (Mio) | Owned final / réservations / décodeurs / buffers en vol |',
    '| --- | --- | --- | --- | --- |',
    ...entry.memory.map((value, index) => `| ${index + 1} | ${format(value.rssBytes.initial / 1048576)} | ${format(value.rssBytes.sampledPeak / 1048576)} | ${format(value.rssBytes.finalSettled / 1048576)} | ${value.ownedBytes.finalSettled} / ${value.finalCounters.ownedResources} / ${value.finalCounters.decoderCount} / ${value.finalCounters.inFlightFrames} |`), '',
    `Sur ces répétitions, le RSS final ${entry.memory.at(-1).rssBytes.finalSettled <= entry.memory[0].rssBytes.finalSettled ? "diminue ; aucune croissance continue n'est observée" : "augmente ; une croissance reste à expliquer"}. Ce constat se limite à ce run. Ces valeurs restent des relevés du processus, demandés après un délai de stabilisation, sans attribution native/GPU exhaustive. Elles ne prouvent ni la libération de toutes les allocations opaques ni une absence de fuite à long terme.`, '',
    "Aucune attribution de heap/GPU n'est fournie par ce rapport. Les temps de ce diagnostic ne constituent pas une nouvelle mesure comparative de performance.", '',
    `Preuve locale : ${basename(evidence.path)} — SHA-256 ${evidence.sha256}.`, ''].join('\n');
}

export function renderIdleObservations(observations, evidence) {
  check(Array.isArray(observations.measurements) && observations.measurements.length >= 2 &&
    typeof observations.source === 'string' && observations.source.startsWith('ps '), 'Recorded ps idle readings required');
  check(observations.measurements.every((point, index) => finite(point.rssKiB) && finite(point.processElapsedSeconds) &&
    (!index || point.processElapsedSeconds > observations.measurements[index - 1].processElapsedSeconds)), 'Invalid idle readings');
  return ['## Repos observé après le run initial', '',
    `Le même processus est resté au repos entre deux lectures RSS par ps : ${observations.measurements.map((point) => `${format(point.rssKiB / 1024, 3)} Mio à ${point.processElapsedSeconds} s de durée de vie du processus`).join(' ; ')}. Les heures murales exactes de ces lectures n'ont pas été capturées ; le recordedAt du JSON correspond à leur consignation, pas à chaque mesure.`, '',
    "Ces relevés sont distincts des points settled après deux secondes et de leur collecteur mach task_info. Ils montrent que le RSS du processus a baissé au repos ; ils n'attribuent pas cette baisse au heap, au GC ou au GPU, et ne prouvent aucune libération précise de buffer.", '',
    `Preuve locale : ${basename(evidence.path)} — SHA-256 ${evidence.sha256}.`, ''].join('\n');
}

export function renderLongIdleObservation(observation, evidence) {
  check(typeof observation.source === 'string' && observation.source.startsWith('ps'), 'Recorded ps long-run idle observation required');
  const readings = observation.measurements ?? [observation];
  const elapsedSeconds = (value) => {
    const [minutes, seconds] = value.split(':').map(Number);
    return minutes * 60 + seconds;
  };
  check(Array.isArray(readings) && readings.length > 0 && readings.every((point, index) => finite(point.rssKiB) &&
    /^\d+:[0-5]\d$/.test(point.processElapsed ?? '') &&
    Number.isFinite(Date.parse(point.measurementWindow?.before)) &&
    Date.parse(point.measurementWindow.before) <= Date.parse(point.measurementWindow?.after) &&
    (!index || (elapsedSeconds(point.processElapsed) > elapsedSeconds(readings[index - 1].processElapsed) &&
      Date.parse(point.measurementWindow.before) >= Date.parse(readings[index - 1].measurementWindow.after)))),
  'Recorded chronological timed long-run idle observations required');
  return ['## Repos observé après le diagnostic long', '',
    'Lectures RSS par ps du même processus au repos :', '',
    ...readings.map((point) => `- ${format(point.rssKiB / 1024, 3)} Mio, à ${point.processElapsed} de durée de vie du processus, dans la fenêtre du ${point.measurementWindow.before} au ${point.measurementWindow.after}.`), '',
    "Ces relevés sont distincts des points settled après fermeture. Ils décrivent le RSS du processus à ces instants, sans identifier le heap, le GC ou le GPU responsables de sa variation. Ils ne démontrent ni un palier stable ni une absence de fuite à long terme.", '',
    `Preuve locale : ${basename(evidence.path)} — SHA-256 ${evidence.sha256}.`, ''].join('\n');
}

export function selfTest() {
  assert.equal(histogramP95Upper({ bounds: [1, 2], counts: [94, 5, 1], total: 100, maxMs: 3, sumMs: 100 }), 2);
  assert.equal(histogramP95Upper({ bounds: [1], counts: [90, 10], total: 100, maxMs: 7, sumMs: 100 }), 7);
  assert.throws(() => histogramP95Upper({ bounds: [1], counts: [1, 0], total: 2, maxMs: 1, sumMs: 1 }), /totals/);
  assert.throws(() => summarizePerformance([]), /At least one/);
  assert.throws(() => summarizePerformance([{ environment: {} }]), /environment/);
  const environment = { deviceId: 'private-test-id', deviceModel: 'test-simulator', platform: 'ios',
    osVersion: '27', reactNativeVersion: '0.86', buildMode: 'release', executionTarget: 'simulator',
    measurementClock: 'performance.now', pixelRatio: 3, displayRefreshRate: 60, thermalState: 'nominal', powerMode: 'normal' };
  const scenarios = buildCases({ profile: 'full' }).filter((value) => PERFORMANCE_CASES.includes(value.id));
  const ids = [...new Set(scenarios.flatMap((value) => value.composition.items.map((item) => item.fixture)))];
  const point = (phase, elapsedMs) => ({ phase, elapsedMs, collectedAtElapsedMs: elapsedMs + 1,
    operatingConditions: { thermalState: 'nominal', powerMode: 'normal', source: 'synthetic conditions' },
    memory: Object.fromEntries(['rssBytes', 'ownedBytes', 'ownedResources', 'decoderCount', 'inFlightFrames', 'nativeHeapBytes', 'gpuBytes']
      .map((field) => [field, { value: field === 'rssBytes' ? 100 : ['nativeHeapBytes', 'gpuBytes'].includes(field) ? null : 0,
        source: `synthetic ${field}`, reason: 'synthetic unavailable' }])) });
  const output = (requested, duration) => {
    const frames = Math.ceil(duration * requested.frameRate - 1e-9);
    return { encodeMs: 100, probeMs: 20, durationMs: 120, actualOutput: { width: requested.width, height: requested.height,
      fps: requested.frameRate, codec: requested.codec, frameCount: frames, duration: frames / requested.frameRate,
      presentationTimesExact: true, timestampsMonotonic: true, firstPresentationTime: 0, lastPresentationTime: (frames - 1) / requested.frameRate } };
  };
  const report = { schema: 1, workloadVersion: 'self-test-only', repetitions: 3, seed: 1, environment,
    backend: { name: 'synthetic' }, fixtureManifest: { schema: 1, files: ids.map((id) => ({ id, bytes: 1, sha256: 'a'.repeat(64) })) },
    memoryBudget: { requestedMaxBytes: 1000, reportedMaxBytes: 1000, applied: true },
    startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z', caseCatalog: scenarios,
    cases: scenarios.flatMap((scenario) => [0, 1, 2].map((repetition) => ({ id: scenario.id, repetition, status: 'passed',
      actualPaths: { source: 'synthetic' }, memorySamples: [point('running', 0), point('settled', 2000)], validations: [],
      collection: { periodMs: 100, memorySamplesDropped: 0, frameTiming: timing, preview: { resolutionUnit: 'physical-pixels', pixelRatio: 3,
        actualPixelWidth: 720, actualPixelHeight: 720, requestedPixelWidth: 720, requestedPixelHeight: 720 } },
      operations: scenario.operations.map((operation) => {
        if (operation === 'perf') return { operation, draws: 240, missingFrames: 0, durationMs: 4000, gpuTimeMs: null,
          drawHistogram: { bounds: [1], counts: [240, 0], total: 240, maxMs: 0.5, sumMs: 120 },
          callbackGapHistogram: { bounds: [20], counts: [239, 0], total: 239, maxMs: 17, sumMs: 239 * 17 } };
        if (operation === 'export') return { operation, requestedOutput: { ...scenario.output }, ...output(scenario.output, scenario.composition.duration) };
        if (operation === 'mixed-exports') return { operation, exports: Array.from({ length: scenario.exportCycles }, (_, index) => {
          const requested = { ...scenario.output, ...[{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 720, height: 1280 }][index % 3] };
          return { output: requested, ...output(requested, scenario.composition.duration) };
        }) };
        return { operation };
      }) }))) };
  const result = summarizePerformance([report]);
  assert.equal(result.cases[0].playback.callbacksPerSecond.median, 60);
  assert.equal(result.cases.at(-1).exports[0].sampleCount, 21);
  assert.equal(renderPerformance(result, []).includes(environment.deviceId), false);
  const reject = (mutate, pattern) => { const changed = structuredClone(report); mutate(changed); assert.throws(() => summarizePerformance([changed]), pattern); };
  reject((value) => { value.repetitions = 1; }, /three-repetition/);
  reject((value) => { value.cases[0].status = 'failed'; }, /passed repetitions/);
  reject((value) => { value.cases[1].repetition = 0; }, /distinct/);
  reject((value) => { value.environment.buildMode = 'debug'; }, /Release/);
  reject((value) => { delete value.environment.measurementClock; }, /measurementClock/);
  reject((value) => { value.cases[0].collection.memorySamplesDropped = 1; }, /truncated/);
  reject((value) => { value.cases[0].memorySamples[1].memory.ownedBytes.value = 1; }, /return to zero/);
  reject((value) => { value.cases[0].memorySamples[0].operatingConditions.thermalState = 'fair'; }, /conditions/);
  reject((value) => { value.cases[0].memorySamples[0].memory.gpuBytes.value = 1; }, /unexpectedly present/);
  reject((value) => { value.cases[0].collection.preview.actualPixelWidth = 2160; }, /physical preview/);
  reject((value) => { value.cases[0].operations.pop(); }, /operations/);
  reject((value) => { value.cases.find((entry) => entry.id === 'encode-h264-copy').operations[0].actualOutput.frameCount--; }, /probe disagrees/);
  reject((value) => { for (const entry of value.cases.filter((entry) => entry.id === 'encode-h264-copy')) {
    entry.operations[0].requestedOutput.width = 800; entry.operations[0].actualOutput.width = 800;
  } }, /requested\/catalog/);
  reject((value) => { for (const entry of value.cases.filter((entry) => entry.id === 'repeated-mixed-size-exports')) {
    entry.operations[0].exports[0].output.width = 800; entry.operations[0].exports[0].actualOutput.width = 800;
  } }, /size sequence/);
  const mixedReport = structuredClone(report);
  mixedReport.cases = mixedReport.cases.filter((entry) => entry.id === 'repeated-mixed-size-exports');
  mixedReport.caseCatalog = mixedReport.caseCatalog.filter((entry) => entry.id === 'repeated-mixed-size-exports');
  const mixedSummary = summarizePerformance([mixedReport], { onlyMixedDiagnostic: true });
  assert.equal(mixedSummary.cases.length, 1);
  assert.throws(() => summarizePerformance([mixedReport]), /requested cases/);
  assert.equal(renderMixedDiagnostic(mixedSummary, { path: 'synthetic-only.json', sha256: 'a'.repeat(64) }).includes('60 fichiers'), true);
  assert.throws(() => renderIdleObservations({ source: 'ps ', measurements: [{ rssKiB: 1, processElapsedSeconds: 1 }] }, {}), /readings required/);
  assert.throws(() => renderIdleObservations({ source: 'ps ', measurements: [{ rssKiB: 1, processElapsedSeconds: 1 }, { rssKiB: 1, processElapsedSeconds: 1 }] }, {}), /Invalid idle/);
  const idle = { source: 'ps resident size', processId: 12345, measurements: [
    { rssKiB: 1024, processElapsed: '05:40', measurementWindow: { before: '2026-10-06T01:00:00Z', after: '2026-10-06T01:00:01Z' } },
    { rssKiB: 512, processElapsed: '10:40', measurementWindow: { before: '2026-10-06T01:05:00Z', after: '2026-10-06T01:05:01Z' } },
  ] };
  const renderedIdle = renderLongIdleObservation(idle, { path: 'synthetic-only.json', sha256: 'a'.repeat(64) });
  assert.equal(renderedIdle.includes('1.000 Mio') && renderedIdle.includes('0.500 Mio'), true);
  assert.equal(renderedIdle.includes('12345'), false);
  const invalidOrder = structuredClone(idle); invalidOrder.measurements[1].processElapsed = '05:40';
  assert.throws(() => renderLongIdleObservation(invalidOrder, {}), /chronological/);
  assert.throws(() => renderLongIdleObservation({ ...idle, source: 'unknown' }, {}), /Recorded ps/);
  return { passed: 31, scope: 'synthetic summarization, privacy, histogram and invalid measurement rejection; separate mixed-only/chronological idle diagnostics; no performance measurements generated' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') console.log(JSON.stringify(selfTest()));
  else {
    const args = process.argv.slice(2);
    const take = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0) return null;
      check(args.indexOf(flag, index + 1) < 0 && args[index + 1] && !args[index + 1].startsWith('--'), `${flag} requires one file`);
      const value = args[index + 1]; args.splice(index, 2); return value;
    };
    const output = take('--output'), host = take('--host'), provenance = take('--provenance'), longRun = take('--long-run'), idle = take('--idle-observations'), longIdle = take('--long-idle-observations');
    check(args.length > 0 && args.every((value) => !value.startsWith('--')),
      'Usage: node scripts/benchmark-performance-summary.mjs RESULT.local.json [MORE.local.json] [--host HOST.local.json] [--provenance SOURCE.local.json] [--long-run LONG.local.json] [--idle-observations IDLE.local.json] [--long-idle-observations LONG_IDLE.local.json] [--output docs/PERFORMANCE_SIMULATOR.md]');
    const inputs = await Promise.all(args.map(async (path) => {
      const raw = await readFile(path); return { path, sha256: createHash('sha256').update(raw).digest('hex'), report: JSON.parse(raw) };
    }));
    const context = {};
    for (const [key, path] of [['host', host], ['provenance', provenance]]) if (path) {
      const raw = await readFile(path); context[key] = JSON.parse(raw);
      inputs.push({ path, sha256: createHash('sha256').update(raw).digest('hex') });
    }
    const reports = inputs.filter((value) => value.report).map((value) => value.report);
    let result = renderPerformance(summarizePerformance(reports), inputs, context);
    if (longRun) {
      const raw = await readFile(longRun), report = JSON.parse(raw);
      same([reports[0].environment, report.environment], 'Initial and long-run environment/clock/conditions');
      same([reports[0].backend, report.backend], 'Initial and long-run backend');
      same([reports[0].fixtureManifest, report.fixtureManifest], 'Initial and long-run fixtures');
      check(report.workloadVersion === reports[0].workloadVersion, 'Initial and long-run workload versions differ');
      result += '\n' + renderMixedDiagnostic(summarizePerformance([report], { onlyMixedDiagnostic: true }),
        { path: longRun, sha256: createHash('sha256').update(raw).digest('hex') });
    }
    if (idle) {
      const raw = await readFile(idle), observations = JSON.parse(raw);
      check(args.some((path) => basename(path) === observations.performanceReport), 'Idle readings belong to another performance result');
      result += '\n' + renderIdleObservations(observations,
        { path: idle, sha256: createHash('sha256').update(raw).digest('hex') });
    }
    if (longIdle) {
      const raw = await readFile(longIdle), observation = JSON.parse(raw);
      check(longRun && basename(longRun) === observation.report, 'Long idle reading belongs to another diagnostic result');
      result += '\n' + renderLongIdleObservation(observation,
        { path: longIdle, sha256: createHash('sha256').update(raw).digest('hex') });
    }
    if (output) { await writeFile(output, result); console.log(`Performance summary written: ${output}`); }
    else process.stdout.write(result);
  }
}
