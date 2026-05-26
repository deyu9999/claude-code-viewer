import { FileSystem, Path } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { parseJsonl } from "../../claude-code/functions/parseJsonl.ts";
import { ApplicationContext } from "../../platform/services/ApplicationContext.ts";
import { decodeProjectId, validateProjectPath } from "../../project/functions/id.ts";
import { extractFirstUserText } from "../../session/functions/extractFirstUserText.ts";
import type { ExtendedConversation } from "../../types.ts";

const SAFE_AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type AgentSessionLoadOptions = {
  tail?: number;
  since?: string;
  until?: string;
};

export type AgentSessionPagination = {
  totalCount: number;
  returnedCount: number;
  hasMore: boolean;
};

export type AgentSessionResult = {
  conversations: ExtendedConversation[];
  pagination: AgentSessionPagination;
};

const tsSchema = z.object({ timestamp: z.string() });
const tsOf = (c: ExtendedConversation): string | null => {
  const r = tsSchema.safeParse(c);
  return r.success ? r.data.timestamp : null;
};

// Mirrors SessionRepository.getSession's tail/range logic. Fast-path: when
// only `tail` is set, slice raw lines before parseJsonl/Zod so multi-MB
// subagent files (e.g. 18MB+ research-style agents) don't pay full parse cost.
const loadConversations = (
  content: string,
  options: AgentSessionLoadOptions | undefined,
): AgentSessionResult => {
  const allLines = content.split("\n").filter((line) => line.trim());
  const totalCount = allLines.length;
  const { tail, since, until } = options ?? {};

  let conversations: ExtendedConversation[];
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
    hasMore = true;
  } else {
    conversations = parseJsonl(allLines.join("\n"));
    if (since !== undefined || until !== undefined) {
      conversations = conversations.filter((c) => {
        const ts = tsOf(c);
        if (ts === null) return true;
        if (since !== undefined && ts < since) return false;
        if (until !== undefined && ts > until) return false;
        return true;
      });
    }
    if (tail !== undefined && tail > 0 && conversations.length > tail) {
      conversations = conversations.slice(conversations.length - tail);
    }
    hasMore = conversations.length < totalCount;
  }

  return {
    conversations,
    pagination: { totalCount, returnedCount: conversations.length, hasMore },
  };
};

