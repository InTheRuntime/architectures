/**
 * Presence & Typing Indicator Adapter Interface.
 * Manages active rosters, sliding-window heartbeat leases, and ephemeral typing indicators.
 */
export interface PresenceAdapter {
  /**
   * Refresh a user's presence heartbeat lease in a room.
   * @param room Room name
   * @param userId Unique user identifier
   * @param ttlMs Sliding-window expiration time in milliseconds (default 15,000ms)
   */
  heartbeat(room: string, userId: string, ttlMs?: number): Promise<void>;

  /**
   * Explicitly remove a user from a room roster (on leave or clean disconnect).
   */
  removeUser(room: string, userId: string): Promise<void>;

  /**
   * Get all active, non-expired users in a room.
   * Dead/expired user entries are pruned automatically.
   */
  getOnlineUsers(room: string, ttlMs?: number): Promise<string[]>;

  /**
   * Get the count of active users in a room.
   */
  getOnlineCount(room: string, ttlMs?: number): Promise<number>;

  /**
   * Set or clear a user's ephemeral typing state.
   * @param ttlMs Auto-expiration duration in milliseconds (default 3,000ms)
   */
  setTyping(room: string, userId: string, isTyping: boolean, ttlMs?: number): Promise<void>;

  /**
   * Get list of users currently typing in a room.
   */
  getTypingUsers(room: string): Promise<string[]>;

  /**
   * Disconnect and clean up resources.
   */
  disconnect(): Promise<void>;
}
