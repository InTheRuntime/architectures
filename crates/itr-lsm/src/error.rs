//! Error types for the LSM-Tree storage engine.

use thiserror::Error;

/// Result type alias for `itr-lsm` operations.
pub type Result<T> = std::result::Result<T, LsmError>;

/// Errors produced by WAL, SSTable, and LSM-Tree engine operations.
#[derive(Debug, Error)]
pub enum LsmError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Corrupt SSTable file '{path}': {reason}")]
    CorruptSstable { path: String, reason: String },

    #[error(
        "Invalid SSTable magic number in '{path}': expected 0x{expected:08X}, got 0x{actual:08X}"
    )]
    InvalidMagic {
        path: String,
        expected: u32,
        actual: u32,
    },

    #[error("Corrupt WAL record at offset {offset}: {reason}")]
    CorruptWal { offset: u64, reason: String },

    #[error("Invalid key range: start key must be <= end key")]
    InvalidRange,
}
