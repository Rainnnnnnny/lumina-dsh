/**
 * Builds the ExtendScript source executed inside Photoshop.
 *
 * The pipeline body lives in assets/pipeline.jsx and is re-read on every call,
 * so tuning the pipeline does NOT require restarting DSH.
 *
 * IMPORTANT: only APIs verified to actually mutate pixels on Photoshop 2025
 * may appear in pipeline.jsx (PS 2025 silently ignores adjustCurves,
 * Hue/Saturation and Invert).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PIPELINE_PATH = path.join(HERE, '..', 'assets', 'pipeline.jsx')

function jsLiteral(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(jsLiteral).join(', ') + ']'
  if (typeof value === 'object') {
    return '{' + Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => JSON.stringify(k) + ': ' + jsLiteral(v))
      .join(', ') + '}'
  }
  return 'null'
}

function pipelineBody() {
  return fs.readFileSync(PIPELINE_PATH, 'utf8')
}

export function buildGradeJsx(config) {
  const payload = {
    input: config.input,
    output: config.output,
    psd: config.psd || null,
    maskOut: config.maskOut || null,
    crop: config.crop,
    steps: config.steps,
  }
  return [
    '#target photoshop',
    'app.displayDialogs = DialogModes.NO;',
    'app.preferences.rulerUnits = Units.PIXELS;',
    'var CFG = ' + jsLiteral(payload) + ';',
    pipelineBody(),
  ].join('\n')
}

export function toPsPath(filePath) {
  return String(filePath).replace(/\\/g, '/')
}
