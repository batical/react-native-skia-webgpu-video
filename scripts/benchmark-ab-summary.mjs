#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareResults, change, validateCompatibility } from '../benchmark/compare.mjs';
import { percentile } from '../benchmark/metrics.mjs';
import { expectedFrameCount } from '../benchmark/cases.mjs';
import { histogramP95Upper } from './benchmark-performance-summary.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const finite = (value) => Number.isFinite(value) && value >= 0;
const canonical = (value) => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const median = (values) => percentile(values.filter(finite), 0.5);
const stats = (values) => { const valid = values.filter(finite); return { samples: valid.length,
  median: median(valid), min: valid.length ? Math.min(...valid) : null,
  max: valid.length ? Math.max(...valid) : null, values: valid }; };
const reading = (point, field) => point?.memory?.[field]?.source && finite(point.memory[field].value) ? point.memory[field].value : null;
const verifiedExport = (item, output, duration) => {
  const actual = item.actualOutput;
  const frames = expectedFrameCount(duration, output.frameRate);
  return actual && actual.width === output.width && actual.height === output.height &&
    actual.codec === (output.codec === 'unknown-fallback' ? 'h264' : output.codec) &&
    actual.frameCount === frames && Number.isFinite(actual.fps) && Math.abs(actual.fps - output.frameRate) <= 0.01 &&
    Number.isFinite(actual.duration) && Math.abs(actual.duration - frames / output.frameRate) <= 1 / output.frameRate + 0.001 &&
    actual.timestampsMonotonic === true && actual.presentationTimesExact === true;
};

function summarizeBackend(reports, scenario) {
  const all = reports.flatMap((report) => report.cases.filter((entry) => entry.id === scenario.id));
  const entries = all.filter((entry) => entry.status === 'passed' && !entry.unsafeToContinue && !entry.cleanupError);
  const memory = {};
  for (const field of ['rssBytes', 'physicalFootprintBytes', 'ownedBytes', 'ownedResources', 'decoderCount', 'inFlightFrames', 'nativeHeapBytes', 'gpuBytes']) {
    const repetitions = entries.map((entry) => {
      const points = [...(entry.memorySamples ?? [])].sort((a, b) => a.elapsedMs - b.elapsedMs);
      const values = points.map((point) => reading(point, field)).filter(finite);
      const settled = points.filter((point) => point.phase === 'settled').at(-1);
      return { repetition: entry.repetition, initial: reading(points[0], field), final: reading(settled, field),
        peak: values.length ? Math.max(...values) : null,
        sources: [...new Set(points.map((point) => point.memory?.[field]?.source).filter(Boolean))] };
    });
    const sources = [...new Set(repetitions.flatMap((entry) => entry.sources))];
    memory[field] = { repetitions, sources, initial: stats(repetitions.map((entry) => entry.initial)),
      peak: stats(repetitions.map((entry) => entry.peak)), final: stats(repetitions.map((entry) => entry.final)),
      availability: repetitions.length && sources.length === 1 && repetitions.every((entry) => finite(entry.peak) && finite(entry.final)) ? 'measured' : 'unavailable-or-partial' };
  }
  const playback = entries.flatMap((entry) => (entry.operations ?? []).filter((op) => op.operation === 'perf').map((op) => {
    assert(finite(op.durationMs) && op.durationMs > 0 && Number.isSafeInteger(op.draws) && op.draws > 0,
      `${scenario.id}: invalid callback count/duration`);
    assert(op.drawHistogram?.total === op.draws && op.callbackGapHistogram?.total === op.draws - 1,
      `${scenario.id}: histogram callback counts disagree`);
    return { callbacksPerSecond: op.draws * 1000 / op.durationMs,
      drawP95UpperMs: histogramP95Upper(op.drawHistogram), gapP95UpperMs: histogramP95Upper(op.callbackGapHistogram),
      missingFrames: finite(op.missingFrames) ? op.missingFrames : null };
  }));
  let invalidExports = 0;
  let verifiedExports = 0;
  const exportRepetitions = entries.map((entry) => (entry.operations ?? []).flatMap((op) => {
    const items = op.operation === 'export' ? [{ ...op, output: scenario.output, totalMs: op.exportMs }]
      : op.operation === 'mixed-exports' ? (op.exports ?? []).map((item) => ({ ...item, totalMs: item.durationMs })) : [];
    return items.filter((item) => {
      const valid = item.output && verifiedExport(item, item.output, scenario.composition.duration) &&
        finite(item.encodeMs) && finite(item.probeMs) && finite(item.totalMs);
      if (valid) verifiedExports++; else invalidExports++;
      return valid;
    });
  }));
  const keys = [...new Set(exportRepetitions.flat().map((item) => `${item.output.width}×${item.output.height}/${item.output.frameRate}/${item.actualOutput.frameCount}/${item.actualOutput.codec}`))];
  const exports = keys.map((key) => {
    const selected = exportRepetitions.map((items) => items.filter((item) => `${item.output.width}×${item.output.height}/${item.output.frameRate}/${item.actualOutput.frameCount}/${item.actualOutput.codec}` === key));
    const sample = selected.flat()[0];
    return { key, width: sample.output.width, height: sample.output.height, fps: sample.output.frameRate,
      frames: sample.actualOutput.frameCount, codec: sample.actualOutput.codec,
      exports: selected.reduce((sum, items) => sum + items.length, 0),
      // Every repetition has equal weight even when mixed-size cycles have different counts per resolution.
      encodeMs: stats(selected.map((items) => median(items.map((item) => item.encodeMs)))),
      probeMs: stats(selected.map((items) => median(items.map((item) => item.probeMs)))),
      totalMs: stats(selected.map((items) => median(items.map((item) => item.totalMs)))) };
  });
  return { total: all.length, passed: entries.length,
    failures: all.filter((entry) => entry.status !== 'passed' || entry.unsafeToContinue || entry.cleanupError)
      .map((entry) => ({ repetition: entry.repetition, status: entry.status, reason: entry.reason ?? entry.cleanupError ?? null })),
    memory, playback: { callbacksPerSecond: stats(playback.map((entry) => entry.callbacksPerSecond)),
      drawP95UpperMs: stats(playback.map((entry) => entry.drawP95UpperMs)),
      gapP95UpperMs: stats(playback.map((entry) => entry.gapP95UpperMs)),
      missingFrames: stats(playback.map((entry) => entry.missingFrames)) }, exports, verifiedExports, invalidExports,
    periodsMs: [...new Set(entries.map((entry) => entry.collection.periodMs))],
    sampleCounts: stats(entries.map((entry) => entry.memorySamples?.length ?? 0)),
    collectorLatencyMs: stats(entries.flatMap((entry) => (entry.memorySamples ?? [])
      .map((point) => point.collectedAtElapsedMs - point.elapsedMs))) };
}

