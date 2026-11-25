//! Unified LSM-Tree Storage Engine coordinating WAL, MemTable, SSTables, Bloom Filters, and Compaction.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{LsmError, Result};
use crate::memtable::{MemTable, ValueEntry};
use crate::sstable::{LookupOutcome, SSTable};
use crate::wal::{WalEntry, WriteAheadLog};

/// Configuration parameters for `LsmEngine`.
#[derive(Debug, Clone)]
pub struct LsmConfig {
    /// Byte threshold at which the active MemTable automatically flushes to an SSTable.
    pub memtable_max_bytes: usize,
    /// Sample every Nth key into the SSTable sparse index (smaller = faster seeks, larger index).
    pub sparse_index_stride: usize,
    /// Whether to fsync WAL writes immediately (true = strict durability, false = OS page cache).
    pub sync_wal_on_write: bool,
    /// Target false-positive rate for per-SSTable Bloom filters (e.g. `Some(0.01)` for 1%).
    /// Set to `None` to disable Bloom filter generation.
    pub bloom_false_positive_rate: Option<f64>,
}

impl Default for LsmConfig {
    fn default() -> Self {
        Self {
            memtable_max_bytes: 4 * 1024 * 1024, // 4 MiB
            sparse_index_stride: 16,
            sync_wal_on_write: true,
            bloom_false_positive_rate: Some(0.01),
        }
    }
}

/// Runtime observability metrics for `LsmEngine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LsmStats {
    pub memtable_entries: usize,
    pub memtable_bytes: usize,
    pub sstable_count: usize,
    pub total_sstable_bytes: u64,
    pub total_writes: u64,
    pub total_reads: u64,
    pub flushes: u64,
    pub compactions: u64,
    pub wal_recovered_entries: usize,
    pub bloom_skips: u64,
    pub fence_skips: u64,
    pub disk_seeks: u64,
}

/// Disk-backed Log-Structured Merge-Tree (LSM-Tree) Key-Value Engine.
pub struct LsmEngine {
    dir: PathBuf,
    config: LsmConfig,
    memtable: MemTable,
    wal: WriteAheadLog,
    sstables: Vec<SSTable>, // Ordered oldest -> newest by ID
    next_sstable_id: u64,
    total_writes: u64,
    total_reads: u64,
    flushes: u64,
    compactions: u64,
    wal_recovered_entries: usize,
    bloom_skips: u64,
    fence_skips: u64,
    disk_seeks: u64,
}

impl LsmEngine {
    /// Opens an existing LSM-Tree database directory or creates a new one.
    ///
    /// Loads all persisted SSTables (`sst_<id>.db`) and replays any uncommitted records
    /// from `wal.log` into the active MemTable.
    pub fn open(dir: impl AsRef<Path>, config: LsmConfig) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;

