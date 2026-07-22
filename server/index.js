import http from "http";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import crypto from "crypto";

const PORT = 3201;
const LOG_DIR = path.join(process.cwd(), "logs");
const INDEX_INTERVAL = 100;
const MAX_BUFFER_LINES = 50000;
const BATCH_INTERVAL_MS = 100;

function ensureDirs() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

// ── LineIndex: same as before, parameterized by path ──

class LineIndex {
  constructor(indexPath, interval) {
    this.indexPath = indexPath;
    this.interval = interval;
    this.entries = [];
    this.lineCount = 0;
    this.load();
  }

  load() {
    if (fs.existsSync(this.indexPath)) {
      const raw = fs.readFileSync(this.indexPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {}
      }
    }
  }

  append(lineNumber, byteOffset, timestamp, level) {
    if (lineNumber % this.interval !== 0) return;
    const entry = { line: lineNumber, offset: byteOffset, ts: timestamp || null, level: level || null };
    this.entries.push(entry);
    this.persist();
  }

  persist() {
    const data = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(this.indexPath, data);
  }

  findNearestBefore(lineNumber) {
    let lo = 0, hi = this.entries.length - 1, result = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].line <= lineNumber) {
        result = this.entries[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  findNearestAfter(lineNumber) {
    let lo = 0, hi = this.entries.length - 1, result = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].line >= lineNumber) {
        result = this.entries[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return result;
  }
}

// ── LogTailer: parameterized by logFile and indexFile ──

class LogTailer {
  constructor(logFile, indexFile) {
    this.logFile = logFile;
    this.indexFile = indexFile;
    this.index = new LineIndex(indexFile, INDEX_INTERVAL);
    this.lineNumber = 0;
    this.byteOffset = 0;
    this.clients = new Set();
    this.batch = [];
    this.batchTimer = null;
    this.watchStarted = false;
    this.init();
  }

  reset() {
    this.index = new LineIndex(this.indexFile, INDEX_INTERVAL);
    this.lineNumber = 0;
    this.byteOffset = 0;
    this.batch = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.watchStarted = false;
  }

  init() {
    if (!fs.existsSync(this.logFile)) return;
    const stat = fs.statSync(this.logFile);
    this.byteOffset = stat.size;
    this.lineNumber = this.countLinesFast();
    this.startWatching();
  }

  countLinesFast() {
    if (this.index.entries.length > 0) {
      const last = this.index.entries[this.index.entries.length - 1];
      return last.line + this.countLinesFromOffset(last.offset, last.line);
    }
    return this.countLinesFromOffset(0, 0);
  }

  countLinesFromOffset(offset, baseLine) {
    const fd = fs.openSync(this.logFile, "r");
    const buf = Buffer.alloc(65536);
    let pos = offset;
    let lines = baseLine;
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) lines++;
      }
      pos += bytesRead;
      if (bytesRead < buf.length) break;
    }
    fs.closeSync(fd);
    return lines;
  }

  startWatching() {
    if (this.watchStarted) return;
    this.watchStarted = true;

    fs.watch(this.logFile, { persistent: true }, (eventType) => {
      if (eventType === "rename") {
        setTimeout(() => this.checkTruncate(), 500);
        return;
      }
      this.readNewLines();
    });

    this.readNewLines();
  }

  checkTruncate() {
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size < this.byteOffset) {
        this.byteOffset = 0;
        this.lineNumber = 0;
      }
      this.readNewLines();
    } catch {}
  }

  readNewLines() {
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size <= this.byteOffset) return;

      const fd = fs.openSync(this.logFile, "r");
      const length = stat.size - this.byteOffset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, this.byteOffset);
      fs.closeSync(fd);

      const text = buf.toString("utf8");
      const lines = text.split("\n");

      if (lines[lines.length - 1] === "") lines.pop();

      for (const line of lines) {
        this.lineNumber++;
        const parsed = this.parseLine(line);
        this.index.append(this.lineNumber, this.byteOffset, parsed.ts, parsed.level);
        this.batch.push({
          line: this.lineNumber,
          offset: this.byteOffset,
          raw: line,
          ...parsed,
        });
        this.byteOffset += Buffer.byteLength(line, "utf8") + 1;

        while (this.batch.length > MAX_BUFFER_LINES) {
          this.batch.shift();
        }
      }

      this.flushBatch();
    } catch (e) {
      console.error("readNewLines error:", e.message);
    }
  }

  parseLine(line) {
    if (!line) return { ts: null, level: null, fields: null };

    // Try JSON
    try {
      const obj = JSON.parse(line);
      const ts = obj.timestamp || obj.ts || obj.time || obj["@timestamp"] || null;
      const level = (obj.level || obj.severity || obj.logLevel || "").toUpperCase() || null;
      return { ts, level, fields: obj };
    } catch {}

    // Dropwizard/slf4j format: LEVEL [date] trace-id [thread] [logger]: message
    const dw = line.match(/^(\s*(DEBUG|INFO|WARN(?:ING)?|ERROR|TRACE|FATAL)\s*)\s*\[([^\]]+)\]\s*(\S*)\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*(.*)$/);
    if (dw) {
      return {
        ts: dw[3],
        level: dw[2].toUpperCase(),
        fields: {
          traceId: dw[4] || null,
          thread: dw[5],
          logger: dw[6],
        },
        message: dw[7],
      };
    }

    // Try common text format: 2024-01-01T12:00:00.000Z [ERROR] message
    const m = line.match(/^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*(?:\[?(DEBUG|INFO|WARN(?:ING)?|ERROR|TRACE|FATAL)\]?)?\s*(.*)$/);
    if (m) {
      return { ts: m[1], level: m[2] ? m[2].toUpperCase() : null, fields: null, message: m[3] };
    }

    // Try logfmt: key=value pairs
    if (/^[\w.-]+=/.test(line) && line.includes("=")) {
      const fields = {};
      const re = /(\S+?)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let match;
      while ((match = re.exec(line)) !== null) {
        fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
      }
      const ts = fields.timestamp || fields.ts || fields.time || null;
      const level = (fields.level || fields.severity || "").toUpperCase() || null;
      return { ts, level, fields };
    }

    return { ts: null, level: null, fields: null, message: line };
  }

  flushBatch() {
    if (this.batch.length === 0) return;
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      const toSend = this.batch.slice();
      this.batch = [];
      this.batchTimer = null;

      const data = `data: ${JSON.stringify({ type: "lines", lines: toSend })}\n\n`;
      for (const client of this.clients) {
        try {
          client.write(data);
        } catch {}
      }
    }, BATCH_INTERVAL_MS);
  }

  addClient(res) {
    const self = this;

    // Send last N lines as backfill — from batch if available, otherwise from file
    let recent = this.batch.slice(-200);
    if (recent.length === 0 && this.lineNumber > 0) {
      const fromLine = Math.max(1, this.lineNumber - 200);
      recent = this.backfill(fromLine, 200);
    }
    if (recent.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "lines", lines: recent })}\n\n`);
    }

    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: "ready", lineCount: this.lineNumber })}\n\n`);

    res.on("close", () => {
      self.clients.delete(res);
    });
  }

  backfill(fromLine, limit) {
    limit = Math.min(limit || 500, 2000);
    const results = [];

    // Find offset from index, then scan forward from there
    const entry = this.index.findNearestBefore(fromLine);
    let startOffset = entry ? entry.offset : 0;
    let currentLine = entry ? entry.line : 0;

    const fd = fs.openSync(this.logFile, "r");
    const buf = Buffer.alloc(65536);
    let pos = startOffset;
    let lineBuf = "";

    while (results.length < limit) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, pos);
      if (bytesRead === 0) break;

      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) {
          currentLine++;
          if (currentLine >= fromLine) {
            const parsed = this.parseLine(lineBuf);
            results.push({
              line: currentLine,
              offset: pos - Buffer.byteLength(lineBuf, "utf8") - 1,
              raw: lineBuf,
              ...parsed,
            });
            if (results.length >= limit) break;
          }
          lineBuf = "";
        } else {
          lineBuf += String.fromCharCode(buf[i]);
        }
      }
      pos += bytesRead;
      if (bytesRead < buf.length) break;
    }

    fs.closeSync(fd);

    // Handle last partial line
    if (lineBuf && results.length < limit) {
      currentLine++;
      const parsed = this.parseLine(lineBuf);
      results.push({
        line: currentLine,
        offset: pos - Buffer.byteLength(lineBuf, "utf8"),
        raw: lineBuf,
        ...parsed,
      });
    }

    return results;
  }

  search(query, options = {}) {
    const { limit = 500, level = null, fromLine = 1 } = options;
    const results = [];
    const isRegex = options.regex === true;
    let regex = null;
    if (isRegex) {
      try { regex = new RegExp(query); } catch { return { error: "invalid regex" }; }
    }

    const fd = fs.openSync(this.logFile, "r");
    const buf = Buffer.alloc(65536);
    let pos = 0;
    let lineNum = 0;
    let lineBuf = "";

    while (results.length < limit) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, pos);
      if (bytesRead === 0) break;

      for (let I = 0; I < bytesRead; I++) {
        if (buf[I] === 10) {
          lineNum++;
          if (lineNum >= fromLine) {
            const match = isRegex
              ? regex.test(lineBuf)
              : lineBuf.includes(query);
            if (match) {
              if (!level || this.parseLine(lineBuf).level === level) {
                results.push({
                  line: lineNum,
                  offset: pos - Buffer.byteLength(lineBuf, "utf8") - 1,
                  raw: lineBuf,
                });
              }
            }
            if (results.length >= limit) break;
          }
          lineBuf = "";
        } else {
          lineBuf += String.fromCharCode(buf[I]);
        }
      }
      pos += bytesRead;
      if (bytesRead < buf.length) break;
    }

    fs.closeSync(fd);
    return { results, total: results.length, truncated: results.length >= limit };
  }

  destroy() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();
    // Clean up log and index files
    try { if (fs.existsSync(this.logFile)) fs.unlinkSync(this.logFile); } catch {}
    try { if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile); } catch {}
  }
}

