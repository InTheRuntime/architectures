import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ConnectionManager, type ManagedSocket } from "./connection-manager.js";
import type { PubSubAdapter, PubSubMessage } from "./pubsub/adapter.js";
import type { ServerMessage } from "./types.js";

export interface ClusteredManagerOptions {
  nodeId?: string;
  pubsub: PubSubAdapter;
}

export interface ClusteredStats {
  node_id: string;
  local_connections: number;
  local_rooms: number;
  cluster_subscribed_rooms: string[];
  rooms: { name: string; local_subscribers: number }[];
}

/**
 * ClusteredConnectionManager coordinates local WebSocket connections with a
 * distributed Pub/Sub backplane (Redis or In-Memory Hub).
 *
 * Implements:
 * 1. Horizontal cross-node broadcast fan-out.
 * 2. Dynamic channel subscription ref-counting: only subscribes to the broker
 *    when local subscribers > 0, and unsubscribes when local subscribers drop to 0.
 * 3. Echo suppression to prevent circular re-broadcasts.
 */
export class ClusteredConnectionManager {
  public readonly nodeId: string;
  private readonly localManager: ConnectionManager;
  private readonly pubsub: PubSubAdapter;

  constructor(options: ClusteredManagerOptions) {
    this.nodeId = options.nodeId ?? `node_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    this.pubsub = options.pubsub;
    this.localManager = new ConnectionManager();
  }

  public registerSocket(ws: WebSocket): ManagedSocket {
    return this.localManager.registerSocket(ws);
  }

  public async removeSocket(connId: string): Promise<void> {
    const client = this.getConnection(connId);
    if (!client) return;

    // Capture rooms client was in before removal to check ref-counts
    const clientRooms = Array.from(client.rooms);

    this.localManager.removeSocket(connId);

    // Dynamic Unsubscribe Check: If any room no longer has local subscribers, unsubscribe from broker
    for (const room of clientRooms) {
      if (this.getLocalSubscriberCount(room) === 0 && this.pubsub.isSubscribed(room)) {
        await this.pubsub.unsubscribe(room);
      }
    }
  }

  public async joinRoom(connId: string, room: string): Promise<boolean> {
    const hadZeroLocal = this.getLocalSubscriberCount(room) === 0;

    const joined = this.localManager.joinRoom(connId, room);
    if (!joined) return false;

    // Dynamic Subscribe Check: First local subscriber triggers broker subscription
    if (hadZeroLocal && !this.pubsub.isSubscribed(room)) {
      await this.pubsub.subscribe(room, (remoteMsg) => this.handleRemoteClusterMessage(remoteMsg));
    }

    return true;
  }

  public async leaveRoom(connId: string, room: string): Promise<boolean> {
    const left = this.localManager.leaveRoom(connId, room);
    if (!left) return false;

    // Dynamic Unsubscribe Check: If no local subscribers remain, drop broker subscription
    if (this.getLocalSubscriberCount(room) === 0 && this.pubsub.isSubscribed(room)) {
      await this.pubsub.unsubscribe(room);
    }

    return true;
  }

  /**
   * Broadcast a message across the entire cluster.
   * Delivers immediately to local sockets and publishes to the backplane for remote nodes.
   */
  public async broadcast(
    room: string,
    payload: unknown,
    senderConnId: string,
  ): Promise<{ localDelivered: number }> {
    const timestamp_ms = Date.now();

    // 1. Deliver to local sockets on this node (skipping sender)
    const localDelivered = this.localManager.broadcastToRoom(
      room,
      {
        type: "message",
        room,
        sender: senderConnId,
        payload,
        timestamp_ms,
      },
      senderConnId,
    );

    // 2. Publish to backplane for all other nodes in the cluster
    const clusterMessage: PubSubMessage = {
      room,
      senderNodeId: this.nodeId,
      senderConnId,
      payload,
      timestamp_ms,
    };

    await this.pubsub.publish(room, clusterMessage);

    return { localDelivered };
  }

  /**
   * Handles inbound messages received from the distributed backplane.
   */
  private handleRemoteClusterMessage(msg: PubSubMessage): void {
    // Echo suppression: Ignore if originated from this node
    if (msg.senderNodeId === this.nodeId) {
      return;
    }

    const serverMessage: ServerMessage = {
      type: "message",
      room: msg.room,
      sender: msg.senderConnId,
      payload: msg.payload,
      timestamp_ms: msg.timestamp_ms,
    };

    // Forward to all local subscribers in this room
    this.localManager.broadcastToRoom(msg.room, serverMessage);
  }

  public sendTo(connId: string, message: ServerMessage): boolean {
    return this.localManager.sendTo(connId, message);
  }

  public getConnection(connId: string): ManagedSocket | undefined {
    return this.localManager.getConnection(connId);
  }

  public getLocalSubscriberCount(room: string): number {
    const stats = this.localManager.getStats();
    const roomStat = stats.rooms.find((r) => r.name === room);
    return roomStat ? roomStat.subscribers : 0;
  }

  public getStats(): ClusteredStats {
    const local = this.localManager.getStats();
    return {
      node_id: this.nodeId,
      local_connections: local.total_connections,
      local_rooms: local.total_rooms,
      cluster_subscribed_rooms: this.pubsub.getSubscribedRooms(),
      rooms: local.rooms.map((r) => ({
        name: r.name,
        local_subscribers: r.subscribers,
      })),
    };
  }

  public sweepHeartbeats(): number {
    return this.localManager.sweepHeartbeats();
  }

  public startHeartbeatWatchdog(intervalMs = 15_000): void {
    this.localManager.startHeartbeatWatchdog(intervalMs);
  }

  public stopHeartbeatWatchdog(): void {
    this.localManager.stopHeartbeatWatchdog();
  }

  public async shutdown(): Promise<void> {
    this.stopHeartbeatWatchdog();
    await this.pubsub.disconnect();
  }
}
