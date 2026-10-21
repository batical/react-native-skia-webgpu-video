package com.azzapp.rnskv;

import android.app.Activity;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;

import com.facebook.react.bridge.ReactApplicationContext;

import java.util.HashSet;
import java.util.Set;

/**
 * Asks the display for its highest refresh rate while a preview plays, through
 * the React Native Skia canvases of the activity (Android 15+). Main thread.
 *
 * Android picks the refresh rate from what the app presents. A preview that
 * presents at 30 fps for a while (30 fps frames drawn as they come) brings a
 * 60 Hz display down to 30 Hz, and it stays there: the next clip, at 60 or
 * 24 fps, can only present at 30 fps and never shows the display it needs
 * more. On a Pixel 8a, one 60 fps frame in two was never shown, and 24 fps
 * came out irregular on a fifth of its frames. A vote tells the display.
 *
 * Only views that draw cast their vote: one on the window's root view is never
 * counted. The player does not know which canvas shows it, so all of the Skia
 * TextureView canvases vote; those that do not draw cast nothing. SurfaceView
 * canvases vote for themselves, and the vote asks what theirs asks: the highest
 * rate a seamless switch reaches, 120 Hz where the user allows it, so that
 * what drawFrame animates over the video is not held to 60 Hz. Not the clips'
 * rate: a 24 fps vote brought the display to 30 Hz, where 24 fps judders.
 */
final class PreviewFrameRateVote {
  private static final String TAG = "PreviewFrameRateVote";

  private static final String SKIA_TEXTURE_VIEW = "com.reactnative.skia.SkiaTextureView";

  // Canvases mounted while playing get the vote at the next refresh.
  private static final long REFRESH_MILLIS = 1000;

  private static final Set<PreviewFrameRateVote> voting = new HashSet<>();

  private static long lastAppliedMillis = 0;

  /** Whether the player is playing, at each vsync it collects frames on. */
  void update(boolean playing) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      return;
    }
    if (playing ? voting.add(this) : voting.remove(this)) {
      apply();
    } else if (playing && SystemClock.uptimeMillis() - lastAppliedMillis >= REFRESH_MILLIS) {
      apply();
    }
  }

  /** The player is released. */
  void withdraw() {
    update(false);
  }

  private static void apply() {
    lastAppliedMillis = SystemClock.uptimeMillis();
    ReactApplicationContext context = ReactNativeSkiaVideoModule.currentReactApplicationContext();
    Activity activity = context != null ? context.getCurrentActivity() : null;
    if (activity == null || activity.getWindow() == null) {
      return;
    }
    float rate = voting.isEmpty() ? View.REQUESTED_FRAME_RATE_CATEGORY_DEFAULT
      : maxRefreshRate(activity.getWindow().getDecorView().getDisplay());
    try {
      vote(activity.getWindow().getDecorView(), rate);
    } catch (RuntimeException e) {
      Log.w(TAG, "Could not vote the refresh rate, leaving it to the display", e);
    }
  }

  // The highest rate a seamless switch from the current mode reaches.
  private static float maxRefreshRate(Display display) {
    if (display == null) {
      return View.REQUESTED_FRAME_RATE_CATEGORY_HIGH;
    }
    Display.Mode mode = display.getMode();
    float rate = mode.getRefreshRate();
    for (float alternative : mode.getAlternativeRefreshRates()) {
      rate = Math.max(rate, alternative);
    }
    return rate;
  }

  private static void vote(View view, float rate) {
    if (SKIA_TEXTURE_VIEW.equals(view.getClass().getName())) {
      view.setRequestedFrameRate(rate);
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        vote(group.getChildAt(i), rate);
      }
    }
  }
}