// ── SourceSession: one per tab (each has its own tailer + process + metadata) ──

class SourceSession {
  constructor(id) {
    this.id = id;
    this.logFile = path.join(LOG_DIR, `${id}.log`);
    this.indexFile = path.join(LOG_DIR, `${id}.log.idx`);
    this.process = null;
    this.source = null;
    this.tailer = null;
    this.writeStream = null;
  }

  startSSH(sshTarget, logPath, jumpServer) {
    this.stop();

    // Clear existing log file for a fresh session
    fs.writeFileSync(this.logFile, "");
    if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);

    this.tailer = new LogTailer(this.logFile, this.indexFile);

    const cmd = `tail -F ${logPath}`;
    const sshOpts = [
      "-A",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=accept-new",
    ];
    if (jumpServer) {
      sshOpts.push("-J", jumpServer);
    }
    const args = [...sshOpts, sshTarget, cmd];

    const proc = spawn("ssh", args);
    this.process = proc;
    this.source = {
      id: this.id,
      type: "ssh",
      sshTarget,
      logPath,
      jumpServer: jumpServer || undefined,
      startedAt: new Date().toISOString(),
      linesReceived: 0,
      status: "connecting",
    };

    this.writeStream = fs.createWriteStream(this.logFile, { flags: "a" });

