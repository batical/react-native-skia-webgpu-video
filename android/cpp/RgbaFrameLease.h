#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace RNSkiaVideo {

struct RgbaFrameStorage {
  virtual ~RgbaFrameStorage() = default;
  virtual size_t size() const = 0;
  virtual uint8_t* data() = 0;
};

// Closing a frame drops its own storage root. Explicit external aliases may
// still hold the same immutable allocation, and keep it alive independently.
class RgbaFrameLease final {
 public:
  explicit RgbaFrameLease(std::shared_ptr<RgbaFrameStorage> storage)
      : storage_(std::move(storage)) {
    if (!storage_ || !storage_->data() || storage_->size() == 0)
      throw std::invalid_argument("Invalid RGBA frame storage");
  }

  std::shared_ptr<RgbaFrameStorage> storage() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return storage_;
  }

  void copyTo(uint8_t* destination, size_t capacity) const {
    auto source = storage();
    if (!source) throw std::runtime_error("RGBA video frame is disposed");
    if (!destination || capacity < source->size())
      throw std::invalid_argument("RGBA copy destination is too small");
    // An explicit consumer may pass a retained source alias as destination.
    // memmove also handles that overlap without undefined behavior.
    std::memmove(destination, source->data(), source->size());
  }

  void dispose() {
    std::lock_guard<std::mutex> lock(mutex_);
    storage_.reset();
  }

 private:
  mutable std::mutex mutex_;
  std::shared_ptr<RgbaFrameStorage> storage_;
};

} // namespace RNSkiaVideo
