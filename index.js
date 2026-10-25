/**
 * lumina-dsh — Photoshop post-processing automation for DSH.
 *
 * Registers the full Lumina tool suite (Photoshop automation + vision
 * inspection):
 *   ps_grade / ps_measure / ps_state
 *   vision_zoom / vision_probe / vision_textmap
 *   (the vision tools were merged in from the former separate
 *    dsh-vision / dsh-vision-text plugins)
 *
 * Tools:
 *   ps_grade   run a parameterized recipe on an image, creating a project folder
 *              with input/work/out/metrics, a comparison sheet and automatic
 *              quality checks
 *   ps_measure image quality metrics for any image file
 *   ps_state   Photoshop session state, recipes, recent projects
 */
import os from 'node:os'
import path from 'node:path'

import { resolvePython } from './lib/py.js'
import { PsSession } from './lib/ps-session.js'
import { createHandlers } from './lib/grade.js'
import { apply as applyVisionTools } from './lib/vision-zoom.js'
import { apply as applyVisionTextTools } from './lib/vision-text.js'
import { listRecipes, listStyles } from './lib/recipes.js'
import { loadUserConfig, userConfigPath } from './lib/user-config.js'
import { mergeSuperResolution } from './lib/superres.js'
import { DEFAULT_AUTO_ASSESS } from './lib/assess.js'

export const inject = ['tools', 'attachments']

function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * Default project root resolution:
 *   env LUMINA_PROJECT_ROOT / DSH_PHOTOSHOP_PROJECT_ROOT
 *   > user config `projectRoot`
 *   > <home>/Lumina
 * (An explicit plugin config `projectRoot` always wins over all of these.)
 */
export function defaultProjectRoot(userConfig = loadUserConfig()) {
  const configured = envFirst('LUMINA_PROJECT_ROOT', 'DSH_PHOTOSHOP_PROJECT_ROOT')
  if (configured) return path.resolve(configured)
  if (typeof userConfig?.projectRoot === 'string' && userConfig.projectRoot.trim()) {
    return path.resolve(userConfig.projectRoot.trim())
  }
  return path.join(os.homedir(), 'Lumina')
}

function textBlocks(lines) {
  const text = Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines ?? '')
  return [{ type: 'text', text: text || '(无内容)' }]
}

function formatMetricsLine(before, after) {
  return `高光溢出 ${before.clipHi}% → ${after.clipHi}% · 锐度 ${before.sharp} → ${after.sharp}`
    + ` · 中间调 p50 ${before.p50} → ${after.p50} · 饱和 ${before.sat} → ${after.sat}`
}

