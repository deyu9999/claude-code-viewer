import { type FC, useState } from "react";
import { Button } from "@/web/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Switch } from "@/web/components/ui/switch";
import type { SessionDetailQueryOptions } from "@/web/lib/api/queries";

export type SessionPaginationInfo = {
  totalCount: number;
  returnedCount: number;
  hasMore: boolean;
} | null;

type PresetValue = "200" | "1000" | "5000" | "all" | "range";

const isPresetValue = (v: string): v is PresetValue =>
  v === "200" || v === "1000" || v === "5000" || v === "all" || v === "range";

const optionsToPreset = (options: SessionDetailQueryOptions): PresetValue => {
  if (options.since !== undefined || options.until !== undefined) return "range";
  if (options.tail === undefined) return "all";
  if (options.tail <= 200) return "200";
  if (options.tail <= 1000) return "1000";
  if (options.tail <= 5000) return "5000";
  return "all";
};

const toLocalDatetimeInput = (iso: string | undefined): string => {
  if (iso === undefined || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local expects YYYY-MM-DDTHH:mm (no seconds, no Z).
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fromLocalDatetimeInput = (local: string): string | undefined => {
  if (local === "") return undefined;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
};

type Props = {
  options: SessionDetailQueryOptions;
  onChange: (next: SessionDetailQueryOptions) => void;
  pagination: SessionPaginationInfo;
  followScroll: boolean;
  onFollowScrollChange: (next: boolean) => void;
};

export const SessionLoadControls: FC<Props> = ({
  options,
  onChange,
  pagination,
  followScroll,
  onFollowScrollChange,
}) => {
  const preset = optionsToPreset(options);
  const [rangeOpen, setRangeOpen] = useState(preset === "range");
  const [pendingSince, setPendingSince] = useState(toLocalDatetimeInput(options.since));
  const [pendingUntil, setPendingUntil] = useState(toLocalDatetimeInput(options.until));

  const handlePresetChange = (value: string) => {
    if (!isPresetValue(value)) return;
    switch (value) {
      case "200":
        setRangeOpen(false);
        onChange({ tail: 200 });
        break;
      case "1000":
        setRangeOpen(false);
        onChange({ tail: 1000 });
        break;
      case "5000":
        setRangeOpen(false);
        onChange({ tail: 5000 });
        break;
      case "all":
        setRangeOpen(false);
        onChange({});
        break;
      case "range":
        setRangeOpen(true);
        break;
      default:
        // unreachable: value is narrowed to PresetValue above
        break;
    }
  };

  const applyRange = () => {
    const since = fromLocalDatetimeInput(pendingSince);
    const until = fromLocalDatetimeInput(pendingUntil);
    onChange({ since, until });
  };

  const clearRange = () => {
    setPendingSince("");
    setPendingUntil("");
    setRangeOpen(false);
    onChange({ tail: 200 });
  };

  const loadEarlier = () => {
    const currentTail = options.tail ?? null;
    if (currentTail === null) return; // already loading all
    const next = currentTail <= 200 ? 1000 : currentTail <= 1000 ? 5000 : undefined;
    onChange({ tail: next });
  };

  const showLoadEarlier = pagination !== null && pagination.hasMore && options.tail !== undefined;

  return (
    <div className="px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 py-2 border-b border-border/30 bg-muted/20 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-medium">Load:</span>
        <Select value={preset} onValueChange={handlePresetChange}>
          <SelectTrigger className="h-7 w-[140px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="200">Last 200 events</SelectItem>
            <SelectItem value="1000">Last 1000 events</SelectItem>
            <SelectItem value="5000">Last 5000 events</SelectItem>
            <SelectItem value="all">All events</SelectItem>
            <SelectItem value="range">Custom time range</SelectItem>
          </SelectContent>
        </Select>

        {pagination !== null && (
          <span className="text-muted-foreground">
            Showing {pagination.returnedCount.toLocaleString()} of{" "}
            {pagination.totalCount.toLocaleString()}
            {pagination.hasMore ? " (filtered)" : ""}
          </span>
        )}

        {showLoadEarlier && (
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={loadEarlier}>
            Load earlier
          </Button>
        )}

        <div className="flex items-center gap-1.5 ml-auto select-none">
          <Switch checked={followScroll} onCheckedChange={onFollowScrollChange} />
          <span className="text-muted-foreground">Follow updates</span>
        </div>
      </div>

      {rangeOpen && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Since:</span>
            <input
              type="datetime-local"
              value={pendingSince}
              onChange={(e) => setPendingSince(e.target.value)}
              className="h-7 px-2 rounded border border-border bg-background text-xs"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Until:</span>
            <input
              type="datetime-local"
              value={pendingUntil}
              onChange={(e) => setPendingUntil(e.target.value)}
              className="h-7 px-2 rounded border border-border bg-background text-xs"
            />
          </label>
          <Button variant="default" size="sm" className="h-7 px-2 text-xs" onClick={applyRange}>
            Apply
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={clearRange}>
            Reset to last 200
          </Button>
        </div>
      )}
    </div>
  );
};
