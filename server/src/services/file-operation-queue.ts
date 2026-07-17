/**
 * File Operation Queue — DB-based job queue for cross-server file operations.
 *
 * In multi-server deployments, file operations (agent instructions, skills)
 * must execute on the server that manages the company's local filesystem.
 *
 * When the API server handling a request is NOT the managing server, it inserts
 * a `file_operations` row and polls until the managing server picks it up,
 * executes it, and writes the result back.
 *
 * This follows the exact same pattern as heartbeat runs:
 * - Main server inserts a queued row with the target serverId
 * - Worker server periodically ticks, finds pending ops, executes locally
 * - Result flows back through the DB
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { fileOperations } from "@paperclipai/db";
import { isManagedCompany, managedCompanyFilter, resolveServerIdForCompany } from "../company-affinity.js";
import { logger } from "../middleware/logger.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { companySkillService } from "./company-skills.js";

/** How often the dispatcher polls for a result (ms). */
const DISPATCH_POLL_INTERVAL_MS = 500;

/** Max time the dispatcher waits for a remote operation to complete (ms). */
const DISPATCH_TIMEOUT_MS = 60_000;

/** How old completed operations need to be before cleanup (ms). */
const CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Check if a file operation for `companyId` should be dispatched to a remote
 * server via the DB queue, or can be executed locally.
 *
 * Returns `true` if the operation can be handled locally (fast path).
 */
export function isLocalFileOperation(companyId: string): boolean {
  return isManagedCompany(companyId);
}

/**
 * Dispatch a file operation to the remote server managing the company.
 *
 * Inserts a pending row into `file_operations`, then polls until the managing
 * server picks it up and writes the result back. Returns the result payload.
 */
export async function dispatchFileOperation(
  db: Db,
  companyId: string,
  operationType: string,
  operationScope: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const serverId = await resolveServerIdForCompany(db, companyId);

  const [row] = await db
    .insert(fileOperations)
    .values({
      companyId,
      serverId,
      operationType,
      operationScope,
      status: "pending",
      payload,
    })
    .returning();

  const opId = row.id;
  const startTime = Date.now();

  // Poll for completion.
  while (Date.now() - startTime < DISPATCH_TIMEOUT_MS) {
    await sleep(DISPATCH_POLL_INTERVAL_MS);

    const [current] = await db
      .select({
        status: fileOperations.status,
        result: fileOperations.result,
        error: fileOperations.error,
      })
      .from(fileOperations)
      .where(eq(fileOperations.id, opId));

    if (!current) {
      throw new Error(`File operation ${opId} disappeared from the database`);
    }

    if (current.status === "completed") {
      return (current.result as Record<string, unknown>) ?? {};
    }

    if (current.status === "failed") {
      const errorMessage = current.error ?? "Remote file operation failed";
      const error = new Error(errorMessage);
      // Preserve HTTP status if the remote handler set one.
      const result = current.result as Record<string, unknown> | null;
      if (result?.statusCode && typeof result.statusCode === "number") {
        (error as any).statusCode = result.statusCode;
      }
      throw error;
    }
  }

  // Timeout — mark as failed so the worker won't pick it up later.
  await db
    .update(fileOperations)
    .set({
      status: "failed",
      error: "Timed out waiting for remote server to execute file operation",
      updatedAt: new Date(),
    })
    .where(eq(fileOperations.id, opId));

  throw new Error(
    `File operation timed out after ${DISPATCH_TIMEOUT_MS / 1000}s. ` +
    `The managing server for company ${companyId} may be offline.`,
  );
}

// ─── Executor (runs on the worker server) ────────────────────────────────────

/**
 * Tick pending file operations for companies managed by this server.
 *
 * Called from the heartbeat scheduler interval. Finds pending operations,
 * executes them locally, and writes results back to the DB.
 */
