import type { ServerMessage } from "../types.js";

export interface PubSubMessage {
  room: string;
  senderNodeId: string;
  senderConnId: string;
  payload: unknown;
  serverMessage?: ServerMessage;
  timestamp_ms: number;
}

export type MessageHandler = (message: PubSubMessage) => void;

/**
 * Interface for distributed real-time pub/sub backplanes.
 * Enables multiple gateway instances to exchange messages across rooms.
 */
export interface PubSubAdapter {
  readonly nodeId: string;

  /**
   * Publish a message to all nodes subscribed to the given room.
   */
  publish(room: string, message: PubSubMessage): Promise<void>;

  /**
   * Subscribe this node to receive broadcast messages for the given room.
   */
  subscribe(room: string, handler: MessageHandler): Promise<void>;

  /**
   * Unsubscribe this node from receiving broadcast messages for the given room.
   */
  unsubscribe(room: string): Promise<void>;

  /**
   * Check if this node is currently subscribed to a room topic.
   */
  isSubscribed(room: string): boolean;

  /**
   * List all rooms this node is currently subscribed to on the backplane.
   */
  getSubscribedRooms(): string[];

  /**
   * Close connections and clean up resources.
   */
  disconnect(): Promise<void>;
}
