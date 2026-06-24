# WDTT Fleet Manager

Private central control plane for multiple [WDTT Control Panel](https://github.com/lebrite/wdtt-control-panel) nodes.

It manages only the narrow WDTT/WireGuard user surface: users, their labels, devices, expiry, traffic and online status. It deliberately does **not** expose a shell, generic file access, Xray, WARP or full-server administration.

## Current stage

This repository contains the first safe foundation: protocol/domain primitives, an in-memory development API, tests, and the architecture contract for the later node agent. It now includes one-use, 15-minute enrollment grants, a node-bound development credential, versioned heartbeat, credential rotation and immediate revocation. It is not yet suitable for controlling production nodes: persistent storage, mTLS termination, audit persistence, an operator UI and the WDTT agent still need to be implemented.

## Local checks

Requires Node.js 22 or newer.

```powershell
npm test
npm run check
```

See [the architecture](docs/architecture.md) and [WDTT integration contract](docs/wdtt-integration-contract.md).
