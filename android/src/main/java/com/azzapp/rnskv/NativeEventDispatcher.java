package com.azzapp.rnskv;

public class NativeEventDispatcher {

  private long eventReceiver;


  public NativeEventDispatcher(long eventReceiver) {
    this.eventReceiver = eventReceiver;
  }

  public synchronized void dispatchEvent(String eventName, Object data) {
    if (eventReceiver != 0) nativeDispatchEvent(eventReceiver, eventName, data);
  }

  // Synchronizes with an in-flight JNI callback before its C++ receiver dies.
  public synchronized void invalidate() {
    if (eventReceiver != 0) nativeInvalidateReceiver(eventReceiver);
    eventReceiver = 0;
  }

  private static native void nativeDispatchEvent(long eventReceiver, String eventName, Object data);
  private static native void nativeInvalidateReceiver(long eventReceiver);

}
