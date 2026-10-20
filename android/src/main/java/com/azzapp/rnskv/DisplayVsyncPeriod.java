package com.azzapp.rnskv;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.view.Display;

/**
 * The vsync period of a display, kept current as its refresh rate changes.
 *
 * Taken from the display rather than from the gaps between vsyncs: those
 * cannot tell a slower refresh rate from missed vsyncs, and an adaptive
 * display dropping from 90 or 120 Hz to 60 Hz left such an estimate at the
 * old rate.
 */
final class DisplayVsyncPeriod implements DisplayManager.DisplayListener {
  private final DisplayManager displayManager;
  private final Display display;
  private volatile long periodNanos;

  private DisplayVsyncPeriod(DisplayManager displayManager, Display display) {
    this.displayManager = displayManager;
    this.display = display;
    update();
  }

  /**
   * Follows the display's refresh rate changes on the calling thread's looper.
   *
   * @param display the display to follow, null for the default one
   * @return null when the display cannot be followed
   */
  static DisplayVsyncPeriod watch(Context context, Display display) {
    DisplayManager displayManager = context.getSystemService(DisplayManager.class);
    if (displayManager == null) return null;
    if (display == null) display = displayManager.getDisplay(Display.DEFAULT_DISPLAY);
    if (display == null) return null;
    DisplayVsyncPeriod period = new DisplayVsyncPeriod(displayManager, display);
    displayManager.registerDisplayListener(period, null);
    return period;
  }

  /**
   * @return the display's vsync period in nanoseconds, 0 when unknown
   */
  long getPeriodNanos() {
    return periodNanos;
  }

  void release() {
    displayManager.unregisterDisplayListener(this);
  }

  private void update() {
    float rate = display.getRefreshRate();
    periodNanos = rate > 0 ? (long) (1_000_000_000L / rate) : 0;
  }

  @Override
  public void onDisplayAdded(int displayId) {
  }

  @Override
  public void onDisplayRemoved(int displayId) {
  }

  @Override
  public void onDisplayChanged(int displayId) {
    if (displayId == display.getDisplayId()) {
      update();
    }
  }
}
