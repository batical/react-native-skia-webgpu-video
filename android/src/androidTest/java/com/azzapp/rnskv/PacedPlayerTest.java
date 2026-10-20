package com.azzapp.rnskv;

import static com.azzapp.rnskv.Compositions.MONTAGE;
import static com.azzapp.rnskv.Compositions.clipAt;
import static com.azzapp.rnskv.Compositions.composition;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.view.Choreographer;

import androidx.test.platform.app.InstrumentationRegistry;

import com.azzapp.rnskv.Compositions.Clip;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.bridge.ReactApplicationContext;

import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.File;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

/**
 * The preview collected as the app collects it: on the main thread, at every
 * vsync, with a React context to find the display. The extractor then
 * releases the decoded frames against the display's vsync, a vsync ahead,
 * rather than on its playback loop's tick. Eager and lazy.
 */
@RunWith(Parameterized.class)
public class PacedPlayerTest {

  private static final long PAUSED_SLACK_US = 1_000;

  private static final long PLAYING_SLACK_US = 250_000;

  @Parameterized.Parameters(name = "lazy={0}")
  public static List<Object[]> modes() {
    return Arrays.asList(new Object[][]{{false}, {true}});
  }

  private final boolean lazy;

  private static File video;

  private Player player;

  private Collector collector;

  public PacedPlayerTest(boolean lazy) {
    this.lazy = lazy;
  }

  @BeforeClass
  public static void writeVideo() throws Exception {
    File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
    video = TestVideo.write(new File(cache, "paced-player-test.mp4"), 6);
  }

  @Before
  public void setUp() throws Exception {
    Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    // Vsyncs only come while the screen is on.
    instrumentation.getUiAutomation().executeShellCommand("input keyevent KEYCODE_WAKEUP").close();
    installContext(new BridgeReactContext(instrumentation.getTargetContext()));
  }

  @After
  public void tearDown() throws Exception {
    if (collector != null) {
      collector.stop();
    }
    if (player != null) {
      List<String> errors = player.errors;
      player.close();
      assertTrue("player errors: " + errors, errors.isEmpty());
      assertFalse("a decoder thread outlived release()", Player.threadAlive());
    }
    installContext(null);
  }

  @Test
  public void playsThroughPacedAgainstTheDisplay() {
    open();
    player.extractor.play();
    awaitEvent("complete", 10_000);
    assertTrue("the frames were released on the playback loop's tick, not at vsync",
      (long) Compositions.get(player.extractor, "lastVsyncReleaseNanos") > 0);
    int checked = 0;
    for (Sample sample : collector.samples()) {
      double time = sample.positionUs / 1e6;
      Clip clip = clipAt(MONTAGE, time);
      if (clip == null || time - clip.compositionStart < 0.3 || clip.end() - time < 0.3) {
        continue;
      }
      Long shownUs = sample.timestampsUs.get(clip.id);
      long expectedUs = clip.sourceUs(time);
      assertTrue(clip.id + " at " + time + "s shows " + shownUs + "us, expected about " + expectedUs,
        shownUs != null && Math.abs(shownUs - expectedUs) <= PLAYING_SLACK_US);
      checked++;
    }
    assertTrue("only " + checked + " vsyncs checked", checked > 100);
    assertEquals(6.0, player.position(), 0.001);
    assertFalse(player.extractor.getIsPlaying());
  }

  /**
   * The point of the vsync release: a frame is collected on the first vsync at
   * or after its time, so its lag, from its composition time to that vsync's,
   * is under one period. The playback loop's 10 ms tick, out of phase with the
   * display, left it to chance.
   */
  @Test
  public void collectsMoreFramesOnTheirFirstVsyncThanTheTickDid() throws Exception {
    List<Long> paced = lagsOverAPlayThrough();
    long pacedPeriodUs = periodNanos() / 1000;
    player.close();
    assertTrue("player errors: " + player.errors, player.errors.isEmpty());
    player = null;
    collector = null;
    installContext(null);
    List<Long> ticked = lagsOverAPlayThrough();
    String distributions = "period " + pacedPeriodUs + "us\npaced " + paced + "\nticked " + ticked;
    // None ahead of its time: released for the next vsync, collected there.
    assertTrue("a frame collected before its time: " + distributions, paced.get(0) > -1_000);
    long pacedOnTime = onFirstVsync(paced, pacedPeriodUs);
    long tickedOnTime = onFirstVsync(ticked, pacedPeriodUs);
    assertTrue(pacedOnTime + " of " + paced.size() + " frames on their first vsync: " + distributions,
      pacedOnTime >= paced.size() * 95 / 100);
    assertTrue("a frame two vsyncs late: " + distributions,
      paced.get(paced.size() - 1) < 2 * pacedPeriodUs);
    assertTrue("paced " + pacedOnTime + "/" + paced.size() + " on their first vsync, ticked "
        + tickedOnTime + "/" + ticked.size() + ": " + distributions,
      pacedOnTime * ticked.size() > tickedOnTime * paced.size());
  }

