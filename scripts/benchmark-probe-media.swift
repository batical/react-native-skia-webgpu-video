// Verify locally generated/shared fixtures before using their manifest.
// Usage: swift benchmark-probe-media.swift <media directory> <manifest.json> <probe.json>
import AVFoundation
import Foundation

guard CommandLine.arguments.count == 4 else {
  fputs("Usage: benchmark-probe-media.swift <directory> <manifest.json> <probe.json>\n", stderr)
  exit(2)
}
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
let files = manifest["files"] as! [[String: Any]]
var probes = [[String: Any]]()
var failed = false
for fixture in files {
  let asset = AVURLAsset(url: directory.appendingPathComponent(fixture["file"] as! String))
  let videos = asset.tracks(withMediaType: .video)
  let audios = asset.tracks(withMediaType: .audio)
  var probe: [String: Any] = ["id": fixture["id"]!, "file": fixture["file"]!,
    "durationSeconds": CMTimeGetSeconds(asset.duration), "audioTracks": audios.count,
    "videoTracks": videos.count, "valid": true]
  var errors = [String]()
  if let expectedAudio = fixture["audio"] as? Bool, expectedAudio && audios.isEmpty { errors.append("missing audio track") }
  if fixture["audioOnly"] as? Bool == true {
    if audios.isEmpty || !videos.isEmpty { errors.append("not audio-only") }
  } else if let track = videos.first {
    let width = Int(track.naturalSize.width)
    let height = Int(track.naturalSize.height)
    let rotation = (Int((atan2(track.preferredTransform.b, track.preferredTransform.a) * 180 / .pi).rounded()) % 360 + 360) % 360
    let format = track.formatDescriptions.first as! CMFormatDescription
    let codec = CMFormatDescriptionGetMediaSubType(format)
    let codecName = codec == kCMVideoCodecType_H264 ? "h264" : codec == kCMVideoCodecType_HEVC ? "hevc" : String(codec)
    probe["width"] = width; probe["height"] = height; probe["fps"] = track.nominalFrameRate
    probe["rotation"] = rotation; probe["codec"] = codecName
    if width != (fixture["width"] as! Int) || height != (fixture["height"] as! Int) { errors.append("encoded dimensions differ") }
    if codecName != fixture["codec"] as! String { errors.append("codec differs") }
    if rotation != (fixture["rotation"] as? Int ?? 0) { errors.append("rotation differs") }
    if abs(Double(track.nominalFrameRate) - (fixture["fps"] as! Double)) > 0.01 { errors.append("nominal fps differs") }
    let reader = try AVAssetReader(asset: asset)
    // Decode rather than treating compressed packet order as presentation
    // order: H.264/HEVC B-frames legitimately reorder packet PTS values.
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    guard reader.startReading() else { throw reader.error! }
    var count = 0
    var previous = -Double.infinity
    var monotonic = true
    var exactPresentationTimes = true
    let fps = fixture["fps"] as! Double
    let slow = fixture["slowMotion"] as? [String: Double]
    func expectedTime(_ frame: Int) -> Double {
      let sourceTime = Double(frame) / fps
      guard let slow = slow else { return sourceTime }
      let start = slow["startSeconds"]!
      let duration = slow["sourceSeconds"]!
      let scaled = slow["presentationSeconds"]!
      if sourceTime < start { return sourceTime }
      if sourceTime < start + duration { return start + (sourceTime - start) * scaled / duration }
      return sourceTime + scaled - duration
    }
    while let sample = output.copyNextSampleBuffer() {
      let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
      monotonic = monotonic && timestamp > previous
      previous = timestamp
      exactPresentationTimes = exactPresentationTimes && abs(timestamp - expectedTime(count)) < 0.001
      count += CMSampleBufferGetNumSamples(sample)
    }
    probe["decodedFrames"] = count; probe["timestampsMonotonic"] = monotonic
    probe["presentationTimesExact"] = exactPresentationTimes
    let expectedCount = fixture["decodedFrames"] as? Int ?? Int(((fixture["seconds"] as! Double) * fps).rounded())
    if slow != nil {
      probe["editListPresentationValidated"] = true
      probe["standaloneSourceReferences"] = track.isSelfContained
      if !track.isSelfContained { errors.append("movie depends on an external source") }
    }
    if reader.status != .completed || count != expectedCount || !monotonic || !exactPresentationTimes { errors.append("frame count/PTS differ") }
    if fixture["bitDepth"] != nil || fixture["color"] != nil { probe["hdrPrecisionValidation"] = "requires pixel/colorimetric validator" }
  } else { errors.append("missing video track") }
  probe["errors"] = errors
  probe["valid"] = errors.isEmpty
  failed = failed || !errors.isEmpty
  probes.append(probe)
}
let data = try JSONSerialization.data(withJSONObject: ["schema": 1, "probes": probes, "allAvailableFixturesValid": !failed], options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
print("Verified \(probes.count) available fixtures; valid=\(!failed)")
exit(failed ? 1 : 0)
