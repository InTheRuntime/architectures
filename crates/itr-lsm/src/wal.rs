//! Append-only Write-Ahead Log (WAL) with CRC32 integrity checks and torn-tail recovery.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use crate::crc::crc32_slices;
use crate::error::Result;
use crate::memtable::MemTable;

const OP_PUT: u8 = 0x01;
const OP_DELETE: u8 = 0x02;
const HEADER_SIZE: usize = 13; // op (1B) + key_len (4B) + val_len (4B) + crc32 (4B)

/// Represents a single durable mutation recorded in the Write-Ahead Log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalEntry {
    Put { key: Vec<u8>, value: Vec<u8> },
    Delete { key: Vec<u8> },
}

/// Append-only Write-Ahead Log protecting in-memory MemTable writes against process crashes.
pub struct WriteAheadLog {
    path: PathBuf,
    writer: BufWriter<File>,
    sync_on_write: bool,
}

impl WriteAheadLog {
    /// Opens (or creates) a WAL file in append mode and replays any valid committed records
    /// into `memtable`. Any partial/corrupted tail bytes left by a crash are safely truncated.
    pub fn open_and_recover(
        path: impl AsRef<Path>,
        memtable: &mut MemTable,
        sync_on_write: bool,
    ) -> Result<(Self, usize)> {
        let path = path.as_ref().to_path_buf();
        let recovered_count = Self::recover_into(&path, memtable)?;

        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let writer = BufWriter::new(file);

        Ok((
            Self {
                path,
                writer,
                sync_on_write,
            },
            recovered_count,
        ))
    }

    fn recover_into(path: &Path, memtable: &mut MemTable) -> Result<usize> {
        if !path.exists() {
            return Ok(0);
        }

        let mut file = OpenOptions::new().read(true).write(true).open(path)?;
        let file_len = file.metadata()?.len();
        let mut valid_offset = 0u64;
        let mut recovered = 0usize;

        while valid_offset < file_len {
            let mut header = [0u8; HEADER_SIZE];
            if file.read_exact(&mut header).is_err() {
                // Torn header at tail -> truncate safely
                break;
            }

            let op = header[0];
            let key_len = u32::from_le_bytes(header[1..5].try_into().unwrap()) as usize;
            let val_len = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
            let stored_crc = u32::from_le_bytes(header[9..13].try_into().unwrap());

            if op != OP_PUT && op != OP_DELETE {
                break;
            }

            let mut key = vec![0u8; key_len];
            if file.read_exact(&mut key).is_err() {
                // Torn key bytes at tail -> truncate safely
                break;
            }

            let mut value = vec![0u8; val_len];
            if file.read_exact(&mut value).is_err() {
                // Torn value bytes at tail -> truncate safely
                break;
            }

            let computed_crc = crc32_slices(&[&[op], &header[1..9], &key, &value]);
            if computed_crc != stored_crc {
                // Checksum mismatch (corrupt tail record) -> stop recovery here
                break;
            }

            match op {
                OP_PUT => memtable.put(key, value),
                OP_DELETE => memtable.delete(key),
                _ => unreachable!(),
            }

            recovered += 1;
            valid_offset = file.stream_position()?;
        }

        // Truncate any partial/corrupt tail left by an abrupt power loss or crash
        if valid_offset < file_len {
            file.set_len(valid_offset)?;
            file.sync_all()?;
        }

        Ok(recovered)
    }

    /// Appends a mutation record to the WAL with a CRC32 checksum.
    pub fn append(&mut self, entry: &WalEntry) -> Result<()> {
        let (op, key, value): (u8, &[u8], &[u8]) = match entry {
            WalEntry::Put { key, value } => (OP_PUT, key.as_slice(), value.as_slice()),
            WalEntry::Delete { key } => (OP_DELETE, key.as_slice(), &[]),
        };

        let key_len = (key.len() as u32).to_le_bytes();
        let val_len = (value.len() as u32).to_le_bytes();
        let crc = crc32_slices(&[&[op], &key_len, &val_len, key, value]).to_le_bytes();

        self.writer.write_all(&[op])?;
        self.writer.write_all(&key_len)?;
        self.writer.write_all(&val_len)?;
        self.writer.write_all(&crc)?;
        self.writer.write_all(key)?;
        self.writer.write_all(value)?;
        self.writer.flush()?;

        if self.sync_on_write {
            self.writer.get_ref().sync_data()?;
        }

        Ok(())
    }

    /// Truncates the WAL after the MemTable has been durably flushed to an SSTable.
    pub fn reset(&mut self) -> Result<()> {
        self.writer.flush()?;
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        file.sync_all()?;

        let append_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.writer = BufWriter::new(append_file);
        Ok(())
    }
}