        // Discover existing SSTables sorted oldest -> newest
        let mut sstable_files: Vec<(u64, PathBuf)> = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if let Some(id) = Self::parse_sstable_filename(name) {
                    sstable_files.push((id, path));
                }
            }
        }
        sstable_files.sort_by_key(|(id, _)| *id);

        let mut sstables = Vec::with_capacity(sstable_files.len());
        let mut max_id = 0u64;
        for (id, path) in sstable_files {
            sstables.push(SSTable::open(id, path)?);
            max_id = max_id.max(id);
        }

        let mut memtable = MemTable::new();
        let wal_path = dir.join("wal.log");
        let (wal, wal_recovered_entries) =
            WriteAheadLog::open_and_recover(wal_path, &mut memtable, config.sync_wal_on_write)?;

        Ok(Self {
            dir,
            config,
            memtable,
            wal,
            sstables,
            next_sstable_id: max_id + 1,
            total_writes: 0,
            total_reads: 0,
            flushes: 0,
            compactions: 0,
            wal_recovered_entries,
            bloom_skips: 0,
            fence_skips: 0,
            disk_seeks: 0,
        })
    }

    fn parse_sstable_filename(name: &str) -> Option<u64> {
        let stripped = name.strip_prefix("sst_")?.strip_suffix(".db")?;
        stripped.parse::<u64>().ok()
    }

    fn sstable_path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("sst_{id:06}.db"))
    }

    /// Inserts or updates a key-value pair durably (WAL + MemTable + auto-flush).
    pub fn put(&mut self, key: impl AsRef<[u8]>, value: impl AsRef<[u8]>) -> Result<()> {
        let key_vec = key.as_ref().to_vec();
        let val_vec = value.as_ref().to_vec();

        self.wal.append(&WalEntry::Put {
            key: key_vec.clone(),
            value: val_vec.clone(),
        })?;
        self.memtable.put(key_vec, val_vec);
        self.total_writes += 1;

        if self.memtable.approx_bytes() >= self.config.memtable_max_bytes {
            self.flush()?;
        }

        Ok(())
    }

    /// Deletes a key durably by writing a Tombstone marker.
    pub fn delete(&mut self, key: impl AsRef<[u8]>) -> Result<()> {
        let key_vec = key.as_ref().to_vec();

        self.wal.append(&WalEntry::Delete {
            key: key_vec.clone(),
        })?;
        self.memtable.delete(key_vec);
        self.total_writes += 1;

        if self.memtable.approx_bytes() >= self.config.memtable_max_bytes {
            self.flush()?;
        }

        Ok(())
    }

    /// Retrieves the latest value for `key`, searching MemTable first and then SSTables newest-to-oldest.
    pub fn get(&mut self, key: impl AsRef<[u8]>) -> Result<Option<Vec<u8>>> {
        self.total_reads += 1;
        let key_bytes = key.as_ref();

        // 1. Check active MemTable
        if let Some(entry) = self.memtable.get(key_bytes) {
            return Ok(match entry {
                ValueEntry::Put(v) => Some(v.clone()),
                ValueEntry::Tombstone => None,
            });
        }

        // 2. Check immutable SSTables from newest to oldest
        for sst in self.sstables.iter().rev() {
            match sst.get_with_outcome(key_bytes)? {
                LookupOutcome::Found(entry) => {
                    self.disk_seeks += 1;
                    return Ok(match entry {
                        ValueEntry::Put(v) => Some(v),
                        ValueEntry::Tombstone => None, // Stops search immediately
                    });
                }
                LookupOutcome::SkippedByFence => {
                    self.fence_skips += 1;
                }
                LookupOutcome::SkippedByBloom => {
                    self.bloom_skips += 1;
                }
                LookupOutcome::NotFoundAfterDiskSeek => {
                    self.disk_seeks += 1;
                }
            }
        }

        Ok(None)
    }

    /// Performs a sorted range scan over `[start_key, end_key]` inclusive across MemTable and all SSTables.
    pub fn scan(
        &mut self,
        start_key: impl AsRef<[u8]>,
        end_key: impl AsRef<[u8]>,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let start = start_key.as_ref();
        let end = end_key.as_ref();
        if start > end {
            return Err(LsmError::InvalidRange);
        }

        self.total_reads += 1;
        let mut merged: BTreeMap<Vec<u8>, ValueEntry> = BTreeMap::new();

        // 1. MemTable has highest priority (newest)
        for (k, v) in self.memtable.scan(start, end) {
            merged.insert(k.to_vec(), v.clone());
        }

        // 2. Merge SSTables newest-to-oldest
        for sst in self.sstables.iter().rev() {
            if sst.max_key.as_slice() < start || sst.min_key.as_slice() > end {
                continue;
            }
            for (k, v) in sst.read_all()? {
                let k_slice = k.as_slice();
                if k_slice >= start && k_slice <= end {
                    merged.entry(k).or_insert(v);
                }
            }
        }

        Ok(merged
            .into_iter()
            .filter_map(|(k, v)| match v {
                ValueEntry::Put(val) => Some((k, val)),
                ValueEntry::Tombstone => None,
            })
            .collect())
    }

    /// Flushes the active MemTable sequentially to a new immutable SSTable on disk and resets the WAL.
    pub fn flush(&mut self) -> Result<Option<u64>> {
        if self.memtable.is_empty() {
            return Ok(None);
        }

        let id = self.next_sstable_id;
        self.next_sstable_id += 1;

        let path = self.sstable_path(id);
        let sst = SSTable::write_from_entries(
            id,
            path,
            self.memtable.iter().map(|(k, v)| (k.as_slice(), v)),
            self.config.sparse_index_stride,
            self.config.bloom_false_positive_rate,
        )?;

        self.sstables.push(sst);
        self.memtable.clear();
        self.wal.reset()?;
        self.flushes += 1;

        Ok(Some(id))
    }

    /// Compacts all existing SSTables into a single clean SSTable, removing overwritten values
    /// and tombstone markers to reclaim disk space and reduce read amplification.
    pub fn compact(&mut self) -> Result<Option<u64>> {
        if self.sstables.is_empty() {
            return Ok(None);
        }

        let new_id = self.next_sstable_id;
        self.next_sstable_id += 1;
        let dest_path = self.sstable_path(new_id);

        let compacted_opt = SSTable::compact_merge(
            &self.sstables,
            new_id,
            dest_path,
            self.config.sparse_index_stride,
            self.config.bloom_false_positive_rate,
        )?;

        // Delete old SSTable files after new compacted SSTable is safely synced on disk
        let old_sstables = std::mem::take(&mut self.sstables);
        for old in old_sstables {
            let _ = fs::remove_file(old.path);
        }

        if let Some(compacted) = compacted_opt {
            self.sstables.push(compacted);
            self.compactions += 1;
            Ok(Some(new_id))
        } else {
            // All keys were tombstones -> disk space completely reclaimed
            self.compactions += 1;
            Ok(None)
        }
    }

    /// Returns current engine telemetry and disk footprint metrics.
    pub fn stats(&self) -> LsmStats {
        let total_sstable_bytes = self
            .sstables
            .iter()
            .filter_map(|s| s.file_size().ok())
            .sum();

        LsmStats {
            memtable_entries: self.memtable.len(),
            memtable_bytes: self.memtable.approx_bytes(),
            sstable_count: self.sstables.len(),
            total_sstable_bytes,
            total_writes: self.total_writes,
            total_reads: self.total_reads,
            flushes: self.flushes,
            compactions: self.compactions,
            wal_recovered_entries: self.wal_recovered_entries,
            bloom_skips: self.bloom_skips,
            fence_skips: self.fence_skips,
            disk_seeks: self.disk_seeks,
        }
    }
}
