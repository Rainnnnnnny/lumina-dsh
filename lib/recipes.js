/**
 * Recipe + style definitions for lumina-dsh.
 *
 * Built-in recipes/styles live in assets/recipes.json and are re-read on every
 * call (mtime cached), so tuning parameters does NOT require restarting DSH.
 * The JSX pipeline body likewise lives in assets/pipeline.jsx.
 *
 * Styles are replaceable/hot-loadable: an optional user style pack
 * (`stylesFile`, default <home>/.lumina/styles.json) is merged over the built-in
 * styles by name on every read. A user style can be:
 *   - a pure LUT look:  { "lut": "my.cube" | "D:/LUTs/my.cube", "strength": 35 }
 *   - a LUT + parameter preset:  { "lut": ..., "params": { "tone": { "gamma": 0.9 } } }
 *   - a parameter-only look:  { "params": { ... } }
 * `params` is deep-merged over the recipe's steps, and `lut` is either an
 * absolute path, a name resolved against the plugin `lutDir` / Photoshop
 * Presets/3DLUTs, or a style-level `lutDir`. Adobe LUT files are never bundled.
 *
 * Pipeline operation set is limited to APIs verified to actually mutate pixels
 * on Photoshop 2025. PS 2025 silently ignores adjustCurves, Hue/Saturation and
 * Invert: never add them without verifying real pixel changes first.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RECIPES_PATH = path.join(HERE, '..', 'assets', 'recipes.json')

export const DEFAULT_RECIPE = 'clean-premium'

const state = {
  stylesFile: null,
}

/**
 * Point the style loader at the user style pack. Called once per tool
 * construction (and by tests); style edits themselves stay hot-reloaded.
 */
export function configureRecipes({ stylesFile } = {}) {
  if (typeof stylesFile === 'string' && stylesFile.trim()) {
    state.stylesFile = path.resolve(stylesFile.trim())
  } else if (stylesFile === null) {
    state.stylesFile = null
  }
}

export function stylesFilePath() {
  return state.stylesFile
}

function readUserStyles() {
  if (!state.stylesFile) return {}
  try {
    // Tolerate a UTF-8 BOM from Windows editors.
    const text = fs.readFileSync(state.stylesFile, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    const styles = parsed && typeof parsed === 'object' ? (parsed.styles || parsed) : {}
    const out = {}
    for (const [name, style] of Object.entries(styles)) {
      if (!style || typeof style !== 'object' || Array.isArray(style)) continue
      out[name] = {
        ...style,
        name,
        label: typeof style.label === 'string' && style.label.trim() ? style.label : name,
        description: typeof style.description === 'string' ? style.description : '',
        source: 'user',
      }
    }
    return out
  } catch {
    return {}
  }
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

let cached = { stamp: '', data: null }

function loadAll() {
  const stamp = `${fileStamp(RECIPES_PATH)}|${state.stylesFile ? fileStamp(state.stylesFile) : 'none'}`
  if (cached.data && cached.stamp === stamp) return cached.data
  const parsed = JSON.parse(fs.readFileSync(RECIPES_PATH, 'utf8'))
  const recipes = {}
  for (const [name, recipe] of Object.entries(parsed.recipes || {})) {
    recipes[name] = { name, ...recipe }
  }
  const styles = {}
  for (const [name, style] of Object.entries(parsed.styles || {})) {
    styles[name] = { name, ...style, source: 'builtin' }
  }
  for (const [name, style] of Object.entries(readUserStyles())) {
    styles[name] = style // user pack overrides a built-in style with the same name
  }
  cached = {
    stamp,
    data: {
      defaultRecipe: parsed.defaultRecipe || Object.keys(recipes)[0],
      recipes,
      styles,
    },
  }
  return cached.data
}

export function listRecipes() {
  return Object.values(loadAll().recipes).map((recipe) => ({
    name: recipe.name,
    label: recipe.label,
    description: recipe.description,
  }))
}

export function listStyles() {
  return Object.values(loadAll().styles || {}).map((style) => ({
    name: style.name,
    label: style.label,
    description: style.description,
    lut: style.lut || null,
    lutDir: style.lutDir || null,
    strength: style.strength || 0,
    hasParams: Boolean(style.params && typeof style.params === 'object'),
    source: style.source || 'builtin',
  }))
}

export function getStyle(name) {
  const all = loadAll()
  const style = (all.styles || {})[name]
  if (!style) {
    throw new Error(`未知风格: ${name}（可用: ${Object.keys(all.styles || {}).join(', ')}；可用 stylesFile 热加载自定义风格）`)
  }
  return style
}

export function getRecipe(name) {
  const all = loadAll()
  const key = name || all.defaultRecipe
  const recipe = all.recipes[key]
  if (!recipe) {
    throw new Error(`未知 recipe: ${key}（可用: ${Object.keys(all.recipes).join(', ')}）`)
  }
  return recipe
}

export function defaultRecipeName() {
  return loadAll().defaultRecipe
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}
