/**
 * Credential storage for browser automation.
 * Stores service credentials encrypted at rest in ~/.hone/credentials.json.
 * Phase 5: OS-level encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 * Falls back to AES-256-CBC with hostname-derived key when OS tools unavailable.
 *
 * 安全/可靠性增强：
 * - 原子写：通过 tmp + rename 模式写入，避免写入中途崩溃导致文件损坏
 * - 进程内互斥锁：串行化 read-modify-write 操作，防止并发覆盖
 * - 唯一 ID：使用 randomUUID 防止同毫秒并发冲突
 */
import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import * as os from 'os'
import type { CredentialEntry } from './types.js'
import { osEncrypt, osDecrypt, osReEncrypt, getEncryptMethod } from './os-credentials.js'

function getDataDir(): string {
  const base = process.env.HONE_DATA_DIR || path.join(os.homedir(), '.hone')
  return path.join(base, 'browser')
}

function getCredentialsPath(): string {
  return path.join(getDataDir(), 'credentials.json')
}

function encrypt(plaintext: string): string {
  return osEncrypt(plaintext)
}

function decrypt(ciphertext: string): string {
  return osDecrypt(ciphertext)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true })
}

// ── 进程内互斥锁 ──────────────────────────────────────────────────────────
// 防止并发 read-modify-write 导致数据丢失：所有写操作必须经过此锁串行化。
// 注：这是单进程内的锁，无法防止多进程并发（需要文件锁）。Hone daemon 是单进程，
// 所以进程内锁已经足够。

let next: Promise<void> = Promise.resolve()

/**
 * 在互斥锁保护下执行 read-modify-write 操作。
 * 后续调用会自动排队，确保不会有两个写操作并发执行。
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = next
  let release!: () => void
  const myTurn = new Promise<void>(r => { release = r })
  // 下一个调用者需要等我释放
  next = prev.then(() => myTurn)
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

// ── 原子写入 ──────────────────────────────────────────────────────────────

/**
 * 原子写入：先写到 tmp 文件，fsync 后 rename 到目标路径。
 * 防止写入中途崩溃/掉电导致 JSON 损坏。
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmpPath, data, 'utf-8')
  // fsync 确保 tmp 文件内容已落盘（防止掉电后 rename 完成但内容丢失）
  try {
    const fd = await fs.open(tmpPath, 'r')
    await fd.sync()
    await fd.close()
  } catch {
    // fsync 失败不致命，仍继续 rename
  }
  // rename 在同分区下是原子的（POSIX 保证；Windows NTFS 也保证）
  await fs.rename(tmpPath, filePath)
}

// ── 持久化 ────────────────────────────────────────────────────────────────

async function loadAll(): Promise<CredentialEntry[]> {
  try {
    await ensureDir()
    const raw = await fs.readFile(getCredentialsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function saveAll(entries: CredentialEntry[]): Promise<void> {
  await ensureDir()
  await atomicWriteFile(getCredentialsPath(), JSON.stringify(entries, null, 2))
}

/** Store a new credential with encrypted password. */
export async function addCredential(
  service: string,
  username: string,
  password: string,
  notes = '',
): Promise<CredentialEntry> {
  return withLock(async () => {
    const entries = await loadAll()
    // 使用 randomUUID 防止同毫秒并发的 ID 冲突
    const entry: CredentialEntry = {
      id: `cred_${randomUUID()}`,
      service,
      username,
      password: encrypt(password),
      notes,
      createdAt: Date.now(),
    }
    entries.push(entry)
    await saveAll(entries)
    return entry
  })
}

/** Retrieve and decrypt a credential. */
export async function getCredential(id: string): Promise<{ username: string; password: string } | null> {
  const entries = await loadAll()
  const entry = entries.find(e => e.id === id)
  if (!entry) return null
  return {
    username: entry.username,
    password: decrypt(entry.password),
  }
}

/** List all credentials (passwords remain encrypted). */
export async function listCredentials(): Promise<CredentialEntry[]> {
  return loadAll()
}

/** Delete a credential. */
export async function deleteCredential(id: string): Promise<boolean> {
  return withLock(async () => {
    const entries = await loadAll()
    const idx = entries.findIndex(e => e.id === id)
    if (idx === -1) return false
    entries.splice(idx, 1)
    await saveAll(entries)
    return true
  })
}
