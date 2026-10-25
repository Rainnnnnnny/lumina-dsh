/**
 * Universal auto-pipeline assessment rules.
 *
 * `ps_grade` with `auto: true` should not require the user to say "this is a
 * game screenshot" or "this is a real photo": the assess stage (metrics.py
 * `assess`) produces size/EXIF/blur/noise/tonality signals, and this module
 * turns them into a concrete plan:
 *
 *   - sourceKind: screenshot | photo | illustration
 *   - crop:       bottom-strip (screenshots) | auto (photos/render)
 *   - superResolution: trigger when the image is low-resolution or blurry
 *   - hdr:        auto HDR reconstruction for clipped screenshots/renders
 *   - recipeHint: gentle recipe for real photos
 *
 * Everything here is pure (no I/O) so it can be unit-tested without Photoshop
 * or a GPU. Thresholds are deliberately conservative: the acceptance suite and
 * the existing auto baselines must stay byte-identical for sharp screenshots.
 */
export const DEFAULT_AUTO_ASSESS = {
  // below this long edge -> always upscale (low-resolution source)
  minLongEdge: 1600,
  // blur score measured at 1024px working long edge; lower = softer/blurrier
  blurThreshold: 0.010,
  // blurry images larger than this are not auto-upscaled (too expensive /
  // no benefit); a restore hint is reported instead
  maxBlurUpscaleEdge: 2600,
  maxLongEdge: 8192,
  // aspect ratio (long/short) considered photo-like; phone photos are 4:3 / 3:4,
  // game screenshots are typically ultra-wide (>= 1.8)
  photoAspectMin: 0.66,
  photoAspectMax: 1.55,
  screenshotAspectMin: 1.8,
  // gentle default recipe for real photos (auto-* recipes are tuned for renders)
  // HDR-look recipe for photos (tone-mapping look, not washed-highlight repair)
  photoRecipe: 'hdr-photo',
  // auto HDR reconstruction only when highlights are clipped this much
  hdrClipThreshold: 2.5,
  // photos: attempt HDR highlight reconstruction by default (washed-highlight look)
  // and apply a gentle colour style unless the caller overrides it
  // 'clipping' (default) = run hdrsynth only for genuinely clipped highlights;
  // true = force the repair pass; false = never.
  photoHdr: 'clipping',
  photoStyle: 'natural',
}

function mergeOptions(options) {
  return { ...DEFAULT_AUTO_ASSESS, ...(options && typeof options === 'object' ? options : {}) }
}

/**
 * Classify the source image. Order matters:
 *   1. a high-confidence screenshot UI strip  -> screenshot
 *   2. camera EXIF (Make/Model)               -> photo
 *   3. EXIF-only files with photo-like aspect -> photo (metadata-stripped exports)
 *   4. photo-like aspect ratio without strip  -> photo
 *   5. otherwise                              -> illustration/render
 */
export function classifySource(assess, options = {}) {
  const opts = mergeOptions(options)
  const a = assess || {}
  const stripPx = Number(a.stripPx) || 0
  if (stripPx > 0 && a.confidence === 'high') {
    return { kind: 'screenshot', reason: `底部 UI 条 ${stripPx}px（置信度 high）` }
  }
  const exif = a.exif || {}
  if (exif.hasCamera) {
    return { kind: 'photo', reason: `相机 EXIF ${[exif.make, exif.model].filter(Boolean).join(' ')}` }
  }
  const aspect = Number(a.aspect) || (Number(a.longEdge) > 0 ? Number(a.longEdge) / Math.max(1, Number(a.shortEdge)) : 1)
  const photoLike = aspect >= opts.photoAspectMin && aspect <= opts.photoAspectMax
  if (exif.hasExif && photoLike) {
    return { kind: 'photo', reason: `EXIF + 画幅 ${aspect}:1（照片）` }
  }
  if (photoLike && stripPx === 0) {
    return { kind: 'photo', reason: `画幅 ${aspect}:1 且无 UI 条（照片/相机图）` }
  }
  return { kind: 'illustration', reason: '无 UI 条 / 无相机 EXIF / 非照片画幅（渲染图或截图）' }
}

/**
 * Build the auto plan from an `assess` result.
 * Returns { sourceKind, sourceReason, crop, superResolution, hdr, recipeHint,
 *           restoreHint, evidence }.
 */
