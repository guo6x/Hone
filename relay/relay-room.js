const TICK_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const GATEWAY_AWAY_GRACE_MS = 60_000;
const MAX_CLIENTS_PER_SESSION = 10;
const UNAPPROVED_TIMEOUT_MS = 120_000;
const MAX_REGISTER_ATTEMPTS = 10;
const REGISTER_RATE_LIMIT_MS = 60_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PENDING_MESSAGES = 100;
const PAIRING_TTL_MS = 10 * 60_000;

const STORAGE_AWAY_SINCE = "gateway_away_since";
const STORAGE_PENDING = "pending_messages";
const STORAGE_GATEWAY_TOKEN = "gateway_token_hash";
const STORAGE_PAIRING = "pairing_challenge";
const DEVICE_PREFIX = "device:";

function json(data) {
  return JSON.stringify(data);
}

function closeWS(ws, code, reason) {
  try { ws.close(code, reason); } catch (_) {}
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function byteLength(raw) {
  if (typeof raw === "string") return new TextEncoder().encode(raw).byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return MAX_MESSAGE_BYTES + 1;
}

function decodeRaw(raw) {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  return "";
}

function token() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function equalHash(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export class RelayRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.gateways = new Map();
    this.clients = new Map();
    this.pendingMessages = [];
    this.gatewayAway = false;
    this.registerAttempts = new Map();

    const restore = async () => {
      const storage = this.ctx.storage;
      const [pending, awaySince] = await Promise.all([
        storage.get(STORAGE_PENDING),
        storage.get(STORAGE_AWAY_SINCE),
      ]);
      this.pendingMessages = Array.isArray(pending) ? pending.slice(-MAX_PENDING_MESSAGES) : [];
      this.gatewayAway = typeof awaySince === "number";

      const sockets = typeof this.ctx.getWebSockets === "function" ? this.ctx.getWebSockets() : [];
      for (const ws of sockets) {
        const meta = this._attachment(ws);
        if (!meta || meta.version !== 3) continue;
        if (meta.role === "gateway" && validId(meta.gatewayId)) {
          this.gateways.set(meta.gatewayId, {
            ws,
            machineName: meta.machineName || "unknown",
            repo: meta.repo || "",
            branch: meta.branch || "",
            lastHeartbeat: Number(meta.lastHeartbeat) || Date.now(),
          });
        } else if (meta.role === "client" && validId(meta.clientId)) {
          this.clients.set(meta.clientId, {
            ws,
            clientId: meta.clientId,
            deviceId: meta.deviceId || null,
            approved: !!meta.approved,
            connectedAt: Number(meta.connectedAt) || Date.now(),
            lastPong: Number(meta.lastPong) || Date.now(),
          });
        }
      }
      await storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    };

    this.ready = typeof ctx.blockConcurrencyWhile === "function"
      ? ctx.blockConcurrencyWhile(restore)
      : restore();
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.ready;
    if (byteLength(raw) > MAX_MESSAGE_BYTES) {
      closeWS(ws, 4009, "Message too large");
      return;
    }

    let msg;
    try {
      msg = JSON.parse(decodeRaw(raw));
    } catch {
      closeWS(ws, 4000, "Invalid JSON");
      return;
    }
    if (!msg || typeof msg.type !== "string" || msg.type.length > 64) {
      closeWS(ws, 4000, "Invalid message type");
      return;
    }

    switch (msg.type) {
      case "register":
        if (msg.role === "gateway") await this._handleGatewayRegister(ws, msg);
        else if (msg.role === "client") await this._handleClientRegister(ws, msg);
        else closeWS(ws, 4000, "Invalid role");
        break;
      case "heartbeat":
        this._recordGatewayHeartbeat(ws);
        break;
      case "pairing_response":
        await this._handlePairingResponse(ws, msg);
        break;
      case "device_revoke":
        await this._handleDeviceRevoke(ws, msg);
        break;
      case "pong":
        this._recordClientPong(ws);
        break;
      case "ping":
        this._send(ws, { type: "pong", ts: msg.ts });
        break;
      default:
        await this._routeMessage(ws, msg);
        break;
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    await this._removeConnection(ws);
  }

  async webSocketError(ws) {
    await this.ready;
    await this._removeConnection(ws);
  }

  _attachment(ws) {
    try {
      return typeof ws.deserializeAttachment === "function" ? ws.deserializeAttachment() : null;
    } catch (_) {
      return null;
    }
  }

  _attach(ws, metadata) {
    try {
      if (typeof ws.serializeAttachment === "function") ws.serializeAttachment(metadata);
    } catch (_) {}
  }

  _checkRegisterRate(ws) {
    const now = Date.now();
    const previous = this.registerAttempts.get(ws);
    const next = !previous || now - previous.windowStart > REGISTER_RATE_LIMIT_MS
      ? { count: 1, windowStart: now }
      : { count: previous.count + 1, windowStart: previous.windowStart };
    this.registerAttempts.set(ws, next);
    return next.count <= MAX_REGISTER_ATTEMPTS;
  }

  async _authorizeGateway(tokenValue) {
    if (typeof tokenValue !== "string" || tokenValue.length < 32) return false;
    if (this.env.AUTH_TOKEN && tokenValue !== this.env.AUTH_TOKEN) return false;

    const candidate = await hash(tokenValue);
    const existing = await this.ctx.storage.get(STORAGE_GATEWAY_TOKEN);
    if (!existing) {
      // The room name is a 256-bit installation secret. Its first authenticated
      // gateway establishes the credential; subsequent gateways must prove it.
      await this.ctx.storage.put(STORAGE_GATEWAY_TOKEN, candidate);
      return true;
    }
    return equalHash(existing, candidate);
  }

  async _handleGatewayRegister(ws, msg) {
    if (!this._checkRegisterRate(ws) || !(await this._authorizeGateway(msg.token))) {
      closeWS(ws, 4003, "Gateway authentication failed");
      return;
    }
    const gatewayId = validId(msg.machineId) ? msg.machineId : crypto.randomUUID();
    const existing = this.gateways.get(gatewayId);
    if (existing && existing.ws !== ws) closeWS(existing.ws, 4001, "Replaced by newer gateway");

    const gateway = {
      ws,
      machineName: typeof msg.machineName === "string" ? msg.machineName.slice(0, 128) : "unknown",
      repo: typeof msg.repo === "string" ? msg.repo.slice(0, 512) : "",
      branch: typeof msg.branch === "string" ? msg.branch.slice(0, 256) : "",
      lastHeartbeat: Date.now(),
    };
    this.gateways.set(gatewayId, gateway);
    this._attach(ws, { version: 3, role: "gateway", gatewayId, ...gateway, ws: undefined });

    if (
      validId(msg.pairingId)
      && typeof msg.pairingCode === "string"
      && /^\d{6}$/.test(msg.pairingCode)
    ) {
      await this.ctx.storage.put(STORAGE_PAIRING, {
        id: msg.pairingId,
        codeHash: await hash(msg.pairingCode),
        expiresAt: Date.now() + PAIRING_TTL_MS,
      });
    }

    this.gatewayAway = false;
    await this.ctx.storage.delete(STORAGE_AWAY_SINCE);
    this._send(ws, { type: "registered", gatewayId, protocolVersion: 3 });

    const pending = this.pendingMessages.splice(0);
    await this._persistPending();
    for (const queued of pending) this._send(ws, queued);

    for (const [clientId, client] of this.clients) {
      if (!client.approved) {
        this._send(ws, { type: "pairing_request", clientId, deviceId: client.deviceId || undefined });
      }
    }
  }

  async _authenticateDevice(deviceId, deviceToken) {
    if (!validId(deviceId) || typeof deviceToken !== "string" || deviceToken.length < 32) return false;
    const record = await this.ctx.storage.get(DEVICE_PREFIX + deviceId);
    if (!record || typeof record.tokenHash !== "string") return false;
    return equalHash(record.tokenHash, await hash(deviceToken));
  }

  async _verifyPairingChallenge(pairingId, pairingCode) {
    if (!validId(pairingId) || typeof pairingCode !== "string" || !/^\d{6}$/.test(pairingCode)) return false;
    const challenge = await this.ctx.storage.get(STORAGE_PAIRING);
    if (!challenge || challenge.id !== pairingId || challenge.expiresAt < Date.now()) return false;
    return equalHash(challenge.codeHash, await hash(pairingCode));
  }

  async _handleClientRegister(ws, msg) {
    if (!this._checkRegisterRate(ws)) {
      closeWS(ws, 4029, "Too many registration attempts");
      return;
    }

    const hasDeviceCredential = typeof msg.deviceId === "string" || typeof msg.deviceToken === "string";
    const restored = hasDeviceCredential && await this._authenticateDevice(msg.deviceId, msg.deviceToken);
    const pairingValid = !hasDeviceCredential && await this._verifyPairingChallenge(msg.pairingId, msg.pairingCode);
    if (!restored && !pairingValid) {
      closeWS(ws, 4003, "Pairing or device credential is invalid");
      return;
    }

    const clientId = restored ? msg.deviceId : crypto.randomUUID();
    const existing = this.clients.get(clientId);
    if (existing && existing.ws !== ws) closeWS(existing.ws, 4001, "Reconnected from another device session");
    if (!existing && this.clients.size >= MAX_CLIENTS_PER_SESSION) {
      closeWS(ws, 4030, "Session full");
      return;
    }

    const client = {
      ws,
      clientId,
      deviceId: restored ? msg.deviceId : null,
      approved: restored,
      connectedAt: Date.now(),
      lastPong: Date.now(),
    };
    this.clients.set(clientId, client);
    this._attach(ws, {
      version: 3,
      role: "client",
      clientId,
      deviceId: client.deviceId,
      approved: client.approved,
      connectedAt: client.connectedAt,
      lastPong: client.lastPong,
    });

    if (restored) {
      this._send(ws, {
        type: "registered",
        clientId,
        deviceId: client.deviceId,
        gateway: this._gatewaySummary(),
        protocolVersion: 3,
      });
      return;
    }

    this._send(ws, { type: "pairing_required", message: "Waiting for gateway approval" });
    await this._forwardPairingRequest(clientId, client);
  }

  async _forwardPairingRequest(clientId, client) {
    const message = {
      type: "pairing_request",
      clientId,
      deviceId: client.deviceId || undefined,
      pairingId: (await this.ctx.storage.get(STORAGE_PAIRING))?.id,
    };
    const gateway = this._gateway();
    if (gateway) this._send(gateway.ws, message);
    else await this._enqueue(message);
  }

  async _handlePairingResponse(ws, msg) {
    if (!this._gatewayIdForSocket(ws)) {
      closeWS(ws, 4003, "Only the gateway can approve devices");
      return;
    }
    const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
    const client = this.clients.get(clientId);
    if (!client) return;

    if (!msg.approved) {
      this.clients.delete(clientId);
      closeWS(client.ws, 4003, "Gateway denied pairing");
      return;
    }

    const deviceId = validId(client.deviceId) ? client.deviceId : crypto.randomUUID();
    const deviceToken = token();
    await this.ctx.storage.put(DEVICE_PREFIX + deviceId, {
      tokenHash: await hash(deviceToken),
      createdAt: Date.now(),
      lastApprovedAt: Date.now(),
    });

    this.clients.delete(clientId);
    client.clientId = deviceId;
    client.deviceId = deviceId;
    client.approved = true;
    this.clients.set(deviceId, client);
    this._attach(client.ws, {
      version: 3,
      role: "client",
      clientId: deviceId,
      deviceId,
      approved: true,
      connectedAt: client.connectedAt,
      lastPong: client.lastPong,
    });
    this._send(client.ws, {
      type: "registered",
      clientId: deviceId,
      deviceId,
      deviceToken,
      gateway: this._gatewaySummary(),
      protocolVersion: 3,
    });
  }

  async _handleDeviceRevoke(ws, msg) {
    if (!this._gatewayIdForSocket(ws) || !validId(msg.deviceId)) {
      closeWS(ws, 4003, "Only the gateway can revoke devices");
      return;
    }
    await this.ctx.storage.delete(DEVICE_PREFIX + msg.deviceId);
    const client = this.clients.get(msg.deviceId);
    if (client) {
      this.clients.delete(msg.deviceId);
      this._send(client.ws, { type: "device_revoked" });
      closeWS(client.ws, 4003, "Device revoked");
    }
  }

  async _routeMessage(ws, msg) {
    const gatewayId = this._gatewayIdForSocket(ws);
    if (gatewayId) {
      const stamped = { ...msg, from: "gateway" };
      if (msg.target === "client" && validId(msg.clientId)) {
        this._forwardToClient(stamped, msg.clientId);
      } else if (msg.target === "all" || msg.broadcast === true) {
        this._broadcastToClients(stamped);
      } else if (validId(msg.clientId)) {
        this._forwardToClient(stamped, msg.clientId);
      } else {
        this._send(ws, { type: "error", message: "Gateway message requires a target client" });
      }
      return;
    }

    const clientId = this._clientIdForSocket(ws);
    const client = clientId ? this.clients.get(clientId) : null;
    if (!client) return;
    if (!client.approved) {
      this._send(ws, { type: "error", message: "Not approved — wait for gateway pairing approval" });
      return;
    }
    await this._forwardToGateway({ ...msg, from: "client", clientId });
  }

  _gatewayIdForSocket(ws) {
    for (const [gatewayId, gateway] of this.gateways) {
      if (gateway.ws === ws) return gatewayId;
    }
    return null;
  }

  _clientIdForSocket(ws) {
    for (const [clientId, client] of this.clients) {
      if (client.ws === ws) return clientId;
    }
    return null;
  }

  _gateway() {
    return this.gateways.values().next().value || null;
  }

  _gatewaySummary() {
    const gateway = this._gateway();
    if (!gateway) return null;
    const gatewayId = this._gatewayIdForSocket(gateway.ws);
    return { machineId: gatewayId, machineName: gateway.machineName, repo: gateway.repo, branch: gateway.branch };
  }

  async _forwardToGateway(msg) {
    const gateway = this._gateway();
    if (!gateway || this.gatewayAway) {
      await this._enqueue(msg);
      return;
    }
    this._send(gateway.ws, msg);
  }

  _forwardToClient(msg, clientId) {
    const client = this.clients.get(clientId);
    if (client?.approved) this._send(client.ws, msg);
  }

  _broadcastToClients(msg) {
    for (const client of this.clients.values()) {
      if (client.approved) this._send(client.ws, msg);
    }
  }

  async _enqueue(message) {
    if (this.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      this.pendingMessages.shift();
    }
    this.pendingMessages.push(message);
    await this._persistPending();
  }

  async _persistPending() {
    await this.ctx.storage.put(STORAGE_PENDING, this.pendingMessages);
  }

  _recordGatewayHeartbeat(ws) {
    const gatewayId = this._gatewayIdForSocket(ws);
    if (!gatewayId) return;
    const gateway = this.gateways.get(gatewayId);
    gateway.lastHeartbeat = Date.now();
    this._attach(ws, {
      version: 3,
      role: "gateway",
      gatewayId,
      machineName: gateway.machineName,
      repo: gateway.repo,
      branch: gateway.branch,
      lastHeartbeat: gateway.lastHeartbeat,
    });
  }

  _recordClientPong(ws) {
    const clientId = this._clientIdForSocket(ws);
    const client = clientId ? this.clients.get(clientId) : null;
    if (!client) return;
    client.lastPong = Date.now();
  }

  async _removeConnection(ws) {
    const gatewayId = this._gatewayIdForSocket(ws);
    if (gatewayId) {
      this.gateways.delete(gatewayId);
      if (this.gateways.size === 0) await this._onGatewayDisconnect();
      return;
    }
    const clientId = this._clientIdForSocket(ws);
    if (clientId) this.clients.delete(clientId);
    this.registerAttempts.delete(ws);
  }

  async _onGatewayDisconnect() {
    this.gatewayAway = true;
    await this.ctx.storage.put(STORAGE_AWAY_SINCE, Date.now());
    this._broadcastToClients({
      type: "gateway_disconnected",
      message: "Gateway is offline. Messages will be queued briefly.",
    });
  }

  async alarm() {
    await this.ready;
    await this._onTick();
    await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
  }

  async _onTick() {
    const now = Date.now();
    for (const [gatewayId, gateway] of this.gateways) {
      if (now - gateway.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.gateways.delete(gatewayId);
        closeWS(gateway.ws, 4001, "Heartbeat timeout");
      } else {
        this._send(gateway.ws, { type: "ping" });
      }
    }
    if (this.gateways.size === 0 && !this.gatewayAway) await this._onGatewayDisconnect();

    for (const [clientId, client] of this.clients) {
      if (!client.approved && now - client.connectedAt > UNAPPROVED_TIMEOUT_MS) {
        this.clients.delete(clientId);
        closeWS(client.ws, 4003, "Pairing timed out");
      } else {
        this._send(client.ws, { type: "ping" });
      }
    }

    const awaySince = await this.ctx.storage.get(STORAGE_AWAY_SINCE);
    if (this.gateways.size === 0 && typeof awaySince === "number" && now - awaySince > GATEWAY_AWAY_GRACE_MS) {
      this.pendingMessages = [];
      await this._persistPending();
    }
  }

  _send(ws, msg) {
    try {
      ws.send(json(msg));
    } catch (_) {}
  }
}
