import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateDraftBody,
  CreateDraftResponse,
  CreateDraftShareParams,
  CreateDraftShareResponse,
  CreateReviewCommentBody,
  CreateReviewCommentParams,
  CreateReviewCommentResponse,
  GetDashboardSummaryResponse,
  DeleteDraftParams,
  GetDraftParams,
  GetDraftResponse,
  GetDraftsResponse,
  GetReviewParams,
  GetReviewPageImageParams,
  GetReviewResponse,
  UpdateCommentBody,
  UpdateCommentParams,
  UpdateCommentResponse,
  UpdateDraftBody,
  UpdateDraftParams,
  UpdateDraftResponse,
} from "@workspace/api-zod";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import { db, comicDraftsTable, reviewCommentsTable } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

function requireUser(req: Request, res: Response): string | null {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in required" });
    return null;
  }
  return req.user.id;
}

function requestOrigin(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return `${proto}://${host}`;
}

function serializeDraft(
  draft: typeof comicDraftsTable.$inferSelect,
  commentCount: number,
  resolvedCount: number,
) {
  return {
    id: draft.id,
    title: draft.title,
    status: draft.status,
    pages: draft.pages,
    shareEnabled: draft.shareEnabled,
    commentCount,
    resolvedCount,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

async function getCommentCounts(draftIds: string[]) {
  const countsById = new Map<string, { commentCount: number; resolvedCount: number }>();
  if (draftIds.length === 0) return countsById;

  const rows = await db
    .select({
      draftId: reviewCommentsTable.draftId,
      commentCount: count(),
      resolvedCount: sql<number>`count(*) filter (where ${reviewCommentsTable.resolved})`,
    })
    .from(reviewCommentsTable)
    .where(inArray(reviewCommentsTable.draftId, draftIds))
    .groupBy(reviewCommentsTable.draftId);

  for (const row of rows) {
    countsById.set(row.draftId, {
      commentCount: Number(row.commentCount),
      resolvedCount: Number(row.resolvedCount),
    });
  }
  return countsById;
}

async function getOwnedDrafts(ownerId: string) {
  const drafts = await db
    .select()
    .from(comicDraftsTable)
    .where(eq(comicDraftsTable.ownerId, ownerId))
    .orderBy(desc(comicDraftsTable.updatedAt));
  const counts = await getCommentCounts(drafts.map((draft) => draft.id));

  return drafts.map((draft) => {
    const tally = counts.get(draft.id) ?? { commentCount: 0, resolvedCount: 0 };
    return serializeDraft(draft, tally.commentCount, tally.resolvedCount);
  });
}

async function findOwnedDraft(draftId: string, ownerId: string) {
  const [draft] = await db
    .select()
    .from(comicDraftsTable)
    .where(
      and(
        eq(comicDraftsTable.id, draftId),
        eq(comicDraftsTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  return draft;
}

function requireValidPageImage(
  width: number,
  height: number,
): boolean {
  return width === 800 && height > 0 && height <= 1280;
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const drafts = await getOwnedDrafts(ownerId);
  const openCommentCount = drafts.reduce(
    (total, draft) => total + draft.commentCount - draft.resolvedCount,
    0,
  );
  res.json(
    GetDashboardSummaryResponse.parse({
      episodeCount: drafts.length,
      inReviewCount: drafts.filter((draft) => draft.status === "in_review").length,
      openCommentCount,
      recentDrafts: drafts.slice(0, 5),
    }),
  );
});

router.get("/drafts", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;
  res.json(GetDraftsResponse.parse(await getOwnedDrafts(ownerId)));
});

router.post("/drafts", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const parsed = CreateDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  for (const page of parsed.data.pages) {
    if (!requireValidPageImage(page.width, page.height)) {
      res.status(400).json({
        error: "Panels must be 800 pixels wide and no taller than 1,280 pixels.",
      });
      return;
    }
    try {
      const file = await storage.getObjectEntityFile(page.objectPath);
      const canRead = await storage.canAccessObjectEntity({
        userId: ownerId,
        objectFile: file,
      });
      if (!canRead) {
        res.status(400).json({ error: "An uploaded panel is not owned by you." });
        return;
      }
    } catch {
      res.status(400).json({ error: "An uploaded panel could not be found." });
      return;
    }
  }

  const [draft] = await db
    .insert(comicDraftsTable)
    .values({
      ownerId,
      title: parsed.data.title.trim(),
      pages: parsed.data.pages,
    })
    .returning();
  res.status(201).json(
    CreateDraftResponse.parse(serializeDraft(draft, 0, 0)),
  );
});

router.get("/drafts/:draftId", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const params = GetDraftParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const draft = await findOwnedDraft(params.data.draftId, ownerId);
  if (!draft) {
    res.status(404).json({ error: "Episode not found" });
    return;
  }

  const comments = await db
    .select()
    .from(reviewCommentsTable)
    .where(eq(reviewCommentsTable.draftId, draft.id))
    .orderBy(desc(reviewCommentsTable.createdAt));
  const counts = await getCommentCounts([draft.id]);
  const tally = counts.get(draft.id) ?? { commentCount: 0, resolvedCount: 0 };
  res.json(
    GetDraftResponse.parse({
      ...serializeDraft(draft, tally.commentCount, tally.resolvedCount),
      shareUrl: draft.shareEnabled && draft.shareToken
        ? `${requestOrigin(req)}/review/${draft.shareToken}`
        : null,
      comments: comments.map((comment) => ({
        id: comment.id,
        reviewerName: comment.reviewerName,
        pageIndex: comment.pageIndex,
        body: comment.body,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
      })),
    }),
  );
});

router.patch("/drafts/:draftId", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const params = UpdateDraftParams.safeParse(req.params);
  const parsed = UpdateDraftBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: !params.success ? params.error.message : "Invalid request",
    });
    return;
  }

  const [draft] = await db
    .update(comicDraftsTable)
    .set({
      ...parsed.data,
      ...(parsed.data.title ? { title: parsed.data.title.trim() } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(comicDraftsTable.id, params.data.draftId),
        eq(comicDraftsTable.ownerId, ownerId),
      ),
    )
    .returning();
  if (!draft) {
    res.status(404).json({ error: "Episode not found" });
    return;
  }

  const counts = await getCommentCounts([draft.id]);
  const tally = counts.get(draft.id) ?? { commentCount: 0, resolvedCount: 0 };
  res.json(UpdateDraftResponse.parse(serializeDraft(draft, tally.commentCount, tally.resolvedCount)));
});

