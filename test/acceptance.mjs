/**
 * Acceptance / regression runner.
 *
 *   node test/acceptance.mjs [path\to\acceptance.json]
 *
 * Without an argument it reads $LUMINA_ACCEPTANCE_MANIFEST, then ./acceptance.json
 * (relative to the current directory). The manifest is a local file (NOT
 * committed) that lists the images and the expected numbers captured from the
 * previously accepted version. Each check runs the real pipeline through the
 * same handlers the plugin tools use, so a passing manifest means the installed
 * behaviour is unchanged.
 *
 * Manifest shape:
 * {
 *   "projectRoot": "D:/Lumina-test/projects",     // optional, default test-results/
 *   "casesFile":   "D:/Lumina-test/cases.json",   // optional, fresh writable bank
 *   "seedCasesFile": "path/to/private-cases.json",// optional seed bank
 *   "freshCases": true,                            // delete casesFile first (default true)
 *   "tolerance": { "mean": 0.01, "p50": 0.01, "clipHi": 1, "clipLo": 1, "sat": 0.01, "sharpRelPct": 1.5 },
 *   "checks": [
 *     { "name": "auto-canyon", "type": "auto", "source": "C:/...png",
 *       "expect": { "recipe": "auto-landscape-hdr", "preprocess": true,
 *                   "baselineAfter": { "mean": 0.5083, "p50": 0.5495, "clipHi": 2.92,
 *                                      "clipLo": 2.4, "sat": 0.2598, "sharp": 0.06753 } } },
 *     { "name": "case-hit", "type": "case", "source": "C:/...png",
 *       "recipe": "clean-premium", "params": {} },
 *     { "name": "self-heal", "type": "selfheal", "source": "C:/...png",
 *       "auto": { "hdrThreshold": 99 } },
 *     { "name": "manual-recipe", "type": "manual", "source": "C:/...png",
 *       "recipe": "clean-premium", "params": { "vignette": 0 }, "style": "cinema",
 *       "expect": { "styleApplied": true } }
 *   ]
 * }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHandlers } from '../lib/grade.js'
import { resolvePython } from '../lib/py.js'
import { PsSession } from '../lib/ps-session.js'
import { resolveLutDir } from '../lib/ps-locate.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestArg = process.argv[2]
  || process.env.LUMINA_ACCEPTANCE_MANIFEST
  || (fs.existsSync(path.resolve('acceptance.json')) ? path.resolve('acceptance.json') : '')
if (!manifestArg) {
  console.error('usage: node test/acceptance.mjs <acceptance.json>   (or set LUMINA_ACCEPTANCE_MANIFEST)')
  process.exit(2)
}
const manifestPath = path.resolve(manifestArg)
if (!fs.existsSync(manifestPath)) {
  console.error(`acceptance manifest not found: ${manifestPath}`)
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const checks = Array.isArray(manifest.checks) ? manifest.checks : []
if (checks.length === 0) {
  console.error('manifest has no checks')
  process.exit(2)
}

const TOLERANCE = {
  mean: 0.01,
  p50: 0.01,
  clipHi: 1.0,
  clipLo: 1.0,
  sat: 0.01,
  sharpRelPct: 1.5,
  ...(manifest.tolerance || {}),
}

const resultsRoot = path.join(REPO, 'acceptance-results')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const projectRoot = manifest.projectRoot ? path.resolve(manifest.projectRoot) : path.join(resultsRoot, `projects-${stamp}`)
const casesFile = manifest.casesFile ? path.resolve(manifest.casesFile) : path.join(resultsRoot, 'cases.json')
if (manifest.freshCases !== false) {
  try { fs.rmSync(casesFile, { force: true }) } catch { /* ignore */ }
}

const python = resolvePython(process.env.LUMINA_PYTHON)
const config = {
  projectRoot,
  casesFile,
  casesSeedFile: manifest.seedCasesFile ? path.resolve(manifest.seedCasesFile) : undefined,
  stylesFile: manifest.stylesFile ? path.resolve(manifest.stylesFile) : undefined,
  lutDir: manifest.lutDir,
  superResolution: manifest.superResolution && typeof manifest.superResolution === 'object' ? manifest.superResolution : undefined,
  psWaitMs: 120000,
  opTimeoutMs: 300000,
}
const session = new PsSession({
  waitMs: config.psWaitMs,
  opTimeoutMs: config.opTimeoutMs,
  logger: (...args) => console.error('[ps-session]', ...args),
})
const handlers = createHandlers({ config, session, python })

