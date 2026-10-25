/**
 * Python bridge: image info, quality metrics, before/after comparison sheets,
 * HDR reconstruction and 3D LUT application.
 *
 * Images are decoded in Python (numpy + Pillow) instead of in the host process.
 * `resolvePython` accepts an explicit path, several environment overrides, the
 * Python runtime bundled with DSH, and finally whatever `python` is on PATH, so
 * the plugin works both inside DSH and from a plain terminal.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const METRICS_SCRIPT = path.join(HERE, '..', 'assets', 'metrics.py')
const AUTODETECT_SCRIPT = path.join(HERE, '..', 'assets', 'autodetect.py')
const HDRSYNTH_SCRIPT = path.join(HERE, '..', 'assets', 'hdrsynth.py')
const LUTAPPLY_SCRIPT = path.join(HERE, '..', 'assets', 'lutapply.py')
const UPSCALE_SCRIPT = path.join(HERE, '..', 'assets', 'upscale.py')
const REGIONMASK_SCRIPT = path.join(HERE, '..', 'assets', 'regionmask.py')

export function resolvePython(configured) {
  const candidates = []
  const push = (value) => {
    if (!value) return
    candidates.push(value)
  }
  push(configured)
  push(process.env.LUMINA_PYTHON)
  push(process.env.DSH_PHOTOSHOP_PYTHON)
  push(process.env.DSH_VISION_PYTHON)
  push(process.env.DSH_PYTHON)

  // The DSH runtime ships a Python with numpy + Pillow; prefer it when present.
  const runtimesDir = path.join(os.homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const entry of fs.readdirSync(runtimesDir)) {
      push(path.join(runtimesDir, entry, 'dependencies', 'python', 'python.exe'))
      push(path.join(runtimesDir, entry, 'dependencies', 'python', 'bin', 'python'))
    }
  } catch { /* no runtimes dir */ }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  // Fall back to whatever python is on PATH (explicit candidates above win).
  return process.platform === 'win32' ? 'python' : 'python3'
}

function runScript(pythonPath, scriptPath, args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`缺少 Python 脚本: ${scriptPath}`))
      return
    }
    let child
    try {
      child = spawn(pythonPath, [scriptPath, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwd || path.dirname(scriptPath),
        // Chinese project folders (and thus paths) must survive the Python ->
        // Node pipe: force UTF-8 stdio instead of the Windows ANSI codepage.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      // spawn() can throw synchronously (e.g. EPERM when a sandbox forbids
      // child processes); surface the same friendly message as async failures.
      reject(new Error(`无法运行 Python (${pythonPath}): ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`Python 脚本超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法运行 Python (${pythonPath}): ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Python 脚本执行失败 (exit ${code}): ${(stderr || stdout).trim().slice(0, 600)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`Python 脚本输出不是 JSON: ${stdout.trim().slice(0, 400)}`))
      }
    })
  })
}

function runPython(pythonPath, args, opts) {
  return runScript(pythonPath, METRICS_SCRIPT, args, opts)
}

export async function imageInfo(pythonPath, filePath) {
  const result = await runPython(pythonPath, ['info', filePath])
  if (!result.ok) throw new Error(result.error || '读取图片信息失败')
  return result
}

export async function imageMeasure(pythonPath, filePath, { cropBottom } = {}) {
  const args = ['measure', filePath]
  if (cropBottom > 0) args.push('--crop-bottom', String(cropBottom))
  const result = await runPython(pythonPath, args)
  if (!result.ok) throw new Error(result.error || '读取图片指标失败')
  return result
}

/** Quality assessment (resolution + EXIF + blur/noise/tonality) for the auto pipeline. */
export async function imageAssess(pythonPath, filePath) {
  const result = await runPython(pythonPath, ['assess', filePath])
  if (!result.ok) throw new Error(result.error || '图片评估失败')
  return result
}

/** Write an EXIF-orientation-normalised copy (portrait phone photos). */
export async function orientImage(pythonPath, { input, output, timeoutMs = 120000 }) {
  const result = await runScript(pythonPath, METRICS_SCRIPT, ['orient', '--input', input, '--output', output], { timeoutMs })
  if (!result.ok) throw new Error(result.error || 'EXIF 旋转归一化失败')
  return result
}

