/**
 * Build a pixel-level person alpha PNG from Photoshop's AI subject selection.
 *
 * Copy the selected subject into a transparent document and save it as PNG: the
 * result is an RGBA cutout whose alpha channel is a per-pixel person matte
 * (native resolution, antialiased edges). Used by grade.js to:
 *   - subtract the person from every colour/channel zone mask (pixel-level), so
 *     skin / white clothes / hair are ONLY affected by the person zone;
 *   - drive the person zone itself through the existing soft-alpha pipeline.
 */
export function buildPersonMaskJsx({ input, output, crop = null, feather = 0 } = {}) {
  const cropCode = Array.isArray(crop) && crop.length === 4
    ? `doc.crop([${crop.map((value) => Math.round(Number(value))).join(',')}]);`
    : ''
  const featherCode = Number(feather) > 0 ? `try { doc.selection.feather(${Number(feather)}); } catch (e) {}` : ''
  return `#target photoshop
(function () {
    var src = app.open(new File(${JSON.stringify(String(input))}));
    var doc = src;
    ${cropCode}
    try {
        executeAction(stringIDToTypeID("autoCutout"), undefined, DialogModes.NO);
    } catch (e) {
        throw new Error('Select Subject failed: ' + e.message);
    }
    ${featherCode}
    doc.selection.copy();
    var w = Math.round(doc.width.as('px'));
    var h = Math.round(doc.height.as('px'));
    var maskDoc = app.documents.add(w, h, doc.resolution, 'lumina-person-mask', NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1.0, BitsPerChannelType.EIGHT);
    app.activeDocument = maskDoc;
    maskDoc.paste();
    var pngOpt = new PNGSaveOptions();
    pngOpt.interlaced = false;
    maskDoc.saveAs(new File(${JSON.stringify(String(output))}), pngOpt, true, Extension.LOWERCASE);
    maskDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
    doc.close(SaveOptions.DONOTSAVECHANGES);
    return 'OK|person-mask';
})();`
}
