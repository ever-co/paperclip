import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Company affinity filter for multi-server deployments.
 *
 * When `PAPERCLIP_MANAGED_COMPANY_IDS` is set, only the listed company IDs are
 * managed by this server instance's background processes (heartbeat scheduler,
 * routine scheduler, orphan reaper, runtime reconciliation, etc.).
 *
 * API routes remain unfiltered — any server can read/write any company's data.
 *
 * When the env var is not set, the server manages ALL companies (legacy default).
 */
let managedCompanyIds: Set<string> | null = null;
let serverId: string | null = null;

/** Initialise the affinity state from config. Call once at startup. */
export function initCompanyAffinity(
  ids: string[] | null,
  serverIdValue: string | null,
): void {
  managedCompanyIds = ids ? new Set(ids) : null;
  serverId = serverIdValue;
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
