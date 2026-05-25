import { FileSystem } from "@effect/platform";
import { desc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { z } from "zod";
import { DrizzleService } from "../../../lib/db/DrizzleService.ts";
import { projects, sessions } from "../../../lib/db/schema.ts";
import type { InferEffect } from "../../../lib/effect/types.ts";
import { parseJsonl } from "../../claude-code/functions/parseJsonl.ts";
import { ApplicationContext } from "../../platform/services/ApplicationContext.ts";
import { decodeProjectId, validateProjectPath } from "../../project/functions/id.ts";
import { SyncService } from "../../sync/services/SyncService.ts";
import type { ExtendedConversation, Session, SessionDetail } from "../../types.ts";
import { decodeSessionId, validateSessionId } from "../functions/id.ts";
import { SessionMetaService } from "../services/SessionMetaService.ts";

export type SessionLoadOptions = {
  tail?: number; // load only the last N events; undefined = load all
  since?: string; // ISO timestamp lower bound (inclusive)
  until?: string; // ISO timestamp upper bound (inclusive)
};

export type SessionPagination = {
  totalCount: number; // total parseable lines in file
  returnedCount: number; // after tail/since/until filter
  hasMore: boolean; // true when filter dropped entries from the start
};

const timestampSchema = z.object({ timestamp: z.string() });
const getConversationTimestamp = (conv: ExtendedConversation): string | null => {
  const parsed = timestampSchema.safeParse(conv);
  return parsed.success ? parsed.data.timestamp : null;
};

const LayerImpl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sessionMetaService = yield* SessionMetaService;
  const appContext = yield* ApplicationContext;
  const { db } = yield* DrizzleService;
  const syncService = yield* SyncService;

  const getSession = (projectId: string, sessionId: string, options?: SessionLoadOptions) =>
    Effect.gen(function* () {
      // Validate sessionId contains only safe characters
      if (!validateSessionId(sessionId)) {
        return yield* Effect.fail(new Error("Invalid session ID: contains unsafe characters"));
      }

      // Validate that the project path is within the Claude projects directory
      const projectPath = decodeProjectId(projectId);
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(projectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      const sessionPath = decodeSessionId(projectId, sessionId);

      // Check if session file exists
      const exists = yield* fs.exists(sessionPath);
      if (!exists) {
        return { session: null, pagination: null };
      }

      const { sessionDetail, pagination } = yield* Effect.gen(function* () {
        // Read session file
        const content = yield* fs.readFileString(sessionPath);
        const allLines = content.split("\n").filter((line) => line.trim());

        const totalCount = allLines.length;
        const { tail, since, until } = options ?? {};

        // Fast path: tail-only (no since/until). Skip parsing the leading lines.
        // Big win on multi-MB files because Zod validation in parseJsonl is the
        // dominant cost; parsing 200 lines vs 16000 is ~80x cheaper.
        let conversations: ExtendedConversation[];
        let returnedCount: number;
        let hasMore: boolean;

        if (
          tail !== undefined &&
          tail > 0 &&
          tail < totalCount &&
          since === undefined &&
          until === undefined
        ) {
          const tailLines = allLines.slice(allLines.length - tail);
          conversations = parseJsonl(tailLines.join("\n"));
          returnedCount = conversations.length;
          hasMore = true;
        } else {
          conversations = parseJsonl(allLines.join("\n"));
          // Apply since/until time-range filter when set.
          // Entries without a timestamp (summaries, metadata) always pass through
          // so structural data stays visible.
          if (since !== undefined || until !== undefined) {
            conversations = conversations.filter((conv) => {
              const ts = getConversationTimestamp(conv);
              if (ts === null) return true;
              if (since !== undefined && ts < since) return false;
              if (until !== undefined && ts > until) return false;
              return true;
            });
          }
          // Apply tail as a final cap (when combined with since/until, or when
          // tail >= totalCount — both cases are cheap because we already parsed).
          if (tail !== undefined && tail > 0 && conversations.length > tail) {
            conversations = conversations.slice(conversations.length - tail);
          }
          returnedCount = conversations.length;
          hasMore = returnedCount < totalCount;
        }

        // Get file stats
        const stat = yield* fs.stat(sessionPath);

        // Get session metadata
        const meta = yield* sessionMetaService.getSessionMeta(projectId, sessionId);

        const sessionDetail: SessionDetail = {
          id: sessionId,
          jsonlFilePath: sessionPath,
          meta,
          conversations,
          lastModifiedAt: Option.getOrElse(stat.mtime, () => new Date()),
        };

        const pagination: SessionPagination = { totalCount, returnedCount, hasMore };
        return { sessionDetail, pagination };
      });

      return {
        session: sessionDetail,
        pagination,
      };
    });

  const getSessions = (
    projectId: string,
    options?: {
      maxCount?: number;
      cursor?: string;
    },
  ) =>
    Effect.gen(function* () {
      const { maxCount = 20, cursor } = options ?? {};

      const claudeProjectPath = decodeProjectId(projectId);

      // Validate that the project path is within the Claude projects directory
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(claudeProjectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      // Ensure project is synced in DB
      const projectExists = db
        .select({ one: sql<number>`1` })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get();
      if (!projectExists) {
        yield* syncService.syncProjectList(projectId).pipe(Effect.catchAll(() => Effect.void));
      }

      // Fetch all sessions for project ordered by lastModifiedAt DESC
      const rows = db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projectId))
        .orderBy(desc(sessions.lastModifiedAt))
        .all();

      if (rows.length === 0) {
        return { sessions: [] };
      }

      // Cursor-based pagination
      const startIndex =
        cursor !== undefined
          ? (() => {
              const idx = rows.findIndex((r) => r.id === cursor);
              return idx === -1 ? 0 : idx + 1;
            })()
          : 0;

      const sessionsToReturn = rows.slice(startIndex, startIndex + maxCount);

      const sessionsResult: Session[] = yield* Effect.all(
        sessionsToReturn.map((row) =>
          Effect.gen(function* () {
            const meta = yield* sessionMetaService.getSessionMeta(projectId, row.id);
            return {
              id: row.id,
              jsonlFilePath: row.filePath,
              lastModifiedAt: new Date(row.lastModifiedAt),
              meta,
            } satisfies Session;
          }),
        ),
        { concurrency: "unbounded" },
      );

      return { sessions: sessionsResult };
    });

  return {
    getSession,
    getSessions,
  };
});

export type ISessionRepository = InferEffect<typeof LayerImpl>;

export class SessionRepository extends Context.Tag("SessionRepository")<
  SessionRepository,
  ISessionRepository
>() {
  static Live = Layer.effect(this, LayerImpl);
}
