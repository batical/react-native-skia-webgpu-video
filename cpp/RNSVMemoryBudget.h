#pragma once

#include <cstdint>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace facebook::jsi { class Runtime; class Object; }

namespace RNSkiaVideo {

// Shared by all worklet runtimes. This accounts owned resources, not the
// opaque caches allocated internally by the graphics driver or media codec.
class MemoryBudget {
public:
  struct Snapshot {
    uint64_t currentBytes, peakBytes, allocations, maxBytes;
  };
  static MemoryBudget& instance() {
    static MemoryBudget budget;
    return budget;
  }
  uint64_t reserve(uint64_t bytes, const std::string& label,
                   const void* owner = nullptr) {
    std::lock_guard<std::mutex> lock(mutex);
    if (bytes == 0 || bytes > maxBytes || currentBytes > maxBytes - bytes) {
      throw std::runtime_error("Video memory budget exceeded: " + label);
    }
    if (nextToken >= 9007199254740991ULL) {
      throw std::runtime_error("Video memory reservation identifiers exhausted");
    }
    const auto token = nextToken++;
    reservations.emplace(token, Reservation{bytes, owner});
    currentBytes += bytes;
    if (currentBytes > peakBytes) peakBytes = currentBytes;
    return token;
  }
  void release(uint64_t token) {
    std::lock_guard<std::mutex> lock(mutex);
    const auto found = reservations.find(token);
    if (found == reservations.end()) return;
    currentBytes -= found->second.bytes;
    reservations.erase(found);
  }
  void resize(uint64_t token, uint64_t bytes, const std::string& label) {
    std::lock_guard<std::mutex> lock(mutex);
    auto found = reservations.find(token);
    if (found == reservations.end()) throw std::runtime_error("Unknown video memory reservation");
    auto remaining = currentBytes - found->second.bytes;
    if (bytes == 0 || bytes > maxBytes || remaining > maxBytes - bytes)
      throw std::runtime_error("Video memory budget exceeded: " + label);
    found->second.bytes = bytes;
    currentBytes = remaining + bytes;
    if (currentBytes > peakBytes) peakBytes = currentBytes;
  }
  void releaseOwner(const void* owner) {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto it = reservations.begin(); it != reservations.end();) {
      if (it->second.owner == owner) {
        currentBytes -= it->second.bytes;
        it = reservations.erase(it);
      } else ++it;
    }
  }
  void configure(uint64_t bytes) {
    std::lock_guard<std::mutex> lock(mutex);
    if (bytes == 0 || bytes < currentBytes) {
      throw std::runtime_error("Video memory limit is below current reservations");
    }
    maxBytes = bytes;
  }
  Snapshot snapshot() {
    std::lock_guard<std::mutex> lock(mutex);
    return {currentBytes, peakBytes, reservations.size(), maxBytes};
  }
  static void install(facebook::jsi::Runtime&, facebook::jsi::Object&);

private:
  struct Reservation { uint64_t bytes; const void* owner; };
  std::mutex mutex;
  std::unordered_map<uint64_t, Reservation> reservations;
  uint64_t nextToken = 1;
  uint64_t currentBytes = 0, peakBytes = 0;
  uint64_t maxBytes = 256ULL * 1024 * 1024;
};

// Use for C++ owned buffers. Reservations are returned even on exceptions.
class MemoryReservation {
public:
  MemoryReservation(uint64_t bytes, const std::string& label)
      : token(MemoryBudget::instance().reserve(bytes, label)) {}
  ~MemoryReservation() { MemoryBudget::instance().release(token); }
  MemoryReservation(const MemoryReservation&) = delete;
  MemoryReservation& operator=(const MemoryReservation&) = delete;
private:
  uint64_t token;
};
} // namespace RNSkiaVideo
