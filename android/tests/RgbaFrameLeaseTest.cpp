#include "../cpp/RgbaFrameLease.h"
#include <array>
#include <cassert>
#include <iostream>
#include <vector>

using namespace RNSkiaVideo;

class Storage final : public RgbaFrameStorage {
 public:
  explicit Storage(size_t bytes, size_t visibleBytes = 0)
      : bytes_(bytes), visibleBytes_(visibleBytes ? visibleBytes : bytes) {
    for (size_t i = 0; i < bytes; ++i) bytes_[i] = static_cast<uint8_t>(i + 17);
  }
  size_t size() const override { return visibleBytes_; }
  uint8_t* data() override { return bytes_.data(); }
 private:
  std::vector<uint8_t> bytes_;
  size_t visibleBytes_;
};

int main() {
  {
    RgbaFrameLease frame(std::make_shared<Storage>(16));
    std::array<uint8_t, 24> destination{};
    frame.copyTo(destination.data(), destination.size());
    for (size_t i = 0; i < 16; ++i) assert(destination[i] == i + 17);
    for (size_t i = 16; i < destination.size(); ++i) assert(destination[i] == 0);
  }
  {
    RgbaFrameLease frame(std::make_shared<Storage>(16));
    std::array<uint8_t, 15> destination{};
    bool rejected = false;
    try { frame.copyTo(destination.data(), destination.size()); }
    catch (const std::invalid_argument&) { rejected = true; }
    assert(rejected);
    for (auto value : destination) assert(value == 0);
  }
  {
    RgbaFrameLease frame(std::make_shared<Storage>(16));
    bool rejected = false;
    try { frame.copyTo(nullptr, 16); }
    catch (const std::invalid_argument&) { rejected = true; }
    assert(rejected);
  }
  {
    auto saved = std::make_shared<Storage>(16);
    std::weak_ptr<Storage> allocation = saved;
    RgbaFrameLease frame(saved);
    frame.dispose(); frame.dispose();
    assert(!frame.storage());
    for (size_t i = 0; i < 16; ++i) assert(saved->data()[i] == i + 17);
    assert(!allocation.expired());
    saved.reset();
    assert(allocation.expired());
  }
  {
    auto storage = std::make_shared<Storage>(16);
    std::weak_ptr<Storage> allocation = storage;
    RgbaFrameLease frame(std::move(storage));
    frame.dispose();
    assert(allocation.expired());
    std::array<uint8_t, 16> destination{};
    bool rejected = false;
    try { frame.copyTo(destination.data(), destination.size()); }
    catch (const std::runtime_error&) { rejected = true; }
    assert(rejected);
    for (auto value : destination) assert(value == 0);
  }
  {
    auto storage = std::make_shared<Storage>(32, 16);
    RgbaFrameLease frame(storage);
    frame.copyTo(storage->data(), storage->size());
    for (size_t i = 0; i < 16; ++i) assert(storage->data()[i] == i + 17);
    frame.copyTo(storage->data() + 4, 28);
    for (size_t i = 0; i < 16; ++i) assert(storage->data()[i + 4] == i + 17);
  }
  std::cout << "6 RGBA frame lease tests passed\n";
}