function buildGradeTool({ config, session, python }) {
  const handlers = createHandlers({ config, session, python })
  return {
    name: 'ps_grade',
    description: [
      '用 Photoshop 对图片执行参数化修图 recipe，并自动建立工程目录。',
      '【零提示词默认流程】用户丢来一张图、没有额外要求时：直接调用 auto:true。auto 是**通用自动路径**，不分游戏截图/真实照片：先自动评估（分辨率、EXIF 方向、模糊度、噪声、UI 条、过曝率）→ 判断来源（截图/照片/渲染）→ 低清或模糊时先超分（AI 引擎可用用 AI，不可用自动回落 Lanczos）→ 高光溢出时 HDR 重建 → 截图裁 UI 条/照片保留原画幅 → 选 recipe 出片，并把判断结果写进 auto.plan 与 warnings。',
      `每个任务会在 ${config.projectRoot} 下创建 <时间戳>-<标题>/ 工程文件夹，包含：input/ 原图、work/ 生成的 JSX 与 PSD、out/ 成品、metrics/ 指标、compare-vN.png 前后对比图、project.json 版本历史。`,
      `可用 recipe: ${listRecipes().map((item) => `${item.name}（${item.label}）`).join('、')}。`,
      '其中 subject-pop（人物/背景分离）与 landscape-depth（前景/背景纵深）会自动拆分图层：主体层和背景层分别套不同参数，再自动合成；',
      '蒙版策略写在 params.layers.mask：{mode:"person"|"subject"|"horizon"|"polygon"|"alpha"|"depth"|"none"}。person=AI主体∩人物椭圆，subject=AI前景，horizon=水平线分割（horizon 为 0~1 高度比例），polygon=手绘/分片多边形，alpha=通道蒙版（alphaFile 指向 RGBA PNG，读图层透明通道做每像素软 alpha，发丝边缘），depth=前景/中景/背景三层渐变分隔（band1/band2/feather1/feather2，可选 midAlphaFile 让中景=人物），none=不分层。',
      '示例：{"layers":{"mask":{"mode":"alpha","alphaFile":"C:/.../alpha-cutout.png","edgeSafe":14}}} 或 {"layers":{"mask":{"mode":"depth","band1":0.33,"band2":0.88,"feather1":150,"feather2":110,"midAlphaFile":"C:/.../alpha-cutout.png"}}}',
      '其余参数用 params 深合并覆盖（如 {"tone":{"gamma":0.85},"vignette":30}），裁剪用 crop（{"mode":"none"} 或 {"bottom":1200}）。',
      '【风格库】style 参数可叠加 Photoshop 自带的 3D LUT（纯颜色映射，不加颗粒；本机需安装 Photoshop，LUT 文件不随插件分发）：' + listStyles().map((item) => `${item.name}（${item.label}）`).join('、') + '。会自动做清晰度守门：LUT 让锐度下降 >2% 时自动降强度，仍不行就跳过（清晰优先）。',
      '自动模式下也支持：auto:{look:"hdr"|"natural", lutStyle:"cinema"}，或直接 auto:{style:"cinema"}。',
      '【自动自愈】auto 模式下若质量校验未通过，会自动算一个小参数补丁（降白场/减 bloom/调 gamma）并重跑一次，返回自愈后的版本。',
      '【风格案例库】auto 模式会先查案例库：当前图特征（过曝率/亮度/主体占比/场景）最近邻命中时，直接复用那次被认可的 recipe + 参数 + 风格。用 learn:true（配 project）把认可的版本入库。',
      '返回工程路径、产物、前后指标、质量校验与蒙版预览；参数不满意可带 project 追加新版本调参。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源图片绝对路径；若指定已有 project 可省略' },
        recipe: { type: 'string', enum: listRecipes().map((item) => item.name), description: 'recipe 名称，默认 clean-premium' },
        title: { type: 'string', description: '任务标题（用于工程文件夹名），默认取文件名' },
        notes: { type: 'string', description: '本次任务的目标/描述，写入 project.json' },
        params: { type: 'object', description: 'recipe 参数深合并覆盖对象', additionalProperties: true },
        crop: { type: 'object', description: '裁剪覆盖：{mode:"auto"|"none"|"bottom-strip",adjustPx,fallbackPx} 或 {left,top,right,bottom} 绝对像素。真实照片建议 auto/none（auto 只在检测置信度高时才裁底部条）', additionalProperties: true },
        learn: { anyOf: [{ type: 'boolean' }, { type: 'object' }], description: '把认可的结果记入风格案例库：true（配合本次出片）或 {version:N, note:"..."}（配合 project 只登记已有版本）' },
        selfHeal: { type: 'boolean', description: 'auto 模式下校验失败是否自动调参重跑一次（默认 true）' },
        style: {
          type: 'string',
          description: `风格（纯颜色 LUT 或"LUT + 参数预设"），默认 natural。当前可用: ${listStyles().map((item) => `${item.name}${item.source === 'user' ? '*' : ''}（${item.label}）`).join('、')}。* = stylesFile 热加载的自定义风格；新增/替换风格直接改 stylesFile（默认 <home>/.lumina/styles.json），无需重启 DSH。锐度下降>2% 会自动降强度/跳过`,
        },
        auto: { anyOf: [{ type: 'boolean' }, { type: 'object' }], description: '通用自动模式：true 或 {scene:"character"|"landscape"|"photo", hdrThreshold:2.5, recipe, params, hdrsynth, superResolution, caseThreshold}。会自动评估清晰度/画幅/来源：低清或模糊先超分（AI 不可用自动回落 Lanczos），截图裁 UI 条，照片保留原画幅；判断结果见结果里的 auto.plan' },
        preprocess: { type: 'object', description: '预处理：{hdrsynth:{mode:"neutral", params:{...}}, superResolution:{enabled,mode:"auto"|"always",scale,minLongEdge,minSharpness,maxLongEdge,command,args,fallback:"lanczos"|"skip"}}；auto 模式下 HDR/超分按评估结果自动决定', additionalProperties: true },
        project: { type: 'string', description: `已有工程目录（绝对路径或 ${config.projectRoot} 下的文件夹名），用于追加版本` },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          project: { type: 'string' },
          projectId: { type: 'string' },
          version: { type: 'number' },
          recipe: { type: 'object' },
          source: { type: 'string' },
          output: { type: 'string' },
          psd: { type: 'string' },
          compare: { type: 'string' },
          jsx: { type: 'string' },
          dimensions: { type: 'string' },
          resolution: { type: 'object' },
          // layers / maskPreview / regions are only present for layered recipes
          // and are rendered by the tool; the schema stays permissive
          // (additionalProperties: true) instead of declaring nullable objects.
          metrics: { type: 'object' },
          auto: { type: 'object' },
          preprocess: { type: 'object' },
          superResolution: { type: 'object' },
          style: { type: 'object' },
          learned: { type: 'object' },
          selfHeal: { type: 'object' },
          checks: { type: 'array' },
          warnings: { type: 'array' },
          durationMs: { type: 'number' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['❌ 处理失败'])
        if (value.learned && !value.recipe) {
          const cases = value.cases || []
          return textBlocks([
            `✅ 已入库案例 ${value.learned.id}`,
            `recipe: ${value.learned.recipe} · 风格: ${value.learned.style || 'natural'} · 场景: ${value.learned.scene} · 版本 v${value.learned.version}`,
            `案例库: 共 ${cases.length} 条（最近 ${cases.length} 条）`,
            ...cases.slice(0, 5).map((entry) => `  · ${entry.id} ${entry.recipe} ${entry.style || ''} ${entry.scene}`),
          ])
        }
        const lines = [
          `✅ ${value.recipe.label} · v${value.version} · ${(value.durationMs / 1000).toFixed(1)}s`,
          value.auto && value.auto.case
            ? `案例库命中: ${value.auto.case.id}（距离 ${value.auto.case.distance}，复用 ${value.auto.case.recipe}${value.auto.case.style ? ' + ' + value.auto.case.style : ''}）`
            : null,
          value.auto
            ? `自动: 场景=${value.auto.scene}`
              + (value.auto.probe && value.auto.probe.kind
                ? ` · AI主体=${value.auto.probe.kind}${value.auto.probe.frac !== null && value.auto.probe.frac !== undefined ? `(${(value.auto.probe.frac * 100).toFixed(1)}%)` : ''}`
                : '')
              + ` · recipe=${value.auto.recipe}`
            : null,
          value.auto && value.auto.plan
            ? `自动判断: ${value.auto.plan.sourceKind}（${value.auto.plan.sourceReason}）`
              + ` · 裁剪=${value.auto.plan.crop}`
              + ` · 超分=${value.auto.plan.superResolution.triggered
                ? `触发 ×${value.auto.plan.superResolution.scale}（${value.auto.plan.superResolution.reason}）`
                : `不触发（${value.auto.plan.superResolution.reason}）`}`
              + ` · 模糊度=${value.auto.plan.evidence.blurScore}`
            : null,
          value.orientation
            ? `EXIF 方向: 旋转 ${value.orientation.from}° 已归一化为 ${value.orientation.width}×${value.orientation.height}`
            : null,
          value.preprocess
            ? `预处理: HDR 高光重建（hdrsynth neutral，源图溢出 ${value.preprocess.clipPct}%）`
            : null,
          value.superResolution
            ? `超分预处理: ${value.superResolution.method} ×${value.superResolution.scale}`
              + (value.superResolution.engine ? ` · 引擎 ${value.superResolution.engine}` : '')
              + (value.superResolution.chain && value.superResolution.chain.length > 1
                ? `（质量优先链: ${value.superResolution.chain.map((item) => `${item.label}${item.ok ? '✓' : '✗'}`).join(' → ')}）`
                : '')
              + `（${value.superResolution.reason}）`
            : null,
          value.style
            ? `风格: ${value.style.label}`
              + (value.style.applied
                ? `（强度 ${value.style.strength}%，锐度 ${value.style.sharpDeltaPct >= 0 ? '+' : ''}${value.style.sharpDeltaPct}%）`
                : (value.style.params ? '（参数预设已应用）' : '（未应用）'))
            : null,
          `工程目录: ${value.project}`,
          `成品: ${value.output}`,
          value.psd ? `PSD: ${value.psd}` : null,
          `对比图: ${value.compare}`,
          value.resolution
            ? `分辨率: ${value.resolution.source.width}×${value.resolution.source.height}`
              + (value.resolution.upscale ? ` → 超分 ${value.resolution.upscale.width}×${value.resolution.upscale.height}` : '')
              + ` → 成品 ${value.resolution.output.width}×${value.resolution.output.height}`
              + (value.resolution.upscale ? '' : (value.resolution.widthPreserved ? '（宽度保持原图）' : '（⚠ 宽度小于原图）'))
            : null,
          value.layers
            ? `分层: ${value.layers.mask}`
              + (value.layers.bboxFrac !== null ? `（AI 选区占画面 ${(value.layers.bboxFrac * 100).toFixed(0)}%）` : '')
              + ` | 主体参数: ${(value.layers.subject || []).join(',') || '—'} | 背景参数: ${(value.layers.background || []).join(',') || '—'}`
            : null,
          value.maskPreview ? `蒙版预览: ${value.maskPreview}` : null,
          value.regions && value.regions.deltas
            ? `区域校验: 主体锐度 ×${value.regions.deltas.subjectSharpGain}（亮度 ${value.regions.deltas.subjectMeanDelta >= 0 ? '+' : ''}${value.regions.deltas.subjectMeanDelta}）`
              + ` · 背景锐度 ×${value.regions.deltas.backgroundSharpGain}`
            : null,
          `指标: ${formatMetricsLine(value.metrics.before, value.metrics.after)}`,
        ]
        const failed = (value.checks || []).filter((check) => !check.pass)
        lines.push(
          failed.length === 0
            ? `校验: ${value.checks.length}/${value.checks.length} 通过`
            : `校验: ${value.checks.length - failed.length}/${value.checks.length} 通过；未通过 ${failed.map((check) => check.name).join('、')}`,
        )
        if (value.learned) lines.push(`案例库: 已入库 ${value.learned.id}（${value.learned.recipe}${value.learned.style ? ' + ' + value.learned.style : ''}）`)
        if (value.selfHeal) lines.push('自愈: 已重跑一次（自动补丁已应用）')
        for (const warning of value.warnings || []) lines.push(`提示: ${warning}`)
        return textBlocks(lines)
      },
    },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return handlers.grade(args || {})
    },
  }
}

