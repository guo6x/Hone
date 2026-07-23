/**
 * OS-level credential encryption.
 * Phase 5 upgrade from AES hostname-key to platform-native encryption:
 *   Windows → DPAPI (via PowerShell)
 *   macOS   → Keychain (via /usr/bin/security)
 *   Linux   → libsecret (via secret-tool)
 *
 * Falls back to AES-256-CBC with hostname-derived key when native tools
 * are unavailable.
 *
 * SECURITY: macOS Keychain 使用 `security -i` 交互模式通过 stdin 传递密码，
 * 避免密码出现在进程 argv 中（`ps aux` 不可见）。
 */
import { spawnSync } from 'child_process'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import os from 'os'

const ALGORITHM = 'aes-256-cbc'
const KEY_LENGTH = 32
const IV_LENGTH = 16

// ── Platform detection ──

const platform = os.platform() as 'win32' | 'darwin' | 'linux'

// ── AES fallback (same as original) ──

function fallbackKey(): Buffer {
  const hostname = process.env.COMPUTERNAME || process.env.HOSTNAME || 'hone'
  return scryptSync(hostname, 'hone-browser-credentials-v1', KEY_LENGTH)
}

function fallbackEncrypt(plaintext: string): string {
  const key = fallbackKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

function fallbackDecrypt(ciphertext: string): string {
  const key = fallbackKey()
  const [ivHex, dataHex] = ciphertext.split(':')
  if (!ivHex || !dataHex) throw new Error('Invalid ciphertext format')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf-8')
}

// ── DPAPI (Windows) ──
// 性能说明：每次加解密 spawn 新的 PowerShell 进程有开销（~100-200ms）。
// 对于低频的凭据加解密（登录时）这是可接受的。如果未来需要高频调用，
// 可考虑缓存 PowerShell 进程或使用 native addon 直接调用 DPAPI。

function dpapiEncrypt(plaintext: string): string {
  const base64 = Buffer.from(plaintext, 'utf-8').toString('base64')
  const ps = `
$bytes = [System.Convert]::FromBase64String('${base64}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Convert]::ToBase64String($protected)
`
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf-8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result.stdout.trim()
}

function dpapiDecrypt(ciphertext: string): string {
  const ps = `
$bytes = [System.Convert]::FromBase64String('${ciphertext}')
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($unprotected)
`
  const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf-8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result.stdout.trim()
}

// ── Keychain (macOS) ──
// 使用 `security -i` 交互模式通过 stdin 传递命令，密码不在进程 argv 中。

function keychainEncrypt(plaintext: string): string {
  const id = `hone_cred_${Date.now()}`
  // 转义密码中的特殊字符（双引号和反斜杠）
  const escapedPassword = plaintext.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  // 使用 -i 模式通过 stdin 传递命令，密码不在 argv 中
  const result = spawnSync('security', ['-i'], {
    encoding: 'utf-8',
    input: `add-generic-password -a hone -s ${id} -w "${escapedPassword}" -U\nquit\n`,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`security add failed: ${result.stderr.trim()}`)
  return id
}

function keychainDecrypt(ciphertext: string): string {
  // find-generic-password -w 输出密码到 stdout，密码不在 argv 中（只有 service name 在 argv）
  const result = spawnSync('security', [
    'find-generic-password',
    '-a', 'hone',
    '-s', ciphertext,
    '-w',
  ], { encoding: 'utf-8' })
  if (result.error) throw result.error
  return result.stdout.trim()
}

// ── libsecret (Linux) — password piped via stdin to avoid argv leak ──

function libsecretEncrypt(plaintext: string): string {
  const id = `hone_cred_${Date.now()}`
  const result = spawnSync('secret-tool', [
    'store',
    '--label=Hone Credential',
    'service', 'hone',
    'id', id,
  ], {
    encoding: 'utf-8',
    input: plaintext,
  })
  if (result.error) throw result.error
  return id
}

function libsecretDecrypt(ciphertext: string): string {
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', 'hone',
    'id', ciphertext,
  ], { encoding: 'utf-8' })
  if (result.error) throw result.error
  return result.stdout.trim()
}

// ── Tool availability checks ──

