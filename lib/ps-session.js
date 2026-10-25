/**
 * Persistent Photoshop COM session.
 *
 * The plugin lives in the DSH host process (normal user token), so unlike the
 * sandboxed shell it can start a GUI application such as Photoshop. One hidden
 * PowerShell helper owns the COM object and stays resident; every call is a
 * JSON line round-trip, so a warm edit costs ~0.5-2s instead of a ~6s cold start.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, '..', 'assets', 'ps-helper.ps1')

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(candidate) ? candidate : 'powershell.exe'
}

export class PsSession {
  constructor({ waitMs = 90000, opTimeoutMs = 240000, logger = () => {} } = {}) {
    this.waitMs = waitMs
    this.opTimeoutMs = opTimeoutMs
    this.logger = logger
    this.child = null
    this.ready = false
    this.version = null
    this.buffer = ''
    this.pending = new Map()
    this.seq = 0
    this.ensurePromise = null
    this.startReject = null
    this.startResolve = null
  }

  get running() {
    return Boolean(this.child) && this.ready
  }

  async ensure() {
    if (this.ready && this.child) return
    if (this.ensurePromise) return this.ensurePromise
    this.ensurePromise = (async () => {
      let lastError
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await this.#start()
        } catch (error) {
          lastError = error
          const message = String(error?.message || error)
          // A freshly killed Photoshop can briefly refuse COM activation
          // (CO_E_SERVER_EXEC_FAILURE / server execution failed). Retry once.
          const transient = /80080005|CO_E_SERVER_EXEC_FAILURE|服务器运行失败|启动超时/.test(message)
          if (!transient || attempt >= 2) throw error
          this.logger(`start attempt ${attempt} failed (${message.slice(0, 120)}), retrying...`)
          await new Promise((resolve) => setTimeout(resolve, 2500))
        }
      }
      throw lastError
    })().finally(() => {
      this.ensurePromise = null
    })
    return this.ensurePromise
  }

  async #start() {
    this.#teardownChild()
    this.buffer = ''
    this.pending.clear()
    this.ready = false
    this.version = null
    if (!fs.existsSync(HELPER)) throw new Error(`缺少 Photoshop 助手脚本: ${HELPER}`)

    const child = spawn(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', HELPER,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.logger(`helper stderr: ${text.slice(0, 500)}`)
    })
    child.on('error', (error) => {
      this.#failAll(new Error(`无法启动 Photoshop 助手进程: ${error.message}`))
      this.ready = false
    })
    child.on('exit', (code, signal) => {
      this.logger(`helper exited code=${code} signal=${signal}`)
      this.ready = false
      this.#failAll(new Error('Photoshop 助手进程已退出'))
    })

    const readyPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })

    const timer = setTimeout(() => {
      this.startReject?.(new Error(`Photoshop 启动超时（${this.waitMs}ms），请确认已安装并能正常启动 Photoshop`))
      this.#teardownChild()
    }, this.waitMs)

    try {
      const info = await readyPromise
      clearTimeout(timer)
      this.version = info.version || null
      this.ready = true
      this.logger(`Photoshop ready: ${info.name || 'Adobe Photoshop'} ${this.version || ''}`)
    } catch (error) {
      clearTimeout(timer)
      this.#teardownChild()
      throw error
    } finally {
      this.startResolve = null
      this.startReject = null
    }
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.logger(`helper emitted non-JSON line: ${line.slice(0, 300)}`)
        continue
      }
      if (message.event === 'ready') {
        this.startResolve?.(message)
        continue
      }
      if (message.fatal) {
        const error = new Error(`Photoshop 助手启动失败: ${message.error || 'unknown'}`)
        this.startReject?.(error)
        this.#failAll(error)
        continue
      }
      const waiter = this.pending.get(message.id)
      if (!waiter) {
        this.logger(`helper emitted response for unknown id ${message.id}`)
        continue
      }
      this.pending.delete(message.id)
      if (message.ok) waiter.resolve(message)
      else waiter.reject(new Error(message.error || 'Photoshop 操作失败'))
    }
  }

  #failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  async request(op, payload = {}, timeoutMs = this.opTimeoutMs) {
    if (!this.ready || !this.child) throw new Error('Photoshop 会话未就绪')
    const id = ++this.seq
    const line = JSON.stringify({ id, op, ...payload }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Photoshop 操作超时（${timeoutMs}ms，op=${op}）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        this.child.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 Photoshop 助手失败: ${error.message}`))
      }
    })
  }

  #parseResult(raw) {
    const text = String(raw ?? '')
    if (text.startsWith('ERR|')) {
      const [, step, message, line] = text.split('|')
      throw new Error(`Photoshop 处理失败 [${step || 'unknown'}] ${message || ''}${line ? ` @line ${line}` : ''}`)
    }
    if (!text.startsWith('OK|')) throw new Error(`Photoshop 返回了意外结果: ${text.slice(0, 300)}`)
    return text.slice(3).trim()
  }

  async runJsx(code, timeoutMs = this.opTimeoutMs) {
    await this.ensure()
    try {
      const response = await this.request('jsx', { code }, timeoutMs)
      return this.#parseResult(response.result)
    } catch (error) {
      const message = String(error?.message || error)
      const recoverable = !this.ready || /助手进程已退出|会话未就绪|EPIPE|ECONNRESET|Photoshop 助手/.test(message)
      if (!recoverable) throw error
      this.logger(`runJsx recovering after: ${message}`)
      await this.ensure()
      const response = await this.request('jsx', { code }, timeoutMs)
      return this.#parseResult(response.result)
    }
  }

  async state() {
    await this.ensure()
    const response = await this.request('state')
    return { version: response.version || this.version, documents: response.documents ?? 0 }
  }

  async cleanup() {
    if (!this.ready) return
    try { await this.request('cleanup', {}, 30000) } catch { /* best effort */ }
  }

  async quit() {
    if (!this.ready) { this.#teardownChild(); return }
    try { await this.request('quit', {}, 30000) } catch { /* best effort */ }
    this.#teardownChild()
  }

  dispose() {
    this.#teardownChild()
  }

  #teardownChild() {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
  }
}