function buildMeasureTool({ config, python }) {
  const handlers = createHandlers({ config, session: null, python })
  return {
    name: 'ps_measure',
    description: '计算图片质量指标（亮度分布、高光/暗部溢出、饱和度、锐度、尺寸、底部 UI 条检测）+ 自动评估（模糊度、噪声、EXIF 方向、照片/截图判断、是否建议超分），返回 JSON；不修改文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片绝对路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          info: { type: 'object' },
          metrics: { type: 'object' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['❌ 读取指标失败'])
        const metrics = value.metrics
        const assess = value.assess
        const lines = [
          `尺寸 ${metrics.width}×${metrics.height} · 格式 ${metrics.format}`,
          `亮度 平均 ${metrics.mean} / p50 ${metrics.p50} / p1 ${metrics.p1} / p99 ${metrics.p99} · 对比 ${metrics.std}`,
          `高光溢出 ${metrics.clipHi}% · 暗部溢出 ${metrics.clipLo}% · 饱和 ${metrics.sat} · 锐度 ${metrics.sharp}`,
          `底部 UI 条检测: ${value.info.stripPx > 0 ? `${value.info.stripPx}px (${value.info.confidence})` : '未检测到'}`,
        ]
        if (assess) {
          const kind = assess.stripPx > 0 && assess.confidence === 'high'
            ? '截图'
            : ((assess.aspect >= 0.66 && assess.aspect <= 1.55) ? '照片（画幅）' : '渲染/截图')
          lines.push(`评估: ${kind} · 模糊度 ${assess.blurScore}（1024px 归一口径） · 噪声 ${assess.noiseScore} · 长边 ${assess.longEdge} / ${assess.megapixels}MP`)
          if (assess.exif) lines.push(`EXIF: ${assess.exif.hasCamera ? `相机 ${[assess.exif.make, assess.exif.model].filter(Boolean).join(' ')}` : '无相机信息'} · orientation=${assess.orientation}`)
        }
        return textBlocks(lines)
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return handlers.measure(args || {})
    },
  }
}

