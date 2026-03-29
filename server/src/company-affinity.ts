import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { companies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * Company affinity filter for multi-server deployments.
 *
 * When `PAPERCLIP_SERVER_ID` is set, the server queries the `companies` table
 * for rows where `assigned_server_id` matches this server and refreshes the
 * managed set periodically.
 *
 * When `PAPERCLIP_SERVER_ID` is NOT set (single-server default), the server
 * manages ALL companies — no filtering is applied.
 *
 * API routes remain unfiltered — any server can read/write any company's data.
 */
let managedCompanyIds: Set<string> | null = null;
let serverId: string | null = null;

/** Initialise the affinity state from config. Call once at startup. */
export function initCompanyAffinity(serverIdValue: string | null): void {
  serverId = serverIdValue;
  // When no serverId is set, managedCompanyIds stays null → manage all.
}

/**
 * Refresh the dynamic affinity set from the database.
 * Queries `companies WHERE assigned_server_id = serverId` and updates the
 * in-memory managed set. Called periodically by the scheduler.
 */
export async function refreshDynamicAffinity(
  db: Db,
  serverIdValue: string,
): Promise<void> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.assignedServerId, serverIdValue));
  managedCompanyIds = new Set(rows.map((r) => r.id));
}

/** Returns the set of managed company IDs, or `null` when managing all. */
export function getManagedCompanyIds(): Set<string> | null {
  return managedCompanyIds;
}

/** Returns the configured server ID, or `null` when not set. */
export function getServerId(): string | null {
  return serverId;
}

/**
 * Returns `true` if this server should manage background work for `companyId`.
 * When affinity is not configured, returns `true` for every company.
 */
export function isManagedCompany(companyId: string): boolean {
  if (managedCompanyIds === null) return true;
  return managedCompanyIds.has(companyId);
}

/**
 * Returns a Drizzle SQL condition that restricts a query to managed companies.
 *
 * When affinity is not configured (manage all), returns `undefined` so callers
 * can safely spread it into an `and(...)` without effect.
 */
export function managedCompanyFilter(
  companyIdColumn: PgColumn,
): SQL | undefined {
  if (managedCompanyIds === null) return undefined;
  const ids = Array.from(managedCompanyIds);
  if (ids.length === 0) return sql`false`;
  return inArray(companyIdColumn, ids);
}
