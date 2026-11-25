//! Sorted in-memory MemTable backed by a B-Tree.

use std::collections::BTreeMap;
use std::ops::Bound;

/// Represents a stored record state in both the MemTable and SSTables.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueEntry {
    /// Active key-value payload.
    Put(Vec<u8>),
    /// Deletion marker masking older values in immutable SSTables.
    Tombstone,
}

/// In-memory sorted write buffer.
///
/// Accepts O(log N) insertions and lookups, maintains approximate memory footprint,
/// and emits entries in strictly sorted key order during SSTable flush.
#[derive(Debug, Default)]
pub struct MemTable {
    entries: BTreeMap<Vec<u8>, ValueEntry>,
    approx_bytes: usize,
}

impl MemTable {
    /// Creates an empty `MemTable`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Inserts or overwrites a key-value pair and updates approximate byte usage.
    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        let key_len = key.len();
        let val_len = value.len();

        match self.entries.insert(key, ValueEntry::Put(value)) {
            Some(ValueEntry::Put(old)) => {
                self.approx_bytes = self.approx_bytes.saturating_sub(old.len()) + val_len;
            }
            Some(ValueEntry::Tombstone) => {
                self.approx_bytes += val_len;
            }
            None => {
                self.approx_bytes += key_len + val_len;
            }
        }
    }

    /// Inserts a deletion tombstone for `key`.
    pub fn delete(&mut self, key: Vec<u8>) {
        let key_len = key.len();
        match self.entries.insert(key, ValueEntry::Tombstone) {
            Some(ValueEntry::Put(old)) => {
                self.approx_bytes = self.approx_bytes.saturating_sub(old.len());
            }
            Some(ValueEntry::Tombstone) => {}
            None => {
                self.approx_bytes += key_len;
            }
        }
    }

    /// Looks up a key in O(log N) time.
    pub fn get(&self, key: &[u8]) -> Option<&ValueEntry> {
        self.entries.get(key)
    }

    /// Iterates entries in sorted order within `[start, end]`.
    pub fn scan(&self, start: &[u8], end: &[u8]) -> impl Iterator<Item = (&[u8], &ValueEntry)> {
        self.entries
            .range::<[u8], _>((Bound::Included(start), Bound::Included(end)))
            .map(|(k, v)| (k.as_slice(), v))
    }

    /// Returns all entries in sorted key order.
    pub fn iter(&self) -> impl Iterator<Item = (&Vec<u8>, &ValueEntry)> {
        self.entries.iter()
    }

    /// Approximate memory footprint in bytes.
    pub fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    /// Number of distinct keys currently buffered.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns `true` if no entries are buffered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clears all entries and resets byte counter after a successful flush.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.approx_bytes = 0;
    }
}
