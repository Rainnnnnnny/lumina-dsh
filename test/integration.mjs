/**
 * Full-pipeline smoke test. Requires a local Photoshop install.
 *
 *   node test/integration.mjs "C:\path\to\shot.png"
 *
 * Env:
 *   LUMINA_ROOT      project root for the test (default <repo>/test-results/integration-projects)
 *   LUMINA_RECIPE    first recipe (default clean-premium)
 *   LUMINA_STYLE     optional style to verify LUT resolution (e.g. cinema)
 *   LUMINA_PYTHON    optional python override
 *
 * Grades one image, appends a second version to the same project, re-measures
 * the output and prints a JSON summary. Exits non-zero on failure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHandlers } from '../lib/grade.js'
import { resolvePython } from '../lib/py.js'
import { PsSession } from '../lib/ps-session.js'
import { resolveLutDir } from '../lib/ps-locate.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2] || process.env.LUMINA_SOURCE
if (!source) {
  console.error('usage: node test/integration.mjs <source-image>')
  process.exit(2)
}
const resolvedSource = path.resolve(source)
if (!fs.existsSync(resolvedSource)) {
  console.error('source image not found:', resolvedSource)
  process.exit(2)
}

const root = process.env.LUMINA_ROOT || path.join(REPO, 'test-results', 'integration-projects')
const recipe = process.env.LUMINA_RECIPE || 'clean-premium'
const style = process.env.LUMINA_STYLE || ''
const python = resolvePython(process.env.LUMINA_PYTHON)
const config = {
  projectRoot: root,
  casesFile: path.join(REPO, 'test-results', 'integration-cases.json'),
  psWaitMs: 120000,
  opTimeoutMs: 300000,
}
const session = new PsSession({
  waitMs: config.psWaitMs,
  opTimeoutMs: config.opTimeoutMs,
  logger: (...args) => console.error('[ps-session]', ...args),
})
const handlers = createHandlers({ config, session, python })

let exitCode = 0
const startedAt = Date.now()
try {
  console.log('python:', python)
  console.log('lutDir:', resolveLutDir() || '(none found)')
  const state = await handlers.state({ start: true })
  console.log(`Photoshop ${state.session.running ? `ready (${state.session.version})` : 'NOT READY'}`)
  if (!state.session.running) throw new Error('Photoshop session did not start')

  console.log('--- grade v1 ---')
  const first = await handlers.grade({ source: resolvedSource, recipe, title: 'integration-smoke' })
  if (!first.ok || !fs.existsSync(first.output)) throw new Error('grade v1 did not produce an output image')

  console.log('--- grade v2 (append, different recipe) ---')
  const second = await handlers.grade({ project: first.project, recipe: 'cinematic-film', params: { vignette: 30 } })
  if (!second.ok || !fs.existsSync(second.output)) throw new Error('grade v2 did not produce an output image')

  let styleResult = null
  if (style) {
    console.log(`--- grade v${second.version + 1} (style: ${style}) ---`)
    const styled = await handlers.grade({ project: first.project, recipe: first.recipe.name, style })
    styleResult = styled.style || null
    console.log('style:', JSON.stringify(styleResult))
    if (styled.style && styled.style.applied === true) {
      console.log('style LUT applied:', styled.style.lut)
    } else {
      console.log('note: style LUT not applied (missing local Photoshop LUT folder?)')
    }
  }

  const measured = await handlers.measure({ path: second.output })
  const summary = {
    ok: true,
    project: first.project,
    versions: [first.version, second.version],
    durationMs: Date.now() - startedAt,
    checks: second.checks.map((check) => ({ name: check.name, pass: check.pass })),
    metrics: second.metrics.after,
    style: styleResult,
    output: second.output,
  }
  console.log('\n' + JSON.stringify(summary, null, 2))
  // A user-provided image is not guaranteed to satisfy every recipe's QA
  // thresholds — that is what the checks field is for. The integration test
  // only requires that the whole pipeline ran and produced measurable output.
  const failed = second.checks.filter((check) => !check.pass)
  if (failed.length > 0) {
    console.log(`\nnote: ${failed.length}/${second.checks.length} QA checks failed (${failed.map((check) => check.name).join(', ')}); pass with different params if this matters`)
  }
  console.log(`\nINTEGRATION OK in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — measured ${measured.metrics.width}x${measured.metrics.height}`)
} catch (error) {
  exitCode = 1
  console.error('INTEGRATION FAILED:', error?.stack || error)
} finally {
  try { await session.quit() } catch { /* ignore */ }
}
process.exit(exitCode)
