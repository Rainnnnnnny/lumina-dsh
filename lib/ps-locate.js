/**
 * Locate the local Adobe Photoshop installation and its bundled 3D LUT folder.
 *
 * Lumina never bundles Adobe's LUT files. The `cinema` / `vivid` / `still` /
 * `soft` styles reference the `.cube` files that ship with Photoshop itself,
 * and this module resolves those names at run time:
 *
 *   1. explicit `lutDir` plugin config (or the LUMINA_LUT_DIR env var)
 *   2. the Presets/3DLUTs folder of a Photoshop install found in the registry
 *   3. filesystem probes under %ProgramFiles%\Adobe\...
 *
 * Driving Photoshop itself does not need any of this: the COM helper activates
 * `Photoshop.Application` through its normal registry registration. This module
 * only answers "where are the LUT files". When nothing is found, style grading
 * is skipped with a warning; everything else keeps working.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LUT_RELATIVE = path.join('Presets', '3DLUTs')
const ENV_KEYS = ['LUMINA_LUT_DIR', 'DSH_LUMINA_LUT_DIR']

let cachedInstalls = null

function decodeRegOutput(buffer) {
  // reg.exe writes its redirected stdout in the console code page (cp936 on
  // Chinese Windows / cp1252 elsewhere), not UTF-8. Node ships full ICU, so
  // TextDecoder can handle 'gbk' when present; fall back to UTF-8 otherwise.
  if (typeof buffer === 'string') return buffer
  for (const encoding of ['gbk', 'utf-8']) {
    try {
      return new TextDecoder(encoding).decode(buffer)
    } catch { /* encoding not available */ }
  }
  return Buffer.from(buffer).toString('utf8')
}

function dedupe(dirs) {
  const seen = new Set()
  const out = []
  for (const dir of dirs) {
    if (!dir) continue
    let resolved
    try { resolved = path.resolve(String(dir).trim()) } catch { continue }
    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

function registryInstallPaths() {
  const results = []
  if (process.platform !== 'win32') return results
  const keys = [
    'HKLM\\SOFTWARE\\Adobe\\Photoshop',
    'HKCU\\SOFTWARE\\Adobe\\Photoshop',
    'HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Photoshop',
  ]
  for (const key of keys) {
    let output
    try {
      output = execFileSync('reg.exe', ['query', key, '/s', '/v', 'ApplicationPath'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      })
    } catch {
      continue
    }
    const text = decodeRegOutput(output)
    for (const line of text.split(/\r?\n/)) {
      // "    ApplicationPath    REG_SZ    D:\...\Adobe Photoshop 2025\"
      const match = /ApplicationPath\s+REG_\w+\s+(.+)$/i.exec(line.trim())
      if (match) results.push(match[1])
    }
  }
  return results
}

function looksLikePhotoshopDir(dir) {
  return fs.existsSync(path.join(dir, 'Photoshop.exe'))
    || fs.existsSync(path.join(dir, 'Presets', '3DLUTs'))
}

function filesystemInstallPaths() {
  const results = []
  const bases = dedupe([
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ])
  for (const base of bases) {
    for (const root of [path.join(base, 'Adobe'), base]) {
      let entries
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root, entry.name)
        // Only look at folders that plausibly are Photoshop installations;
        // the Adobe root holds many unrelated products.
        if (!/photoshop/i.test(entry.name) && !looksLikePhotoshopDir(dir)) continue
        if (looksLikePhotoshopDir(dir)) results.push(dir)
      }
    }
  }
  return results
}

/** All Photoshop install directories found on this machine (cached). */
export function detectPhotoshopInstalls() {
  // Negative results are deliberately not cached: a transient probe failure
  // (sandboxed shell, locked registry) must not disable LUT styles until the
  // next DSH restart.
  if (cachedInstalls && cachedInstalls.length > 0) return cachedInstalls
  const candidates = dedupe([...registryInstallPaths(), ...filesystemInstallPaths()])
  cachedInstalls = candidates.filter((dir) => {
    try { return fs.existsSync(dir) } catch { return false }
  })
  return cachedInstalls
}

/** LUT folders shipped with the detected Photoshop installs. */
export function detectLutDirs() {
  const dirs = []
  for (const install of detectPhotoshopInstalls()) {
    const candidate = path.join(install, LUT_RELATIVE)
    if (fs.existsSync(candidate)) dirs.push(candidate)
  }
  return dirs
}

/**
 * Resolve the folder that provides Photoshop's bundled 3D LUTs.
 * `configured` is the plugin's `lutDir` config value; an absolute path wins.
 * Returns null when no Photoshop LUT folder can be found.
 */
export function resolveLutDir(configured) {
  const explicit = []
  if (typeof configured === 'string' && configured.trim()) explicit.push(configured.trim())
  for (const key of ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) explicit.push(value.trim())
  }
  for (const candidate of explicit) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return path.resolve(candidate)
    } catch { /* ignore */ }
  }
  return detectLutDirs()[0] || null
}

/**
 * Resolve a recipe style `lut` entry. Absolute paths are returned as-is (the
 * caller reports a missing file); bare file names are looked up in the local
 * Photoshop 3DLUTs folder. Returns null when the LUT cannot be located.
 */
export function resolveLut(lut, { lutDir } = {}) {
  if (typeof lut !== 'string' || !lut.trim()) return null
  const value = lut.trim()
  if (path.isAbsolute(value)) return value
  const dir = resolveLutDir(lutDir)
  if (!dir) return null
  const candidate = path.join(dir, value)
  try {
    return fs.existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}
