import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ConnectionManager, type ManagedSocket } from "./connection-manager.js";
import type { PresenceAdapter } from "./presence/adapter.js";
import type { PubSubAdapter, PubSubMessage } from "./pubsub/adapter.js";
import type { ReplayBufferAdapter } from "./replay/adapter.js";
import type { ReplayedMessage, ServerMessage } from "./types.js";

export interface ClusteredManagerOptions {
  nodeId?: string;
  pubsub: PubSubAdapter;
  presence?: PresenceAdapter;
  replay?: ReplayBufferAdapter;
}

export interface JoinRoomResult {
  success: boolean;
  onlineUsers: string[];
  replayedMessages?: ReplayedMessage[];
  currentSeq?: number;
  isExpired?: boolean;
  oldestAvailableSeq?: number;
}

export interface ClusteredStats {
  node_id: string;
  local_connections: number;
  local_rooms: number;
  cluster_subscribed_rooms: string[];
  rooms: { name: string; local_subscribers: number }[];
}

/**
 * ClusteredConnectionManager coordinates local WebSocket connections with:
 * 1. Distributed Pub/Sub backplane (cross-node fan-out, dynamic channel subscriptions).
 * 2. Distributed Ephemeral Presence (sliding-window heartbeats, typing indicators, roster sync).
 * 3. Stream Replay Buffer (monotonic sequence IDs, disconnect catchup, zero message loss).
 */
export class ClusteredConnectionManager {
  public readonly nodeId: string;
  private readonly localManager: ConnectionManager;
  private readonly pubsub: PubSubAdapter;
  private readonly presence?: PresenceAdapter;
  private readonly replay?: ReplayBufferAdapter;

