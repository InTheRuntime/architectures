# [ADR-0005] Log-Structured Merge-Tree (LSM-Tree) Storage Engine

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: InTheRuntime Team
- **Deciders**: Engineering Lead, System Architect
- **Consulted**: Core Engineers

---

## Context and Problem Statement

Traditional disk-based storage engines (such as B-Trees / B+Trees) update records **in place** on fixed-size 4KB–16KB disk pages. Under write-heavy workloads (telemetry ingestion, time-series metrics, messaging logs, key-value stores), in-place page updates produce severe **random disk I/O**, page splits, and high write amplification—bottlenecking throughput even on modern NVMe SSDs.

We need a foundational storage engine for **Domain 3 (Data & Storage Engines)** that maximizes write throughput, guarantees crash durability, supports fast point lookups and range scans, and reclaims disk space from updates and deletions.

---

## Decision Drivers

- **Driver 1 (Sequential I/O First)**: Convert random mutations (`put`, `delete`) into sequential append-only writes.
- **Driver 2 (Crash Durability)**: Never lose acknowledged writes on sudden process crash or power loss, and tolerate torn/partial log tails safely.
- **Driver 3 (Bounded Memory & Fast Disk Reads)**: Keep hot writes in a bounded sorted memory structure while avoiding full-file scans on cold disk files via Sparse Indexing.
- **Driver 4 (Zero C-Binding Portability)**: Implement in pure Rust (`std` + `thiserror`) in `crates/itr-lsm` so the storage engine compiles deterministically across platforms without native C toolchain dependencies.

---

## Considered Options

1. **Pure In-Place Hash Index (Bitcask-style)**: Fast writes and $O(1)$ reads, but requires holding every single key in RAM and cannot support sorted range scans.
2. **B+Tree Page Engine**: Great read latency and range scans, but suffers from random write I/O and page fragmentation under high-ingest workloads.
3. **Log-Structured Merge-Tree (LSM-Tree)**: Combines an append-only Write-Ahead Log (WAL), an in-memory sorted MemTable, and immutable disk SSTables with Sparse Indexes and background/explicit Compaction.

---

## Decision Outcome

Chosen option: **Option 3 (LSM-Tree Storage Engine)** implemented in `crates/itr-lsm`.

### Positive Consequences
- All mutations append sequentially to disk (`WAL` + `SSTable` flushes), saturating disk bandwidth instead of seek latency.
- Sorted MemTable and SSTables support both point lookups (`get`) and ordered range queries (`scan`).
- Immutable SSTables eliminate read/write lock contention on disk files and simplify crash recovery.

### Negative Consequences / Trade-offs
- **Read Amplification**: A point lookup may check the MemTable and multiple SSTable levels.
  - *Mitigation*: Maintain in-memory `min_key`/`max_key` fences and a Sparse Index per SSTable to bound disk reads to a single small stride. (Future Level 1 adds Bloom Filters to skip non-existent keys in $O(1)$).
- **Space Amplification (Tombstones & Stale Keys)**: Updates and deletes append new entries rather than overwriting old bytes.
  - *Mitigation*: Periodic **Compaction** merges SSTables, retaining only the latest state and reclaiming obsolete entries and tombstones.

---

## Architectural Details & On-Disk Binary Formats

### 1. Write-Ahead Log (`wal.log`)
Every record is framed sequentially with a CRC32 checksum:

```text
+----------+--------------+--------------+------------+----------+------------+
| op (1B)  | key_len (4B) | val_len (4B) | crc32 (4B) | key bytes| val bytes  |
+----------+--------------+--------------+------------+----------+------------+
op = 0x01 (Put) | 0x02 (Tombstone Delete)
```

On recovery, records failing CRC32 verification or encountering unexpected EOF (torn writes) are truncated safely without invalidating prior committed records.

### 2. Sorted String Table (`sst_<seq>.db`)

```text
+-------------------------------------------------------------------+
| Data Block: Sorted [op: u8][k_len: u32][v_len: u32][key][val]...  |
+-------------------------------------------------------------------+
| Sparse Index Block: Every Kth entry -> [k_len: u32][key][off: u64]|
+-------------------------------------------------------------------+
| Footer (16 bytes): [index_offset: u64][index_count: u32][magic:u32]|
+-------------------------------------------------------------------+
Magic = 0x4954524C ("ITRL")
```
