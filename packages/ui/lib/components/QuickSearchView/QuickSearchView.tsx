import type { FsNode } from "@dotdirfm/fss";
import { useCallback, useState, type CSSProperties } from "react";
import { VscArrowDown, VscArrowUp, VscChevronLeft, VscRegex } from "react-icons/vsc";

export interface QuickSearchViewProps {
  onBack: () => void;
  entries: FsNode[];
  onSelectMatch: (query: string, matchIndex?: number, regexp?: boolean) => void;
  onConfirm: () => void;
}

const jumpButtonStyle: CSSProperties = {
  minWidth: 26,
  minHeight: 26,
  padding: 0,
  border: "1px solid var(--border)",
  borderRadius: 2,
  background: "transparent",
  color: "var(--fg)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

export function QuickSearchView({ onBack, entries, onSelectMatch, onConfirm }: QuickSearchViewProps) {
  const [value, setValue] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [regexp, setRegexp] = useState(false);

  const getMatches = useCallback(
    (query: string) => {
      const normalized = query.trim();
      if (!normalized) return [];
      if (regexp) {
        try {
          const re = new RegExp(normalized, "i");
          return entries.filter((entry) => re.test(entry.name));
        } catch {
          return [];
        }
      }
      const lower = normalized.toLowerCase();
      return entries.filter((entry) => entry.name.toLowerCase().includes(lower));
    },
    [entries, regexp],
  );

  const moveMatch = useCallback(
    (delta: 1 | -1, query: string, currentIndex: number, useRegexp: boolean) => {
      const matches = getMatches(query);
      if (matches.length === 0) return;
      const nextIndex = (currentIndex + delta + matches.length) % matches.length;
      setMatchIndex(nextIndex);
      onSelectMatch(query, nextIndex, useRegexp);
    },
    [getMatches, onSelectMatch],
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto auto auto",
        gap: 6,
        alignItems: "stretch",
      }}
    >
      <button type="button" aria-label="Back" title="Back" style={jumpButtonStyle} onClick={onBack}>
        <VscChevronLeft aria-hidden />
      </button>
      <input
        autoFocus
        type="text"
        value={value}
        placeholder="Type filename..."
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 26,
          padding: "4px 6px",
          border: "1px solid var(--border)",
          borderRadius: 2,
          background: "var(--input-bg, var(--bg))",
          color: "var(--fg)",
          boxSizing: "border-box",
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          setMatchIndex(0);
          onSelectMatch(nextValue, 0, regexp);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onConfirm();
            return;
          }
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          moveMatch(event.key === "ArrowDown" ? 1 : -1, value, matchIndex, regexp);
        }}
      />
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match"
        style={jumpButtonStyle}
        onClick={() => {
          moveMatch(-1, value, matchIndex, regexp);
        }}
      >
        <VscArrowUp aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match"
        style={jumpButtonStyle}
        onClick={() => {
          moveMatch(1, value, matchIndex, regexp);
        }}
      >
        <VscArrowDown aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Use regular expression"
        title="Regexp"
        aria-pressed={regexp}
        style={{
          ...jumpButtonStyle,
          background: regexp ? "var(--entry-hover, rgba(255, 255, 255, 0.08))" : "transparent",
        }}
        onClick={() => {
          setRegexp((current) => {
            const next = !current;
            setMatchIndex(0);
            onSelectMatch(value, 0, next);
            return next;
          });
        }}
      >
        <VscRegex aria-hidden />
      </button>
    </div>
  );
}
