// Hone Relay v2 — Cloudflare Worker (Durable Objects)
// WebSocket relay between Hone Gateway daemon and client devices.
// Protocol: see PROTOCOL.md
//
// Uses DO Alarm API instead of setInterval/setTimeout (required for
// correctness across eviction boundaries in production).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS        = 15_000;   // alarm fires every 15s
const HEARTBEAT_TIMEOUT_MS    = 90_000;   // consider gateway dead after this
const GATEWAY_AWAY_GRACE_MS   = 60_000;   // hold pending messages for this long
const MAX_CLIENTS_PER_SESSION = 10;       // max connected clients
const UNAPPROVED_TIMEOUT_MS   = 120_000;  // drop unapproved clients after this
const REGISTER_RATE_LIMIT_MS  = 60_000;   // rate-limit register attempts (1 per window)
const MAX_REGISTER_ATTEMPTS   = 10;       // max register attempts per window per IP

// Storage keys for alarm state
const STORAGE_AWAY_SINCE       = 'gateway_away_since';
const STORAGE_REGISTER_TRACKER = 'register_tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data) {
  return JSON.stringify(data);
}

/** Close a WebSocket with a specific code and reason, swallowing errors. */
function closeWS(ws, code, reason) {
  try { ws.close(code, reason); } catch (_) { /* already closed */ }
}

// ---------------------------------------------------------------------------
// Durable Object: RelayRoom
// ---------------------------------------------------------------------------