function buildStateTool({ config, session, python }) {
  const handlers = createHandlers({ config, session, python })
  return {
    name: 'ps_state',
    description: `查看 Photoshop 会话状态（是否启动、版本、打开文档数）、可用 recipe、${config.projectRoot} 下最近工程列表。可传 start=true 预热，quit=true 释放。\n【首次安装自检 / hilumina】当用户输入 hilumina、初始化、安装自检、配置输出文件夹、挑选超分模型时，调用本工具并传 onboard:true：会检查依赖/配置、列出本机所有 AI 超分模型与推荐模型，并提示用户提供输出文件夹（再用 projectRoot 参数写入）和模型（用 model 参数写入）。`,
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'boolean', description: '是否启动/预热 Photoshop 会话（首次约 6-10 秒）' },
        quit: { type: 'boolean', description: '是否退出 Photoshop 会话并释放内存' },
        onboard: { type: 'boolean', description: '首次安装自检：检查依赖、列出 AI 超分模型并给出推荐（用户输入 hilumina / 初始化时传 true）' },
        projectRoot: { type: 'string', description: '初始化时设置输出文件夹（必须是已存在的目录），写入用户配置' },
        model: { type: 'string', description: '初始化时选择模型/引擎名称（从模型一览表中选），写入用户配置' },
        forceAsk: { type: 'boolean', description: '强制走一遍初始化提问（即使配置已完整），用于首次装机引导/测试' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          projectRoot: { type: 'string' },
          python: { type: 'string' },
          session: { type: 'object' },
          recipes: { type: 'array' },
          recentProjects: { type: 'array' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlocks(['❌ 状态读取失败'])
        const sessionInfo = value.session || {}
        const lines = [
          `Photoshop: ${sessionInfo.running ? `运行中 (${sessionInfo.version || 'unknown'})` : '未启动（首次 ps_grade 会自动启动）'}`,
          (() => { const major = parseInt(String(sessionInfo.version || '0').split('.')[0], 10); return major > 0 && major < 21 ? '⚠ Photoshop 版本低于 2020：Select Subject/AI 主体分层会自动回退，建议升级到 2020+（2025 已实测）' : null })(),
          `工程根目录: ${value.projectRoot}`,
          `Python: ${value.python}`,
          `风格 LUT 目录: ${value.lutDir || '未找到（风格将跳过；需安装带 Presets/3DLUTs 的 Photoshop，或用 lutDir 配置指定）'}`,
          `Recipe: ${(value.recipes || []).map((item) => `${item.name}（${item.label}）`).join('、')}`,
          `风格: ${(value.styles || []).map((item) => `${item.name}${item.source === 'user' ? '*' : ''}`).join('、')}`,
          `案例库: ${(value.autoCases || []).length} 条`,
        ]
        if (value.stylesFile) lines.push(`自定义风格文件: ${value.stylesFile}${value.stylesFileExists ? '（* 号风格来自这里；可热加载）' : '（尚未创建；可复制 assets/styles.example.json 后热加载）'}`)
        if (value.userConfigFile) lines.push(`用户配置文件: ${value.userConfigFile}`)
        if (value.onboard) {
          const ob = value.onboard
          lines.push('')
          lines.push('=== 安装自检 ===')
          lines.push(`Python: ${ob.dependencies.python.ok ? 'OK' : '缺失'} · ${ob.dependencies.python.path}`)
          lines.push(`Photoshop: ${ob.dependencies.photoshop.version ? ob.dependencies.photoshop.version : '未启动（首次 ps_grade 会自动启动）'} · LUT: ${ob.dependencies.photoshop.lutDir || '未找到'}`)
          lines.push(`输出文件夹(当前): ${ob.dependencies.outputFolder}`)
          lines.push(`模型目录: ${ob.dependencies.modelDirs.join(' | ') || '（无）'}`)
          lines.push(`超分引擎链: ${(ob.dependencies.engines || []).map((item) => `${item.label}(${item.priority})`).join(' → ') || '内置 Lanczos'}`)
          lines.push('')
          lines.push('=== AI 超分模型一览 ===')
          if (!ob.modelTable || ob.modelTable.length === 0) {
            lines.push('（本机未检测到模型文件；可下载后放入模型目录，或先用内置 Lanczos）')
          } else {
            lines.push('名称 | 可用性 | 大小(MB) | 路径')
            for (const item of ob.modelTable.filter((item) => item.kind !== 'engine')) {
              const usable = item.runnable === false ? '需适配器' : '可运行'
              lines.push(`${item.name} | ${usable} | ${item.sizeMB ?? '-'} | ${item.path}`)
            }
          }
          lines.push('')
          lines.push('=== 超分档位（完整） ===')
          lines.push('档位 | 状态 | 体积(MB) | 说明')
          for (const tier of ob.tiers || []) {
            const st = tier.status === 'installed'
              ? (tier.adapterReady === false ? '已安装·需适配器' : '已安装·可运行')
              : tier.status === 'ready' ? '可用'
                : tier.status === 'downloadable' ? '可下载'
                  : tier.status === 'manual' ? '需手动'
                    : tier.status === 'unsupported' ? '不可用' : String(tier.status)
            const note = [tier.note, tier.experimental ? '实验性' : null, tier.license ? `许可 ${tier.license}` : null].filter(Boolean).join('；')
            lines.push(`${tier.label} | ${st} | ${tier.sizeMB ?? '-'} | ${note || '-'}`)
          }
          lines.push('')
          if (ob.installs && ob.installs.length > 0) {
            lines.push('')
            lines.push('=== 安装任务进度 ===')
            for (const item of ob.installs) lines.push(`${item.tier}: ${item.state}${item.failedStep ? ` (失败于 ${item.failedStep})` : ''} · 日志 ${item.logFile}`)
            lines.push('进度可再次发送 hilumina 查看；下载目录/安装目录见上。')
          }
          lines.push('=== 推荐 ===')
          for (const role of ['photo', 'screenshot', 'anime']) {
            const rec = ob.recommendations[role]
            lines.push(`${role}: ${rec ? `${rec.name} (${rec.sizeMB}MB)` : '未检测到，回退 Lanczos'}`)
          }
          lines.push(`兜底: ${ob.recommendations.fallback.name}`)
          for (const action of ob.actions || []) lines.push(`已执行: ${action}`)
          if (ob.current) {
            lines.push('')
            lines.push(`已配置: 输出文件夹=${ob.current.outputFolder || '未设置'} · CUDA 兜底模型=${ob.current.cudaModel || ob.current.modelChoice || '未选择'}`)
            if (ob.current.engineChain && ob.current.engineChain.length > 0) {
              lines.push(`超分引擎链(当前): ${ob.current.engineChain.map((item) => `${item.label}(${item.priority})`).join(' → ')}${ob.current.supirActive ? ' · SUPIR 已启用（链上最高优先）' : ''}`)
            }
            if (ob.suggestion) lines.push(`提示: ${ob.suggestion.note}`)
          }
          lines.push('')
          if (!ob.questions || ob.questions.length === 0) {
            lines.push('配置已就绪，无需再设置 ✅')
          } else {
            lines.push('还需要确认:')
            for (const question of ob.questions) lines.push(`- ${question}`)
          }
        }

        if (value.superResolution) {
          const engine = value.superResolutionEngine || {}
          const engineText = (() => {
            const chain = Array.isArray(engine.chain) ? engine.chain : []
            if (chain.length > 0) {
              return ` · 质量优先链: ${chain.map((item) => `${item.label}(priority ${item.priority})`).join(' → ')} → Lanczos 兜底`
            }
            return engine.command
              ? ` · 引擎 ${engine.command}${engine.commandExists ? '' : '（⚠ 文件不存在，将回落 Lanczos）'}`
              : ' · 内置 Lanczos'
          })()
          lines.push(`超分预处理: ${value.superResolution.enabled
            ? `开启（mode=${value.superResolution.mode}, ×${value.superResolution.scale}, minLongEdge=${value.superResolution.minLongEdge}, fallback=${engine.fallback || 'lanczos'}）`
            : '关闭'}${engineText}`)
        }
        if (value.assessOptions) {
          lines.push(`自动评估阈值: minLongEdge=${value.assessOptions.minLongEdge}, blur<${value.assessOptions.blurThreshold}, maxBlurUpscaleEdge=${value.assessOptions.maxBlurUpscaleEdge}`)
        }
        if (value.caseBank) lines.push(`案例库文件: seed=${value.caseBank.seedFile}（${value.caseBank.seedCases} 条） user=${value.caseBank.userFile}（${value.caseBank.userCases} 条）`)
        if (value.sessionError) lines.push(`会话错误: ${value.sessionError}`)
        const recent = value.recentProjects || []
        if (recent.length > 0) {
          lines.push('最近工程:')
          for (const project of recent.slice(0, 5)) {
            lines.push(`  ${project.id} · v${project.versions} · ${project.recipe} · ${project.updatedAt}`)
          }
        } else {
          lines.push('最近工程: 暂无')
        }
        return textBlocks(lines)
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return handlers.state(args || {})
    },
  }
}