const LayerImpl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appContext = yield* ApplicationContext;

  /**
   * Get agent session conversations by agentId.
   * Checks new path: {project}/{sessionId}/subagents/agent-{agentId}.jsonl
   * Fallback to old path: {project}/agent-{agentId}.jsonl
   */
  const getAgentSessionByAgentId = (
    projectId: string,
    agentId: string,
    sessionId?: string,
    options?: AgentSessionLoadOptions,
  ): Effect.Effect<AgentSessionResult | null, Error> =>
    Effect.gen(function* () {
      // Validate agentId to prevent path traversal
      if (!SAFE_AGENT_ID_PATTERN.test(agentId)) {
        return yield* Effect.fail(new Error("Invalid agent ID: contains disallowed characters"));
      }

      const projectPath = decodeProjectId(projectId);

      // Validate that the project path is within the Claude projects directory
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(projectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }

      // Try new path if sessionId is provided
      if (sessionId !== undefined && sessionId !== "") {
        const newPath = path.resolve(projectPath, sessionId, "subagents", `agent-${agentId}.jsonl`);

        if (yield* fs.exists(newPath)) {
          const content = yield* fs.readFileString(newPath);
          return loadConversations(content, options);
        }
      }

      // Fallback to old path
      const agentFilePath = path.resolve(projectPath, `agent-${agentId}.jsonl`);

      // Check if file exists
      const exists = yield* fs.exists(agentFilePath);
      if (!exists) {
        return null;
      }

      const content = yield* fs.readFileString(agentFilePath);
      return loadConversations(content, options);
    });

  /**
   * List all agent sessions for a given session.
   * Scans both legacy root directory and new subagents directory.
   */
  const listAgentSessionsForSession = (
    projectId: string,
    sessionId: string,
  ): Effect.Effect<
    { agentId: string; firstMessage: string | null; firstTimestamp: string | null }[],
    Error
  > =>
    Effect.gen(function* () {
      const projectPath = decodeProjectId(projectId);

      // Validate that the project path is within the Claude projects directory
      const { claudeProjectsDirPath } = yield* appContext.claudeCodePaths;
      if (!validateProjectPath(projectPath, claudeProjectsDirPath)) {
        return yield* Effect.fail(new Error("Invalid project path: outside allowed directory"));
      }
      const results: {
        agentId: string;
        firstMessage: string | null;
        firstTimestamp: string | null;
      }[] = [];

      const extractAgentId = (filename: string): string | null => {
        const match = /^agent-(.+)\.jsonl$/.exec(filename);
        return match ? (match[1] ?? null) : null;
      };

      const timestampSchema = z.object({ timestamp: z.string() });
      const extractTimestamp = (conv: unknown): string | null => {
        const parsed = timestampSchema.safeParse(conv);
        return parsed.success ? parsed.data.timestamp : null;
      };

      const processFile = (filePath: string, filename: string): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const agentId = extractAgentId(filename);
          if (agentId === null) return;

          const content = yield* fs.readFileString(filePath);
          const firstLine = content.split("\n")[0];
          if (firstLine === undefined || firstLine.trim() === "") return;

          try {
            const conversations = parseJsonl(firstLine);
            const firstConv = conversations[0];
            const firstMessage = firstConv ? extractFirstUserText(firstConv) : null;
            const firstTimestamp = extractTimestamp(firstConv);
            results.push({ agentId, firstMessage, firstTimestamp });
          } catch {
            results.push({ agentId, firstMessage: null, firstTimestamp: null });
          }
        });

      // Check subagents directory: {project}/{sessionId}/subagents/
      const subagentsDir = path.join(projectPath, sessionId, "subagents");
      const subagentsDirExists = yield* fs.exists(subagentsDir);

      if (subagentsDirExists) {
        const entries = yield* fs
          .readDirectory(subagentsDir)
          .pipe(Effect.catchAll(() => Effect.succeed([] as string[])));

        const agentFiles = entries.filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));

        for (const filename of agentFiles) {
          yield* processFile(path.join(subagentsDir, filename), filename).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }
      }

      // Check legacy root directory
      const rootEntries = yield* fs
        .readDirectory(projectPath)
        .pipe(Effect.catchAll(() => Effect.succeed([] as string[])));

      const rootAgentFiles = rootEntries.filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
      );

      for (const filename of rootAgentFiles) {
        const filePath = path.join(projectPath, filename);
        // Only include if the first line's sessionId matches
        const content = yield* fs
          .readFileString(filePath)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
        const firstLine = content.split("\n")[0];
        if (firstLine === undefined || firstLine.trim() === "") continue;

        try {
          const parsed: unknown = JSON.parse(firstLine);
          const sessionIdResult = z.object({ sessionId: z.string() }).safeParse(parsed);
          if (sessionIdResult.success && sessionIdResult.data.sessionId === sessionId) {
            yield* processFile(filePath, filename).pipe(Effect.catchAll(() => Effect.void));
          }
        } catch {
          // skip invalid files
        }
      }

      // Sort by firstTimestamp DESC (newest spawned subagent first).
      // Entries without a timestamp sink to the end.
      results.sort((a, b) => {
        if (a.firstTimestamp === null && b.firstTimestamp === null) return 0;
        if (a.firstTimestamp === null) return 1;
        if (b.firstTimestamp === null) return -1;
        return b.firstTimestamp.localeCompare(a.firstTimestamp);
      });

      return results;
    });

  return {
    getAgentSessionByAgentId,
    listAgentSessionsForSession,
  };
});

export class AgentSessionRepository extends Context.Tag("AgentSessionRepository")<
  AgentSessionRepository,
  {
    readonly getAgentSessionByAgentId: (
      projectId: string,
      agentId: string,
      sessionId?: string,
      options?: AgentSessionLoadOptions,
    ) => Effect.Effect<AgentSessionResult | null, Error>;
    readonly listAgentSessionsForSession: (
      projectId: string,
      sessionId: string,
    ) => Effect.Effect<
      { agentId: string; firstMessage: string | null; firstTimestamp: string | null }[],
      Error
    >;
  }
>() {
  static Live = Layer.effect(this, LayerImpl);
}

export type IAgentSessionRepository = Context.Tag.Service<typeof AgentSessionRepository>;
