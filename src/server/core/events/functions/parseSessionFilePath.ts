import z from "zod";

const sessionFileRegExp = /(?<projectId>.*?)\/(?<sessionId>.*?)\.jsonl$/;
// New-style subagent files live under {project}/{parentSessionId}/subagents/agent-{id}.jsonl.
// Checked before the legacy pattern so the projectId doesn't accidentally swallow
// "{parentSessionId}/subagents" — that breaks SSE invalidation routing.
const nestedAgentFileRegExp =
  /(?<projectId>.*?)\/(?<parentSessionId>[^/]+)\/subagents\/agent-(?<agentSessionId>.*?)\.jsonl$/;
const agentFileRegExp = /(?<projectId>.*?)\/agent-(?<agentSessionId>.*?)\.jsonl$/;

const sessionFileGroupSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
});

const nestedAgentFileGroupSchema = z.object({
  projectId: z.string(),
  parentSessionId: z.string(),
  agentSessionId: z.string(),
});

const agentFileGroupSchema = z.object({
  projectId: z.string(),
  agentSessionId: z.string(),
});

export type SessionFileMatch = {
  type: "session";
  projectId: string;
  sessionId: string;
};

export type AgentFileMatch = {
  type: "agent";
  projectId: string;
  agentSessionId: string;
  // Only set when the file was found in the new-style nested location.
  parentSessionId?: string;
};

export type FileMatch = SessionFileMatch | AgentFileMatch | null;

/**
 * Parses a file path to determine if it's a regular session file or an agent session file.
 * Agent files take precedence in matching (checked first).
 *
 * @param filePath - The relative file path from the claude projects directory
 * @returns FileMatch object with type and extracted IDs, or null if not a recognized file
 */
export const parseSessionFilePath = (filePath: string): FileMatch => {
  // Check nested-layout subagent first (most specific).
  const nestedMatch = filePath.match(nestedAgentFileRegExp);
  const nestedGroups = nestedAgentFileGroupSchema.safeParse(nestedMatch?.groups);
  if (nestedGroups.success) {
    return {
      type: "agent",
      projectId: nestedGroups.data.projectId,
      parentSessionId: nestedGroups.data.parentSessionId,
      agentSessionId: nestedGroups.data.agentSessionId,
    };
  }

  // Legacy flat agent file: {project}/agent-{id}.jsonl
  const agentMatch = filePath.match(agentFileRegExp);
  const agentGroups = agentFileGroupSchema.safeParse(agentMatch?.groups);
  if (agentGroups.success) {
    return {
      type: "agent",
      projectId: agentGroups.data.projectId,
      agentSessionId: agentGroups.data.agentSessionId,
    };
  }

  // Check for regular session file
  const sessionMatch = filePath.match(sessionFileRegExp);
  const sessionGroups = sessionFileGroupSchema.safeParse(sessionMatch?.groups);
  if (sessionGroups.success) {
    return {
      type: "session",
      projectId: sessionGroups.data.projectId,
      sessionId: sessionGroups.data.sessionId,
    };
  }

  return null;
};
