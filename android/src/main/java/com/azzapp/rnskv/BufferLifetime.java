package com.azzapp.rnskv;

import java.lang.ref.PhantomReference;
import java.lang.ref.ReferenceQueue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongConsumer;

/** Pre-registered backing owner and exposed JNI root: no cleanup allocation is needed during GC. */
final class BufferLifetime {
  private final ReferenceQueue<Object> queue = new ReferenceQueue<>();
  private final Set<Tracked> references = ConcurrentHashMap.newKeySet();
  private final LongConsumer release;

  BufferLifetime(LongConsumer release) { this.release = release; }

  Tracked track(Object exposed, Object backing, long token) {
    Tracked tracked = new Tracked(exposed, backing, token);
    references.add(tracked);
    return tracked;
  }

  void drain() {
    Tracked reference;
    while ((reference = (Tracked) queue.poll()) != null) process(reference);
  }

  void run() {
    for (;;) {
      try { process((Tracked) queue.remove()); }
      catch (InterruptedException ignored) { /* Process-wide daemon has no application owner. */ }
    }
  }

  private void process(Tracked reference) {
    if (!references.remove(reference)) return;
    reference.backing = null;
    reference.clear();
    if (reference.token != 0) release.accept(reference.token);
  }

  int trackedCount() { return references.size(); }
  // Only package tests use this to enqueue a second-phase reference without relying on GC timing.
  Tracked onlyTracked() { return references.iterator().next(); }

  final class Tracked extends PhantomReference<Object> {
    private Object backing;
    private final long token;
    Tracked(Object referent, Object backing, long token) {
      super(referent, queue);
      this.backing = backing;
      this.token = token;
    }
  }
}
