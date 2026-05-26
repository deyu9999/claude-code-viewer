import { Trans } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, FolderIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Switch } from "@/web/components/ui/switch";
import { projectListQuery } from "@/web/lib/api/queries";
import { cn } from "@/web/utils";

/** Replace /home/<user> or /Users/<user> prefix with ~/ */
const shortenHome = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+/, "~");

type MatchMode = "substring" | "fuzzy";
const MATCH_MODE_STORAGE_KEY = "claude-code-viewer.project-switcher.match-mode";
const isMatchMode = (v: unknown): v is MatchMode => v === "substring" || v === "fuzzy";

/** fzf-style: query chars must appear in order somewhere in value (case-insensitive). */
const fuzzyContains = (value: string, query: string): boolean => {
  let i = 0;
  for (let j = 0; j < value.length && i < query.length; j++) {
    if (value[j] === query[i]) i++;
  }
  return i === query.length;
};

/**
 * Multi-keyword AND filter. Whitespace-separated tokens, each must satisfy
 * the chosen match strategy against the value. Empty search => keep all.
 */
const matchesAll = (value: string, search: string, mode: MatchMode): boolean => {
  const v = value.toLowerCase();
  const tokens = search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return mode === "substring"
    ? tokens.every((t) => v.includes(t))
    : tokens.every((t) => fuzzyContains(v, t));
};

type ProjectSwitcherProps = {
  currentProjectId?: string;
  currentProjectPath?: string;
};

export const ProjectSwitcher: FC<ProjectSwitcherProps> = ({
  currentProjectId,
  currentProjectPath,
}) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  // Default to strict substring match — that's what "search this string"
  // intuitively means. User can flip to fuzzy via the toggle in the
  // popover. Preference is persisted in localStorage.
  const [matchMode, setMatchMode] = useState<MatchMode>("substring");
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MATCH_MODE_STORAGE_KEY);
      if (isMatchMode(raw)) setMatchMode(raw);
    } catch {
      // localStorage may be unavailable (SSR, privacy modes) — silently keep default
    }
  }, []);
  const handleMatchModeChange = (next: boolean) => {
    const mode: MatchMode = next ? "fuzzy" : "substring";
    setMatchMode(mode);
    try {
      localStorage.setItem(MATCH_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore — preference just won't persist
    }
  };

  const { data } = useQuery({
    queryKey: projectListQuery.queryKey,
    queryFn: projectListQuery.queryFn,
  });

  const projects = data?.projects ?? [];

  // Derive display path from own query data if not provided as prop
  const resolvedPath =
    currentProjectPath ??
    (() => {
      const match = projects.find((p) => p.id === currentProjectId);
      return match ? (match.meta.projectPath ?? match.claudeProjectPath) : undefined;
    })();
  const displayPath =
    resolvedPath !== undefined && resolvedPath !== "" ? shortenHome(resolvedPath) : undefined;

  const handleSelect = (projectId: string) => {
    setOpen(false);
    if (projectId === currentProjectId) return;
    void navigate({
      to: "/projects/$projectId/session",
      params: { projectId },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/role-has-required-aria-props -- shadcn-ui Combobox pattern
          role="combobox"
          aria-expanded={open}
          // Native title attribute shows the un-shortened path on hover —
          // makes "is this the right project?" answerable without clicking.
          title={resolvedPath}
          className="flex items-center gap-1.5 h-7 text-foreground/70 font-medium truncate hover:text-foreground transition-colors rounded px-2 hover:bg-muted/50"
        >
          <FolderIcon className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="truncate max-w-[300px] font-mono text-xs">
            {displayPath ?? <Trans id="project_switcher.no_project" />}
          </span>
          <ChevronsUpDownIcon className="w-3.5 h-3.5 shrink-0 opacity-40" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0 z-[53]" align="start" sideOffset={8}>
        {/* Multi-keyword AND filter — whitespace-separated tokens, each must
            match the value. Substring mode does case-insensitive includes()
            per token; fuzzy mode requires each token's chars to appear in
            order somewhere in the value (fzf-style). Bypasses cmdk's
            default fuzzy scoring so "repos auto" actually means "both". */}
        <Command filter={(value, search) => (matchesAll(value, search, matchMode) ? 1 : 0)}>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b text-xs">
            <span className="text-muted-foreground">Match:</span>
            <div className="flex items-center gap-1.5 select-none">
              <span
                className={cn(
                  "text-xs",
                  matchMode === "substring" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                Exact
              </span>
              <Switch
                checked={matchMode === "fuzzy"}
                onCheckedChange={handleMatchModeChange}
                aria-label="Toggle fuzzy match"
              />
              <span
                className={cn(
                  "text-xs",
                  matchMode === "fuzzy" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                Fuzzy
              </span>
            </div>
          </div>
          <CommandInput placeholder="Search projects (space-separated, all match)..." />
          <CommandList>
            <CommandEmpty>
              <Trans id="project_switcher.no_results" />
            </CommandEmpty>
            <CommandGroup>
              {projects.map((project) => {
                const path = project.meta.projectPath ?? project.claudeProjectPath;
                const displayPath = shortenHome(path);
                const isActive = project.id === currentProjectId;
                return (
                  <CommandItem
                    key={project.id}
                    value={path}
                    onSelect={() => handleSelect(project.id)}
                    className="gap-2"
                    title={path}
                  >
                    <CheckIcon
                      className={cn("w-3.5 h-3.5 shrink-0", isActive ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate font-mono text-xs" title={path}>
                      {displayPath}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
