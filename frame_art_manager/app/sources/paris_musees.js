'use strict';

/**
 * Paris Musées — thin wrapper over wikimedia_commons.
 *
 * Pre-injects { type: 'institution', mode: 'require', values: ['Paris Musées'] }
 * into all fetches, and hides the institution filter from the UI since it's fixed.
 * All other Wikimedia Commons filters (media type, subject, century, license,
 * artist, search) remain available.
 */

const commons = require('./wikimedia_commons');

const SOURCE_LABEL      = 'Paris Musées';
const INSTITUTION_FILTER = { type: 'institution', mode: 'require', values: [SOURCE_LABEL] };

function withInstitution(filters) {
  return [INSTITUTION_FILTER, ...filters];
}

async function fetchRandomArtwork(filters = [], options = {}) {
  const result = await commons.fetchRandomArtwork(filters, {
    ...options,
    sourceLabel: SOURCE_LABEL,
    preFilters:  [INSTITUTION_FILTER, ...(options.preFilters || [])],
  });
  return result;
}

async function fetchByIdentifier(identifier, options = {}) {
  return commons.fetchByIdentifier(identifier, { ...options, sourceLabel: SOURCE_LABEL });
}

async function searchPreview(query, options = {}) {
  return commons.searchPreview(query, {
    ...options,
    sourceLabel: SOURCE_LABEL,
    preFilters:  [INSTITUTION_FILTER, ...(options.preFilters || [])],
  });
}

async function countArtistArtworks(artistName, options = {}) {
  return commons.countArtistArtworks(artistName, {
    ...options,
    preFilters: [INSTITUTION_FILTER, ...(options.preFilters || [])],
  });
}

function selectMode(filters = []) {
  return commons.selectMode(withInstitution(filters));
}

function getFilterTypes() {
  // Hide 'institution' since it's pre-set to Paris Musées.
  return commons.getFilterTypes().filter(f => f.type !== 'institution');
}

module.exports = {
  fetchRandomArtwork,
  fetchByIdentifier,
  canHandleIdentifier: commons.canHandleIdentifier,
  countArtistArtworks,
  searchPreview,
  selectMode,
  getFilterTypes,
  settingsSchema:  commons.settingsSchema,
  getExtraOptions: commons.getExtraOptions,
  metadataFields:  commons.metadataFields,
  defaultMapping:  commons.defaultMapping,
};
