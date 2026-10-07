package com.skiawebgpuvideo.tests

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import com.facebook.react.bridge.*
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.abs

/** Example-only collector: actual process memory, files and decoded output verification. */
class VideoBenchmarkHarness(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val worker = Executors.newSingleThreadExecutor()
  private val outputs = File(context.getExternalFilesDir(null) ?: context.filesDir, "benchmark-results")
  private val fixtures = File(context.filesDir, "fixtures")
  @Volatile private var applicationState = "background"
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "VideoBenchmarkHarness"
  override fun onHostResume() { applicationState = "active" }
  override fun onHostPause() { applicationState = "background" }
  override fun onHostDestroy() { applicationState = "background" }
  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    worker.shutdownNow()
    super.invalidate()
  }

  override fun getConstants(): MutableMap<String, Any?> {
    fixtures.mkdirs()
    // Setup is outside timed benchmark phases, and all copies are streamed.
    for (name in context.assets.list("").orEmpty()) {
      if (!name.endsWith(".mp4") && !name.endsWith(".mov") && !name.endsWith(".m4a")) continue
      val target = File(fixtures, name)
      context.assets.open(name).use { source -> target.outputStream().use { source.copyTo(it) } }
    }
    val conditions = conditions()
    val emulator = Build.FINGERPRINT.startsWith("generic") || Build.MODEL.contains("sdk_gphone") || Build.MODEL.contains("Emulator")
    val refresh = (context.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.refreshRate
    val intent = MainActivity.benchmarkIntent ?: context.currentActivity?.intent
    val profile = intent?.getStringExtra("RNSKV_BENCHMARK_PROFILE")?.takeIf { it in listOf("smoke", "full", "soak", "interop") }
    val repetitions = intent?.getIntExtra("RNSKV_BENCHMARK_REPETITIONS", 3)?.coerceIn(1, 10) ?: 3
    val caseIds = intent?.getStringExtra("RNSKV_BENCHMARK_CASE_IDS")?.let { encoded ->
      val values = JSONArray(encoded)
      require(values.length() in 1..128) { "Invalid benchmark case selection" }
      (0 until values.length()).map { values.getString(it) }
    }
    return mutableMapOf("benchmarkCaseIds" to caseIds, "benchmarkProfile" to profile, "benchmarkRunId" to intent?.getStringExtra("RNSKV_BENCHMARK_RUN_ID"),
      "fixtureDirectory" to fixtures.absolutePath, "resultDirectory" to outputs.absolutePath,
      "deviceId" to Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID),
      "deviceModel" to "${Build.MANUFACTURER} ${Build.MODEL}", "executionTarget" to if (emulator) "emulator" else "device",
      "osVersion" to Build.VERSION.RELEASE, "displayRefreshRate" to refresh.toDouble(),
      "benchmarkRepetitions" to repetitions, "processIdentifier" to Process.myPid(),
      "thermalState" to conditions["thermalState"], "powerMode" to conditions["powerMode"])
  }

  private fun conditions(): Map<String, Any?> {
    val power = context.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
    val thermal = if (Build.VERSION.SDK_INT >= 29) when (power.currentThermalStatus) {
      PowerManager.THERMAL_STATUS_NONE -> "nominal"
      PowerManager.THERMAL_STATUS_LIGHT -> "fair"
      PowerManager.THERMAL_STATUS_MODERATE -> "serious"
      PowerManager.THERMAL_STATUS_SEVERE, PowerManager.THERMAL_STATUS_CRITICAL, PowerManager.THERMAL_STATUS_EMERGENCY,
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
      else -> "unknown"
    } else "unknown"
    return mapOf("thermalState" to thermal, "powerMode" to if (power.isPowerSaveMode) "low-power" else "normal",
      "applicationState" to applicationState, "source" to "Android PowerManager and React lifecycle")
  }

  private fun execute(promise: Promise, action: () -> Any?) {
    try {
      worker.execute { try {
        val value = action()
        promise.resolve(if (value is Map<*, *>) Arguments.makeNativeMap(value as Map<String, Any?>) else value)
      } catch (error: Exception) { promise.reject("BENCHMARK_ANDROID", error.message, error) } }
    } catch (error: java.util.concurrent.RejectedExecutionException) { promise.reject("BENCHMARK_CLOSED", error) }
  }
  private fun output(path: String): File {
    val file = File(path).canonicalFile
    require(file.path.startsWith(outputs.canonicalPath + File.separator)) { "Only benchmark output files are allowed" }
    return file
  }
  @ReactMethod fun prepareOutputDirectory(promise: Promise) = execute(promise) {
    check(outputs.mkdirs() || outputs.isDirectory) { "Cannot create benchmark result directory" }; outputs.absolutePath
  }
  @ReactMethod fun stat(path: String, promise: Promise) = execute(promise) {
    val file = output(path); require(file.isFile) { "Output is missing" }; mapOf("size" to file.length().toDouble())
  }
  @ReactMethod fun remove(path: String, promise: Promise) = execute(promise) {
    val file = output(path); check(!file.exists() || file.delete()) { "Cannot remove output" }; true
  }
  @ReactMethod fun writeResult(json: String, name: String, promise: Promise) = execute(promise) {
    require(File(name).name == name && name.endsWith(".json") && !name.startsWith(".")) { "A plain JSON filename is required" }
    JSONObject(json)
    check(outputs.mkdirs() || outputs.isDirectory)
    val file = output(File(outputs, name).absolutePath)
    val temporary = File(outputs, "$name.tmp")
    temporary.writeText(json)
    check(temporary.renameTo(file)) { "Cannot commit benchmark JSON" }; file.absolutePath
  }
  @ReactMethod fun sampleOperatingConditions(promise: Promise) = execute(promise) { conditions() }
  @ReactMethod fun sampleMemory(promise: Promise) = execute(promise) {
    val memory = Debug.MemoryInfo(); Debug.getMemoryInfo(memory)
    val rss = File("/proc/self/status").useLines { lines ->
      lines.firstOrNull { it.startsWith("VmRSS:") }?.split(Regex("\\s+"))?.getOrNull(1)?.toLongOrNull()?.times(1024)
    }
    fun reading(value: Long?, source: String) = if (value == null) mapOf("value" to null, "reason" to "Reading unavailable")
      else mapOf("value" to value.toDouble(), "source" to source)
    mapOf("rssBytes" to reading(rss, "Android /proc/self/status VmRSS"),
      "pssBytes" to reading(memory.totalPss.toLong() * 1024, "Android Debug.MemoryInfo TOTAL PSS"),
      "nativeHeapBytes" to reading(memory.nativePss.toLong() * 1024, "Android Debug.MemoryInfo native heap PSS"),
      "gpuBytes" to mapOf("value" to null, "reason" to "Android exposes no complete process GPU allocation collector"))
  }

  @ReactMethod fun probe(path: String, promise: Promise) = execute(promise) { probeOutput(output(path)) }
  private fun probeOutput(file: File): Map<String, Any?> {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(file.absolutePath)
      var videoTrack = -1
      var audioTracks = 0
      for (index in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME).orEmpty()
        if (mime.startsWith("video/") && videoTrack < 0) videoTrack = index
        if (mime.startsWith("audio/")) audioTracks++
      }
      require(videoTrack >= 0) { "Output has no video track" }
      val format = extractor.getTrackFormat(videoTrack)
      val mime = format.getString(MediaFormat.KEY_MIME)!!
      val width = format.getInteger(MediaFormat.KEY_WIDTH)
      val height = format.getInteger(MediaFormat.KEY_HEIGHT)
      val rotation = if (format.containsKey(MediaFormat.KEY_ROTATION)) format.getInteger(MediaFormat.KEY_ROTATION) else 0
      val duration = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1e6 else 0.0
      var fps = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() else 0.0
      extractor.selectTrack(videoTrack)
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(format, null, null, 0); codec.start()
      val info = MediaCodec.BufferInfo()
      var inputEnded = false
      var outputEnded = false
      var count = 0
      var first = 0L
      var last = 0L
      var monotonic = true
      var exact = true
      var lastProgress = SystemClock.uptimeMillis()
      val deadline = lastProgress + 30000
      val intervals = ArrayList<Long>(128)
      while (!outputEnded) {
        require(!Thread.currentThread().isInterrupted) { "Output probe cancelled" }
        check(SystemClock.uptimeMillis() < deadline && SystemClock.uptimeMillis() - lastProgress < 15000) { "Output probe stalled" }
        if (!inputEnded) {
          val input = codec.dequeueInputBuffer(1000)
          if (input >= 0) {
            val buffer = codec.getInputBuffer(input)!!; buffer.clear()
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) { codec.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true }
            else { codec.queueInputBuffer(input, 0, size, extractor.sampleTime, 0); extractor.advance() }
            lastProgress = SystemClock.uptimeMillis()
          }
        }
        val index = codec.dequeueOutputBuffer(info, 1000)
        if (index >= 0) {
          if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
            val time = info.presentationTimeUs
            if (count == 0) first = time
            else {
              if (time <= last) monotonic = false
              if (time > last && intervals.size < 128) intervals.add(time - last)
            }
            if (fps > 0 && abs(time - count * 1e6 / fps) > 1000) exact = false
            last = time; count++
          }
          outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          codec.releaseOutputBuffer(index, false)
          lastProgress = SystemClock.uptimeMillis()
        } else if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) lastProgress = SystemClock.uptimeMillis()
      }
      require(count > 0) { "Output decoded no frames" }
      if (fps <= 0 && intervals.isNotEmpty()) {
        intervals.sort()
        val interval = intervals[intervals.size / 2]
        fps = 1e6 / interval
        exact = abs(first) <= 1000 && intervals.all { abs(it - interval) <= 1000 }
      }
      return mapOf("codec" to when (mime) { "video/avc" -> "h264"; "video/hevc" -> "hevc"; else -> mime },
        "width" to width, "height" to height, "fps" to fps, "duration" to duration,
        "rotation" to rotation, "frameCount" to count, "timestampsMonotonic" to monotonic,
        "presentationTimesExact" to exact, "firstPresentationTime" to first / 1e6,
        "lastPresentationTime" to last / 1e6, "audioTracks" to audioTracks)
    } finally {
      codec?.let { try { it.stop() } catch (_: Exception) {} finally { it.release() } }
      extractor.release()
    }
  }
}
