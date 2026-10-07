package com.azzapp.rnskv;

import android.opengl.EGL14;
import android.opengl.EGLExt;
import android.view.Surface;

import java.util.function.Supplier;
import javax.microedition.khronos.egl.EGL10;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.egl.EGLContext;
import javax.microedition.khronos.egl.EGLDisplay;
import javax.microedition.khronos.egl.EGLSurface;

/** A session-owned EGL context. The display is process-owned and is never terminated here. */
public final class EGLResourcesHolder {
  private final EGL10 egl;
  private final EGLDisplay display;
  private final EGLContext context;
  private final EGLSurface surface;
  private boolean released;

  public static EGLResourcesHolder createWithWindowedSurface(EGLContext sharedContext, Surface surface) {
    return create(sharedContext, surface);
  }

  public static EGLResourcesHolder createWithPBBufferSurface(EGLContext sharedContext) {
    return create(sharedContext, null);
  }

  private static EGLResourcesHolder create(EGLContext sharedContext, Surface window) {
    EGL10 egl = (EGL10) EGLContext.getEGL();
    EGLDisplay display = egl.eglGetDisplay(EGL10.EGL_DEFAULT_DISPLAY);
    if (display == EGL10.EGL_NO_DISPLAY || !egl.eglInitialize(display, new int[2])) {
      throw new IllegalStateException("Could not initialize the video EGL display");
    }
    EGLContext context = EGL10.EGL_NO_CONTEXT;
    EGLSurface surface = EGL10.EGL_NO_SURFACE;
    try {
      int[] attributes = window == null ? new int[]{
        EGL10.EGL_RED_SIZE, 8, EGL10.EGL_GREEN_SIZE, 8, EGL10.EGL_BLUE_SIZE, 8,
        EGL10.EGL_ALPHA_SIZE, 8, EGL10.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL10.EGL_SURFACE_TYPE, EGL10.EGL_PBUFFER_BIT, EGL10.EGL_NONE
      } : new int[]{
        EGL10.EGL_RED_SIZE, 8, EGL10.EGL_GREEN_SIZE, 8, EGL10.EGL_BLUE_SIZE, 8,
        EGL10.EGL_ALPHA_SIZE, 8, EGL10.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL10.EGL_SURFACE_TYPE, EGL10.EGL_WINDOW_BIT,
        EGLUtils.EGL_RECORDABLE_ANDROID, 1, EGL10.EGL_NONE
      };
      EGLConfig[] configs = new EGLConfig[1];
      int[] count = new int[1];
      if (!egl.eglChooseConfig(display, attributes, configs, 1, count) || count[0] == 0) {
        throw new IllegalStateException("No video EGL config found");
      }
      context = egl.eglCreateContext(display, configs[0], sharedContext,
        new int[]{EGLUtils.EGL_CONTEXT_CLIENT_VERSION, 2, EGL10.EGL_NONE});
      if (context == EGL10.EGL_NO_CONTEXT) {
        throw new IllegalStateException("Could not create video EGL context");
      }
      surface = window == null
        ? egl.eglCreatePbufferSurface(display, configs[0],
          new int[]{EGL10.EGL_WIDTH, 1, EGL10.EGL_HEIGHT, 1, EGL10.EGL_NONE})
        : egl.eglCreateWindowSurface(display, configs[0], window, new int[]{EGL10.EGL_NONE});
      if (surface == EGL10.EGL_NO_SURFACE) {
        throw new IllegalStateException("Could not create video EGL surface");
      }
      return new EGLResourcesHolder(egl, display, context, surface);
    } catch (RuntimeException error) {
      if (surface != EGL10.EGL_NO_SURFACE) egl.eglDestroySurface(display, surface);
      if (context != EGL10.EGL_NO_CONTEXT) egl.eglDestroyContext(display, context);
      throw error;
    }
  }

  private EGLResourcesHolder(EGL10 egl, EGLDisplay display, EGLContext context, EGLSurface surface) {
    this.egl = egl;
    this.display = display;
    this.context = context;
    this.surface = surface;
  }

  public boolean makeCurrent() {
    if (released || !egl.eglMakeCurrent(display, surface, surface, context)) {
      throw new IllegalStateException("Could not bind video EGL context");
    }
    return true;
  }

  /** Always detach our context before returning, including when the caller has no EGL context. */
  public <T> T withContextCurrent(Supplier<T> action) {
    android.opengl.EGLDisplay previousDisplay = EGL14.eglGetCurrentDisplay();
    android.opengl.EGLContext previousContext = EGL14.eglGetCurrentContext();
    android.opengl.EGLSurface previousDraw = EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW);
    android.opengl.EGLSurface previousRead = EGL14.eglGetCurrentSurface(EGL14.EGL_READ);
    makeCurrent();
    try {
      return action.get();
    } finally {
      if (!EGL14.EGL_NO_CONTEXT.equals(previousContext)) {
        if (!EGL14.eglMakeCurrent(previousDisplay, previousDraw, previousRead, previousContext)) {
          throw new IllegalStateException("Could not restore the caller's EGL context");
        }
      } else if (!egl.eglMakeCurrent(display, EGL10.EGL_NO_SURFACE,
          EGL10.EGL_NO_SURFACE, EGL10.EGL_NO_CONTEXT)) {
        throw new IllegalStateException("Could not detach video EGL context");
      }
    }
  }

  public void runWithContextCurrent(Runnable action) {
    withContextCurrent(() -> { action.run(); return null; });
  }

  public boolean swapBuffers() { return egl.eglSwapBuffers(display, surface); }

  public void setPresentationTime(long nanoseconds) {
    if (!EGLExt.eglPresentationTimeANDROID(EGL14.eglGetCurrentDisplay(),
        EGL14.eglGetCurrentSurface(EGL14.EGL_DRAW), nanoseconds)) {
      throw new IllegalStateException("Could not timestamp video encoder surface");
    }
  }

  public void release() {
    if (released) return;
    if (egl.eglGetCurrentContext().equals(context)) {
      egl.eglMakeCurrent(display, EGL10.EGL_NO_SURFACE,
        EGL10.EGL_NO_SURFACE, EGL10.EGL_NO_CONTEXT);
    }
    egl.eglDestroySurface(display, surface);
    egl.eglDestroyContext(display, context);
    released = true;
  }
}
