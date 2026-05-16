/**
 * Full end-to-end: CLI Gateway Daemon ↔ Relay ↔ Client
 * Usage: node relay/test-e2e.mjs
 */
import { spawn } from 'child_process'

const RELAY_WSS = 'wss://hone-relay.marsailleippi79.workers.dev'
const RELAY_URL = RELAY_WSS + '/connect/default'
const ROOM = 'default'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

let passed = 0, failed = 0
function ok(n) { console.log('  ✅', n); passed++ }
function fail(n) { console.log('  ❌', n); failed++ }

async function main() {
  console.log('Hone E2E Test — ' + new Date().toISOString())
  console.log(RELAY_WSS + '\n')

  // ── Start Gateway daemon ──
  console.log('[1] 启动 Gateway daemon')
  const gw = spawn('node', ['dist/cli.js', '--gateway-mode'], {
    env: { ...process.env, HONE_RELAY_URL: RELAY_URL, HONE_GOD_MODE: '1' },
    stdio: 'pipe',
  })
  gw.stderr.on('data', d => process.stdout.write('  [GW] ' + d.toString().trim() + '\n'))

  // Wait for "已连接到中继"
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway startup timeout')), 15000)
    gw.stderr.on('data', d => {
      if (d.toString().includes('已连接到中继')) {
        clearTimeout(timeout)
        ok('Gateway 已连接到 relay')
        resolve()
      }
    })
  })

  // ── Connect client ──
  console.log('\n[2] 客户端连入 relay')
  const cl = new WebSocket(RELAY_WSS + '/connect/' + ROOM)
  await new Promise(r => cl.onopen = r)
  ok('客户端已连接 relay')

  // Register client
  cl.send(JSON.stringify({ type: 'register', role: 'client', pairingCode: '123456' }))
  console.log('  → 发送注册 (client)')

  // Wait for pairing approval (Gateway in God Mode auto-approves)
  const clResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Pairing timeout')), 10000)
    cl.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      console.log('  [CL] ←', msg.type)

      if (msg.type === 'pairing_required') {
        ok('配对请求已发送到 Gateway')
      } else if (msg.type === 'registered') {
        ok('Gateway 已自动批准配对 (God Mode)')
        // Send a test message
        cl.send(JSON.stringify({ type: 'message', target: 'gateway', payload: { text: '你好，现在几点？' } }))
        console.log('  → 发送消息到 Gateway')
      } else if (msg.type === 'message') {
        ok('Gateway 回复: ' + (msg.payload?.text || JSON.stringify(msg.payload)))
        clearTimeout(timeout)
        resolve(true)
      } else if (msg.type === 'ping') {
        cl.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }))
      }
    }
  })

  // ── Cleanup ──
  console.log('\n[3] 清理')
  try { cl.close() } catch {}
  gw.kill('SIGTERM')
  await sleep(1000)

  console.log('\n' + '─'.repeat(40))
  console.log(`结果: ${passed} 通过, ${failed} 失败`)

  if (clResult) {
    console.log('\n🎉 端到端验证成功！')
    console.log('Gateway Daemon ↔ Cloudflare Relay ↔ Client')
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('\n测试失败:', e.message)
  process.exit(1)
})
