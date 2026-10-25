/**
 * Auto style/parameter case bank.
 *
 * Every accepted result can be recorded here (source features + the exact
 * recipe/params/style used). In auto mode a new image first looks up the
 * nearest accepted case; a close hit reuses its recipe/params so results drift
 * towards the looks that were actually approved, instead of a fixed default.
 *
 * The bank has two layers:
 *   seed bank   assets/auto-cases.json — optional, read-only. A published
 *               install ships an empty (or missing) seed file; projects may
 *               keep their own curated cases here (gitignored).
 *   user bank   ~/.lumina/auto-cases.json by default, or the `casesFile`
 *               plugin config / LUMINA_CASES_FILE env var. `learn: true`
 *               writes here, so a read-only package install still works.
 *
 * Both layers are plain JSON ({ version: 1, cases: [...] }) and are hot-read
 * on every lookup, so editing them by hand never needs a restart.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_SEED_PATH = path.join(HERE, '..', 'assets', 'auto-cases.json')

const state = {
  seedFile: null,
  userFile: null,
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function defaultUserFile() {
  return path.join(os.homedir(), '.lumina', 'auto-cases.json')
}

/**
 * Point the case bank at its two files. Called once per tool construction, so a
 * new plugin config takes effect the next time the bundle is (re)loaded.
 */
export function configureCases({ seedFile, userFile } = {}) {
  state.seedFile = seedFile || envValue('LUMINA_CASES_SEED', 'DSH_LUMINA_CASES_SEED') || DEFAULT_SEED_PATH
  state.userFile = userFile || envValue('LUMINA_CASES_FILE', 'DSH_LUMINA_CASES_FILE') || defaultUserFile()
}

function configureFallback() {
  if (!state.seedFile) state.seedFile = envValue('LUMINA_CASES_SEED', 'DSH_LUMINA_CASES_SEED') || DEFAULT_SEED_PATH
  if (!state.userFile) state.userFile = envValue('LUMINA_CASES_FILE', 'DSH_LUMINA_CASES_FILE') || defaultUserFile()
}

export function caseBankInfo() {
  configureFallback()
  const seed = readBankFile(state.seedFile)
  const user = readBankFile(state.userFile)
  return {
    seedFile: state.seedFile,
    userFile: state.userFile,
    seedCases: seed.cases.length,
    userCases: user.cases.length,
  }
}

function emptyBank() {
  return { version: 1, cases: [] }
}

function readBankFile(file) {
  if (typeof file !== 'string' || !file) return emptyBank()
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return {
      version: Number(parsed.version) || 1,
      cases: Array.isArray(parsed.cases) ? parsed.cases.filter((entry) => entry && typeof entry === 'object') : [],
    }
  } catch {
    return emptyBank()
  }
}

function writeBankFile(file, bank) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(bank, null, 2), 'utf8')
}

function entryId(entry, index) {
  if (entry.id) return String(entry.id)
  return `${index}:${entry.recipe || '?'}:${entry.version || '?'}:${entry.createdAt || ''}`
}

/** Merged, de-duplicated view of the seed and user banks. */
export function readBank() {
  configureFallback()
  const seed = readBankFile(state.seedFile)
  const user = readBankFile(state.userFile)
  const seen = new Set()
  const cases = []
  for (const entry of [...seed.cases, ...user.cases]) {
    const id = entryId(entry, cases.length)
    if (seen.has(id)) continue
    seen.add(id)
    cases.push(entry)
  }
  return { version: 1, cases }
}

export function listCases(limit = 50) {
  return readBank().cases.slice(-limit).reverse()
}

export function addCase(record) {
  configureFallback()
  const entry = { id: `case-${Date.now().toString(36)}-${Math.round(Math.random() * 1e4)}`, createdAt: new Date().toISOString(), ...record }
  try {
    const bank = readBankFile(state.userFile)
    bank.cases.push(entry)
    writeBankFile(state.userFile, bank)
    entry.persisted = true
  } catch {
    // Best effort: a read-only home/package must never break grading. The
    // caller still gets the entry back, marked as not persisted.
    entry.persisted = false
  }
  return entry
}

// Feature vector used for nearest-neighbour lookup. Scales are chosen so that
// a distance of ~1.0 means "very different"; scene type must match exactly.
export function featureVector(detection = {}, scene = 'landscape') {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    clipPct: num(detection.clipPct, 0),
    washPct: num(detection.washPct, 0),
    mean: num(detection.mean, 0.5),
    p50: num(detection.p50, 0.5),
    skinBlob: num(detection.skinBlobAreaFrac, 0),
    scene: scene === 'character' ? 1 : 0,
  }
}

const WEIGHTS = { clipPct: 1.0, washPct: 0.35, mean: 1.3, p50: 1.1, skinBlob: 0.8, scene: 3.0 }
const SCALES = { clipPct: 8.0, washPct: 18.0, mean: 0.35, p50: 0.35, skinBlob: 0.04, scene: 1.0 }

export function findNearestCase(detection, scene, threshold = 0.85) {
  const target = featureVector(detection, scene)
  let best = null
  for (const entry of readBank().cases) {
    const features = entry.features
    if (!features) continue
    let sum = 0
    for (const key of Object.keys(WEIGHTS)) {
      const a = Number(target[key] ?? 0)
      const b = Number(features[key] ?? 0)
      const d = (a - b) / SCALES[key]
      sum += WEIGHTS[key] * d * d
    }
    const distance = Math.sqrt(sum / 6)
    if (!best || distance < best.distance) best = { entry, distance }
  }
  if (!best || best.distance > threshold) return null
  return { case: best.entry, distance: Number(best.distance.toFixed(3)) }
}
