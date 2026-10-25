/**
 * Optional super-resolution preprocessing.
 *
 * Two modes, both configured through a single options object (plugin config
 * `superResolution`, user config, or `preprocess.superResolution` per call):
 *
 *   - external AI upscaler: set `command` + `args` to any CLI that takes an
 *     input/output image (Real-ESRGAN, waifu2x, Topaz CLI, ...). Lumina does not
 *     bundle a model; it runs your tool and keeps the original untouched.
 *   - built-in fallback: high-quality Lanczos resize (no AI, no new detail, but
 *     a deterministic, dependency-free 2x upscale).
 *
 * Whether to run at all is decided by `planSuperResolution`:
 *   mode "auto"   -> when the long edge is below `minLongEdge`, or when the
 *                    source sharpness is below `minSharpness` (0 = ignore).
 *   mode "always" -> always run.
 * `maxLongEdge` caps the result so a 4K source does not explode into 16K.
 *
 * The upscaled image is written to work/sr-vN/sr-view.png and becomes the graded
 * input; the project keeps the untouched original in input/.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { runUpscale } from './py.js'

export const DEFAULT_SUPER_RESOLUTION = {
  enabled: false,
  mode: 'auto',
  scale: 2,
  minLongEdge: 1600,
  maxLongEdge: 8192,
  minSharpness: 0,
  sharpen: 0,
  command: '',
  args: [],
  timeoutMs: 600000,
  // Quality-first engine chain. `engines` maps an engine name to
  // { command, args, priority, label }; higher priority is tried first and a
  // failing/low-quality engine is skipped for the next one. `command`/`args`
  // (above) act as an extra highest-priority engine when set.
  engines: {},
  // What to do when every external engine fails or returns a defective image
  // (the known case: the 2022 Real-ESRGAN ncnn build on NVIDIA 570+ drivers
  // returns an almost-black frame with exit code 0 on RTX 50-series cards):
  // "lanczos" keeps the upscale intent, "skip" leaves the image untouched.
  fallback: 'lanczos',
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function mergeSuperResolution(base, patch) {
  const out = { ...DEFAULT_SUPER_RESOLUTION, ...(isObject(base) ? base : {}), ...(isObject(patch) ? patch : {}) }
  if (Array.isArray(patch?.args)) out.args = patch.args.slice()
  if (isObject(patch?.engines)) out.engines = patch.engines
  return out
}

/**
 * Build the ordered quality-first engine chain for this configuration.
 * Pure function (unit tested).
 *
 *   1. explicit top-level `command` (priority 1000)
 *   2. `engines` entries sorted by descending `priority` (optional label)
 *
 * Empty chain means "no external AI engine configured" -> built-in Lanczos.
 */
export function resolveEngineChain(options = {}) {
  const opts = mergeSuperResolution(options)
  const engines = []
  if (typeof opts.command === 'string' && opts.command.trim()) {
    engines.push({
      key: 'command',
      label: opts.label || String(opts.command).split(/[\\/]/).pop() || 'external',
      command: opts.command.trim(),
      args: Array.isArray(opts.args) ? opts.args : [],
      priority: 1000,
    })
  }
  const map = isObject(opts.engines) ? opts.engines : {}
  for (const [key, def] of Object.entries(map)) {
    if (!isObject(def) || typeof def.command !== 'string' || !def.command.trim()) continue
    const priority = Number.isFinite(Number(def.priority)) ? Number(def.priority) : 0
    engines.push({
      key,
      label: typeof def.label === 'string' && def.label.trim() ? def.label.trim() : key,
      command: def.command.trim(),
      args: Array.isArray(def.args) ? def.args : [],
      priority,
    })
  }
  engines.sort((a, b) => b.priority - a.priority)
  return engines
}

/**
 * Decide whether this image needs upscaling. Pure function (unit tested).
 * Returns { triggered, reason, scale, targetLongEdge }.
 */