export async function compareImages(pythonPath, { before, after, out, json, labelBefore, labelAfter, cropBottomBefore }) {
  const args = ['compare', '--before', before, '--after', after, '--out', out]
  if (json) args.push('--json', json)
  if (labelBefore) args.push('--label-before', labelBefore)
  if (labelAfter) args.push('--label-after', labelAfter)
  if (cropBottomBefore > 0) args.push('--crop-bottom-before', String(cropBottomBefore))
  const result = await runPython(pythonPath, args)
  if (!result.ok) throw new Error(result.error || '生成对比图失败')
  return result
}

export async function regionCompare(pythonPath, { before, after, mask, json, cropBottomBefore }) {
  const args = ['region', '--before', before, '--after', after, '--mask', mask]
  if (json) args.push('--json', json)
  if (cropBottomBefore > 0) args.push('--crop-bottom-before', String(cropBottomBefore))
  const result = await runPython(pythonPath, args)
  if (!result.ok) throw new Error(result.error || '区域对比失败')
  return result
}


export async function autoDetect(pythonPath, filePath, { timeoutMs = 150000 } = {}) {
  const result = await runScript(pythonPath, AUTODETECT_SCRIPT, [filePath], { timeoutMs })
  if (result && result.ok === false) throw new Error(result.error || '场景分析失败')
  return result
}

export async function runHdrSynth(pythonPath, { input, outDir, cropBottom = 0, params = {}, timeoutMs = 300000 }) {
  const p = params || {}
  const args = [
    '--input', input,
    '--out-dir', outDir,
    '--sdr-mode', String(p.mode || 'neutral'),
    '--wash-lum', String(p.washLum ?? 0.90),
    '--darken', String(p.darken ?? 0.10),
    '--texture', String(p.texture ?? 0.30),
    '--glow', String(p.glow ?? 0.55),
    '--sdr-knee', String(p.knee ?? 0.90),
    '--sdr-top', String(p.top ?? 0.965),
  ]
  // Always pass it: the Python default is 149 (screenshot UI strip), which
  // must not silently crop real photos / full-frame runs.
  args.push('--crop-bottom', String(Number(cropBottom) > 0 ? Number(cropBottom) : 0))
  if (Number.isFinite(Number(p.fog)) && Number(p.fog) > 0) args.push('--fog', String(p.fog))
  if (p.fogTip) args.push('--fog-tip', String(p.fogTip))
  if (p.fogBrighten) args.push('--fog-brighten')
  if (p.skipHdr !== false) args.push('--skip-hdr')
  const result = await runScript(pythonPath, HDRSYNTH_SCRIPT, args, { timeoutMs })
  if (result && result.ok === false) throw new Error(result.error || 'HDR 重建失败')
  return result
}


export async function lutApply(pythonPath, { input, lut, strength = 35, output, timeoutMs = 180000 }) {
  const args = ['--input', input, '--lut', lut, '--output', output, '--strength', String(strength)]
  const result = await runScript(pythonPath, LUTAPPLY_SCRIPT, args, { timeoutMs })
  if (result && result.ok === false) throw new Error(result.error || 'LUT 应用失败')
  return result
}

/**
 * Built-in Lanczos super-resolution fallback (no AI model; see assets/upscale.py).
 */
export async function runUpscale(pythonPath, { input, output, scale = 2, maxLongEdge = 8192, sharpen = 0, timeoutMs = 600000 }) {
  const args = [
    '--input', input,
    '--output', output,
    '--scale', String(scale),
    '--max-long-edge', String(maxLongEdge),
  ]
  if (Number(sharpen) > 0) args.push('--sharpen', String(sharpen))
  const result = await runScript(pythonPath, UPSCALE_SCRIPT, args, { timeoutMs })
  if (result && result.ok === false) throw new Error(result.error || '超分失败')
  return result
}


/** Generate a soft-alpha region mask (colour ranges or a channel threshold). */
export async function regionMask(pythonPath, { input, output, mode = 'color', ranges = [], channel = 'lum', low = 0.2, high = 0.8, feather = 0, invert = false, crop = null, exclude = null, timeoutMs = 180000 } = {}) {
  const args = ['--input', input, '--output', output, '--mode', mode,
    '--ranges', JSON.stringify(ranges || []), '--channel', channel,
    '--low', String(low), '--high', String(high), '--feather', String(feather)]
  if (invert) args.push('--invert')
  if (exclude) args.push('--exclude', exclude)
  if (Array.isArray(crop) && crop.length === 4) args.push('--crop', crop.map((v) => Math.round(Number(v))).join(','))
  const result = await runScript(pythonPath, REGIONMASK_SCRIPT, args, { timeoutMs })
  if (!result.ok || result.coveragePct === undefined) throw new Error(result.error || 'region mask generation failed')
  return result
}
