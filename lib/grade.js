/**
 * Orchestration shared by the tools and the standalone smoke test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildGradeJsx, toPsPath } from './jsx.js'
import { buildPersonMaskJsx } from './personmask.js'
import { imageInfo, imageMeasure, imageAssess, orientImage, compareImages, regionCompare, autoDetect, runHdrSynth, lutApply, regionMask, runUpscale } from './py.js'
import {
  createProject,
  recordVersion,
  resolveProjectDir,
  readProject,
  listProjects,
  appendLog,
} from './project.js'
import { DEFAULT_RECIPE, configureRecipes, getRecipe, listRecipes, getStyle, listStyles, stylesFilePath, deepMerge, isPlainObject } from './recipes.js'
import { configureCases, findNearestCase, addCase, listCases, caseBankInfo, featureVector } from './cases.js'
import { resolveLut, resolveLutDir } from './ps-locate.js'
import { mergeSuperResolution, planSuperResolution, runSuperResolution, validateUpscaleOutput, resolveEngineChain } from './superres.js'
import { planAuto, DEFAULT_AUTO_ASSESS, routeZoneRecipe } from './assess.js'
import { defaultModelDirs, scanModels, recommendModels, formatModelTable } from './setup.js'
import { loadModelCatalog, probeHardware, evaluateTiers, defaultInstallPaths, buildInstallPlan, startInstall, readInstallStatus } from './models.js'
import { fileURLToPath } from 'node:url'

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function resolveCrop(cropRule, info) {
  const width = info.width
  const height = info.height
  const explicit = ['left', 'top', 'right', 'bottom'].some((key) => typeof cropRule?.[key] === 'number')
  if (explicit) {
    return {
      left: clampInt(cropRule.left, 0, width - 1, 0),
      top: clampInt(cropRule.top, 0, height - 1, 0),
      right: clampInt(cropRule.right, 1, width, width),
      bottom: clampInt(cropRule.bottom, 1, height, height),
    }
  }
  const mode = cropRule?.mode || 'bottom-strip'
  if (mode === 'none') return { left: 0, top: 0, right: width, bottom: height }
  // "auto" only trims a strip the detector is confident about; otherwise it
  // keeps the full frame (friendlier to real photos, where a dark/bright bottom
  // band is often part of the picture rather than a screenshot UI bar).
  if (mode === 'auto' && info.confidence !== 'high') {
    return { left: 0, top: 0, right: width, bottom: height }
  }
  let strip = Number(info.stripPx) || 0
  // A low-confidence strip is a few pixels at most; cropping it is never worth
  // the risk on a photo.
  if (info.confidence === 'low') strip = 0
  if (!strip && Number(cropRule?.fallbackPx)) strip = Number(cropRule.fallbackPx)
  strip += Number(cropRule?.adjustPx) || 0
  strip = clampInt(strip, 0, Math.floor(height * 0.3), 0)
  return { left: 0, top: 0, right: width, bottom: height - strip }
}

/** Scale a crop rectangle by a super-resolution factor. */
export function scaleCrop(crop, scale) {
  const factor = Number(scale) || 1
  return {
    left: Math.round(crop.left * factor),
    top: Math.round(crop.top * factor),
    right: Math.round(crop.right * factor),
    bottom: Math.round(crop.bottom * factor),
  }
}

// Compute a small parameter patch that should move failing checks back into range.
// Used by the auto self-heal pass (one retry max).
export function buildSelfHealPatch(recipe, steps, checks, after) {
  const failed = new Set(checks.filter((check) => !check.pass).map((check) => check.name))
  const patch = {}
  if (failed.size === 0) return patch
  if (failed.has('highlight_clip')) {
    if (steps.tone) {
      patch.tone = deepMerge(patch.tone || {}, { ow: Math.max(238, Math.round((Number(steps.tone.ow) || 252) - 4)) })
    }
    if (steps.bloom) {
      patch.bloom = deepMerge(patch.bloom || {}, { opacity: Math.max(0, Number(steps.bloom.opacity || 0) * 0.7) })
    }
    for (const layer of ['subject', 'midground', 'background']) {
      const layerTone = steps.layers && steps.layers[layer] && steps.layers[layer].tone
      if (layerTone) {
        patch.layers = patch.layers || {}
        patch.layers[layer] = deepMerge(patch.layers[layer] || {}, {
          tone: { ow: Math.max(230, Math.round((Number(layerTone.ow) || 250) - 3)) },
        })
      }
    }
  }
  if (failed.has('midtones') || failed.has('mean')) {
    const rules = recipe.checks || {}
    const range = Array.isArray(rules.p50Range) ? rules.p50Range : (Array.isArray(rules.meanRange) ? rules.meanRange : [0.3, 0.8])
    const target = (Number(range[0]) + Number(range[1])) / 2
    const current = Number(after.p50 ?? after.mean ?? 0.5)
    const gamma = Math.min(1.35, Math.max(0.62, Number(steps.tone && steps.tone.gamma != null ? steps.tone.gamma : 1) + (target - current) * 0.55))
    patch.tone = deepMerge(patch.tone || {}, { gamma: Number(gamma.toFixed(3)) })
  }
  return patch
}

// Learned params must stay reusable on OTHER images: drop image-specific mask
// files (soft-alpha / polygon tiles belong to one shot) and fall back to AI subject.
// Learned params carry the warm push of the shot they were tuned on; on a
// different scene that warm subject-layer split turns skin yellow / clips it.
// Neutralise the *person layer* before merging: clamp the warm channels, put a
// little blue back into mid/highs, cap the white point and the gamma lift.
export function neutralizeCaseSkinParams(params) {
  try {
    const copy = JSON.parse(JSON.stringify(params || {}))
    const subject = copy.layers && copy.layers.subject
    if (!subject) return copy
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
    const cool = (arr) => {
      if (!Array.isArray(arr) || arr.length < 3) return arr
      const out = [clamp(arr[0], -4, 2), clamp(arr[1], -3, 2), clamp(arr[2], -3, 2)]
      out[2] = Math.max(-1, out[2]) + 1 // one unit of blue back = de-yellow
      return out
    }
    if (subject.split && typeof subject.split === 'object') {
      for (const key of ['sh', 'mid', 'hi']) if (subject.split[key]) subject.split[key] = cool(subject.split[key])
    }
    if (subject.tone && typeof subject.tone === 'object') {
      if (Number.isFinite(Number(subject.tone.iw))) subject.tone.iw = Math.min(250, Number(subject.tone.iw))
      if (Number.isFinite(Number(subject.tone.ow))) subject.tone.ow = Math.min(252, Number(subject.tone.ow))
      if (Number.isFinite(Number(subject.tone.gamma))) subject.tone.gamma = Math.min(1.02, Number(subject.tone.gamma))
    }
    return copy
  } catch { return params || {} }
}

export function sanitizeCaseParams(params) {
  try {
    const copy = JSON.parse(JSON.stringify(params || {}))
    const mask = copy.layers && copy.layers.mask
    if (mask && (mask.mode === 'alpha' || mask.mode === 'polygon')) {
      mask.mode = 'subject'
      delete mask.alphaFile
      delete mask.polygonListFile
      delete mask.midAlphaFile
    }
    return copy
  } catch { return params || {} }
}

export function evaluateChecks(recipe, before, after, crop) {
  const checks = []
  const rules = recipe.checks || {}
  const maxClip = Number(rules.highlightClipMaxPct)
  if (Number.isFinite(maxClip)) {
    checks.push({
      name: 'highlight_clip',
      pass: after.clipHi <= maxClip,
      detail: `高光溢出 ${before.clipHi}% → ${after.clipHi}%（阈值 ≤ ${maxClip}%）`,
    })
  }
  const beforeP50 = Number(before && before.p50)
  const beforeMean = Number(before && before.mean)
  const highKey = (Number.isFinite(beforeP50) && beforeP50 > 0.78) || (Number.isFinite(beforeMean) && beforeMean > 0.80)
  const p50Slack = highKey ? 0.12 : 0
  const meanSlack = highKey ? 0.10 : 0
  // The *source itself* can already sit above the recipe's target range (high-key
  // mist / overcast scenes, bright UI screenshots). Demanding the graded result
  // return into that range forces a global darkening that destroys the look, so
  // when the input is already out of range we only evaluate stability (don't
  // brighten further beyond a small slack).
  const p50RangeCfg = Array.isArray(rules.p50Range) ? rules.p50Range : null
  const meanRangeCfg = Array.isArray(rules.meanRange) ? rules.meanRange : null
  const sourceP50Out = Boolean(p50RangeCfg && Number.isFinite(beforeP50) && beforeP50 > Number(p50RangeCfg[1]))
  const sourceMeanOut = Boolean(meanRangeCfg && Number.isFinite(beforeMean) && beforeMean > Number(meanRangeCfg[1]))
  const minGain = Number(rules.sharpnessGainMin)
  if (Number.isFinite(minGain)) {
    const gain = before.sharp > 0 ? after.sharp / before.sharp : 0
    checks.push({
      name: 'sharpness',
      pass: gain >= minGain,
      detail: `锐度 ${before.sharp} → ${after.sharp}（×${gain.toFixed(2)}，阈值 ≥ ×${minGain}）`,
    })
  }
  if (Array.isArray(rules.p50Range)) {
    const [minP50, maxP50] = rules.p50Range
    const maxP50Allowed = (highKey || sourceP50Out) && Number.isFinite(beforeP50)
      ? Math.max(maxP50 + p50Slack, Math.min(1, beforeP50 + 0.03))
      : Math.min(1, maxP50 + p50Slack)
    checks.push({
      name: 'midtones',
      pass: after.p50 >= minP50 && after.p50 <= maxP50Allowed,
      detail: `中间调 p50 ${before.p50} → ${after.p50}（目标 ${minP50}–${maxP50Allowed.toFixed(2)}）`,
    })
  }
  if (Array.isArray(rules.meanRange)) {
    const [minMean, maxMean] = rules.meanRange
    const maxMeanAllowed = (highKey || sourceMeanOut) && Number.isFinite(beforeMean)
      ? Math.max(maxMean + meanSlack, Math.min(1, beforeMean + 0.03))
      : Math.min(1, maxMean + meanSlack)
    checks.push({
      name: 'mean',
      pass: after.mean >= minMean && after.mean <= maxMeanAllowed,
      detail: `平均亮度 ${before.mean} → ${after.mean}（目标 ${minMean}–${maxMeanAllowed.toFixed(2)}）`,
    })
  }
  if (crop) {
    checks.push({
      name: 'dimensions',
      pass: after.width === crop.right - crop.left && after.height === crop.bottom - crop.top,
      detail: `输出尺寸 ${after.width}×${after.height}（期望 ${crop.right - crop.left}×${crop.bottom - crop.top}）`,
    })
  }
  return checks
}

