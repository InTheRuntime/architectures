//! # itr-rbac
//! Zero-allocation, constant-time $O(1)$ 64-bit bitmask Role-Based Access Control (RBAC).

use thiserror::Error;

/// Error returned when authorization fails.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RbacError {
    #[error("Missing required permissions: required 0x{required:016X}, provided 0x{provided:016X}, missing 0x{missing:016X}")]
    MissingPermissions {
        required: u64,
        provided: u64,
        missing: u64,
    },
}

/// Bitwise permission mask representing up to 64 granular operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct PermissionMask(pub u64);

impl PermissionMask {
    pub const EMPTY: Self = Self(0);
    pub const ALL: Self = Self(u64::MAX);

    #[inline(always)]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    #[inline(always)]
    pub const fn from_shift(shift: u8) -> Self {
        assert!(shift < 64, "Bitmask shift must be iwn 0..63");
        Self(1u64 << shift)
    }

    #[inline(always)]
    pub const fn bits(&self) -> u64 {
        self.0
    }

    /// Constant-time O(1) authorization verification: (user & required) == required.
    #[inline(always)]
    pub const fn has_permission(&self, required: Self) -> bool {
        (self.0 & required.0) == required.0
    }

    /// Computes missing permissions as a bitmask.
    #[inline(always)]
    pub const fn missing_permissions(&self, required: Self) -> Self {
        Self(required.0 & !self.0)
    }

    /// Verifies permissions, returning Result.
    #[inline]
    pub fn verify(&self, required: Self) -> Result<(), RbacError> {
        if self.has_permission(required) {
            Ok(())
        } else {
            Err(RbacError::MissingPermissions {
                required: required.0,
                provided: self.0,
                missing: self.missing_permissions(required).0,
            })
        }
    }

    /// Combines permissions (bitwise OR).
    #[inline(always)]
    pub const fn union(&self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Intersects permissions (bitwise AND).
    #[inline(always)]
    pub const fn intersect(&self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    /// Removes permissions (bitwise AND NOT).
    #[inline(always)]
    pub const fn remove(&self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERM_READ: PermissionMask = PermissionMask::from_shift(0);   // 1 << 0 = 0x01
    const PERM_WRITE: PermissionMask = PermissionMask::from_shift(1);  // 1 << 1 = 0x02
    const PERM_DELETE: PermissionMask = PermissionMask::from_shift(2); // 1 << 2 = 0x04
    const PERM_ADMIN: PermissionMask = PermissionMask::from_shift(3);  // 1 << 3 = 0x08

    #[test]
    fn test_constant_time_permission_checks() {
        let editor_role = PERM_READ.union(PERM_WRITE);
        assert!(editor_role.has_permission(PERM_READ));
        assert!(editor_role.has_permission(PERM_WRITE));
        assert!(!editor_role.has_permission(PERM_DELETE));
        assert!(!editor_role.has_permission(PERM_ADMIN));

        let admin_role = editor_role.union(PERM_DELETE).union(PERM_ADMIN);
        assert!(admin_role.has_permission(PERM_READ));
        assert!(admin_role.has_permission(PERM_DELETE));
        assert!(admin_role.has_permission(PERM_ADMIN));
    }

    #[test]
    fn test_verification_error_reporting() {
        let read_only = PERM_READ;
        let required = PERM_READ.union(PERM_WRITE);

        let result = read_only.verify(required);
        assert!(result.is_err());
        if let Err(RbacError::MissingPermissions { missing, .. }) = result {
            assert_eq!(missing, PERM_WRITE.bits());
        }
    }
}
