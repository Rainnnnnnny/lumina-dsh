// Pipeline body executed inside Photoshop, appended after `var CFG = {...};`.
// Kept as a data file (read at call time) so tuning needs no DSH restart.
// Only operations verified to actually change pixels on PS 2025 are used.
//
// Layered mode (CFG.steps.layers.mask.mode != "none"):
//   base layer   = background (direct adjustments only: tone/split/usm/blur)
//   subject layer= duplicate with its own adjustments, cut out by the mask
//   -> merge visible -> global finishing (vignette/clarity/finalUsm/grain)

// ---- optional AI-subject probe (scene type detection for auto mode) ----
// Opens CFG.input, runs Select Subject, reports the selection bbox fraction
// through the error channel (no output file needed), then aborts.
if (CFG.steps && CFG.steps.__subjectProbe) {
    var __spMsg = 'SUBJECT_PROBE|error|no-doc';
    var __spDoc = null;
    try {
        __spDoc = app.open(new File(CFG.input));
        app.activeDocument = __spDoc;
        var __spOk = false;
        try { __spOk = selectAI({ mode: 'subject', feather: 2 }); } catch (eSpAi) { __spOk = false; }
        if (__spOk) {
            var __spW = __spDoc.width.as('px');
            var __spH = __spDoc.height.as('px');
            var __spFrac = __maskBBox ? String(__maskBBox) : '';
            __spMsg = 'SUBJECT_PROBE|subject-ai|' + __spFrac + '|' + __spW + 'x' + __spH;
        } else {
            __spMsg = 'SUBJECT_PROBE|none||' + __spDoc.width.as('px') + 'x' + __spDoc.height.as('px');
        }
    } catch (eSp) {
        __spMsg = 'SUBJECT_PROBE|error|' + (eSp.message || eSp);
    }
    try { if (__spDoc) __spDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (eSpC) {}
    throw new Error(__spMsg);
}

function A() { return app.activeDocument; }
function deselect() { try { A().selection.deselect(); } catch (e) {} }
function ellipsePts(cx, cy, rx, ry) {
    var pts = [], n = 64;
    for (var i = 0; i < n; i++) {
        var t = (i / n) * Math.PI * 2;
        pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    return pts;
}
function selEllipse(cx, cy, rx, ry, feather) {
    var d = A();
    d.selection.deselect();
    d.selection.select(ellipsePts(cx, cy, rx, ry));
    if (feather > 0) d.selection.feather(feather);
}
function mergeVisible() { try { A().mergeVisibleLayers(); } catch (e) {} }
function mergeDown() { try { A().activeLayer.merge(); } catch (e) {} }
function addFill(hex, blend, opacity) {
    var d = A();
    var l = d.artLayers.add();
    d.activeLayer = l;
    var c = new SolidColor();
    c.rgb.hexValue = hex;
    d.selection.selectAll();
    d.selection.fill(c);
    d.selection.deselect();
    if (blend) l.blendMode = blend;
    if (opacity !== undefined) l.opacity = opacity;
}
function bloom(r, o) {
    var d = A();
    var dup = d.activeLayer.duplicate();
    d.activeLayer = dup;
    dup.applyGaussianBlur(r);
    dup.blendMode = BlendMode.SCREEN;
    dup.opacity = o;
    mergeDown();
}
function clarity(r, o) {
    var d = A();
    var dup = d.activeLayer.duplicate();
    d.activeLayer = dup;
    dup.applyHighPass(r);
    dup.blendMode = BlendMode.OVERLAY;
    dup.opacity = o;
    mergeDown();
}
function vignette(o) {
    var d = A();
    var v = d.artLayers.add();
    d.activeLayer = v;
    var b = new SolidColor();
    b.rgb.hexValue = '000000';
    d.selection.selectAll();
    d.selection.fill(b);
    d.selection.deselect();
    var w = d.width.as('px'), h = d.height.as('px');
    d.selection.select(ellipsePts(w / 2, h * 0.46, w * 0.78, h * 0.92));
    d.selection.feather(320);
    d.selection.clear();
    d.selection.deselect();
    v.opacity = o;
    mergeVisible();
}
function tone(ib, iw, g, ob, ow) { A().activeLayer.adjustLevels(ib, iw, g, ob, ow); }
function split(sh, mid, hi) { A().activeLayer.adjustColorBalance(sh, mid, hi, true); }
function usm(a, r, t) { A().activeLayer.applyUnSharpMask(a, r, t); }
function blur(r) { A().activeLayer.applyGaussianBlur(r); }

// Apply a 3D LUT as a Color Lookup adjustment layer (PS built-in: .look/.cube/.3dl).
// Used by the "style library" (film emulation / teal-orange / etc.).

function desat(pct) {
    addFill('808080', BlendMode.SATURATION, pct);
    mergeDown();
}

// Per-layer group; helpers here only affect the active layer (mergeDown).
function applyGroup(G) {
    if (!G) return;
    if (G.bloom && G.bloom.opacity > 0) bloom(G.bloom.radius, G.bloom.opacity);
    if (G.tone) tone(G.tone.ib, G.tone.iw, G.tone.gamma, G.tone.ob, G.tone.ow);
    if (G.split) split(G.split.sh, G.split.mid, G.split.hi);
    if (G.desat > 0) desat(G.desat);
    if (G.clarity && G.clarity.opacity > 0) clarity(G.clarity.radius, G.clarity.opacity);
    if (G.usm && G.usm.amount > 0) usm(G.usm.amount, G.usm.radius || 1.0, 0);
    if (G.blur > 0) blur(G.blur);
    // film grain on the subject layer only: keeps the background (sky/mist)
    // clean while the character keeps a textured look
    if (G.grain > 0) {
        try { A().activeLayer.applyAddNoise(G.grain, NoiseDistribution.GAUSSIAN, true); } catch (e) {}
    }
}

// True when a group has any operation that must run after a cut (halo-prone ops).
function groupHasSharp(G) {
    if (!G) return false;
    return (G.bloom && G.bloom.opacity > 0)
        || (G.clarity && G.clarity.opacity > 0)
        || (G.usm && G.usm.amount > 0)
        || (G.grain > 0);
}

// --- mask strategies -------------------------------------------------------
var __maskInfo = 'none';
var __maskBBox = '';

function bboxFrac() {
    try {
        var d = A();
        var b = d.selection.bounds;
        if (!b) return -1;
        return ((b[2].as('px') - b[0].as('px')) * (b[3].as('px') - b[1].as('px'))) /
               (d.width.as('px') * d.height.as('px'));
    } catch (e) { return -1; }
}

function selectAI(maskCfg) {
    executeAction(stringIDToTypeID('autoCutout'), undefined, DialogModes.NO);
    var d = A();
    var b = null;
    try { b = d.selection.bounds; } catch (e) { b = null; }
    if (!b) return false;
    var f = bboxFrac();
    __maskBBox = f >= 0 ? f.toFixed(3) : '';
    if (maskCfg.expand > 0) { try { d.selection.expand(maskCfg.expand); } catch (e) {} }
    if (maskCfg.feather > 0) d.selection.feather(maskCfg.feather);
    return true;
}

function selectHorizon(maskCfg) {
    var d = A();
    var w = d.width.as('px'), h = d.height.as('px');
    var y = Math.round(h * (maskCfg.horizon || 0.6));
    d.selection.deselect();
    d.selection.select([[0, y], [w, y], [w, h], [0, h]]);
    var feather = maskCfg.feather > 0 ? maskCfg.feather : 80;
    d.selection.feather(feather);
    __maskInfo = 'horizon@' + (maskCfg.horizon || 0.6);
    return true;
}

// Horizontal band selection (gradient depth layering, "gradient version"):
// rect y0..y1 across the canvas with a wide feather -> soft vertical gradient.
function selectBand(y0, y1, feather) {
    var d = A();
    var w = d.width.as('px');
    d.selection.deselect();
    d.selection.select([[0, y0], [w, y0], [w, y1], [0, y1]]);
    if (feather > 0) d.selection.feather(feather);
    return true;
}

// Save a mask/inspection PNG while hiding every layer except `onlyLayer`.
function saveLayerOnly(d, onlyLayer, file) {
    var vis = [], i;
    for (i = 0; i < d.layers.length; i++) {
        vis.push(d.layers[i].visible);
        d.layers[i].visible = (d.layers[i].id === onlyLayer.id);
    }
    try { savePng(d, file); } catch (e) {}
    for (i = 0; i < d.layers.length; i++) d.layers[i].visible = vis[i];
}

// Union of many per-tile polygons, each under the ~1000-point PS limit.
// {"polygonListFile":"C:/.../tiles.json"} holds [[[x,y],...], [[x,y],...], ...]
function selectPolygonList(maskCfg) {
    var d = A();
    var w = d.width.as('px'), h = d.height.as('px');
    var list = [];
    try {
        var f = new File(maskCfg.polygonListFile);
        f.encoding = 'UTF-8';
        if (f.open('r')) {
            var txt = f.read();
            f.close();
            list = eval('(' + txt + ')');
        }
    } catch (e) { list = []; }
    if (!list || !list.length) return false;
    var totalPts = 0, polyCount = 0, first = true;
    for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        var op = 'add';
        var poly = entry;
        if (entry && !(entry[0] instanceof Array) && entry.points) {
            poly = entry.points;
            op = entry.op || 'add';
        }
        if (!poly || poly.length < 3) continue;
        var normalized = true;
        for (var k = 0; k < poly.length; k++) {
            if (poly[k][0] > 1.5 || poly[k][1] > 1.5) { normalized = false; break; }
        }
        var pts = [];
        for (var j = 0; j < poly.length; j++) {
            pts.push(normalized ? [poly[j][0] * w, poly[j][1] * h] : [poly[j][0], poly[j][1]]);
        }
        if (pts.length > 1000) {
            var keep = Math.ceil(pts.length / 1000);
            var sub = [];
            for (var m = 0; m < pts.length; m += keep) sub.push(pts[m]);
            pts = sub;
        }
        var selType;
        if (op === 'sub') {
            if (first) continue;
            selType = SelectionType.DIMINISH;
        } else {
            selType = first ? SelectionType.REPLACE : SelectionType.EXTEND;
        }
        d.selection.select(pts, selType, 0, true);
        first = false;
        totalPts += pts.length;
        polyCount++;
    }
    if (!polyCount) return false;
    var fb = bboxFrac();
    __maskBBox = fb >= 0 ? fb.toFixed(3) : '';
    // shrink before feather: avoids a bright rim where the subject layer's
    // sharpening/bloom would otherwise bleed over the true silhouette
    if (maskCfg.contract > 0) {
        try { d.selection.contract(maskCfg.contract); } catch (e) {}
    }
    d.selection.feather(maskCfg.feather > 0 ? maskCfg.feather : 2);
    __maskInfo = 'tiles-' + polyCount + 'poly-' + totalPts + 'pt-union';
    return true;
}

function selectPolygon(maskCfg) {
    var d = A();
    var raw = maskCfg.polygon || [];
    // dense contours can be passed by file: {"polygonFile":"C:/.../polygon.json"}
    if ((!raw || raw.length < 3) && maskCfg.polygonFile) {
        try {
            var f = new File(maskCfg.polygonFile);
            f.encoding = 'UTF-8';
            if (f.open('r')) {
                var txt = f.read();
                f.close();
                raw = eval('(' + txt + ')');
            }
        } catch (e) { raw = []; }
    }
    if (!raw || raw.length < 3) return false;
    var w = d.width.as('px'), h = d.height.as('px');
    // points may be absolute pixels (any coord > 1.5) or normalized 0..1
    var normalized = true;
    for (var i = 0; i < raw.length; i++) {
        if (raw[i][0] > 1.5 || raw[i][1] > 1.5) { normalized = false; break; }
    }
    var pts = [];
    for (var j = 0; j < raw.length; j++) {
        pts.push(normalized ? [raw[j][0] * w, raw[j][1] * h] : [raw[j][0], raw[j][1]]);
    }
    // Photoshop's ExtendScript polygon selection accepts ~1000 points max
    // (measured: 1000 OK, 1100 raises "illegal argument"). Decimate if needed.
    if (pts.length > 1000) {
        var keep = Math.ceil(pts.length / 1000);
        var sub = [];
        for (var k = 0; k < pts.length; k += keep) sub.push(pts[k]);
        pts = sub;
    }
    d.selection.deselect();
    d.selection.select(pts);
    var f2 = bboxFrac();
    __maskBBox = f2 >= 0 ? f2.toFixed(3) : '';
    var feather = maskCfg.feather > 0 ? maskCfg.feather : 12;
    d.selection.feather(feather);
    __maskInfo = 'polygon-' + pts.length + 'pt-' + (normalized ? 'norm' : 'px')
        + (maskCfg.polygonFile ? '-file' : '');
    return true;
}

// --- soft alpha ("channel") mask -------------------------------------------
// mask.mode = "alpha": the mask comes from an RGBA PNG whose alpha channel is a
// per-pixel soft matte (generated by tracemask.py alpha / alphamatte.py). The
// PNG layer is duplicated into the document, its *transparency* is loaded as a
// selection (Load Selection > Layer Transparency via Action Manager), so hair
// strands keep partial alpha instead of being cut by a hard polygon. The
// selection is also stored as an alpha channel (inspected via the PSD) and the
// subject layer is cut with it, giving a real soft edge in the composite.
var __alphaLayer = null;
var __alphaChannelStored = false;

function prepareAlphaSource(maskCfg) {
    var d = A();
    if (__alphaLayer) return true;
    if (!maskCfg.alphaFile) throw new Error('mask.mode=alpha 需要 mask.alphaFile');
    var ad = app.open(new File(maskCfg.alphaFile));
    var aw = ad.width.as('px'), ah = ad.height.as('px');
    var dw = d.width.as('px'), dh = d.height.as('px');
    if (aw !== dw || ah !== dh) {
        ad.close(SaveOptions.DONOTSAVECHANGES);
        throw new Error('alpha 尺寸 ' + aw + 'x' + ah + ' 与内容区 ' + dw + 'x' + dh + ' 不一致');
    }
    ad.activeLayer = ad.layers[0];
    var src = ad.layers[0].duplicate(d);
    ad.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = d;
    d.activeLayer = src;
    src.name = '__alphaSrc';
    src.visible = false;
    __alphaLayer = src;
    return true;
}

function loadAlphaSelection() {
    var d = A();
    if (!__alphaLayer) throw new Error('alpha 源图层未就绪');
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(charIDToTypeID('Chnl'), charIDToTypeID('fsel'));
    desc.putReference(charIDToTypeID('null'), ref);
    var ref2 = new ActionReference();
    ref2.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Trsp'));
    ref2.putName(charIDToTypeID('Lyr '), __alphaLayer.name);
    desc.putReference(charIDToTypeID('T   '), ref2);
    executeAction(charIDToTypeID('setd'), desc, DialogModes.NO);
    return true;
}

function selectAlpha(maskCfg) {
    var d = A();
    __step = 'alpha-mask';
    prepareAlphaSource(maskCfg);
    loadAlphaSelection();
    var fb = bboxFrac();
    __maskBBox = fb >= 0 ? fb.toFixed(3) : '';
    // keep the soft matte as an alpha channel for inspection / PSD delivery
    if (!__alphaChannelStored && maskCfg.storeChannel !== false) {
        try {
            var ch;
            try { ch = d.channels.add(); } catch (eAdd) {
                var mk = new ActionDescriptor();
                mk.putClass(charIDToTypeID('Nw  '), charIDToTypeID('Chnl'));
                executeAction(charIDToTypeID('Mk  '), mk, DialogModes.NO);
                ch = d.channels[d.channels.length - 1];
            }
            // creating a channel makes it the active (single) channel; restore
            // the RGB composite or later layer edits/clear would target it
            var selRgb = new ActionDescriptor();
            var rgbRef = new ActionReference();
            rgbRef.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('RGB '));
            selRgb.putReference(charIDToTypeID('null'), rgbRef);
            executeAction(charIDToTypeID('slct'), selRgb, DialogModes.NO);
            d.selection.store(ch);
            __alphaChannelStored = true;
            __step = 'mask';
            __maskInfo = 'channel-alpha(' + ch.name + ')';
        } catch (e) {}
    }
    if (maskCfg.contract > 0) {
        try { d.selection.contract(maskCfg.contract); } catch (e) {}
    }
    if (maskCfg.feather > 0) d.selection.feather(maskCfg.feather);
    if (__maskInfo === 'none') __maskInfo = 'channel-alpha';
    return true;
}

