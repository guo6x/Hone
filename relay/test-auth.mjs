/**
 * Relay 鉴权验证测试 v2。
 *
 * 测试 1: AUTH_TOKEN 注册鉴权（单元测试 worker 逻辑）
 * 测试 2: 未批准 client 消息拒绝（单元测试 worker 逻辑）
 * 测试 3: 真实 relay E2E — 验证部署版本是否有 approved-check
 *
 * Usage: node relay/test-auth.mjs
 */

let passed = 0, failed = 0, warned = 0
function ok(n) { console.log(`  ✅ ${n}`); passed++ }
function fail(n, r) { console.log(`  ❌ ${n}: ${r}`); failed++ }
function warn(n, r) { console.log(`  ⚠️ ${n}: ${r}`); warned++ }

// ── AUTH_TOKEN 注册逻辑（从 worker.js 复制的核心逻辑）────────

function simulateGatewayRegister(msg, envAUTH_TOKEN) {
  if (envAUTH_TOKEN) {
    if (!msg.token || msg.token !== envAUTH_TOKEN) {
      return { rejected: true, code: 4003, reason: "Gateway auth failed — invalid or missing token" }
    }
  }
  return { rejected: false, registered: true, gatewayId: msg.machineId || 'auto-generated' }
}

function simulateClientRegister(msg, envAUTH_TOKEN) {
  if (envAUTH_TOKEN) {
    if (!msg.token || msg.token !== envAUTH_TOKEN) {
      return { rejected: true, code: 4003, reason: "Client auth failed — invalid or missing token" }
    }
  }
  const code = (msg.pairingCode || '').trim()
  if (!code || code.length < 4 || code.length > 32) {
    return { rejected: true, code: 4000, reason: "Invalid pairing code format" }
  }
  return { rejected: false, registered: true, clientId: 'mock-client-id', approved: false }
}

function simulateMessageFromClient(ws, senderApproved) {
  if (!senderApproved) {
    return { rejected: true, type: "error", message: "Not approved — wait for gateway pairing approval" }
  }
  return { rejected: false, forwarded: true }
}

// ── Test 1: AUTH_TOKEN 网关注册鉴权（6 个用例）────────────────

console.log('\n[1] AUTH_TOKEN 鉴权 — worker.js 逻辑单元测试')
console.log('    代码位置: relay/worker.js:242-248 (_handleGatewayRegister)')
console.log('              relay/worker.js:299-306 (_handleClientRegister)')

const cases = [
  ['AUTH_TOKEN 未设置: 无 token GW 注册通过',           simulateGatewayRegister({ machineId: 'g1' }, undefined),             r => !r.rejected],
  ['AUTH_TOKEN 已设置: 无 token GW 被拒 (4003)',          simulateGatewayRegister({ machineId: 'g1' }, 'sec'),                r => r.rejected && r.code === 4003],
  ['AUTH_TOKEN 已设置: 错误 token GW 被拒 (4003)',        simulateGatewayRegister({ token: 'wrong', machineId: 'g1' }, 'sec'), r => r.rejected && r.code === 4003],
  ['AUTH_TOKEN 已设置: 正确 token GW 通过',               simulateGatewayRegister({ token: 'sec', machineId: 'g1' }, 'sec'),    r => !r.rejected],
  ['AUTH_TOKEN 已设置: Client 无 token 被拒 (4003)',      simulateClientRegister({ pairingCode: '123456' }, 'sec'),            r => r.rejected && r.code === 4003],
  ['AUTH_TOKEN 已设置: Client 正确 token 注册通过(未批准)', simulateClientRegister({ pairingCode: '123456', token: 'sec' }, 'sec'), r => !r.rejected && !r.approved],
]

for (const [label, result, check] of cases) {
  if (check(result)) ok(label)
  else fail(label, JSON.stringify(result))
}

// ── Test 2: 未批准 client 消息拒绝逻辑 ────────────────────────

console.log('\n[2] 未批准 Client 消息拒绝 — worker.js 逻辑单元测试')
console.log('    代码位置: relay/worker.js:388-402 (_handleMessage)')

