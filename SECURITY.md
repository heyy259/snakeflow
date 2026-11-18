# Security Policy

## Supported versions

Security fixes are applied to the latest minor release of SnakeFlow and to the
SnakeEats versions listed in `COMPATIBILITY.md`.

## Local trust model

SnakeFlow is a local-first application. The Node server binds to loopback only
(`127.0.0.1`). The browser never receives the SnakeEats root token: the server
creates a fresh token for each spawned SnakeEats process and injects it only
into that process environment.

All `/api/*` routes and the `/api/se/ws` WebSocket upgrade are protected by an
exact loopback origin check plus a per-server-session secret. Requests from a
different loopback port, a non-loopback host, or without the session secret are
rejected. Do not expose the server with `--host 0.0.0.0` unless you have added
a real authentication layer first.

## Reporting a vulnerability

Please do not open a public issue for security reports. Contact the maintainers
privately through the
[GitHub Security Advisory form](https://github.com/heyy259/snakeflow/security/advisories/new)
with:

- affected SnakeFlow and SnakeEats versions;
- operating system and Node/Python versions;
- reproduction steps;
- whether the issue requires local access, a malicious web page, or network access.

If the advisory form is temporarily unavailable, use the private contact
channel listed on the maintainer's [GitHub profile](https://github.com/heyy259).

## Data safety

SnakeFlow never automatically deletes `se-storage/` or workspace documents.
Only `runtime/` metadata is cleaned automatically, and only after it is stale
and provably unreferenced.
