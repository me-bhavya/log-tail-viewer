"use client";

import { useState, useRef, useCallback } from "react";

const API_URL = "http://localhost:3201";
const SSH_TIMEOUT_MS = 15000;
const SSH_POLL_INTERVAL_MS = 1000;

interface SourceStatus {
  type: string;
  sshTarget?: string;
  logPath?: string;
  jumpServer?: string;
  localFile?: string;
  filename?: string;
  status: string;
  startedAt?: string;
  error?: string;
}

interface StartScreenProps {
  onConnected: (source: SourceStatus, sourceId: string) => void;
}

export default function StartScreen({ onConnected }: StartScreenProps) {
  const [mode, setMode] = useState<"ssh" | "file">("ssh");
  const [sshTarget, setSshTarget] = useState("");
  const [logPath, setLogPath] = useState("");
  const [jumpServer, setJumpServer] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const sourceIdRef = useRef<string | null>(null);

  const stopAndCleanup = useCallback(() => {
    if (sourceIdRef.current) {
      fetch(`${API_URL}/api/source/stop?sourceId=${sourceIdRef.current}`, { method: "POST" }).catch(() => {});
    }
  }, []);

  const pollSSHStatus = useCallback(async (): Promise<SourceStatus> => {
    const deadline = Date.now() + SSH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (cancelledRef.current) throw new Error("Cancelled");

      await new Promise((r) => setTimeout(r, SSH_POLL_INTERVAL_MS));
      if (cancelledRef.current) throw new Error("Cancelled");

      try {
        const r = await fetch(`${API_URL}/api/source/status?sourceId=${sourceIdRef.current}`);
        const d = await r.json();
        const src = d.source as SourceStatus | null;

        if (!src) {
          throw new Error("SSH connection was lost");
        }

        if (src.status === "connected") {
          return src;
        }

        if (src.status === "error") {
          throw new Error(src.error || "SSH connection failed");
        }

        if (src.status === "disconnected") {
          throw new Error("SSH connection closed unexpectedly. Check the host and path.");
        }

        // still "connecting" — keep polling
      } catch (e) {
        if (e instanceof Error && e.message !== "Cancelled") {
          throw e;
        }
        throw e;
      }
    }

    throw new Error("SSH connection timed out. Check the host, path, and your SSH key access.");
  }, []);

  const handleSSHConnect = useCallback(async () => {
    if (!sshTarget.trim() || !logPath.trim()) {
      setError("Both SSH target and log path are required");
      return;
    }

    setError("");
    setConnecting(true);
    cancelledRef.current = false;

    try {
      const r = await fetch(`${API_URL}/api/source/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sshTarget: sshTarget.trim(), logPath: logPath.trim(), jumpServer: jumpServer.trim() || undefined }),
      });
      const d = await r.json();

      if (d.error) {
        setError(d.error);
        setConnecting(false);
        return;
      }

      sourceIdRef.current = d.sourceId;

      // Poll until connected or error
      const source = await pollSSHStatus();
      onConnected(source, d.sourceId);
    } catch (e) {
      stopAndCleanup();
      setError(e instanceof Error ? e.message : "Failed to connect via SSH");
    } finally {
      setConnecting(false);
    }
  }, [sshTarget, logPath, pollSSHStatus, onConnected, stopAndCleanup]);

  const verifyFileLoaded = useCallback(async (): Promise<SourceStatus> => {
    // Poll stats for a short time to confirm lines were parsed
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`${API_URL}/api/source/status?sourceId=${sourceIdRef.current}`);
        const d = await r.json();
        const src = d.source as SourceStatus | null;
        if (src && src.status === "connected") {
          // Verify lines exist
          const statsR = await fetch(`${API_URL}/api/stats?sourceId=${sourceIdRef.current}`);
          const stats = await statsR.json();
          if (stats.totalLines > 0) {
            return src;
          }
          throw new Error("Log file appears to be empty or has no parseable log lines");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("empty")) {
          throw e;
        }
      }
    }
    throw new Error("Failed to verify file was loaded");
  }, []);

  const handleFileSelect = useCallback(async (file: File) => {
    if (file.size === 0) {
      setError("File is empty");
      return;
    }

    // Basic extension check
    const validExtensions = [".log", ".txt", ".jsonl", ".log.", ".out"];
    const lowerName = file.name.toLowerCase();
    const hasValidExt = validExtensions.some((ext) => lowerName.includes(ext)) || !file.name.includes(".");

    if (!hasValidExt && file.type && !file.type.startsWith("text/")) {
      setError("Please select a .log, .txt, or .jsonl file");
      return;
    }

    setConnecting(true);
    setError("");
    cancelledRef.current = false;

    try {
      const data = await file.text();

      if (!data.trim()) {
        setError("File is empty or contains no text");
        setConnecting(false);
        return;
      }

      const r = await fetch(`${API_URL}/api/source/upload?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: data,
      });
      const d = await r.json();

      if (d.error) {
        setError(d.error);
        setConnecting(false);
        return;
      }

      sourceIdRef.current = d.sourceId;

      // Verify lines were actually parsed
      const source = await verifyFileLoaded();
      onConnected(source, d.sourceId);
    } catch (e) {
      stopAndCleanup();
      setError(e instanceof Error ? e.message : "Failed to load file");
    } finally {
      setConnecting(false);
    }
  }, [verifyFileLoaded, onConnected, stopAndCleanup]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  return (
    <div className="h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-lg px-8">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-white mb-2">Log Tail Viewer</h1>
          <p className="text-zinc-500 text-sm">Connect to a log source to get started</p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 mb-8 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
          <button
            onClick={() => { setMode("ssh"); setError(""); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === "ssh" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Live SSH Tail
          </button>
          <button
            onClick={() => { setMode("file"); setError(""); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === "file" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Open Log File
          </button>
        </div>

        {/* SSH form */}
        {mode === "ssh" && (
          <div className="space-y-5">
            <div>
              <label className="text-xs text-zinc-400 font-medium mb-1.5 block">SSH Target</label>
              <input
                type="text"
                placeholder="user@hostname"
                value={sshTarget}
                onChange={(e) => setSshTarget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSSHConnect()}
                disabled={connecting}
                className="w-full bg-zinc-900 text-zinc-100 px-4 py-3 rounded-xl border border-zinc-800 outline-none focus:border-indigo-600 text-sm placeholder-zinc-600 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 font-medium mb-1.5 block">Jump Server <span className="text-zinc-600">(optional)</span></label>
              <input
                type="text"
                placeholder="jumpuser@jumphost"
                value={jumpServer}
                onChange={(e) => setJumpServer(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSSHConnect()}
                disabled={connecting}
                className="w-full bg-zinc-900 text-zinc-100 px-4 py-3 rounded-xl border border-zinc-800 outline-none focus:border-indigo-600 text-sm placeholder-zinc-600 font-mono disabled:opacity-50"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 font-medium mb-1.5 block">Log Path</label>
              <input
                type="text"
                placeholder="/path/to/logs/*.log"
                value={logPath}
                onChange={(e) => setLogPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSSHConnect()}
                disabled={connecting}
                className="w-full bg-zinc-900 text-zinc-100 px-4 py-3 rounded-xl border border-zinc-800 outline-none focus:border-indigo-600 text-sm placeholder-zinc-600 font-mono disabled:opacity-50"
              />
            </div>
            {error && (
              <div className="bg-red-950/40 border border-red-800/50 rounded-lg px-4 py-3">
                <p className="text-red-300 text-xs">{error}</p>
              </div>
            )}
            <div className="flex gap-3">
              {connecting && (
                <button
                  onClick={() => {
                    cancelledRef.current = true;
                    stopAndCleanup();
                    setConnecting(false);
                    setError("Connection cancelled");
                  }}
                  className="px-4 py-3 rounded-xl bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 font-medium text-sm transition-colors"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={handleSSHConnect}
                disabled={connecting}
                className="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-500 transition-colors disabled:opacity-50"
              >
                {connecting ? "Connecting..." : "Connect"}
              </button>
            </div>
            {connecting && (
              <p className="text-indigo-400/70 text-xs text-center">
                Establishing SSH connection and waiting for first log line...
              </p>
            )}
          </div>
        )}

        {/* File upload */}
        {mode === "file" && (
          <div className="space-y-5">
            <div
              onClick={() => !connecting && fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-2xl py-16 px-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-indigo-500 bg-indigo-600/10"
                  : "border-zinc-700 hover:border-zinc-600 hover:bg-zinc-900"
              } ${connecting ? "opacity-50 pointer-events-none" : ""}`}
            >
              <div className="text-4xl mb-4 opacity-40 text-zinc-500">📄</div>
              <p className="text-zinc-300 text-sm font-medium mb-1">
                Drop a .log file here or click to browse
              </p>
              <p className="text-zinc-600 text-xs">
                Supports .log, .txt, .jsonl files
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".log,.txt,.jsonl,.out,text/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
                className="hidden"
              />
            </div>
            {error && (
              <div className="bg-red-950/40 border border-red-800/50 rounded-lg px-4 py-3">
                <p className="text-red-300 text-xs">{error}</p>
              </div>
            )}
            {connecting && (
              <p className="text-indigo-400/70 text-xs text-center">Loading and parsing file...</p>
            )}
          </div>
        )}

        <div className="mt-8 text-center text-zinc-700 text-xs">
          Make sure the API server is running on http://localhost:3201
        </div>
      </div>
    </div>
  );
}