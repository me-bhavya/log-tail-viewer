<div align="center">

# Log Tail Viewer

A real-time, browser-based log tail viewer. Connect to remote hosts via SSH (with optional jump server), or drop in local log files. Multi-tab support lets you watch multiple sources in parallel.

![Status](https://img.shields.io/badge/status-active-success)
![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Tailwind](https://img.shields.io/badge/TailwindCSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## ✨ Features

| Feature | What it does |
|---------|-------------|
| **Multi-Tab / Multi-Source** | Open multiple browser tabs, each connected to a different log source — independent SSH hosts, files, and filters, all streaming in parallel |
| **SSH Tail + Jump Server** | Connect to `user@host` and tail remote logs. Optional jump server (bastion) via `-J` flag — works with `~/.ssh/config` aliases |
| **File Upload** | Drag-and-drop `.log`, `.txt`, `.jsonl` files. Parsed and indexed server-side instantly |
| **Multi-Format Parsing** | Dropwizard/slf4j, JSON, common text, logfmt — with raw fallback. Structured fields extracted automatically |
| **Virtualized Rendering** | `react-virtuoso` with dynamic row heights. Handles thousands of lines with smooth scrolling |
| **Real-Time Streaming** | SSE streaming with 100ms batch intervals. Backfill on connect and on scroll-up |
| **Live Filters** | Toggle log levels (with row tinting), text/regex search with highlighting, and exclude filter |
| **Pause / Resume** | Pause the stream without losing data. Buffered lines flush on resume. Auto-tail when at bottom |
| **Refresh Persistence** | Each tab stores its source in the URL — refresh reconnects automatically |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **SSH key** at `~/.ssh/id_ed25519` (for SSH tail)
- **SSH config** entries for jump server aliases (if using bastion hosts)

### One-Command Start

```bash
npm install
npm run dev:all
```

This starts both the API server (port 3201) and the frontend (port 3200) in a single terminal.

Open http://localhost:3200

> **Separate terminals?**
> ```bash
> npm run server   # port 3201
> npm run dev      # port 3200
> ```

### Sample Log Generators

```bash
./sample-logs.sh                          # generate a static sample log file
./live-logs.sh /path/to/output.log       # continuously append live logs
```

---

## 🏗️ Architecture

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

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TailwindCSS 4 |
| Rendering | react-virtuoso (dynamic height virtualization) |
| Backend | Node.js HTTP server (no framework) |
| Streaming | SSE (Server-Sent Events) |
| SSH | Native `ssh` with key-based auth |

---

## 📋 Log Formats

| Format | Example |
|--------|---------|
| **Dropwizard / slf4j** | `INFO [2024-01-01T12:00:00.000Z] trace-abc [main] [com.app.Service]: Started` |
| **JSON** | `{"timestamp":"2024-01-01T12:00:00Z","level":"ERROR","message":"..."}` |
| **Common text** | `2024-01-01T12:00:00.000Z [ERROR] Something went wrong` |
| **Logfmt** | `level=error msg="disk full" component=storage` |
| **Raw fallback** | Any unparseable line is displayed as-is |

---

## 📡 API Reference

All data endpoints require `?sourceId=xxx`.

<details>
<summary><b>Click to expand full API reference</b></summary>

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

</details>

---

## 🔧 Log Format Parsers

The server automatically detects and parses multiple log formats. Parsed fields (timestamp, level, traceId, thread, logger) are extracted into structured data for filtering and display.

- **Dropwizard / slf4j**: `LEVEL [date] traceId [thread] [logger]: message`
- **JSON**: extracts `timestamp`, `level`, and all fields
- **Common text**: timestamp + optional `[LEVEL]` + message
- **Logfmt**: `key=value` pairs parsed into structured fields
- **Raw fallback**: any unparseable line passes through as-is

---

<div align="center">

Made with ⚡ by [me-bhavya](https://github.com/me-bhavya)

</div>