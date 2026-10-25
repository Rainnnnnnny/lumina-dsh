import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

export function loadModelCatalog(assetsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(assetsDir, 'model-catalog.json'), 'utf8'))
  } catch {
    return { tiers: [] }
  }
}

export function probeHardware({ dataDir, venvPython } = {}) {
  const hardware = { gpu: null, vulkan: false, torch: false, diskFreeGB: null }
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 8000 }).trim()
    const first = out.split(/\r?\n/)[0].split(',').map((item) => item.trim())
    if (first.length >= 2) {
      hardware.gpu = { name: first[0], vramMB: Number(first[1]) || 0 }
      hardware.vulkan = true
    }
  } catch { /* no NVIDIA GPU/tool */ }
  if (dataDir) {
    try {
      const stat = fs.statfsSync(dataDir)
      hardware.diskFreeGB = Math.round((stat.bavail * stat.bsize) / 1073741824)
    } catch { hardware.diskFreeGB = null }
  }
  if (venvPython && fs.existsSync(venvPython)) {
    try {
      execFileSync(venvPython, ['-c', 'import torch; print(1 if torch.cuda.is_available() else 0)'], { encoding: 'utf8', timeout: 30000 })
      hardware.torch = true
    } catch { hardware.torch = false }
  }
  return hardware
}

function installedFiles(entry, modelsDir) {
  if (!modelsDir || !Array.isArray(entry.downloads) || entry.downloads.length === 0) return []
  return entry.downloads.filter((item) => {
    try { return fs.statSync(path.join(modelsDir, item.fileName)).size > 1000 } catch { return false }
  })
}

export function evaluateTiers(catalog, hardware, { modelsDir, engines = [] } = {}) {
  return (catalog.tiers || []).map((entry) => {
    const installed = installedFiles(entry, modelsDir)
    const missing = (entry.downloads || []).filter((item) => !installed.some((hit) => hit.fileName === item.fileName))
    const problems = []
    const req = entry.requires || {}
    if (req.gpu && !hardware.gpu) problems.push('需要 NVIDIA GPU')
    if (req.minVRAMGB && hardware.gpu && hardware.gpu.vramMB < req.minVRAMGB * 1024) problems.push(`显存不足（需要 ${req.minVRAMGB}GB，本机 ${Math.round(hardware.gpu.vramMB / 1024)}GB）`)
    if (req.torch && !hardware.torch) problems.push('缺少 CUDA PyTorch 运行环境')
    if (req.vulkan && !hardware.vulkan) problems.push('需要 Vulkan/GPU')
    if (req.diskGB && Number.isFinite(hardware.diskFreeGB) && hardware.diskFreeGB < req.diskGB) problems.push(`磁盘空间不足（需要 ${req.diskGB}GB，剩余 ${hardware.diskFreeGB}GB）`)
    let status = 'downloadable'
    if (entry.adapter === 'builtin') status = 'ready'
    else if (installed.length > 0 && missing.length === 0) status = 'installed'
    else if (problems.length > 0) status = 'unsupported'
    else if (!entry.downloads || entry.downloads.length === 0) status = 'manual'
    return {
      id: entry.id, label: entry.label, quality: entry.quality, tier: entry.tier, adapter: entry.adapter,
      sizeMB: entry.sizeMB, license: entry.license, status, problems,
      installedFiles: installed.map((item) => item.fileName),
      missingFiles: missing.map((item) => item.fileName),
      needsDownload: missing.length > 0,
      adapterReady: entry.adapterReady !== false,
      experimental: entry.experimental === true,
      license: entry.license || null,
      runnableNow: status === 'installed' && entry.adapter === 'native',
    }
  })
}

export function startDownloads(entry, modelsDir) {
  fs.mkdirSync(modelsDir, { recursive: true })
  const started = []
  for (const item of entry.downloads || []) {
    const target = path.join(modelsDir, item.fileName)
    if (fs.existsSync(target)) { started.push({ fileName: item.fileName, status: 'already' }); continue }
    const child = spawnDetached('curl.exe', ['-L', '--retry', '50', '--retry-all-errors', '-C', '-', '-o', target, item.url])
    started.push({ fileName: item.fileName, status: child ? 'started' : 'failed', sizeMB: item.sizeMB })
  }
  return started
}

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return child
  } catch {
    return null
  }
}