/** Raw A/B data remain unchanged. Comparability/correctness verdicts come from the strict comparator. */
export function summarizeAB(pairs, { host = null, provenance = null } = {}) {
  assert(Array.isArray(pairs) && pairs.length > 0, 'At least one A/B pair is required');
  assert(new Set(pairs.map((pair) => pair.label)).size === pairs.length && pairs.every((pair) => typeof pair.label === 'string' && pair.label), 'Unique nonempty pair labels required');
  const first = pairs[0];
  const runs = [];
  const comparisons = pairs.map((pair) => {
    for (const backend of ['baseline', 'candidate']) {
      validateCompatibility(first[backend], pair[backend]);
      assert(canonical(first[backend].backend) === canonical(pair[backend].backend), `Changed ${backend} implementation identity between pairs`);
      assert(canonical(first[backend].memoryBudget) === canonical(pair[backend].memoryBudget), `Changed ${backend} memory budget between pairs`);
      const start = Date.parse(pair[backend].startedAt);
      const end = Date.parse(pair[backend].finishedAt);
      assert(Number.isFinite(start) && Number.isFinite(end) && end > start, `Missing run timestamps: ${pair.label}/${backend}`);
      runs.push({ label: pair.label, backend, startedAt: pair[backend].startedAt, finishedAt: pair[backend].finishedAt,
        start, end, source: pair[`${backend}Source`] ?? null });
    }
    return { label: pair.label, comparison: compareResults(pair.baseline, pair.candidate) };
  });
  runs.sort((a, b) => a.start - b.start);
  for (let index = 1; index < runs.length; index++) assert(runs[index].start >= runs[index - 1].end, 'A/B measurement windows overlap; performance cannot be compared');
  const allCases = (selected) => first.baseline.caseCatalog.map((scenario) => ({ id: scenario.id,
    baseline: summarizeBackend(selected.map((pair) => pair.baseline), scenario),
    candidate: summarizeBackend(selected.map((pair) => pair.candidate), scenario) }));
  const assessment = comparisons.some((pair) => pair.comparison.assessment === 'failed') ? 'failed'
    : comparisons.some((pair) => pair.comparison.assessment === 'incomplete') ? 'incomplete' : 'passed';
  const sources = runs.map(({ start, end, ...run }) => run);
  const interrunGaps = runs.slice(1).map((run, index) => ({
    from: `${runs[index].backend}/${runs[index].label}`, to: `${run.backend}/${run.label}`,
    seconds: (run.start - runs[index].end) / 1000 }));
  return { schema: 1, assessment, environment: first.baseline.environment,
    baseline: first.baseline.backend, candidate: first.candidate.backend, host, provenance,
    workloadVersion: first.baseline.workloadVersion,
    memoryBudget: { baseline: first.baseline.memoryBudget, candidate: first.candidate.memoryBudget },
    runs: sources, interrunGaps, balancedOrder: runs.length === 4 && runs[0].backend !== runs[1].backend &&
      runs[0].backend === runs[3].backend && runs[1].backend === runs[2].backend &&
      runs[0].label === runs[1].label && runs[2].label === runs[3].label,
    comparisons, pairSummaries: pairs.map((pair) => ({ label: pair.label, cases: allCases([pair]) })),
    combined: allCases(pairs) };
}

