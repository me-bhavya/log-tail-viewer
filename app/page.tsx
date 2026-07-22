"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import StartScreen from "./components/StartScreen";

const API_URL = "http://localhost:3201";

interface LogLine {
  line: number;
  offset: number;
  raw: string;
  ts: string | null;
  level: string | null;
  fields: Record<string, any> | null;
  message?: string;
}

interface SourceStatus {
  id?: string;
  type: string;
  sshTarget?: string;
  logPath?: string;
  localFile?: string;
  filename?: string;
  status: string;
  startedAt?: string;
}

const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "TRACE"];
const LEVEL_COLORS: Record<string, string> = {
  DEBUG: "text-zinc-500",
  INFO: "text-sky-400",
  WARN: "text-amber-400",
  ERROR: "text-red-400",
  TRACE: "text-violet-400",
};
const LEVEL_BADGE: Record<string, string> = {
  DEBUG: "bg-zinc-700 text-zinc-400 border-zinc-600",
  INFO: "bg-sky-900/50 text-sky-300 border-sky-700/50",
  WARN: "bg-amber-900/50 text-amber-300 border-amber-700/50",
  ERROR: "bg-red-900/60 text-red-300 border-red-700/50",
  TRACE: "bg-violet-900/40 text-violet-300 border-violet-700/40",
};
const ROW_TINT: Record<string, string> = {
  DEBUG: "",
  INFO: "",
  WARN: "bg-amber-950/20",
  ERROR: "bg-red-950/25",
  TRACE: "",
};

const MAX_LINES = 8000;

