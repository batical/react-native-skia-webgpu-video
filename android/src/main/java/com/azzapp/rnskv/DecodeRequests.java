package com.azzapp.rnskv;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;

/** One synchronous decoder request at a time; errors also persist between requests. */
final class DecodeRequests<T> {
  private CompletableFuture<T> pending;
  private T completedResult;
  private boolean hasCompletedResult;
  private final Consumer<T> discard;
  private Exception failure;
  private boolean closed;

  DecodeRequests() { this(result -> {}); }

  DecodeRequests(Consumer<T> discard) { this.discard = discard; }

  synchronized CompletableFuture<T> begin() throws Exception {
    if (closed) throw new IllegalStateException("Video decoder has been released");
    if (failure != null) throw failure;
    if (pending != null) {
      throw new IllegalStateException("A video decode request is already pending");
    }
    pending = new CompletableFuture<>();
    return pending;
  }

  synchronized void fail(Exception error) {
    if (closed) return;
    if (failure == null) failure = error;
    if (pending != null) pending.completeExceptionally(failure);
    discardCompleted();
  }

  synchronized void complete(T result) {
    if (!closed && failure == null && pending != null && !pending.isDone()) {
      completedResult = result;
      hasCompletedResult = true;
      // Set ownership before waking waiters, including a synchronous completion
      // callback which may re-enter await on this same monitor.
      if (!pending.complete(result)) discardCompleted();
    } else {
      // Results racing cancellation, duplicate completions, or an absent
      // request never reach the consumer and must release their own aliases.
      discard.accept(result);
    }
  }

  synchronized boolean isPending() {
    return !closed && failure == null && pending != null && !pending.isDone();
  }

  synchronized boolean isClosed() { return closed; }

  synchronized void close() {
    closed = true;
    if (pending != null) pending.cancel(true);
    discardCompleted();
    pending = null;
  }

  private void discardCompleted() {
    if (!hasCompletedResult) return;
    T discarded = completedResult;
    completedResult = null;
    hasCompletedResult = false;
    discard.accept(discarded);
  }

  T await(CompletableFuture<T> request, long timeoutMs) throws Exception {
    try {
      T result = request.get(timeoutMs, TimeUnit.MILLISECONDS);
      synchronized (this) {
        // close/fail may run between Future.get and this ownership transfer.
        // Such a result has already been discarded and must not escape.
        if (closed) throw new CancellationException("Video decoder has been released");
        if (failure != null) throw new ExecutionException(failure);
        if (pending != request || !hasCompletedResult)
          throw new IllegalStateException("Video decode result was already consumed");
        completedResult = null;
        hasCompletedResult = false;
        pending = null;
        return result;
      }
    } catch (TimeoutException error) {
      fail(error);
      close();
      throw error;
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      close();
      throw error;
    }
  }
}
