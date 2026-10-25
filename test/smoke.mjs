/**
 * Fast smoke tests — no Photoshop required.
 *
 *   node test/smoke.mjs
 *
 * Covers:
 *   1. package metadata / npm allowlist is publishable and excludes private data
 *   2. plugin loads and registers exactly the six public tools
 *   3. config defaults are portable (project root under the user home)
 *   4. recipes/styles load with the 17 recipes and 5 styles and relative LUT names
 *   5. LUT resolution works from an explicit lutDir and Photoshop detection is
 *      consistent with the registry when the registry is readable
 *   6. the two-layer auto-case bank merges seed + user banks and learns
 *   7. a simulated fresh install resolves the package from a clean profile and
 *      loads it with a different (fake) user home — no machine paths needed
 *   8. repository hygiene: publishable files contain no private paths and no
 *      Adobe LUT binaries are bundled
 *
 * Everything runs in-process or under test-results/; nothing touches Photoshop
 * or the user's project folders. All temp folders created here are removed again
 * (set LUMINA_KEEP_TMP=1 to keep them for debugging).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(REPO, 'test-results')
// Keep the smoke run independent of this machine's real user config file.
const PREVIOUS_CONFIG_ENV = process.env.LUMINA_CONFIG
const ISOLATED_CONFIG = path.join(WORK, 'no-user-config.json')
process.env.LUMINA_CONFIG = ISOLATED_CONFIG

let failures = 0
let checks = 0
const createdDirs = []

async function check(name, fn) {
  checks += 1
  try {
    const detail = await fn()
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error?.message || error}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function tmpDir(prefix) {
  fs.mkdirSync(WORK, { recursive: true })
  const base = path.join(WORK, `${prefix}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(base, { recursive: true })
  createdDirs.push(base)
  return base
}

/** Remove a temp directory, never following an NTFS junction into the repo. */
function removeDirSafe(dir) {
  if (process.env.LUMINA_KEEP_TMP) return
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      // NTFS junctions report as directories but are reparse points: rmSync
      // recursion would follow them. rmdirSync removes the link itself.
      if (entry.isSymbolicLink() || (entry.isDirectory() && fs.lstatSync(full).isSymbolicLink())) {
        try { fs.rmdirSync(full) } catch { /* ignore */ }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    createdDirs.splice(createdDirs.indexOf(dir), 1)
  } catch {
    // Best effort: a leftover test folder must not fail the smoke run.
  }
}

function mockCtx() {
  const tools = []
  return {
    tools: {
      register(tool) { tools.push(tool) },
    },
    attachments: {
      async saveImage() { return { type: 'image', path: 'unused.png' } },
    },
    list() { return tools },
  }
}

const EXPECTED_TOOLS = ['ps_grade', 'ps_measure', 'ps_state', 'vision_zoom', 'vision_probe', 'vision_textmap']

// ---------------------------------------------------------------------------
// 1-3. plugin load + portable defaults
// ---------------------------------------------------------------------------
const plugin = await import(pathToFileURL(path.join(REPO, 'index.js')).href)
const configuredRoot = path.join(tmpDir('lumina-smoke'), 'projects')
const mainCtx = mockCtx()
plugin.apply(mainCtx, { projectRoot: configuredRoot })

await check('package metadata and npm allowlist are publishable', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  assert(pkg.name === 'lumina-dsh', `package name is ${pkg.name}`)
  assert(pkg.license === 'MIT', 'license must be MIT')
  assert(!pkg.private, 'package must not be private')
  assert(pkg.exports['.'] === './index.js', 'exports["."] must point at index.js')
  assert(Array.isArray(pkg.files) && pkg.files.includes('index.js'), 'files[] must include index.js')
  assert(fs.existsSync(path.join(REPO, pkg.icon || 'icon.svg')), 'icon file missing')
  for (const forbidden of ['assets/auto-cases.json', 'test-results', 'acceptance-results', 'standalone.mjs', 'probe-']) {
    assert(!pkg.files.some((entry) => String(entry).includes(forbidden)), `files[] must not allowlist ${forbidden}`)
  }
  return `${pkg.name}@${pkg.version} ${pkg.license}`
})

