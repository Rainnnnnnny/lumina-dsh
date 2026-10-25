/**
 * First-run onboarding helpers: scan locally installed AI super-resolution
 * models/engines and recommend one per content type.
 *
 * The plugin never bundles models; this module only looks at directories the
 * user points us at (config `modelsDir`, dataDir/ai/models, dataDir/models) and
 * at the configured engine chain.
 */
import fs from 'node:fs'
import path from 'node:path'

const MODEL_EXTENSIONS = ['.pth', '.pt', '.onnx', '.bin']
const ENGINE_EXTENSIONS = ['.exe', '.cmd', '.bat']

function safeStat(filePath) {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

export function defaultModelDirs({ config = {}, dataDir } = {}) {
  const dirs = []
  if (typeof config.modelsDir === 'string' && config.modelsDir.trim()) dirs.push(path.resolve(config.modelsDir.trim()))
  if (dataDir) {
    dirs.push(path.join(dataDir, 'ai', 'models'))
    dirs.push(path.join(dataDir, 'models'))
  }
  return [...new Set(dirs)]
}

/** Scan model directories and the engine chain. Returns { dirs, models }. */
export function scanModels({ dirs = [], engines = [] } = {}) {
  const models = []
  for (const dir of dirs) {
    const stat = safeStat(dir)
    if (!stat || !stat.isDirectory()) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MODEL_EXTENSIONS.includes(ext)) continue
      const full = path.join(dir, entry.name)
      const fileStat = safeStat(full)
      if (!fileStat) continue
      const compat = classifyModel(entry.name, ext.slice(1), 'super-resolution')
      models.push({
        name: entry.name,
        path: full,
        format: ext.slice(1),
        sizeMB: Math.round((fileStat.size / 1048576) * 10) / 10,
        kind: 'super-resolution',
        source: 'model-dir',
        runtime: compat.runtime,
        runnable: compat.runnable,
        note: compat.note,
      })
    }
  }
  for (const engine of engines) {
    const cmd = engine.command || ''
    const ext = path.extname(cmd).toLowerCase()
    const stat = safeStat(cmd)
    models.push({
      runtime: 'engine',
      runnable: true,
      note: 'external engine command',
      name: engine.label || path.basename(cmd) || engine.key,
      path: cmd,
      format: ENGINE_EXTENSIONS.includes(ext) ? ext.slice(1) : 'command',
      sizeMB: stat ? Math.round((stat.size / 1048576) * 10) / 10 : null,
      kind: 'engine',
      source: 'engine-chain',
      priority: engine.priority,
    })
  }
  // de-dupe by name
  const seen = new Set()
  const unique = []
  for (const item of models) {
    const key = `${item.kind}:${item.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

// The bundled runner (upscale_torch.py) currently loads Real-ESRGAN RRDBNet
// checkpoints only; other community architectures need an adapter before use.
const NATIVE_PATTERNS = [/^RealESRGAN_x4plus\.pth$/i, /^RealESRGAN_x4plus_anime_6B\.pth$/i, /^RealESRGAN_x2plus\.pth$/i, /ultrasharp/i, /remacri/i]
const ADAPTER_PATTERNS = [/ultrasharp/i, /remacri/i, /nmkd/i, /\bhat\b/i, /\bdat\b/i, /supir/i, /animevideov3/i]
const ADAPTER_FORMATS = new Set(['onnx', 'engine'])
export function classifyModel(name = '', format = '', kind = 'super-resolution') {
  if (kind === 'engine') return { runtime: 'engine', runnable: true, note: 'external engine command' }
  const lowerFormat = String(format).toLowerCase()
  if (NATIVE_PATTERNS.some((re) => re.test(name))) return { runtime: 'rrdb', runnable: true, note: 'RRDBNet checkpoint (native or adapter-converted)' }
  if (ADAPTER_FORMATS.has(lowerFormat)) return { runtime: 'needs-adapter', runnable: false, note: 'external engine/ONNX backend required' }
  if (ADAPTER_PATTERNS.some((re) => re.test(name))) return { runtime: 'needs-adapter', runnable: false, note: 'community checkpoint: adapter required before the runner can load it' }
  return { runtime: 'unknown', runnable: false, note: 'not validated by the bundled runner' }
}

const ROLE_RULES = {
  photo: [/ultrasharp/i, /remacri/i, /x4plus/i, /photo/i, /supir/i, /hat/i, /dat/i, /nmkd/i],
  screenshot: [/ultrasharp/i, /x4plus/i, /animevideov3/i, /nmkd/i, /hat/i, /supir/i],
  anime: [/anime_6b/i, /animevideov3/i, /anime/i, /waifu2x/i],
}

/** Recommend one model/engine per content role from a scanned catalog. */
export function recommendModels(models = []) {
  const local = models.filter((item) => item.kind === 'super-resolution' && item.runnable !== false)
  const engines = models.filter((item) => item.kind === 'engine')
  const pick = (role) => {
    for (const pattern of ROLE_RULES[role]) {
      const hit = local.find((item) => pattern.test(item.name))
      if (hit) return { name: hit.name, path: hit.path, sizeMB: hit.sizeMB }
    }
    return null
  }
  return {
    photo: pick('photo'),
    screenshot: pick('screenshot'),
    anime: pick('anime'),
    acceleration: engines.length > 0 ? engines.map((item) => item.name) : [],
    fallback: { name: 'builtin Lanczos', note: 'always available, no model files needed' },
  }
}

export function formatModelTable(models = []) {
  return models.map((item) => ({
    name: item.name,
    kind: item.kind,
    format: item.format,
    sizeMB: item.sizeMB,
    status: item.kind === 'engine' ? `engine (priority ${item.priority ?? '-'})` : 'model file',
    runtime: item.runtime || 'unknown',
    runnable: item.runnable !== false,
    path: item.path,
  }))
}
