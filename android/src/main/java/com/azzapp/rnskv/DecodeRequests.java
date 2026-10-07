package com.azzapp.rnskv;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** One synchronous decoder request at a time; errors also persist between requests. */
final class DecodeRequests<T> {
  private CompletableFuture<T> pending;
  private Exception failure;
  private boolean closed;

  synchronized CompletableFuture<T> begin() throws Exception {
    if (closed) throw new IllegalStateException("Video decoder has been released");
    if (failure != null) throw failure;
    if (pending != null && !pending.isDone()) {
      throw new IllegalStateException("A video decode request is already pending");
    }
    pending = new CompletableFuture<>();
    return pending;
  }

  synchronized void fail(Exception error) {
    if (closed) return;
    if (failure == null) failure = error;
    if (pending != null) pending.completeExceptionally(failure);
  }

  synchronized void complete(T result) {
    if (!closed && pending != null) pending.complete(result);
  }

  synchronized boolean isClosed() { return closed; }

  synchronized void close() {
    closed = true;
    if (pending != null) pending.cancel(true);
  }

  T await(CompletableFuture<T> request, long timeoutMs) throws Exception {
    try {
      return request.get(timeoutMs, TimeUnit.MILLISECONDS);
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
