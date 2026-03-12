'use strict';

const { trimPreProcessor }              = require('./trim');
const { varianceScanPreProcessor }      = require('./varianceScan');
const { regionComparePreProcessor }     = require('./regionCompare');
const { cornerConsensusPreProcessor }   = require('./cornerConsensus');
const { meanProfilePreProcessor }       = require('./meanProfile');
const { tileColorPreProcessor }         = require('./tileColor');
const { symmetricScanPreProcessor }  = require('./symmetricScan');
const { adaptiveScanPreProcessor }   = require('./adaptiveScan');

const PRE_PROCESSORS = {
  trim:              trimPreProcessor,
  variance_scan:     varianceScanPreProcessor,
  region_compare:    regionComparePreProcessor,
  corner_consensus:  cornerConsensusPreProcessor,
  mean_profile:      meanProfilePreProcessor,
  tile_color:        tileColorPreProcessor,
  symmetric_scan:    symmetricScanPreProcessor,
  adaptive_scan:     adaptiveScanPreProcessor,
};

module.exports = {
  PRE_PROCESSORS,
  trimPreProcessor,
  varianceScanPreProcessor,
  regionComparePreProcessor,
  cornerConsensusPreProcessor,
  meanProfilePreProcessor,
  tileColorPreProcessor,
  symmetricScanPreProcessor,
  adaptiveScanPreProcessor,
};