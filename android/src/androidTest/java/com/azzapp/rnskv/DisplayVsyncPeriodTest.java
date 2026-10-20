package com.azzapp.rnskv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assume.assumeTrue;

import android.app.UiAutomation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.Display;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The vsync period the preview releases frames against follows the display's
 * refresh rate, down as well as up. Forces the rate through the system
 * settings; skipped on a display with a single rate.
 */
@RunWith(AndroidJUnit4.class)
public class DisplayVsyncPeriodTest {
  private static final long TOLERANCE_NANOS = 100_000;
  private static final long SETTLE_MS = 3000;

  private Context context;
  private Display display;
  private HandlerThread looper;
  private DisplayVsyncPeriod period;
  private String minRefreshRate;
  private String peakRefreshRate;

  @Before
  public void setUp() throws Exception {
    context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    display = context.getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
    minRefreshRate = shell("settings get system min_refresh_rate");
    peakRefreshRate = shell("settings get system peak_refresh_rate");
    // Display modes only change while the screen is on.
    shell("input keyevent KEYCODE_WAKEUP");
    looper = new HandlerThread("test-display");
    looper.start();
  }

  @After
  public void tearDown() throws Exception {
    if (period != null) onLooper(period::release);
    looper.quitSafely();
    restore("min_refresh_rate", minRefreshRate);
    restore("peak_refresh_rate", peakRefreshRate);
  }

  @Test
  public void periodIsTheDisplayRefreshRate() throws Exception {
    period = watch(display);
    assertNotNull(period);
    assertPeriod(display.getRefreshRate(), period.getPeriodNanos());
  }

  @Test
  public void nullDisplayFollowsTheDefaultDisplay() throws Exception {
    period = watch(null);
    assertNotNull(period);
    assertPeriod(display.getRefreshRate(), period.getPeriodNanos());
  }

  // The estimate this replaced stayed at the high rate: every 60 Hz gap looked
  // like a missed vsync.
  @Test
  public void followsADropFromTheHighestRateTo60Hz() throws Exception {
    float high = highestRate();
    forceRate(high);
    period = watch(display);
    assertPeriod(high, awaitPeriod(high));
    forceRate(60);
    assertPeriod(60, awaitPeriod(60));
  }

  @Test
  public void followsARiseFrom60HzToTheHighestRate() throws Exception {
    float high = highestRate();
    forceRate(60);
    period = watch(display);
    assertPeriod(60, awaitPeriod(60));
    forceRate(high);
    assertPeriod(high, awaitPeriod(high));
  }

  @Test
  public void stopsFollowingOnceReleased() throws Exception {
    float high = highestRate();
    forceRate(high);
    period = watch(display);
    assertPeriod(high, awaitPeriod(high));
    onLooper(period::release);
    forceRate(60);
    awaitDisplayRate(60);
    // Let a late display event reach the looper, were it still listening.
    onLooper(() -> {});
    assertPeriod(high, period.getPeriodNanos());
    period = null;
  }

  private DisplayVsyncPeriod watch(Display display) throws Exception {
    AtomicReference<DisplayVsyncPeriod> watched = new AtomicReference<>();
    onLooper(() -> watched.set(DisplayVsyncPeriod.watch(context, display)));
    return watched.get();
  }

  private void onLooper(Runnable runnable) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    new Handler(looper.getLooper()).post(() -> {
      runnable.run();
      done.countDown();
    });
    assertEquals(true, done.await(5, TimeUnit.SECONDS));
  }

  private float highestRate() {
    float highest = 0;
    boolean has60 = false;
    for (Display.Mode mode : display.getSupportedModes()) {
      highest = Math.max(highest, mode.getRefreshRate());
      has60 |= Math.abs(mode.getRefreshRate() - 60) < 1;
    }
    assumeTrue("needs a display that runs at 60 Hz and above", has60 && highest > 61);
    return highest;
  }

  private void forceRate(float rate) throws Exception {
    shell("settings put system min_refresh_rate " + rate);
    shell("settings put system peak_refresh_rate " + rate);
  }

  private void awaitDisplayRate(float rate) {
    long deadline = SystemClock.uptimeMillis() + SETTLE_MS;
    while (Math.abs(display.getRefreshRate() - rate) > 1 && SystemClock.uptimeMillis() < deadline) {
      SystemClock.sleep(20);
    }
    assertEquals(rate, display.getRefreshRate(), 1);
  }

  private long awaitPeriod(float rate) {
    long expected = expectedPeriod(rate);
    long deadline = SystemClock.uptimeMillis() + SETTLE_MS;
    while (Math.abs(period.getPeriodNanos() - expected) > TOLERANCE_NANOS
        && SystemClock.uptimeMillis() < deadline) {
      SystemClock.sleep(20);
    }
    return period.getPeriodNanos();
  }

  private static void assertPeriod(float rate, long periodNanos) {
    assertEquals(expectedPeriod(rate), periodNanos, TOLERANCE_NANOS);
  }

  private static long expectedPeriod(float rate) {
    return (long) (1_000_000_000L / rate);
  }

  private void restore(String key, String value) throws Exception {
    shell(value == null || value.isEmpty() || value.equals("null")
      ? "settings delete system " + key
      : "settings put system " + key + " " + value);
  }

  private static String shell(String command) throws IOException {
    UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    ParcelFileDescriptor output = automation.executeShellCommand(command);
    try (InputStream in = new FileInputStream(output.getFileDescriptor())) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[256];
      for (int read; (read = in.read(buffer)) != -1; ) bytes.write(buffer, 0, read);
      return bytes.toString().trim();
    } finally {
      output.close();
    }
  }
}
