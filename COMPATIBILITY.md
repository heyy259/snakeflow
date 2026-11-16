# SnakeFlow × SnakeEats compatibility

SnakeFlow and SnakeEats version independently. The integration contract is the
WebSocket JSON-RPC handshake (`system.info`) plus the storage discovery file
(`<storage>/registry/.registry.json`).

## Version matrix

| SnakeFlow | SnakeEats package | `protocol_version` | Status |
| --- | --- | --- | --- |
| 0.1.x | `>=0.1.0,<0.2.0` | 1 | supported |

The supported range is also encoded in `se.config.example.json` as
`versionRange`. Preflight rejects incompatible versions before spawning and
prints the exact install/upgrade command.

## Handshake fields

SnakeFlow consumes these additive `system.info` fields when present:

- `system_id`: must match the requested system;
- `port`: must match the discovered registry port;
- `pid`: must match the spawned child process for managed spawns;
- `instance_id`: identifies one SnakeEats boot, used to detect port reuse;
- `protocol_version`: wire-protocol version, independent of `api_version`;
- `version` / `app_version`: SnakeEats package version, checked against `versionRange`;
- `storage_format`: storage format version, surfaced for diagnostics.

`api_version` remains the manifest-schema identifier (`snake-manifest-v1`) and
is **not** the wire-protocol version.

Older SnakeEats builds without the additive fields are accepted in a degraded
compatibility mode; identity checks that require `pid`/`instance_id` then fall
back to the legacy process-evidence path.

## Storage ownership

- `<dataRoot>/se-storage/<systemId>` is owned exclusively by SnakeEats.
- `<dataRoot>/runtime/` is owned exclusively by SnakeFlow and may be cleaned.
- SnakeFlow never writes `.owner.json`, `.spawn.lock`, or token files into
  SnakeEats storage in installed mode.

## Reporting incompatibilities

Include `system.info` output, SnakeFlow version, SnakeEats version, Python
version, OS, and whether the runtime was resolved in `pip` or `dir` mode.