    proc.stdout.on("data", (data) => {
      this.writeStream.write(data);
      this.source.linesReceived += data.toString().split("\n").filter(l => l.trim()).length;
      this.source.status = "connected";
    });

    proc.stderr.on("data", (data) => {
      const errText = data.toString().trim();
      console.error(`[ssh ${this.id} stderr]`, errText);
      if (this.source && this.source.status === "connecting") {
        if (errText.includes("Could not resolve hostname") || errText.includes("Connection refused") || errText.includes("Permission denied") || errText.includes("Host key verification failed") || errText.includes("Connection timed out")) {
          this.source.status = "error";
          this.source.error = errText;
        }
      }
    });

    proc.on("error", (err) => {
      console.error(`[ssh ${this.id} error]`, err.message);
      if (this.source) {
        this.source.status = "error";
        this.source.error = err.message;
      }
    });

    proc.on("close", (code) => {
      console.log(`[ssh ${this.id}] process exited with code ${code}`);
      if (this.source) {
        if (this.source.status === "connecting") {
          this.source.status = "error";
          this.source.error = code !== 0 ? "SSH connection failed (process exited before any data was received)" : "SSH connection closed before any data was received";
        } else if (this.source.status === "connected") {
          this.source.status = "disconnected";
        }
      }
      this.process = null;
    });

