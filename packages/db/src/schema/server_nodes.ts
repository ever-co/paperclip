import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const serverNodes = pgTable(
  "server_nodes",
  {
    id: text("id").primaryKey(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