export function planAuto(assess, options = {}) {
  const opts = mergeOptions(options)
  const a = assess || {}
  const source = classifySource(a, opts)
  const longEdge = Number(a.longEdge) || 0
  const megapixels = Number(a.megapixels) || 0
  const blur = Number(a.blurScore)

  const srReasons = []
  if (longEdge > 0 && longEdge < opts.minLongEdge) {
    srReasons.push(`低分辨率（长边 ${longEdge} < ${opts.minLongEdge}）`)
  }
  if (Number.isFinite(blur) && blur < opts.blurThreshold && longEdge <= opts.maxBlurUpscaleEdge) {
    srReasons.push(`模糊（blur ${blur} < ${opts.blurThreshold}）`)
  }

  let superResolution = { triggered: false, scale: 1, reason: '图像分辨率/清晰度足够，不需要超分' }
  let restoreHint = ''
  if (srReasons.length > 0) {
    let scale = 2
    if (longEdge * scale > opts.maxLongEdge) scale = opts.maxLongEdge / longEdge
    if (scale >= 1.05) {
      superResolution = {
        triggered: true,
        scale: Number(scale.toFixed(2)),
        reason: srReasons.join('；'),
      }
    } else {
      restoreHint = `图像模糊但长边已达 ${longEdge}（上限 ${opts.maxLongEdge}），不再放大；可手动开启 AI 修复`
    }
  } else if (Number.isFinite(blur) && blur < opts.blurThreshold) {
    restoreHint = `检测到图像偏软/模糊（blur ${blur}），长边 ${longEdge} 已较大；建议用 AI 恢复（superResolution mode:"always", scale:1）而不是继续放大`
  }

  const crop = source.kind === 'screenshot' ? 'bottom-strip' : 'auto'
  const clipHi = Number(a.clipHi)
  // hdrsynth is a washed-highlight *repair* pass, not a general 'texture' filter:
  // photos only use it when highlights are genuinely clipped (or photoHdr:true forces it).
  const hdr = source.kind === 'photo'
    ? (opts.photoHdr === true || (opts.photoHdr !== false && Number.isFinite(clipHi) && clipHi >= opts.hdrClipThreshold))
    : (Number.isFinite(clipHi) && clipHi >= opts.hdrClipThreshold)

  return {
    sourceKind: source.kind,
    sourceReason: source.reason,
    crop,
    superResolution,
    hdr,
    recipeHint: source.kind === 'photo' ? opts.photoRecipe : null,
    photoStyle: source.kind === 'photo' ? opts.photoStyle : null,
    // Universal layered HDR: choose the region mask by content shape.
    photoMask: source.kind === 'photo'
      ? (Number(a.height) > Number(a.width) ? 'person' : 'horizon')
      : null,
    restoreHint,
    evidence: {
      longEdge,
      megapixels: Number(megapixels.toFixed(2)),
      blurScore: Number.isFinite(blur) ? blur : null,
      noiseScore: Number.isFinite(Number(a.noiseScore)) ? Number(a.noiseScore) : null,
      aspect: Number(a.aspect) || null,
      stripPx: Number(a.stripPx) || 0,
      confidence: a.confidence || 'none',
    },
    thresholds: opts,
  }
}


/**
 * Content-aware recipe routing for the auto pipeline (no explicit recipe).
 *  - screenshots with a detected character -> region-zones (人物/绿叶/白花)
 *  - landscape photos -> region-sky (sky colour domain)
 *  - everything else keeps the existing auto recipe (portrait -> hdr-photo...)
 */
export function routeZoneRecipe({ explicitRecipe, autoPlan, detection, scene, probe } = {}) {
  if (explicitRecipe) return null
  if (scene === 'character') return 'region-zones'
  if (scene === 'landscape') return 'region-sky'
  const kind = autoPlan && autoPlan.sourceKind
  const skinFrac = Number(detection && detection.skinBlobAreaFrac || 0)
  const style = String(detection && detection.style || '')
  const probeFrac = Number(probe && probe.frac)
  const probePerson = Boolean(probe && probe.kind === 'subject-ai' && Number.isFinite(probeFrac) && probeFrac >= 0.02 && probeFrac <= 0.38)
  if (kind === 'screenshot' && probePerson) return 'region-zones'
  if (kind === 'screenshot' && style === 'character' && skinFrac >= 0.003 && probe && probe.kind === 'subject-ai') return 'region-zones'
  if (kind === 'photo') {
    // Portrait/person photos keep hdr-photo. Landscape photos also keep the
    // generic hdr-photo recipe: region-sky over-brightens lake/snow scenes, so
    // it is opt-in only via params.scene = "landscape".
    return null
  }
  return null
}
