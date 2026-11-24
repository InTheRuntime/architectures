export type ClientMessage =
  | { type: "join_room"; room: string }
  | { type: "leave_room"; room: string }
  | { type: "send_message"; room: string; payload: unknown }
  | { type: "ping" };

export type ServerMessage =
  | { type: "welcome"; connection_id: string }
  | { type: "joined"; room: string }
  | { type: "left"; room: string }
  | { type: "message"; room: string; sender: string; payload: unknown; timestamp_ms: number }
  | { type: "pong" }
  | { type: "error"; message: string };

export interface GatewayStats {
  total_connections: number;
  total_rooms: number;
  rooms: { name: string; subscribers: number }[];
}
