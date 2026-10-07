#include "RNSVMemoryBudget.h"
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

using namespace RNSkiaVideo;

int main() {
  auto& budget = MemoryBudget::instance();
  assert(budget.snapshot().currentBytes == 0);
  budget.configure(1024);
  int firstOwner, secondOwner;
  auto first = budget.reserve(512, "first", &firstOwner);
  bool rejected = false;
  try { budget.reserve(513, "over budget"); }
  catch (const std::runtime_error&) { rejected = true; }
  assert(rejected && budget.snapshot().currentBytes == 512);
  auto second = budget.reserve(256, "second", &secondOwner);
  budget.resize(first, 700, "aligned storage");
  assert(budget.snapshot().currentBytes == 956);
  rejected = false;
  try { budget.resize(first, 800, "rejected aligned storage"); }
  catch (const std::runtime_error&) { rejected = true; }
  assert(rejected && budget.snapshot().currentBytes == 956);
  budget.resize(first, 512, "smaller storage");
  budget.releaseOwner(&firstOwner);
  budget.release(first); // idempotent after owner cleanup
  assert(budget.snapshot().currentBytes == 256);
  budget.release(second);
  budget.release(second);
  try { MemoryReservation allocation(300, "exception path"); throw 1; }
  catch (int) {}
  assert(budget.snapshot().currentBytes == 0);

  std::vector<std::thread> workers;
  for (int worker = 0; worker < 8; ++worker) {
    workers.emplace_back([&budget] {
      for (int iteration = 0; iteration < 5000; ++iteration) {
        MemoryReservation allocation(16, "concurrent reservation");
      }
    });
  }
  for (auto& worker : workers) worker.join();
  assert(budget.snapshot().currentBytes == 0);
  assert(budget.snapshot().allocations == 0);
  budget.configure(256ULL * 1024 * 1024);
  std::cout << "{\"test\":\"native-memory-budget\",\"concurrentReservations\":40000,"
               "\"trackedCurrentBytes\":0,\"allocationFailureRollback\":true}\n";
}