let dpapiAvailable: boolean | null = null
let keychainAvailable: boolean | null = null
let libsecretAvailable: boolean | null = null

function checkDpapi(): boolean {
  if (dpapiAvailable !== null) return dpapiAvailable
  try {
    const test = dpapiEncrypt('hone-test')
    const decrypted = dpapiDecrypt(test)
    dpapiAvailable = decrypted === 'hone-test'
  } catch {
    dpapiAvailable = false
  }
  return dpapiAvailable
}

function checkKeychain(): boolean {
  if (keychainAvailable !== null) return keychainAvailable
  try {
    spawnSync('security', ['find-generic-password', '-a', 'hone', '-s', 'hone_test_key'], { encoding: 'utf-8' })
  } catch {
    // Keychain available — lookup failed because key doesn't exist
  }
  try {
    spawnSync('security', ['add-generic-password', '-a', 'hone', '-s', 'hone_test_key', '-w', 'testval', '-U'], { encoding: 'utf-8' })
    const val = spawnSync('security', ['find-generic-password', '-a', 'hone', '-s', 'hone_test_key', '-w'], { encoding: 'utf-8' }).stdout.trim()
    spawnSync('security', ['delete-generic-password', '-a', 'hone', '-s', 'hone_test_key'], { encoding: 'utf-8' })
    keychainAvailable = val === 'testval'
  } catch {
    keychainAvailable = false
  }
  return keychainAvailable
}

function checkLibsecret(): boolean {
  if (libsecretAvailable !== null) return libsecretAvailable
  try {
    spawnSync('secret-tool', ['lookup', 'service', 'hone', 'id', 'hone_test'], { encoding: 'utf-8' })
  } catch {}
  try {
    spawnSync('secret-tool', ['store', '--label=Hone Test', 'service', 'hone', 'id', 'hone_test'], {
      encoding: 'utf-8',
      input: 'testval',
    })
    const val = spawnSync('secret-tool', ['lookup', 'service', 'hone', 'id', 'hone_test'], { encoding: 'utf-8' }).stdout.trim()
    spawnSync('secret-tool', ['clear', 'service', 'hone', 'id', 'hone_test'], { encoding: 'utf-8' })
    libsecretAvailable = val === 'testval'
  } catch {
    libsecretAvailable = false
  }
  return libsecretAvailable
}

// ── Public API ──

export type EncryptMethod = 'dpapi' | 'keychain' | 'libsecret' | 'aes-fallback'

let cachedMethod: EncryptMethod | null = null

export function getEncryptMethod(): EncryptMethod {
  if (cachedMethod) return cachedMethod

  if (platform === 'win32' && checkDpapi()) {
    cachedMethod = 'dpapi'
  } else if (platform === 'darwin' && checkKeychain()) {
    cachedMethod = 'keychain'
  } else if (platform === 'linux' && checkLibsecret()) {
    cachedMethod = 'libsecret'
  } else {
    cachedMethod = 'aes-fallback'
  }

  return cachedMethod
}

export function osEncrypt(plaintext: string): string {
  const method = getEncryptMethod()
  const prefix = `${method}:`

  switch (method) {
    case 'dpapi':
      return prefix + dpapiEncrypt(plaintext)
    case 'keychain':
      return prefix + keychainEncrypt(plaintext)
    case 'libsecret':
      return prefix + libsecretEncrypt(plaintext)
    default:
      return prefix + fallbackEncrypt(plaintext)
  }
}

export function osDecrypt(ciphertext: string): string {
  const colonIdx = ciphertext.indexOf(':')
  if (colonIdx === -1) {
    return fallbackDecrypt(ciphertext)
  }

  const method = ciphertext.slice(0, colonIdx)
  const payload = ciphertext.slice(colonIdx + 1)

  switch (method) {
    case 'dpapi':
      return dpapiDecrypt(payload)
    case 'keychain':
      return keychainDecrypt(payload)
    case 'libsecret':
      return libsecretDecrypt(payload)
    default:
      return fallbackDecrypt(payload)
  }
}

/** Re-encrypt using the current best method (for upgrading legacy credentials). */
export function osReEncrypt(ciphertext: string): string {
  return osEncrypt(osDecrypt(ciphertext))
}