export function fileOperationQueueService(db: Db) {
  const instructions = agentInstructionsService();
  const skills = companySkillService(db);

  async function tickPendingFileOperations(): Promise<{ executed: number }> {
    const pendingOps = await db
      .select()
      .from(fileOperations)
      .where(
        and(
          eq(fileOperations.status, "pending"),
          managedCompanyFilter(fileOperations.companyId),
        ),
      );

    let executed = 0;

    for (const op of pendingOps) {
      // Mark as processing to prevent double-execution.
      const [claimed] = await db
        .update(fileOperations)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(fileOperations.id, op.id),
            eq(fileOperations.status, "pending"),
          ),
        )
        .returning();

      if (!claimed) continue; // Another server got it first.

      try {
        const result = await executeFileOperation(op);
        await db
          .update(fileOperations)
          .set({
            status: "completed",
            result,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(fileOperations.id, op.id));
        executed++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const statusCode = (err as any)?.statusCode;
        logger.error(
          { err, fileOperationId: op.id, operationType: op.operationType },
          "file operation execution failed",
        );
        await db
          .update(fileOperations)
          .set({
            status: "failed",
            error: errorMessage,
            result: statusCode ? { statusCode } : null,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(fileOperations.id, op.id));
      }
    }

    return { executed };
  }

  async function executeFileOperation(
    op: typeof fileOperations.$inferSelect,
  ): Promise<Record<string, unknown>> {
    const payload = (op.payload ?? {}) as Record<string, unknown>;
    const scope = op.operationScope;
    const type = op.operationType;

    if (scope === "agent_instructions") {
      return executeAgentInstructionOp(type, payload);
    }

    if (scope === "company_skills") {
      return executeCompanySkillOp(type, payload, op.companyId);
    }

    throw new Error(`Unknown file operation scope: ${scope}`);
  }

  async function executeAgentInstructionOp(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const agent = payload.agent as {
      id: string;
      companyId: string;
      name: string;
      adapterConfig: unknown;
    };

    switch (type) {
      case "get_bundle": {
        const bundle = await instructions.getBundle(agent);
        return { bundle } as unknown as Record<string, unknown>;
      }

      case "read_file": {
        const relativePath = payload.relativePath as string;
        const file = await instructions.readFile(agent, relativePath);
        return { file } as unknown as Record<string, unknown>;
      }

      case "write_file": {
        const relativePath = payload.path as string;
        const content = payload.content as string;
        const clearLegacy = payload.clearLegacyPromptTemplate as boolean | undefined;
        const result = await instructions.writeFile(agent, relativePath, content, {
          clearLegacyPromptTemplate: clearLegacy,
        });
        return {
          bundle: result.bundle,
          file: result.file,
          adapterConfig: result.adapterConfig,
        } as unknown as Record<string, unknown>;
      }

      case "delete_file": {
        const relativePath = payload.relativePath as string;
        const result = await instructions.deleteFile(agent, relativePath);
        return {
          bundle: result.bundle,
          adapterConfig: result.adapterConfig,
        } as unknown as Record<string, unknown>;
      }

      case "update_bundle": {
        const input = payload.input as {
          mode?: "managed" | "external";
          rootPath?: string | null;
          entryFile?: string;
          clearLegacyPromptTemplate?: boolean;
        };
        const result = await instructions.updateBundle(agent, input);
        return {
          bundle: result.bundle,
          adapterConfig: result.adapterConfig,
        } as unknown as Record<string, unknown>;
      }

      case "materialize_bundle": {
        const files = payload.files as Record<string, string>;
        const options = payload.options as {
          clearLegacyPromptTemplate?: boolean;
          replaceExisting?: boolean;
          entryFile?: string;
        } | undefined;
        const result = await instructions.materializeManagedBundle(agent, files, options);
        return {
          bundle: result.bundle,
          adapterConfig: result.adapterConfig,
        } as unknown as Record<string, unknown>;
      }

      default:
        throw new Error(`Unknown agent_instructions operation: ${type}`);
    }
  }

  async function executeCompanySkillOp(
    type: string,
    payload: Record<string, unknown>,
    companyId: string,
  ): Promise<Record<string, unknown>> {
    switch (type) {
      case "read_file": {
        const skillId = payload.skillId as string;
        const relativePath = payload.relativePath as string;
        const result = await skills.readFile(companyId, skillId, relativePath);
        if (!result) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
        return { result } as unknown as Record<string, unknown>;
      }

      case "create_local": {
        const input = payload.input as {
          name: string;
          slug?: string;
          description?: string;
          markdown?: string;
        };
        const result = await skills.createLocalSkill(companyId, input);
        return { result } as unknown as Record<string, unknown>;
      }

      case "update_file": {
        const skillId = payload.skillId as string;
        const filePath = payload.path as string;
        const content = payload.content as string;
        const result = await skills.updateFile(companyId, skillId, filePath, content);
        return { result } as unknown as Record<string, unknown>;
      }

      case "delete_skill": {
        const skillId = payload.skillId as string;
        const result = await skills.deleteSkill(companyId, skillId);
        if (!result) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
        return { result } as unknown as Record<string, unknown>;
      }

      case "import_source": {
        const source = payload.source as string;
        const result = await skills.importFromSource(companyId, source);
        return { result } as unknown as Record<string, unknown>;
      }

      case "scan_projects": {
        const input = payload.input as Record<string, unknown>;
        const result = await skills.scanProjectWorkspaces(companyId, input as any);
        return { result } as unknown as Record<string, unknown>;
      }

      case "install_update": {
        const skillId = payload.skillId as string;
        const result = await skills.installUpdate(companyId, skillId);
        if (!result) throw Object.assign(new Error("Skill not found"), { statusCode: 404 });
        return { result } as unknown as Record<string, unknown>;
      }

      default:
        throw new Error(`Unknown company_skills operation: ${type}`);
    }
  }

  /**
   * Clean up old completed/failed file operations.
   */
  async function cleanupStaleOperations(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);
    const result = await db
      .delete(fileOperations)
      .where(
        and(
          inArray(fileOperations.status, ["completed", "failed"]),
          lt(fileOperations.completedAt, cutoff),
        ),
      )
      .returning({ id: fileOperations.id });
    return { deleted: result.length };
  }

  return {
    tickPendingFileOperations,
    cleanupStaleOperations,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
