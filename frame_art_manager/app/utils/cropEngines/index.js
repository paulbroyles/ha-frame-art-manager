'use strict';

const { sharpCropEngine } = require('./sharpCrop');

const CROP_ENGINES = {
  sharp: sharpCropEngine,
  // Future: ml: mlCropEngine
};

module.exports = { CROP_ENGINES, sharpCropEngine };