function dropAlphaSource() {
    if (__alphaLayer) {
        try { __alphaLayer.remove(); } catch (e) {}
        __alphaLayer = null;
    }
}

// Build the final subject selection for a mask config (leaves it active).
// Used by cutSubjectLayer and by the edge-safe sharpening pass.
function buildSubjectSelection(maskCfg, w, h) {
    var d = A();
    var mode = maskCfg.mode;
    if (mode === 'alpha') return selectAlpha(maskCfg);
    if (mode === 'subject' || mode === 'person') {
        var ai = false;
        try { ai = selectAI(maskCfg); } catch (e) { ai = false; }
        if (!ai) {
            if (!selectHorizon({ horizon: maskCfg.fallbackHorizon || 0.6, feather: 120 })) return false;
            __maskInfo = 'fallback-horizon';
            return true;
        }
        if (mode === 'person') {
            // narrow the AI foreground to the person region: AI pixels stay,
            // the manual polygon / ellipse decides who counts as the subject
            if (maskCfg.polygon && maskCfg.polygon.length >= 3) {
                var raw = maskCfg.polygon;
                var pts = [];
                var norm = true;
                for (var i = 0; i < raw.length; i++) {
                    if (raw[i][0] > 1.5 || raw[i][1] > 1.5) { norm = false; break; }
                }
                for (var j = 0; j < raw.length; j++) {
                    pts.push(norm ? [raw[j][0] * w, raw[j][1] * h] : [raw[j][0], raw[j][1]]);
                }
                d.selection.select(pts, SelectionType.INTERSECT, maskCfg.polygonFeather || 8, true);
                __maskInfo = 'person-ai-polygon';
            } else {
                var epts = ellipsePts(w * (maskCfg.personCx || 0.49), h * (maskCfg.personCy || 0.72),
                                      w * (maskCfg.personRx || 0.2), h * (maskCfg.personRy || 0.3));
                d.selection.select(epts, SelectionType.INTERSECT, maskCfg.personFeather || 60, true);
                __maskInfo = 'person-ai-ellipse';
            }
            return true;
        }
        __maskInfo = mode + '-ai';
        return true;
    }
    if (mode === 'horizon') return selectHorizon(maskCfg);
    if (mode === 'polygon') {
        if (maskCfg.polygonListFile) return selectPolygonList(maskCfg);
        return selectPolygon(maskCfg);
    }
    return false;
}

