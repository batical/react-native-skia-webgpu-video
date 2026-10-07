// The runner injects the factory body from the installed RNImageProvider.h.
// The real SkRefCnt implementation is used with a destructor-counting payload;
// this tests factory ownership without requiring a GPU context on the host.
#include "include/core/SkRefCnt.h"

class ImageProvider final : public SkRefCnt {
public:
  ImageProvider() { ++alive; }
  ~ImageProvider() override { --alive; }
  static inline int alive = 0;
  static sk_sp<ImageProvider> Make() { /* INSTALLED_FACTORY_BODY */ }
};

int main() {
  auto provider = ImageProvider::Make();
  if (!provider || !provider->unique() || ImageProvider::alive != 1) return 1;
  auto alias = provider;
  provider.reset();
  if (!alias->unique() || ImageProvider::alive != 1) return 2;
  alias.reset();
  if (ImageProvider::alive != 0) return 3;
  return 0;
}
