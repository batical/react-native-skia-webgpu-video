package com.azzapp.rnskv;
import org.junit.Test;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class BufferLifetimeTest {
  @Test public void budgetStaysReservedUntilBackingGcPhase() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    ByteBuffer backing = ByteBuffer.allocate(8);
    ByteBuffer exposed = ByteBuffer.allocate(8);
    lifetime.track(backing, null, 7);
    BufferLifetime.Tracked first = lifetime.track(exposed, backing, 0);
    first.enqueue(); lifetime.drain();
    assertTrue(released.isEmpty());
    assertEquals(1, lifetime.trackedCount());
    lifetime.onlyTracked().enqueue(); lifetime.drain();
    assertEquals(List.of(7L), released);
    assertEquals(0, lifetime.trackedCount());
  }
  @Test public void duplicateCleanupCannotDoubleRelease() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    BufferLifetime.Tracked reference = lifetime.track(ByteBuffer.allocate(8), null, 3);
    reference.enqueue(); lifetime.drain(); reference.enqueue(); lifetime.drain();
    assertEquals(List.of(3L), released);
  }
  @Test public void drainingKeepsOtherLiveBuffersAccounted() {
    List<Long> released = new ArrayList<>();
    BufferLifetime lifetime = new BufferLifetime(released::add);
    ByteBuffer kept = ByteBuffer.allocate(8);
    lifetime.track(kept, null, 1);
    lifetime.track(ByteBuffer.allocate(8), null, 2).enqueue(); lifetime.drain();
    assertEquals(List.of(2L), released);
    assertEquals(1, lifetime.trackedCount());
  }
}
