export interface ReplayedMessage {
  seq: number;
  sender: string;
  payload: unknown;
  timestamp_ms: number;
}

export type ClientMessage =
  | { type: "join_room"; room: string; user_id?: string; last_received_seq?: number }
  | { type: "leave_room"; room: string }
  | { type: "send_message"; room: string; payload: unknown }
  | { type: "typing"; room: string; is_typing: boolean }
  | { type: "ping" };

export type ServerMessage =
  | { type: "welcome"; connection_id: string }
  | { type: "joined"; room: string }
  | { type: "left"; room: string }
  | {
      type: "message";
      room: string;
      sender: string;
      payload: unknown;
      timestamp_ms: number;
      seq?: number;
    }
  | {
      type: "replay_messages";
      room: string;
      messages: ReplayedMessage[];
      current_seq: number;
    }
  | {
      type: "replay_expired";
      room: string;
      oldest_available_seq: number;
      current_seq: number;
      message: string;
    }
  | { type: "presence_sync"; room: string; users: string[] }
  | { type: "user_joined"; room: string; user_id: string }
  | { type: "user_left"; room: string; user_id: string }
  | { type: "user_typing"; room: string; user_id: string; is_typing: boolean }
  | { type: "pong" }
  | { type: "error"; message: string };

export interface GatewayStats {
  total_connections: number;
  total_rooms: number;
  rooms: { name: string; subscribers: number }[];
}