  constructor(options: ClusteredManagerOptions) {
    this.nodeId = options.nodeId ?? `node_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    this.pubsub = options.pubsub;
    this.presence = options.presence;
    this.replay = options.replay;
    this.localManager = new ConnectionManager();
  }

  public registerSocket(ws: WebSocket, userId?: string): ManagedSocket {
    return this.localManager.registerSocket(ws, userId);
  }

  public async removeSocket(connId: string): Promise<void> {
    const client = this.getConnection(connId);
    if (!client) return;

    const clientRooms = Array.from(client.rooms);
    const userId = client.userId;

    // Presence update: remove user from all joined rooms and notify cluster
    if (this.presence) {
      for (const room of clientRooms) {
        await this.presence.removeUser(room, userId);
        await this.broadcastServerMessage(
          room,
          {
            type: "user_left",
            room,
            user_id: userId,
          },
          connId,
        );
      }
    }

    this.localManager.removeSocket(connId);

    // Dynamic Unsubscribe Check: If any room no longer has local subscribers, unsubscribe from broker
    for (const room of clientRooms) {
      if (this.getLocalSubscriberCount(room) === 0 && this.pubsub.isSubscribed(room)) {
        await this.pubsub.unsubscribe(room);
      }
    }
  }

  public async joinRoom(
    connId: string,
    room: string,
    userId?: string,
    lastReceivedSeq?: number,
  ): Promise<JoinRoomResult> {
    const client = this.getConnection(connId);
    if (!client) return { success: false, onlineUsers: [] };

    if (userId) {
      client.userId = userId;
    }

    const hadZeroLocal = this.getLocalSubscriberCount(room) === 0;
    const joined = this.localManager.joinRoom(connId, room);
    if (!joined) return { success: false, onlineUsers: [] };

    // Dynamic Subscribe Check: First local subscriber triggers broker subscription
    if (hadZeroLocal && !this.pubsub.isSubscribed(room)) {
      await this.pubsub.subscribe(room, (remoteMsg) => this.handleRemoteClusterMessage(remoteMsg));
    }

    let onlineUsers: string[] = [];

    // Presence update: register heartbeat and notify peers
    if (this.presence) {
      await this.presence.heartbeat(room, client.userId);
      onlineUsers = await this.presence.getOnlineUsers(room);

      // Broadcast join event to all other room members across the cluster
      await this.broadcastServerMessage(
        room,
        {
          type: "user_joined",
          room,
          user_id: client.userId,
        },
        connId,
      );
    } else {
      onlineUsers = [client.userId];
    }

    // Replay buffer check: catchup missed messages if reconnecting
    let replayedMessages: ReplayedMessage[] | undefined;
    let currentSeq: number | undefined;
    let isExpired: boolean | undefined;
    let oldestAvailableSeq: number | undefined;

    if (this.replay && lastReceivedSeq !== undefined) {
      const range = await this.replay.getRange(room, lastReceivedSeq);
      currentSeq = range.currentSeq;
      oldestAvailableSeq = range.oldestSeq;
      isExpired = range.isExpired;
      if (!range.isExpired) {
        replayedMessages = range.messages;
      }
    }

    return {
      success: true,
      onlineUsers,
      replayedMessages,
      currentSeq,
      isExpired,
      oldestAvailableSeq,
    };
  }

  public async leaveRoom(connId: string, room: string): Promise<boolean> {
    const client = this.getConnection(connId);
    if (!client) return false;

    const userId = client.userId;

    if (this.presence) {
      await this.presence.removeUser(room, userId);
      await this.broadcastServerMessage(
        room,
        {
          type: "user_left",
          room,
          user_id: userId,
        },
        connId,
      );
    }

    const left = this.localManager.leaveRoom(connId, room);
    if (!left) return false;

    // Dynamic Unsubscribe Check: If no local subscribers remain, drop broker subscription
    if (this.getLocalSubscriberCount(room) === 0 && this.pubsub.isSubscribed(room)) {
      await this.pubsub.unsubscribe(room);
    }

    return true;
  }

  /**
   * Set or clear ephemeral typing status for a user in a room.
   */
  public async setTyping(connId: string, room: string, isTyping: boolean): Promise<boolean> {
    const client = this.getConnection(connId);
    if (!client || !client.rooms.has(room)) return false;

    if (this.presence) {
      await this.presence.setTyping(room, client.userId, isTyping);
    }

    // Broadcast typing event to all peers in the room (skipping sender)
    await this.broadcastServerMessage(
      room,
      {
        type: "user_typing",
        room,
        user_id: client.userId,
        is_typing: isTyping,
      },
      connId,
    );

    return true;
  }

  /**
   * Refresh presence leases for all rooms a client is currently participating in.
   */
  public async refreshPresence(connId: string): Promise<void> {
    const client = this.getConnection(connId);
    if (!client || !this.presence) return;

    for (const room of client.rooms) {
      await this.presence.heartbeat(room, client.userId);
    }
  }

  public async getOnlineUsers(room: string): Promise<string[]> {
    if (this.presence) {
      return this.presence.getOnlineUsers(room);
    }
    return [];
  }

  public async getTypingUsers(room: string): Promise<string[]> {
    if (this.presence) {
      return this.presence.getTypingUsers(room);
    }
    return [];
  }

  /**
   * Broadcast a user message across the cluster.
   * If a ReplayBuffer is configured, assigns a monotonic sequence ID and buffers for catchup.
   */
  public async broadcast(
    room: string,
    payload: unknown,
    senderConnId: string,
  ): Promise<{ localDelivered: number; seq?: number }> {
    const timestamp_ms = Date.now();
    let seq: number | undefined;

    if (this.replay) {
      const appended = await this.replay.append(room, senderConnId, payload, timestamp_ms);
      seq = appended.seq;
    }

    const serverMessage: ServerMessage = {
      type: "message",
      room,
      sender: senderConnId,
      payload,
      timestamp_ms,
      seq,
    };

    const localDelivered = await this.broadcastServerMessage(room, serverMessage, senderConnId);
    return { localDelivered, seq };
  }

  /**
   * Broadcast an arbitrary ServerMessage across both local sockets and the distributed backplane.
   */
  public async broadcastServerMessage(
    room: string,
    message: ServerMessage,
    senderConnId?: string,
  ): Promise<number> {
    // 1. Deliver to local sockets on this node (skipping sender)
    const localDelivered = this.localManager.broadcastToRoom(room, message, senderConnId);

    // 2. Publish to backplane for all other nodes in the cluster
    const clusterMessage: PubSubMessage = {
      room,
      senderNodeId: this.nodeId,
      senderConnId: senderConnId ?? "",
      payload: message,
      serverMessage: message,
      timestamp_ms: Date.now(),
    };

    await this.pubsub.publish(room, clusterMessage);

    return localDelivered;
  }

  /**
   * Handles inbound messages received from the distributed backplane.
   */
  private handleRemoteClusterMessage(msg: PubSubMessage): void {
    // Echo suppression: Ignore if originated from this node
    if (msg.senderNodeId === this.nodeId) {
      return;
    }

    const serverMsg: ServerMessage = msg.serverMessage ?? {
      type: "message",
      room: msg.room,
      sender: msg.senderConnId,
      payload: msg.payload,
      timestamp_ms: msg.timestamp_ms,
    };

    // Forward to all local subscribers in this room
    this.localManager.broadcastToRoom(msg.room, serverMsg);
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
    if (this.presence) {
      await this.presence.disconnect();
    }
    if (this.replay) {
      await this.replay.disconnect();
    }
  }
}
