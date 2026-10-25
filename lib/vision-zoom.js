/**
 * High-resolution inspection tools (part of lumina-dsh).
 *
 * `vision_zoom`   crop a region at a chosen zoom, draw a source-coordinate grid,
 *                 optionally overlay strong edges and mark points, then return
 *                 the view as an image content block (so the model sees pixels,
 *                 not a whole-image thumbnail).
 * `vision_probe`  sample exact pixel colours / luminance / edge strength at
 *                 coordinates or along a line (text only, no image needed).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePython } from './py.js'

export const inject = ['tools', 'attachments']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ZOOM_PY = path.join(HERE, '..', 'assets', 'vision-zoom.py')

function runPython(pythonPath, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(pythonPath, [ZOOM_PY, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`cannot run python (${pythonPath}): ${error.message}`))
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`vision tool timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`cannot run python (${pythonPath}): ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`vision tool failed (exit ${code}): ${(err || out).trim().slice(0, 400)}`))
        return
      }
      try { resolve(JSON.parse(out)) } catch {
        reject(new Error(`vision tool output is not JSON: ${out.trim().slice(0, 300)}`))
      }
    })
  })
}

function textBlocks(lines) {
  const text = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines ?? '')
  return [{ type: 'text', text: text || '(empty)' }]
}

export function apply(ctx, config = {}) {
  const maxDim = Number(config.maxViewDimension) > 0 ? Math.round(Number(config.maxViewDimension)) : 2048
  const python = resolvePython(config.pythonPath)
  const tmpRoot = path.join(os.tmpdir(), 'lumina-vision')
  fs.mkdirSync(tmpRoot, { recursive: true })

  let seq = 0
  function viewFile() {
    seq += 1
    return path.join(tmpRoot, `view-${Date.now()}-${seq}.png`)
  }

  const zoomTool = {
    name: 'vision_zoom',
    description: [
      '高分辨率看图：把图片的指定区域按 zoom 放大，叠加“原图坐标网格”（每格 grid 像素、每 5 格标坐标）、可选边缘高亮和标记点，然后把这张放大图直接返回给模型看。',
      '用它替代逐块裁剪+外挂脚本：一次调用即可获得带坐标的高倍视图，适合精修选区、核对边界、读取像素级位置。',
      '路径用原图路径；区域坐标是原图像素坐标（x,y,w,h），省略则看全图。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径' },
        x: { type: 'number', description: '区域左上角 x（原图像素）' },
        y: { type: 'number', description: '区域左上角 y（原图像素）' },
        w: { type: 'number', description: '区域宽度（原图像素）' },
        h: { type: 'number', description: '区域高度（原图像素）' },
        zoom: { type: 'number', description: '放大倍数，默认 1（受 maxViewDimension 限制）' },
        native: { type: 'boolean', description: '原生 1:1 裁片：不缩放、不降采样，用于发丝/边缘级细节核对（区域像素建议 ≤8MP，否则模型侧仍会被压缩）' },
        maxPixels: { type: 'number', description: '原生模式下允许的最大输出像素数（默认 0=不限；DSH 每图预算 8MP，超了会二次压缩）' },
        grid: { type: 'number', description: '网格间距（原图像素），0 表示不画网格' },
        edge: { type: 'boolean', description: '是否用红色叠加强边缘（用于判断真实边界）' },
        points: { type: 'string', description: '要标记的点，格式 "x,y;x,y"，坐标是原图像素' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          image: { type: 'object' },
          source: { type: 'object' },
          view: { type: 'object' },
          scale: { type: 'number' },
          sourceRect: { type: 'array' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['vision_zoom failed'])
        const lines = [
          `view ${value.view.width}x${value.view.height} (scale ${value.scale}) of source rect [${value.sourceRect.join(', ')}]`,
        ]
        if (value.source && value.source.w) lines.push(`source region ${value.source.w}x${value.source.h} @ (${value.source.x},${value.source.y})`)
        return [{ type: 'text', text: lines.join('\n') }, { type: 'image', attachment: value.image }]
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const p = String(args.path || '').trim()
      if (!p) throw new Error('path is required')
      if (!fs.existsSync(p)) throw new Error(`image not found: ${p}`)
      const out = viewFile()
      const cmdArgs = ['zoom', '--input', p, '--out', out, '--max-dim', String(maxDim)]
      for (const [key, flag] of [['x', '--x'], ['y', '--y'], ['w', '--w'], ['h', '--h']]) {
        if (args[key] !== undefined) cmdArgs.push(flag, String(Math.round(Number(args[key]))))
      }
      if (args.zoom !== undefined) cmdArgs.push('--zoom', String(Number(args.zoom)))
      if (args.native === true) cmdArgs.push('--native', '1')
      if (args.maxPixels !== undefined) cmdArgs.push('--max-pixels', String(Math.round(Number(args.maxPixels))))
      if (args.grid !== undefined) cmdArgs.push('--grid', String(Number(args.grid)))
      if (args.edge) cmdArgs.push('--edge', '1')
      if (args.points) cmdArgs.push('--points', String(args.points))
      const result = await runPython(python, cmdArgs)
      if (!result.ok) throw new Error(result.error || 'vision_zoom failed')
      const data = fs.readFileSync(result.file)
      const ref = await ctx.attachments.saveImage({ data, mediaType: 'image/png', name: path.basename(result.file) })
      return { ok: true, image: ref, source: result.source, view: result.view, scale: result.scale, sourceRect: result.sourceRect }
    },
  }

  const probeTool = {
    name: 'vision_probe',
    description: '像素探针：读取原图指定坐标（或一条线段上等距采样）的精确 RGB、亮度、边缘强度。用于确认边界到底在哪、颜色阈值多少。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径' },
        points: { type: 'string', description: '采样点，格式 "x,y;x,y"（原图像素）' },
        line: { type: 'string', description: '沿线段采样，格式 "x1,y1,x2,y2"' },
        step: { type: 'number', description: '线段采样步长（像素），默认 4' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, samples: { type: 'array' }, count: { type: 'number' } }, required: ['ok'], additionalProperties: true },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['vision_probe failed'])
        const lines = (value.samples || []).slice(0, 120).map((s) => (
          s.out ? `(${s.x},${s.y}) out-of-bounds`
            : `(${s.x},${s.y}) rgb=${s.rgb.join(',')} lum=${s.lum} edge=${s.edge}`
        ))
        return textBlocks(lines.length ? lines : ['no samples'])
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const p = String(args.path || '').trim()
      if (!p) throw new Error('path is required')
      if (!fs.existsSync(p)) throw new Error(`image not found: ${p}`)
      const cmdArgs = ['probe', '--input', p]
      if (args.points) cmdArgs.push('--points', String(args.points))
      if (args.line) cmdArgs.push('--line', String(args.line))
      if (args.step !== undefined) cmdArgs.push('--step', String(Number(args.step)))
      const result = await runPython(python, cmdArgs)
      if (!result.ok) throw new Error(result.error || 'vision_probe failed')
      return result
    },
  }

  ctx.tools.register(zoomTool)
  ctx.tools.register(probeTool)
}
