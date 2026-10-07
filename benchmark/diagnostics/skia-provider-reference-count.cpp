// Reproduce the factory ownership pattern in Skia 3.0.6 RNImageProvider.h
// using the installed Skia reference-count implementation. This isolates the
// ownership bug; it does not measure actual ImageProvider GPU allocations.
#include "include/core/SkRefCnt.h"
#include <cstdio>

struct Probe final : SkRefCnt {
  explicit Probe(int& destroyed) : destroyed(destroyed) {}
  ~Probe() override { ++destroyed; }
  int& destroyed;
};

int main() {
  int destroyed = 0;
  auto* raw = new Probe(destroyed);
  auto retained = sk_ref_sp(raw); // Same ownership pattern as ImageProvider::Make.
  if (retained->unique()) return 1;
  retained.reset();
  if (destroyed != 0) return 2;
  std::puts("sk_ref_sp(new T): object survives the final smart-pointer reset");
  raw->unref(); // Balance the orphaned construction reference for this test.
  if (destroyed != 1) return 3;

  auto adopted = sk_make_sp<Probe>(destroyed);
  if (!adopted->unique()) return 4;
  adopted.reset();
  if (destroyed != 2) return 5;
  std::puts("sk_make_sp<T>(): object is destroyed at the final smart-pointer reset");
}