export default function Home() {
  const [source, setSource] = useState<SourceStatus | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [totalLines, setTotalLines] = useState(0);
  const [paused, setPaused] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [checkingSource, setCheckingSource] = useState(true);

  const [search, setSearch] = useState("");
  const [regexEnabled, setRegexEnabled] = useState(false);
  const [exclude, setExclude] = useState("");
  const [activeLevels, setActiveLevels] = useState<Set<string>>(new Set());

  const allLinesRef = useRef<LogLine[]>([]);
  const pausedRef = useRef(false);
  const pausedBufferRef = useRef<LogLine[]>([]);
  const atBottomRef = useRef(true);
  const loadingBackfill = useRef(false);
  const backlogExhausted = useRef(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const sseRef = useRef<EventSource | null>(null);
  const sourceIdRef = useRef<string | null>(null);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);
  useEffect(() => { sourceIdRef.current = sourceId; }, [sourceId]);

  // Check for existing source on mount — from URL param or server status
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSourceId = params.get("source");

    if (urlSourceId) {
      // Reconnect to existing source by sourceId from URL
      fetch(`${API_URL}/api/source/status?sourceId=${urlSourceId}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.source && (d.source.status === "connected" || d.source.status === "connecting")) {
            setSourceId(urlSourceId);
            setSource(d.source);
          }
          setCheckingSource(false);
        })
        .catch(() => setCheckingSource(false));
    } else {
      setCheckingSource(false);
    }
  }, []);

  const disconnect = () => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    setSource(null);
    setSourceId(null);
    setLines([]);
    setConnected(false);
    setTotalLines(0);
    allLinesRef.current = [];

    if (sourceIdRef.current) {
      fetch(`${API_URL}/api/source/stop?sourceId=${sourceIdRef.current}`, { method: "POST" }).catch(() => {});
      // Remove source param from URL
      const url = new URL(window.location.href);
      url.searchParams.delete("source");
      window.history.replaceState({}, "", url.toString());
    }
  };

  // SSE connection — only when we have a source and sourceId
  useEffect(() => {
    if (!source || !sourceId) return;

    const es = new EventSource(`${API_URL}/api/stream?sourceId=${sourceId}`);
    sseRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "ready") {
        setConnected(true);
        setTotalLines(data.lineCount || 0);
        return;
      }
      if (data.type === "lines") {
        const incoming = data.lines as LogLine[];

        if (pausedRef.current) {
          pausedBufferRef.current.push(...incoming);
          return;
        }

        const current = allLinesRef.current;
        const merged = [...current, ...incoming];
        while (merged.length > MAX_LINES) merged.shift();
        allLinesRef.current = merged;
        setLines([...merged]);
        setTotalLines((prev) => Math.max(prev, merged.length > 0 ? merged[merged.length - 1]?.line || prev : prev));
      }
    };

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [source, sourceId]);

  const flushPausedBuffer = () => {
    if (pausedBufferRef.current.length > 0) {
      const buffered = pausedBufferRef.current;
      pausedBufferRef.current = [];
      const merged = [...allLinesRef.current, ...buffered];
      while (merged.length > MAX_LINES) merged.shift();
      allLinesRef.current = merged;
      setLines([...merged]);
    }
  };

  const jumpToBottom = () => {
    flushPausedBuffer();
    setPaused(false);
    setAtBottom(true);
    virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth" });
  };

  const togglePause = () => {
    setPaused((p) => {
      const next = !p;
      if (!next) {
        flushPausedBuffer();
        if (atBottomRef.current) {
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollToIndex({ index: "LAST" });
          });
        }
      }
      return next;
    });
  };

  const toggleLevel = (level: string) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const startReached = useCallback(() => {
    if (loadingBackfill.current || backlogExhausted.current) return;
    const firstLine = allLinesRef.current[0];
    if (!firstLine || firstLine.line <= 1) return;

    loadingBackfill.current = true;
    fetch(`${API_URL}/api/backfill?sourceId=${sourceIdRef.current}&from=${firstLine.line - 500}&limit=500`)
      .then((r) => r.json())
      .then((d) => {
        if (d.lines && d.lines.length > 0) {
          const newLines = d.lines.filter(
            (l: LogLine) => !allLinesRef.current.some((e) => e.line === l.line)
          );
          if (newLines.length === 0) {
            backlogExhausted.current = true;
            return;
          }
          allLinesRef.current = [...newLines, ...allLinesRef.current];
          while (allLinesRef.current.length > MAX_LINES) allLinesRef.current.pop();
          setLines([...allLinesRef.current]);
        }
      })
      .catch(() => {})
      .finally(() => { loadingBackfill.current = false; });
  }, []);

  let regex: RegExp | null = null;
  if (regexEnabled && search) {
    try { regex = new RegExp(search); } catch { regex = null; }
  }

  const buildSearchable = (l: LogLine): string => {
    const parts = [l.raw || ""];
    if (l.message) parts.push(l.message);
    if (l.fields?.traceId) parts.push(l.fields.traceId);
    if (l.fields?.thread) parts.push(`[${l.fields.thread}]`);
    if (l.fields?.logger) parts.push(l.fields.logger);
    return parts.join(" ");
  };

  const filteredLines = lines.filter((l) => {
    const trimmedLevel = l.level?.trim() || "";
    if (activeLevels.size > 0 && (!trimmedLevel || !activeLevels.has(trimmedLevel))) return false;
    const haystack = buildSearchable(l).toLowerCase();
    if (search) {
      if (regex) {
        if (!regex.test(buildSearchable(l))) return false;
      } else {
        if (!haystack.includes(search.toLowerCase())) return false;
      }
    }
    if (exclude) {
      if (haystack.includes(exclude.toLowerCase())) return false;
    }
    return true;
  });

  const hasFilter = search || exclude || activeLevels.size > 0;

  const hl = (text: string) => search && !regexEnabled ? highlightText(text, search) : text;

  const renderRow = (index: number) => {
    const l = filteredLines[index];
    if (!l) return null;
    const level = l.level?.trim() || "";
    const msg = l.message ? l.message : l.raw;

    return (
      <div className={`px-6 py-2.5 border-b border-zinc-800/40 ${ROW_TINT[level] || ""}`}>
        <div className="flex items-center gap-3 mb-1">
          <span className="text-zinc-600 text-xs w-10 shrink-0 text-right tabular-nums select-none">
            {l.line}
          </span>
          {level && (
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${LEVEL_BADGE[level] || ""}`}>
              {level}
            </span>
          )}
          {l.ts && (
            <span className="text-zinc-500 text-xs tabular-nums shrink-0">
              {hl(l.ts)}
            </span>
          )}
          {l.fields?.traceId && (
            <span className="text-indigo-400 text-xs shrink-0 font-mono">
              {hl(l.fields.traceId)}
            </span>
          )}
          {l.fields?.thread && (
            <span className="text-zinc-500 text-xs shrink-0">
              [{hl(l.fields.thread)}]
            </span>
          )}
          {l.fields?.logger && (
            <span className="text-cyan-500/60 text-xs shrink-0 font-mono">
              {hl(l.fields.logger)}
            </span>
          )}
        </div>
        <div className="pl-[52px]">
          <span className="text-zinc-200 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {hl(msg)}
          </span>
        </div>
      </div>
    );
  };

  // ── Start screen ──
  if (checkingSource) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-500 text-sm">
        Connecting...
      </div>
    );
  }

  if (!source) {
    return <StartScreen onConnected={(s, sid) => {
      setSource(s);
      setSourceId(sid);
      // Update URL with source param for refresh persistence
      const url = new URL(window.location.href);
      url.searchParams.set("source", sid);
      window.history.replaceState({}, "", url.toString());
    }} />;
  }

  // ── Log viewer ──
  const sourceLabel = source.type === "ssh"
    ? `${source.sshTarget}:${source.logPath}`
    : source.type === "file"
    ? source.localFile
    : source.filename;

  return (
    <div className="h-screen flex flex-col bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4 shrink-0 bg-zinc-950">
        <h1 className="text-base font-semibold text-white shrink-0">Log Tail Viewer</h1>

        {/* Source badge */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-amber-500"}`} />
          <span className="text-xs text-zinc-400 font-mono max-w-xs truncate" title={sourceLabel}>
            {sourceLabel}
          </span>
          <span className="text-xs text-zinc-600">
            {source.type === "ssh" ? "SSH" : source.type === "file" ? "FILE" : "UPLOAD"}
          </span>
          <button
            onClick={disconnect}
            className="text-xs text-zinc-500 hover:text-red-400 transition-colors ml-1"
            title="Disconnect"
          >
            ✕
          </button>
        </div>

        <button
          onClick={() => window.open(window.location.origin, "_blank")}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors font-medium"
          title="Open new tab with a different log source"
        >
          + New Tab
        </button>

        <span className="text-xs text-zinc-600">
          {totalLines.toLocaleString()} lines · Showing {filteredLines.length.toLocaleString()}
          {hasFilter && ` (filtered from ${lines.length.toLocaleString()})`}
        </span>

        <div className="ml-auto flex items-center gap-3">
          {!atBottom && (
            <button
              onClick={jumpToBottom}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors font-medium"
            >
              ↓ Live
            </button>
          )}
          <button
            onClick={togglePause}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              paused
                ? "bg-green-500/10 text-green-400 border-green-500/30 hover:bg-green-500/20"
                : "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20"
            }`}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </header>

      {/* Filter Bar */}
      <div className="border-b border-zinc-800 px-6 py-2.5 flex items-center gap-3 shrink-0 bg-zinc-950">
        <div className="flex items-center gap-1.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={`text-xs px-3 py-1 rounded-md border font-medium transition-colors ${
                activeLevels.has(level)
                  ? `border-zinc-600 bg-zinc-800 ${LEVEL_COLORS[level]}`
                  : "border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700"
              }`}
            >
              {level}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[150px] bg-zinc-900 text-zinc-200 px-3 py-1.5 rounded-lg border border-zinc-800 outline-none focus:border-indigo-600 text-sm placeholder-zinc-600"
          />
          <button
            onClick={() => setRegexEnabled((r) => !r)}
            title="Toggle regex search"
            className={`text-sm px-2.5 py-1.5 rounded-lg border font-mono transition-colors ${
              regexEnabled
                ? "bg-indigo-600/20 text-indigo-400 border-indigo-600/40"
                : "bg-zinc-900 text-zinc-600 border-zinc-800"
            }`}
          >
            .*
          </button>
        </div>

        <input
          type="text"
          placeholder="Exclude..."
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          className="w-40 bg-zinc-900 text-zinc-200 px-3 py-1.5 rounded-lg border border-zinc-800 outline-none focus:border-indigo-600 text-sm placeholder-zinc-600"
        />
      </div>

      {/* Log View */}
      <div className="flex-1 min-h-0 bg-zinc-950">
        <Virtuoso
          ref={virtuosoRef}
          data={filteredLines}
          itemContent={(index) => renderRow(index)}
          followOutput={(isBottom) => {
            setAtBottom(isBottom);
            return !pausedRef.current && isBottom;
          }}
          startReached={startReached}
          atBottomStateChange={(bottom) => setAtBottom(bottom)}
          className="log-scroll"
          increaseViewportBy={{ top: 600, bottom: 600 }}
        />
      </div>

      {/* Status Bar */}
      <footer className="border-t border-zinc-800 px-6 py-2 flex items-center gap-4 shrink-0 text-xs text-zinc-600 bg-zinc-950">
        <span className={atBottom && !paused ? "text-green-500" : ""}>
          {atBottom && !paused ? "● Following" : paused ? "⏸ Paused" : "○ Scrolled up"}
        </span>
        <span>
          {filteredLines.length.toLocaleString()} visible
        </span>
        {loadingBackfill.current && <span className="text-indigo-400">Loading older logs...</span>}
      </footer>
    </div>
  );
}

function highlightText(text: string, query: string) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx !== -1) {
    parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark key={key++} className="bg-yellow-500/25 text-yellow-200 rounded px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    lastIdx = idx + query.length;
    idx = lower.indexOf(q, lastIdx);
  }
  parts.push(text.slice(lastIdx));
  return parts;
}