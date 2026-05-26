import { Context, Effect, Layer } from "effect";
import type { ControllerResponse } from "../../../lib/effect/toEffectResponse.ts";
import type { InferEffect } from "../../../lib/effect/types.ts";
import { AgentSessionRepository } from "../infrastructure/AgentSessionRepository.ts";

const LayerImpl = Effect.gen(function* () {
  const repository = yield* AgentSessionRepository;

  /**
   * Get agent session by agentId.
   * Directly reads agent-${agentId}.jsonl file without mapping service.
   */
  const getAgentSession = (params: {
    projectId: string;
    agentId: string;
    sessionId?: string;
    tail?: number;
    since?: string;
    until?: string;
  }) =>
    Effect.gen(function* () {
      const { projectId, agentId, sessionId, tail, since, until } = params;

      // Read conversations directly using agentId. Pass through tail/range
      // options so the modal can request only the latest N events when
      // viewing a multi-MB subagent jsonl.
      const result = yield* repository.getAgentSessionByAgentId(projectId, agentId, sessionId, {
        tail,
        since,
        until,
      });

      if (result === null) {
        return {
          status: 200,
          response: {
            agentSessionId: null,
            conversations: [],
            pagination: null,
          },
        } as const satisfies ControllerResponse;
      }

      return {
        status: 200,
        response: {
          agentSessionId: agentId,
          conversations: result.conversations,
          pagination: result.pagination,
        },
      } as const satisfies ControllerResponse;
    });

  /**
   * List agent sessions for a given session.
   */
  const listAgentSessions = (params: { projectId: string; sessionId: string }) =>
    Effect.gen(function* () {
      const { projectId, sessionId } = params;
      const agentSessions = yield* repository.listAgentSessionsForSession(projectId, sessionId);

      return {
        status: 200,
        response: {
          agentSessions,
        },
      } as const satisfies ControllerResponse;
    });

  return {
    getAgentSession,
    listAgentSessions,
  };
});

export type IAgentSessionController = InferEffect<typeof LayerImpl>;

export class AgentSessionController extends Context.Tag("AgentSessionController")<
  AgentSessionController,
  IAgentSessionController
>() {
  static Live = Layer.effect(this, LayerImpl);
}