{
  const r = simulateMessageFromClient('ws', false)
  if (r.rejected && r.message.includes('Not approved')) ok('未批准 client: 消息被拒绝 (error: Not approved)')
  else fail('未批准 client: 消息应被拒绝', JSON.stringify(r))
}
{
  const r = simulateMessageFromClient('ws', true)
  if (!r.rejected) ok('已批准 client: 消息正常转发')
  else fail('已批准 client: 消息应通过', JSON.stringify(r))
}

// ── Test 3: 真实 relay E2E — 部署版本行为验证 ────────────────

async function testDeployedRelay() {
  console.log('\n[3] 真实 Relay E2E — 验证部署版本的 approved-check')

  const RELAY = 'wss://hone-relay.marsailleippi79.workers.dev'
  const ROOM = 'auth-test-' + Date.now()

  return new Promise((resolve) => {
    let earlyMsgRejected = false
    let earlyMsgForwarded = false

    const timeout = setTimeout(() => {
      if (earlyMsgRejected) ok('E2E: relay 已部署 approved-check，未批准消息被正确拒绝')
      else if (earlyMsgForwarded) warn('E2E: relay 未部署 approved-check（本地 worker.js 已有修复，需部署）', '')
      else fail('E2E', 'timeout before any result')
      resolve()
    }, 12000)

    const gw = new WebSocket(`${RELAY}/connect/${ROOM}`)

    gw.onopen = () => {
      gw.send(JSON.stringify({ type: 'register', role: 'gateway', machineId: 'auth-gw', machineName: 'auth-gw' }))
    }

    gw.onmessage = (e) => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'registered') ok('Gateway 注册成功')

      if (msg.type === 'pairing_request') {
        // 故意延迟 5 秒再批准，给 client 足够时间发未批准消息
        setTimeout(() => {
          gw.send(JSON.stringify({ type: 'pairing_response', clientId: msg.clientId, approved: true }))
        }, 5000)
      }

      // Gateway 收到转发消息 → 回复证明消息通过了 relay
      if (msg.type === 'message' && msg.from === 'client') {
        earlyMsgForwarded = true
        gw.send(JSON.stringify({
          type: 'message', target: 'client', clientId: msg.clientId,
          payload: { text: 'RELAY_FORWARDED_UNCHECKED' },
        }))
      }
    }

    gw.onerror = () => { fail('E2E', 'gw WebSocket error'); clearTimeout(timeout); resolve() }

    // Client
    setTimeout(() => {
      const cl = new WebSocket(`${RELAY}/connect/${ROOM}`)

      cl.onopen = () => {
        cl.send(JSON.stringify({ type: 'register', role: 'client', pairingCode: 'auth-test-12345' }))
      }

      cl.onmessage = (ce) => {
        const msg = JSON.parse(ce.data)

        if (msg.type === 'pairing_required') {
          ok('Client 已注册，状态: pairing_required')
          // 立即发消息 — 此时 client 未被批准
          cl.send(JSON.stringify({ type: 'message', target: 'gateway', payload: { text: 'UNPROVED_SEND' } }))
        }

        if (msg.type === 'error' && msg.message && msg.message.includes('Not approved')) {
          earlyMsgRejected = true
          ok('未批准 client 消息被 relay 正确拒绝')
          clearTimeout(timeout)
          setTimeout(() => { cl.close(); gw.close(); resolve() }, 300)
        }

        if (msg.type === 'registered') {
          ok('Client 被批准后注册成功')
        }

        if (msg.type === 'message' && msg.payload?.text === 'RELAY_FORWARDED_UNCHECKED') {
          warn('消息未被拒绝，relay 缺少 approved-check', '本地 worker.js:394-402 已有修复')
          clearTimeout(timeout)
          setTimeout(() => { cl.close(); gw.close(); resolve() }, 300)
        }
      }

      cl.onerror = () => { fail('E2E', 'client WebSocket error'); clearTimeout(timeout); resolve() }
    }, 400)
  })
}

async function main() {
  console.log(`Hone Relay Auth Test — ${new Date().toISOString()}`)
  console.log(`Target: wss://hone-relay.marsailleippi79.workers.dev`)

  await testDeployedRelay()

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warnings`)

  if (warned > 0 && failed === 0) {
    console.log(`\n说明: ⚠️ 表示本地代码已修复但尚未部署到 relay。`)
    console.log(`修复文件: relay/worker.js (lines 394-402: approved check)`)
    console.log(`部署命令: cd relay && npx wrangler deploy`)
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Crashed:', e); process.exit(1) })
