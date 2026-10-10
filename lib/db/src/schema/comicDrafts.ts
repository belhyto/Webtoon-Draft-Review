import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const draftStatusEnum = pgEnum("draft_status", [
  "draft",
  "in_review",
  "approved",
]);

export type ComicPage = {
  objectPath: string;
  width: number;
  height: number;
};

export const comicDraftsTable = pgTable(
  "comic_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: varchar("owner_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 180 }).notNull(),
    status: draftStatusEnum("status").notNull().default("draft"),
    pages: jsonb("pages").$type<ComicPage[]>().notNull(),
    shareToken: varchar("share_token", { length: 96 }),
    shareEnabled: boolean("share_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("comic_drafts_owner_updated_idx").on(table.ownerId, table.updatedAt),
    uniqueIndex("comic_drafts_share_token_idx").on(table.shareToken),
  ],
);

export const reviewCommentsTable = pgTable(
  "review_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => comicDraftsTable.id, { onDelete: "cascade" }),
    reviewerName: varchar("reviewer_name", { length: 80 }).notNull(),
    pageIndex: integer("page_index").notNull(),
    body: text("body").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("review_comments_draft_created_idx").on(table.draftId, table.createdAt)],
);

export const insertComicDraftSchema = createInsertSchema(comicDraftsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertReviewCommentSchema = createInsertSchema(
  reviewCommentsTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertComicDraft = z.infer<typeof insertComicDraftSchema>;
export type ComicDraft = typeof comicDraftsTable.$inferSelect;
export type InsertReviewComment = z.infer<typeof insertReviewCommentSchema>;
export type ReviewCommentRecord = typeof reviewCommentsTable.$inferSelect;