/**
 * Merge super-resolution options from plugin config, auto options and the
 * per-call preprocess block. An explicitly requested block enables it even
 * without config; otherwise only `config.superResolution.enabled: true` turns
 * it on (so a normal install never silently upscales every image).
 */
export function resolveSrOptions(config, autoArg, preprocessArg) {
  const defaults = isPlainObject(config?.superResolution) ? config.superResolution : {}
  const autoSr = isPlainObject(autoArg?.superResolution) ? autoArg.superResolution : null
  const explicit = isPlainObject(preprocessArg?.superResolution) ? preprocessArg.superResolution : null
  let merged = mergeSuperResolution(defaults)
  if (autoSr) merged = mergeSuperResolution(merged, autoSr)
  if (explicit) merged = mergeSuperResolution(merged, explicit)
  const requested = explicit || autoSr
  return { ...merged, enabled: requested ? merged.enabled !== false : merged.enabled === true }
}

export function createHandlers({ config, session, python }) {
  configureCases({ seedFile: config.casesSeedFile, userFile: config.casesFile })
  configureRecipes({ stylesFile: config.stylesFile })
  const logger = (message) => {
    if (process.env.LUMINA_DEBUG || process.env.DSH_PHOTOSHOP_DEBUG) console.error('[lumina]', message)
  }

  async function grade(args) {
    const startedAt = Date.now()
    const requestedSource = String(args.source || '').trim()
    const existingProject = args.project
      ? resolveProjectDir({ root: config.projectRoot, project: String(args.project) })
      : null

    let projectDir = existingProject
    let project = null
    let sourcePath = requestedSource
    if (!sourcePath && projectDir) {
      project = readProject(projectDir)
      sourcePath = project.source.path
    }
    // ---- learn-only call: record an accepted version into the case bank ----
    if (args.learn && projectDir) {
      const project = readProject(projectDir)
      const wanted = isPlainObject(args.learn) && args.learn.version ? Number(args.learn.version) : project.versions.length
      const version = project.versions.find((item) => Number(item.version) === wanted) || project.versions[project.versions.length - 1]
      if (!version) throw new Error('工程里还没有可学习的版本')
      const projectSource = path.isAbsolute(project.source.path) ? project.source.path : path.resolve(projectDir, project.source.path)
      // features must describe the USER's original image, not a derived hdr-view:
      // learn accepts an explicit source (original screenshot) alongside project.
      const srcPath = requestedSource
        ? (path.isAbsolute(requestedSource) ? requestedSource : path.resolve(requestedSource))
        : projectSource
      let detection = null
      try { detection = await autoDetect(python, srcPath) } catch (error) { detection = { ok: false, error: String(error?.message || error) } }
      let scene = isPlainObject(args.learn) && typeof args.learn.scene === 'string'
        ? args.learn.scene
        : ((version.auto && version.auto.scene) || null)
      if (!scene) {
        // classify with Photoshop Select Subject (same probe as auto mode)
        let frac = null
        let kind = null
        try {
          const probeJsx = buildGradeJsx({
            input: toPsPath(srcPath),
            output: toPsPath(path.join(os.tmpdir(), 'lumina-learn-probe.png')),
            psd: null, maskOut: null, crop: { left: 0, top: 0, right: 1, bottom: 1 },
            steps: { __subjectProbe: true },
          })
          let message = ''
          try { message = String(await session.runJsx(probeJsx, config.opTimeoutMs)) } catch (error) { message = String(error?.message || error) }
          const match = message.match(/SUBJECT_PROBE\|([a-z-]+)\|([0-9.]*)\|/)
          if (match) { kind = match[1]; frac = Number(match[2]); }
        } catch { /* probe best effort */ }
        const skinBlob = Number(detection && detection.skinBlobAreaFrac || 0)
        if (kind === 'subject-ai' && Number.isFinite(frac) && frac >= 0.02 && frac <= 0.38) scene = 'character'
        else if (kind === 'subject-ai' && Number.isFinite(frac) && frac > 0.38 && detection && detection.style === 'character' && skinBlob >= 0.01) scene = 'character'
        else scene = 'landscape'
      }
      const entry = addCase({
        source: path.basename(projectDir),
        project: path.basename(projectDir),
        version: version.version,
        recipe: version.recipe,
        params: sanitizeCaseParams(version.params || {}),
        style: (version.style && version.style.name) || 'natural',
        scene,
        features: featureVector(detection || {}, scene),
        detection: detection ? { clipPct: detection.clipPct, washPct: detection.washPct, mean: detection.mean, p50: detection.p50, skinBlobAreaFrac: detection.skinBlobAreaFrac } : null,
        note: String(args.learn.note || args.notes || ''),
      })
      return { ok: true, learned: entry, project: projectDir, cases: listCases(10) }
    }
    if (!sourcePath) throw new Error('需要提供 source（图片路径）或 project（已有工程目录）')
    const resolvedSource = projectDir
      ? path.resolve(projectDir, sourcePath)
      : (path.isAbsolute(sourcePath) ? sourcePath : path.resolve(sourcePath))
    if (!fs.existsSync(resolvedSource)) throw new Error(`找不到源图片: ${resolvedSource}`)

    const autoArg = args.auto === true ? {} : (isPlainObject(args.auto) ? args.auto : null)
    const preprocessArg = isPlainObject(args.preprocess) ? args.preprocess : null
    let autoInfo = null
    let detection = null
    let assess = null
    let autoPlan = null
    if (autoArg) {
      try {
        detection = await autoDetect(python, resolvedSource)
      } catch (error) {
        detection = { ok: false, style: 'landscape', clipPct: 0, error: String(error?.message || error) }
      }
      // Universal assessment: resolution / EXIF / blur / noise / tonality.
      // This is what makes "any image in -> reasonable output" possible without
      // the caller declaring screenshot vs photo.
      try {
        assess = await imageAssess(python, resolvedSource)
      } catch (error) {
        assess = { ok: false, error: String(error?.message || error) }
      }
      if (assess && assess.ok) {
        autoPlan = planAuto(assess, { options: isPlainObject(config.assess) ? config.assess : {} })
      }
      const photoSource = Boolean(autoPlan && autoPlan.sourceKind === 'photo')
      autoInfo = {
        scene: autoArg.scene || (photoSource ? 'photo' : null),
        style: (photoSource || autoArg.style === 'natural') ? 'natural' : 'hdr',
        detection,
      }
      if (autoPlan) autoInfo.plan = autoPlan
      if (photoSource) {
        // Real photos: the Select Subject probe and the render-tuned auto-*
        // recipes/case bank do not apply; use the photo plan (gentle recipe).
        autoInfo.scene = 'photo'
      } else if (!autoInfo.scene && !args.recipe) {
        let probe = null
        try {
          const probeJsx = buildGradeJsx({
            input: toPsPath(resolvedSource),
            output: toPsPath(path.join(os.tmpdir(), 'lumina-probe-unused.png')),
            psd: null,
            maskOut: null,
            crop: { left: 0, top: 0, right: 1, bottom: 1 },
            steps: { __subjectProbe: true },
          })
          let probeMessage = ''
          try {
            probeMessage = String(await session.runJsx(probeJsx, config.opTimeoutMs))
          } catch (error) {
            probeMessage = String(error?.message || error)
          }
          const match = probeMessage.match(/SUBJECT_PROBE\|([a-z-]+)\|([0-9.]*)\|/)
          if (match) {
            const kind = match[1]
            const frac = Number(match[2])
            probe = { kind, frac: Number.isFinite(frac) ? frac : null }
            autoInfo.probe = probe
          }
        } catch (error) {
          autoInfo.probe = { kind: 'error', message: String(error?.message || error) }
        }
        // Classification rules (validated on the reference images):
        //   AI subject 2%-38% of frame            -> character shot
        //   AI subject >38% + compact skin blob   -> character (AI over-selected the scene)
        //   AI subject tiny (<2%) or none         -> landscape
        //   probe failed                          -> landscape (safe default)
        const frac = probe && probe.frac
        const skinBlob = Number(detection?.skinBlobAreaFrac || 0)
        if (probe && probe.kind === 'subject-ai' && Number.isFinite(frac)) {
          if (frac >= 0.02 && frac <= 0.38) {
            autoInfo.scene = 'character'
          } else if (frac > 0.38 && detection && detection.style === 'character' && skinBlob >= 0.01) {
            autoInfo.scene = 'character'
          } else {
            autoInfo.scene = 'landscape'
          }
        } else {
          autoInfo.scene = 'landscape'
        }
      }
      if (!autoInfo.scene) autoInfo.scene = 'landscape'
    }

    // ---- case-bank lookup: reuse the params of the nearest accepted result ----
    // (render-tuned cases do not apply to real photos)
    let caseHit = null
    if (autoInfo && !args.recipe && (!autoPlan || autoPlan.sourceKind !== 'photo')) {
      try {
        caseHit = findNearestCase(detection || {}, autoInfo.scene,
          Number(autoArg && autoArg.caseThreshold) > 0 ? Number(autoArg.caseThreshold) : 0.85)
      } catch { caseHit = null }
      if (caseHit && caseHit.case) {
        autoInfo.case = { id: caseHit.case.id, distance: caseHit.distance, recipe: caseHit.case.recipe, style: caseHit.case.style }
      }
    }
    let recipeName = args.recipe || (projectDir ? readProject(projectDir).recipe : DEFAULT_RECIPE)
    if (autoInfo && !args.recipe) {
      const scene = autoArg.scene || autoInfo.scene || 'landscape'
      autoInfo.scene = scene
      const routedRecipe = routeZoneRecipe({ explicitRecipe: Boolean(args.recipe), autoPlan, detection, probe: autoInfo && autoInfo.probe, scene: (args.params && args.params.scene) || null })
      if (routedRecipe) autoInfo.routedRecipe = routedRecipe
      const caseRecipe = caseHit && caseHit.case && typeof caseHit.case.recipe === 'string' ? caseHit.case.recipe : ''
      if (caseRecipe) {
        // An accepted case wins over content routing: its params were tuned
        // together with this exact recipe, mixing them with another recipe's
        // layer mask is what produced the washed "hdr-pop params + region zones"
        // mismatch. Explicit args.recipe still overrides (handled above).
        recipeName = caseRecipe
        autoInfo.caseRecipe = caseRecipe
      } else if (routedRecipe) {
        recipeName = routedRecipe
      } else if (autoPlan && autoPlan.recipeHint) {
        recipeName = autoPlan.recipeHint
      } else {
        recipeName = autoArg.recipe || `auto-${scene}-${autoInfo.style}`
      }
    }
    if (autoInfo) autoInfo.recipe = recipeName
    const recipe = getRecipe(recipeName)
    const baseOverrides = isPlainObject(args.params) ? args.params : {}
    const autoOverrides = autoArg && isPlainObject(autoArg.params) ? autoArg.params : null
    const caseOverridesRaw = caseHit && caseHit.case && isPlainObject(caseHit.case.params) ? caseHit.case.params : null
    const caseOverrides = caseOverridesRaw ? neutralizeCaseSkinParams(caseOverridesRaw) : null
    let overrides = autoOverrides ? deepMerge(autoOverrides, baseOverrides) : baseOverrides
    if (caseOverrides) overrides = deepMerge(deepMerge(caseOverrides, autoOverrides || {}), baseOverrides)
    // clone: zone/colour mask materialisation must never mutate the cached recipe
  let steps = deepMerge(JSON.parse(JSON.stringify(recipe.steps || {})), overrides)

    // ---- style resolution happens early: a style can carry a parameter preset
    // (params deep-merged over the recipe steps) in addition to a LUT ----------
    const warnings = []
    if (autoPlan) {
      const srText = autoPlan.superResolution.triggered
        ? `建议超分 ×${autoPlan.superResolution.scale}（${autoPlan.superResolution.reason}）`
        : `不超分（${autoPlan.superResolution.reason}）`
      if (detection && detection.skyTopPct !== undefined) {
      warnings.push(`场景特征：天空占比 ${(Number(detection.skyTopPct) * 100).toFixed(1)}%，水面/雪面 ${(Number(detection.waterPct) * 100).toFixed(1)}%`)
    }
    warnings.push(`自动判断：${autoPlan.sourceKind}（${autoPlan.sourceReason}） · 裁剪=${autoPlan.crop} · ${srText} · 模糊度 ${autoPlan.evidence.blurScore}`)
      if (autoPlan.restoreHint) warnings.push(autoPlan.restoreHint)
    }
    const argStyle = typeof args.style === 'string' && args.style.trim() ? args.style.trim() : ''
    const autoStyle = autoArg && typeof autoArg.lutStyle === 'string' && autoArg.lutStyle.trim()
      ? autoArg.lutStyle.trim()
      : (autoArg && typeof autoArg.style === 'string' && !['hdr', 'natural'].includes(autoArg.style) ? autoArg.style : '')
    const caseStyle = caseHit && caseHit.case && typeof caseHit.case.style === 'string' ? caseHit.case.style : ''
    const requestedStyle = argStyle || autoStyle || (autoPlan && autoPlan.photoStyle) || (typeof recipe.style === 'string' ? recipe.style : '') || caseStyle || 'natural'
    let styleDef = null
    let styleError = null
    if (requestedStyle && requestedStyle !== 'natural') {
      try {
        styleDef = getStyle(requestedStyle)
      } catch (error) {
        styleError = error
      }
    }
    if (styleDef && isPlainObject(styleDef.params)) steps = deepMerge(steps, styleDef.params)

    // Universal layered HDR: a recipe may declare mask.mode "auto"; resolve it by
    // content (photos: portrait/heuristic person vs landscape horizon; screenshots
    // already pick subject/depth masks in their auto-* recipes).
    if (steps && steps.layers && steps.layers.mask && steps.layers.mask.mode === 'auto') {
      const skinFrac = Number(detection && detection.skinBlobAreaFrac || 0)
      const probe = autoInfo && autoInfo.probe
      const probeFrac = Number(probe && probe.frac)
      const probePerson = Boolean(
        probe && probe.kind === 'subject-ai' && Number.isFinite(probeFrac)
        && probeFrac >= 0.02 && probeFrac <= 0.6,
      )
      const maskKind = ((autoPlan && autoPlan.photoMask === 'person' && skinFrac >= 0.01)
        || (autoPlan && autoPlan.sourceKind === 'screenshot' && probePerson))
        ? 'person' : 'horizon'
      steps.layers.mask = { ...steps.layers.mask, mode: maskKind }
    }
    const cropRule = deepMerge(recipe.crop || {}, isPlainObject(args.crop) ? args.crop : {})
    if (autoPlan && !isPlainObject(args.crop)) {
      // Plan-driven crop: screenshots trim the UI strip, photos/render keep the
      // full frame unless the strip detector is highly confident.
      cropRule.mode = autoPlan.crop
    }

    const info = await imageInfo(python, resolvedSource)
    const crop = resolveCrop(cropRule, info)
    if (crop.right - crop.left < 16 || crop.bottom - crop.top < 16) {
      throw new Error(`裁剪参数无效: ${JSON.stringify(crop)}`)
    }

    if (!projectDir) {
      const created = createProject({
        root: config.projectRoot,
        sourcePath: resolvedSource,
        title: args.title,
        recipeName,
        notes: args.notes,
      })
      projectDir = created.projectDir
      project = created.project
      sourcePath = created.originalPath
    } else {
      project = readProject(projectDir)
    }

    const version = project.versions.length + 1
    const inputAbsolute = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectDir, sourcePath)
    if (!fs.existsSync(inputAbsolute)) throw new Error(`工程内源图不存在: ${inputAbsolute}`)

    // ---- EXIF orientation normalisation (phone photos) ----------------------
    let pipelineSource = inputAbsolute
    let orientationInfo = null
    if (assess && Number(assess.orientation) > 1) {
      try {
        const orientedPath = path.join(projectDir, 'work', `oriented-v${version}.png`)
        const oriented = await orientImage(python, { input: inputAbsolute, output: orientedPath })
        orientationInfo = { from: Number(assess.orientation), width: oriented.width, height: oriented.height }
        pipelineSource = oriented.output
        warnings.push(`检测到 EXIF 旋转（orientation=${assess.orientation}，手机竖拍），已归一化为 ${oriented.width}×${oriented.height} 再处理；原图仍保留在 input/`)
      } catch (error) {
        warnings.push(`EXIF 方向归一化失败（${String(error?.message || error).slice(0, 120)}），按原始像素处理`)
      }
    }

    // ---- optional super-resolution preprocessing ----------------------------
    // ---- extreme long-edge / extreme-aspect guard -------------------------
    let longEdgeGuard = null
    {
      const guardInfo = await imageInfo(python, pipelineSource)
      const longEdge = Math.max(guardInfo.width, guardInfo.height)
      const shortEdge = Math.max(1, Math.min(guardInfo.width, guardInfo.height))
      const aspect = longEdge / shortEdge
      const maxLongEdge = Number(config.maxInputLongEdge || 12000)
      if (longEdge > maxLongEdge || aspect >= 12) {
        const target = Math.min(8000, maxLongEdge)
        const resizedPath = path.join(projectDir, 'work', `resized-extreme-v${version}.png`)
        try {
          const resized = await runUpscale(python, { input: pipelineSource, output: resizedPath, scale: 1, maxLongEdge: target, sharpen: 0 })
          const outW = Number(resized && resized.outputImage && resized.outputImage.width) || Math.round(guardInfo.width * target / longEdge)
          const outH = Number(resized && resized.outputImage && resized.outputImage.height) || Math.round(guardInfo.height * target / longEdge)
          longEdgeGuard = { from: { width: guardInfo.width, height: guardInfo.height }, to: { width: outW, height: outH }, scale: outW / Math.max(1, guardInfo.width) }
          pipelineSource = resizedPath
          warnings.push(`超长图保护：${guardInfo.width}×${guardInfo.height}（长宽比 ${aspect.toFixed(1)}:1）→ ${outW}×${outH} 再处理（长边上限 ${target}）`)
        } catch (error) {
          warnings.push(`超长图保护失败（${String(error?.message || error).slice(0, 120)}），按原始尺寸处理`)
        }
      }
    }

    let srOptions = resolveSrOptions(config, autoArg, preprocessArg)
    const srExplicit = isPlainObject(preprocessArg?.superResolution) || isPlainObject(autoArg?.superResolution)
    if (autoPlan && autoPlan.superResolution.triggered && !srExplicit) {
      if (srOptions.enabled) {
        // The universal auto plan decided this image is low-res/blurry: force the
        // planned scale (still capped by maxLongEdge) and record why.
        srOptions = {
          ...srOptions,
          mode: 'always',
          scale: autoPlan.superResolution.scale,
          reason: autoPlan.superResolution.reason,
          planned: true,
        }
      } else {
        warnings.push(`自动判断建议超分（${autoPlan.superResolution.reason}），但 superResolution.enabled=false，已跳过；需要时在配置里开启`)
      }
    }
    let srInfo = null
    let gradedSource = pipelineSource
    let sourceInfo = longEdgeGuard ? { width: longEdgeGuard.to.width, height: longEdgeGuard.to.height } : info
    if (srOptions.enabled) {
      let sharpness
      if (Number(srOptions.minSharpness) > 0) {
        try { sharpness = (await imageMeasure(python, pipelineSource)).sharp } catch { sharpness = undefined }
      }
      const plan = planSuperResolution(info, srOptions, { sharpness })
      if (plan.triggered) {
        const srDir = path.join(projectDir, 'work', `sr-v${version}`)
        const sourceKind = autoPlan ? autoPlan.sourceKind : 'default'
        const chain = resolveEngineChain(srOptions)
        const chainAttempts = []
        const measureForValidation = async () => {
          try { return await imageMeasure(python, pipelineSource) } catch { return null }
        }
        const inputMetrics = chain.length > 0 ? await measureForValidation() : null
        const attemptEngine = async (engine, options) => {
          const sr = await runSuperResolution({
            python,
            input: pipelineSource,
            outDir: srDir,
            plan,
            options,
            engine,
            sourceKind,
            timeoutMs: config.opTimeoutMs,
          })
          const srImage = await imageInfo(python, sr.path)
          let validation = { ok: true, problems: [] }
          if (sr.method === 'external-ai') {
            // Guards against engines that exit 0 but return corrupt output
            // (2022 Real-ESRGAN on RTX 50-series drivers is the known case).
            try {
              const outputMetrics = await imageMeasure(python, sr.path)
              validation = validateUpscaleOutput({
                inputInfo: info,
                outputInfo: srImage,
                inputMetrics,
                outputMetrics,
                expectedScale: plan.scale,
              })
            } catch {
              validation = { ok: true, problems: [] }
            }
          }
          return { sr, srImage, validation }
        }
        let accepted = null
        for (const engine of chain) {
          // Quality-first: engines are tried in priority order, a failing/low
          // quality engine is skipped for the next one.
          try {
            const attempt = await attemptEngine(engine, srOptions)
            if (!attempt.validation.ok) throw new Error(`输出校验失败：${attempt.validation.problems.join('；')}`)
            accepted = { ...attempt, label: engine.label, engineKey: engine.key, method: 'external-ai' }
            chainAttempts.push({ engine: engine.key, label: engine.label, ok: true })
            break
          } catch (error) {
            chainAttempts.push({ engine: engine.key, label: engine.label, ok: false, error: String(error?.message || error).slice(0, 200) })
            warnings.push(`AI 超分引擎「${engine.label}」不可用/输出异常（${String(error?.message || error).slice(0, 160)}），尝试下一级引擎`)
          }
        }
        if (!accepted && chain.length === 0) {
          // No external engine configured: built-in Lanczos is the configured
          // backend (this is the normal "no AI installed" case).
          try {
            const attempt = await attemptEngine(null, { ...srOptions, command: '', args: [] })
            accepted = { ...attempt, label: 'builtin-lanczos', engineKey: 'lanczos', method: 'lanczos' }
          } catch (error) {
            chainAttempts.push({ engine: 'builtin-lanczos', ok: false, error: String(error?.message || error).slice(0, 160) })
          }
        } else if (!accepted && String(srOptions.fallback || 'lanczos') !== 'skip') {
          try {
            const attempt = await attemptEngine(null, { ...srOptions, command: '', args: [] })
            accepted = { ...attempt, label: 'builtin-lanczos', engineKey: 'lanczos-fallback', method: 'lanczos-fallback' }
            chainAttempts.push({ engine: 'fallback-lanczos', ok: true })
            warnings.push('所有 AI 超分引擎不可用，已回退到内置 Lanczos')
          } catch (error) {
            chainAttempts.push({ engine: 'fallback-lanczos', ok: false, error: String(error?.message || error).slice(0, 160) })
          }
        }
        if (accepted) {
          const actualScale = Number((accepted.srImage.width / info.width).toFixed(4))
          srInfo = {
            method: accepted.method,
            engine: accepted.label,
            engineKey: accepted.engineKey,
            command: accepted.sr.command || null,
            scale: actualScale,
            reason: plan.reason,
            width: accepted.srImage.width,
            height: accepted.srImage.height,
            view: path.relative(projectDir, accepted.sr.path),
            planned: Boolean(srOptions.planned),
            fallbackFrom: accepted.method === 'lanczos-fallback' ? 'external-ai' : null,
            chain: chainAttempts,
          }
          gradedSource = accepted.sr.path
          sourceInfo = { width: accepted.srImage.width, height: accepted.srImage.height }
          warnings.push(`超分预处理（${srInfo.engine}${srInfo.method === 'lanczos-fallback' ? ' · Lanczos 回退' : ''} ×${actualScale}）：${plan.reason} → ${srInfo.view}`)
        } else {
          warnings.push('所有超分尝试失败，已跳过超分，直接调色原图')
        }
      }
    }

    // crop coordinates scale with the upscaled canvas
    const guardScale = longEdgeGuard ? longEdgeGuard.scale : 1
    const cropScaled = scaleCrop(crop, (srInfo ? srInfo.scale : 1) * guardScale)
    const contentCrop = { left: 0, top: 0, right: cropScaled.right - cropScaled.left, bottom: cropScaled.bottom - cropScaled.top }
    let gradedInput = gradedSource
    let preprocessInfo = null
    const autoHdrThreshold = Number(autoArg && autoArg.hdrThreshold) > 0 ? Number(autoArg.hdrThreshold) : 2.5
    const autoHdrAllowed = !autoPlan || autoPlan.hdr !== false
    // HDR recipes are a *look* (tone-mapped texture/colour density), not only a
    // highlight-repair pass: an hdr-* recipe always builds its HDR base unless the
    // caller explicitly disables preprocess.hdrsynth.
    const hdrLookRecipe = /^hdr-/.test(String(recipeName || ''))
    const wantHdrSynth = Boolean(
      (preprocessArg && preprocessArg.hdrsynth)
      || (hdrLookRecipe && !(preprocessArg && preprocessArg.hdrsynth === false))
      // Auto mode defaults to the HDR look for screenshots (style === 'hdr'), not
      // only for visibly clipped ones: the layered HDR base is what supplies the
      // tone-mapped texture/colour density this plugin is about.
      || (autoInfo && autoInfo.style === 'hdr' && autoHdrAllowed && !(preprocessArg && preprocessArg.hdrsynth === false))
      || (autoInfo && autoHdrAllowed && Number(detection?.clipPct || 0) >= autoHdrThreshold)
      || (autoPlan && autoPlan.sourceKind === 'photo' && autoPlan.hdr),
    )
    if (wantHdrSynth) {
      const clipPct = Number(detection?.clipPct || 0)
      const defaultHdrParams = {
        mode: 'neutral',
        washLum: clipPct >= 10 ? 0.88 : (clipPct >= 4 ? 0.89 : 0.91),
        darken: 0.10,
        texture: 0.30,
        glow: 0.55,
        knee: 0.90,
        top: 0.965,
        skipHdr: true,
      }
      let hdrParams = defaultHdrParams
      if (preprocessArg && isPlainObject(preprocessArg.hdrsynth)) {
        hdrParams = deepMerge(hdrParams, isPlainObject(preprocessArg.hdrsynth.params) ? preprocessArg.hdrsynth.params : {})
        if (typeof preprocessArg.hdrsynth.mode === 'string') hdrParams.mode = preprocessArg.hdrsynth.mode
      }
      if (autoArg && isPlainObject(autoArg.hdrsynth)) hdrParams = deepMerge(hdrParams, autoArg.hdrsynth)
      const hdrDir = path.join(projectDir, 'work', `hdr-v${version}`)
      try {
        const hdr = await runHdrSynth(python, {
          input: gradedInput,
          outDir: hdrDir,
          cropBottom: sourceInfo.height - (cropScaled.bottom - cropScaled.top),
          params: hdrParams,
        })
        if (hdr && hdr.files && hdr.files.view) {
          gradedInput = hdr.files.view
          preprocessInfo = {
            mode: 'hdrsynth-neutral',
            params: hdrParams,
            view: path.relative(projectDir, gradedInput),
            clipPct,
            metrics: hdr.highlight || null,
          }
          warnings.push(`自动 HDR 高光重建：源图高光溢出 ${clipPct}%，已用 hdrsynth（neutral）重建后再调色 → ${preprocessInfo.view}`)
        }
      } catch (error) {
        warnings.push(`HDR 高光重建跳过（${String(error?.message || error).slice(0, 160)}），直接调色原图`)
      }
    }
    const effectiveCrop = (preprocessInfo || srInfo) ? contentCrop : cropScaled

    // ---- content-aware gating: person zones only when a person is detected ----
    const explicitPersonArg = (args.params && typeof args.params.person === 'boolean') ? args.params.person : null
    if (steps && steps.layers && Array.isArray(steps.layers.zones)) {
      const skinFrac = Number(detection && detection.skinBlobAreaFrac || 0)
      const personStyle = String(detection && detection.style || '')
      // The Select Subject probe already answered "is there a person?" for anime /
      // stylised renders where a skin-pixel heuristic finds almost no skin. Trust
      // it before dropping person zones, otherwise the whole layer split silently
      // falls back to colour zones and the result looks flat.
      const probe = autoInfo && autoInfo.probe
      const probeFrac = Number(probe && probe.frac)
      const probePerson = Boolean(probe && probe.kind === 'subject-ai' && Number.isFinite(probeFrac)
        && probeFrac >= 0.02 && probeFrac <= 0.60)
      const personLikely = explicitPersonArg !== null
        ? explicitPersonArg
        : (Boolean(caseHit && caseHit.case)
          || probePerson
          || (personStyle === 'character' && skinFrac >= 0.003)
          || Boolean(autoPlan && autoPlan.photoMask === 'person' && skinFrac >= 0.01))
      const dropped = []
      steps.layers.zones = steps.layers.zones.filter((zone) => {
        if (!zone) return false
        const mode = String(zone.select && zone.select.mode || '')
        const personZone = mode === 'person' || mode === 'subject' || zone.when === 'person'
        const landscapeZone = zone.when === 'landscape'
        if (personZone && !personLikely) { dropped.push(zone.name || mode); return false }
        if (landscapeZone && personLikely) { dropped.push(zone.name || mode); return false }
        return true
      })
      if (dropped.length) warnings.push(`内容感知分区：未检测到人物，已跳过 [${dropped.join(', ')}]（保留颜色/通道分区）`)
    }

    // ---- pixel-level person matte: carve the person out once, then subtract it
    //      from every colour zone so skin/clothes/hair are only touched by the
    //      person zone (soft alpha PNG from PS Select Subject, native resolution).
    let personAlphaFile = null
    if (steps && steps.layers && Array.isArray(steps.layers.zones) && explicitPersonArg !== false
        && steps.layers.zones.some((zone) => zone && zone.select && ['person', 'subject'].includes(String(zone.select.mode)))) {
      const personAlphaPath = path.join(projectDir, 'work', `person-alpha-v${version}.png`)
      try {
        const personJsx = buildPersonMaskJsx({
          input: toPsPath(gradedInput),
          output: toPsPath(personAlphaPath),
          crop: [effectiveCrop.left, effectiveCrop.top, effectiveCrop.right, effectiveCrop.bottom],
        })
        await session.runJsx(personJsx, config.opTimeoutMs)
        if (fs.existsSync(personAlphaPath)) personAlphaFile = personAlphaPath
        warnings.push(`人物像素级蒙版已生成: ${path.relative(projectDir, personAlphaPath)}`)
      } catch (error) {
        // the JSX may have saved the matte before the result-protocol round trip;
        // accept a valid on-disk matte instead of falling back to unisolated zones.
        if (fs.existsSync(personAlphaPath) && fs.statSync(personAlphaPath).size > 1024) {
          personAlphaFile = personAlphaPath
          warnings.push(`人物像素级蒙版已生成（返回协议异常已忽略: ${String(error?.message || error).slice(0, 80)}）`)
        } else {
          warnings.push(`人物像素级蒙版生成失败（${String(error?.message || error).slice(0, 140)}），回退为非隔离分区`)
        }
      }
    }

    // ---- multi-zone: colour/channel selectors become native soft-alpha PNGs ----
    if (steps && steps.layers && Array.isArray(steps.layers.zones)) {
      const materializedZones = []
      for (let zi = 0; zi < steps.layers.zones.length; zi += 1) {
        // clone each zone: recipe definitions may be frozen/cached across runs
        const zone = JSON.parse(JSON.stringify(steps.layers.zones[zi] || {}))
        const sel = zone.select || {}
        if (['person', 'subject'].includes(String(sel.mode))) {
          if (personAlphaFile) {
            zone.select = { ...sel, mode: 'alpha', alphaFile: toPsPath(personAlphaFile) }
            materializedZones.push(zone)
          }
          continue
        }
        if (!['color', 'channel'].includes(String(sel.mode))) {
          materializedZones.push(zone)
          continue
        }
        const zoneMaskPath = path.join(projectDir, 'work', `zone-${zi + 1}-mask-v${version}.png`)
        try {
          const zoneResult = await regionMask(python, {
            input: gradedInput,
            output: zoneMaskPath,
            mode: String(sel.mode),
            ranges: Array.isArray(sel.ranges) ? sel.ranges : [],
            channel: sel.channel || 'lum',
            low: Number(sel.low ?? 0.2),
            high: Number(sel.high ?? 0.8),
            feather: Number(sel.feather || 0),
            invert: sel.invert === true,
            exclude: personAlphaFile ? toPsPath(personAlphaFile) : null,
            crop: [effectiveCrop.left, effectiveCrop.top, effectiveCrop.right, effectiveCrop.bottom],
          })
          const coverage = Number(zoneResult && zoneResult.coveragePct || 0)
          const plausible = zone.when !== 'person' || (coverage >= 0.3 && coverage <= 30)
          if (!plausible) {
            warnings.push(`分区 ${zi + 1}「${zone.name || 'zone'}」覆盖 ${coverage}%，超出人物场景合理范围，已跳过`)
            continue
          }
          zone.select = { ...sel, mode: 'alpha', alphaFile: toPsPath(zoneMaskPath) }
          warnings.push(`分区蒙版 ${zi + 1} 已生成（覆盖 ${coverage}%）: ${path.relative(projectDir, zoneMaskPath)}`)
          materializedZones.push(zone)
        } catch (error) {
          warnings.push(`分区蒙版 ${zi + 1} 生成失败（${String(error?.message || error).slice(0, 140)}），跳过该区`)
        }
      }
      steps.layers.zones = materializedZones
    }

    // ---- colour / channel region masks -> soft alpha PNG (native pixels) ----
    if (steps && steps.layers && steps.layers.mask && ['color', 'channel'].includes(String(steps.layers.mask.mode))) {
      const maskCfg = steps.layers.mask
      const regionMaskPath = path.join(projectDir, 'work', `region-mask-v${version}.png`)
      try {
        const maskResult = await regionMask(python, {
          input: gradedInput,
          output: regionMaskPath,
          mode: String(maskCfg.mode),
          ranges: Array.isArray(maskCfg.ranges) ? maskCfg.ranges : [],
          channel: maskCfg.channel || 'lum',
          low: Number(maskCfg.low ?? 0.2),
          high: Number(maskCfg.high ?? 0.8),
          feather: Number(maskCfg.feather || 0),
          invert: maskCfg.invert === true,
          crop: [effectiveCrop.left, effectiveCrop.top, effectiveCrop.right, effectiveCrop.bottom],
        })
        steps.layers.mask = { ...maskCfg, mode: 'alpha', alphaFile: toPsPath(regionMaskPath) }
        warnings.push(`颜色/通道分区蒙版已生成（覆盖 ${maskResult.coveragePct}%）: ${path.relative(projectDir, regionMaskPath)}`)
      } catch (error) {
        warnings.push(`颜色/通道分区蒙版生成失败（${String(error?.message || error).slice(0, 160)}），本版回退为无分区`)
        delete steps.layers
      }
    }
    const outputPath = path.join(projectDir, 'out', `${recipe.name}-v${version}.png`)
    const psdPath = path.join(projectDir, 'work', `${recipe.name}-v${version}.psd`)
    const jsxPath = path.join(projectDir, 'work', `grade-v${version}.jsx`)
    const maskPath = path.join(projectDir, 'work', `mask-v${version}.png`)
    const comparePath = path.join(projectDir, `compare-v${version}.png`)
    const metricsDir = path.join(projectDir, 'metrics')

    const jsx = buildGradeJsx({
      input: toPsPath(gradedInput),
      output: toPsPath(outputPath),
      psd: toPsPath(psdPath),
      maskOut: toPsPath(maskPath),
      crop: effectiveCrop,
      steps,
    })
    fs.writeFileSync(jsxPath, jsx, 'utf8')

    logger(`grade start: ${recipe.name} v${version} -> ${outputPath}`)
    const runInfo = String(await session.runJsx(jsx, config.opTimeoutMs))
    const [dimensions, maskInfo = '', maskBBox = ''] = runInfo.split('|')
    if (!fs.existsSync(outputPath)) throw new Error(`Photoshop 未生成输出文件: ${outputPath}`)

    // ---- style LUT / parameter preset (styles were resolved before grading) ---
    let styleInfo = null
    if (styleError) warnings.push(`风格跳过：${String(styleError.message || styleError).slice(0, 200)}`)
    if (styleDef) {
      const styleMeta = { source: styleDef.source || 'builtin', params: Boolean(styleDef.params) }
      try {
        // Style LUTs are the .cube files that ship with Photoshop; the package
        // never bundles them. Resolve the name against the local PS install (or a
        // style-level lutDir).
        const lutPath = styleDef.lut ? resolveLut(styleDef.lut, { lutDir: styleDef.lutDir || config.lutDir }) : null
        if (!styleDef.lut) {
          styleInfo = { name: styleDef.name, label: styleDef.label, applied: false, ...styleMeta }
        } else if (!lutPath || !fs.existsSync(lutPath)) {
          styleInfo = { name: styleDef.name, label: styleDef.label, applied: false, ...styleMeta }
          warnings.push(`风格 LUT「${styleDef.label}」不可用：能找到本机 Photoshop 自带的 Presets/3DLUTs 或 lutDir 才能启用（缺少 ${styleDef.lut}）`)
        } else {
          const styleTmp = path.join(projectDir, 'work', `style-v${version}.png`)
          let strength = Number(styleDef.strength) > 0 ? Number(styleDef.strength) : 35
          let applied = null
          for (let attempt = 0; attempt < 2; attempt++) {
            const res = await lutApply(python, { input: outputPath, lut: lutPath, strength, output: styleTmp })
            const delta = Number(res.sharpDeltaPct)
            if (Number.isFinite(delta) && delta >= -2.0) { applied = res; break }
            if (attempt === 0) { strength = Math.max(8, Math.round(strength * 0.6)); continue }
          }
          if (applied) {
            fs.copyFileSync(styleTmp, outputPath)
            styleInfo = {
              name: styleDef.name,
              label: styleDef.label,
              strength,
              sharpDeltaPct: applied.sharpDeltaPct,
              clipBefore: applied.clipBefore,
              clipAfter: applied.clipAfter,
              lut: path.basename(lutPath),
              applied: true,
              ...styleMeta,
            }
            warnings.push(`风格 LUT：${styleDef.label}（强度 ${strength}%，锐度 ${applied.sharpDeltaPct >= 0 ? '+' : ''}${applied.sharpDeltaPct}%，纯颜色映射不加颗粒）`)
            warnings.push('PSD 为 LUT 前的版本；成品 PNG 已包含风格 LUT')
          } else {
            styleInfo = { name: styleDef.name, label: styleDef.label, applied: false, ...styleMeta }
            warnings.push(`风格 LUT「${styleDef.label}」会让锐度下降超过 2%，已跳过（清晰优先）`)
          }
        }
      } catch (error) {
        warnings.push(`风格 LUT 跳过：${String(error?.message || error).slice(0, 160)}`)
      }
    }

    const layerCfg = steps.layers && steps.layers.mask && steps.layers.mask.mode !== 'none'
      ? steps.layers
      : null
    const layers = layerCfg
      ? {
          mask: maskInfo || 'unknown',
          bboxFrac: maskBBox ? Number(maskBBox) : null,
          preview: fs.existsSync(maskPath) ? path.relative(projectDir, maskPath) : null,
          subject: layerCfg.subject ? Object.keys(layerCfg.subject) : [],
          background: layerCfg.background ? Object.keys(layerCfg.background) : [],
        }
      : null

    // QA/compare "before" reference: the original for a plain run, or the
    // upscaled (pre-grading) image for a super-resolution run, so sharpness and
    // tonality checks still measure the grading step itself.
    const beforeInput = srInfo ? gradedSource : pipelineSource
    const beforeCropBottom = sourceInfo.height - contentCrop.bottom

    const before = await imageMeasure(python, beforeInput, { cropBottom: beforeCropBottom })
    const compare = await compareImages(python, {
      before: beforeInput,
      after: outputPath,
      out: comparePath,
      json: path.join(metricsDir, `compare-v${version}.json`),
      labelBefore: srInfo ? '原图（已超分预处理）' : '原图（含 UI 条）',
      labelAfter: `${recipe.label} v${version}`,
      cropBottomBefore: beforeCropBottom,
    })
    const after = compare.after
    fs.writeFileSync(path.join(metricsDir, `before-v${version}.json`), JSON.stringify(before, null, 2), 'utf8')
    fs.writeFileSync(path.join(metricsDir, `after-v${version}.json`), JSON.stringify(after, null, 2), 'utf8')

    const checks = evaluateChecks(recipe, before, after, effectiveCrop)
    let regions = null
    if (layers && layers.preview) {
      try {
        regions = await regionCompare(python, {
          before: beforeInput,
          after: outputPath,
          mask: maskPath,
          json: path.join(metricsDir, `region-v${version}.json`),
          cropBottomBefore: beforeCropBottom,
        })
        const subjMin = Number(recipe.checks?.subjectSharpnessGainMin)
        if (Number.isFinite(subjMin)) {
          checks.push({
            name: 'subject_sharpness',
            pass: regions.deltas.subjectSharpGain >= subjMin,
            detail: `主体锐度 ×${regions.deltas.subjectSharpGain}（阈值 ≥ ×${subjMin}）`,
          })
        }
        const bgMin = Number(recipe.checks?.backgroundSharpnessMin)
        if (Number.isFinite(bgMin)) {
          checks.push({
            name: 'background_stability',
            pass: regions.deltas.backgroundSharpGain >= bgMin,
            detail: `背景锐度 ×${regions.deltas.backgroundSharpGain}（阈值 ≥ ×${bgMin}，不允许过度柔化）`,
          })
        }
      } catch (error) {
        regions = { error: String(error?.message || error) }
      }
    }
    const croppedPx = info.height - (crop.bottom - crop.top)
    if (croppedPx > 0) warnings.push(`已裁掉底部 ${croppedPx}px（UI 条检测置信度 ${info.confidence}）；如需保留完整画面用 crop {"mode":"none"}`)
    if (before.clipHi > 20) warnings.push(`源图高光已溢出 ${before.clipHi}%，细节无法恢复，只能压回观感`)
    if (/\\\.dsh\\attachments\\/i.test(inputAbsolute)) {
      warnings.push('⚠ 源图位于 DSH 附件目录（模型看到的归一化副本），可能已被缩放/有损压缩，建议改用原始文件路径重跑')
    }
    if (autoInfo) {
      if (autoPlan) {
        warnings.push(`自动模式：${autoPlan.sourceKind}（${autoPlan.sourceReason}）→ recipe ${autoInfo.recipe}`
          + (preprocessInfo ? '；已先做 HDR 高光重建' : '')
          + (srInfo ? `；已先做超分（${srInfo.method} ×${srInfo.scale}）` : ''))
      } else {
        const kindText = autoInfo.probe
          ? `AI 主体 ${autoInfo.probe.kind}${autoInfo.probe.frac !== null ? `（${(autoInfo.probe.frac * 100).toFixed(1)}%）` : ''}`
          : `形象检测 ${detection && detection.style ? detection.style : '?'}`
        warnings.push(`自动模式：场景判定 ${autoInfo.scene}（${kindText}），采用 recipe ${autoInfo.recipe}${preprocessInfo ? '；已先做 HDR 高光重建' : ''}${srInfo ? `；已先做超分（${srInfo.method} ×${srInfo.scale}）` : ''}`)
      }
      if (detection && detection.ok === false) warnings.push(`自动场景分析失败，已回退风景流程：${detection.error}`)
    }
    if (checks.some((check) => !check.pass)) {
      warnings.push('有质量校验未通过，可用 params 调参后带 project 追加新版本')
    }
    if (layers) {
      if (String(layers.mask).startsWith('fallback')) {
        warnings.push('AI 主体选区失败，已回退为水平线拆分（可用 params.layers.mask.horizon 调整分界）')
      } else if (layers.bboxFrac !== null && layers.bboxFrac > 0.7 && !String(layers.mask).startsWith('person')) {
        warnings.push(`AI 选区占画面 ${(layers.bboxFrac * 100).toFixed(0)}%，可能把邻近物体也算进主体；可用 params.layers.mask 收窄`)
      }
    }

    const sourceSize = { width: info.width, height: info.height }
    const outputSize = { width: after.width, height: after.height }
    const expectedContentWidth = effectiveCrop.right - effectiveCrop.left
    const resolutionPreserved = outputSize.width === expectedContentWidth

    const durationMs = Date.now() - startedAt
    const record = {
      version,
      recipe: recipe.name,
      recipeLabel: recipe.label,
      source: path.relative(projectDir, inputAbsolute),
      output: path.relative(projectDir, outputPath),
      psd: fs.existsSync(psdPath) ? path.relative(projectDir, psdPath) : null,
      jsx: path.relative(projectDir, jsxPath),
      compare: path.relative(projectDir, comparePath),
      crop,
      dimensions,
      layers,
      regions,
      metrics: { before, after },
      checks,
      params: steps,
      auto: autoInfo,
      preprocess: preprocessInfo,
      superResolution: srInfo,
      assessment: assess && assess.ok ? {
        sourceKind: autoPlan ? autoPlan.sourceKind : null,
        longEdge: assess.longEdge,
        megapixels: assess.megapixels,
        aspect: assess.aspect,
        orientation: assess.orientation,
        blurScore: assess.blurScore,
        noiseScore: assess.noiseScore,
        stripPx: assess.stripPx,
        confidence: assess.confidence,
        exif: assess.exif ? { hasCamera: assess.exif.hasCamera, make: assess.exif.make, model: assess.exif.model } : null,
      } : null,
      orientation: orientationInfo,
      style: styleInfo,
      durationMs,
      createdAt: new Date().toISOString(),
    }
    recordVersion(projectDir, record)
    appendLog(projectDir, {
      event: 'grade',
      version,
      recipe: recipe.name,
      durationMs,
      checks: checks.map((check) => ({ name: check.name, pass: check.pass })),
    })

    // ---- inline learn: bank this result so future auto grades reuse it ------
    let learned = null
    if (args.learn) {
      try {
        const scene = (autoInfo && autoInfo.scene) || (detection && detection.style === 'character' ? 'character' : 'landscape')
        const learnDetection = detection || { ok: false }
        learned = addCase({
          source: path.basename(projectDir),
          project: path.basename(projectDir),
          version,
          recipe: recipe.name,
          params: sanitizeCaseParams(steps),
          style: (styleInfo && styleInfo.name) || 'natural',
          scene,
          features: featureVector(learnDetection, scene),
          detection: learnDetection.ok ? {
            clipPct: learnDetection.clipPct,
            washPct: learnDetection.washPct,
            mean: learnDetection.mean,
            p50: learnDetection.p50,
            skinBlobAreaFrac: learnDetection.skinBlobAreaFrac,
          } : null,
          note: String(args.learn && args.learn.note ? args.learn.note : (args.notes || '')),
        })
      } catch (error) {
        warnings.push(`案例入库失败：${String(error?.message || error).slice(0, 160)}`)
      }
    }

    // ---- auto self-heal: one parameter-adjusted retry when checks fail ------
    const failedChecks = checks.filter((check) => !check.pass)
    // Render-tuned check ranges do not describe real photos well; do not reshape
    // a photo just to satisfy them (results are reported instead).
    const selfHealAllowed = !(autoPlan && autoPlan.sourceKind === 'photo')
    if (autoInfo && selfHealAllowed && !args.__selfHealRetry && args.selfHeal !== false && failedChecks.length > 0) {
      const patch = buildSelfHealPatch(recipe, steps, checks, after)
      if (Object.keys(patch).length > 0) {
        try {
          const retryArgs = Object.assign({}, args, {
            auto: false,
            source: undefined,
            project: projectDir,
            recipe: recipe.name,
            params: deepMerge(steps, patch),
            style: (styleInfo && styleInfo.name) || args.style || 'natural',
            selfHeal: false,
            learn: false,
            __selfHealRetry: true,
          })
          const retryPreprocess = {}
          if (preprocessInfo) retryPreprocess.hdrsynth = { params: preprocessInfo.params }
          if (srInfo) retryPreprocess.superResolution = srOptions
          if (Object.keys(retryPreprocess).length > 0) retryArgs.preprocess = retryPreprocess
          else delete retryArgs.preprocess
          const healed = await grade(retryArgs)
          if (healed && healed.ok) {
            healed.warnings = [
              `自动自愈：首次校验未通过（${failedChecks.map((check) => check.name).join('、')}），已自动调整参数重跑为 v${healed.version}`,
              ...(healed.warnings || []),
            ]
            healed.selfHeal = {
              attempted: true,
              firstChecks: checks.map((check) => ({ name: check.name, pass: check.pass })),
              patch,
            }
            if (autoInfo) healed.auto = autoInfo
            return healed
          }
        } catch (error) {
          warnings.push(`自动自愈重试失败：${String(error?.message || error).slice(0, 160)}`)
        }
      }
    }

    return {
      ok: true,
      projectId: path.basename(projectDir),
      project: projectDir,
      version,
      recipe: { name: recipe.name, label: recipe.label },
      source: inputAbsolute,
      output: outputPath,
      psd: record.psd ? psdPath : null,
      compare: comparePath,
      jsx: jsxPath,
      dimensions,
      layers,
      regions,
      maskPreview: layers && layers.preview ? maskPath : null,
      metrics: { before, after },
      checks,
      warnings,
      ...(autoInfo ? { auto: autoInfo } : {}),
      ...(preprocessInfo ? { preprocess: preprocessInfo } : {}),
      ...(srInfo ? { superResolution: srInfo } : {}),
      ...(assess && assess.ok ? {
        assessment: {
          sourceKind: autoPlan ? autoPlan.sourceKind : null,
          sourceReason: autoPlan ? autoPlan.sourceReason : null,
          longEdge: assess.longEdge,
          megapixels: assess.megapixels,
          aspect: assess.aspect,
          orientation: assess.orientation,
          blurScore: assess.blurScore,
          noiseScore: assess.noiseScore,
          stripPx: assess.stripPx,
          confidence: assess.confidence,
        },
      } : {}),
      ...(orientationInfo ? { orientation: orientationInfo } : {}),
      ...(styleInfo ? { style: styleInfo } : {}),
      ...(learned ? { learned } : {}),
      resolution: {
        source: sourceSize,
        output: outputSize,
        widthPreserved: resolutionPreserved,
        upscale: srInfo ? { method: srInfo.method, scale: srInfo.scale, width: srInfo.width, height: srInfo.height } : null,
      },
      durationMs,
    }
  }

  async function measure(args) {
    const target = String(args.path || '').trim()
    if (!target) throw new Error('需要提供 path（图片路径）')
    const resolved = path.isAbsolute(target) ? target : path.resolve(target)
    if (!fs.existsSync(resolved)) throw new Error(`找不到图片: ${resolved}`)
    const info = await imageInfo(python, resolved)
    const metrics = await imageMeasure(python, resolved)
    let assess = null
    try {
      assess = await imageAssess(python, resolved)
    } catch { assess = null }
    return { ok: true, path: resolved, info, metrics, ...(assess ? { assess } : {}) }
  }


  // ---- first-run onboarding / self-check (triggered by "hilumina") ----------
  function buildOnboard(args = {}) {
    const dataDir = config.casesFile ? path.dirname(config.casesFile) : null
    const modelDirs = defaultModelDirs({ config, dataDir })
    const engineChain = resolveEngineChain(resolveSrOptions(config, null, null))
    const catalog = scanModels({ dirs: modelDirs, engines: engineChain })
    const recommendations = recommendModels(catalog)
    const actions = []
    const userConfigFile = config.userConfigFile
    let userConfig = {}
    try { userConfig = JSON.parse(fs.readFileSync(userConfigFile, 'utf8').replace(/^\uFEFF/, '')) } catch { userConfig = {} }
    if (typeof args.projectRoot === 'string' && args.projectRoot.trim()) {
      const target = path.resolve(args.projectRoot.trim())
      if (!fs.existsSync(target)) throw new Error(`输出目录不存在，请先创建: ${target}`)
      userConfig.projectRoot = target
      fs.writeFileSync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8')
      actions.push(`输出目录已写入 ${userConfigFile}: ${target}（重启 DSH 生效）`)
    }
    if (typeof args.model === 'string' && args.model.trim()) {
      const rawChoice = args.model.trim()
      const autoChoice = /^(用推荐|推荐|默认|auto|recommended)$/i.test(rawChoice)
      const choice = autoChoice ? (recommendModels(catalog).photo || { name: '' }).name : rawChoice
      const hit = catalog.find((item) => item.name === choice)
        || catalog.find((item) => item.name.toLowerCase().includes(choice.toLowerCase()))
      if (!hit) throw new Error(`未找到模型/引擎: ${choice}（可用值见模型一览表）`)
      userConfig.setup = { ...(userConfig.setup || {}), modelChoice: hit.name, modelPath: hit.path, at: new Date().toISOString() }
      const cuda = userConfig.superResolution && userConfig.superResolution.engines && userConfig.superResolution.engines.cuda
      if (cuda && Array.isArray(cuda.args) && hit.kind === 'super-resolution' && hit.runnable !== false) {
        const cleaned = []
        for (let i = 0; i < cuda.args.length; i += 1) {
          if (cuda.args[i] === '--model') { i += 1; continue }
          cleaned.push(cuda.args[i])
        }
        if (!autoChoice) cleaned.push('--model', hit.path)
        cuda.args = cleaned
        actions.push(autoChoice
          ? '已选择“用推荐”：按图片类型自动选权重（照片/截图 -> 通用模型，动漫 -> anime_6B）'
          : `已将该模型写入 CUDA 引擎参数: ${hit.name}（重启 DSH 生效；如需恢复自动选择请回复“用推荐”）`)
      }
      fs.writeFileSync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8')
      if (!actions.length) actions.push(hit.runnable === false
        ? `已记录 ${hit.name}，但它需要适配器（${hit.note || '旧格式/其他架构'}），暂未接入引擎参数`
        : `已记录模型偏好 ${hit.name}`)
    }
    const venvPython = dataDir ? path.join(dataDir, 'ai', 'venv', 'Scripts', 'python.exe') : null
    const hardware = probeHardware({ dataDir, venvPython })
    const tierCatalog = loadModelCatalog(ASSETS_DIR)
    const tierModelsDir = modelDirs.find((dir) => { try { return fs.existsSync(dir) } catch { return false } }) || (modelDirs[0] || null)
    const tiers = evaluateTiers(tierCatalog, hardware, { modelsDir: tierModelsDir, engines: engineChain })
    const installPaths = defaultInstallPaths({ dataDir, userConfig, overrides: { downloadDir: args.downloadDir, installDir: args.installDir } })
    if (typeof args.download === 'string' && args.download.trim()) {
      const wanted = args.download.trim().toLowerCase()
      const entry = tiers.find((item) => item.id === wanted || item.label.toLowerCase().includes(wanted))
      if (!entry) throw new Error(`未知模型档位: ${args.download}`)
      if (entry.status === 'unsupported') throw new Error(`本机跑不动 ${entry.label}: ${entry.problems.join('；')}`)
      const catalogEntry = (tierCatalog.tiers || []).find((item) => item.id === entry.id)
      const plan = buildInstallPlan(catalogEntry || entry, installPaths)
      userConfig.paths = { ...(userConfig.paths || {}), downloadDir: installPaths.downloadDir, installDir: installPaths.installDir, venvDir: installPaths.venvDir, modelsDir: installPaths.modelsDir }
      fs.writeFileSync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8')
      const installer = startInstall(plan, { python, logFile: path.join(installPaths.installDir || '.', `install-${entry.id}.log`) })
      if (entry.id === 'supir' && installPaths.installDir) {
        try {
          fs.mkdirSync(installPaths.installDir, { recursive: true })
          fs.copyFileSync(path.join(ASSETS_DIR, 'upscale_supir.py'), path.join(installPaths.installDir, 'upscale_supir.py'))
          fs.copyFileSync(path.join(ASSETS_DIR, 'supir_compat.py'), path.join(installPaths.installDir, 'supir_compat.py'))
          userConfig.superResolution = userConfig.superResolution || {}
          userConfig.superResolution.engines = userConfig.superResolution.engines || {}
          userConfig.superResolution.engines.supir = {
            priority: 110,
            label: 'SUPIR (SDXL diffusion)',
            command: path.join(installPaths.venvDir || '', 'Scripts', 'python.exe'),
            args: [path.join(installPaths.installDir, 'upscale_supir.py'), '--input', '{input}', '--output', '{output}',
                   '--scale', '{scale}', '--kind', '{sourceKind}', '--model-dir', path.join(installPaths.installDir, 'supir'),
                   '--code-dir', path.join(installPaths.installDir, 'supir-code')],
          }
          fs.writeFileSync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8')
          actions.push('SUPIR 引擎已登记（priority 90，实验性）；安装+重启 DSH 后自动进入质量优先链')
        } catch (error) {
          actions.push('SUPIR 引擎登记失败: ' + String(error && error.message || error).slice(0, 120))
        }
      }
      actions.push(`下载目录: ${installPaths.downloadDir}`)
      actions.push(`安装目录: ${installPaths.installDir}`)
      actions.push(`${entry.label} 依赖安装已在后台启动（权重 + Python 依赖 + venv 一次装全）`)
      actions.push(`安装脚本: ${installer.scriptPath} · 日志: ${installer.logFile}`)
    }
    const existingRoot = typeof userConfig.projectRoot === 'string' && userConfig.projectRoot.trim()
      && fs.existsSync(userConfig.projectRoot)
    const nativeModels = catalog.filter((item) => item.kind === 'super-resolution' && item.runnable !== false)
    const recommendedPhoto = recommendations && recommendations.photo
    const selectedModel = userConfig.setup && userConfig.setup.modelChoice
    const suggestion = selectedModel && recommendedPhoto && recommendedPhoto.name !== selectedModel
      ? {
        current: selectedModel,
        recommended: recommendedPhoto.name,
        note: `检测到本机推荐模型 ${recommendedPhoto.name}，当前默认是 ${selectedModel}；回复「换成 ${recommendedPhoto.name}」可切换，或忽略保持现状`,
      }
      : null
    const engineChainText = engineChain.map((item) => `${item.label}(${item.priority})`).join(' → ') || '内置 Lanczos'
    const questions = []
    // An explicit `hilumina` self-check always surfaces the two decisions a user
    // most often wants to change, even when the profile is already configured.
    questions.push(`输出文件夹：当前 ${userConfig.projectRoot || '未设置'}；回复新路径可修改（需已存在），或跳过保持`)
    questions.push(`CUDA 兜底模型：当前 ${selectedModel || '未选择'}${recommendedPhoto ? `；本机推荐 ${recommendedPhoto.name}` : ''}；当前超分链 ${engineChainText}（SUPIR 为最高优先；回复「用推荐」恢复按内容自动选择）`)
    if (args.forceAsk === true) {
      questions.push(`确认：以上两项会写入 ${userConfigFile || '用户配置'}，如需修改请直接回复；跳过则保持不变`)
    }
    if (!existingRoot) questions.push('请提供输出文件夹路径（如 D:/AIPS，需已存在）')
    if (!selectedModel && nativeModels.length === 0) questions.push('本机没有可直接运行的超分模型：可下载 Real-ESRGAN 权重，或保持内置 Lanczos')
    else if (!selectedModel && nativeModels.length > 0) questions.push(`请选择模型（可运行: ${nativeModels.map((item) => item.name).join(', ')}）`)
    return {
      configured: { outputFolder: Boolean(existingRoot), model: Boolean(selectedModel), engines: engineChain.length > 0 },
      current: {
        outputFolder: userConfig.projectRoot || null,
        modelChoice: selectedModel || null,
        cudaModel: selectedModel || null,
        engineChain: engineChain.map((item) => ({ label: item.label, priority: item.priority })),
        engineChainText,
        supirActive: engineChain.some((item) => String(item.label || '').toUpperCase().includes('SUPIR')),
        styleDefaults: userConfig.assess || null,
      },
      questions,
      suggestion,
      forceAsk: args.forceAsk === true,
      hardware,
      tiers,
      modelsDir: tierModelsDir,
      installPaths,
      installs: readInstallStatus(installPaths),
      installHint: '下载前请确认：可回复自定义“下载到 <路径>，安装到 <路径>”；直接说档位名则用以上默认路径',
      dependencies: {
        python: { ok: fs.existsSync(python), path: python },
        photoshop: { version: (session && session.version) || null, lutDir: resolveLutDir(config.lutDir) },
        userConfig: { file: userConfigFile, exists: fs.existsSync(userConfigFile) },
        outputFolder: config.projectRoot,
        modelDirs,
        engines: engineChain.map((item) => ({ label: item.label, priority: item.priority })),
      },
      modelTable: formatModelTable(catalog),
      recommendations,
      actions,
      next: [
        '请确认/指定输出文件夹（复制路径发我即可，例如 D:/AIPS）',
        '请从模型一览里选一个模型（或回复“用推荐”）',
        '设置完成后重启 DSH 生效',
      ],
    }
  }

  async function state(args = {}) {
    const srOptions = resolveSrOptions(config, null, null)
    const result = {
      ok: true,
      projectRoot: config.projectRoot,
      python,
      lutDir: resolveLutDir(config.lutDir),
      stylesFile: stylesFilePath(),
      stylesFileExists: Boolean(stylesFilePath() && fs.existsSync(stylesFilePath())),
      userConfigFile: config.userConfigFile || null,
      caseBank: caseBankInfo(),
      superResolution: srOptions,
      onboard: buildOnboard(args),
      superResolutionEngine: {
        command: srOptions.command || null,
        commandExists: Boolean(srOptions.command && fs.existsSync(srOptions.command)),
        fallback: srOptions.fallback || 'lanczos',
        chain: resolveEngineChain(srOptions).map((engine) => ({ key: engine.key, label: engine.label, priority: engine.priority, command: engine.command })),
      },
      assessOptions: isPlainObject(config.assess) ? config.assess : DEFAULT_AUTO_ASSESS,
      session: { running: Boolean(session?.running), version: session?.version || null, documents: 0 },
      recipes: listRecipes(),
      styles: listStyles(),
      autoCases: listCases(20),
      recentProjects: listProjects(config.projectRoot, 10),
    }
    if (args.quit === true) {
      await session.quit()
      result.session = { running: false, version: null, documents: 0 }
      result.message = 'Photoshop 已退出（下次 ps_grade 会自动重新启动）'
      return result
    }
    if (session && (args.start === true || session.running)) {
      try {
        const live = await session.state()
        result.session = { running: true, version: live.version, documents: live.documents }
      } catch (error) {
        result.session = { running: false, version: null, documents: 0 }
        result.sessionError = String(error?.message || error)
      }
    }
    return result
  }

  return { grade, measure, state, logger }
}