    return this.source;
  }

  useLocalFile(filePath) {
    this.stop();

    if (!fs.existsSync(filePath)) {
      return { error: "file not found" };
    }

    fs.copyFileSync(filePath, this.logFile);
    if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);
    this.tailer = new LogTailer(this.logFile, this.indexFile);

    this.source = {
      id: this.id,
      type: "file",
      localFile: filePath,
      startedAt: new Date().toISOString(),
      status: "connected",
    };

    return this.source;
  }

  uploadData(data, filename) {
    this.stop();

    fs.writeFileSync(this.logFile, data);
    if (fs.existsSync(this.indexFile)) fs.unlinkSync(this.indexFile);
    this.tailer = new LogTailer(this.logFile, this.indexFile);

    this.source = {
      id: this.id,
      type: "upload",
      filename,
      startedAt: new Date().toISOString(),
      status: "connected",
    };

    return this.source;
  }

  stop() {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    if (this.writeStream) {
      try { this.writeStream.end(); } catch {}
      this.writeStream = null;
    }
    this.source = null;
  }

  getStatus() {
    return this.source;
  }

  destroy() {
    this.stop();
    if (this.tailer) {
      this.tailer.destroy();
      this.tailer = null;
    }
  }
}

// ── MultiSourceManager: holds Map<id, SourceSession> ──

class MultiSourceManager {
  constructor() {
    this.sessions = new Map();
  }

  createSession() {
    const id = genId();
    const session = new SourceSession(id);
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  removeSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      this.sessions.delete(id);
      return true;
    }
    return false;
  }

  getAll() {
    const result = [];
    for (const [id, session] of this.sessions) {
      if (session.source) {
        result.push({ id, ...session.source });
      }
    }
    return result;
  }
}

ensureDirs();
const sourceManager = new MultiSourceManager();

