//! Immutable Sorted String Table (SSTable) with Sparse Indexing, Bloom Filters, and Compaction.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::bloom::BloomFilter;
use crate::error::{LsmError, Result};
use crate::memtable::ValueEntry;

const MAGIC_V1: u32 = 0x4954_524C; // "ITRL" (Sparse Index only)
const MAGIC_V2: u32 = 0x4954_524D; // "ITRM" (Sparse Index + Bloom Filter)
const FOOTER_V1_SIZE: usize = 16; // index_offset (u64) + index_count (u32) + magic (u32)
const FOOTER_V2_SIZE: usize = 28; // index_offset (u64) + index_count (u32) + bloom_offset (u64) + bloom_len (u32) + magic (u32)
const OP_PUT: u8 = 0x01;
const OP_DELETE: u8 = 0x02;

/// Detailed lookup outcome for observability and disk-I/O telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupOutcome {
    /// Key was matched in this SSTable (`Put` or `Tombstone`).
    Found(ValueEntry),
    /// Key fell outside `[min_key, max_key]` fence bounds (0 disk I/O).
    SkippedByFence,
    /// Key rejected by the in-memory Bloom Filter (0 disk I/O).
    SkippedByBloom,
    /// Disk seek + sparse stride scan completed without finding the key.
    NotFoundAfterDiskSeek,
}

/// Maps a sampled key to its byte offset in an SSTable's Data Block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseIndexEntry {
    pub key: Vec<u8>,
    pub offset: u64,
}

/// Immutable on-disk Sorted String Table.
#[derive(Debug)]
pub struct SSTable {
    pub id: u64,
    pub path: PathBuf,
    pub min_key: Vec<u8>,
    pub max_key: Vec<u8>,
    pub data_end_offset: u64,
    sparse_index: Vec<SparseIndexEntry>,
    bloom: Option<BloomFilter>,
}

impl SSTable {
    /// Writes a sorted stream of entries to disk atomically (via `.tmp` + rename)
    /// along with a Sparse Index, optional Bloom Filter (v2), and verified Footer.
    pub fn write_from_entries<'a, I>(
        id: u64,
        path: impl AsRef<Path>,
        entries: I,
        sparse_stride: usize,
        bloom_fp_rate: Option<f64>,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = (&'a [u8], &'a ValueEntry)>,
    {
        let path = path.as_ref().to_path_buf();
        let tmp_path = path.with_extension("db.tmp");
        let stride = sparse_stride.max(1);

        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)?;
        let mut writer = BufWriter::new(file);

        let mut offset = 0u64;
        let mut sparse_index = Vec::new();
        let mut all_keys: Vec<&'a [u8]> = Vec::new();
        let mut min_key: Option<Vec<u8>> = None;
        let mut max_key: Option<Vec<u8>> = None;

        for (count, (key, entry)) in entries.into_iter().enumerate() {
            if min_key.is_none() {
                min_key = Some(key.to_vec());
            }
            max_key = Some(key.to_vec());
            if bloom_fp_rate.is_some() {
                all_keys.push(key);
            }

            if count.is_multiple_of(stride) {
                sparse_index.push(SparseIndexEntry {
                    key: key.to_vec(),
                    offset,
                });
            }

            let (op, val_bytes): (u8, &[u8]) = match entry {
                ValueEntry::Put(v) => (OP_PUT, v.as_slice()),
                ValueEntry::Tombstone => (OP_DELETE, &[]),
            };

            let key_len = key.len() as u32;
            let val_len = val_bytes.len() as u32;

            writer.write_all(&[op])?;
            writer.write_all(&key_len.to_le_bytes())?;
            writer.write_all(&val_len.to_le_bytes())?;
            writer.write_all(key)?;
            writer.write_all(val_bytes)?;

            offset += 1 + 4 + 4 + (key.len() as u64) + (val_bytes.len() as u64);
        }

        let data_end_offset = offset;
        let index_offset = data_end_offset;

