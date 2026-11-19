# Changelog

All notable changes to SnakeFlow are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a project Code of Conduct and a private GitHub Security Advisory
  reporting path.

### Fixed

- Restored the tracked `server/se/runtime/` source modules used by the runtime
  resolver, process supervisor, launcher, and integration tests.
- Anchored runtime/build ignore rules to the repository root so source files
  under nested `runtime/` directories are included.

### Changed

- Marked `start.command` and `start.sh` as executable in Git.
- Replaced machine-specific paths in portability tests with neutral examples.
- Normalized public author metadata to the project's GitHub identity and
  removed machine-specific paths from the public Git history.

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
