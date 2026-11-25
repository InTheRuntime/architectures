//! # itr-lsm
//!
//! Log-Structured Merge-Tree (LSM-Tree) disk storage engine.
//!
//! ## Architecture
//! - **Write-Ahead Log (`wal.log`)**: CRC32-framed append-only log for crash durability and torn-tail recovery.
//! - **MemTable (`BTreeMap`)**: Sorted in-memory write buffer.
//! - **SSTables (`sst_<seq>.db`)**: Immutable on-disk sorted files with Sparse Indexing, Bloom Filters, and verified Footers.
//! - **Compaction**: Merges SSTables newest-to-oldest, reclaiming space from overwrites and tombstones.

pub mod bloom;
pub mod crc;
pub mod engine;
pub mod error;
pub mod memtable;
pub mod sstable;
pub mod wal;

pub use bloom::BloomFilter;
pub use engine::{LsmConfig, LsmEngine, LsmStats};
pub use error::{LsmError, Result};
pub use memtable::{MemTable, ValueEntry};
pub use sstable::{LookupOutcome, SSTable, SparseIndexEntry};

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "itr_lsm_test_{}_{}_{}",
                name,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_basic_put_get_overwrite_delete() {
        let dir = TestDir::new("basic");
        let mut db = LsmEngine::open(&dir.0, LsmConfig::default()).unwrap();

        db.put(b"user:1", b"Alice").unwrap();
        db.put(b"user:2", b"Bob").unwrap();

        assert_eq!(db.get(b"user:1").unwrap(), Some(b"Alice".to_vec()));
        assert_eq!(db.get(b"user:2").unwrap(), Some(b"Bob".to_vec()));
        assert_eq!(db.get(b"user:999").unwrap(), None);

        // Overwrite
        db.put(b"user:1", b"Alice_Updated").unwrap();
        assert_eq!(db.get(b"user:1").unwrap(), Some(b"Alice_Updated".to_vec()));

        // Delete
        db.delete(b"user:2").unwrap();
        assert_eq!(db.get(b"user:2").unwrap(), None);
    }

    #[test]
    fn test_auto_flush_and_sparse_index_disk_lookups() {
        let dir = TestDir::new("flush_sparse");
        let config = LsmConfig {
            memtable_max_bytes: 120,
            sparse_index_stride: 3, // Sparse index samples every 3rd key
            sync_wal_on_write: false,
            ..Default::default()
        };

        let mut db = LsmEngine::open(&dir.0, config.clone()).unwrap();

        // Insert 20 keys, triggering multiple automatic flushes to SSTables
        for i in 0..20 {
            let k = format!("key_{i:04}");
            let v = format!("value_payload_{i:04}");
            db.put(k.as_bytes(), v.as_bytes()).unwrap();
        }
        db.flush().unwrap();

        let stats = db.stats();
        assert!(
            stats.sstable_count >= 2,
            "Expected multiple SSTables on disk"
        );
        assert_eq!(stats.memtable_entries, 0);

        // Reopen DB completely cold from disk (tests SSTable Footer & Sparse Index loading)
        drop(db);
        let mut reopened = LsmEngine::open(&dir.0, config).unwrap();

        for i in 0..20 {
            let k = format!("key_{i:04}");
            let expected = format!("value_payload_{i:04}").into_bytes();
            assert_eq!(reopened.get(k.as_bytes()).unwrap(), Some(expected));
        }

        // Non-existent key inside and outside key fences
        assert_eq!(reopened.get(b"key_0005_missing").unwrap(), None);
        assert_eq!(reopened.get(b"aaa_before_min").unwrap(), None);
        assert_eq!(reopened.get(b"zzz_after_max").unwrap(), None);
    }

    #[test]
    fn test_tombstone_prevents_resurrection_across_sstables() {
        let dir = TestDir::new("tombstone");
        let config = LsmConfig {
            memtable_max_bytes: 1024 * 1024,
            sparse_index_stride: 2,
            sync_wal_on_write: false,
            ..Default::default()
        };

        let mut db = LsmEngine::open(&dir.0, config).unwrap();

        // SSTable 1: Put key "session:42"
        db.put(b"session:42", b"active_token").unwrap();
        db.flush().unwrap();

        // SSTable 2: Delete key "session:42" (writes tombstone)
        db.delete(b"session:42").unwrap();
        db.flush().unwrap();

        assert_eq!(db.stats().sstable_count, 2);

        // Must stop at SSTable 2's tombstone and NOT resurrect SSTable 1's value!
        assert_eq!(db.get(b"session:42").unwrap(), None);
    }

    #[test]
    fn test_wal_crash_recovery_and_torn_tail_truncation() {
        let dir = TestDir::new("wal_recovery");
        let config = LsmConfig {
            memtable_max_bytes: 1024 * 1024, // Keep entries in MemTable + WAL
            sparse_index_stride: 4,
            sync_wal_on_write: true,
            ..Default::default()
        };

        {
            let mut db = LsmEngine::open(&dir.0, config.clone()).unwrap();
            db.put(b"k1", b"v1").unwrap();
            db.put(b"k2", b"v2").unwrap();
            db.delete(b"k1").unwrap();
            // Simulate abrupt crash: drop WITHOUT flushing MemTable to SSTable!
        }

        // Simulate a partial/corrupt torn write at the tail of wal.log
        let wal_path = dir.0.join("wal.log");
        {
            let mut f = OpenOptions::new().append(true).open(&wal_path).unwrap();
            f.write_all(&[0x01, 0x10, 0x00, 0x00, 0x00, 0xDE, 0xAD])
                .unwrap();
        }

        // Reopen database -> WAL must recover k2=v2 and k1=Tombstone, and safely truncate garbage tail!
        let mut recovered = LsmEngine::open(&dir.0, config).unwrap();
        assert_eq!(recovered.stats().wal_recovered_entries, 3);
        assert_eq!(recovered.get(b"k1").unwrap(), None);
        assert_eq!(recovered.get(b"k2").unwrap(), Some(b"v2".to_vec()));

        // Verify subsequent writes succeed cleanly after tail truncation
        recovered.put(b"k3", b"v3").unwrap();
        assert_eq!(recovered.get(b"k3").unwrap(), Some(b"v3".to_vec()));
    }

    #[test]
    fn test_compaction_reclaims_overwrites_and_tombstones() {
        let dir = TestDir::new("compaction");
        let config = LsmConfig {
            memtable_max_bytes: 1024 * 1024,
            sparse_index_stride: 2,
            sync_wal_on_write: false,
            ..Default::default()
        };

        let mut db = LsmEngine::open(&dir.0, config).unwrap();

        // SSTable 1
        db.put(b"alpha", b"old_alpha_11111111111111111111").unwrap();
        db.put(b"beta", b"will_be_deleted_222222222222222").unwrap();
        db.flush().unwrap();

        // SSTable 2 (overwrite alpha)
        db.put(b"alpha", b"newer_alpha_3333333333333333333")
            .unwrap();
        db.put(b"gamma", b"gamma_val").unwrap();
        db.flush().unwrap();

        // SSTable 3 (delete beta + final overwrite alpha)
        db.delete(b"beta").unwrap();
        db.put(b"alpha", b"final_alpha").unwrap();
        db.flush().unwrap();

        let pre_stats = db.stats();
        assert_eq!(pre_stats.sstable_count, 3);

        // Execute Compaction
        let compacted_id = db.compact().unwrap();
        assert!(compacted_id.is_some());

        let post_stats = db.stats();
        assert_eq!(post_stats.sstable_count, 1);
        assert_eq!(post_stats.compactions, 1);
        assert!(
            post_stats.total_sstable_bytes < pre_stats.total_sstable_bytes,
            "Compaction must reduce disk footprint"
        );

        // Verify data correctness after compaction
        assert_eq!(db.get(b"alpha").unwrap(), Some(b"final_alpha".to_vec()));
        assert_eq!(db.get(b"beta").unwrap(), None);
        assert_eq!(db.get(b"gamma").unwrap(), Some(b"gamma_val".to_vec()));
    }

    #[test]
    fn test_range_scan_merges_memtable_and_sstables() {
        let dir = TestDir::new("range_scan");
        let mut db = LsmEngine::open(&dir.0, LsmConfig::default()).unwrap();

        // SSTable 1
        db.put(b"a", b"1").unwrap();
        db.put(b"b", b"2").unwrap();
        db.put(b"c", b"3").unwrap();
        db.flush().unwrap();

        // SSTable 2: overwrite "b", delete "c", add "d"
        db.put(b"b", b"2_v2").unwrap();
        db.delete(b"c").unwrap();
        db.put(b"d", b"4").unwrap();
        db.flush().unwrap();

        // Active MemTable: add "e", overwrite "a"
        db.put(b"a", b"1_mem").unwrap();
        db.put(b"e", b"5").unwrap();

        let results = db.scan(b"a", b"d").unwrap();
        assert_eq!(
            results,
            vec![
                (b"a".to_vec(), b"1_mem".to_vec()),
                (b"b".to_vec(), b"2_v2".to_vec()),
                (b"d".to_vec(), b"4".to_vec()),
            ]
        );
    }

    #[test]
    fn test_bloom_filter_skips_disk_seeks_on_missing_keys() {
        let dir = TestDir::new("bloom_disk_skip");
        let config = LsmConfig {
            memtable_max_bytes: 400,
            sparse_index_stride: 4,
            sync_wal_on_write: false,
            bloom_false_positive_rate: Some(0.01),
        };

        let mut db = LsmEngine::open(&dir.0, config.clone()).unwrap();

        // Write 100 even-numbered keys across multiple SSTables (0000, 0002, ..., 0198)
        for i in (0..200).step_by(2) {
            let k = format!("key_{i:04}");
            let v = format!("val_{i:04}");
            db.put(k.as_bytes(), v.as_bytes()).unwrap();
        }
        db.flush().unwrap();

        let sstable_count = db.stats().sstable_count;
        assert!(sstable_count >= 2);

        // Reopen cold from disk to verify v2 SSTable footer & Bloom Filter deserialization
        drop(db);
        let mut reopened = LsmEngine::open(&dir.0, config).unwrap();

        // Query 100 missing odd-numbered keys strictly INSIDE [min_key, max_key] fences
        for i in (1..200).step_by(2) {
            let missing = format!("key_{i:04}");
            assert_eq!(reopened.get(missing.as_bytes()).unwrap(), None);
        }

        let miss_stats = reopened.stats();
        // With 1% FP rate, almost every overlapping SSTable check should be rejected by Bloom filter
        assert!(
            miss_stats.bloom_skips > miss_stats.disk_seeks * 10,
            "Expected Bloom filter to eliminate >90% of disk seeks: skips={}, seeks={}",
            miss_stats.bloom_skips,
            miss_stats.disk_seeks
        );

        // Zero false negatives invariant: every present even key must still be found
        for i in (0..200).step_by(2) {
            let k = format!("key_{i:04}");
            let expected = format!("val_{i:04}").into_bytes();
            assert_eq!(reopened.get(k.as_bytes()).unwrap(), Some(expected));
        }
    }

    #[test]
    fn test_bloom_filter_preserved_after_compaction() {
        let dir = TestDir::new("bloom_compaction");
        let config = LsmConfig {
            memtable_max_bytes: 120,
            sparse_index_stride: 4,
            sync_wal_on_write: false,
            bloom_false_positive_rate: Some(0.01),
        };

        let mut db = LsmEngine::open(&dir.0, config).unwrap();
        for i in 0..30 {
            db.put(format!("rec_{i:04}").as_bytes(), b"payload_data")
                .unwrap();
        }
        db.flush().unwrap();
        assert!(db.stats().sstable_count >= 2);

        db.compact().unwrap();
        assert_eq!(db.stats().sstable_count, 1);

        // Query non-existent keys strictly inside [rec_0000, rec_0029] range
        for i in 0..30 {
            assert_eq!(
                db.get(format!("rec_{i:04}_missing").as_bytes()).unwrap(),
                None
            );
        }

        let stats = db.stats();
        assert!(
            stats.bloom_skips >= 27,
            "Compacted SSTable should retain a functioning Bloom filter (skips={})",
            stats.bloom_skips
        );
    }
}