export function apply(ctx, config = {}) {
  const userConfig = loadUserConfig()
  // Runtime data (case bank / style pack / caches) defaults to the user config
  // `dataDir` (e.g. a second drive), otherwise to <home>/.lumina. An explicit
  // plugin config / env var still wins for each individual file.
  const dataDir = typeof userConfig.dataDir === 'string' && userConfig.dataDir.trim()
    ? path.resolve(userConfig.dataDir.trim())
    : path.join(os.homedir(), '.lumina')
  const pickPath = (configValue, envName, key, defaultName) => {
    if (typeof configValue === 'string' && configValue.trim()) return path.resolve(configValue.trim())
    const envValue = envFirst(envName)
    if (envValue) return path.resolve(envValue)
    if (typeof userConfig[key] === 'string' && userConfig[key].trim()) return path.resolve(userConfig[key].trim())
    return defaultName ? path.join(dataDir, defaultName) : undefined
  }
  const resolved = {
    projectRoot: typeof config.projectRoot === 'string' && config.projectRoot.trim()
      ? path.resolve(config.projectRoot.trim())
      : defaultProjectRoot(userConfig),
    // Documented precedence: plugin config > environment variable > user config.
    pythonPath: typeof config.pythonPath === 'string' && config.pythonPath.trim()
      ? config.pythonPath.trim()
      : (envFirst('LUMINA_PYTHON', 'DSH_PHOTOSHOP_PYTHON', 'DSH_VISION_PYTHON', 'DSH_PYTHON')
        || (typeof userConfig.pythonPath === 'string' && userConfig.pythonPath.trim() ? userConfig.pythonPath.trim() : undefined)),
    lutDir: typeof config.lutDir === 'string' && config.lutDir.trim()
      ? config.lutDir.trim()
      : (envFirst('LUMINA_LUT_DIR', 'DSH_LUMINA_LUT_DIR')
        || (typeof userConfig.lutDir === 'string' && userConfig.lutDir.trim() ? userConfig.lutDir.trim() : undefined)),
    casesFile: pickPath(config.casesFile, 'LUMINA_CASES_FILE', 'casesFile', 'auto-cases.json'),
    casesSeedFile: typeof config.casesSeedFile === 'string' && config.casesSeedFile.trim()
      ? config.casesSeedFile.trim()
      : (typeof userConfig.casesSeedFile === 'string' && userConfig.casesSeedFile.trim() ? userConfig.casesSeedFile.trim() : undefined),
    stylesFile: pickPath(config.stylesFile, 'LUMINA_STYLES_FILE', 'stylesFile', 'styles.json'),
    userConfigFile: userConfigPath(),
    superResolution: mergeSuperResolution(
      userConfig.superResolution && typeof userConfig.superResolution === 'object' ? userConfig.superResolution : {},
      config.superResolution && typeof config.superResolution === 'object' ? config.superResolution : {},
    ),
    assess: config.assess && typeof config.assess === 'object'
      ? config.assess
      : (userConfig.assess && typeof userConfig.assess === 'object' ? userConfig.assess : undefined),
    psWaitMs: Number(config.psWaitMs) > 0 ? Number(config.psWaitMs) : 90000,
    opTimeoutMs: Number(config.opTimeoutMs) > 0 ? Number(config.opTimeoutMs) : 240000,
    maxViewDimension: Number(config.maxViewDimension) > 0 ? Number(config.maxViewDimension) : 4096,
  }

  const python = resolvePython(resolved.pythonPath)
  const logger = (message) => {
    if (process.env.LUMINA_DEBUG || process.env.DSH_PHOTOSHOP_DEBUG) console.error('[lumina]', message)
  }
  const session = new PsSession({
    waitMs: resolved.psWaitMs,
    opTimeoutMs: resolved.opTimeoutMs,
    logger,
  })

  const dispose = () => session.dispose()
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => dispose())
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', dispose)
    }
  } catch {
    // Disposal is best effort; the helper exits when its stdin closes.
  }

  ctx.tools.register(buildGradeTool({ config: resolved, session, python }))
  ctx.tools.register(buildMeasureTool({ config: resolved, python }))
  ctx.tools.register(buildStateTool({ config: resolved, session, python }))

  // merged vision tools (formerly the separate dsh-vision / dsh-vision-text
  // plugins): vision_zoom / vision_probe / vision_textmap, same names as before.
  try {
    applyVisionTools(ctx, {
      maxViewDimension: resolved.maxViewDimension,
      pythonPath: resolved.pythonPath,
    })
  } catch (error) {
    logger(`vision tools failed to load: ${error && error.message ? error.message : error}`)
  }
  try {
    applyVisionTextTools(ctx, { pythonPath: resolved.pythonPath })
  } catch (error) {
    logger(`vision-text tools failed to load: ${error && error.message ? error.message : error}`)
  }
}
