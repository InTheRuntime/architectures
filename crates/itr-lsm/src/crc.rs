//! Pure-Rust IEEE 802.3 CRC32 implementation for WAL frame integrity verification.

const fn generate_crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut j = 0;
        while j < 8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
            j += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

const CRC32_TABLE: [u32; 256] = generate_crc32_table();

/// Computes the IEEE CRC32 checksum across multiple byte slices.
pub fn crc32_slices(slices: &[&[u8]]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for slice in slices {
        for &byte in *slice {
            let idx = ((crc ^ (byte as u32)) & 0xFF) as usize;
            crc = (crc >> 8) ^ CRC32_TABLE[idx];
        }
    }
    !crc
}