export class RelayRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // Connected gateways: gatewayId -> { ws, machineName, lastHeartbeat }
    this.gateways = new Map();

    // Connected clients: clientId -> { ws, pairingCode, approved }
    this.clients = new Map();

    // Pending messages held while gateway is away.
    this.pendingMessages = [];

    // Is the gateway currently away?
    this.gatewayAway = false;

    // Start the heartbeat/ping loop via Alarm API.
    this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
  }

  // -----------------------------------------------------------------------
  // DO Alarm handler — fires every TICK_INTERVAL_MS
  // -----------------------------------------------------------------------

  async alarm() {
    this._onTick();
    this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
  }

  // -----------------------------------------------------------------------
  // HTTP entry point (called once per WebSocket upgrade)
  // -----------------------------------------------------------------------

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -----------------------------------------------------------------------
  // WebSocket message handler
  // -----------------------------------------------------------------------

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      closeWS(ws, 4000, "Invalid JSON");
      return;
    }

    const type = msg.type;
    if (!type) {
      closeWS(ws, 4000, "Missing message type");
      return;
    }

    switch (type) {

      // ----- Registration ------------------------------------------------

      case "register": {
        if (msg.role === "gateway") {
          this._handleGatewayRegister(ws, msg);
        } else if (msg.role === "client") {
          this._handleClientRegister(ws, msg);
        } else {
          closeWS(ws, 4000, 'Invalid role — must be "gateway" or "client"');
        }
        break;
      }

      // ----- Gateway heartbeat -------------------------------------------

      case "heartbeat": {
        for (const [, gw] of this.gateways) {
          if (gw.ws === ws) {
            gw.lastHeartbeat = Date.now();
            break;
          }
        }
        break;
      }

      // ----- Client sends a message for the gateway ----------------------

      case "message": {
        this._handleMessage(ws, msg);
        break;
      }

      // ----- Pairing response from gateway -------------------------------

      case "pairing_response": {
        this._handlePairingResponse(ws, msg);
        break;
      }

      // ----- Task lifecycle (gateway → broadcast to all clients) ---------

      case "task_started":
      case "task_progress":
      case "task_complete": {
        this._broadcastToClients(msg);
        break;
      }

      // ----- Schedule messages -------------------------------------------

      case "schedule_create": {
        this._forwardToGateway(msg);
        break;
      }

      case "schedule_list": {
        // If the message includes schedules[] data, it's a response from
        // the gateway — broadcast to approved clients.
        if (Array.isArray(msg.schedules)) {
          this._broadcastToClients(msg);
        } else {
          // Request from a client — forward to gateway.
          this._forwardToGateway(msg);
        }
        break;
      }

      case "schedule_enable":
      case "schedule_disable":
      case "schedule_delete": {
        this._forwardToGateway(msg);
        break;
      }

      case "schedule_created": {
        // Gateway created a schedule — broadcast to all approved clients
        this._broadcastToClients(msg);
        break;
      }

      case "schedule_triggered": {
        this._forwardToClient(msg, msg.clientId);
        this._broadcastToClients(msg);
        break;
      }

      // ----- Canvas streaming --------------------------------------------

      case "canvas_update": {
        this._broadcastToClients(msg);
        break;
      }

      // ----- Dispatch to CLI (desktop → gateway → CLI) ------------------

      case "dispatch": {
        this._forwardToGateway(msg);
        break;
      }

      // ----- Internal ping / pong ----------------------------------------

      case "pong": {
        // silently consumed
        break;
      }

      // ----- Unknown type ------------------------------------------------

      default: {
        // Silently ignore unknown message types.
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket close handler
  // -----------------------------------------------------------------------

  async webSocketClose(ws, code, reason, wasClean) {
    this._removeConnection(ws);
  }

  // -----------------------------------------------------------------------
  // WebSocket error handler
  // -----------------------------------------------------------------------

  async webSocketError(ws, error) {
    this._removeConnection(ws);
  }

  // -----------------------------------------------------------------------
  // Private: Registration handlers
  // -----------------------------------------------------------------------

  _handleGatewayRegister(ws, msg) {
    // Auth check: if AUTH_TOKEN is configured, require it
    if (this.env.AUTH_TOKEN) {
      if (!msg.token || msg.token !== this.env.AUTH_TOKEN) {
        closeWS(ws, 4003, "Gateway auth failed — invalid or missing token");
        return;
      }
    }

    // Rate-limit register attempts (prevent brute-force)
    if (!this._checkRegisterRate()) {
      closeWS(ws, 4029, "Too many register attempts — try again later");
      return;
    }

    const gatewayId = msg.machineId || crypto.randomUUID();

    // If a gateway with this ID already exists, close the old one.
    const existing = this.gateways.get(gatewayId);
    if (existing) {
      closeWS(existing.ws, 4001, "Replaced by new connection");
      this.gateways.delete(gatewayId);
    }

    this.gateways.set(gatewayId, {
      ws,
      machineName: msg.machineName || "unknown",
      repo: msg.repo || "",
      branch: msg.branch || "",
      lastHeartbeat: Date.now(),
    });

    this._send(ws, {
      type: "registered",
      gatewayId,
    });

    // If the gateway was previously away, replay pending messages.
    if (this.gatewayAway) {
      this.gatewayAway = false;
      const pending = this.pendingMessages.splice(0);
      for (const queued of pending) {
        this._send(ws, queued);
      }
    }

    // Forward queued pairing requests to the new gateway.
    for (const [cid, cl] of this.clients) {
      if (!cl.approved && cl.pairingCode !== undefined) {
        this._send(ws, {
          type: "pairing_request",
          clientId: cid,
          pairingCode: cl.pairingCode,
        });
      }
    }
  }

  _handleClientRegister(ws, msg) {
    // Optional: require the same AUTH_TOKEN for clients too
    if (this.env.AUTH_TOKEN) {
      if (!msg.token || msg.token !== this.env.AUTH_TOKEN) {
        closeWS(ws, 4003, "Client auth failed — invalid or missing token");
        return;
      }
    }

    // Rate-limit register attempts
    if (!this._checkRegisterRate()) {
      closeWS(ws, 4029, "Too many register attempts — try again later");
      return;
    }

    // Enforce max clients limit
    if (this.clients.size >= MAX_CLIENTS_PER_SESSION) {
      closeWS(ws, 4030, "Session full — too many connected clients");
      return;
    }

    // Validate pairing code format
    const pairingCode = (msg.pairingCode || "").trim();
    if (!pairingCode || pairingCode.length < 4 || pairingCode.length > 32) {
      closeWS(ws, 4000, "Invalid pairing code format");
      return;
    }

    const clientId = crypto.randomUUID();
    const now = Date.now();

    this.clients.set(clientId, {
      ws,
      pairingCode,
      approved: false,
      connectedAt: now,
    });

    this._send(ws, {
      type: "pairing_required",
      message: "Waiting for gateway approval",
    });

    let forwarded = false;
    for (const [, gw] of this.gateways) {
      this._send(gw.ws, {
        type: "pairing_request",
        clientId,
        pairingCode,
      });
      forwarded = true;
    }

    if (!forwarded) {
      this.pendingMessages.push({
        type: "pairing_request",
        clientId,
        pairingCode,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Private: Pairing response
  // -----------------------------------------------------------------------

  _handlePairingResponse(ws, msg) {
    const clientId = msg.clientId;
    if (!clientId) return;

    const cl = this.clients.get(clientId);
    if (!cl) return;

    if (msg.approved) {
      cl.approved = true;
      this._send(cl.ws, {
        type: "registered",
        clientId,
      });
    } else {
      closeWS(cl.ws, 4003, "Gateway denied pairing");
      this.clients.delete(clientId);
    }
  }

  // -----------------------------------------------------------------------
  // Private: Message forwarding
  // -----------------------------------------------------------------------

  _handleMessage(ws, msg) {
    const target = msg.target;
    const payload = msg.payload || {};

    if (target === "gateway") {
      let senderId = null;
      let approved = false;
      for (const [cid, cl] of this.clients) {
        if (cl.ws === ws) { senderId = cid; approved = cl.approved; break; }
      }
      if (!senderId) return;
      if (!approved) {
        this._send(ws, { type: "error", message: "Not approved — wait for gateway pairing approval" });
        return;
      }

      this._forwardToGateway({
        type: "message",
        from: "client",
        clientId: senderId,
        payload,
      });
    } else if (target === "client") {
      const clientId = msg.clientId;
      if (!clientId) return;

      this._forwardToClient({
        type: "message",
        from: "gateway",
        payload,
      }, clientId);
    }
  }

  _forwardToGateway(msg) {
    if (this.gateways.size === 0 || this.gatewayAway) {
      this.pendingMessages.push(msg);
      return;
    }
    for (const [, gw] of this.gateways) {
      this._send(gw.ws, msg);
    }
  }

  _forwardToClient(msg, clientId) {
    const cl = this.clients.get(clientId);
    if (cl) this._send(cl.ws, msg);
  }

  _broadcastToClients(msg) {
    for (const [, cl] of this.clients) {
      if (cl.approved) this._send(cl.ws, msg);
    }
  }

  // -----------------------------------------------------------------------
  // Private: Connection lifecycle
  // -----------------------------------------------------------------------

  _removeConnection(ws) {
    for (const [gid, gw] of this.gateways) {
      if (gw.ws === ws) {
        this.gateways.delete(gid);
        this._onGatewayDisconnect();
        return;
      }
    }
    for (const [cid, cl] of this.clients) {
      if (cl.ws === ws) {
        this.clients.delete(cid);
        return;
      }
    }
  }

  _onGatewayDisconnect() {
    if (this.gateways.size > 0) return;

    this.gatewayAway = true;
    this.ctx.storage.put(STORAGE_AWAY_SINCE, Date.now());

    for (const [, cl] of this.clients) {
      if (cl.approved) {
        this._send(cl.ws, {
          type: "gateway_disconnected",
          message: "Gateway is offline. Messages will be queued for 60s.",
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: Periodic tick (heartbeat + ping + cleanup)
  // -----------------------------------------------------------------------

  _onTick() {
    const now = Date.now();

    // 1. Check gateway heartbeats — remove stale ones.
    for (const [gid, gw] of this.gateways) {
      if (now - gw.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        closeWS(gw.ws, 4001, "Heartbeat timeout");
        this.gateways.delete(gid);
        this._onGatewayDisconnect();
      }
    }

    // 2. Expire unapproved clients (stuck waiting for gateway approval).
    for (const [cid, cl] of this.clients) {
      if (!cl.approved && (now - cl.connectedAt) > UNAPPROVED_TIMEOUT_MS) {
        closeWS(cl.ws, 4003, "Pairing timed out — gateway did not respond");
        this.clients.delete(cid);
      }
    }

    // 3. Clear pending messages if gateway has been away too long.
    if (this.gatewayAway && this.gateways.size === 0) {
      this.ctx.storage.get(STORAGE_AWAY_SINCE).then(awaySince => {
        if (awaySince && (now - awaySince) > GATEWAY_AWAY_GRACE_MS) {
          this.pendingMessages = [];
        }
      }).catch(() => {});
    }

    // 4. Send ping to all connections to detect broken TCP links.
    for (const [, gw] of this.gateways) {
      this._send(gw.ws, { type: "ping" });
    }
    for (const [, cl] of this.clients) {
      this._send(cl.ws, { type: "ping" });
    }
  }

  // -----------------------------------------------------------------------
  // Private: Rate limiting for register attempts
  // -----------------------------------------------------------------------

  _checkRegisterRate() {
    const now = Date.now();
    const key = STORAGE_REGISTER_TRACKER;

    // Use a simple in-memory window because DO storage is async.
    // We track: { count, windowStart }
    const tracker = this._registerTracker || { count: 0, windowStart: now };
    if (now - tracker.windowStart > REGISTER_RATE_LIMIT_MS) {
      // New window
      tracker.count = 1;
      tracker.windowStart = now;
      this._registerTracker = tracker;
      return true;
    }

    tracker.count++;
    this._registerTracker = tracker;

    if (tracker.count > MAX_REGISTER_ATTEMPTS) {
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Private: Safe send
  // -----------------------------------------------------------------------

  _send(ws, msg) {
    try {
      ws.send(json(msg));
    } catch (_) {
      // Connection probably dead — cleaned up by close/error handler.
    }
  }
}

// ---------------------------------------------------------------------------
// Static assets (served directly from the Worker)
// ---------------------------------------------------------------------------

const ASSETS = {
  // Service worker script
  "/sw.js": {
    type: "application/javascript;charset=utf-8",
    body: `// Hone PWA Service Worker
const CACHE='hone-v1';self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/manifest.json'])));self.skipWaiting()});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim()});self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{if(r&&r.status===200&&r.type==='basic'){const clone=r.clone();caches.open(CACHE).then(c=>c.put(e.request,clone))}return r})))})`,
  },

  // PWA manifest
  "/manifest.json": {
    type: "application/json",
    body: JSON.stringify({
      name: "Hone",
      short_name: "Hone",
      description: "Mobile client for Hone AI gateway",
      start_url: "/",
      display: "standalone",
      orientation: "portrait",
      theme_color: "#0C0E12",
      background_color: "#0C0E12",
      icons: [
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
      ]
    }),
  },

  // Favicon SVG (inline, works in all modern browsers)
  "/favicon.svg": {
    type: "image/svg+xml",
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#D4A853"/><stop offset="100%" stop-color="#A07830"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="#0C0E12"/><path d="M6,22 L26,22 L28,28 L4,28 Z" fill="url(#g)"/><circle cx="20" cy="15" r="1.5" fill="#F0D68A"/></svg>`,
  },
};

// ---------------------------------------------------------------------------
// Static PWA client HTML (served at /)
// ---------------------------------------------------------------------------

// Inlined from client.html — minified to fit Worker size budget
function serveClientHTML() {
  return new Response(CLIENT_HTML, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

const CLIENT_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#0C0E12">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Hone">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>Hone</title>
<style>
:root{--bg:#0C0E12;--surface:#13161C;--surfaceRaised:#1A1E26;--surfaceOverlay:#222733;--text:#E4E8F0;--muted:#6B7285;--border:#252A36;--accent:#D4A853;--accentHover:#E0B963;--accentMuted:#24201A;--success:#2ECC80;--successMuted:#162720;--danger:#F45858;--dangerMuted:#241818;--codeBg:#0F131A;--scrim:rgba(0,0,0,0.65);--radius:12px;--radius-sm:8px;--radius-xs:6px;--safe-top:env(safe-area-inset-top);--safe-bottom:env(safe-area-inset-bottom)}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;width:100%;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;background:var(--bg);color:var(--text);overflow:hidden;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
::selection{background:var(--accent);color:var(--bg)}
#connect-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;gap:16px;padding-top:calc(24px + var(--safe-top))}
#connect-screen.hidden{display:none}
.logo-block{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:20px}
.logo-icon{width:64px;height:64px;border-radius:18px;background:linear-gradient(135deg,#D4A853,#A07830);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(212,168,83,0.25)}
.logo-text{font-size:24px;font-weight:800;letter-spacing:2px;background:linear-gradient(135deg,#D4A853,#E8C97A);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.logo-sub{font-size:12px;color:var(--muted)}
.field{width:100%;max-width:360px;display:flex;flex-direction:column;gap:4px}
.field label{font-size:12px;color:var(--muted);font-weight:500;padding-left:2px;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:13px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:15px;outline:none;font-family:inherit;transition:border-color .2s;-webkit-user-select:text;user-select:text}
.field input:focus{border-color:var(--accent)}
.field input::placeholder{color:#3a3f4a}
.btn-primary{width:100%;max-width:360px;padding:14px;border:none;border-radius:var(--radius-sm);background:linear-gradient(135deg,#D4A853,#B89040);color:#0C0E12;font-size:16px;font-weight:700;cursor:pointer;transition:all .15s;margin-top:4px;letter-spacing:.5px}
.btn-primary:active{transform:scale(.98);opacity:.9}
.btn-primary:disabled{background:#3a3f4a;color:#6B7285;cursor:not-allowed;transform:none;opacity:1}
#connect-status{font-size:13px;min-height:20px;transition:color .2s}
#connect-status.connected{color:var(--success)}
#connect-status.error{color:var(--danger)}
#main-screen{display:none;flex-direction:column;height:100%}
#main-screen.active{display:flex}
#topbar{display:flex;align-items:center;padding:10px 14px;gap:10px;background:var(--surfaceRaised);border-bottom:1px solid var(--border);flex-shrink:0;padding-top:calc(10px + var(--safe-top))}
#topbar .logo-sm{font-size:16px;font-weight:700;background:linear-gradient(135deg,#D4A853,#E0B963);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
#topbar .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--success);transition:background .3s}
#topbar .dot.offline{background:var(--danger)}
#topbar .machine{flex:1;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:5px 10px;border-radius:var(--radius-xs);font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;font-family:inherit}
.topbar-btn:active{background:var(--surfaceOverlay);color:var(--text)}
#offline-banner{display:none;background:var(--dangerMuted);color:var(--danger);text-align:center;padding:6px;font-size:12px;flex-shrink:0;font-weight:500}
#offline-banner.show{display:block}
#messages{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}
#messages .spacer{flex:1;min-height:4px}
.msg{max-width:85%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.55;word-break:break-word;animation:msgIn .25s ease-out}
@keyframes msgIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.msg.gateway{align-self:flex-start;background:var(--surfaceRaised);color:var(--text);border-bottom-left-radius:4px}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,#D4A853,#B89040);color:#0C0E12;border-bottom-right-radius:4px;font-weight:500}
.msg .time{display:block;font-size:10px;margin-top:4px;opacity:.6;font-weight:400}
.sys{font-size:11px;color:var(--muted);text-align:center;padding:2px 8px;animation:msgIn .2s ease-out;max-width:90%;align-self:center}
.sys .label{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;margin-right:4px;letter-spacing:.3px;background:var(--accentMuted);color:var(--accent)}
.sys .label.completed{background:var(--successMuted);color:var(--success)}
.sys .label.error{background:var(--dangerMuted);color:var(--danger)}
.typing{align-self:flex-start;padding:10px 14px;display:flex;gap:4px;align-items:center}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:bounce .6s infinite alternate}
.typing span:nth-child(2){animation-delay:.15s}
.typing span:nth-child(3){animation-delay:.3s}
@keyframes bounce{from{opacity:.3;transform:translateY(0)}to{opacity:1;transform:translateY(-4px)}}
#input-bar{display:flex;gap:8px;padding:10px 14px;background:var(--surfaceRaised);border-top:1px solid var(--border);flex-shrink:0;padding-bottom:calc(10px + var(--safe-bottom))}
#input-bar input{flex:1;padding:11px 16px;border-radius:22px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:15px;outline:none;font-family:inherit;transition:border-color .2s;-webkit-user-select:text;user-select:text}
#input-bar input:focus{border-color:var(--accent)}
#input-bar input::placeholder{color:#3a3f4a}
#btn-send{width:42px;height:42px;border-radius:50%;flex-shrink:0;border:none;background:var(--accent);color:#0C0E12;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s,transform .1s}
#btn-send:active{transform:scale(.9)}
#btn-send:disabled{background:#3a3f4a;color:#6B7285;cursor:not-allowed;transform:none}
#schedule-overlay{display:none;position:fixed;inset:0;z-index:100;background:var(--scrim);justify-content:center;align-items:flex-end}
#schedule-overlay.active{display:flex}
#schedule-panel{width:100%;max-width:500px;max-height:80vh;background:var(--surfaceRaised);border-radius:16px 16px 0 0;padding:20px 18px;display:flex;flex-direction:column;gap:14px;animation:slideUp .25s ease-out;padding-bottom:calc(20px + var(--safe-bottom))}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
#schedule-panel h2{font-size:17px;font-weight:700;text-align:center;color:var(--text)}
#schedule-panel .row{display:flex;gap:8px}
#schedule-panel .row input{flex:1;padding:11px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px;outline:none;font-family:inherit;-webkit-user-select:text;user-select:text}
#schedule-panel .row input:focus{border-color:var(--accent)}
#schedule-panel .btn-sm{padding:11px 16px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#0C0E12;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit}
#schedule-panel .btn-sm:active{opacity:.8}
#schedule-panel .close-btn{align-self:center;background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:8px 16px;font-family:inherit}
#schedule-list{list-style:none;overflow-y:auto;max-height:260px;display:flex;flex-direction:column;gap:6px}
#schedule-list li{display:flex;align-items:center;gap:10px;background:var(--surface);border-radius:var(--radius-xs);padding:10px 12px;font-size:13px}
#schedule-list li .text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#schedule-list li .toggle{width:40px;height:24px;border-radius:12px;flex-shrink:0;background:var(--border);position:relative;cursor:pointer;transition:background .2s}
#schedule-list li .toggle.on{background:var(--accent)}
#schedule-list li .toggle::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s}
#schedule-list li .toggle.on::after{transform:translateX(16px)}
#schedule-list li .del{background:none;border:none;color:var(--danger);font-size:20px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0}
#quick-actions{display:flex;gap:6px;padding:8px 14px;overflow-x:auto;flex-shrink:0;-webkit-overflow-scrolling:touch}
#quick-actions.hidden{display:none}
.quick-chip{flex-shrink:0;padding:6px 14px;border-radius:16px;background:var(--surface);border:1px solid var(--border);color:var(--muted);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:all .15s}
.quick-chip:active{background:var(--accentMuted);border-color:var(--accent);color:var(--accent)}
#install-banner{display:none;position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--surfaceRaised);border-top:1px solid var(--accent);padding:12px 16px;padding-bottom:calc(12px + var(--safe-bottom));flex-direction:row;align-items:center;gap:12px}
#install-banner.show{display:flex}
#install-banner .text{flex:1;font-size:13px}
#install-banner .text strong{color:var(--accent)}
#install-banner button{padding:8px 18px;border-radius:var(--radius-xs);border:none;background:var(--accent);color:#0C0E12;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit}
#install-banner .dismiss{background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;padding:4px}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:300;padding:10px 20px;border-radius:20px;background:var(--dangerMuted);color:var(--danger);font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;pointer-events:none}
#toast.show{opacity:1}
</style>
</head>
<body>

<div id="connect-screen">
  <div class="logo-block">
    <div class="logo-icon"><svg viewBox="0 0 32 32"><path d="M6,26 L6,22 L26,22 L26,26 Z" fill="#0C0E12" opacity=".8"/><path d="M10,10 L22,10 L24,22 L8,22 Z" fill="#0C0E12" opacity=".3"/><circle cx="19" cy="11" r="1" fill="#0C0E12" opacity=".6"/></svg></div>
    <div class="logo-text">HONE</div>
    <div class="logo-sub">Mobile Client</div>
  </div>
  <div class="field">
    <label for="rurl">Relay</label>
    <input id="rurl" type="text" placeholder="wss://your-relay.workers.dev" autocomplete="url" enterkeyhint="next">
  </div>
  <div class="field">
    <label for="pcode">Pairing Code</label>
    <input id="pcode" type="text" placeholder="6-digit code" maxlength="6" autocomplete="off" inputmode="numeric" pattern="[0-9]*" enterkeyhint="go">
  </div>
  <button class="btn-primary" id="btn-connect" onclick="connect()">Connect</button>
  <div id="connect-status">Not connected</div>
</div>

<div id="main-screen">
  <div id="topbar">
    <span class="logo-sm">HONE</span>
    <span class="dot" id="status-dot"></span>
    <span class="machine" id="machine-name"></span>
    <button class="topbar-btn" onclick="showSchedule()">Schedules</button>
    <button class="topbar-btn" onclick="disconnect()">Leave</button>
  </div>
  <div id="offline-banner">Gateway offline</div>
  <div id="messages"><div class="spacer"></div></div>
  <div id="quick-actions" class="hidden">
    <button class="quick-chip" onclick="qa('git status')">git status</button>
    <button class="quick-chip" onclick="qa('Run the tests')">Run tests</button>
    <button class="quick-chip" onclick="qa('Check recent PRs')">Recent PRs</button>
  </div>
  <div id="input-bar">
    <input id="msg-input" type="text" placeholder="Message..." autocomplete="off" enterkeyhint="send">
    <button id="btn-send" onclick="sendMessage()" aria-label="Send"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
  </div>
</div>

<div id="schedule-overlay" onclick="if(event.target===this)hideSchedule()">
  <div id="schedule-panel">
    <h2>Schedules</h2>
    <div class="row">
      <input id="sched-input" type="text" placeholder="e.g. Check PRs every morning at 9" autocomplete="off">
      <button class="btn-sm" onclick="createSchedule()">Create</button>
    </div>
    <ul id="schedule-list"></ul>
    <button class="close-btn" onclick="hideSchedule()">Close</button>
  </div>
</div>

<div id="install-banner"><span class="text"><strong>Hone</strong> - install to home screen</span><button onclick="installPWA()">Install</button><button class="dismiss" onclick="dismissInstall()">&times;</button></div>
<div id="toast"></div>

<script>
(function(){
var S={ws:null,connected:false,registered:false,clientId:null,gatewayInfo:null,lastHb:0,reconTimer:null,reconDelay:1e3,hbTimer:null,schedules:[],lang:navigator.language.startsWith('zh')?'zh':'en'};
var T={connecting:{zh:'连接中...',en:'Connecting...'},connected:{zh:'已连接',en:'Connected'},disconnected:{zh:'已断开',en:'Disconnected'},reconnecting:{zh:'重新连接中...',en:'Reconnecting...'},needUrl:{zh:'请输入中继地址',en:'Enter relay URL'},needCode:{zh:'请输入配对码',en:'Enter pairing code'},codeDigits:{zh:'配对码必须为6位数字',en:'Code must be 6 digits'},pairFailed:{zh:'配对失败',en:'Pairing failed'},badFormat:{zh:'消息格式错误',en:'Bad message format'},connError:{zh:'无法创建连接',en:'Cannot connect'},waiting:{zh:'等待网关批准...',en:'Waiting...'},ts:{zh:'任务开始',en:'Task started'},td:{zh:'已完成',en:'Completed'},te:{zh:'错误',en:'Error'},sc:{zh:'定时任务已创建',en:'Schedule created'},st:{zh:'定时任务触发: ',en:'Schedule triggered: '},noSch:{zh:'暂无定时任务',en:'No schedules'},gwOff:{zh:'网关离线',en:'Gateway offline'}};
function tr(k){var v=T[k];return v?(v[S.lang]||v.en):k}
function now(){var d=new Date();return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}

var D={cs:document.getElementById('connect-screen'),ms:document.getElementById('main-screen'),ri:document.getElementById('rurl'),ci:document.getElementById('pcode'),bc:document.getElementById('btn-connect'),cst:document.getElementById('connect-status'),sd:document.getElementById('status-dot'),mn:document.getElementById('machine-name'),mel:document.getElementById('messages'),mi:document.getElementById('msg-input'),bs:document.getElementById('btn-send'),ob:document.getElementById('offline-banner'),qa:document.getElementById('quick-actions'),so:document.getElementById('schedule-overlay'),si:document.getElementById('sched-input'),sl:document.getElementById('schedule-list'),to:document.getElementById('toast')};

D.ri.value=localStorage.getItem('hone_url')||'';
D.ci.value=localStorage.getItem('hone_code')||'';

var tt=null;
function toast(t){D.to.textContent=t;D.to.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){D.to.classList.remove('show')},3e3)}

var dp=null;
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;if(!localStorage.getItem('hone_pwa_d')){document.getElementById('install-banner').classList.add('show')}});
window.installPWA=function(){if(dp){dp.prompt();dp.userChoice.then(function(r){if(r.outcome==='accepted')document.getElementById('install-banner').classList.remove('show');dp=null})}};
window.dismissInstall=function(){document.getElementById('install-banner').classList.remove('show');localStorage.setItem('hone_pwa_d','1')};

window.connect=function(){
  var u=D.ri.value.trim(),c=D.ci.value.trim();
  if(!u){toast(tr('needUrl'));return}
  if(!c){toast(tr('needCode'));return}
  if(c.length!==6||!/^\d{6}$/.test(c)){toast(tr('codeDigits'));return}
  localStorage.setItem('hone_url',u);localStorage.setItem('hone_code',c);
  D.cst.textContent=tr('connecting');D.cst.className='';D.bc.disabled=true;D.bc.textContent=tr('connecting');
  _open(u,c);
};

window.disconnect=function(){
  _clean();
  D.ms.classList.remove('active');D.cs.classList.remove('hidden');
  D.bc.disabled=false;D.bc.textContent='Connect';D.cst.textContent=tr('disconnected');D.cst.className='';
  D.mel.innerHTML='<div class="spacer"></div>';S.schedules=[];rSch();D.qa.classList.add('hidden');
};

function _clean(){
  if(S.ws){S.ws.onclose=null;S.ws.close(4000);S.ws=null}
  clearTimeout(S.reconTimer);clearInterval(S.hbTimer);
  S.connected=false;S.registered=false;S.clientId=null;S.gatewayInfo=null;S.reconDelay=1e3;
}

function _open(u,c){
  if(S.ws){S.ws.onclose=null;S.ws.close(4000)}
  var ws;try{ws=new WebSocket(u)}catch(e){_fail(tr('connError'));return}
  S.ws=ws;
  ws.onopen=function(){D.cst.textContent=tr('waiting');ws.send(JSON.stringify({type:'register',role:'client',pairingCode:c}))};
  ws.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(err){return};_msg(m)};
  ws.onclose=function(ev){
    if(S.registered){S.connected=false;S.registered=false;setOff(true);toast(tr('gwOff'))}
    if(ev.code===4003){_fail(tr('pairFailed'));return}
    if(ev.code===4000){_fail(tr('badFormat'));return}
    _recon(u,c);
  };
  ws.onerror=function(){};
}

function _recon(u,c){
  clearTimeout(S.reconTimer);
  if(S.reconDelay>3e4)S.reconDelay=3e4;
  S.reconTimer=setTimeout(function(){D.cst.textContent=tr('reconnecting')+' ('+(S.reconDelay/1000)+'s)';_open(u,c);S.reconDelay=Math.min(S.reconDelay*2,3e4)},S.reconDelay);
}

function _fail(m){S.ws=null;D.cst.textContent=m;D.cst.className='error';D.bc.disabled=false;D.bc.textContent='Connect';_recon(D.ri.value.trim(),D.ci.value.trim())}

function _msg(m){
  S.lastHb=Date.now();
  switch(m.type){
  case'registered':
    S.registered=true;S.connected=true;S.clientId=m.clientId||null;S.reconDelay=1e3;S.gatewayInfo=m.gateway||null;
    D.cs.classList.add('hidden');D.ms.classList.add('active');D.bc.disabled=false;D.bc.textContent='Connect';
    D.cst.textContent=tr('connected');D.cst.className='connected';setOff(false);
    var n=S.gatewayInfo?(S.gatewayInfo.machineName||S.gatewayInfo.machineId||'Gateway'):(m.machineName||'Connected');
    D.mn.textContent=n;D.sd.classList.remove('offline');D.qa.classList.remove('hidden');startHb();
    addMsg('gateway','Connected to '+n+'. How can I help you?',now());
    break;
  case'pairing_required':D.cst.textContent=tr('waiting');break;
  case'message':if(m.from==='gateway'&&m.payload){addMsg('gateway',m.payload.text||JSON.stringify(m.payload),now());rmTyping()}break;
  case'task_started':addSys(m.description||tr('ts'),'started');addTyping();break;
  case'task_progress':addSys(m.status||'Processing...','');break;
  case'task_complete':rmTyping();addSys(m.result||tr('td'),'completed');break;
  case'heartbeat':S.lastHb=Date.now();setOff(false);if(m.machineName)D.mn.textContent=m.machineName;break;
  case'gateway_disconnected':setOff(true);toast(m.message||tr('gwOff'));break;
  case'schedule_created':S.schedules.push({id:m.scheduleId,text:m.description||m.scheduleId,on:true});rSch();addSys(tr('sc'),'completed');break;
  case'schedule_triggered':addSys(tr('st')+(m.task||m.scheduleId),'started');break;
  case'schedule_list':if(Array.isArray(m.schedules)){S.schedules=m.schedules;rSch()}break;
  case'ping':if(S.ws&&S.ws.readyState===WebSocket.OPEN)S.ws.send(JSON.stringify({type:'pong'}));break;
  }
}

function addMsg(tp,txt,tm){
  var d=document.createElement('div');d.className='msg '+tp;d.textContent=txt;
  if(tm){var s=document.createElement('span');s.className='time';s.textContent=tm;d.appendChild(s)}
  D.mel.appendChild(d);scr();
}
function addSys(txt,lb){
  var d=document.createElement('div');d.className='sys';
  if(lb){var s=document.createElement('span');s.className='label '+lb;s.textContent=lb==='completed'?tr('td'):lb==='error'?tr('te'):tr('ts');d.appendChild(s)}
  d.appendChild(document.createTextNode(' '+txt));D.mel.appendChild(d);scr();
}
var tyEl=null;
function addTyping(){if(tyEl)return;tyEl=document.createElement('div');tyEl.className='typing';tyEl.innerHTML='<span></span><span></span><span></span>';D.mel.appendChild(tyEl);scr()}
function rmTyping(){if(tyEl){tyEl.remove();tyEl=null}}
function scr(){requestAnimationFrame(function(){D.mel.scrollTop=D.mel.scrollHeight})}
function setOff(o){if(o){D.sd.classList.add('offline');D.ob.classList.add('show')}else{D.sd.classList.remove('offline');D.ob.classList.remove('show')}}
function startHb(){S.lastHb=Date.now();clearInterval(S.hbTimer);S.hbTimer=setInterval(function(){if(!S.connected&&!S.registered)return;if(Date.now()-S.lastHb>45e3)setOff(true)},5e3)}

window.sendMessage=function(){
  if(!S.ws||S.ws.readyState!==WebSocket.OPEN)return;
  var t=D.mi.value.trim();if(!t)return;
  addMsg('user',t,now());D.mi.value='';D.mi.focus();addTyping();
  S.ws.send(JSON.stringify({type:'message',target:'gateway',payload:{text:t}}));
};
window.qa=function(t){D.mi.value=t;sendMessage()};
D.mi.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendMessage()}});
D.ci.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();connect()}});
D.ri.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();D.ci.focus()}});

window.showSchedule=function(){D.so.classList.add('active');D.si.focus();if(S.ws&&S.ws.readyState===WebSocket.OPEN)S.ws.send(JSON.stringify({type:'schedule_list'}))};
window.hideSchedule=function(){D.so.classList.remove('active')};
window.createSchedule=function(){
  if(!S.ws||S.ws.readyState!==WebSocket.OPEN)return;
  var t=D.si.value.trim();if(!t)return;
  var p={text:t},cr=detCron(t);if(cr){p.trigger='cron';p.cron=cr;p.task=t}
  S.ws.send(JSON.stringify({type:'schedule_create',payload:p}));D.si.value='';
};
window.toggleSchedule=function(id){
  if(!S.ws||S.ws.readyState!==WebSocket.OPEN)return;
  var s=S.schedules.find(function(x){return x.id===id});if(!s)return;
  s.on=!s.on;rSch();
  S.ws.send(JSON.stringify({type:s.on?'schedule_enable':'schedule_disable',scheduleId:id}));
};
window.deleteSchedule=function(id){
  if(!S.ws||S.ws.readyState!==WebSocket.OPEN)return;
  S.ws.send(JSON.stringify({type:'schedule_delete',scheduleId:id}));
  S.schedules=S.schedules.filter(function(x){return x.id!==id});rSch();
};

function rSch(){
  D.sl.innerHTML='';
  if(S.schedules.length===0){var li=document.createElement('li');li.style.justifyContent='center';li.style.color='var(--muted)';li.textContent=tr('noSch');D.sl.appendChild(li);return}
  S.schedules.forEach(function(s){
    var li=document.createElement('li');
    var ts=document.createElement('span');ts.className='text';ts.textContent=s.text||s.id;
    var tg=document.createElement('span');tg.className='toggle'+(s.on?' on':'');tg.onclick=function(){toggleSchedule(s.id)};
    var dl=document.createElement('button');dl.className='del';dl.textContent='\\u00d7';dl.onclick=function(){deleteSchedule(s.id)};
    li.appendChild(ts);li.appendChild(tg);li.appendChild(dl);D.sl.appendChild(li);
  });
}

function detCron(t){
  var t2=t.toLowerCase();
  var hm=t2.match(/每[天日]\\s*(\\d{1,2})\\s*点/);if(hm)return '0 '+hm[1]+' * * *';
  if(/每天\\s*早上/.test(t2)){var m=t2.match(/早上\\s*(\\d{1,2})/);return '0 '+(m?m[1]:'9')+' * * *'}
  if(/每天\\s*下午/.test(t2)){var m=t2.match(/下午\\s*(\\d{1,2})/);return '0 '+(m?parseInt(m[1])+12:'15')+' * * *'}
  var wm=t2.match(/每[周週]\\s*([一二三四五六日])/);if(wm){var dm={'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','日':'0'};return '0 9 * * '+(dm[wm[1]]||'1')}
  if(/每小时/.test(t2))return '0 * * * *';
  if(/每分钟/.test(t2))return '* * * * *';
  return null;
}

if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
if(D.ri.value&&D.ci.value&&D.ci.value.length===6&&/^\\d{6}$/.test(D.ci.value))setTimeout(connect,500);
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Default export: fetch() router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Static assets
    const asset = ASSETS[path];
    if (asset) {
      return new Response(asset.body, {
        headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=3600" },
      });
    }

    // Health endpoint
    if (path === "/health") {
      return new Response(json({
        status: "ok",
        version: "v2",
        time: new Date().toISOString(),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // PWA root — serve the client HTML
    if (path === "/" || path === "/index.html") {
      return serveClientHTML();
    }

    // WebSocket upgrade — /connect/:sessionId
    const match = path.match(/^\/connect\/([^/]+)$/);
    if (match) {
      const sessionId = match[1];
      const id = env.RELAY_ROOM.idFromName(sessionId);
      const stub = env.RELAY_ROOM.get(id);
      return stub.fetch(request);
    }

    // Unknown path
    return new Response("Not Found", { status: 404 });
  },
};