        // Write Sparse Index Section
        let mut index_bytes_written = 0u64;
        for idx_entry in &sparse_index {
            let k_len = idx_entry.key.len() as u32;
            writer.write_all(&k_len.to_le_bytes())?;
            writer.write_all(&idx_entry.key)?;
            writer.write_all(&idx_entry.offset.to_le_bytes())?;
            index_bytes_written += 4 + (idx_entry.key.len() as u64) + 8;
        }

        // Write optional Bloom Filter (v2) or legacy v1 Footer
        let bloom = match bloom_fp_rate {
            Some(rate) if !all_keys.is_empty() => {
                let filter =
                    BloomFilter::build_from_keys(all_keys.iter().copied(), all_keys.len(), rate);
                let bloom_bytes = filter.to_bytes();
                let bloom_offset = index_offset + index_bytes_written;
                let bloom_len = bloom_bytes.len() as u32;

                writer.write_all(&bloom_bytes)?;

                // 28-byte v2 Footer
                writer.write_all(&index_offset.to_le_bytes())?;
                writer.write_all(&(sparse_index.len() as u32).to_le_bytes())?;
                writer.write_all(&bloom_offset.to_le_bytes())?;
                writer.write_all(&bloom_len.to_le_bytes())?;
                writer.write_all(&MAGIC_V2.to_le_bytes())?;
                Some(filter)
            }
            _ => {
                // 16-byte v1 Footer
                writer.write_all(&index_offset.to_le_bytes())?;
                writer.write_all(&(sparse_index.len() as u32).to_le_bytes())?;
                writer.write_all(&MAGIC_V1.to_le_bytes())?;
                None
            }
        };

        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);

        fs::rename(&tmp_path, &path)?;

        Ok(Self {
            id,
            path,
            min_key: min_key.unwrap_or_default(),
            max_key: max_key.unwrap_or_default(),
            data_end_offset,
            sparse_index,
            bloom,
        })
    }

    /// Opens an existing SSTable (supporting both v1 and v2 formats) and loads only
    /// its Sparse Index and optional Bloom Filter into memory.
    pub fn open(id: u64, path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path)?;
        let file_len = file.metadata()?.len();
        let path_str = path.display().to_string();

        if file_len < FOOTER_V1_SIZE as u64 {
            return Err(LsmError::CorruptSstable {
                path: path_str,
                reason: "File smaller than minimum 16-byte footer".to_string(),
            });
        }

        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::End(-4))?;
        let mut magic_buf = [0u8; 4];
        reader.read_exact(&mut magic_buf)?;
        let magic = u32::from_le_bytes(magic_buf);

        let (index_offset, index_count, bloom_meta) = match magic {
            MAGIC_V2 => {
                if file_len < FOOTER_V2_SIZE as u64 {
                    return Err(LsmError::CorruptSstable {
                        path: path_str,
                        reason: "File smaller than 28-byte v2 footer".to_string(),
                    });
                }
                reader.seek(SeekFrom::End(-(FOOTER_V2_SIZE as i64)))?;
                let mut footer = [0u8; FOOTER_V2_SIZE];
                reader.read_exact(&mut footer)?;

                let index_offset = u64::from_le_bytes(footer[0..8].try_into().unwrap());
                let index_count = u32::from_le_bytes(footer[8..12].try_into().unwrap()) as usize;
                let bloom_offset = u64::from_le_bytes(footer[12..20].try_into().unwrap());
                let bloom_len = u32::from_le_bytes(footer[20..24].try_into().unwrap()) as usize;

                if index_offset > file_len - FOOTER_V2_SIZE as u64
                    || bloom_offset + (bloom_len as u64) > file_len - FOOTER_V2_SIZE as u64
                {
                    return Err(LsmError::CorruptSstable {
                        path: path_str,
                        reason: "Invalid index or bloom offset in v2 footer".to_string(),
                    });
                }

                (index_offset, index_count, Some((bloom_offset, bloom_len)))
            }
            MAGIC_V1 => {
                reader.seek(SeekFrom::End(-(FOOTER_V1_SIZE as i64)))?;
                let mut footer = [0u8; FOOTER_V1_SIZE];
                reader.read_exact(&mut footer)?;

                let index_offset = u64::from_le_bytes(footer[0..8].try_into().unwrap());
                let index_count = u32::from_le_bytes(footer[8..12].try_into().unwrap()) as usize;

                if index_offset > file_len - FOOTER_V1_SIZE as u64 {
                    return Err(LsmError::CorruptSstable {
                        path: path_str,
                        reason: "Invalid sparse index offset in v1 footer".to_string(),
                    });
                }

                (index_offset, index_count, None)
            }
            other => {
                return Err(LsmError::InvalidMagic {
                    path: path_str,
                    expected: MAGIC_V2,
                    actual: other,
                });
            }
        };

        // Load Sparse Index
        reader.seek(SeekFrom::Start(index_offset))?;
        let mut sparse_index = Vec::with_capacity(index_count);
        for _ in 0..index_count {
            let mut k_len_buf = [0u8; 4];
            reader.read_exact(&mut k_len_buf)?;
            let k_len = u32::from_le_bytes(k_len_buf) as usize;

            let mut key = vec![0u8; k_len];
            reader.read_exact(&mut key)?;

            let mut off_buf = [0u8; 8];
            reader.read_exact(&mut off_buf)?;
            let offset = u64::from_le_bytes(off_buf);

            sparse_index.push(SparseIndexEntry { key, offset });
        }

        // Load optional Bloom Filter
        let bloom = match bloom_meta {
            Some((bloom_offset, bloom_len)) => {
                reader.seek(SeekFrom::Start(bloom_offset))?;
                let mut bloom_buf = vec![0u8; bloom_len];
                reader.read_exact(&mut bloom_buf)?;
                Some(BloomFilter::from_bytes(&bloom_buf, &path_str)?)
            }
            None => None,
        };

        let min_key = sparse_index
            .first()
            .map(|e| e.key.clone())
            .unwrap_or_default();

        // Determine max_key by scanning only the final sparse stride block
        let max_key = if let Some(last_idx) = sparse_index.last() {
            reader.seek(SeekFrom::Start(last_idx.offset))?;
            let mut last_seen = last_idx.key.clone();
            while reader.stream_position()? < index_offset {
                let (k, _) = Self::read_record(&mut reader, &path_str)?;
                last_seen = k;
            }
            last_seen
        } else {
            Vec::new()
        };

        Ok(Self {
            id,
            path,
            min_key,
            max_key,
            data_end_offset: index_offset,
            sparse_index,
            bloom,
        })
    }

    /// Searches this SSTable for `key` and returns the entry if present.
    pub fn get(&self, key: &[u8]) -> Result<Option<ValueEntry>> {
        match self.get_with_outcome(key)? {
            LookupOutcome::Found(entry) => Ok(Some(entry)),
            _ => Ok(None),
        }
    }

    /// Searches this SSTable for `key`, returning whether fence bounds or the Bloom filter
    /// avoided disk I/O.
    pub fn get_with_outcome(&self, key: &[u8]) -> Result<LookupOutcome> {
        if self.sparse_index.is_empty()
            || key < self.min_key.as_slice()
            || key > self.max_key.as_slice()
        {
            return Ok(LookupOutcome::SkippedByFence);
        }

        if let Some(bloom) = &self.bloom {
            if !bloom.may_contain(key) {
                return Ok(LookupOutcome::SkippedByBloom);
            }
        }

        // Find the rightmost sparse index entry whose key <= target key
        let pos = self
            .sparse_index
            .partition_point(|e| e.key.as_slice() <= key);
        if pos == 0 {
            return Ok(LookupOutcome::SkippedByFence);
        }

        let start_offset = self.sparse_index[pos - 1].offset;
        let stop_offset = if pos < self.sparse_index.len() {
            self.sparse_index[pos].offset
        } else {
            self.data_end_offset
        };

        let file = File::open(&self.path)?;
        let mut reader = BufReader::new(file);
        reader.seek(SeekFrom::Start(start_offset))?;

        let path_str = self.path.display().to_string();
        while reader.stream_position()? < stop_offset {
            let (rec_key, rec_val) = Self::read_record(&mut reader, &path_str)?;
            match rec_key.as_slice().cmp(key) {
                std::cmp::Ordering::Equal => return Ok(LookupOutcome::Found(rec_val)),
                std::cmp::Ordering::Greater => return Ok(LookupOutcome::NotFoundAfterDiskSeek),
                std::cmp::Ordering::Less => continue,
            }
        }

        Ok(LookupOutcome::NotFoundAfterDiskSeek)
    }

    /// Returns `true` if this SSTable carries an embedded Bloom filter.
    pub fn has_bloom_filter(&self) -> bool {
        self.bloom.is_some()
    }

    /// Reads all entries from this SSTable in sorted order (used for compaction and range scans).
    pub fn read_all(&self) -> Result<Vec<(Vec<u8>, ValueEntry)>> {
        let file = File::open(&self.path)?;
        let mut reader = BufReader::new(file);
        let path_str = self.path.display().to_string();
        let mut entries = Vec::new();

        while reader.stream_position()? < self.data_end_offset {
            entries.push(Self::read_record(&mut reader, &path_str)?);
        }

        Ok(entries)
    }

    /// Returns the number of entries in the in-memory sparse index.
    pub fn sparse_index_len(&self) -> usize {
        self.sparse_index.len()
    }

    /// Returns total file size on disk in bytes.
    pub fn file_size(&self) -> Result<u64> {
        Ok(fs::metadata(&self.path)?.len())
    }

    fn read_record(reader: &mut BufReader<File>, path_str: &str) -> Result<(Vec<u8>, ValueEntry)> {
        let mut header = [0u8; 9];
        reader.read_exact(&mut header)?;

        let op = header[0];
        let key_len = u32::from_le_bytes(header[1..5].try_into().unwrap()) as usize;
        let val_len = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;

        let mut key = vec![0u8; key_len];
        reader.read_exact(&mut key)?;

        let mut val = vec![0u8; val_len];
        reader.read_exact(&mut val)?;

        let entry = match op {
            OP_PUT => ValueEntry::Put(val),
            OP_DELETE => ValueEntry::Tombstone,
            other => {
                return Err(LsmError::CorruptSstable {
                    path: path_str.to_string(),
                    reason: format!("Unknown op byte 0x{other:02X}"),
                });
            }
        };

        Ok((key, entry))
    }

    /// Merges multiple SSTables (provided in oldest-to-newest order) into a single compacted SSTable,
    /// retaining only the latest value per key and dropping deletion tombstones.
    pub fn compact_merge(
        sstables: &[SSTable],
        new_id: u64,
        dest_path: impl AsRef<Path>,
        sparse_stride: usize,
        bloom_fp_rate: Option<f64>,
    ) -> Result<Option<Self>> {
        let mut merged: BTreeMap<Vec<u8>, ValueEntry> = BTreeMap::new();

        // Iterate newest-to-oldest so the newest state always wins
        for sst in sstables.iter().rev() {
            for (key, entry) in sst.read_all()? {
                merged.entry(key).or_insert(entry);
            }
        }

        // Safe to drop tombstones because ALL older SSTables are being merged away
        merged.retain(|_, v| matches!(v, ValueEntry::Put(_)));

        if merged.is_empty() {
            return Ok(None);
        }

        let compacted = Self::write_from_entries(
            new_id,
            dest_path,
            merged.iter().map(|(k, v)| (k.as_slice(), v)),
            sparse_stride,
            bloom_fp_rate,
        )?;

        Ok(Some(compacted))
    }
}