const results = []
let failures = 0

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function compareMetrics(name, actual, expected) {
  const problems = []
  for (const key of ['mean', 'p50', 'clipHi', 'clipLo', 'sat']) {
    if (expected[key] === undefined) continue
    const tolerance = TOLERANCE[key]
    const delta = Math.abs(Number(actual[key]) - Number(expected[key]))
    if (!(delta <= tolerance)) problems.push(`${key} ${actual[key]} vs ${expected[key]} (Δ${delta.toFixed(4)} > ${tolerance})`)
  }
  if (expected.sharp !== undefined) {
    const deltaPct = Math.abs((Number(actual.sharp) - Number(expected.sharp)) / Math.max(Number(expected.sharp), 1e-9) * 100)
    if (!(deltaPct <= TOLERANCE.sharpRelPct)) problems.push(`sharp ${actual.sharp} vs ${expected.sharp} (Δ${deltaPct.toFixed(2)}% > ${TOLERANCE.sharpRelPct}%)`)
  }
  assert(problems.length === 0, `${name}: metrics differ from baseline — ${problems.join('; ')}`)
}

function record(entry) {
  results.push(entry)
  const mark = entry.pass ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  if (!entry.pass) failures += 1
}

/** Assert that `actual` contains every leaf of `expected` (nested subset match). */
function assertSubset(label, actual, expected, depth = 0) {
  if (expected === null || typeof expected !== 'object') {
    assert(Object.is(actual, expected), `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
    return
  }
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual) && actual.length === expected.length, `${label}: array length mismatch`)
    expected.forEach((item, index) => assertSubset(`${label}[${index}]`, actual[index], item, depth + 1))
    return
  }
  assert(actual !== null && typeof actual === 'object', `${label}: expected object, got ${JSON.stringify(actual)}`)
  for (const [key, value] of Object.entries(expected)) {
    assertSubset(`${label}.${key}`, actual[key], value, depth + 1)
  }
}

async function runCheck(check) {
  const startedAt = Date.now()
  const source = path.resolve(check.source)
  if (!fs.existsSync(source)) throw new Error(`source image not found: ${source}`)
  const common = { source, title: `acceptance-${check.name}` }

  if (check.type === 'auto') {
    const result = await handlers.grade({
      ...common,
      ...(check.auto || {}),
      ...(check.preprocess && typeof check.preprocess === 'object' ? { preprocess: check.preprocess } : {}),
      auto: check.auto === false ? false : true,
    })
    const expect = check.expect || {}
    if (expect.recipe) assert(result.auto && result.auto.recipe === expect.recipe, `auto recipe ${result.auto && result.auto.recipe} != expected ${expect.recipe}`)
    if (expect.baselineAfter) compareMetrics(check.name, result.metrics.after, expect.baselineAfter)
    if (expect.preprocess !== undefined) {
      assert(Boolean(result.preprocess) === Boolean(expect.preprocess), `preprocess ${Boolean(result.preprocess)} != expected ${Boolean(expect.preprocess)}`)
    }
    if (expect.scene) assert(result.auto && result.auto.scene === expect.scene, `scene ${result.auto && result.auto.scene} != expected ${expect.scene}`)
    if (expect.caseDistance !== undefined) {
      assert(result.auto && result.auto.case, 'expected a case-bank hit but auto mode did not hit one')
      assert(Math.abs(Number(result.auto.case.distance) - Number(expect.caseDistance)) <= 0.001, `case distance ${result.auto.case.distance} != expected ${expect.caseDistance}`)
    }
    if (expect.plan) {
      assert(result.auto && result.auto.plan, 'auto mode did not produce a plan')
      assertSubset(`${check.name}.plan`, result.auto.plan, expect.plan)
    }
    if (expect.width) assert(result.metrics.after.width === expect.width, `output width ${result.metrics.after.width} != ${expect.width}`)
    if (expect.height) assert(result.metrics.after.height === expect.height, `output height ${result.metrics.after.height} != ${expect.height}`)
    if (expect.orientation) {
      assert(result.orientation, 'expected an EXIF orientation record but none was produced')
      assertSubset(`${check.name}.orientation`, result.orientation, expect.orientation)
    }
    if (expect.superResolutionMethod) {
      assert(result.superResolution && result.superResolution.method === expect.superResolutionMethod,
        `superResolution method ${result.superResolution && result.superResolution.method} != ${expect.superResolutionMethod}`)
    }
    if (expect.engine) assert(result.superResolution && result.superResolution.engine === expect.engine, `superResolution engine ${result.superResolution && result.superResolution.engine} != ${expect.engine}`)
    return {
      detail: `recipe=${result.auto && result.auto.recipe} scene=${result.auto && result.auto.scene}`
        + (result.auto && result.auto.plan ? ` plan=${result.auto.plan.sourceKind}/${result.auto.plan.crop}/sr=${result.auto.plan.superResolution.triggered ? result.auto.plan.superResolution.scale + 'x' : 'off'}` : '')
        + ` checks=${result.checks.filter((item) => item.pass).length}/${result.checks.length}`
        + (result.superResolution ? ` sr=${result.superResolution.method}×${result.superResolution.scale}` : '')
        + ` after=${result.metrics.after.width}×${result.metrics.after.height}`,
      result,
    }
  }

  if (check.type === 'case') {
    // 1) produce a normal version, 2) learn-only call records it (same code path
    // as the documented `{project, learn}` workflow), 3) auto must hit it at
    // distance 0 and reuse the learned recipe/params.
    const first = await handlers.grade({
      source,
      recipe: check.recipe || 'clean-premium',
      params: check.params || {},
      title: `acceptance-${check.name}-grade`,
    })
    const learned = await handlers.grade({
      project: first.project,
      source,
      learn: { version: first.version, note: 'acceptance' },
    })
    assert(learned.learned, 'learn call did not record a case')
    assert(learned.learned.persisted !== false, 'learned case was not persisted')
    const auto = await handlers.grade({
      source,
      auto: true,
      title: `acceptance-${check.name}-auto`,
    })
    assert(auto.auto && auto.auto.case, 'auto mode did not hit the learned case')
    assert(Number(auto.auto.case.distance) <= 0.001, `case distance ${auto.auto.case.distance} != 0`)
    return {
      detail: `learned ${learned.learned.id} (${learned.learned.recipe}) -> auto case ${auto.auto.case.id} distance ${auto.auto.case.distance} recipe ${auto.auto.recipe}`,
      result: auto,
    }
  }

  if (check.type === 'selfheal') {
    const result = await handlers.grade({ ...common, ...(check.auto || {}), auto: true })
    assert(result.selfHeal && result.selfHeal.attempted === true, 'auto self-heal did not trigger')
    assert(Number(result.version) >= 2, `expected a retry version >= 2, got v${result.version}`)
    const firstFailed = (result.selfHeal.firstChecks || []).filter((item) => !item.pass).map((item) => item.name)
    assert(firstFailed.length > 0, 'self-heal triggered without any failing check')
    return {
      detail: `first checks failed: ${firstFailed.join(',')} -> healed to v${result.version}`,
      result,
    }
  }

  if (check.type === 'manual') {
    const result = await handlers.grade({
      ...common,
      recipe: check.recipe || 'clean-premium',
      params: check.params || {},
      style: check.style,
      crop: check.crop,
      ...(check.preprocess && typeof check.preprocess === 'object' ? { preprocess: check.preprocess } : {}),
      title: `acceptance-${check.name}-manual`,
    })
    const expect = check.expect || {}
    if (expect.styleApplied !== undefined) {
      assert(Boolean(result.style && result.style.applied) === Boolean(expect.styleApplied), `style applied ${Boolean(result.style && result.style.applied)} != expected ${expect.styleApplied}`)
    }
    if (expect.styleSource) {
      assert(result.style && result.style.source === expect.styleSource, `style source ${result.style && result.style.source} != ${expect.styleSource}`)
      assert(result.style.params === true, 'user style was not reported as carrying a parameter preset')
    }
    if (expect.checksPass !== false) {
      const failed = result.checks.filter((item) => !item.pass)
      assert(failed.length === 0, `quality checks failed: ${failed.map((item) => item.name).join(', ')}`)
    }
    if (expect.width) assert(result.metrics.after.width === expect.width, `output width ${result.metrics.after.width} != ${expect.width}`)
    if (expect.height) assert(result.metrics.after.height === expect.height, `output height ${result.metrics.after.height} != ${expect.height}`)
    if (expect.baselineAfter) compareMetrics(check.name, result.metrics.after, expect.baselineAfter)
    return {
      detail: `recipe=${result.recipe.name} checks=${result.checks.filter((item) => item.pass).length}/${result.checks.length}${result.style ? ` style=${result.style.name}(${result.style.applied ? 'applied' : 'skipped'})` : ''}`,
      result,
    }
  }

  if (check.type === 'superres') {
    const result = await handlers.grade({
      ...common,
      recipe: check.recipe || 'clean-premium',
      params: check.params || {},
      crop: check.crop,
      preprocess: {
        superResolution: {
          enabled: true,
          mode: check.mode || 'always',
          scale: Number(check.scale) || 2,
          ...(check.superResolution || {}),
        },
      },
    })
    const expect = check.expect || {}
    assert(result.superResolution, 'superResolution preprocessing did not run')
    assert(['lanczos', 'external-ai', 'lanczos-fallback'].includes(result.superResolution.method), `unexpected SR method ${result.superResolution.method}`)
    if (expect.method) assert(result.superResolution.method === expect.method, `SR method ${result.superResolution.method} != ${expect.method}`)
    if (expect.engine) assert(result.superResolution.engine === expect.engine, `SR engine ${result.superResolution.engine} != ${expect.engine}`)
    if (expect.chain) assertSubset(`${check.name}.chain`, result.superResolution.chain, expect.chain)
    if (expect.fallbackFrom) assert(result.superResolution.fallbackFrom === expect.fallbackFrom, `SR fallbackFrom ${result.superResolution.fallbackFrom} != ${expect.fallbackFrom}`)
    const wantedScale = Number(check.scale) || 2
    assert(Math.abs(Number(result.superResolution.scale) - wantedScale) < 0.05, `SR scale ${result.superResolution.scale} != ${wantedScale}`)
    assert(result.resolution && result.resolution.upscale, 'resolution.upscale missing')
    if (expect.warningIncludes) {
      const text = (result.warnings || []).join('\n')
      for (const needle of [].concat(expect.warningIncludes)) {
        assert(text.includes(needle), `warnings do not contain "${needle}"`)
      }
    }
    if (expect.outputWidth) assert(result.metrics.after.width === expect.outputWidth, `output width ${result.metrics.after.width} != ${expect.outputWidth}`)
    if (expect.outputHeight) assert(result.metrics.after.height === expect.outputHeight, `output height ${result.metrics.after.height} != ${expect.outputHeight}`)
    return {
      detail: `SR ${result.superResolution.method} ×${result.superResolution.scale} → ${result.metrics.after.width}×${result.metrics.after.height}（${result.superResolution.reason}）`,
      result,
    }
  }

  throw new Error(`unknown check type: ${check.type}`)
}

let exitCode = 0
const startedAt = Date.now()
try {
  console.log('python:', python)
  console.log('lutDir:', resolveLutDir(config.lutDir) || '(none found)')
  console.log('projectRoot:', projectRoot)
  console.log('casesFile:', casesFile)
  const state = await handlers.state({ start: true })
  if (!state.session.running) throw new Error('Photoshop session did not start')
  console.log(`Photoshop ready (${state.session.version})\n`)
  try {
    const expectedStyles = 5 + (manifest.stylesFile ? 1 : 0)
    assert(state.styles.length >= 5, `expected at least 5 styles, got ${state.styles.length}`)
    if (manifest.stylesFile) {
      assert(state.styles.some((style) => style.source === 'user'), 'user stylesFile was not merged into the style list')
    }
    assert(state.recipes.length === 19, `expected 19 recipes, got ${state.recipes.length}`)
    assert(state.styles.length >= expectedStyles, `expected ${expectedStyles} styles, got ${state.styles.length}`)
    assert(state.lutDir, 'no Photoshop 3DLUTs folder detected (PSD styles cannot work)')
    record({
      name: 'ps_state',
      type: 'preflight',
      pass: true,
      detail: `PS ${state.session.version} · ${state.recipes.length} recipes · ${state.styles.length} styles · lutDir=${state.lutDir} · ${state.autoCases.length} seed cases`,
    })
  } catch (error) {
    record({ name: 'ps_state', type: 'preflight', pass: false, detail: error?.message || String(error) })
  }

  for (const check of checks) {
    const checkStartedAt = Date.now()
    try {
      const { detail, result } = await runCheck(check)
      record({ name: check.name, type: check.type, pass: true, detail, durationMs: Date.now() - checkStartedAt, version: result.version, checks: result.checks })
    } catch (error) {
      record({ name: check.name, type: check.type, pass: false, detail: error?.message || String(error), durationMs: Date.now() - checkStartedAt })
    }
  }
} catch (error) {
  exitCode = 1
  console.error('ACCEPTANCE ABORTED:', error?.stack || error)
} finally {
  try { await session.quit() } catch { /* ignore */ }
}

const report = {
  ok: failures === 0 && exitCode === 0,
  manifest: manifestPath,
  startedAt: new Date(startedAt).toISOString(),
  durationMs: Date.now() - startedAt,
  python,
  lutDir: resolveLutDir(config.lutDir),
  projectRoot,
  casesFile,
  tolerance: TOLERANCE,
  checks: results,
}
const reportPath = manifest.reportPath ? path.resolve(manifest.reportPath) : path.join(resultsRoot, `report-${stamp}.json`)
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

console.log(`\n${results.filter((item) => item.pass).length}/${results.length} acceptance checks passed`)
console.log('report:', reportPath)
if (failures > 0 || exitCode !== 0) process.exit(1)