  /** A frame is on its first vsync when that vsync came less than a period after its time. */
  private static long onFirstVsync(List<Long> lags, long periodUs) {
    // 1 ms for the clock read after the vsync, and the period's rounding.
    return lags.stream().filter(lag -> lag < periodUs + 1_000).count();
  }

  /** Each new frame's lag behind the vsync that collected it, sorted. */
  private List<Long> lagsOverAPlayThrough() {
    open();
    player.extractor.play();
    awaitEvent("complete", 10_000);
    collector.stop();
    List<Long> lags = new ArrayList<>();
    Map<String, Long> previous = new HashMap<>();
    for (Sample sample : collector.samples()) {
      double time = sample.vsyncPositionUs / 1e6;
      Clip clip = clipAt(MONTAGE, time);
      Long shownUs = sample.timestampsUs.get(clip != null ? clip.id : "");
      Long before = clip != null ? previous.put(clip.id, shownUs) : null;
      // Clear of the cuts, where a lazy item is still opening, and only
      // where a new frame arrives.
      if (clip == null || shownUs == null || shownUs.equals(before)
        || time - clip.compositionStart < 0.3 || clip.end() - time < 0.3) {
        continue;
      }
      long frameCompositionUs = TimeHelpers.secToUs(clip.compositionStart)
        + shownUs - TimeHelpers.secToUs(clip.start);
      lags.add(sample.vsyncPositionUs - frameCompositionUs);
    }
    assertTrue("only " + lags.size() + " new frames", lags.size() > 60);
    Collections.sort(lags);
    return lags;
  }

  @Test
  public void aPausedSeekShowsTheExactFrameInAnyOrder() {
    open();
    double[] times = {5.5, 0.5, 3.2, 1.9, 4.0, 2.0, 0.0, 5.95, 1.0, 3.999};
    for (double time : times) {
      player.seek(time);
      Clip clip = clipAt(MONTAGE, time);
      long expectedUs = clip.sourceUs(time);
      Map<String, VideoFrame> frames = awaitFrames(clip.id + " exact at " + time + "s", 3000, f -> {
        VideoFrame frame = f.get(clip.id);
        if (frame == null) {
          return false;
        }
        long actualUs = TimeHelpers.nsecToUs(frame.getTimestampNs());
        return actualUs <= expectedUs + PAUSED_SLACK_US
          && actualUs >= expectedUs - TestVideo.FRAME_US - PAUSED_SLACK_US;
      });
      Pixels.assertShowsItsFrame(clip.id + " at " + time + "s", frames.get(clip.id), TestVideo.FPS);
    }
  }

  @Test
  public void aSeekWhilePlayingPlaysOnFromThere() {
    open();
    player.extractor.play();
    SystemClock.sleep(500);
    player.seek(4.2);
    Clip c = MONTAGE[2];
    awaitFrames("c near 4.2s", 3000, frames -> {
      VideoFrame frame = frames.get("c");
      return player.position() >= 4.2 && frame != null
        && Math.abs(TimeHelpers.nsecToUs(frame.getTimestampNs()) - c.sourceUs(player.position())) < PLAYING_SLACK_US;
    });
    double after = player.position();
    assertTrue("position " + after + " after a seek to 4.2 s", after >= 4.2 && after < 5.2);
  }

  @Test
  public void aLoopWrapsToTheFirstItem() {
    open();
    player.extractor.setIsLooping(true);
    player.seek(5.5);
    player.extractor.play();
    Clip a = MONTAGE[0];
    awaitFrames("a after the wrap", 3000, frames -> {
      double position = player.position();
      VideoFrame frame = frames.get("a");
      return position > 0.3 && position < 1.5 && frame != null
        && Math.abs(TimeHelpers.nsecToUs(frame.getTimestampNs()) - a.sourceUs(position)) < PLAYING_SLACK_US;
    });
  }

  /**
   * A UI thread that stops collecting holds no codec buffer for long: after
   * 100 ms the playback loop releases on its tick again, and the first
   * collection after the stall shows a current frame, not one from before it.
   */
  @Test
  public void aStalledCollectorHandsTheReleaseBackToThePlaybackLoop() {
    open();
    player.extractor.play();
    SystemClock.sleep(300);
    collector.paused = true;
    SystemClock.sleep(1000);
    int before = collector.samples().size();
    collector.paused = false;
    awaitSamples(before + 1);
    Sample sample = collector.samples().get(before);
    double time = sample.positionUs / 1e6;
    Clip clip = clipAt(MONTAGE, time);
    Long shownUs = sample.timestampsUs.get(clip.id);
    assertTrue(clip.id + " shows " + shownUs + "us at " + time + "s right after the stall",
      shownUs != null && Math.abs(shownUs - clip.sourceUs(time)) <= PLAYING_SLACK_US);
  }

