import { Redis } from "ioredis";
import type { MessageHandler, PubSubAdapter, PubSubMessage } from "./adapter.js";

export interface RedisPubSubConfig {
  redisUrl?: string;
  host?: string;
  port?: number;
  channelPrefix?: string;
}

/**
 * Production Redis Pub/Sub Backplane Adapter.
 *
 * Architecture:
 * - Employs two separate Redis client instances:
 *   1. `pubClient`: dedicated to executing PUBLISH commands.
 *   2. `subClient`: dedicated to SUBSCRIBE / UNSUBSCRIBE listener commands.
 *   (Redis protocol specification strictly forbids executing general commands on a client in subscriber mode).
 * - Implements channel prefixing (`ws:cluster:room:<room>`) to avoid key collisions.
 */
export class RedisPubSubAdapter implements PubSubAdapter {
  public readonly nodeId: string;
  private readonly prefix: string;
  private readonly pubClient: Redis;
  private readonly subClient: Redis;
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly subscribedRooms = new Set<string>();
  private isConnected = false;

  constructor(nodeId: string, config: RedisPubSubConfig = {}) {
    this.nodeId = nodeId;
    this.prefix = config.channelPrefix ?? "ws:cluster:room:";

    if (config.redisUrl) {
      this.pubClient = new Redis(config.redisUrl, { lazyConnect: true });
      this.subClient = new Redis(config.redisUrl, { lazyConnect: true });
    } else {
      const host = config.host ?? process.env.REDIS_HOST ?? "localhost";
      const port = config.port ?? Number(process.env.REDIS_PORT) ?? 6379;
      this.pubClient = new Redis({ host, port, lazyConnect: true });
      this.subClient = new Redis({ host, port, lazyConnect: true });
    }

    this.setupMessageListener();
  }

  private setupMessageListener(): void {
    this.subClient.on("message", (channel: string, payloadStr: string) => {
      const room = channel.slice(this.prefix.length);
      const handler = this.handlers.get(room);
      if (!handler) return;

      try {
        const parsed: PubSubMessage = JSON.parse(payloadStr);

        // Echo suppression: ignore messages originally published by this node
        if (parsed.senderNodeId === this.nodeId) {
          return;
        }

        handler(parsed);
      } catch (err) {
        console.error(
          `[RedisPubSubAdapter:${this.nodeId}] Failed to parse message on ${channel}:`,
          err,
        );
      }
    });
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;
    await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
    this.isConnected = true;
  }

  public async publish(room: string, message: PubSubMessage): Promise<void> {
    const channel = `${this.prefix}${room}`;
    const payload = JSON.stringify(message);
    await this.pubClient.publish(channel, payload);
  }

  public async subscribe(room: string, handler: MessageHandler): Promise<void> {
    const channel = `${this.prefix}${room}`;
    this.handlers.set(room, handler);
    this.subscribedRooms.add(room);
    await this.subClient.subscribe(channel);
  }

  public async unsubscribe(room: string): Promise<void> {
    const channel = `${this.prefix}${room}`;
    this.handlers.delete(room);
    this.subscribedRooms.delete(room);
    await this.subClient.unsubscribe(channel);
  }

  public isSubscribed(room: string): boolean {
    return this.subscribedRooms.has(room);
  }

  public getSubscribedRooms(): string[] {
    return Array.from(this.subscribedRooms);
  }

  public async disconnect(): Promise<void> {
    this.handlers.clear();
    this.subscribedRooms.clear();
    this.isConnected = false;
    await Promise.all([this.pubClient.quit(), this.subClient.quit()]);
  }
}
