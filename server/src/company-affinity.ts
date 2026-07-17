import { eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
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
 * manages only companies that have NO `assigned_server_id` set (unassigned).
 * This prevents a headless server from stealing work from dedicated workers.
 *
 * API routes remain unfiltered — any server can read/write any company's data.
 */
let managedCompanyIds: Set<string> | null = null;
let serverId: string | null = null;
let affinityInitialized = false;

/** Initialise the affinity state from config. Call once at startup. */
export function initCompanyAffinity(serverIdValue: string | null): void {
  serverId = serverIdValue;
  affinityInitialized = true;
  // managedCompanyIds stays null until first refreshDynamicAffinity call.
}

/**
 * Refresh the dynamic affinity set from the database.
 *
 * When `serverIdValue` is provided, queries companies assigned to that server.
 * When called without a serverIdValue (for unassigned-mode), queries companies
 * with `assigned_server_id IS NULL`.
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

/**
 * Refresh affinity for an unassigned (no server ID) server.
 * Queries companies with `assigned_server_id IS NULL`.
 */
export async function refreshUnassignedAffinity(db: Db): Promise<void> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(isNull(companies.assignedServerId));
  managedCompanyIds = new Set(rows.map((r) => r.id));
}

/** Returns the set of managed company IDs, or `null` when not yet refreshed. */
export function getManagedCompanyIds(): Set<string> | null {
  return managedCompanyIds;
}

/** Returns the configured server ID, or `null` when not set. */
export function getServerId(): string | null {
  return serverId;
}

/**
 * Returns `true` if this server should manage background work for `companyId`.
 *
 * Before the first affinity refresh, returns `true` for every company so that
 * single-server setups (no DB refresh cycle) continue to work. After the first
 * refresh, strictly checks the managed set.
 */
export function isManagedCompany(companyId: string): boolean {
  if (managedCompanyIds === null) return true;
  return managedCompanyIds.has(companyId);
}

/**
 * Returns a Drizzle SQL condition that restricts a query to managed companies.
 *
 * When affinity has not been refreshed yet, returns `undefined` so callers
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

/**
 * Resolve the correct `server_id` to stamp on a heartbeat run for a company.
 *
 * In multi-server deployments, a run may be enqueued via API on the main server
 * but should execute on a dedicated worker node. The `server_id` on the run
 * should reflect the company's `assigned_server_id` so the correct server
 * picks it up. Falls back to `getServerId()` for unassigned companies.
 */
export async function resolveServerIdForCompany(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ assignedServerId: companies.assignedServerId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row?.assignedServerId ?? getServerId();
}

