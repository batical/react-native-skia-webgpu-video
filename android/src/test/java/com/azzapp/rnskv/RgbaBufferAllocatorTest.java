package com.azzapp.rnskv;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class RgbaBufferAllocatorTest {
  @Test public void aliasFailureRemainsBudgetedUntilOwnerGc() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime, size -> 9, released::add,
      ByteBuffer::allocateDirect, bytes -> { throw new IllegalStateException("alias failed"); });
    try { allocator.allocate(64); fail("Expected alias failure"); }
    catch (IllegalStateException expected) { assertEquals("alias failed", expected.getMessage()); }
    assertTrue(released.isEmpty());
    assertEquals(1, lifetime.trackedCount());
    lifetime.onlyTracked().enqueue(); lifetime.drain();
    assertEquals(List.of(9L), released);
  }
  @Test public void backingAllocationFailureUsesPreRegisteredCleanup() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime, size -> 5, released::add,
      size -> { throw new OutOfMemoryError("backing failed"); }, bytes -> bytes);
    try { allocator.allocate(64); fail("Expected backing failure"); }
    catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("memory budget"));
      assertTrue(expected.getCause() instanceof OutOfMemoryError);
      assertEquals("backing failed", expected.getCause().getMessage());
    }
    assertTrue(released.isEmpty());
    lifetime.onlyTracked().enqueue(); lifetime.drain();
    assertEquals(List.of(5L), released);
  }
  @Test public void budgetRejectionOccursBeforeBackingAllocation() {
    BufferLifetime lifetime = new BufferLifetime(token -> fail("Unexpected release"));
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime,
      size -> { throw new IllegalStateException("budget exceeded"); }, token -> fail("Unexpected release"),
      size -> { fail("Backing must not be allocated"); return null; }, bytes -> bytes);
    try { allocator.allocate(64); fail("Expected budget rejection"); }
    catch (IllegalStateException expected) { assertEquals("budget exceeded", expected.getMessage()); }
    assertEquals(0, lifetime.trackedCount());
  }
  @Test public void heapGuardIncludesArtAlignmentAndCleanupHeadroom() {
    long mib = 1024L * 1024;
    // Refuse only an individually impossible backing, not currently occupied heap.
    RgbaBufferAllocator.checkAllocationCapacity((int) (240 * mib - 7), 256 * mib);
    try {
      RgbaBufferAllocator.checkAllocationCapacity((int) (240 * mib - 6), 256 * mib);
      fail("Expected ART heap rejection");
    } catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("headroom=16777216"));
    }
    // Smaller heaps retain one sixteenth, rather than a fixed 16 MiB deduction.
    RgbaBufferAllocator.checkAllocationCapacity((int) (60 * mib - 7), 64 * mib);
  }

  @Test public void heapGuardRejectsInvalidSizesAndAccountsLongArithmetic() {
    try { RgbaBufferAllocator.checkAllocationCapacity(0, 256); fail("Expected invalid size"); }
    catch (IllegalArgumentException expected) { }
    try { RgbaBufferAllocator.checkAllocationCapacity(Integer.MAX_VALUE, Integer.MAX_VALUE);
      fail("Expected aligned size rejection"); }
    catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("memory budget")); }
  }

  @Test public void heapRejectionHappensBeforeNativeReservation() {
    BufferLifetime lifetime = new BufferLifetime(token -> fail("Unexpected release"));
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime,
      size -> { fail("Native reservation must not be made"); return 0; },
      token -> fail("Unexpected release"), size -> { fail("Backing must not be allocated"); return null; },
      bytes -> bytes, size -> { throw new IllegalStateException("ART heap budget exceeded"); });
    try { allocator.allocate(64); fail("Expected heap rejection"); }
    catch (IllegalStateException expected) { assertEquals("ART heap budget exceeded", expected.getMessage()); }
    assertEquals(0, lifetime.trackedCount());
  }

  @Test public void aHeapRaceAfterReservationUsesTheExistingOwnerCleanup() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    java.util.concurrent.atomic.AtomicInteger checks = new java.util.concurrent.atomic.AtomicInteger();
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime, size -> 15, released::add,
      size -> { fail("Backing must not be allocated after the race"); return null; }, bytes -> bytes,
      size -> { if (checks.incrementAndGet() == 2) throw new IllegalStateException("Concurrent ART heap use"); });
    try { allocator.allocate(64); fail("Expected heap race rejection"); }
    catch (IllegalStateException expected) { assertEquals("Concurrent ART heap use", expected.getMessage()); }
    assertTrue(released.isEmpty());
    assertEquals(1, lifetime.trackedCount());
    lifetime.onlyTracked().enqueue(); lifetime.drain();
    assertEquals(List.of(15L), released);
  }

  @Test public void oneBackingRetryDrainsQueuedCleanupAndKeepsLiveAliases() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    Object dead = new Object(), live = new Object();
    BufferLifetime.Tracked queued = lifetime.track(dead, null, 2);
    lifetime.track(live, null, 3);
    java.util.concurrent.atomic.AtomicInteger allocations = new java.util.concurrent.atomic.AtomicInteger();
    java.util.concurrent.atomic.AtomicInteger reservations = new java.util.concurrent.atomic.AtomicInteger();
    java.util.concurrent.atomic.AtomicInteger aliases = new java.util.concurrent.atomic.AtomicInteger();
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime,
      size -> { reservations.incrementAndGet(); return 9; }, released::add,
      size -> {
        if (allocations.incrementAndGet() == 1) {
          queued.enqueue();
          throw new OutOfMemoryError("ART queued a dead root");
        }
        assertEquals(List.of(2L), released);
        ByteBuffer pixels = ByteBuffer.allocateDirect(size); pixels.put(0, (byte) 91); return pixels;
      }, pixels -> { aliases.incrementAndGet(); return pixels; });
    ByteBuffer pixels = allocator.allocate(64);
    assertEquals(91, pixels.get(0));
    assertEquals(2, allocations.get());
    assertEquals(1, reservations.get());
    assertEquals(1, aliases.get());
    assertEquals(List.of(2L), released); // token 3 remains owned by the unrelated live alias.
    assertEquals(3, lifetime.trackedCount()); // live alias, allocation owner, exposed root.
    assertNotNull(live); // keep the unrelated alias live through the assertions.
  }

  @Test public void persistentBackingOomAttemptsExactlyTwiceWithOnePendingToken() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    java.util.concurrent.atomic.AtomicInteger allocations = new java.util.concurrent.atomic.AtomicInteger();
    java.util.concurrent.atomic.AtomicInteger reservations = new java.util.concurrent.atomic.AtomicInteger();
    RgbaBufferAllocator allocator = new RgbaBufferAllocator(lifetime,
      size -> { reservations.incrementAndGet(); return 7; }, released::add,
      size -> { throw new OutOfMemoryError("attempt " + allocations.incrementAndGet()); },
      pixels -> { fail("Alias must not be created after failed allocation"); return null; });
    try { allocator.allocate(64); fail("Expected controlled allocation refusal"); }
    catch (IllegalStateException expected) {
      assertTrue(expected.getMessage().contains("attempts=2"));
      assertEquals("attempt 2", expected.getCause().getMessage());
    }
    assertEquals(2, allocations.get());
    assertEquals(1, reservations.get());
    assertTrue(released.isEmpty());
    assertEquals(1, lifetime.trackedCount());
    lifetime.onlyTracked().enqueue(); lifetime.drain();
    assertEquals(List.of(7L), released);
  }

}