export function planSuperResolution(info, options = {}, { sharpness } = {}) {
  const opts = mergeSuperResolution(options)
  const width = Number(info?.width) || 0
  const height = Number(info?.height) || 0
  const longEdge = Math.max(width, height)
  const mode = String(opts.mode || 'auto').toLowerCase()
  if (!opts.enabled || longEdge <= 0) return { triggered: false, reason: 'superResolution disabled', scale: 1, targetLongEdge: longEdge }
  if (mode === 'off' || mode === 'never' || mode === 'none' || mode === 'disabled') {
    return { triggered: false, reason: 'mode=off', scale: 1, targetLongEdge: longEdge }
  }

  const requestedScale = Number(opts.scale) > 1 ? Number(opts.scale) : 2
  const maxLongEdge = Number(opts.maxLongEdge) > 0 ? Number(opts.maxLongEdge) : 8192
  let scale = requestedScale
  if (longEdge * scale > maxLongEdge) scale = maxLongEdge / longEdge
  if (scale < 1.05) {
    return { triggered: false, reason: `maxLongEdge ${maxLongEdge} reached (long edge ${longEdge})`, scale: 1, targetLongEdge: longEdge }
  }

  if (mode === 'always') {
    return { triggered: true, reason: 'mode=always', scale, targetLongEdge: Math.round(longEdge * scale) }
  }

  const reasons = []
  const minLongEdge = Number(opts.minLongEdge) > 0 ? Number(opts.minLongEdge) : 0
  if (minLongEdge > 0 && longEdge < minLongEdge) reasons.push(`long edge ${longEdge} < ${minLongEdge}`)
  const minSharpness = Number(opts.minSharpness) > 0 ? Number(opts.minSharpness) : 0
  if (minSharpness > 0 && Number.isFinite(Number(sharpness)) && Number(sharpness) < minSharpness) {
    reasons.push(`sharpness ${sharpness} < ${minSharpness}`)
  }
  if (reasons.length === 0) {
    return { triggered: false, reason: `image is large/sharp enough (long edge ${longEdge})`, scale: 1, targetLongEdge: longEdge }
  }
  return { triggered: true, reason: reasons.join('; '), scale, targetLongEdge: Math.round(longEdge * scale) }
}

function expandTokens(template, values) {
  let text = String(template)
  for (const [key, value] of Object.entries(values)) text = text.split(`{${key}}`).join(String(value))
  return text
}

/**
 * Sanity-check an upscaled image before accepting it.
 *
 * Some engines "succeed" (exit code 0) but return a corrupt frame — the known
 * case is the 2022 Real-ESRGAN ncnn build on NVIDIA 570+ drivers (near-black or
 * banded output on RTX 50-series). This validator compares output size and basic
 * tonality statistics against the input so the caller can fall back safely.
 */