router.delete("/drafts/:draftId", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const params = DeleteDraftParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const draft = await findOwnedDraft(params.data.draftId, ownerId);
  if (!draft) {
    res.status(404).json({ error: "Episode not found" });
    return;
  }
  await db
    .delete(comicDraftsTable)
    .where(
      and(
        eq(comicDraftsTable.id, draft.id),
        eq(comicDraftsTable.ownerId, ownerId),
      ),
    );

  const cleanup = await Promise.allSettled(
    draft.pages.map(async (page) => {
      const file = await storage.getObjectEntityFile(page.objectPath);
      await file.delete({ ignoreNotFound: true });
    }),
  );
  for (const result of cleanup) {
    if (result.status === "rejected") {
      req.log.warn({ err: result.reason }, "Could not remove a stored panel");
    }
  }
  res.sendStatus(204);
});

router.post("/drafts/:draftId/share", async (req, res): Promise<void> => {
  const ownerId = requireUser(req, res);
  if (!ownerId) return;

  const params = CreateDraftShareParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const existing = await findOwnedDraft(params.data.draftId, ownerId);
  if (!existing) {
    res.status(404).json({ error: "Episode not found" });
    return;
  }
  const shareToken = randomBytes(32).toString("hex");
  await db
    .update(comicDraftsTable)
    .set({
      shareToken,
      shareEnabled: true,
      status: existing.status === "draft" ? "in_review" : existing.status,
      updatedAt: new Date(),
    })
    .where(eq(comicDraftsTable.id, existing.id));
  res.json(
    CreateDraftShareResponse.parse({
      shareUrl: `${requestOrigin(req)}/review/${shareToken}`,
      shareEnabled: true,
    }),
  );
});