await check('six public tools register', () => {
  const names = mainCtx.list().map((tool) => tool.name)
  for (const expected of EXPECTED_TOOLS) assert(names.includes(expected), `missing tool ${expected}`)
  assert(names.length === EXPECTED_TOOLS.length, `unexpected tools: ${names.join(', ')}`)
  for (const tool of mainCtx.list()) {
    assert(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} has no description`)
    assert(tool.parameters && tool.parameters.type === 'object', `${tool.name} has no parameter schema`)
    assert(typeof tool.execute === 'function', `${tool.name} is not executable`)
  }
  return names.join(', ')
})

await check('tool descriptions point at the configured project root', () => {
  const grade = mainCtx.list().find((tool) => tool.name === 'ps_grade')
  const state = mainCtx.list().find((tool) => tool.name === 'ps_state')
  assert(grade.description.includes(configuredRoot), `ps_grade description does not mention ${configuredRoot}`)
  assert(state.description.includes(configuredRoot), `ps_state description does not mention ${configuredRoot}`)
  return 'config-driven'
})

await check('default project root is portable (<home>/Lumina)', () => {
  const native = plugin.defaultProjectRoot()
  assert(path.isAbsolute(native), 'default project root must be absolute')
  assert(!new RegExp('^[A-Z]:' + '\\\\{1,2}' + 'A' + 'IPS', 'i').test(native), `default project root leaked a machine path: ${native}`)
  assert(native.startsWith(os.homedir()), `default project root must be under the user home: ${native}`)
  const previous = process.env.LUMINA_PROJECT_ROOT
  process.env.LUMINA_PROJECT_ROOT = path.join(tmpDir('lumina-env-root'), 'custom')
  try {
    assert(plugin.defaultProjectRoot() === path.resolve(process.env.LUMINA_PROJECT_ROOT), 'LUMINA_PROJECT_ROOT is not honoured')
  } finally {
    if (previous === undefined) delete process.env.LUMINA_PROJECT_ROOT
    else process.env.LUMINA_PROJECT_ROOT = previous
  }
  return native
})

await check('user config file drives projectRoot and dataDir (<home> stays portable)', async () => {
  const userConfigModule = await import(pathToFileURL(path.join(REPO, 'lib', 'user-config.js')).href)
  const dir = tmpDir('lumina-user-config')
  const configFile = path.join(dir, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({
    projectRoot: path.join(dir, 'ProjectsOnD'),
    dataDir: path.join(dir, 'DataOnD'),
    superResolution: { enabled: true, minLongEdge: 999 },
  }, null, 2))
  process.env.LUMINA_CONFIG = configFile
  try {
    const loaded = userConfigModule.loadUserConfig()
    assert(loaded.projectRoot.endsWith('ProjectsOnD'), 'user config projectRoot not loaded')
    assert(loaded.dataDir.endsWith('DataOnD'), 'user config dataDir not loaded')
    assert(plugin.defaultProjectRoot() === path.resolve(loaded.projectRoot), 'defaultProjectRoot does not honour the user config')
    assert(userConfigModule.dataDirFile(loaded, 'styles.json') === path.join(path.resolve(loaded.dataDir), 'styles.json'), 'dataDirFile join failed')
    return path.relative(REPO, path.resolve(loaded.projectRoot))
  } finally {
    process.env.LUMINA_CONFIG = ISOLATED_CONFIG
  }
})

// ---------------------------------------------------------------------------
// 4. recipes + styles
// ---------------------------------------------------------------------------
const recipesModule = await import(pathToFileURL(path.join(REPO, 'lib', 'recipes.js')).href)

await check('19 recipes and 5 styles load', () => {
  const list = recipesModule.listRecipes()
  const styles = recipesModule.listStyles()
  assert(list.length === 19, `expected 17 recipes, got ${list.length}`)
  assert(list.some((item) => item.name === 'clean-premium'), 'clean-premium missing')
  assert(styles.map((item) => item.name).join(',') === 'natural,cinema,vivid,still,soft', 'style names changed')
  return `${list.length} recipes / ${styles.length} styles`
})

await check('style LUT entries are Photoshop-relative names, not machine paths', () => {
  const luts = recipesModule.listStyles().filter((style) => style.lut).map((style) => style.lut)
  assert(luts.length === 4, `expected 4 LUT styles, got ${luts.length}`)
  for (const lut of luts) {
    assert(!path.isAbsolute(lut), `style LUT is an absolute machine path: ${lut}`)
    assert(lut.toLowerCase().endsWith('.cube'), `style LUT is not a .cube name: ${lut}`)
  }
  return luts.map((lut) => path.basename(lut)).join(', ')
})

await check('user style pack hot-loads and can override a built-in style', () => {
  const dir = tmpDir('lumina-styles')
  const stylesFile = path.join(dir, 'styles.json')
  fs.writeFileSync(stylesFile, JSON.stringify({
    styles: {
      'my-look': {
        label: 'My look',
        lut: null,
        strength: 0,
        description: 'parameter-only custom style',
        params: { vignette: 42, tone: { gamma: 0.9 } },
      },
      cinema: { label: 'Cinema override', lut: 'Kodak 5218 Kodak 2383 (by Adobe).cube', strength: 50 },
    },
  }, null, 2))
  recipesModule.configureRecipes({ stylesFile })
  try {
    const styles = recipesModule.listStyles()
    const custom = styles.find((style) => style.name === 'my-look')
    assert(custom, 'custom style missing from listStyles()')
    assert(custom.source === 'user', 'custom style source is not user')
    assert(custom.hasParams === true, 'custom style params flag missing')
    const overridden = styles.find((style) => style.name === 'cinema')
    assert(overridden.label === 'Cinema override' && overridden.strength === 50, 'user style did not override the built-in one')
    const def = recipesModule.getStyle('my-look')
    assert(def.params && def.params.vignette === 42, 'custom style params not readable')
    // Unknown styles fail with a helpful message (the style param is a free string).
    let message = ''
    try { recipesModule.getStyle('does-not-exist') } catch (error) { message = String(error.message) }
    assert(message.includes('my-look'), 'unknown-style error does not list available styles')
    return `${styles.length} styles (incl. user pack)`
  } finally {
    recipesModule.configureRecipes({ stylesFile: null })
  }
})

await check('plugin config wires the hot style pack and super-resolution into ps_state', async () => {
  const dir = tmpDir('lumina-style-wire')
  const stylesFile = path.join(dir, 'styles.json')
  fs.writeFileSync(stylesFile, JSON.stringify({
    styles: { 'wired-look': { label: 'Wired look', lut: null, params: { vignette: 30 } } },
  }, null, 2))
  const ctx = mockCtx()
  plugin.apply(ctx, {
    projectRoot: path.join(dir, 'projects'),
    stylesFile,
    superResolution: { enabled: true, mode: 'auto', minLongEdge: 1600, scale: 2 },
  })
  const state = await ctx.list().find((tool) => tool.name === 'ps_state').execute({})
  const wired = state.styles.find((style) => style.name === 'wired-look')
  assert(wired && wired.source === 'user', 'plugin stylesFile config did not reach the style loader')
  assert(state.stylesFile === path.resolve(stylesFile), `ps_state reports stylesFile ${state.stylesFile}`)
  assert(state.stylesFileExists === true, 'ps_state should report stylesFileExists for a real pack')
  assert(state.superResolution && state.superResolution.enabled === true, 'superResolution config did not reach ps_state')
  assert(Number(state.superResolution.minLongEdge) === 1600, 'superResolution.minLongEdge not honoured')
  return 'stylesFile + superResolution config wired'
})

// ---------------------------------------------------------------------------
// 5. LUT resolution + Photoshop detection
// ---------------------------------------------------------------------------
const locate = await import(pathToFileURL(path.join(REPO, 'lib', 'ps-locate.js')).href)

await check('LUT resolution uses an explicit lutDir', () => {
  const dir = tmpDir('lumina-lut')
  fs.writeFileSync(path.join(dir, 'sample.cube'), 'LUT_3D_SIZE 2\n')
  assert(locate.resolveLutDir(dir) === path.resolve(dir), 'explicit lutDir is not used')
  const resolved = locate.resolveLut('sample.cube', { lutDir: dir })
  assert(resolved === path.join(path.resolve(dir), 'sample.cube'), 'bare LUT name is not resolved')
  assert(locate.resolveLut('missing.cube', { lutDir: dir }) === null, 'missing LUT should not resolve')
  assert(locate.resolveLut('', { lutDir: dir }) === null, 'empty LUT should not resolve')
  return path.basename(resolved)
})

await check('Photoshop detection is consistent with the registry (when readable)', () => {
  const installs = locate.detectPhotoshopInstalls()
  const lutDir = locate.resolveLutDir()
  assert(Array.isArray(installs), 'detectPhotoshopInstalls must return an array')
  let registryInstall = ''
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Adobe\\Photoshop', '/s', '/v', 'ApplicationPath'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
      )
      const match = /ApplicationPath\s+REG_\w+\s+([^\r\n]+)/i.exec(String(output))
      if (match) registryInstall = match[1].trim()
    } catch {
      registryInstall = '' // registry probe blocked (e.g. by a sandbox) or no Adobe key
    }
  }
  if (registryInstall) {
    assert(fs.existsSync(registryInstall), `registry advertises a missing Photoshop path: ${registryInstall}`)
    assert(
      installs.some((dir) => dir.toLowerCase() === path.resolve(registryInstall).toLowerCase()),
      `registry advertises ${registryInstall} but detection returned: ${installs.join(', ') || '(none)'}`,
    )
    assert(lutDir, `detected Photoshop ${registryInstall} but no Presets/3DLUTs folder`)
  } else if (process.platform === 'win32') {
    console.log('      note: registry probe unavailable or Adobe key absent; filesystem-only result accepted')
  }
  assert(lutDir === null || fs.existsSync(lutDir), `resolved LUT dir does not exist: ${lutDir}`)
  return `${installs.length} install(s), lutDir=${lutDir || 'none'}${registryInstall ? ', registry-backed' : ''}`
})

// ---------------------------------------------------------------------------
// 6. auto-case bank (seed + user layers)
// ---------------------------------------------------------------------------
const cases = await import(pathToFileURL(path.join(REPO, 'lib', 'cases.js')).href)

await check('case bank merges seed + user layers and learns', () => {
  const dir = tmpDir('lumina-cases')
  const seedFile = path.join(dir, 'seed.json')
  const userFile = path.join(dir, 'user.json')
  const seedCase = {
    id: 'seed-1', recipe: 'clean-premium', style: 'natural', scene: 'landscape',
    features: { clipPct: 1, washPct: 2, mean: 0.5, p50: 0.5, skinBlob: 0, scene: 0 },
  }
  fs.writeFileSync(seedFile, JSON.stringify({ version: 1, cases: [seedCase] }))
  cases.configureCases({ seedFile, userFile })
  try {
    assert(cases.readBank().cases.length === 1, 'seed bank not read')
    const learned = cases.addCase({
      recipe: 'cinematic-film', style: 'natural', scene: 'character',
      features: { clipPct: 1, washPct: 2, mean: 0.5, p50: 0.5, skinBlob: 0, scene: 1 },
    })
    assert(learned.persisted === true, 'learned case was not persisted')
    assert(cases.readBank().cases.length === 2, 'user bank not merged')
    const hit = cases.findNearestCase({ clipPct: 1, washPct: 2, mean: 0.5, p50: 0.5, skinBlobAreaFrac: 0 }, 'landscape')
    assert(hit && hit.distance === 0, `expected a distance-0 case hit, got ${JSON.stringify(hit)}`)
    const bank = cases.caseBankInfo()
    assert(bank.seedCases === 1 && bank.userCases === 1, 'case bank info wrong')
    return `${bank.seedCases} seed + ${bank.userCases} user cases, hit distance ${hit.distance}`
  } finally {
    // Restore the module defaults so later checks see the real home/package paths.
    cases.configureCases({})
  }
})

// ---------------------------------------------------------------------------
// 7. super-resolution planner (pure logic, no Photoshop/Python)
// ---------------------------------------------------------------------------
await check('super-resolution planner triggers/clamps correctly', async () => {
  const superres = await import(pathToFileURL(path.join(REPO, 'lib', 'superres.js')).href)
  const lowRes = { width: 800, height: 600 }
  const highRes = { width: 4000, height: 3000 }

  const disabled = superres.planSuperResolution(lowRes, { enabled: false })
  assert(disabled.triggered === false, 'disabled superResolution must not trigger')

  const auto = superres.planSuperResolution(lowRes, { enabled: true, mode: 'auto', minLongEdge: 1600, scale: 2 })
  assert(auto.triggered === true && auto.scale === 2, `low-res image should trigger 2x, got ${JSON.stringify(auto)}`)

  const big = superres.planSuperResolution(highRes, { enabled: true, mode: 'auto', minLongEdge: 1600, scale: 2 })
  assert(big.triggered === false, 'large image must not auto-trigger')

  const blurred = superres.planSuperResolution(highRes, { enabled: true, mode: 'auto', minLongEdge: 1600, minSharpness: 0.02, scale: 2 }, { sharpness: 0.01 })
  assert(blurred.triggered === true, 'low-sharpness image should trigger when minSharpness is set')

  const clamped = superres.planSuperResolution({ width: 6000, height: 3000 }, { enabled: true, mode: 'always', scale: 2, maxLongEdge: 8192 })
  assert(clamped.triggered === true, 'mode=always must trigger')
  assert(Math.abs(clamped.scale - 8192 / 6000) < 0.001, `scale not clamped by maxLongEdge: ${clamped.scale}`)

  const capped = superres.planSuperResolution({ width: 5000, height: 4000 }, { enabled: true, mode: 'auto', scale: 2, maxLongEdge: 8192, minLongEdge: 1600 })
  assert(capped.triggered === false, 'image already at maxLongEdge must not trigger')
  return `auto=${auto.scale}x, clamp=${clamped.scale.toFixed(3)}x`
})

// ---------------------------------------------------------------------------
// 8. universal auto plan: screenshots / photos / blurry-low-res
// ---------------------------------------------------------------------------
await check('universal auto plan: screenshots, photos, blurry/low-res images', async () => {
  const assess = await import(pathToFileURL(path.join(REPO, 'lib', 'assess.js')).href)
  const screenshot = assess.planAuto({
    longEdge: 3440, shortEdge: 1578, aspect: 2.18, megapixels: 5.43,
    blurScore: 0.0758, noiseScore: 0.0126, clipHi: 12.2, stripPx: 149, confidence: 'high',
    exif: { hasExif: false, hasCamera: false, orientation: 1 },
  })
  assert(screenshot.sourceKind === 'screenshot', `screenshot misclassified: ${screenshot.sourceKind}`)
  assert(screenshot.crop === 'bottom-strip', 'screenshot should trim the UI strip')
  assert(screenshot.superResolution.triggered === false, 'sharp 3440px screenshot must not be upscaled')

  const photo = assess.planAuto({
    longEdge: 4032, shortEdge: 3024, aspect: 1.333, megapixels: 12.19,
    blurScore: 0.0229, noiseScore: 0.0055, clipHi: 0.01, stripPx: 0, confidence: 'none',
    exif: { hasExif: true, hasCamera: false, orientation: 1 },
  })
  assert(photo.sourceKind === 'photo', `photo misclassified: ${photo.sourceKind}`)
  assert(photo.crop === 'auto', 'photos must use the conservative auto crop')
  assert(photo.recipeHint === 'hdr-photo', 'photo should map to the HDR-look recipe')
  assert(photo.superResolution.triggered === false, 'large sharp photo must not be upscaled')

  const softPhoto = assess.planAuto({
    longEdge: 4032, shortEdge: 3024, aspect: 1.333, megapixels: 12.19,
    blurScore: 0.005, noiseScore: 0.02, clipHi: 0, stripPx: 0, confidence: 'none',
    exif: { hasExif: true, hasCamera: false, orientation: 1 },
  })
  assert(softPhoto.superResolution.triggered === false, 'very large blurry photo should not auto-upscale')
  assert(softPhoto.restoreHint.length > 0, 'large blurry photo should get a restore hint')

  const lowRes = assess.planAuto({
    longEdge: 900, shortEdge: 600, aspect: 1.5, megapixels: 0.54,
    blurScore: 0.004, noiseScore: 0.01, clipHi: 0, stripPx: 0, confidence: 'none',
    exif: { hasExif: false, hasCamera: false, orientation: 1 },
  })
  assert(lowRes.superResolution.triggered === true, 'low-resolution image should trigger super-resolution')
  assert(lowRes.superResolution.scale === 2, `expected 2x plan, got ${lowRes.superResolution.scale}`)
  return `screenshot=${screenshot.sourceKind}/${screenshot.crop}, photo=${photo.sourceKind}/${photo.crop}, lowRes=${lowRes.superResolution.scale}x`
})

// ---------------------------------------------------------------------------
// 9. super-resolution output validation (corrupt-frame guard)
// ---------------------------------------------------------------------------
await check('quality-first engine chain ordering', async () => {
  const superres = await import(pathToFileURL(path.join(REPO, 'lib', 'superres.js')).href)
  const chain = superres.resolveEngineChain({
    command: 'D:/ai/run.cmd',
    args: [],
    engines: {
      onnx: { command: 'D:/ai/ort.cmd', args: [], priority: 30, label: 'ONNX-DML' },
      cuda: { command: 'D:/ai/torch.cmd', args: ['--kind', '{sourceKind}'], priority: 100, label: 'CUDA Real-ESRGAN' },
      vulkan: { command: 'D:/ai/waifu2x.exe', args: [], priority: 50, label: 'waifu2x-Vulkan' },
    },
  })
  assert(chain.length === 4, `expected 4 engines, got ${chain.length}`)
  assert(chain[1].label === 'CUDA Real-ESRGAN', `quality order wrong: ${chain.map((e) => e.label).join(' > ')}`)
  assert(chain[2].label === 'waifu2x-Vulkan', 'vulkan should be second fallback')
  assert(chain[3].label === 'ONNX-DML', 'onnx should be last external engine')
  assert(chain[1].args[1] === '{sourceKind}', 'sourceKind token not preserved in engine args')
  assert(superres.resolveEngineChain({}).length === 0, 'empty config must yield no external engines')
  return chain.map((e) => e.label).join(' > ')
})

await check('super-resolution output validation rejects corrupt frames', async () => {
  const superres = await import(pathToFileURL(path.join(REPO, 'lib', 'superres.js')).href)
  const inputInfo = { width: 1000, height: 600 }
  const ok = superres.validateUpscaleOutput({
    inputInfo,
    outputInfo: { width: 2000, height: 1200 },
    inputMetrics: { mean: 0.5, std: 0.2 },
    outputMetrics: { mean: 0.49, std: 0.19 },
    expectedScale: 2,
  })
  assert(ok.ok === true, `valid upscale rejected: ${ok.problems.join(', ')}`)
  const black = superres.validateUpscaleOutput({
    inputInfo,
    outputInfo: { width: 2000, height: 1200 },
    inputMetrics: { mean: 0.55, std: 0.25 },
    outputMetrics: { mean: 0.02, std: 0.01 }, // 2022 Real-ESRGAN on RTX 50-series output
    expectedScale: 2,
  })
  assert(black.ok === false && black.problems.length > 0, 'black/corrupt frame was not rejected')
  const wrongSize = superres.validateUpscaleOutput({
    inputInfo,
    outputInfo: { width: 1500, height: 900 },
    inputMetrics: { mean: 0.5, std: 0.2 },
    outputMetrics: { mean: 0.5, std: 0.2 },
    expectedScale: 2,
  })
  assert(wrongSize.ok === false, 'wrong output size was not rejected')
  return `corrupt rejected: ${black.problems[0].slice(0, 28)}…`
})

// ---------------------------------------------------------------------------
// 10. crop planner: real photos must keep their full frame
// ---------------------------------------------------------------------------
await check('crop planner keeps photo frames and only trims confident screenshot strips', async () => {
  const gradeModule = await import(pathToFileURL(path.join(REPO, 'lib', 'grade.js')).href)
  const photo = { width: 3840, height: 2400, stripPx: 0, confidence: 'none' }
  const screenshot = { width: 3440, height: 1578, stripPx: 149, confidence: 'high' }
  const lowConfidence = { width: 3440, height: 1578, stripPx: 6, confidence: 'low' }
  const equal = (rect, left, top, right, bottom) => (
    rect.left === left && rect.top === top && rect.right === right && rect.bottom === bottom
  )
  // A real photo (no screenshot UI strip) is never cropped, whatever the mode.
  assert(equal(gradeModule.resolveCrop({ mode: 'bottom-strip' }, photo), 0, 0, 3840, 2400), 'real photo was cropped by bottom-strip')
  assert(equal(gradeModule.resolveCrop({ mode: 'auto' }, photo), 0, 0, 3840, 2400), 'real photo was cropped by auto')
  // A screenshot keeps the documented UI-strip behaviour.
  assert(equal(gradeModule.resolveCrop({ mode: 'bottom-strip' }, screenshot), 0, 0, 3440, 1429), 'screenshot strip not trimmed')
  assert(equal(gradeModule.resolveCrop({ mode: 'auto' }, screenshot), 0, 0, 3440, 1429), 'confident screenshot strip not trimmed by auto')
  // Low-confidence guesses are ignored by auto (photo-friendly) but explicit
  // bottom-strip keeps its legacy behaviour.
  assert(equal(gradeModule.resolveCrop({ mode: 'auto' }, lowConfidence), 0, 0, 3440, 1578), 'low-confidence strip was cropped by auto')
  assert(equal(gradeModule.resolveCrop({ mode: 'none' }, screenshot), 0, 0, 3440, 1578), 'crop mode none must keep the full frame')
  assert(equal(gradeModule.resolveCrop({ left: 10, top: 20, right: 300, bottom: 400 }, photo), 10, 20, 300, 400), 'explicit crop rect not honoured')
  return 'photo kept, screenshot trimmed, low-confidence ignored'
})




// ---------------------------------------------------------------------------
// 14. install plan covers full dependencies (weights + venv + pip) with paths
// ---------------------------------------------------------------------------
await check('install plan covers deps and weights with configurable paths', async () => {
  const models = await import(pathToFileURL(path.join(REPO, 'lib', 'models.js')).href)
  const catalog = models.loadModelCatalog(path.join(REPO, 'assets'))
  const supir = catalog.tiers.find((item) => item.id === 'supir')
  const paths = models.defaultInstallPaths({ dataDir: 'D:/Data', overrides: { downloadDir: 'E:/dl', installDir: 'E:/ai' } })
  assert(paths.downloadDir === 'E:/dl' && paths.installDir === 'E:/ai', 'path overrides must win')
  assert(paths.venvDir === path.join('E:/ai', 'venv') && paths.modelsDir === path.join('E:/ai', 'models'), 'derived dirs wrong')
  const plan = models.buildInstallPlan(supir, paths)
  const types = plan.steps.map((step) => step.type)
  assert(types.includes('download') && types.includes('venv') && types.includes('pip'), 'install plan must include weights+venv+pip')
  const script = models.buildInstallerScript(plan, { python: 'python.exe' })
  assert(script.charCodeAt(0) === 0xFEFF, 'installer script must be UTF-8 BOM for Windows PowerShell 5.1')
  assert(script.includes('curl.exe') && script.includes('venv') && script.includes('pip install'), 'installer script incomplete')
  const downloadStep = plan.steps.find((step) => step.type === 'download')
  assert(Array.isArray(downloadStep.urls) && downloadStep.urls.length >= 1, 'download steps need mirror url lists')
  assert(plan.steps.every((step) => step.type !== 'place-weights'), 'weights must go straight to the models dir (no 2x disk use)')
  return `steps=${types.join(',')}`
})


await check('SUPIR install plan includes code and aux weights', async () => {
  const models = await import(pathToFileURL(path.join(REPO, 'lib', 'models.js')).href)
  const catalog = models.loadModelCatalog(path.join(REPO, 'assets'))
  const supir = catalog.tiers.find((item) => item.id === 'supir')
  assert(supir.adapterReady === true, 'SUPIR tier must be marked adapter-ready')
  assert(supir.downloads.filter((item) => !item.optional).length >= 4, 'SUPIR needs SUPIR+SDXL+CLIP weights')
  assert(Array.isArray(supir.downloads.filter((item) => item.optional)) && supir.downloads.some((item) => item.optional), 'optional LLaVA/CLIP tiers missing')
  const plan = models.buildInstallPlan(supir, { installDir: 'E:/ai', venvDir: 'E:/ai/venv', modelsDir: 'E:/ai/supir' })
  const types = plan.steps.map((step) => step.type)
  assert(types.includes('fetch-code') && types.includes('download'), 'SUPIR plan must fetch source code + weights')
  assert(types.includes('py-compat'), 'SUPIR plan must run the compatibility patcher')
  assert(JSON.stringify(supir.install.pip || []).includes('xformers'), 'SUPIR deps must include xformers')
  assert(!types.includes('extract-tar'), 'archive extraction belongs to supir_compat.py')
  assert(!plan.steps.some((step) => step.type === 'download' && /llava|clip-vit-large-patch14\.tar$/i.test(step.fileName)), 'optional weights must not be forced')
  return `steps=${types.filter((t) => t !== 'pip').join(',')}`
})

// ---------------------------------------------------------------------------
// 13. model catalog tiers are hardware-aware (onboarding download ladder)
// ---------------------------------------------------------------------------
await check('model catalog tiers are hardware-aware', async () => {
  const models = await import(pathToFileURL(path.join(REPO, 'lib', 'models.js')).href)
  const catalog = models.loadModelCatalog(path.join(REPO, 'assets'))
  assert((catalog.tiers || []).length >= 5, 'model catalog tiers missing')
  assert(catalog.tiers[0].id === 'supir', 'ultimate tier (SUPIR) must come first')
  const strongPc = models.evaluateTiers(catalog, { gpu: { name: 'RTX', vramMB: 16384 }, vulkan: true, torch: true, diskFreeGB: 500 }, { modelsDir: path.join(REPO, 'test-results', 'no-models') })
  const supir = strongPc.find((item) => item.id === 'supir')
  assert(supir.status === 'downloadable', `SUPIR should be downloadable on a 16GB CUDA machine, got ${supir.status}`)
  const weakPc = models.evaluateTiers(catalog, { gpu: { name: 'iGPU', vramMB: 1024 }, vulkan: true, torch: false, diskFreeGB: 50 }, { modelsDir: path.join(REPO, 'test-results', 'no-models') })
  const weakSupir = weakPc.find((item) => item.id === 'supir')
  assert(weakSupir.status === 'unsupported' && weakSupir.problems.length > 0, 'SUPIR must be blocked on weak hardware')
  const fallback = strongPc.find((item) => item.id === 'lanczos')
  assert(fallback.status === 'ready', 'Lanczos fallback must always be ready')
  return `tiers=${catalog.tiers.length}, supir@16GB=${supir.status}, supir@1GB=${weakSupir.status}`
})

// ---------------------------------------------------------------------------
// 12. onboarding model classification (bundled runner compat)
// ---------------------------------------------------------------------------
await check('setup classification keeps the runner honest', async () => {
  const setup = await import(pathToFileURL(path.join(REPO, 'lib', 'setup.js')).href)
  const native = setup.classifyModel('RealESRGAN_x4plus.pth', 'pth', 'super-resolution')
  assert(native.runnable === true, 'native RealESRGAN model must be runnable')
  const ultra = setup.classifyModel('4x-UltraSharp.pth', 'pth', 'super-resolution')
  assert(ultra.runnable === true, 'UltraSharp is loadable via the bundled adapter')
  const onnx = setup.classifyModel('model.onnx', 'onnx', 'super-resolution')
  assert(onnx.runnable === false, 'ONNX model cannot be loaded by the bundled torch runner')
  const rec = setup.recommendModels([
    { name: '4x-UltraSharp.pth', kind: 'super-resolution', runnable: false, runtime: 'needs-adapter', sizeMB: 64 },
    { name: 'RealESRGAN_x4plus.pth', kind: 'super-resolution', runnable: true, runtime: 'native-rrdb', sizeMB: 64 },
    { name: 'RealESRGAN_x4plus_anime_6B.pth', kind: 'super-resolution', runnable: true, runtime: 'native-rrdb', sizeMB: 17 },
  ])
  assert(rec.photo && rec.photo.name, 'a runnable photo model must be recommended')
  assert(rec.anime && rec.anime.name === 'RealESRGAN_x4plus_anime_6B.pth', 'anime recommendation missing')
  return 'native-only recommendations, adapters flagged'
})


// ---------------------------------------------------------------------------
// 15. onboarding upgrade suggestion + forceAsk
// ---------------------------------------------------------------------------
await check('onboarding suggests model upgrade and supports forceAsk', async () => {
  const gradeModule = await import(pathToFileURL(path.join(REPO, 'lib', 'grade.js')).href)
  const tmp = tmpDir('lumina-onboard')
  const modelsDir = path.join(tmp, 'ai', 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, '4x-UltraSharp.pth'), Buffer.alloc(2048))
  fs.writeFileSync(path.join(modelsDir, 'RealESRGAN_x4plus.pth'), Buffer.alloc(2048))
  const projectRoot = path.join(tmp, 'projects')
  fs.mkdirSync(projectRoot, { recursive: true })
  const userConfigFile = path.join(tmp, 'user.json')
  fs.writeFileSync(userConfigFile, JSON.stringify({ projectRoot, setup: { modelChoice: 'RealESRGAN_x4plus.pth' } }))
  const config = {
    projectRoot,
    casesFile: path.join(tmp, 'auto-cases.json'),
    userConfigFile,
    stylesFile: path.join(tmp, 'styles.json'),
    lutDir: undefined,
    superResolution: {},
  }
  const handlers = gradeModule.createHandlers({ config, session: null, python: 'python' })
  const res = await handlers.state({ onboard: true })
  assert(res.onboard.suggestion && res.onboard.suggestion.recommended === '4x-UltraSharp.pth', 'upgrade suggestion missing')
  assert(res.onboard.questions.length >= 2, 'onboarding must always offer output folder + CUDA model confirmation')
  assert(res.onboard.questions.some((q) => q.includes('输出文件夹')), 'output folder question missing')
  assert(res.onboard.questions.some((q) => q.includes('CUDA')), 'CUDA model question missing')
  assert(Array.isArray(res.onboard.tiers) && res.onboard.tiers.length >= 5, 'full super-resolution tier ladder missing')
  assert(res.onboard.current && Array.isArray(res.onboard.current.engineChain), 'engine chain missing from onboarding payload')
  const forced = await handlers.state({ onboard: true, forceAsk: true })
  assert(forced.onboard.forceAsk === true && forced.onboard.questions.length >= 3, 'forceAsk must add a write-confirmation question')
  fs.rmSync(tmp, { recursive: true, force: true })
  return `suggest=${res.onboard.suggestion.recommended}, forcedQuestions=${forced.onboard.questions.length}`
})


// ---------------------------------------------------------------------------
// 16. colour/channel region masks + native inspection assets
// ---------------------------------------------------------------------------
await check('region/colour masks are bundled', async () => {
  const regionmask = path.join(REPO, 'assets', 'regionmask.py')
  assert(fs.existsSync(regionmask), 'regionmask.py missing')
  const recipesModule = await import(pathToFileURL(path.join(REPO, 'lib', 'recipes.js')).href)
  const recipe = recipesModule.getRecipe('region-sky')
  assert(recipe.steps.layers.mask.mode === 'color', 'region-sky must use a colour mask')
  assert(Array.isArray(recipe.steps.layers.mask.ranges) && recipe.steps.layers.mask.ranges.length > 0, 'colour ranges missing')
  const pyText = fs.readFileSync(path.join(REPO, 'lib', 'py.js'), 'utf8')
  assert(pyText.includes('regionMask'), 'py.js regionMask wrapper missing')
  const zonesRecipe = recipesModule.getRecipe('region-zones')
  assert(Array.isArray(zonesRecipe.steps.layers.zones) && zonesRecipe.steps.layers.zones.length >= 3, 'region-zones must define at least 3 zones')
  const pipeText = fs.readFileSync(path.join(REPO, 'assets', 'pipeline.jsx'), 'utf8')
  assert(pipeText.includes('multi-zone local adjustment'), 'pipeline.jsx zones branch missing')
  assert(pipeText.includes('zonesOrdered'), 'pipeline.jsx person-last zone ordering missing')
  const personMaskSrc = fs.readFileSync(path.join(REPO, 'lib', 'personmask.js'), 'utf8')
  assert(personMaskSrc.includes('autoCutout') && personMaskSrc.includes('PNGSaveOptions'), 'personmask.js missing PS subject alpha export')
  const gradeSrc = fs.readFileSync(path.join(REPO, 'lib', 'grade.js'), 'utf8')
  assert(gradeSrc.includes('personAlphaFile') && gradeSrc.includes('exclude: personAlphaFile'), 'grade.js person-exclusion wiring missing')
  assert(gradeSrc.includes('longEdgeGuard') && gradeSrc.includes('maxInputLongEdge'), 'grade.js long-edge guard missing')
  assert(gradeSrc.includes('highKey') && gradeSrc.includes('p50Slack'), 'grade.js high-key check tolerance missing')
  assert(gradeSrc.includes('probePerson'), 'grade.js screenshot person mask resolution missing')
  const hdrPop = recipesModule.getRecipe('hdr-pop')
  assert(hdrPop.steps.layers.mask.mode === 'auto', 'hdr-pop mask must be auto (no polygon data)')
  const rmSrc = fs.readFileSync(path.join(REPO, 'assets', 'regionmask.py'), 'utf8')
  assert(rmSrc.includes('--exclude') && rmSrc.includes('ex_alpha'), 'regionmask.py exclude missing')

  const assessModule = await import(pathToFileURL(path.join(REPO, 'lib', 'assess.js')).href)
  assert(assessModule.routeZoneRecipe({ autoPlan: { sourceKind: 'photo' }, detection: {}, scene: 'landscape' }) === 'region-sky', 'explicit landscape scene must route to region-sky')
  const adSrc = fs.readFileSync(path.join(REPO, 'assets', 'autodetect.py'), 'utf8')
  assert(adSrc.includes('skyTopPct') && adSrc.includes('waterPct'), 'autodetect sky/water metrics missing')
  assert(assessModule.routeZoneRecipe({ autoPlan: { sourceKind: 'screenshot' }, detection: { style: 'character', skinBlobAreaFrac: 0.02 }, probe: { kind: 'subject-ai', frac: 0.18 } }) === 'region-zones', 'character screenshot with AI subject probe must route to region-zones')
  assert(assessModule.routeZoneRecipe({ autoPlan: { sourceKind: 'screenshot' }, detection: { style: 'character', skinBlobAreaFrac: 0.02 }, probe: { kind: 'subject-none', frac: null } }) === null, 'screenshot without subject probe must not route to region-zones')
  assert(assessModule.routeZoneRecipe({ autoPlan: { sourceKind: 'photo' }, detection: { style: 'landscape', skinBlobAreaFrac: 0 } }) === null, 'landscape photos must keep hdr-photo by default')
  assert(assessModule.routeZoneRecipe({ explicitRecipe: 'hdr-photo', autoPlan: { sourceKind: 'screenshot' }, detection: { style: 'character' } }) === null, 'explicit recipe must win')
  assert(assessModule.routeZoneRecipe({ autoPlan: { sourceKind: 'photo', photoMask: 'person' }, detection: { style: 'character', skinBlobAreaFrac: 0.05 } }) === null, 'portrait photo keeps hdr-photo')
  assert(pipeText.includes('zcfg.invert === true'), 'pipeline.jsx zone invert support missing')
  const gradeText = fs.readFileSync(path.join(REPO, 'lib', 'grade.js'), 'utf8')
  assert(gradeText.includes('content-aware gating'), 'content-aware zone gating missing')
  assert(zonesRecipe.steps.layers.zones.filter((z) => z.when === 'person').length >= 2, 'person zones must be tagged with when=person')
  return 'regionmask.py + region-sky recipe wired'
})

// ---------------------------------------------------------------------------
// 9. simulated fresh install (clean profile, fake user home)
// ---------------------------------------------------------------------------
await check('fresh-profile install resolves and loads without machine paths', async () => {
  const workspace = tmpDir('lumina-profile')
  const link = path.join(workspace, 'node_modules', 'lumina-dsh')
  try {
    const consumer = path.join(workspace, 'package.json')
    fs.writeFileSync(consumer, JSON.stringify({ name: 'lumina-fresh-profile', private: true, type: 'module' }, null, 2))
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(REPO, link, 'junction')

    const require = createRequire(consumer)
    const resolved = require.resolve('lumina-dsh')
    // Node resolves symlinks/junctions to their real path by default, so the
    // resolved entry must point at this repo's index.js while the profile's own
    // node_modules entry proves dependency resolution works from a clean tree.
    // (In restricted sandboxes realpath() may be unavailable; accept the
    // unresolved profile path in that case.)
    assert(fs.existsSync(link), 'profile node_modules link is missing')
    let resolvedReal = resolved
    try { resolvedReal = fs.realpathSync(resolved) } catch { /* keep lexical path */ }
    const repoEntry = fs.realpathSync(path.join(REPO, 'index.js'))
    const pointsAtRepo = resolvedReal.toLowerCase() === repoEntry.toLowerCase()
      || resolved.toLowerCase().startsWith(link.toLowerCase())
    assert(pointsAtRepo, `package resolved to an unexpected entry: ${resolved}`)

    const previousProfile = process.env.USERPROFILE
    const previousHome = process.env.HOME
    process.env.USERPROFILE = workspace
    process.env.HOME = workspace
    try {
      const freshPlugin = await import(`${pathToFileURL(resolved).href}?fresh=${Date.now()}`)
      const ctx = mockCtx()
      freshPlugin.apply(ctx, {})
      assert(ctx.list().length === EXPECTED_TOOLS.length, 'fresh install did not register all tools')
      const root = freshPlugin.defaultProjectRoot()
      assert(root === path.join(workspace, 'Lumina'), `fresh default project root is not portable: ${root}`)
      const stateTool = ctx.list().find((tool) => tool.name === 'ps_state')
      const state = await stateTool.execute({})
      assert(state.caseBank, 'state has no case bank info')
      assert(state.caseBank.userFile.toLowerCase().startsWith(workspace.toLowerCase()), `case bank escaped the fresh profile: ${state.caseBank.userFile}`)
      assert(state.caseBank.seedFile.toLowerCase().startsWith(REPO.toLowerCase()), 'seed bank should come from the package')
      assert(state.stylesFile && state.stylesFile.toLowerCase().startsWith(workspace.toLowerCase()), `hot style pack escaped the fresh profile: ${state.stylesFile}`)
      assert(/[\\/]\.lumina[\\/]styles\.json$/.test(state.stylesFile), `default stylesFile is not <home>/.lumina/styles.json: ${state.stylesFile}`)
    } finally {
      if (previousProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousProfile
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
    return 'fresh profile loads lumina-dsh'
  } finally {
    // Remove the junction first (rmSync recursion would follow it into the repo).
    try { fs.rmdirSync(link) } catch { /* ignore */ }
    removeDirSafe(workspace)
  }
})

// ---------------------------------------------------------------------------
// 10. repository hygiene
// ---------------------------------------------------------------------------
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.py', '.ps1', '.jsx', '.svg', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'test-results', 'acceptance-results'])
const PRIVATE_PATTERNS = [
  { name: 'project root', pattern: new RegExp('D:' + '\\\\{1,2}' + 'A' + 'IPS', 'i') },
  { name: 'user home', pattern: /[A-Z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/i },
  { name: 'photoshop drive path', pattern: /PS20\d\d/i },
  { name: 'local scope', pattern: new RegExp('@' + 'local/') },
  { name: 'demo folder', pattern: new RegExp('\\.ps' + '-' + 'demo', 'i') },
  { name: 'username', pattern: new RegExp('jie' + 'ji', 'i') },
]

function walkRepo(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkRepo(path.join(dir, entry.name), out)
    } else {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

await check('no private paths in repository files', () => {
  const hits = []
  const files = walkRepo(REPO)
  for (const file of files) {
    if (path.basename(file) === 'auto-cases.json') continue // local seed bank, gitignored
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const { name, pattern } of PRIVATE_PATTERNS) {
      const match = pattern.exec(text)
      if (match) hits.push(`${path.relative(REPO, file)}: ${name} (${match[0]})`)
    }
  }
  assert(hits.length === 0, `private paths found:\n      ${hits.join('\n      ')}`)
  return `${files.length} files scanned`
})

await check('no Adobe LUT binaries are bundled', () => {
  const binaries = walkRepo(REPO).filter((file) => /\.(cube|look|3dl)$/i.test(file))
  assert(binaries.length === 0, `bundled LUT binaries: ${binaries.map((file) => path.relative(REPO, file)).join(', ')}`)
  return 'none'
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
if (PREVIOUS_CONFIG_ENV === undefined) delete process.env.LUMINA_CONFIG
else process.env.LUMINA_CONFIG = PREVIOUS_CONFIG_ENV
for (const dir of [...createdDirs]) removeDirSafe(dir)
try { fs.rmdirSync(WORK) } catch { /* not empty: keep the shared test-results dir */ }
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`)
  process.exit(1)
}
console.log('smoke OK — no Photoshop required')