export function validateUpscaleOutput({ inputInfo, outputInfo, inputMetrics, outputMetrics, expectedScale = 2, tolerance = 0.08 } = {}) {
  const problems = []
  if (!outputInfo || !(Number(outputInfo.width) > 0) || !(Number(outputInfo.height) > 0)) {
    return { ok: false, problems: ['超分输出不存在或尺寸无效'] }
  }
  if (!inputInfo || !(Number(inputInfo.width) > 0)) {
    return { ok: false, problems: ['无法读取超分前尺寸'] }
  }
  const scaleX = Number(outputInfo.width) / Number(inputInfo.width)
  const scaleY = Number(outputInfo.height) / Number(inputInfo.height)
  const wanted = Number(expectedScale) > 1 ? Number(expectedScale) : 2
  const sizeOk = Math.abs(scaleX - wanted) / wanted <= tolerance && Math.abs(scaleY - wanted) / wanted <= tolerance
  if (!sizeOk) problems.push(`输出尺寸 ${outputInfo.width}×${outputInfo.height} 与预期 ×${wanted} 不符`)

  if (inputMetrics && outputMetrics) {
    const inMean = Number(inputMetrics.mean)
    const outMean = Number(outputMetrics.mean)
    const inStd = Number(inputMetrics.std)
    const outStd = Number(outputMetrics.std)
    if (Number.isFinite(inMean) && Number.isFinite(outMean)) {
      if (inMean > 0.25 && outMean < Math.max(0.06, inMean * 0.55)) problems.push(`输出亮度异常（${outMean} vs 输入 ${inMean}，疑似坏帧）`)
      if (inMean < 0.75 && outMean > Math.min(0.99, inMean * 1.6)) problems.push(`输出亮度异常偏高（${outMean} vs 输入 ${inMean}）`)
    }
    if (Number.isFinite(inStd) && Number.isFinite(outStd) && inStd > 0.05 && outStd < inStd * 0.45) {
      problems.push(`输出对比度异常（std ${outStd} vs 输入 ${inStd}，疑似坏帧）`)
    }
  }
  return { ok: problems.length === 0, problems, scale: Number(scaleX.toFixed(3)) }
}

function runExternalCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动外部超分命令 (${command}): ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`外部超分命令超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法运行外部超分命令 (${command}): ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`外部超分命令失败 (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`))
    })
  })
}

/**
 * Execute the planned upscale with one engine (or the built-in Lanczos fallback
 * when `options.command` is empty).
 *
 * `engine` may be one entry from resolveEngineChain; `sourceKind` is exposed to
 * the command template as `{sourceKind}` so a single runner script can pick the
 * right model (e.g. photo vs anime/screenshot weights).
 */
export async function runSuperResolution({ python, input, outDir, plan, options = {}, engine = null, sourceKind = 'default', timeoutMs }) {
  const opts = mergeSuperResolution(options)
  const engineCommand = engine && engine.command ? engine.command : (opts.command || '')
  const engineArgs = engine && Array.isArray(engine.args) && engine.args.length ? engine.args : (Array.isArray(opts.args) ? opts.args : [])
  const engineLabel = engine ? engine.label : ''
  fs.mkdirSync(outDir, { recursive: true })
  const output = path.join(outDir, 'sr-view.png')
  try { fs.rmSync(output, { force: true }) } catch { /* ignore */ }

  if (engineCommand) {
    const values = {
      input,
      output,
      scale: plan.scale,
      targetLongEdge: plan.targetLongEdge,
      sourceKind: String(sourceKind || 'default'),
      scaleInt: Math.max(1, Math.round(plan.scale)),
    }
    const args = (engineArgs.length > 0
      ? engineArgs
      : ['--input', '{input}', '--output', '{output}', '--scale', '{scale}']).map((arg) => expandTokens(arg, values))
    const command = expandTokens(engineCommand, values)
    await runExternalCommand(command, args, Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 600000)
    if (!fs.existsSync(output)) throw new Error(`外部超分命令未生成输出文件: ${output}`)
    return {
      ok: true,
      path: output,
      method: 'external-ai',
      command,
      label: engineLabel || command,
      engineKey: engine ? engine.key : null,
      scale: plan.scale,
      targetLongEdge: plan.targetLongEdge,
    }
  }

  const result = await runUpscale(python, {
    input,
    output,
    scale: plan.scale,
    maxLongEdge: Number(opts.maxLongEdge) > 0 ? Number(opts.maxLongEdge) : 8192,
    sharpen: Number(opts.sharpen) > 0 ? Number(opts.sharpen) : 0,
    timeoutMs: timeoutMs || 600000,
  })
  return {
    ok: true,
    path: output,
    method: 'lanczos',
    label: 'builtin-lanczos',
    engineKey: 'lanczos',
    scale: Number(result.scale) || plan.scale,
    width: result.width,
    height: result.height,
    targetLongEdge: plan.targetLongEdge,
  }
}
