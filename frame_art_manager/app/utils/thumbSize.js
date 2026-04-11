'use strict';

/**
 * Thumbnail size utilities for web source image downloads.
 *
 * Rather than downloading full-resolution originals (which can be 50–100 MB TIFFs),
 * sources request pre-resized thumbnails from each provider's resize infrastructure.
 * The thumbnail must be large enough to cover the 4K output target with headroom for
 * the crop engine to work with.
 *
 * TV targets:
 *   Landscape: 3840 × 2160
 *   Portrait:  2160 × 3840
 *
 * These are the current defaults. In future they should be configurable per TV so that
 * lower-resolution TVs don't unnecessarily fetch 4K-sized thumbnails. The API is
 * designed to accept explicit target dimensions wherever needed.
 *
 * Output orientation is always known before download. Source image dimensions are
 * sometimes known (e.g. from Wikimedia Commons imageinfo API) and sometimes not
 * (e.g. Wikidata P18 SPARQL). When source dimensions are known, we compute an exact
 * thumb size; when not, we request by the constraining axis for the known orientation.
 */

const HEADROOM_FACTOR  = 1.2;   // 20% headroom over the long-edge target

const TV_TARGETS = {
  landscape: { w: 3840, h: 2160 },
  portrait:  { w: 2160, h: 3840 },
};

/**
 * The default thumbnail long-edge size for a given orientation.
 * = long-edge of TV target × HEADROOM_FACTOR.
 *
 * Both orientations share the same long edge (3840px), so this is orientation-
 * independent in value but used differently:
 *   landscape → request width=THUMB_LONG_EDGE (width is long edge)
 *   portrait  → request height=THUMB_LONG_EDGE (height is long edge)
 */
const THUMB_LONG_EDGE = Math.round(TV_TARGETS.landscape.w * HEADROOM_FACTOR);  // 4608

/**
 * Compute the optimal thumbnail width to request for a source image with known dimensions.
 *
 * Determines which source dimension is the constraining one for fitting the output
 * target, then applies headroom. Always returns a width (not height) — callers pass
 * this as iiurlwidth or the width component of an IIIF size parameter.
 *
 * @param {number} srcW                         Source image width in pixels
 * @param {number} srcH                         Source image height in pixels
 * @param {'landscape'|'portrait'} orientation  Target TV orientation
 * @param {object} [target]                     Override target dims; defaults to standard 4K
 * @param {number} [target.w]
 * @param {number} [target.h]
 * @returns {number}  Thumbnail width to request
 */
function thumbWidthFor(srcW, srcH, orientation = 'landscape', target) {
  const { w: targetW, h: targetH } = { ...TV_TARGETS[orientation] || TV_TARGETS.landscape, ...target };

  const srcAspect    = srcW / srcH;
  const targetAspect = targetW / targetH;

  let neededW;
  if (srcAspect >= targetAspect) {
    // Height is the constraining dimension — scale to cover target height, measure resulting width.
    neededW = Math.ceil((targetH / srcH) * srcW);
  } else {
    neededW = targetW;
  }

  return Math.round(neededW * HEADROOM_FACTOR);
}

/**
 * Compute the optimal IIIF max-fit bounding box size string for a source image.
 *
 * IIIF `!w,h` syntax: fit inside w×h while preserving aspect ratio. This function
 * returns a bounding box that guarantees the image covers the output target after
 * the crop engine works on it, without fetching unnecessary pixels.
 *
 * When source dimensions are known, the box is tailored to the exact constraining axis:
 * wide sources (srcAspect ≥ targetAspect) are height-constrained, so th = tw × (targetH/targetW);
 * narrow sources (srcAspect < targetAspect) are width-constrained for cover-fit, so th = ⌈tw/srcAspect⌉
 * to prevent the height side of the box from binding first and under-serving the width.
 * When unknown, both sides are set to THUMB_LONG_EDGE (safe square fallback for any aspect ratio).
 *
 * @param {'landscape'|'portrait'} orientation  Target TV orientation
 * @param {number} [srcW]                       Source width (optional — enables precision)
 * @param {number} [srcH]                       Source height (optional — enables precision)
 * @param {object} [target]                     Override target dims; defaults to standard 4K
 * @returns {string}  e.g. "4608,4608" or "4800,2700" for IIIF size param `!{result}`
 */
function iiifBoundingBox(orientation = 'landscape', srcW, srcH, target) {
  if (srcW && srcH) {
    const tw = thumbWidthFor(srcW, srcH, orientation, target);
    const { w: targetW, h: targetH } = { ...TV_TARGETS[orientation] || TV_TARGETS.landscape, ...target };
    const srcAspect    = srcW / srcH;
    const targetAspect = targetW / targetH;
    // For narrow sources (srcAspect < targetAspect), cover-fit scales by width, so the
    // bounding box height must be tall enough to not height-constrain the download.
    // For wide sources, the target-aspect height is the correct constraint.
    const th = srcAspect < targetAspect
      ? Math.ceil(tw / srcAspect)
      : Math.round(tw * (targetH / targetW));
    return `${tw},${th}`;
  }
  // No source dims: use a square bounding box at THUMB_LONG_EDGE × THUMB_LONG_EDGE.
  // IIIF !w,h will never upscale, so this is safe for any aspect ratio.
  return `${THUMB_LONG_EDGE},${THUMB_LONG_EDGE}`;
}

/**
 * Rewrite a Wikimedia Commons thumb URL to a different width.
 *
 * Wikimedia thumb URLs have the form:
 *   https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/File.jpg/4608px-File.jpg
 *
 * Replacing the width segment gives a thumb at the desired size without any extra
 * API call. Wikimedia generates these on demand.
 *
 * @param {string} thumbUrl   Thumb URL as returned by the Wikimedia imageinfo API
 * @param {number} newWidth   Desired width in pixels
 * @returns {string}
 */
function adjustThumbWidth(thumbUrl, newWidth) {
  return thumbUrl.replace(/\/\d+px-/, `/${newWidth}px-`);
}

/**
 * Build the query parameter for a Wikimedia Special:FilePath thumb request.
 *
 * Special:FilePath supports ?width=N (scales by width) and ?height=N (scales by height).
 * For portrait output we constrain by height (the long edge); for landscape by width.
 * This ensures we always have sufficient resolution in the constraining axis.
 *
 * @param {'landscape'|'portrait'} orientation
 * @returns {string}  e.g. "width=4608" or "height=4608"
 */
function thumbSpecialFileParam(orientation = 'landscape') {
  const dim = orientation === 'portrait' ? 'height' : 'width';
  return `${dim}=${THUMB_LONG_EDGE}`;
}

module.exports = {
  THUMB_LONG_EDGE,
  thumbWidthFor,
  iiifBoundingBox,
  adjustThumbWidth,
  thumbSpecialFileParam,
};
