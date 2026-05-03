'use strict';

const { sharpCropEngine }    = require('./sharpCrop');
const { faceAwareCropEngine } = require('./faceAware');

const CROP_ENGINES = {
  sharp:      sharpCropEngine,
  face_aware: faceAwareCropEngine,
};

module.exports = { CROP_ENGINES, sharpCropEngine, faceAwareCropEngine };