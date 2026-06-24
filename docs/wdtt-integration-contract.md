# WDTT panel integration contract (draft)

This document is a design contract for a future change in `wdtt-control-panel`; it adds no cross-project dependency yet.

## Agent-local interface

The agent receives a central command and calls a local typed interface. The interface accepts only:

```text
createUser(input)
updateUser(sourceUserId, patch, expectedRevision)
deleteUser(sourceUserId)
readUser(sourceUserId)
readNodeSnapshot(cursor)
```

`input`/`patch` consist only of WDTT user properties: local user ID, display/name fields accepted by WDTT, user label, devices/public keys through the established WDTT flow, expiry, traffic limits and enabled/access state. The exact schema is versioned alongside the panel adapter. An operation must reject unknown fields.

The snapshot returns the opaque local user ID, user label, device summaries, expiry, traffic counters, enabled state and an `online` indicator derived from a recent WireGuard handshake. It must not include private keys, configuration files, Xray/WARP settings, tokens, command output or raw host metrics.

## Agent responsibilities

- Authenticate outbound with its enrolled mTLS identity and include `wdtt-fleet/v1` version metadata.
- Save command IDs and final receipts before acknowledging completion, so retries are safe across restarts.
- Enforce `expires_at`, payload schema and target node identity before calling the local interface.
- Serialize conflicting commands for the same source user.
- Send a bounded heartbeat and snapshot; redact all errors to documented agent error codes.

## Compatibility

The adapter is opt-in and disabled by default. It may run only when the installed WDTT version advertises a compatible local interface version. The fleet agent reports both its protocol version and panel adapter version, letting the center show upgrade-required instead of guessing.
