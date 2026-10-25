import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'assets', 'export-layers.py')

export function exportLayers(python, projectDir) {
  try {
    const res = spawnSync(python, [SCRIPT, projectDir], { encoding: 'utf8', timeout: 120000 })
    return { ok: res.status === 0, stdout: res.stdout || '', stderr: res.stderr || '' }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error && error.message || error) }
  }
}