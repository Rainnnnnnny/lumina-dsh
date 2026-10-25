/**
 * Optional user-level configuration file.
 *
 * The package itself stays portable: machine-specific choices (where projects
 * go, where the writable case/style files live, an external AI upscaler
 * command, ...) belong in a user config file rather than in the repository or
 * the npm package:
 *
 *   <home>/.lumina/config.json          (default)
 *   $LUMINA_CONFIG                      (override the path)
 *
 * Example (keep data and renders on a second drive):
 * {
 *   "projectRoot": "D:/Photos/LuminaProjects",
 *   "dataDir": "D:/Photos/LuminaData",
 *   "superResolution": { "enabled": true, "minLongEdge": 1600, "scale": 2 }
 * }
 *
 * Precedence for every resolved value is:
 *   plugin config (cordis.patch.yml) > environment variable > user config file > built-in default.
 * The file is read when the plugin bundle is loaded; edit + reload/restart DSH
 * to apply (style/case banks themselves stay hot-reloaded per call).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function userConfigPath() {
  const configured = process.env.LUMINA_CONFIG
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.lumina', 'config.json')
}

export function defaultDataDir() {
  return path.join(os.homedir(), '.lumina')
}

/** Read the optional user config file. Returns {} when absent/unreadable. */
export function loadUserConfig() {
  const file = userConfigPath()
  try {
    // Windows editors (PowerShell 5, Notepad) may prepend a UTF-8 BOM.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/** <dataDir>/<name> when a dataDir is configured, otherwise null. */
export function dataDirFile(userConfig, name) {
  const dir = typeof userConfig?.dataDir === 'string' && userConfig.dataDir.trim()
    ? userConfig.dataDir.trim()
    : ''
  if (!dir) return null
  return path.join(path.resolve(dir), name)
}