export function defaultInstallPaths({ dataDir, userConfig = {}, overrides = {} } = {}) {
  const paths = (userConfig && userConfig.paths) || {}
  const installDir = overrides.installDir || paths.installDir || (dataDir ? path.join(dataDir, 'ai') : null)
  const downloadDir = overrides.downloadDir || paths.downloadDir || (dataDir ? path.join(dataDir, 'downloads') : null)
  const venvDir = overrides.venvDir || paths.venvDir || (installDir ? path.join(installDir, 'venv') : null)
  const modelsDir = overrides.modelsDir || paths.modelsDir || (installDir ? path.join(installDir, 'models') : null)
  return { installDir, downloadDir, venvDir, modelsDir }
}

export function buildInstallPlan(entry, paths = {}) {
  const steps = []
  const install = entry.install || {}
  const weightsDir = install.weightsSubdir ? path.join(paths.installDir || '', install.weightsSubdir) : paths.installDir
  if (install.venv) steps.push({ type: 'venv', target: paths.venvDir })
  if (install.torch) steps.push({ type: 'pip', note: 'torch cu130 (download.pytorch.org)', target: paths.venvDir })
  if (install.torchvision) steps.push({ type: 'pip-torchvision', target: paths.venvDir })
  for (const pkg of install.pip || []) steps.push({ type: 'pip', package: pkg, target: paths.venvDir })
  if (entry.codeArchive) {
    steps.push({ type: 'fetch-code', urls: entry.codeArchive.urls || [], destName: entry.codeArchive.destName || 'code',
                 target: path.join(paths.installDir || '', entry.codeArchive.destName || 'code') })
  }
  for (const item of entry.downloads || []) {
    if (item.optional) continue
    steps.push({
      type: 'download',
      urls: item.urls || [item.url],
      fileName: item.fileName,
      target: path.join(weightsDir || paths.installDir || '', item.fileName),
      sizeMB: item.sizeMB,
    })
  }
  for (const item of entry.downloads || []) {
    if (!item.optional) continue
    steps.push({ type: 'download-optional', urls: item.urls || [item.url], fileName: item.fileName,
                 target: path.join(weightsDir || paths.installDir || '', item.fileName), sizeMB: item.sizeMB })
  }
  if (install.extract) steps.push({ type: 'extract', from: path.join(weightsDir || paths.installDir || '', (entry.downloads[0] || {}).fileName || ''), to: weightsDir })
  if (entry.id === 'supir') {
    steps.push({ type: 'py-compat', script: path.join(paths.installDir || '', 'supir_compat.py'),
                 codeDir: path.join(paths.installDir || '', 'supir-code'), weightsDir: path.join(paths.installDir || '', 'supir') })
  }
  steps.push({ type: 'finalize', note: 'write install-status json + engine config hint' })
  return {
    tier: entry.id, label: entry.label, adapterReady: entry.adapterReady !== false,
    downloadDir: paths.downloadDir, installDir: paths.installDir, venvDir: paths.venvDir,
    modelsDir: weightsDir, steps, totalSizeMB: entry.sizeMB,
  }
}