const n = (value, digits = 2) => finite(value) ? value.toFixed(digits) : 'indisponible';
const pct = (a, b) => { const value = change(a, b); return value.percent == null ? 'indisponible' : `${value.percent >= 0 ? '+' : ''}${value.percent.toFixed(1)} %`; };
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const mib = (bytes) => finite(bytes) ? bytes / (1024 * 1024) : null;
const memoryPercent = (a, b) => a.availability === 'measured' && b.availability === 'measured' &&
  canonical(a.sources) === canonical(b.sources) ? pct(a.peak.median, b.peak.median) : 'indisponible';
const names = { 'steady-playback-h264-1080p30-audio': 'Lecture continue H.264 1080p',
  'steady-playback-h264-4k30': 'Lecture continue H.264 4K', 'steady-playback-hevc-4k30': 'Lecture continue HEVC 4K',
  'single-h264-1080p30-audio.mp4': 'Lecture H.264 1080p', 'single-h264-4k30.mp4': 'Lecture H.264 4K',
  'single-hevc-4k30.mp4': 'Lecture HEVC 4K', 'encode-h264-copy': 'Export H.264', 'repeated-mixed-size-exports': 'Exports de tailles alternées' };
function tables(cases) {
  const lines = ['| Scénario | Réussis ancien / nouveau | Pic RSS ancien / nouveau (MiB) | Écart RSS | RSS final ancien / nouveau (MiB) |',
    '|---|---:|---:|---:|---:|'];
  for (const row of cases) {
    const a = row.baseline; const b = row.candidate;
    lines.push(`| ${cell(names[row.id] ?? row.id)} | ${a.passed}/${a.total} · ${b.passed}/${b.total} | ${n(mib(a.memory.rssBytes.peak.median))} / ${n(mib(b.memory.rssBytes.peak.median))} | ${memoryPercent(a.memory.rssBytes, b.memory.rssBytes)} | ${n(mib(a.memory.rssBytes.final.median))} / ${n(mib(b.memory.rssBytes.final.median))} |`);
  }
  const footprintCases = cases.filter((row) => row.baseline.memory.physicalFootprintBytes?.peak.samples ||
    row.candidate.memory.physicalFootprintBytes?.peak.samples);
  if (footprintCases.length) {
    const unavailableFootprint = { peak: { median: null }, final: { median: null }, availability: 'unavailable-or-partial' };
    lines.push('', '| Scénario | Pic empreinte physique ancien / nouveau (MiB) | Écart empreinte | Empreinte finale ancien / nouveau (MiB) |',
      '|---|---:|---:|---:|');
    for (const row of footprintCases) {
      const a = row.baseline.memory.physicalFootprintBytes ?? unavailableFootprint;
      const b = row.candidate.memory.physicalFootprintBytes ?? unavailableFootprint;
      lines.push(`| ${cell(names[row.id] ?? row.id)} | ${n(mib(a.peak.median))} / ${n(mib(b.peak.median))} | ${memoryPercent(a, b)} | ${n(mib(a.final.median))} / ${n(mib(b.final.median))} |`);
    }
    lines.push('', 'L’empreinte physique iOS provient de task_vm_info phys_footprint. Elle est mesurée séparément du RSS et reste indisponible lorsqu’aucun collecteur ne la fournit.');
  }
  const playbackCases = cases.filter((value) => value.baseline.playback.callbacksPerSecond.samples || value.candidate.playback.callbacksPerSecond.samples);
  if (playbackCases.length) lines.push('', '| Lecture | Callbacks/s ancien / nouveau | p95 CPU ancien / nouveau (ms) | p95 intervalle ancien / nouveau (ms) |', '|---|---:|---:|---:|');
  for (const row of playbackCases) {
    const a = row.baseline.playback; const b = row.candidate.playback;
    lines.push(`| ${cell(names[row.id] ?? row.id)} | ${n(a.callbacksPerSecond.median)} / ${n(b.callbacksPerSecond.median)} | ≤ ${n(a.drawP95UpperMs.median)} / ≤ ${n(b.drawP95UpperMs.median)} | ≤ ${n(a.gapP95UpperMs.median)} / ≤ ${n(b.gapP95UpperMs.median)} |`);
  }
  lines.push('', '| Export | Images | Pipeline ancien / nouveau (ms) | Écart pipeline | Total ancien / nouveau (ms) |', '|---|---:|---:|---:|---:|');
  for (const row of cases) {
    const keys = [...new Set([...row.baseline.exports, ...row.candidate.exports].map((item) => item.key))];
    for (const key of keys) {
      const a = row.baseline.exports.find((item) => item.key === key); const b = row.candidate.exports.find((item) => item.key === key);
      const description = a ?? b;
      lines.push(`| ${cell(names[row.id] ?? row.id)} ${description.width}×${description.height} | ${description.frames} | ${n(a?.encodeMs.median)} / ${n(b?.encodeMs.median)} | ${pct(a?.encodeMs.median, b?.encodeMs.median)} | ${n(a?.totalMs.median)} / ${n(b?.totalMs.median)} |`);
    }
  }
  return lines;
}