function cutSubjectLayer(layer, maskCfg, w, h) {
    var d = A();
    d.activeLayer = layer;
    if (!buildSubjectSelection(maskCfg, w, h)) return false;
    // alpha-mask preparation inserts/hides a helper layer and can steal the
    // active layer; re-target the layer that must be cut (also required for
    // soft selections: Clear is unavailable on a hidden layer)
    d.activeLayer = layer;
    d.selection.invert();
    d.selection.clear();
    d.selection.deselect();
    return true;
}

function saveMaskPreview(d, file, hideLayer) {
    try {
        var vis = hideLayer.visible;
        hideLayer.visible = false;
        var po = new PNGSaveOptions();
        po.compression = 6;
        d.saveAs(new File(file), po, true, Extension.LOWERCASE);
        hideLayer.visible = vis;
    } catch (e) {}
}

function savePng(d, file) {
    var o = new PNGSaveOptions();
    o.compression = 6;
    o.interlaced = false;
    d.saveAs(new File(file), o, true, Extension.LOWERCASE);
}
function savePsd(d, file) {
    try {
        var o = new PhotoshopSaveOptions();
        o.layers = true;
        d.saveAs(new File(file), o, true, Extension.LOWERCASE);
    } catch (e) {}
}

// Radial depth-of-field fake: duplicate + blur, delete the centre, merge down.
// Keeps the subject sharp and softens the surroundings (premium "camera lens"
// feel); unlike a flat background blur this never touches the centre.
function depthBlur(o) {
    var d = A();
    var w = d.width.as('px'), h = d.height.as('px');
    var base = d.activeLayer;
    var dup = base.duplicate();
    d.activeLayer = dup;
    if (o.amount > 0) { try { dup.applyGaussianBlur(o.amount); } catch (e) {} }
    var cx = (o.cx === undefined ? 0.5 : o.cx) * w;
    var cy = (o.cy === undefined ? 0.55 : o.cy) * h;
    var rx = (o.radius === undefined ? 0.34 : o.radius) * w;
    var ry = (o.ry === undefined ? (o.radius === undefined ? 0.34 : o.radius) : o.ry) * h;
    selEllipse(cx, cy, rx, ry, (o.feather === undefined ? 0.6 : o.feather) * Math.min(rx, ry));
    try { d.selection.clear(); } catch (e) {}
    deselect();
    mergeDown();
}

