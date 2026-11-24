import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ServerMessage } from "./types.js";

export interface ManagedSocket {
  id: string;
  socket: WebSocket;
  isAlive: boolean;
  rooms: Set<string>;
  connectedAtMs: number;
}

/**
 * Manages active WebSocket connections, room pub/sub subscriptions,
 * and heartbeat watchdog routines.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, ManagedSocket>();
  private readonly roomSubscribers = new Map<string, Set<string>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  public registerSocket(ws: WebSocket): ManagedSocket {
    const id = `conn_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const managed: ManagedSocket = {
      id,
      socket: ws,
      isAlive: true,
      rooms: new Set(),
      connectedAtMs: Date.now(),
    };

    this.connections.set(id, managed);
    return managed;
  }

  public removeSocket(id: string): void {
    const managed = this.connections.get(id);
    if (!managed) return;

    // Unsubscribe from all rooms
    for (const room of managed.rooms) {
      const roomSet = this.roomSubscribers.get(room);
      if (roomSet) {
        roomSet.delete(id);
        if (roomSet.size === 0) {
          this.roomSubscribers.delete(room);
        }
      }
    }

    this.connections.delete(id);
  }

  public joinRoom(connId: string, room: string): boolean {
    const managed = this.connections.get(connId);
    if (!managed) return false;

    managed.rooms.add(room);

    let roomSet = this.roomSubscribers.get(room);
    if (!roomSet) {
      roomSet = new Set();
      this.roomSubscribers.set(room, roomSet);
    }
    roomSet.add(connId);

    return true;
  }

  public leaveRoom(connId: string, room: string): boolean {
    const managed = this.connections.get(connId);
    if (!managed) return false;

    managed.rooms.delete(room);

    const roomSet = this.roomSubscribers.get(room);
    if (roomSet) {
      roomSet.delete(connId);
      if (roomSet.size === 0) {
        this.roomSubscribers.delete(room);
      }
    }

    return true;
  }

  public broadcastToRoom(room: string, message: ServerMessage, senderConnId?: string): number {
    const subscribers = this.roomSubscribers.get(room);
    if (!subscribers) return 0;

    const payload = JSON.stringify(message);
    let delivered = 0;

    for (const connId of subscribers) {
      if (senderConnId && connId === senderConnId) {
        continue; // Skip echo to sender if requested
      }

      const client = this.connections.get(connId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
        delivered++;
      }
    }

    return delivered;
  }

  public sendTo(connId: string, message: ServerMessage): boolean {
    const client = this.connections.get(connId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    client.socket.send(JSON.stringify(message));
    return true;
  }

  public getStats() {
    const roomsSummary = Array.from(this.roomSubscribers.entries()).map(([name, set]) => ({
      name,
      subscribers: set.size,
    }));

    return {
      total_connections: this.connections.size,
      total_rooms: this.roomSubscribers.size,
      rooms: roomsSummary,
    };
  }

  /**
   * Active Watchdog: Sweeps all sockets. Terminates zombie sockets
   * that failed to respond to the previous ping.
   */
  public sweepHeartbeats(): number {
    let zombiesTerminated = 0;

    for (const [id, managed] of this.connections.entries()) {
      if (!managed.isAlive) {
        // Socket failed to respond to ping since last interval -> Zombie!
        managed.socket.terminate();
        this.removeSocket(id);
        zombiesTerminated++;
        continue;
      }

      // Mark unverified and send ping
      managed.isAlive = false;
      managed.socket.ping();
    }

    return zombiesTerminated;
  }

  public startHeartbeatWatchdog(intervalMs = 15_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.sweepHeartbeats();
    }, intervalMs).unref();
  }

  public stopHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
