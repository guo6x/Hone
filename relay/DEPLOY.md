# Hone Relay — 部署指南

Cloudflare Workers WebSocket 中继，连接 Gateway daemon 与客户端设备。

## 前置条件

1. Cloudflare 账号 + Workers Paid 计划（Durable Objects 需要付费）
2. 安装 [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## 快速部署

```bash
cd relay
npm install

# 登录 Cloudflare
npx wrangler login

# 部署到 workers.dev 子域名
npm run deploy
```

部署后你会得到一个 URL，如：`wss://hone-relay.你的账号.workers.dev`

## 设置 AUTH_TOKEN（推荐）

生成随机 token：
```bash
openssl rand -hex 32
```

编辑 `wrangler.toml`：
```toml
[env.production]
vars = { AUTH_TOKEN = "你生成的token" }
```

Gateway 连接时需传递此 token：
```json
{ "type": "register", "role": "gateway", "token": "你生成的token", ... }
```

## 自定义域名（可选）

取消注释 `wrangler.toml` 中的 routes 配置：
```toml
[[routes]]
pattern = "relay.yourdomain.com/*"
zone_name = "yourdomain.com"
```

## 验证

```bash
# 健康检查
curl https://hone-relay.你的账号.workers.dev/health
# {"status":"ok","version":"v2","time":"..."}

# 查看实时日志
npm run tail
```

## 协议

见 `PROTOCOL.md`。WebSocket 路径：`/connect/:sessionId`

## 架构

```
Gateway daemon ──WebSocket──┐
                             ├── RelayRoom (Durable Object) ── 消息路由 / 配对审批 / 心跳管理
Desktop / CLI ──WebSocket──┘
```
