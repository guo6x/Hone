# Hone Relay Protocol v1

All messages are JSON. Transport is WebSocket (binary not used).

## Connection Roles

| Role | Description |
|------|-------------|
| `gateway` | Hone Gateway daemon (L1) |
| `client` | Mobile browser / Desktop / CLI operator |
| `relay` | Cloudflare Worker (this server) |

## Message Envelope

Every message:
```json
{
  "type": "<message_type>",
  "from": "<role>",
  "sessionId": "<uuid>",
  "ts": "<ISO timestamp>",
  "payload": { ... }
}
```

## Connection Flow

### 1. Gateway connects
```
G → R: { type: "register", role: "gateway", machineId: "<id>", machineName: "...", repo: "...", branch: "..." }
R → G: { type: "registered", gatewayId: "<id>" }
```
Gateway stays connected. Relay tracks this gateway as available.

### 2. Client connects
```
C → R: { type: "register", role: "client", pairingCode: "<code>" }
R → C: { type: "pairing_required", message: "Waiting for gateway approval" }
R → G: { type: "pairing_request", clientId: "<id>", pairingCode: "<code>" }
G approves or denies:
G → R: { type: "pairing_response", clientId: "<id>", approved: true|false }
R → C: { type: "registered", clientId: "<id>" }  (if approved)
```

### 3. Client sends message to Gateway
```
C → R: { type: "message", target: "gateway", payload: { text: "帮我修bug" } }
R → G: { type: "message", from: "client", clientId: "<id>", payload: { text: "帮我修bug" } }
```

### 4. Gateway responds
```
G → R: { type: "message", target: "client", clientId: "<id>", payload: { text: "好的，正在处理..." } }
R → C: { type: "message", from: "gateway", payload: { text: "好的，正在处理..." } }
```

### 5. Gateway executes task (dispatches to CLI)
```
G → R: { type: "task_started", taskId: "<id>", description: "Fixing auth bug" }
G → R: { type: "task_progress", taskId: "<id>", status: "reading file..." }
G → R: { type: "task_complete", taskId: "<id>", result: "Fixed. PR created." }
```
Relay broadcasts to all connected clients.

### 6. Gateway heartbeat
Every 30s:
```
G → R: { type: "heartbeat", gatewayId: "<id>" }
```

## Schedule Messages

### Client creates schedule
```
C → R: { type: "schedule_create", payload: { text: "每天早上9点检查PR", trigger: "cron", cron: "0 9 * * *", task: "..." } }
R → G: forwarded
G → R: { type: "schedule_created", scheduleId: "<id>" }
```

### Gateway triggers schedule
```
G → R: { type: "schedule_triggered", scheduleId: "<id>", task: "检查PR" }
R → C: forwarded
```

## Error Handling

- Unknown message type: silently ignore
- Invalid JSON: close connection with code 4000
- Auth failure: close with code 4003
- Gateway disconnected: relay notifies all clients, holds messages for 60s