  /** No display found: the release stays on the playback loop's tick, as before pacing. */
  @Test
  public void withoutAContextThePlaybackLoopReleases() throws Exception {
    installContext(null);
    open();
    player.extractor.play();
    Clip a = MONTAGE[0];
    awaitFrames("a playing", 3000, frames -> {
      double position = player.position();
      VideoFrame frame = frames.get("a");
      return position > 0.5 && frame != null
        && Math.abs(TimeHelpers.nsecToUs(frame.getTimestampNs()) - a.sourceUs(position)) < PLAYING_SLACK_US;
    });
    assertEquals(0L, (long) Compositions.get(player.extractor, "lastVsyncReleaseNanos"));
  }

  @Test
  public void releaseStopsFollowingTheDisplay() throws Exception {
    open();
    player.extractor.play();
    awaitSamples(10);
    assertTrue("no display followed", Compositions.get(player.extractor, "vsyncPeriod") != null);
    collector.stop();
    collector = null;
    player.extractor.release();
    // The recorder lets the display go on its next vsync.
    long deadline = SystemClock.uptimeMillis() + 1000;
    while (Compositions.get(player.extractor, "vsyncPeriod") != null
      && SystemClock.uptimeMillis() < deadline) {
      SystemClock.sleep(16);
    }
    assertNull(Compositions.get(player.extractor, "vsyncPeriod"));
  }

  private void open() {
    player = new Player(composition(video, lazy, MONTAGE));
    collector = new Collector();
    collector.start();
  }

  private long periodNanos() {
    Object period = Compositions.get(player.extractor, "vsyncPeriod");
    assertTrue("no display followed", period != null);
    return ((DisplayVsyncPeriod) period).getPeriodNanos();
  }

  private Map<String, VideoFrame> awaitFrames(String what, long timeoutMs, Predicate<Map<String, VideoFrame>> check) {
    long deadline = SystemClock.uptimeMillis() + timeoutMs;
    Map<String, VideoFrame> frames = collector.latest.get();
    while (!check.test(frames)) {
      if (SystemClock.uptimeMillis() > deadline) {
        throw new AssertionError(what + " after " + timeoutMs + "ms, position "
          + player.position() + "s, frames " + Player.describe(frames) + ", events " + player.events);
      }
      SystemClock.sleep(8);
      frames = collector.latest.get();
    }
    return frames;
  }

  /** Player#awaitEvent collects on the test thread: here only the main thread collects. */
  private void awaitEvent(String name, long timeoutMs) {
    long deadline = SystemClock.uptimeMillis() + timeoutMs;
    while (!player.events.contains(name)) {
      assertTrue("no " + name + " event after " + timeoutMs + "ms, position " + player.position()
        + "s, events " + player.events, SystemClock.uptimeMillis() < deadline);
      SystemClock.sleep(10);
    }
  }

  private void awaitSamples(int count) {
    long deadline = SystemClock.uptimeMillis() + 3000;
    while (collector.samples().size() < count) {
      assertTrue("no vsync on the main thread", SystemClock.uptimeMillis() < deadline);
      SystemClock.sleep(8);
    }
  }

  private static void installContext(ReactApplicationContext context) throws Exception {
    Field field = ReactNativeSkiaVideoModule.class.getDeclaredField("reactApplicationContext");
    field.setAccessible(true);
    field.set(null, context);
  }

  /** What one vsync's collection saw. */
  private static final class Sample {
    final long positionUs;
    /** The position at the vsync, before the collection's own delay. */
    final long vsyncPositionUs;
    final Map<String, Long> timestampsUs;

    Sample(long positionUs, long vsyncPositionUs, Map<String, Long> timestampsUs) {
      this.positionUs = positionUs;
      this.vsyncPositionUs = vsyncPositionUs;
      this.timestampsUs = timestampsUs;
    }
  }

  /** Collects the frames on the main thread at every vsync, as the app's frame callback does. */
  private final class Collector implements Choreographer.FrameCallback {
    final AtomicReference<Map<String, VideoFrame>> latest = new AtomicReference<>(new HashMap<>());
    private final List<Sample> samples = Collections.synchronizedList(new ArrayList<>());
    volatile boolean paused;
    private volatile boolean running;

    void start() {
      running = true;
      InstrumentationRegistry.getInstrumentation().runOnMainSync(
        () -> Choreographer.getInstance().postFrameCallback(this));
    }

    void stop() {
      running = false;
      InstrumentationRegistry.getInstrumentation().runOnMainSync(
        () -> Choreographer.getInstance().removeFrameCallback(this));
    }

    List<Sample> samples() {
      synchronized (samples) {
        return new ArrayList<>(samples);
      }
    }

    @Override
    public void doFrame(long frameTimeNanos) {
      if (!running) {
        return;
      }
      if (!paused) {
        Map<String, VideoFrame> frames = player.frames();
        long positionUs = player.extractor.getCurrentPosition();
        long sinceVsyncUs = (System.nanoTime() - frameTimeNanos) / 1000;
        Map<String, Long> timestamps = new HashMap<>();
        frames.forEach((id, frame) -> timestamps.put(id, TimeHelpers.nsecToUs(frame.getTimestampNs())));
        latest.set(frames);
        samples.add(new Sample(positionUs, positionUs - sinceVsyncUs, timestamps));
      }
      Choreographer.getInstance().postFrameCallback(this);
    }
  }
}
