# Changelog

## 1.1.6 — 2026-10-26

### Fixed
- Skin tone: learned-case params are neutralised before they are merged into the
  person layer (warm split channels clamped, blue restored, white point/gamma
  capped), so a case tuned on a warm autumn shot no longer turns skin yellow or
  clips it on a cold/white scene.
- `hdr-pop` now ships generic background colour zones (green foliage / warm reds)
  on top of the person/background split, so the default layered path is
  person + background + colour zones even when a case routes to hdr-pop.
- Case-hit runs keep their person zones even if the secondary skin heuristic
  disagrees with the Select Subject probe.

## 1.1.5 — 2026-10-26

### Fixed
- Person zones are no longer dropped when the skin-tone heuristic finds nothing:
  the Photoshop Select Subject probe is trusted first, so stylised/anime renders
  keep their subject/background split instead of silently falling back to colour
  zones (the flat-look bug).
- `hdr-*` recipes now always build their HDR base (tone-mapped texture/colour
  density), instead of only when measured highlight clipping exceeded 2.5%; HDR
  is a look, not just a highlight-repair pass.
- An accepted case now takes precedence over content routing: its params were
  tuned together with its recipe, so they are no longer mixed into a different
  recipe's zone mask.
- QA `midtones` / `mean` checks no longer fail images whose *source* is already
  above the target range (high-key mist scenes): stability is checked instead of
  forcing a global darkening.

## 1.1.4 — 2026-10-25

### Changed
- Added `repository` / `homepage` / `bugs` metadata pointing at the public GitHub repo
  `https://github.com/Rainnnnnnny/lumina-dsh`. No functional changes; version bump so the
  published npm package carries the repository links.

## 1.1.3 — 2026-10-25

### Changed
- `hilumina` self-check always asks two explicit confirmations: the output folder
  (current value, change allowed) and the CUDA fallback model — with the engine
  chain and SUPIR's top priority spelled out. Previously these questions were only
  emitted when a value was missing, which made a configured profile look incomplete.
- The self-check now renders the **complete super-resolution tier ladder**
  (SUPIR / HAT / UltraSharp / Real-ESRGAN / waifu2x / Lanczos) with status, size,
  adapter and license notes, plus the current engine chain, instead of only the
  local model-file table.
- Removed the stale "strongerModels" hint block (state now comes from the catalog).

## 1.1.2 — 2026-10-25

### Fixed
- The published 1.1.0 tarball was missing `assets/model-catalog.json`, so a package
  installed from npm reported "model catalog tiers missing" (23/26 smoke). The model
  catalog is now shipped in `files`; the seed case bank stays out of the package
  (`assets/auto-cases.json` is intentionally not allowlisted).

Built with DeepSeek Harness — human + AI pair programming (DeepSeek V4.1 flash 1017).

## 1.1.0 — 2026-10-25

### Highlights
- **SUPIR (SDXL diffusion) quality-first engine**: complete install plan (weights + source
  archive + pip env), post-install compatibility patcher (`assets/supir_compat.py`),
  one-click wiring into the engine chain at priority 110, automatic fallback to
  Real-ESRGAN / waifu2x / Lanczos when it fails. Validated end-to-end on an RTX 5080.
- **Multi-zone grading** (`region-zones`): per-zone AI person / colour-range / channel
  masks with independently tuned tone/split/clarity/USM. Person zones always run last.
- **Pixel-level person isolation**: `lib/personmask.js` exports a native-resolution
  person alpha from Photoshop Select Subject; colour zone masks are multiplied by
  `1 - alpha` (`regionmask.py --exclude`) so skin, white clothes and hair are only
  touched by the person zone.
- **Colour/region masks**: `mask.mode = "color" | "channel"` on top of the existing
  person / subject / horizon / depth / polygon / alpha modes; `region-sky` recipe added.
- **Content-aware routing** in auto mode: character screenshots -> `region-zones`,
  landscape photos keep `hdr-photo` (region-sky is opt-in), explicit `params.scene`
  and `params.person` overrides win over heuristics.
- **Native 1:1 vision crops**: `vision_zoom native:true` returns unscaled native pixels
  for hair/edge inspection (subject to the model's per-image budget).
- **Guards**: high-key scenes get relative exposure tolerance in QA checks; extreme
  long-edge / extreme-aspect images are downscaled before grading (cap configurable
  with `maxInputLongEdge`, default 12000).

### Fixed
- Recipe objects are cloned before mask materialisation (no cross-run cache pollution).
- Empty/implausible zone selections are skipped instead of failing the whole run.
- `upscale.py` can now downscale for long-edge protection (previously clamped to >=1x).
- Personality: hdr-pop's polygon mask (no polygon data) replaced by content-aware auto.

### Compatibility
- Windows only (Photoshop COM). Photoshop 2025 tested; 2020-2024 expected.
- Python 3.12, torch 2.9.1+cu130, xformers 0.0.33 for the SUPIR tier.

## 1.0.0 — 2026-10-22

- Initial open-source release: 17 recipes, 7 styles, layered HDR, optional
  super-resolution chain, universal auto assessment, case bank, QA metrics,
  high-resolution vision tools and the `hilumina` onboarding self-check.
