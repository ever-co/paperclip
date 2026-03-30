import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { serverNodes } from "@paperclipai/db";
import { desc } from "drizzle-orm";
import { assertBoard } from "./authz.js";

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

export function serverRoutes(db: Db) {
  const router = Router();

  router.get("/", async (req, res) => {
    assertBoard(req);
    const now = Date.now();
    const nodes = await db
      .select()
      .from(serverNodes)
      .orderBy(desc(serverNodes.lastHeartbeatAt));
    const result = nodes.map((node) => ({
      id: node.id,
      lastHeartbeatAt: node.lastHeartbeatAt,
      status:
        now - new Date(node.lastHeartbeatAt).getTime() < ONLINE_THRESHOLD_MS
          ? ("online" as const)
          : ("offline" as const),
      metadata: node.metadata,
      createdAt: node.createdAt,
    }));
    res.json(result);
  });

  return router;
}
