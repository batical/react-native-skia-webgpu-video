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
    catch (OutOfMemoryError expected) { assertEquals("backing failed", expected.getMessage()); }
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
}
