# Log Tail Viewer

A real-time log tail viewer for debugging Dropwizard / slf4j server logs. Connect to remote hosts via SSH (with optional jump server / bastion support), or drag-and-drop local log files. Multiple browser tabs can connect to independent log sources simultaneously.

## Features

### Multi-Source / Multi-Tab
- Open multiple browser tabs, each connected to a **different log source** — different SSH hosts, different files, all streaming in parallel
- Each tab gets its own `?source=xxx` URL param, so **refresh persists** per-tab
- Sources are fully independent — separate log files, separate SSE streams, separate filters
- "+ New Tab" button in the header opens a fresh start screen

### SSH Tail with Jump Server Support
- Connect to any remote host: `user@hostname` + `/path/to/logs/*.log`
- **Jump server (bastion)** support via SSH `-J` flag — works with `~/.ssh/config` aliases (e.g. `pgjump`)
- SSH key at `~/.ssh/id_ed25519` is used automatically with `IdentitiesOnly=yes`
- SSH connection validation: polls for connection status, captures common errors (hostname resolution, permission denied, timeout, host key verification), cancel button during connecting
- `StrictHostKeyChecking=accept-new` for first-connect convenience

### Local File & Upload
- Drag-and-drop `.log`, `.txt`, `.jsonl` files onto the start screen
- Empty file detection — rejects files with no parseable log lines
- File contents are parsed and indexed server-side for search/backfill

### Log Parsing
- **Dropwizard / slf4j format**: `LEVEL [date] traceId [thread] [logger]: message`
- **JSON logs**: extracts `timestamp`, `level`, and all fields automatically
- **Common text format**: `2024-01-01T12:00:00.000Z [ERROR] message`
- **Logfmt**: `key=value` pairs parsed into structured fields
- Fallback: raw line passed through as-is

### Virtualized Rendering
- Powered by `react-virtuoso` with dynamic row heights (messages can span multiple lines)
- 2-line card layout: metadata row (line number, level badge, timestamp, trace ID, thread, logger) + message row
- Handles large log volumes (8000-line window with backfill on scroll-up)

### Streaming & Backfill
- **SSE (Server-Sent Events)** for real-time streaming with 100ms batch interval
- On connect, backfills the last 200 lines from buffer or file
- **Scroll-up backfill**: loads 500 older lines when reaching the top of the viewport
- Line index (every 100th line) for fast offset-based seek

### Filters
- **Level badges**: click to toggle DEBUG / INFO / WARN / ERROR / TRACE — rows tinted by level (ERROR = red background, WARN = amber background)
- **Text search**: case-insensitive, highlights matches across all fields (raw line, message, traceId, thread, logger)
- **Regex search**: toggle regex mode for advanced pattern matching
- **Exclude filter**: hide lines containing specific text

### Pause / Resume
- Pause incoming log lines without losing them — buffered and flushed on resume
- "↓ Live" button to jump back to the bottom and resume following
- Auto-tail: new lines auto-scroll to bottom when already at the bottom

### Source Management
- Source state persists server-side — browser refresh reconnects to the same source
- Disconnect button cleanly stops the SSH process and cleans up files
- `GET /api/sources` lists all active sources across tabs

## Architecture

```
┌─────────────────────┐     SSE      ┌──────────────────────┐
│  Next.js Frontend    │◄────────────►│  Node API Server     │
│  (port 3200)        │   /api/*     │  (port 3201)         │
│                     │              │                      │
│  - Start screen     │              │  - MultiSourceManager│
│  - Virtuoso list    │              │  - LogTailer (per    │
│  - Filters/pause    │              │    source)           │
│  - Multi-tab        │              │  - SSH spawn         │
└─────────────────────┘              │  - File watcher      │
                                     │  - Log parser        │
                                     │  - Line index        │
                                     └──────────────────────┘
```

**Frontend**: Next.js 16 + React 19 + TailwindCSS 4 + react-virtuoso
**Backend**: Node.js HTTP server (no framework) with SSE streaming

## Getting Started

### Prerequisites
- Node.js 18+
- SSH key at `~/.ssh/id_ed25519` (for SSH tail feature)
- SSH config entries for jump server aliases (if using bastion hosts)

### Install & Run

```bash
# Install dependencies
npm install

# Start the API server (port 3201)
npm run server

# In another terminal, start the frontend (port 3200)
npm run dev
```

Open http://localhost:3200

### Sample Log Generators

```bash
# Generate a static sample log file
./sample-logs.sh

# Continuously append live logs to any path
./live-logs.sh /path/to/output.log
```

## API Endpoints

All data endpoints require `?sourceId=xxx`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stream?sourceId=xxx` | SSE stream for real-time log lines |
| GET | `/api/backfill?sourceId=xxx&from=N&limit=500` | Fetch older lines from line N |
| GET | `/api/search?sourceId=xxx&q=query&regex=false&level=ERROR` | Search across log lines |
| GET | `/api/stats?sourceId=xxx` | Line count, file size, connected clients |
| GET | `/api/sources` | List all active sources |
| POST | `/api/source/start` | Start SSH tail (body: `{sshTarget, logPath, jumpServer?}`) |
| POST | `/api/source/stop?sourceId=xxx` | Stop and destroy a source |
| GET | `/api/source/status?sourceId=xxx` | Get source connection status |
| POST | `/api/source/file` | Use local file (body: `{filePath}`) |
| POST | `/api/source/upload?filename=foo.log` | Upload file content as source |
| GET | `/api/health` | Health check |