var __step = 'open';
try {
    var d = app.open(new File(CFG.input));
    __step = 'crop';
    d.crop([CFG.crop.left, CFG.crop.top, CFG.crop.right, CFG.crop.bottom]);
    var w = d.width.as('px'), h = d.height.as('px');
    var S = CFG.steps;

    // ---- 1. global base pass --------------------------------------------
    if (S.bloom && S.bloom.opacity > 0) { __step = 'bloom'; bloom(S.bloom.radius, S.bloom.opacity); }
    __step = 'tone';
    tone(S.tone.ib, S.tone.iw, S.tone.gamma, S.tone.ob, S.tone.ow);
    __step = 'split';
    split(S.split.sh, S.split.mid, S.split.hi);
    if (S.desat > 0) {
        __step = 'desat';
        addFill('808080', BlendMode.SATURATION, S.desat);
        mergeVisible();
    }

    var layered = S.layers && S.layers.mask && S.layers.mask.mode && S.layers.mask.mode !== 'none';
    var zones = (S.layers && S.layers.zones && S.layers.zones.length) ? S.layers.zones : null;
    var depthMode = Boolean(layered && S.layers.mask.mode === 'depth');

    if (zones) {
        // ---- 2a. multi-zone local adjustment (order matters: later zones win overlaps) ----
        __step = 'zones';
        var zoneBase = d.activeLayer;
        // person zones always run last so skin / hair / clothes are re-adjusted
        // after the colour zones, and wins any overlap.
        var zonesOrdered = [];
        for (var zqa = 0; zqa < zones.length; zqa++) {
            var zqaSel = (zones[zqa] && zones[zqa].select) || {};
            if (zqaSel.mode !== 'person' && zqaSel.mode !== 'subject') zonesOrdered.push(zones[zqa]);
        }
        for (var zqb = 0; zqb < zones.length; zqb++) {
            var zqbSel = (zones[zqb] && zones[zqb].select) || {};
            if (zqbSel.mode === 'person' || zqbSel.mode === 'subject') zonesOrdered.push(zones[zqb]);
        }
        zones = zonesOrdered;
        for (var zi = 0; zi < zones.length; zi++) {
            var zone = zones[zi] || {};
            var zcfg = zone.select || {};
            if (!zcfg.mode || zcfg.mode === 'none') continue;
            var zSelOk = false;
            try {
                zSelOk = buildSubjectSelection(zcfg, w, h);
            } catch (eZoneSel) {
                zSelOk = false;
            }
            if (!zSelOk) {
                __maskInfo = 'zone-' + zi + '-skipped(' + zcfg.mode + ')';
                try { deselect(); } catch (eDs0) {}
                continue;
            }
            if (zcfg.mode === 'person' || zcfg.mode === 'subject') {
                var personFrac = 0;
                try {
                    var pb = d.selection.bounds;
                    personFrac = ((pb[2] - pb[0]) * (pb[3] - pb[1])) / Math.max(1, w * h);
                } catch (ePb) { personFrac = 0; }
                if (personFrac < 0.005 || personFrac > 0.75) {
                    __maskInfo = 'zone-' + zi + '-person-implausible(' + personFrac.toFixed(3) + ')';
                    try { deselect(); } catch (ePf) {}
                    continue;
                }
            }
            if (zcfg.invert === true) {
                try { d.selection.invert(); } catch (eInv) {}
            }
            var zoneEmpty = false;
            try {
                var zoneBounds = d.selection.bounds;
                zoneEmpty = !zoneBounds || zoneBounds[2] <= zoneBounds[0] || zoneBounds[3] <= zoneBounds[1];
            } catch (eBounds) {
                zoneEmpty = true;
            }
            if (zoneEmpty) {
                __maskInfo = 'zone-' + zi + '-empty(' + zcfg.mode + ')';
                try { deselect(); } catch (eDs1) {}
                continue;
            }
            if (zi === 0 && CFG.maskOut) {
                try { saveMaskPreview(d, CFG.maskOut, d.activeLayer); } catch (eMp) {}
            }
            try { d.activeLayer = zoneBase; } catch (eAct) {}
            applyGroup({ tone: zone.tone, split: zone.split, desat: zone.desat });
            applyGroup({ bloom: zone.bloom, clarity: zone.clarity, usm: zone.usm, grain: zone.grain });
            deselect();
            dropAlphaSource();
        }
        __maskInfo = 'zones-' + zones.length;
        mergeVisible();
    } else if (depthMode) {
        // ---- 2b. gradient depth split (atmospheric perspective) ----------
        // three stacked layers cut by wide-feathered horizontal bands:
        //   background/far (base)  midground/middle  subject=near/foreground (top)
        __step = 'split-layers-depth';
        var baseLayer = d.activeLayer;
        var depthMask = S.layers.mask;
        var y1 = Math.round(h * (depthMask.band1 || 0.45));
        var y2 = Math.round(h * (depthMask.band2 || 0.85));
        if (y2 <= y1 + 20) y2 = y1 + 20;
        var f1 = Number(depthMask.feather1 !== undefined ? depthMask.feather1 : 140);
        var f2 = Number(depthMask.feather2 !== undefined ? depthMask.feather2 : 100);
        var bEs = Number(depthMask.edgeSafe || 0);
        var midGroup = S.layers.midground || {};
        var nearGroup = S.layers.subject || S.layers.foreground || {};
        var farGroup = S.layers.background || {};

        // midground: either a feathered band, or the subject itself via soft alpha
        // (mask.midAlphaFile = channel mask; character becomes the middle layer)
        var midLayer = baseLayer.duplicate();
        var alphaMid = Boolean(depthMask.midAlphaFile);
        var midAlphaCfg = null;
        if (alphaMid) {
            midAlphaCfg = {};
            for (var ak in depthMask) midAlphaCfg[ak] = depthMask[ak];
            midAlphaCfg.mode = 'alpha';
            midAlphaCfg.alphaFile = depthMask.midAlphaFile;
        }
        d.activeLayer = midLayer;
        applyGroup({ tone: midGroup.tone, split: midGroup.split, desat: midGroup.desat });
        if (alphaMid) {
            if (!cutSubjectLayer(midLayer, midAlphaCfg, w, h)) {
                throw new Error('depth mid alpha mask failed (' + __maskInfo + ')');
            }
        } else {
            selectBand(y1, y2, f1);
            d.selection.invert();
            d.selection.clear();
            d.selection.deselect();
        }
        var midSharp = { bloom: midGroup.bloom, clarity: midGroup.clarity, usm: midGroup.usm, grain: midGroup.grain };
        if (groupHasSharp(midSharp)) {
            __step = 'mid-sharpen';
            if (alphaMid && bEs > 0) {
                var midInner = {};
                for (var mk2 in midAlphaCfg) midInner[mk2] = midAlphaCfg[mk2];
                midInner.contract = Number(midAlphaCfg.contract || 0) + bEs;
                midInner.feather = 2;
                if (buildSubjectSelection(midInner, w, h)) {
                    d.activeLayer = midLayer;
                    applyGroup(midSharp);
                    deselect();
                }
            } else if (alphaMid) {
                applyGroup(midSharp);
            } else {
                selectBand(y1 + bEs, y2 - bEs, 2);
                applyGroup(midSharp);
                deselect();
            }
        }
        if (alphaMid) dropAlphaSource();

        // near / foreground band (below the mid layer; duplication order keeps
        // the character layer on top of it)
        var nearLayer = baseLayer.duplicate();
        d.activeLayer = nearLayer;
        applyGroup({ tone: nearGroup.tone, split: nearGroup.split, desat: nearGroup.desat });
        selectBand(y2, h + 2, f2);
        d.selection.invert();
        d.selection.clear();
        d.selection.deselect();
        var nearSharp = { bloom: nearGroup.bloom, clarity: nearGroup.clarity, usm: nearGroup.usm, grain: nearGroup.grain };
        if (groupHasSharp(nearSharp)) {
            __step = 'near-sharpen';
            selectBand(y2 + bEs, h + 2, 2);
            applyGroup(nearSharp);
            deselect();
        }

        __maskInfo = alphaMid
            ? ('depth-alpha+' + __maskInfo)
            : ('bands-y' + y1 + '-' + y2 + '-f' + f1 + '/' + f2);
        if (CFG.maskOut) saveLayerOnly(d, midLayer, CFG.maskOut);
        try { baseLayer.name = 'background-far'; } catch (eN1) {}
        try { midLayer.name = 'midground'; } catch (eN2) {}
        try { nearLayer.name = 'foreground-near'; } catch (eN3) {}

        // far/background layer: direct adjustments only (it is the base layer)
        __step = 'background-adjust';
        d.activeLayer = baseLayer;
        if (farGroup.tone) tone(farGroup.tone.ib, farGroup.tone.iw, farGroup.tone.gamma, farGroup.tone.ob, farGroup.tone.ow);
        if (farGroup.split) split(farGroup.split.sh, farGroup.split.mid, farGroup.split.hi);
        if (farGroup.usm && farGroup.usm.amount > 0) usm(farGroup.usm.amount, farGroup.usm.radius || 1.0, 0);
        if (farGroup.blur > 0) blur(farGroup.blur);
        mergeVisible();
    } else if (layered) {
        // ---- 2. split: subject layer on top, background stays as base ----
        __step = 'split-layers';
        var baseLayer = d.activeLayer;
        var subjectLayer = baseLayer.duplicate();
        d.activeLayer = subjectLayer;
        var subjGroup = S.layers.subject || {};
        // soft-alpha masks need the helper transparency layer before cutting
        if (S.layers.mask.mode === 'alpha') {
            prepareAlphaSource(S.layers.mask);
            d.activeLayer = subjectLayer;
        }
        // tone/split/desaturation are safe at the silhouette edge;
        // bloom/clarity/USM create halos there, so they run after the cut,
        // restricted to an eroded interior when mask.edgeSafe > 0.
        applyGroup({ tone: subjGroup.tone, split: subjGroup.split, desat: subjGroup.desat });
        if (!cutSubjectLayer(subjectLayer, S.layers.mask, w, h)) {
            throw new Error('mask selection failed (mode=' + S.layers.mask.mode
                + ', info=' + __maskInfo + ')');
        }
        var sharpGroup = { bloom: subjGroup.bloom, clarity: subjGroup.clarity, usm: subjGroup.usm, grain: subjGroup.grain };
        var hasSharp = (sharpGroup.bloom && sharpGroup.bloom.opacity > 0)
            || (sharpGroup.clarity && sharpGroup.clarity.opacity > 0)
            || (sharpGroup.usm && sharpGroup.usm.amount > 0)
            || (sharpGroup.grain > 0);
        var edgeSafe = (S.layers.mask.edgeSafe !== undefined) ? Number(S.layers.mask.edgeSafe) : 0;
        if (hasSharp) {
            __step = 'subject-sharpen';
            if (edgeSafe > 0) {
                var innerCfg = {};
                for (var mk in S.layers.mask) innerCfg[mk] = S.layers.mask[mk];
                innerCfg.contract = Number(S.layers.mask.contract || 0) + edgeSafe;
                innerCfg.feather = 2;
                if (buildSubjectSelection(innerCfg, w, h)) {
                    d.activeLayer = subjectLayer;
                    applyGroup(sharpGroup);
                    deselect();
                }
            } else {
                applyGroup(sharpGroup);
            }
        }
        if (CFG.maskOut) saveMaskPreview(d, CFG.maskOut, baseLayer);
        if (S.layers.mask.mode === 'alpha') dropAlphaSource();
        try { baseLayer.name = 'background'; } catch (eName1) {}
        try { subjectLayer.name = 'subject'; } catch (eName2) {}

        __step = 'background-adjust';
        d.activeLayer = baseLayer;
        var bgGroup = S.layers.background || {};
        // background is the bottom layer: only direct adjustments are safe
        if (bgGroup.tone) tone(bgGroup.tone.ib, bgGroup.tone.iw, bgGroup.tone.gamma, bgGroup.tone.ob, bgGroup.tone.ow);
        if (bgGroup.split) split(bgGroup.split.sh, bgGroup.split.mid, bgGroup.split.hi);
        if (bgGroup.usm && bgGroup.usm.amount > 0) usm(bgGroup.usm.amount, bgGroup.usm.radius || 1.0, 0);
        if (bgGroup.blur > 0) blur(bgGroup.blur);
        mergeVisible();
    } else {
        // ---- legacy single-layer subject/face emphasis -------------------
        if (S.subject) {
            __step = 'subject';
            selEllipse(w * S.subject.cx, h * S.subject.cy, w * S.subject.rx, h * S.subject.ry, S.subject.feather);
            if (S.subject.tone) { tone(S.subject.tone.ib, S.subject.tone.iw, S.subject.tone.gamma, S.subject.tone.ob, S.subject.tone.ow); }
            if (S.subject.usm) { usm(S.subject.usm.amount, S.subject.usm.radius, 0); }
            deselect();
        }
        if (S.face) {
            __step = 'face';
            selEllipse(w * S.face.cx, h * S.face.cy, w * S.face.rx, h * S.face.ry, S.face.feather);
            tone(0, 255, S.face.gamma, 0, 255);
            if (S.face.split) { split(S.face.split.sh, S.face.split.mid, S.face.split.hi); }
            deselect();
        }
    }

    // ---- 3. global finishing --------------------------------------------
    if (S.depthBlur && S.depthBlur.amount > 0) { __step = 'depthBlur'; depthBlur(S.depthBlur); }
    if (S.vignette > 0) { __step = 'vignette'; vignette(S.vignette); }
    if (S.clarity && S.clarity.opacity > 0) { __step = 'clarity'; clarity(S.clarity.radius, S.clarity.opacity); }
    if (S.finalUsm > 0) { __step = 'finalUsm'; usm(S.finalUsm, 1.0, 3); }
    if (S.noise > 0) { __step = 'grain'; A().activeLayer.applyAddNoise(S.noise, NoiseDistribution.GAUSSIAN, true); }

    __step = 'savePng';
    savePng(d, CFG.output);
    if (CFG.psd) { __step = 'savePsd'; savePsd(d, CFG.psd); }
    __step = 'close';
    d.close(SaveOptions.DONOTSAVECHANGES);
    'OK|' + w + 'x' + h + '|' + __maskInfo + '|' + __maskBBox;
} catch (e) {
    try {
        var g = 0;
        while (app.documents.length > 0 && g < 20) {
            app.documents[0].close(SaveOptions.DONOTSAVECHANGES);
            g++;
        }
    } catch (e2) {}
    'ERR|' + __step + '|' + (e.message || e) + '|' + (e.line || '');
}