export function buildInstallerScript(plan, { python } = {}) {
  const statusFile = path.join(plan.installDir || '.', `install-status-${plan.tier}.json`)
  const logFile = path.join(plan.installDir || '.', `install-${plan.tier}.log`)
  const lines = [
    '$ErrorActionPreference = "Continue"',
    `$log = '${logFile}'`,
    'function Log($m) { $m *>> $log }',
    `Log "install ${plan.tier} started $(Get-Date -Format o)"`,
    `New-Item -ItemType Directory -Force '${plan.installDir || '.'}' | Out-Null`,
    `New-Item -ItemType Directory -Force '${plan.modelsDir || plan.installDir || '.'}' | Out-Null`,
    `'{"tier":"${plan.tier}","state":"running"}' | Out-File -Encoding utf8 '${statusFile}'`,
  ]
  for (const step of plan.steps || []) {
    if (step.type === 'venv') lines.push(`if (-not (Test-Path '${step.target}\\Scripts\\python.exe')) { & '${python || 'python'}' -m venv '${step.target}' *>> $log }`)
    if (step.type === 'pip') lines.push(`& '${plan.venvDir}\\Scripts\\python.exe' -m pip install --disable-pip-version-check --no-cache-dir ${step.package ? `-i https://pypi.tuna.tsinghua.edu.cn/simple ${step.package}` : '--index-url https://download.pytorch.org/whl/cu130 torch'} *>> $log`)
    if (step.type === 'pip-torchvision') lines.push(`& '${plan.venvDir}\\Scripts\\python.exe' -m pip install --disable-pip-version-check --no-cache-dir --index-url https://download.pytorch.org/whl/cu130 torchvision==0.24.1 *>> $log`)
    if (step.type === 'py-compat') lines.push(`& '${plan.venvDir}\\Scripts\\python.exe' '${step.script}' --code-dir '${step.codeDir}' --weights-dir '${step.weightsDir}' *>> $log`)
    if (step.type === 'download') {
      const minBytes = Math.max(100000, Math.round((step.sizeMB || 64) * 1048576 * 0.92))
      lines.push(`$ok = $false`)
      lines.push(`foreach ($u in @(${step.urls.map((u) => `'${u}'`).join(', ')})) {`)
      lines.push(`  Log "downloading ${step.fileName} from $u"`)
      lines.push(`  & curl.exe -L --fail --retry 20 --retry-all-errors -C - -A "Mozilla/5.0" -o '${step.target}' "$u" *>> $log`)
      lines.push(`  if ((Test-Path '${step.target}') -and ((Get-Item '${step.target}').Length -ge ${minBytes})) { $ok = $true; break }`)
      lines.push(`  Remove-Item '${step.target}' -Force -ErrorAction SilentlyContinue`)
      lines.push(`}`)
      lines.push(`if (-not $ok) { '{"tier":"${plan.tier}","state":"failed","step":"${step.fileName}"}' | Out-File -Encoding utf8 '${statusFile}'; exit 1 }`)
    }
    if (step.type === 'extract') lines.push(`Expand-Archive -Path '${step.from}' -DestinationPath '${step.to}' -Force *>> $log`)
    if (step.type === 'fetch-code') {
      lines.push(`$codeZip = '${plan.installDir}\\supir-code.tar.gz'`)
      lines.push(`foreach ($u in @(${step.urls.map((u) => `'${u}'`).join(', ')})) { & curl.exe -L --fail --retry 20 --retry-all-errors -o $codeZip "$u" *>> $log; if ((Test-Path $codeZip) -and ((Get-Item $codeZip).Length -gt 100000)) { break } }`)
      lines.push(`if (Test-Path '${step.target}') { Remove-Item '${step.target}' -Recurse -Force -ErrorAction SilentlyContinue }`)
      lines.push(`New-Item -ItemType Directory -Force '${step.target}' | Out-Null`)
      lines.push(`& tar.exe -xzf $codeZip -C '${step.target}' --strip-components=1 *>> $log`)
    }
    if (step.type === 'download-optional') {
      lines.push(`if ($env:LUMINA_INSTALL_OPTIONAL -eq '1') { & curl.exe -L --fail --retry 20 -C - -o '${step.target}' '${(step.urls || [])[0] || ''}' *>> $log } else { Log "skipping optional ${step.fileName}" }`)
    }
  }
  lines.push(`'{"tier":"${plan.tier}","state":"done"}' | Out-File -Encoding utf8 '${statusFile}'`)
  lines.push(`Log "install ${plan.tier} done $(Get-Date -Format o)"`)
  return '\uFEFF' + lines.join('\r\n')
}

export function readInstallStatus(installPaths = {}) {
  const dir = installPaths.installDir
  if (!dir) return []
  const results = []
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(/^install-status-(.+)\.json$/)
      if (!match) continue
      let state = null
      try { state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '')) } catch { state = null }
      let logTail = null
      const logName = `install-${match[1]}.log`
      try { const text = fs.readFileSync(path.join(dir, logName), 'utf8'); logTail = text.trim().split(/\r?\n/).slice(-2).join(' | ') } catch { /* no log yet */ }
      results.push({ tier: match[1], state: state && state.state, failedStep: state && state.step, logTail, logFile: path.join(dir, logName) })
    }
  } catch { /* dir missing */ }
  return results
}

export function startInstall(plan, { python, logFile } = {}) {
  const dir = plan.installDir
  fs.mkdirSync(dir, { recursive: true })
  const scriptPath = path.join(dir, `install-${plan.tier}.ps1`)
  fs.writeFileSync(scriptPath, buildInstallerScript(plan, { python }), 'utf8')
  const log = logFile || path.join(dir, `install-${plan.tier}.log`)
  const child = spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath])
  return { scriptPath, logFile: log, started: Boolean(child) }
}
