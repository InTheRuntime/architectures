import type { MessageHandler, PubSubAdapter, PubSubMessage } from "./adapter.js";

/**
 * Shared in-memory pub/sub broker hub for multi-node testing and in-process simulation.
 * Replicates Redis Pub/Sub semantics without external network dependencies.
 */
export class InMemoryPubSubHub {
  private readonly channels = new Map<string, Map<string, MessageHandler>>();

  public subscribe(room: string, nodeId: string, handler: MessageHandler): void {
    let subs = this.channels.get(room);
    if (!subs) {
      subs = new Map();
      this.channels.set(room, subs);
    }
    subs.set(nodeId, handler);
  }

  public unsubscribe(room: string, nodeId: string): void {
    const subs = this.channels.get(room);
    if (subs) {
      subs.delete(nodeId);
      if (subs.size === 0) {
        this.channels.delete(room);
      }
    }
  }

  public publish(room: string, message: PubSubMessage): void {
    const subs = this.channels.get(room);
    if (!subs) return;

    // Dispatch asynchronously to emulate network I/O
    for (const [subNodeId, handler] of subs.entries()) {
      if (subNodeId === message.senderNodeId) {
        // Echo suppression: the publishing node already delivered locally
        continue;
      }
      queueMicrotask(() => handler(message));
    }
  }

  public getChannelSubscriberCount(room: string): number {
    return this.channels.get(room)?.size ?? 0;
  }

  public getActiveChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  public clear(): void {
    this.channels.clear();
  }
}

/**
 * Adapter connected to an InMemoryPubSubHub.
 */
export class InMemoryPubSubAdapter implements PubSubAdapter {
  public readonly nodeId: string;
  private readonly hub: InMemoryPubSubHub;
  private readonly subscribedRooms = new Set<string>();

  constructor(nodeId: string, hub: InMemoryPubSubHub) {
    this.nodeId = nodeId;
    this.hub = hub;
  }

  public async publish(room: string, message: PubSubMessage): Promise<void> {
    this.hub.publish(room, message);
  }

  public async subscribe(room: string, handler: MessageHandler): Promise<void> {
    this.subscribedRooms.add(room);
    this.hub.subscribe(room, this.nodeId, handler);
  }

  public async unsubscribe(room: string): Promise<void> {
    this.subscribedRooms.delete(room);
    this.hub.unsubscribe(room, this.nodeId);
  }

  public isSubscribed(room: string): boolean {
    return this.subscribedRooms.has(room);
  }

  public getSubscribedRooms(): string[] {
    return Array.from(this.subscribedRooms);
  }

  public async disconnect(): Promise<void> {
    for (const room of Array.from(this.subscribedRooms)) {
      await this.unsubscribe(room);
    }
  }
}
