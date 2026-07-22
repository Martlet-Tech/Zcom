<p align="center">
  <img src="src-tauri/icons/app-icon.png" width="128" height="128" alt="ZCOM">
</p>

<h1 align="center">ZCOM</h1>

<p align="center">
  High-performance serial debug assistant — Rust + Tauri
</p>

<p align="center">
  English · <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-1.96-orange" alt="Rust">
  <img src="https://img.shields.io/badge/Tauri-2.11-blue" alt="Tauri">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="Platform">
</p>

---

## Why ZCOM?

After many years of embedded/microcontroller work, I had tried every serial tool out there — but none felt right except sscom (a classic Chinese serial tool). So I never switched.

But sscom has pain points that were never fixed:

1. **Auto-scroll can't pause** — data keeps pushing the view down; look back and it snaps to bottom
2. **Multi-string panel steals screen space** — embedded in the main window, takes half the UI
3. **UTF-8 encoding broken** — Chinese text garbled without manual byte calculation
4. **No dark theme** — blinding white interface in a dim lab
5. **Can't pin window** — constant alt-tab while reading PDF datasheets
6. **No receiver search/filter** — hunting for a specific packet means squinting at a wall of text

With the help of AI-assisted coding, I decided to build a modern replacement.
Issues and PRs welcome.

## Features

- 🔥 **MCP (Model Context Protocol) Server** — built-in MCP HTTP server lets AI agents (opencode, Claude Desktop, etc.) read serial data, inspect port status, and send commands in real time. Enable in settings, connect at `http://localhost:9876/mcp`.
- 🔥 **Repeat line folding** — auto-fold identical consecutive lines into <code>[×N]</code>, click to expand, right-click for copy / fold below
- ⭐ **Serial communication** — auto-enumerate COM ports with device descriptions, hot-plug support
- ⭐ **Dual-mode I/O** — text / Hex send and receive, switch on the fly
- ⭐ **Receive filter** — keyword / regex filter, case-sensitivity toggle, Ctrl+F to focus
- ⭐ **Multi-string sender** — independent window, drag-to-reorder, per-item Hex/delay, loop mode, JSON import/export
- ⭐ **Auto-scroll** — pauses on manual scroll, resumes at bottom
- ⭐ **Timestamps** — bidirectional send/receive timestamps
- ⭐ **Pin window** — main window and multi-string window both support always-on-top
- ⭐ **Themes** — dark / light / system / high-contrast
- ⭐ **Encoding** — UTF-8 / GBK selectable, solves Chinese garbled text
- ⭐ **Checksum** — CRC16-Modbus / CRC32 / ADD8 / XOR8, custom insert position
- ⭐ **File upload** — chunked send with abort support
- ⭐ **Save received data** — dump receive buffer to file
- ⭐ **UI customization** — font family, size, and color picker
- ⭐ **Persistent config** — all settings auto-saved

## Screenshots

<p align="center">
  <img src="screenshots/main.png" width="700" alt="Main window">
  <br>
  <em>Main window — dark theme, filter bar, multi-string panel</em>
</p>

<p align="center">
  <img src="screenshots/multi-strings.png" width="600" alt="Multi-string window">
  <br>
  <em>Multi-string sender — drag-to-reorder, per-item Hex/delay, loop mode</em>
</p>

<p align="center">
  <img src="screenshots/fold.png" width="700" alt="Repeat line folding">
  <br>
  <em>Repeat line folding — auto-fold identical consecutive lines into <code>[×N]</code>, click to expand, right-click for copy / fold below</em>
</p>

## Quick Start

```bash
npm install
npm run tauri dev    # development
npm run tauri build  # production build
```

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri v2 |
| Backend | Rust — serialport / encoding_rs / crc |
| Frontend | Vanilla HTML / CSS / JS |
| Build | Vite + @tauri-apps/cli |

## Download

Grab the latest build from the [Releases](https://github.com/Martlet-Tech/Zcom/releases) page.

## License

MIT
