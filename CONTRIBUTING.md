# Contributing to SnakeFlow

## Development setup

```bash
npm ci
python -m pip install -e "../snakeeats[dev]"  # or use a released snakeeats
npm run dev
```

Node `^20.19.0 || >=22.12.0` and Python `>=3.10` are required.

Useful commands:

```bash
npm run check:boundaries   # dependency-direction gate (must stay green)
npm run test:smoke         # broad smoke/unit suites
npm run test:parity        # dev-server vs standalone-server parity
npm run se:doctor          # diagnose the SnakeEats runtime
npm run build              # frontend dist/
npm run build:server       # bundled standalone server
```

## Architecture rules (do not bypass)

One concern has exactly one owner and one implementation. New capabilities must
replace an old mechanism, not coexist with it.

Allowed dependency direction:

```text
src  ──▶ shared ◀── server ◀── scripts (dev/test only)
```

- `shared/` is isomorphic: no `node:*`, no `process.env`, no `process.platform`.
- `server/` may not import `src/` or `scripts/`.
- `src/` may not import `server/` or `node:*`.
- Runtime code may never import `scripts/`.
- `scripts/` is for development, tests, and operator CLIs only.

The boundary checker starts with a small allowlist of legacy violations. The
allowlist is a ratchet: it may only shrink. Do not add new exceptions.

## Refactor discipline

Use **wrap → switch → delete**:

1. Wrap the existing behavior behind the target interface without changing it.
2. Switch callers to the new interface and prove parity.
3. Delete the old mechanism and its allowlist entry.

Do not introduce a second implementation "for production" or "for pip" next to
the old one. Do not parse human-readable logs when a machine-readable contract
can exist. Do not add per-call `process.platform` branches; extend `server/platform/`.

## Tests

Every behavior change needs a regression test. For boundary changes, also run
`npm run check:boundaries` and `npm run test:parity`. Do not delete failing tests
to make a change pass.

`se-test-helper` injects `RF_ALLOW_INSECURE_TEST=1` and a deterministic
`RF_SESSION_SECRET` into spawned Vite processes so the legacy suite does not
need to bootstrap a session for every request. That flag is **test-only** and
must never be set in production. Security behavior is covered separately by
`npm run test:parity` and by the secure standalone/WS assertions.

## Data safety

Never add automatic deletion of `se-storage/` or workspace documents. Runtime
metadata belongs in `runtime/`; SnakeEats owns `se-storage/`; users own their
workspace.
