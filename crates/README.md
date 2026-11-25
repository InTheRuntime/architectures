# Rust Shared Crates (`crates/`)

This directory contains shared Rust crates within the virtual Cargo workspace, prefixed with `itr-*`.

---

## Crate Index

| Crate | Path | Description |
| :--- | :--- | :--- |
| **`itr-contracts`** | `crates/itr-contracts` | Rust types and prost/tonic bindings generated from `specs/contracts/`. |
| **`itr-rbac`** | `crates/itr-rbac` | Zero-allocation $O(1)$ 64-bit (`u64`) bitmask evaluation engine. |
| **`itr-ratelimit`** | `crates/itr-ratelimit` | Redis Lua and in-memory Token Bucket rate limiting library with IETF header support. |
| **`itr-lsm`** | `crates/itr-lsm` | Log-Structured Merge-Tree (LSM-Tree) disk storage engine with WAL, MemTable, Sparse-Indexed SSTables, and Compaction. |