export function renderABMarkdown(summary) {
  const lines = ['# Comparaison Skia 2 / Skia 3 WebGPU', '',
    `Comparaison mesurée : **${summary.assessment}** selon le comparateur strict. Cette qualification conserve les échecs, les régressions et les validations média manquantes.`, '',
    `Ancien : ${summary.baseline.name} ${summary.baseline.version}, Skia ${summary.baseline.skiaVersion}. Nouveau : ${summary.candidate.name} ${summary.candidate.version}, Skia ${summary.candidate.skiaVersion}.`, '',
    `Environnement : ${summary.environment.executionTarget}, ${summary.environment.deviceModel}, ${summary.environment.platform} ${summary.environment.osVersion}, React Native ${summary.environment.reactNativeVersion}, ${summary.environment.buildMode}, horloge ${summary.environment.measurementClock}.`, '',
    `Ordre : ${summary.runs.map((run) => `${run.backend === 'baseline' ? 'ancien' : 'nouveau'} (${run.label})`).join(' → ')}. ${summary.balancedOrder ? 'Ordre A/B puis B/A vérifié, sans chevauchement.' : 'Cette série ne constitue pas un ordre A/B puis B/A complet.'}`, '',
    ...summary.interrunGaps.filter((gap) => gap.seconds > 15 * 60).flatMap((gap) => [
      `**Intervalle prolongé : ${n(gap.seconds / 60, 1)} minutes entre ${cell(gap.from)} et ${cell(gap.to)}.** Les conditions du système hôte pendant cet intervalle ne sont pas contrôlées. Examiner la cohérence des résultats par paire avant de tirer une conclusion des médianes regroupées ; l'ordre A/B puis B/A ne supprime pas cette limite.`, '']),
    '## Résultats regroupés', '',
    'Médianes des répétitions réussies ; les effectifs restent visibles. Les six répétitions éventuelles sont regroupées depuis deux processus par version et ne constituent pas six démarrages indépendants. Pour les tailles alternées, chaque répétition pèse autant après calcul de sa propre médiane.', '',
    ...tables(summary.combined), '',
    'Le pipeline couvre décodage, dessin et encodage, avant lecture des métadonnées. Le total inclut aussi la vérification et la suppression du fichier. La lecture mesure des callbacks, pas les images effectivement affichées ni le temps GPU ; les valeurs p95 sont les médianes des bornes supérieures du p95 par répétition, pas un p95 global recalculé.', '',
    'Les scénarios steady-playback mesurent une lecture continue sans seek ; ils ne remplacent pas les scénarios historiques de seek, boucle et maintien d’image. Un échec historique de seek reste un échec fonctionnel distinct.', '',
    'Les pics RSS sont échantillonnés, donc des bornes inférieures du vrai maximum. Le RSS final suit la pause de stabilisation prévue par le scénario ; les caches peuvent survivre et le processus poursuit les scénarios suivants. Ces chiffres ne démontrent ni fuite ni absence de fuite.', '',
    '## Qualification et limites', '',
    `Budget demandé : ${n(mib(summary.memoryBudget.baseline.requestedMaxBytes), 0)} MiB. Application ancien : ${summary.memoryBudget.baseline.applied ? 'oui' : 'non disponible'} ; nouveau : ${summary.memoryBudget.candidate.applied ? 'oui' : 'non disponible'}.`, '',
    'Les compteurs de ressources propres à la nouvelle bibliothèque restent indisponibles sur l’ancienne. Ils ne sont jamais remplacés par zéro et ne servent pas à comparer la mémoire totale. Mémoire GPU totale et tas natif séparé : non mesurés lorsque les collecteurs sont absents.', ''];
  for (const pair of summary.comparisons) {
    lines.push(`### ${cell(pair.label)} — ${pair.comparison.assessment}`, '');
    for (const message of [...new Set([...pair.comparison.warnings, ...pair.comparison.confounders])]) lines.push(`- ${cell(message)}`);
    for (const row of pair.comparison.cases) {
      if (row.findings.length) lines.push(`- ${cell(names[row.id] ?? row.id)} : ${row.assessment}. ${row.findings.map(cell).join(' ; ')}`);
    }
    lines.push('');
  }
  if (summary.pairSummaries.length > 1) for (const pair of summary.pairSummaries) lines.push(`## Paire ${cell(pair.label)}`, '', ...tables(pair.cases), '');
  lines.push('## Traçabilité', '', '| Version / paire | Début UTC | Fin UTC | JSON SHA-256 |', '|---|---|---|---|');
  for (const run of summary.runs) lines.push(`| ${run.backend} / ${cell(run.label)} | ${run.startedAt} | ${run.finishedAt} | ${run.source?.sha256 ?? 'non fourni'} |`);
  lines.push('', 'Les fenêtres sont celles enregistrées par chaque application. Les fichiers JSON conservent les échantillons, les conditions thermiques, les résultats des vérifications et les mesures par répétition.', '');
  if (summary.provenance) lines.push(`Provenance complémentaire : ${cell(summary.provenance.source?.path ?? 'jointe au résumé JSON')}.`, '');
  if (summary.host) lines.push(`Hôte : ${cell(JSON.stringify(summary.host.data ?? summary.host))}.`, '');
  return lines.join('\n');
}

