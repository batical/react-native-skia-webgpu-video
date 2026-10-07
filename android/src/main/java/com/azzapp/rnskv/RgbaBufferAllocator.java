package com.azzapp.rnskv;
import java.nio.ByteBuffer;
import java.util.function.Function;
import java.util.function.IntFunction;
import java.util.function.IntToLongFunction;
import java.util.function.LongConsumer;

/** Allocation transaction registers its budget owner before allocating any pixel storage. */
final class RgbaBufferAllocator {
  private final BufferLifetime lifetimes;
  private final IntToLongFunction reserve;
  private final LongConsumer release;
  private final IntFunction<ByteBuffer> allocateBacking;
  private final Function<ByteBuffer, ByteBuffer> alias;
  RgbaBufferAllocator(BufferLifetime lifetimes, IntToLongFunction reserve, LongConsumer release,
      IntFunction<ByteBuffer> allocateBacking, Function<ByteBuffer, ByteBuffer> alias) {
    this.lifetimes = lifetimes; this.reserve = reserve; this.release = release;
    this.allocateBacking = allocateBacking; this.alias = alias;
  }
  ByteBuffer allocate(int size) {
    lifetimes.drain();
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
    owner.backing = allocateBacking.apply(size);
    ByteBuffer exposed = alias.apply(owner.backing);
    lifetimes.track(exposed, owner, 0);
    return exposed;
  }
  private static final class Allocation { ByteBuffer backing; }
}
