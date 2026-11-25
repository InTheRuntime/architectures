import type { PresenceAdapter } from "./adapter.js";

/**
 * High-performance In-Memory Presence Adapter.
 * Emulates Redis Sorted Sets with sliding-window millisecond timestamps.
 */
export class InMemoryPresenceAdapter implements PresenceAdapter {
  private readonly defaultPresenceTtlMs: number;
  private readonly defaultTypingTtlMs: number;

  // room -> (userId -> lastHeartbeatMs)
  private readonly rosters = new Map<string, Map<string, number>>();

  // room -> (userId -> typingExpiresAtMs)
  private readonly typingStates = new Map<string, Map<string, number>>();

  constructor(options: { defaultPresenceTtlMs?: number; defaultTypingTtlMs?: number } = {}) {
    this.defaultPresenceTtlMs = options.defaultPresenceTtlMs ?? 15_000;
    this.defaultTypingTtlMs = options.defaultTypingTtlMs ?? 3_000;
  }

  public async heartbeat(room: string, userId: string, _ttlMs?: number): Promise<void> {
    let roomMap = this.rosters.get(room);
    if (!roomMap) {
      roomMap = new Map();
      this.rosters.set(room, roomMap);
    }
    roomMap.set(userId, Date.now());
  }

  public async removeUser(room: string, userId: string): Promise<void> {
    const roomMap = this.rosters.get(room);
    if (roomMap) {
      roomMap.delete(userId);
      if (roomMap.size === 0) {
        this.rosters.delete(room);
      }
    }

    const typingMap = this.typingStates.get(room);
    if (typingMap) {
      typingMap.delete(userId);
      if (typingMap.size === 0) {
        this.typingStates.delete(room);
      }
    }
  }

  public async getOnlineUsers(room: string, ttlMs?: number): Promise<string[]> {
    const threshold = Date.now() - (ttlMs ?? this.defaultPresenceTtlMs);
    const roomMap = this.rosters.get(room);
    if (!roomMap) return [];

    const activeUsers: string[] = [];
    for (const [userId, lastSeen] of roomMap.entries()) {
      if (lastSeen >= threshold) {
        activeUsers.push(userId);
      } else {
        // Prune expired entry
        roomMap.delete(userId);
      }
    }

    if (roomMap.size === 0) {
      this.rosters.delete(room);
    }

    return activeUsers;
  }

  public async getOnlineCount(room: string, ttlMs?: number): Promise<number> {
    const users = await this.getOnlineUsers(room, ttlMs);
    return users.length;
  }

  public async setTyping(
    room: string,
    userId: string,
    isTyping: boolean,
    ttlMs?: number,
  ): Promise<void> {
    let typingMap = this.typingStates.get(room);
    if (!typingMap) {
      typingMap = new Map();
      this.typingStates.set(room, typingMap);
    }

    if (!isTyping) {
      typingMap.delete(userId);
      if (typingMap.size === 0) {
        this.typingStates.delete(room);
      }
      return;
    }

    const expiresAt = Date.now() + (ttlMs ?? this.defaultTypingTtlMs);
    typingMap.set(userId, expiresAt);
  }

  public async getTypingUsers(room: string): Promise<string[]> {
    const now = Date.now();
    const typingMap = this.typingStates.get(room);
    if (!typingMap) return [];

    const activeTyping: string[] = [];
    for (const [userId, expiresAt] of typingMap.entries()) {
      if (expiresAt > now) {
        activeTyping.push(userId);
      } else {
        // Prune expired typing state
        typingMap.delete(userId);
      }
    }

    if (typingMap.size === 0) {
      this.typingStates.delete(room);
    }

    return activeTyping;
  }

  public async disconnect(): Promise<void> {
    this.rosters.clear();
    this.typingStates.clear();
  }
}
