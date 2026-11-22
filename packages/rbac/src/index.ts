/**
 * 64-bit BigInt bitmask Role-Based Access Control (RBAC) engine.
 * Provides constant-time O(1) permission evaluation.
 */

export class PermissionMask {
  public readonly mask: bigint;

  public static readonly EMPTY = new PermissionMask(0n);
  public static readonly ALL = new PermissionMask(0xffffffffffffffffn);

  constructor(mask: bigint | number | string) {
    this.mask = BigInt(mask);
  }

  public static fromShift(shift: number): PermissionMask {
    if (shift < 0 || shift > 63) {
      throw new RangeError("Permission bit shift must be between 0 and 63");
    }
    return new PermissionMask(1n << BigInt(shift));
  }

  public hasPermission(required: PermissionMask): boolean {
    return (this.mask & required.mask) === required.mask;
  }

  public missingPermissions(required: PermissionMask): PermissionMask {
    return new PermissionMask(required.mask & ~this.mask);
  }

  public verify(required: PermissionMask): void {
    if (!this.hasPermission(required)) {
      const missing = this.missingPermissions(required);
      throw new Error(
        `Missing required permissions: required 0x${required.toHex()}, provided 0x${this.toHex()}, missing 0x${missing.toHex()}`,
      );
    }
  }

  public union(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.mask | other.mask);
  }

  public intersect(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.mask & other.mask);
  }

  public remove(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.mask & ~other.mask);
  }

  public toHex(): string {
    return this.mask.toString(16).padStart(16, "0");
  }

  public toJSON(): string {
    return `0x${this.toHex()}`;
  }
}
