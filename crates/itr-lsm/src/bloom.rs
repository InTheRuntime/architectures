//! Space-efficient probabilistic Bloom Filter using Kirsch-Mitzenmacher double hashing.

use crate::error::{LsmError, Result};

/// Probabilistic set membership filter with zero false negatives.
///
/// Uses two 64-bit non-cryptographic hashes (`h1`, `h2`) to simulate `k` independent
/// bit probes via double hashing: `g_i(x) = (h1(x) + i * h2(x)) mod m`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BloomFilter {
    num_bits: u32,
    num_hashes: u32,
    bits: Vec<u8>,
}

impl BloomFilter {
    /// Allocates an optimally sized Bloom filter for `expected_items` at false-positive rate `fp_rate`.
    pub fn with_rate(expected_items: usize, fp_rate: f64) -> Self {
        let n = expected_items.max(1) as f64;
        let p = fp_rate.clamp(1e-6, 0.99);

        let ln2 = std::f64::consts::LN_2;
        let m_float = -(n * p.ln()) / (ln2 * ln2);
        let num_bits = (m_float.ceil() as u64).clamp(64, u32::MAX as u64) as u32;

        let k_float = ((num_bits as f64) / n) * ln2;
        let num_hashes = (k_float.round() as u32).clamp(1, 30);

        let byte_len = (num_bits as usize).div_ceil(8);
        Self {
            num_bits,
            num_hashes,
            bits: vec![0u8; byte_len],
        }
    }

    /// Builds a Bloom filter populated with all provided keys.
    pub fn build_from_keys<'a, I>(keys: I, expected_items: usize, fp_rate: f64) -> Self
    where
        I: IntoIterator<Item = &'a [u8]>,
    {
        let mut filter = Self::with_rate(expected_items, fp_rate);
        for key in keys {
            filter.insert(key);
        }
        filter
    }

    /// Inserts a key into the filter bitmap.
    pub fn insert(&mut self, key: &[u8]) {
        let (h1, h2) = Self::hash_pair(key);
        let m = self.num_bits as u64;

        for i in 0..(self.num_hashes as u64) {
            let bit_idx = (h1.wrapping_add(i.wrapping_mul(h2)) % m) as usize;
            self.bits[bit_idx / 8] |= 1u8 << (bit_idx % 8);
        }
    }

    /// Returns `false` if `key` is guaranteed absent, or `true` if it may be present.
    pub fn may_contain(&self, key: &[u8]) -> bool {
        if self.num_bits == 0 || self.bits.is_empty() {
            return true;
        }

        let (h1, h2) = Self::hash_pair(key);
        let m = self.num_bits as u64;

        for i in 0..(self.num_hashes as u64) {
            let bit_idx = (h1.wrapping_add(i.wrapping_mul(h2)) % m) as usize;
            if (self.bits[bit_idx / 8] & (1u8 << (bit_idx % 8))) == 0 {
                return false;
            }
        }

        true
    }

    /// Serializes the filter as `[num_bits: u32][num_hashes: u32][bitmap bytes...]`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.bits.len());
        out.extend_from_slice(&self.num_bits.to_le_bytes());
        out.extend_from_slice(&self.num_hashes.to_le_bytes());
        out.extend_from_slice(&self.bits);
        out
    }

    /// Deserializes a Bloom filter slice from an SSTable file.
    pub fn from_bytes(data: &[u8], path_str: &str) -> Result<Self> {
        if data.len() < 8 {
            return Err(LsmError::CorruptSstable {
                path: path_str.to_string(),
                reason: "Bloom filter header shorter than 8 bytes".to_string(),
            });
        }

        let num_bits = u32::from_le_bytes(data[0..4].try_into().unwrap());
        let num_hashes = u32::from_le_bytes(data[4..8].try_into().unwrap());
        let expected_bytes = (num_bits as usize).div_ceil(8);

        if data.len() != 8 + expected_bytes {
            return Err(LsmError::CorruptSstable {
                path: path_str.to_string(),
                reason: format!(
                    "Bloom filter length mismatch: expected {}, got {}",
                    8 + expected_bytes,
                    data.len()
                ),
            });
        }

        Ok(Self {
            num_bits,
            num_hashes,
            bits: data[8..].to_vec(),
        })
    }

    pub fn num_bits(&self) -> u32 {
        self.num_bits
    }

    pub fn num_hashes(&self) -> u32 {
        self.num_hashes
    }

    /// Produces two independent 64-bit hashes via FNV-1a and SplitMix64 mixing.
    fn hash_pair(key: &[u8]) -> (u64, u64) {
        let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in key {
            h1 ^= b as u64;
            h1 = h1.wrapping_mul(0x0100_0000_01b3);
        }

        // SplitMix64 finalizer with distinct seed for orthogonal second hash
        let mut h2 =
            h1 ^ 0x9e37_79b9_7f4a_7c15 ^ ((key.len() as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9));
        h2 = (h2 ^ (h2 >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        h2 = (h2 ^ (h2 >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        h2 ^= h2 >> 31;

        // Guarantee odd h2 so it is coprime with any power-of-two modulus and avoids degenerate 0 step
        (h1, h2 | 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bloom_zero_false_negatives_and_bounded_false_positives() {
        let count = 2_000usize;
        let mut keys = Vec::with_capacity(count);
        for i in 0..count {
            keys.push(format!("present_key_{i:06}").into_bytes());
        }

        let bloom = BloomFilter::build_from_keys(keys.iter().map(|k| k.as_slice()), count, 0.01);

        // Zero false negatives invariant
        for k in &keys {
            assert!(bloom.may_contain(k), "False negative detected!");
        }

        // Measure empirical false positive rate on 5,000 disjoint keys
        let probe_count = 5_000usize;
        let mut false_positives = 0usize;
        for i in 0..probe_count {
            let missing = format!("absent_key_{i:06}").into_bytes();
            if bloom.may_contain(&missing) {
                false_positives += 1;
            }
        }

        let observed_fpr = (false_positives as f64) / (probe_count as f64);
        assert!(
            observed_fpr < 0.025,
            "Observed FPR {observed_fpr:.4} exceeded acceptable threshold for target 0.01"
        );
    }

    #[test]
    fn test_bloom_serialization_roundtrip() {
        let keys = [b"alpha".as_slice(), b"beta".as_slice(), b"gamma".as_slice()];
        let original = BloomFilter::build_from_keys(keys.iter().copied(), keys.len(), 0.01);

        let bytes = original.to_bytes();
        let decoded = BloomFilter::from_bytes(&bytes, "test.db").unwrap();

        assert_eq!(original, decoded);
        assert!(decoded.may_contain(b"alpha"));
        assert!(decoded.may_contain(b"beta"));
        assert!(decoded.may_contain(b"gamma"));
    }
}
