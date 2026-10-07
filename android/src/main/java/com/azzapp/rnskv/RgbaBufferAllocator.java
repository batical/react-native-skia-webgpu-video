package com.azzapp.rnskv;
import java.nio.ByteBuffer;
import java.util.function.Function;
import java.util.function.IntFunction;
import java.util.function.IntConsumer;
import java.util.function.IntToLongFunction;
import java.util.function.LongConsumer;

/** Allocation transaction registers its budget owner before allocating any pixel storage. */
final class RgbaBufferAllocator {
  private final BufferLifetime lifetimes;
  private final IntToLongFunction reserve;
  private final LongConsumer release;
  private final IntFunction<ByteBuffer> allocateBacking;
  private final Function<ByteBuffer, ByteBuffer> alias;
  private final IntConsumer checkHeap;
  RgbaBufferAllocator(BufferLifetime lifetimes, IntToLongFunction reserve, LongConsumer release,
      IntFunction<ByteBuffer> allocateBacking, Function<ByteBuffer, ByteBuffer> alias) {
    this(lifetimes, reserve, release, allocateBacking, alias, size -> {});
  }
  RgbaBufferAllocator(BufferLifetime lifetimes, IntToLongFunction reserve, LongConsumer release,
      IntFunction<ByteBuffer> allocateBacking, Function<ByteBuffer, ByteBuffer> alias, IntConsumer checkHeap) {
    this.lifetimes = lifetimes; this.reserve = reserve; this.release = release;
    this.allocateBacking = allocateBacking; this.alias = alias; this.checkHeap = checkHeap;
  }

  /** Refuse a single backing too large for ART's heap and cleanup headroom.
   * Do not subtract currently occupied heap: allocateDirect must be allowed to
   * trigger ART's natural GC and reclaim unreachable backing owners. A free-heap
   * precheck would stop streaming before that GC, leaving reclaimable buffers live.
   * The native quota and narrow allocation-OOM catch remain the actual limits. */
  static void checkAllocationCapacity(int size, long maxHeap) {
    if (size <= 0) throw new IllegalArgumentException("Invalid RGBA allocation size");
    if (maxHeap <= 0) throw new IllegalStateException("Android heap capacity is unavailable");
    long headroom = Math.min(16L * 1024 * 1024, maxHeap / 16);
    long available = Math.max(0, maxHeap - headroom);
    if ((long) size + 7 > available) {
      throw new IllegalStateException("Android RGBA memory budget exceeds single-allocation Java heap capacity; "
        + "reduce maxLongSide or use lazyDecoders (requested=" + ((long) size + 7)
        + ", available=" + available + ", headroom=" + headroom + ")");
    }
  }

  ByteBuffer allocate(int size) {
    lifetimes.drain();
    checkHeap.accept(size);
    long token = reserve.applyAsLong(size);
    Allocation owner;
    try {
      owner = new Allocation();
      // Pre-register before the large allocation. Alias/registration failures
      // remain accounted until this owner and its backing have been collected.
      lifetimes.track(owner, null, token);
    } catch (Throwable error) {
      // No pixel backing has been allocated at this point.
      release.accept(token);
      throw error;
    }
    // Re-check any injected capacity policy after the reservation; concurrent heap
    // use itself is handled by ART allocation/GC and the narrow OOM catch below.
    checkHeap.accept(size);
    try {
      owner.backing = allocateBacking.apply(size);
    } catch (OutOfMemoryError error) {
      // Catch only backing allocation. No backing or pixel alias escaped.
      // The already registered owner releases its quota after GC; error paths
      // never decrement a reservation for memory that could still be live.
      throw new IllegalStateException("Android RGBA memory budget exhausted during allocation; "
        + "reduce maxLongSide or use lazyDecoders (requested=" + size + ")", error);
    }
    ByteBuffer exposed = alias.apply(owner.backing);
    lifetimes.track(exposed, owner, 0);
    return exposed;
  }
  private static final class Allocation { ByteBuffer backing; }
}