router.patch(
  "/drafts/:draftId/comments/:commentId",
  async (req, res): Promise<void> => {
    const ownerId = requireUser(req, res);
    if (!ownerId) return;

    const params = UpdateCommentParams.safeParse(req.params);
    const parsed = UpdateCommentBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: !params.success ? params.error.message : "Invalid request",
      });
      return;
    }

    const [ownedComment] = await db
      .select({ commentId: reviewCommentsTable.id })
      .from(reviewCommentsTable)
      .innerJoin(
        comicDraftsTable,
        eq(reviewCommentsTable.draftId, comicDraftsTable.id),
      )
      .where(
        and(
          eq(reviewCommentsTable.id, params.data.commentId),
          eq(comicDraftsTable.id, params.data.draftId),
          eq(comicDraftsTable.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!ownedComment) {
      res.status(404).json({ error: "Feedback not found" });
      return;
    }

    const [comment] = await db
      .update(reviewCommentsTable)
      .set({ resolved: parsed.data.resolved })
      .where(eq(reviewCommentsTable.id, ownedComment.commentId))
      .returning();
    res.json(
      UpdateCommentResponse.parse({
        id: comment.id,
        reviewerName: comment.reviewerName,
        pageIndex: comment.pageIndex,
        body: comment.body,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
      }),
    );
  },
);

router.get("/reviews/:shareToken", async (req, res): Promise<void> => {
  const params = GetReviewParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Review link not found" });
    return;
  }
  const [draft] = await db
    .select()
    .from(comicDraftsTable)
    .where(
      and(
        eq(comicDraftsTable.shareToken, params.data.shareToken),
        eq(comicDraftsTable.shareEnabled, true),
      ),
    )
    .limit(1);
  if (!draft) {
    res.status(404).json({ error: "Review link not found" });
    return;
  }

  const comments = await db
    .select()
    .from(reviewCommentsTable)
    .where(eq(reviewCommentsTable.draftId, draft.id))
    .orderBy(desc(reviewCommentsTable.createdAt));
  res.json(
    GetReviewResponse.parse({
      title: draft.title,
      status: draft.status,
      pages: draft.pages.map((page, index) => ({
        index,
        width: page.width,
        height: page.height,
        imageUrl: `/api/reviews/${params.data.shareToken}/pages/${index}`,
      })),
      comments: comments.map((comment) => ({
        id: comment.id,
        reviewerName: comment.reviewerName,
        pageIndex: comment.pageIndex,
        body: comment.body,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
      })),
    }),
  );
});

router.get(
  "/reviews/:shareToken/pages/:pageIndex",
  async (req, res): Promise<void> => {
    const params = GetReviewPageImageParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Panel not found" });
      return;
    }

    const [draft] = await db
      .select()
      .from(comicDraftsTable)
      .where(
        and(
          eq(comicDraftsTable.shareToken, params.data.shareToken),
          eq(comicDraftsTable.shareEnabled, true),
        ),
      )
      .limit(1);
    const page = draft?.pages[params.data.pageIndex];
    if (!draft || !page) {
      res.status(404).json({ error: "Panel not found" });
      return;
    }

    try {
      const file = await storage.getObjectEntityFile(page.objectPath);
      const response = await storage.downloadObject(file, 60);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        ).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, "Could not stream a shared panel");
      res.status(404).json({ error: "Panel not found" });
    }
  },
);

router.post(
  "/reviews/:shareToken/comments",
  async (req, res): Promise<void> => {
    const params = CreateReviewCommentParams.safeParse(req.params);
    const parsed = CreateReviewCommentBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: !params.success ? params.error.message : "Invalid request",
      });
      return;
    }

    const [draft] = await db
      .select()
      .from(comicDraftsTable)
      .where(
        and(
          eq(comicDraftsTable.shareToken, params.data.shareToken),
          eq(comicDraftsTable.shareEnabled, true),
        ),
      )
      .limit(1);
    if (!draft) {
      res.status(404).json({ error: "Review link not found" });
      return;
    }
    if (
      parsed.data.pageIndex < 0 ||
      parsed.data.pageIndex >= draft.pages.length
    ) {
      res.status(400).json({ error: "Choose a panel in this episode." });
      return;
    }

    const [comment] = await db
      .insert(reviewCommentsTable)
      .values({
        draftId: draft.id,
        reviewerName: parsed.data.reviewerName.trim(),
        pageIndex: parsed.data.pageIndex,
        body: parsed.data.body.trim(),
      })
      .returning();
    res.status(201).json(
      CreateReviewCommentResponse.parse({
        id: comment.id,
        reviewerName: comment.reviewerName,
        pageIndex: comment.pageIndex,
        body: comment.body,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
      }),
    );
  },
);

export default router;
