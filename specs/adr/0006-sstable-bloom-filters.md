# [ADR-0006] Probabilistic Bloom Filters for SSTable Read Amplification Reduction

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: InTheRuntime Team
- **Deciders**: Engineering Lead, System Architect
- **Consulted**: Core Engineers

---

## Context and Problem Statement

In `itr-lsm` (ADR-0005), point lookups (`get(key)`) search the MemTable and then inspect immutable SSTables from newest to oldest. While `min_key`/`max_key` fences skip SSTables whose overall key range does not overlap the target key, **queries for non-existent keys whose lexicographical order falls inside `[min_key, max_key]` still incur a binary search and a disk seek (`seek` + stride read) on every overlapping SSTable**.

For read-heavy workloads with high miss ratios (existence checks, cache-aside fallbacks, sparse user lookups), this Read Amplification severely degrades p99 read latency and wastes disk IOPS.

---

## Decision Drivers

- **Driver 1 (Zero False Negatives)**: A negative answer ("key does not exist in this SSTable") must be 100% mathematically certain so valid keys are never silently missed.
- **Driver 2 (Minimal RAM Footprint)**: Keep per-SSTable filter metadata compact (~1.2 bytes per key for a 1% false-positive rate).
- **Driver 3 (Fast CPU Hashing)**: Avoid computing $k$ separate cryptographic hashes per key by using Kirsch-Mitzenmacher double hashing from two 64-bit non-cryptographic hashes.
- **Driver 4 (Backward Compatibility)**: Support reading legacy v1 SSTables (`0x4954524C`) alongside new v2 SSTables (`0x4954524D`) carrying embedded Bloom filters.

---

## Considered Options

1. **Full In-Memory Hash Index**: Eliminates false positives completely, but consumes $O(N \cdot \text{key\_size})$ RAM and defeats the bounded-memory advantage of an LSM-Tree.
2. **Classic Bloom Filter with Kirsch-Mitzenmacher Double Hashing**: Compact bit array (~9.6 bits/key for $p=0.01$), zero false negatives, fast two-hash probing, and simple serialization into the SSTable file.
3. **Cuckoo / Quotient Filter**: Supports deletions inside the filter, unnecessary here because SSTables are strictly immutable once written.

---

## Decision Outcome

Chosen option: **Option 2 (Bloom Filter per SSTable with Double Hashing)** implemented in `crates/itr-lsm/src/bloom.rs` and persisted in SSTable v2 (`0x4954524D`).

### Mathematical Sizing

Given $n$ keys inserted into an SSTable and target false-positive probability $p \in (0, 1)$:

$$m = \left\lceil -\frac{n \ln p}{(\ln 2)^2} \right\rceil \quad \text{bits}, \qquad k = \max\left(1, \left\lfloor \frac{m}{n} \ln 2 \right\rceil\right) \quad \text{probes}$$

Using double hashing with independent 64-bit base hashes $h_1(x)$ and $h_2(x)$:

$$g_i(x) = (h_1(x) + i \cdot h_2(x)) \bmod m \quad (0 \le i < k)$$