export async function main(argv) {
  const pairs = []; let output; let jsonPath; let hostPath; let provenancePath;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--pair') { const [label, baselinePath, candidatePath] = argv.slice(index + 1, index + 4);
      assert(label && baselinePath && candidatePath && ![label, baselinePath, candidatePath].some((value) => value.startsWith('--')), '--pair requires LABEL BASELINE_JSON CANDIDATE_JSON');
      pairs.push({ label, baselinePath, candidatePath }); index += 3;
    } else if (['--output', '--json', '--host', '--provenance'].includes(flag)) {
      const value = argv[++index]; assert(value && !value.startsWith('--'), `${flag} requires a path`);
      if (flag === '--output') output = value; else if (flag === '--json') jsonPath = value;
      else if (flag === '--host') hostPath = value; else provenancePath = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  assert(output && pairs.length, 'Usage: node scripts/benchmark-ab-summary.mjs --pair LABEL BASELINE_JSON CANDIDATE_JSON [--pair LABEL BASELINE_JSON CANDIDATE_JSON] --output REPORT.md [--json SUMMARY.json] [--host HOST.json] [--provenance PROVENANCE.json]');
  const load = async (path) => { const raw = await readFile(path); return { data: JSON.parse(raw), source: { path: resolve(path), sha256: createHash('sha256').update(raw).digest('hex') } }; };
  const loaded = await Promise.all(pairs.map(async (pair) => {
    const [baseline, candidate] = await Promise.all([load(pair.baselinePath), load(pair.candidatePath)]);
    return { label: pair.label, baseline: baseline.data, candidate: candidate.data,
      baselineSource: baseline.source, candidateSource: candidate.source };
  }));
  const summary = summarizeAB(loaded, { host: hostPath ? await load(hostPath) : null,
    provenance: provenancePath ? await load(provenancePath) : null });
  await writeFile(output, renderABMarkdown(summary));
  if (jsonPath) await writeFile(jsonPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`${summary.assessment}: ${summary.runs.length} runs, ${summary.combined.length} cases; ${output}`);
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
