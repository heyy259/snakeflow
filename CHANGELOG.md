# Changelog

All notable changes to SnakeFlow are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-16

### Added

- First public open-source import.
- Standalone Node server (`server/app/standalone.js`) in addition to the Vite
  development server; both share the same API router.
- `AppPaths` separates application, data, workspace, configuration, runtime,
  and SnakeEats storage roots.
- `RuntimeProvider` supports `pip`, `dir`, and `auto` SnakeEats resolution.
- Exact-origin + per-session-secret security gate for HTTP APIs and WebSocket
  upgrades.
- Cross-platform process-tree shutdown, dialogs, and absolute-path handling.
- Windows and macOS launchers.

### Changed

- Runtime metadata moved out of SnakeEats storage into `runtime/`.
- SnakeEats storage is no longer deleted automatically; only stale runtime
  metadata is cleaned.
- Configuration schema v2 with a read-only migration path from v1.
- Python and SnakeEats resolution is asynchronous and cached instead of
  blocking the Node event loop.

### Removed

- Machine-specific SnakeEats auto-discovery paths.
- The Windows-only `启动ReactFlow演示.bat` launcher.
- Legacy `.se-token` persistence.
