package com.azzapp.rnskv;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.ArrayList;
import java.util.List;

public class DecodeRequestsTest {
  @Test public void preservesCodecErrorBeforeFirstFrameRequest() throws Exception {
    DecodeRequests<String> requests = new DecodeRequests<>();
    Exception codec = new IllegalStateException("codec startup failed");
    requests.fail(codec);
    try { requests.begin(); fail("Expected original startup error"); }
    catch (Exception failure) { assertSame(codec, failure); }
  }

  @Test(timeout = 1000) public void closeUnblocksAnActuallyWaitingThread() throws Exception {
    DecodeRequests<String> requests = new DecodeRequests<>();
    CompletableFuture<String> request = requests.begin();
    CompletableFuture<Throwable> observed = new CompletableFuture<>();
    Thread waiter = new Thread(() -> {
      try { requests.await(request, 10000); observed.complete(null); }
      catch (Exception error) { observed.complete(error); }
    });
    waiter.start();
    requests.close();
    waiter.join(500);
    assertFalse(waiter.isAlive());
    assertTrue(observed.get() instanceof CancellationException);
    requests.complete("late frame");
    assertTrue(request.isCancelled());
    try { requests.begin(); fail("Closed decoder was reopened"); }
    catch (IllegalStateException expected) { /* Closed forever. */ }
  }

  @Test(timeout = 1000) public void stalledDecodeTerminatesAndCannotAllocateAgain() throws Exception {
    DecodeRequests<String> requests = new DecodeRequests<>();
    CompletableFuture<String> request = requests.begin();
    try { requests.await(request, 10); fail("Expected bounded wait"); }
    catch (TimeoutException expected) { /* No permanent Worklet stall. */ }
    assertTrue(requests.isClosed());
    try { requests.begin(); fail("Timed-out decoder reopened"); }
    catch (IllegalStateException expected) { /* Terminal state. */ }
  }

  @Test public void failedActiveRequestReturnsOriginalErrorAndBlocksNewRequests() throws Exception {
    DecodeRequests<String> requests = new DecodeRequests<>();
    CompletableFuture<String> request = requests.begin();
    Exception codec = new IllegalStateException("codec lost while decoding");
    requests.fail(codec);
    try { requests.await(request, 1000); fail("Expected codec error"); }
    catch (ExecutionException failure) { assertSame(codec, failure.getCause()); }
    try { requests.begin(); fail("Failed decoder accepted another request"); }
    catch (Exception failure) { assertSame(codec, failure); }
  }

  @Test public void sequentialRequestsDoNotRetainPreviousFrameOrAcceptConcurrentRequests() throws Exception {
    DecodeRequests<String> requests = new DecodeRequests<>();
    CompletableFuture<String> first = requests.begin();
    try { requests.begin(); fail("Concurrent request was accepted"); }
    catch (IllegalStateException expected) { /* First request stays active. */ }
    requests.complete("first");
    assertEquals("first", requests.await(first, 1000));
    CompletableFuture<String> second = requests.begin();
    assertNotSame(first, second);
    assertFalse(second.isDone());
    requests.complete("second");
    assertEquals("second", requests.await(second, 1000));
  }

  @Test public void completedButUnclaimedFramesAreClosedExactlyOnceOnCancellation() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> request = requests.begin();
    requests.complete("ready frame");
    assertFalse(requests.isPending());
    try { requests.begin(); fail("Unclaimed result was replaced"); }
    catch (IllegalStateException expected) { }
    requests.close();
    requests.close();
    assertEquals(List.of("ready frame"), discarded);
    try { requests.await(request, 1000); fail("Closed frame escaped"); }
    catch (CancellationException expected) { }
  }

  @Test public void deliveredFramesRemainOwnedByTheirConsumerAfterDecoderClose() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> request = requests.begin();
    requests.complete("retained frame");
    assertEquals("retained frame", requests.await(request, 1000));
    requests.close();
    assertTrue(discarded.isEmpty());
  }

  @Test public void lateAndDuplicateCompletionsReleaseOnlyUndeliverableFrames() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    requests.complete("no request");
    CompletableFuture<String> request = requests.begin();
    assertTrue(requests.isPending());
    requests.complete("delivered");
    requests.complete("duplicate");
    assertEquals("delivered", requests.await(request, 1000));
    requests.close();
    requests.complete("after close");
    assertEquals(List.of("no request", "duplicate", "after close"), discarded);
  }

  @Test public void codecFailureClosesReadyButUnclaimedFrameAndPreservesError() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> request = requests.begin();
    requests.complete("ready frame");
    Exception codec = new IllegalStateException("codec failed before handoff");
    requests.fail(codec);
    requests.close();
    assertEquals(List.of("ready frame"), discarded);
    // Without close, await reports the persistent codec error even though the
    // Future itself had already completed successfully.
    DecodeRequests<String> failed = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> ready = failed.begin();
    failed.complete("second ready frame");
    failed.fail(codec);
    try { failed.await(ready, 1000); fail("Discarded frame escaped"); }
    catch (ExecutionException error) { assertSame(codec, error.getCause()); }
    failed.close();
    assertEquals(List.of("ready frame", "second ready frame"), discarded);
  }

  @Test public void ownershipIsReadyBeforeAReentrantFutureCompletionCallback() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> request = requests.begin();
    CompletableFuture<String> claimed = request.thenApply(value -> {
      try { return requests.await(request, 1000); }
      catch (Exception error) { throw new RuntimeException(error); }
    });
    requests.complete("reentrant");
    assertEquals("reentrant", claimed.get());
    requests.close();
    assertTrue(discarded.isEmpty());
  }

  @Test public void aResultArrivingAfterTimeoutReleasesItsAliases() throws Exception {
    List<String> discarded = new ArrayList<>();
    DecodeRequests<String> requests = new DecodeRequests<>(discarded::add);
    CompletableFuture<String> request = requests.begin();
    try { requests.await(request, 1); fail("Expected timeout"); }
    catch (TimeoutException expected) { }
    requests.complete("late frame");
    assertEquals(List.of("late frame"), discarded);
  }
}
