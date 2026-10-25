/**
 * Native-resolution pixel maps as text (part of lumina-dsh).
 *
 * `vision_textmap` renders an image region with one character per source pixel
 * (block-averaged only when the region exceeds the character budget). This has
 * no image-token or image-dimension limit, so it is the escape hatch when even
 * the raised image budget is not enough: pixel-exact work happens in text.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePython } from './py.js'

export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEXTMAP_PY = path.join(HERE, '..', 'assets', 'vision-textmap.py')

function runPython(pythonPath, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(pythonPath, [TEXTMAP_PY, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`cannot run python (${pythonPath}): ${error.message}`))
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`vision_textmap timed out after ${timeoutMs}ms`))
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
        reject(new Error(`textmap failed (exit ${code}): ${(err || out).trim().slice(0, 400)}`))
        return
      }
      try { resolve(JSON.parse(out)) } catch {
        reject(new Error(`textmap output is not JSON: ${out.trim().slice(0, 300)}`))
      }
    })
  })
}

function textBlocks(lines) {
  const text = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines ?? '')
  return [{ type: 'text', text: text || '(empty)' }]
}

export function apply(ctx, config = {}) {
  const python = resolvePython(config.pythonPath)
  const maxChars = Number(config.maxChars) > 0 ? Math.round(Number(config.maxChars)) : 24000

  const tool = {
    name: 'vision_textmap',
    description: [
      '把图片的指定区域渲染成“原生分辨率文本像素图”：默认 1 个字符 = 1 个原图像素（区域过大时才按块平均），带坐标标尺。',
      '这条路径不受图片尺寸/图像 token 上限限制，适合在放大图仍不够时做像素级核对（边界、1px 线条、微缩文字、颜色过渡）。',
      'mode: lum（亮度渐变，默认自动判断）/ edge（边缘强度）/ binary（按阈值二值化）；区域建议 ≤ 200×150。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径' },
        x: { type: 'number', description: '区域左上角 x（原图像素）' },
        y: { type: 'number', description: '区域左上角 y（原图像素）' },
        w: { type: 'number', description: '区域宽度（原图像素），默认 200' },
        h: { type: 'number', description: '区域高度（原图像素），默认 120' },
        mode: { type: 'string', enum: ['auto', 'lum', 'edge', 'binary'], description: '渲染模式，默认 auto' },
        threshold: { type: 'number', description: 'binary 模式阈值 0-255，默认 128' },
        maxChars: { type: 'number', description: `字符预算，默认 ${maxChars}（超过则按块平均）` },
        ruler: { type: 'number', description: '标尺间隔（像素），默认 10' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, mode: { type: 'string' }, sourceRect: { type: 'array' }, block: { type: 'number' }, chars: { type: 'number' }, text: { type: 'string' } }, required: ['ok'], additionalProperties: true },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['vision_textmap failed'])
        const head = `mode=${value.mode} source=[${value.sourceRect.join(', ')}] block=${value.block} chars=${value.chars}`
        return textBlocks([head, '', value.text])
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const p = String(args.path || '').trim()
      if (!p) throw new Error('path is required')
      if (!fs.existsSync(p)) throw new Error(`image not found: ${p}`)
      const cmdArgs = ['map', '--input', p]
      for (const [key, flag] of [['x', '--x'], ['y', '--y'], ['w', '--w'], ['h', '--h']]) {
        if (args[key] !== undefined) cmdArgs.push(flag, String(args[key]))
      }
      if (args.mode) cmdArgs.push('--mode', String(args.mode))
      if (args.threshold !== undefined) cmdArgs.push('--threshold', String(args.threshold))
      if (args.ruler !== undefined) cmdArgs.push('--ruler', String(args.ruler))
      cmdArgs.push('--max-chars', String(args.maxChars !== undefined ? Math.round(Number(args.maxChars)) : maxChars))
      const result = await runPython(python, cmdArgs)
      if (!result.ok) throw new Error(result.error || 'vision_textmap failed')
      return result
    },
  }

  ctx.tools.register(tool)
}
