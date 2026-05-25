import { useQueryClient } from "@tanstack/react-query";
import type { FC, PropsWithChildren } from "react";
import { useServerEventListener } from "@/lib/sse/hook/useServerEventListener";
import {
  notificationsQuery,
  pendingPermissionRequestsQuery,
  pendingQuestionRequestsQuery,
  projectDetailQuery,
  projectListQuery,
} from "@/web/lib/api/queries";

export const SSEEventListeners: FC<PropsWithChildren> = ({ children }) => {
  const queryClient = useQueryClient();

  useServerEventListener("sessionListChanged", (event) => {
    void queryClient.invalidateQueries({
      queryKey: projectDetailQuery(event.projectId).queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: projectListQuery.queryKey,
    });
  });

  useServerEventListener("sessionChanged", (event) => {
    // sessionDetailQuery's queryKey includes a 5th element (tail/since/until
    // options object). Plain prefix invalidate would only match queries built
    // with identical options — match the first 4 elements via predicate instead
    // so all variants (tail=200, tail=1000, custom range, ...) get invalidated.
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const k = query.queryKey;
        return (
          Array.isArray(k) &&
          k[0] === "projects" &&
          k[1] === event.projectId &&
          k[2] === "sessions" &&
          k[3] === event.sessionId
        );
      },
    });
  });

  useServerEventListener("agentSessionChanged", (event) => {
    // Invalidate the specific agent-session query for this agentSessionId
    // New query key pattern: ["projects", projectId, "agent-sessions", agentId]
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const queryKey = query.queryKey;
        return (
          Array.isArray(queryKey) &&
          queryKey[0] === "projects" &&
          queryKey[1] === event.projectId &&
          queryKey[2] === "agent-sessions" &&
          queryKey[3] === event.agentSessionId
        );
      },
    });
  });

  useServerEventListener("permissionRequested", () => {
    void queryClient.invalidateQueries({
      queryKey: pendingPermissionRequestsQuery.queryKey,
    });
  });

  useServerEventListener("permissionResolved", () => {
    void queryClient.invalidateQueries({
      queryKey: pendingPermissionRequestsQuery.queryKey,
    });
  });

  useServerEventListener("questionRequested", () => {
    void queryClient.invalidateQueries({
      queryKey: pendingQuestionRequestsQuery.queryKey,
    });
  });

  useServerEventListener("questionResolved", () => {
    void queryClient.invalidateQueries({
      queryKey: pendingQuestionRequestsQuery.queryKey,
    });
  });

  useServerEventListener("notificationCreated", () => {
    void queryClient.invalidateQueries({
      queryKey: notificationsQuery.queryKey,
    });
  });

  useServerEventListener("notificationConsumed", () => {
    void queryClient.invalidateQueries({
      queryKey: notificationsQuery.queryKey,
    });
  });

  useServerEventListener("schedulerJobsChanged", () => {
    void queryClient.invalidateQueries({
      queryKey: ["scheduler"],
    });
  });

  return <>{children}</>;
};
