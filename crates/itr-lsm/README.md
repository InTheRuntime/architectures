# `itr-lsm` (`crates/itr-lsm`)

A pure-Rust **Log-Structured Merge-Tree (LSM-Tree)** disk key-value storage engine implementing sequential append-only durability, sorted in-memory buffering, sparse-indexed immutable SSTables, and compaction.

---

## Features

- **CRC32 Write-Ahead Log (`wal.log`)**: Protects MemTable writes against crashes and safely truncates torn/partial tail frames on startup.
- **Sorted In-Memory MemTable (`BTreeMap`)**: Fast $O(\log M)$ inserts, overwrites, tombstones, and automatic flush on byte threshold.
- **Immutable Binary SSTables (`sst_<seq>.db`)**: Atomic `.tmp` flush + `sync_all` + rename with `min_key`/`max_key` fences and 28-byte verified v2 Footer (`0x4954524D`).
- **Probabilistic Bloom Filters**: Kirsch-Mitzenmacher double hashing per SSTable eliminates >99% of disk seeks on non-existent key lookups with zero false negatives.
- **Sparse Indexing**: Binary searches sampled keys in RAM and seeks directly to the exact disk stride block without loading data into memory.
- **SSTable Compaction & Range Scans**: Merges stale overwrites and drops tombstones to reclaim disk space while supporting sorted `[start, end]` range scans.

---

## Quick Usage

```rust
use itr_lsm::{LsmConfig, LsmEngine};

let config = LsmConfig {
    memtable_max_bytes: 4 * 1024 * 1024,
    sparse_index_stride: 16,
    sync_wal_on_write: true,
    bloom_false_positive_rate: Some(0.01),
};

let mut db = LsmEngine::open("./data/lsm", config)?;
db.put(b"account:101", b"balance=4200")?;
db.flush()?;

assert_eq!(db.get(b"account:101")?, Some(b"balance=4200".to_vec()));

db.delete(b"account:101")?;
db.compact()?; // Reclaims overwritten values & tombstones
assert_eq!(db.get(b"account:101")?, None);
```

---

## Running Tests

```bash
cargo test -p itr-lsm
```
