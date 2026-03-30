import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const fileOperations = pgTable(
  "file_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    serverId: text("server_id"),
    operationType: text("operation_type").notNull(),
    operationScope: text("operation_scope").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusServerIdx: index("file_operations_status_server_idx").on(table.status, table.serverId),
    companyIdx: index("file_operations_company_idx").on(table.companyId),
  }),
);