function sendJSON(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const sourceId = url.searchParams.get("sourceId");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE stream
  if (pathname === "/api/stream") {
    if (!sourceId || !sourceManager.getSession(sourceId)) {
      sendJSON(res, 400, { error: "invalid or missing sourceId" });
      return;
    }
    const session = sourceManager.getSession(sourceId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    session.tailer.addClient(res);
    req.on("close", () => session.tailer.clients.delete(res));
    return;
  }

  // Backfill: GET /api/backfill?from=123&limit=500&sourceId=xxx
  if (pathname === "/api/backfill") {
    if (!sourceId || !sourceManager.getSession(sourceId)) {
      sendJSON(res, 400, { error: "invalid or missing sourceId" });
      return;
    }
    const session = sourceManager.getSession(sourceId);
    const from = parseInt(url.searchParams.get("from") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "500");
    const lines = session.tailer.backfill(from, limit);
    sendJSON(res, 200, { lines, total: lines.length });
    return;
  }

  // Search: GET /api/search?q=error&regex=false&level=ERROR&limit=500&sourceId=xxx
  if (pathname === "/api/search") {
    if (!sourceId || !sourceManager.getSession(sourceId)) {
      sendJSON(res, 400, { error: "invalid or missing sourceId" });
      return;
    }
    const session = sourceManager.getSession(sourceId);
    const q = url.searchParams.get("q") || "";
    const regex = url.searchParams.get("regex") === "true";
    const level = url.searchParams.get("level") || null;
    const limit = parseInt(url.searchParams.get("limit") || "500");
    const fromLine = parseInt(url.searchParams.get("from") || "1");
    const result = session.tailer.search(q, { regex, level, limit, fromLine });
    sendJSON(res, 200, result);
    return;
  }

  // Stats: GET /api/stats?sourceId=xxx
  if (pathname === "/api/stats") {
    if (!sourceId || !sourceManager.getSession(sourceId)) {
      sendJSON(res, 400, { error: "invalid or missing sourceId" });
      return;
    }
    const session = sourceManager.getSession(sourceId);
    sendJSON(res, 200, {
      totalLines: session.tailer.lineNumber,
      fileSize: fs.existsSync(session.logFile) ? fs.statSync(session.logFile).size : 0,
      clients: session.tailer.clients.size,
      logFile: session.logFile,
    });
    return;
  }

  // Health
  if (pathname === "/api/health") {
    sendJSON(res, 200, { status: "ok" });
    return;
  }

  // List all sources: GET /api/sources
  if (pathname === "/api/sources") {
    sendJSON(res, 200, { sources: sourceManager.getAll() });
    return;
  }

  // Source: start SSH tail
  if (pathname === "/api/source/start" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { sshTarget, logPath, jumpServer } = JSON.parse(body);
        if (!sshTarget || !logPath) {
          sendJSON(res, 400, { error: "sshTarget and logPath are required" });
          return;
        }

        const session = sourceManager.createSession();
        const source = session.startSSH(sshTarget, logPath, jumpServer);
        sendJSON(res, 200, { source, sourceId: session.id });
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Source: stop
  if (pathname === "/api/source/stop" && req.method === "POST") {
    if (!sourceId) {
      sendJSON(res, 400, { error: "sourceId is required" });
      return;
    }
    sourceManager.removeSession(sourceId);
    sendJSON(res, 200, { stopped: true });
    return;
  }

  // Source: status
  if (pathname === "/api/source/status") {
    if (!sourceId) {
      sendJSON(res, 400, { error: "sourceId is required" });
      return;
    }
    const session = sourceManager.getSession(sourceId);
    if (!session) {
      sendJSON(res, 200, { source: null });
      return;
    }
    const status = session.getStatus();
    sendJSON(res, 200, { source: status });
    return;
  }

  // Source: use local file
  if (pathname === "/api/source/file" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) {
          sendJSON(res, 400, { error: "filePath is required" });
          return;
        }
        const session = sourceManager.createSession();
        const source = session.useLocalFile(filePath);
        if (source.error) {
          sourceManager.removeSession(session.id);
          sendJSON(res, 400, source);
          return;
        }
        sendJSON(res, 200, { source, sourceId: session.id });
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Source: upload file content
  if (pathname === "/api/source/upload" && req.method === "POST") {
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => (body = Buffer.concat([body, chunk])));
    req.on("end", () => {
      const filename = url.searchParams.get("filename") || "uploaded.log";
      const data = body.toString("utf8");
      const session = sourceManager.createSession();
      const source = session.uploadData(data, filename);
      sendJSON(res, 200, { source, sourceId: session.id });
    });
    return;
  }

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Log Tail API server running on http://localhost:${PORT}`);
  console.log(`  Multi-source: each source gets its own log/index files`);
  console.log(`  SSE:        /api/stream?sourceId=xxx`);
  console.log(`  Backfill:   /api/backfill?sourceId=xxx&from=1&limit=500`);
  console.log(`  Search:     /api/search?sourceId=xxx&q=error`);
  console.log(`  Stats:      /api/stats?sourceId=xxx`);
  console.log(`  Sources:    GET /api/sources`);
  console.log(`  Source:     POST /api/source/start, POST /api/source/stop?sourceId=xxx, POST /api/source/file, POST /api/source/upload?filename=foo.log, GET /api/source/status?sourceId=xxx`);
});