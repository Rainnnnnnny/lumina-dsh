/**
 * Per-task project folders under the configured root (default: <home>/Lumina).
 *
 * Layout:
 *   <root>/<stamp>-<slug>/
 *     project.json          task metadata + version history
 *     log.jsonl             append-only run log
 *     README.txt            short human note about the folder
 *     input/                untouched original(s)
 *     work/                 generated .jsx and .psd working files
 *     out/                  final renders
 *     metrics/              before/after metrics JSON
 *     compare-vN.png        before/after comparison sheets
 */
import fs from 'node:fs'
import path from 'node:path'

function pad2(value) {
  return String(value).padStart(2, '0')
}

export function timestamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-`
    + `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

export function slugify(input, fallback = 'task') {
  const base = String(input || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  const slug = base.slice(0, 40).replace(/^-|-$/g, '')
  return slug || fallback
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

export function readProject(projectDir) {
  const file = path.join(projectDir, 'project.json')
  if (!fs.existsSync(file)) throw new Error(`不是有效的工程目录（缺少 project.json）: ${projectDir}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function appendLog(projectDir, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
  fs.appendFileSync(path.join(projectDir, 'log.jsonl'), line, 'utf8')
}

export function createProject({ root, sourcePath, title, recipeName, notes }) {
  fs.mkdirSync(root, { recursive: true })
  const stamp = timestamp()
  const slug = slugify(title || path.basename(sourcePath))
  let projectDir = path.join(root, `${stamp}-${slug}`)
  let suffix = 2
  while (fs.existsSync(projectDir)) {
    projectDir = path.join(root, `${stamp}-${slug}-${suffix}`)
    suffix += 1
  }
  for (const sub of ['input', 'work', 'out', 'metrics']) {
    fs.mkdirSync(path.join(projectDir, sub), { recursive: true })
  }

  const ext = path.extname(sourcePath) || '.png'
  const originalPath = path.join(projectDir, 'input', `original${ext}`)
  fs.copyFileSync(sourcePath, originalPath)

  const project = {
    id: path.basename(projectDir),
    title: title || path.basename(sourcePath),
    recipe: recipeName,
    notes: notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { path: path.relative(projectDir, originalPath), origin: sourcePath },
    versions: [],
  }
  writeJson(path.join(projectDir, 'project.json'), project)
  fs.writeFileSync(path.join(projectDir, 'README.txt'), buildReadme(project), 'utf8')
  appendLog(projectDir, { event: 'project-created', recipe: recipeName, source: sourcePath })
  return { projectDir, project, originalPath }
}

export function resolveProjectDir({ root, project }) {
  if (!project) return null
  if (path.isAbsolute(project) && fs.existsSync(path.join(project, 'project.json'))) return project
  const candidate = path.join(root, project)
  if (fs.existsSync(path.join(candidate, 'project.json'))) return candidate
  throw new Error(`找不到工程目录: ${project}（根目录 ${root}）`)
}

export function recordVersion(projectDir, record) {
  const project = readProject(projectDir)
  project.versions.push(record)
  project.updatedAt = new Date().toISOString()
  project.recipe = record.recipe || project.recipe
  writeJson(path.join(projectDir, 'project.json'), project)
  return project
}

export function listProjects(root, limit = 10) {
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, 'project.json')))
  } catch {
    return []
  }
  const projects = entries.map((dir) => {
    try {
      const project = readProject(dir)
      const last = project.versions[project.versions.length - 1]
      return {
        id: project.id,
        title: project.title,
        recipe: project.recipe,
        versions: project.versions.length,
        updatedAt: project.updatedAt,
        lastOutput: last ? path.join(dir, last.output) : null,
      }
    } catch {
      return null
    }
  }).filter(Boolean)
  projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return projects.slice(0, limit)
}

function buildReadme(project) {
  return [
    `工程: ${project.title}`,
    `创建: ${project.createdAt}`,
    '',
    '目录说明:',
    '  input/    原始图片（只读副本）',
    '  work/     每次处理生成的 grade-vN.jsx 与 PSD 工作文件',
    '  out/      最终渲染图',
    '  metrics/  处理前后指标 JSON',
    '  compare-vN.png  前后对比图',
    '  project.json    任务参数与版本历史',
    '  log.jsonl       运行日志',
    '',
    '本目录由 lumina-dsh 插件自动生成（generated by lumina-dsh）；删除前请确认不再需要。',
  ].join('\n')
}
