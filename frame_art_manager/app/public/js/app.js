// API Base URL
const API_BASE = 'api';

// Global state
let libraryPath = null; // Store library path for tooltips
let isSyncInProgress = false; // Track if a sync operation is currently running
let appEnvironment = 'development'; // 'development' or 'production'

/**
 * Extract base name from a hashed filename (e.g., "photo-abc123.jpg" -> "photo")
 * @param {string} filename - The filename with hash
 * @returns {string} - The base name without hash or extension
 */
function getBaseName(filename) {
  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.substring(0, lastDot) : filename;
  const lastDash = nameWithoutExt.lastIndexOf('-');
  // Check if the part after the last dash looks like a hash (8 hex chars)
  if (lastDash > 0) {
    const possibleHash = nameWithoutExt.substring(lastDash + 1);
    if (/^[a-f0-9]{8}$/i.test(possibleHash)) {
      return nameWithoutExt.substring(0, lastDash);
    }
  }
  return nameWithoutExt;
}

// State
const navigationContext = detectNavigationContext();
const isInitialTabLoad = navigationContext.isFirstLoadInTab;

const SORT_PREFERENCE_STORAGE_KEY = 'frameArt.sortPreference';

function loadSortPreference() {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(SORT_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    // SYNC: Must match <option value="..."> in index.html #sort-order dropdown
    const validOrders = ['name', 'date', 'displayed', 'modified'];
    if (!parsed || !validOrders.includes(parsed.order)) {
      return null;
    }

    return {
      order: parsed.order,
      ascending: typeof parsed.ascending === 'boolean' ? parsed.ascending : true
    };
  } catch (error) {
    console.warn('Failed to load sort preference:', error);
    return null;
  }
}

function saveSortPreference(order, ascending) {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(
      SORT_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        order,
        ascending: !!ascending
      })
    );
  } catch (error) {
    console.warn('Failed to save sort preference:', error);
  }
}

const storedSortPreference = loadSortPreference();
const initialSortOrderPreference = storedSortPreference?.order || 'displayed';
let sortAscending = typeof storedSortPreference?.ascending === 'boolean' ? storedSortPreference.ascending : false;


let allImages = {};
let allTags = [];
let allTVs = [];
let allGlobalTagsets = {}; // Global tagsets (name -> {tags, exclude_tags})
let allAttributes = []; // Global custom attribute names
let allEntityTypes = []; // Global entity type definitions
let allEntityInstances = {}; // entityId → { instanceKey → { attrName: value } }
let allCustomDataOrder = []; // [{type:'attribute',name:str}|{type:'entity',id:str}]
let currentImage = null;
let selectedImages = new Set();
let lastClickedIndex = null;
let galleryHasLoadedAtLeastOnce = false;
let currentUploadPreviewUrl = null;
let activeUploadPreviewToken = 0;
let thumbnailCacheBusters = {}; // Map of filename -> timestamp for cache busting edited thumbnails

// Chunked gallery rendering state
const GALLERY_CHUNK_SIZE = 100; // Initial and incremental load size
let currentFilteredImages = []; // Store filtered/sorted results for chunked loading
let renderedCount = 0; // How many images currently rendered
let isLoadingMoreImages = false; // Prevent multiple simultaneous loads

const createDefaultEditState = () => ({
  active: false,
  hasBackup: false,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  adjustments: { brightness: 0, contrast: 0, hue: 0, saturation: 0, lightness: 0 },
  filter: 'none',
  naturalWidth: 0,
  naturalHeight: 0,
  rotation: 0, // degrees, -45 to +45
  cropPreset: 'free',
  targetResolution: null,
  userSelectedCropPreset: false,
  autoPresetApplied: false,
  activeTool: null,
  isDirty: false,
  previewEnabled: true
});

const FILTER_ALIASES = {
  'gallery-soft': 'watercolor',
  'gallery': 'watercolor',
  'vivid-sky': 'pop-art',
  'dusk-haze': 'watercolor',
  'impressionist': 'impressionist',
  'oil painting': 'oil-paint',
  'oilpaint': 'oil-paint',
  'oil-painting': 'oil-paint',
  'deco-gold': 'art-deco',
  'artdeco': 'art-deco',
  'art deco': 'art-deco',
  'charcoal': 'sketch',
  'pencil': 'sketch',
  'sketch': 'sketch',
  'silver-tone': 'silver-pearl',
  'monochrome': 'silver-pearl',
  'grayscale': 'silver-pearl',
  'ink-sketch': 'sketch',
  'ink': 'graphite-ink',
  'wash': 'watercolor',
  'pastel': 'watercolor',
  'pastel-wash': 'watercolor',
  'aqua': 'watercolor',
  'feuve': 'impressionist',
  'luminous-portrait': 'art-deco',
  'golden-hour': 'art-deco',
  'ember-glow': 'oil-paint',
  'arctic-mist': 'watercolor',
  'verdant-matte': 'impressionist',
  'forest-depth': 'oil-paint',
  'retro-fade': 'impressionist',
  'cobalt-pop': 'pop-art',
  'sunlit-sienna': 'art-deco',
  'coastal-breeze': 'watercolor',
  'film-classic': 'oil-paint',
  'watercolour': 'watercolor',
  'pop art': 'pop-art',
  'popart': 'pop-art',
  'neural': 'neural-style',
  'neural-style': 'neural-style'
};

const AVAILABLE_FILTERS = new Set([
  'none',
  'sketch',
  'oil-paint',
  'watercolor',
  'impressionist',
  'pop-art',
  'art-deco',
  'neural-style',
  'noir-cinema',
  'silver-pearl',
  'graphite-ink'
]);

const METADATA_DEFAULT_MATTE = 'none';
const METADATA_DEFAULT_FILTER = 'None';

// Matte types that work for portrait images (Samsung firmware limitation)
// See frame-art-shuffler/docs/MATTE_BEHAVIOR.md for details
const PORTRAIT_MATTE_TYPES = ['flexible', 'shadowbox'];
const LANDSCAPE_ONLY_MATTE_TYPES = ['modernthin', 'modern', 'modernwide', 'panoramic', 'triptych', 'mix', 'squares'];

// Track current upload image orientation for matte filtering
let currentUploadIsPortrait = false;

/**
 * Check if a matte type is valid for portrait images
 */
function isMatteValidForPortrait(matte) {
  if (!matte || matte === 'none') return true;
  const matteType = matte.split('_')[0];
  return PORTRAIT_MATTE_TYPES.includes(matteType);
}

/**
 * Update matte dropdown to show only valid options based on image orientation
 * @param {string} selectId - ID of the select element
 * @param {boolean} isPortrait - Whether the image is portrait orientation
 * @param {string} currentValue - Current selected value to preserve if valid
 */
function updateMatteOptionsForOrientation(selectId, isPortrait, currentValue = null) {
  const select = document.getElementById(selectId);
  if (!select) return;
  
  const optgroups = Array.from(select.querySelectorAll('optgroup'));
  let newValue = currentValue || select.value;
  
  // Remove any existing separator
  const existingSeparator = select.querySelector('.portrait-separator');
  if (existingSeparator) {
    existingSeparator.remove();
  }
  
  // Map display labels to matte type prefixes
  const typeMap = {
    'modernthin': 'modernthin',
    'modern': 'modern',
    'modernwide': 'modernwide',
    'flexible': 'flexible',
    'shadowbox': 'shadowbox',
    'panoramic': 'panoramic',
    'triptych': 'triptych',
    'mix': 'mix',
    'squares': 'squares'
  };
  
  // Categorize optgroups
  const enabledGroups = [];
  const disabledGroups = [];
  
  optgroups.forEach(group => {
    const label = group.getAttribute('label') || '';
    const matteType = label.toLowerCase().replace(/\s+/g, '');
    const actualType = typeMap[matteType] || matteType;
    const isLandscapeOnly = LANDSCAPE_ONLY_MATTE_TYPES.includes(actualType);
    
    if (isPortrait && isLandscapeOnly) {
      group.disabled = true;
      group.classList.add('matte-disabled');
      disabledGroups.push(group);
    } else {
      group.disabled = false;
      group.classList.remove('matte-disabled');
      enabledGroups.push(group);
    }
  });
  
  // Reorder: enabled groups first, then separator (if portrait), then disabled groups
  // Get the 'none' option to keep it at the top
  const noneOption = select.querySelector('option[value="none"]');
  
  // Clear and rebuild select (keeping 'none' at top)
  select.innerHTML = '';
  if (noneOption) {
    select.appendChild(noneOption);
  }
  
  // Add enabled groups
  enabledGroups.forEach(group => select.appendChild(group));
  
  // Add separator and disabled groups if portrait
  if (isPortrait && disabledGroups.length > 0) {
    const separator = document.createElement('option');
    separator.disabled = true;
    separator.className = 'portrait-separator';
    separator.textContent = '── Landscape only ──';
    select.appendChild(separator);
    
    disabledGroups.forEach(group => select.appendChild(group));
  } else {
    // For landscape, just add remaining groups in original order
    disabledGroups.forEach(group => select.appendChild(group));
  }
  
  // If current value is invalid for portrait, reset to 'none'
  if (isPortrait && !isMatteValidForPortrait(newValue)) {
    select.value = 'none';
  } else if (currentValue) {
    select.value = currentValue;
  }
}

/**
 * Detect if an image file is portrait orientation
 * @param {File} file - The image file to check
 * @returns {Promise<boolean>} - True if portrait (height > width)
 */
function detectImageOrientation(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    
    img.onload = () => {
      const isPortrait = img.naturalHeight > img.naturalWidth;
      URL.revokeObjectURL(url);
      resolve(isPortrait);
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Default to landscape on error (shows all mattes)
      resolve(false);
    };
    
    img.src = url;
  });
}

// Similar Images filter - groups visually related images with adjustable threshold
// When similarFilterActive is true, an implicit "similar" sort mode is engaged
// that groups related images together, sorted by hamming distance (most similar first).
// This sort mode does NOT appear in the sort dropdown - it auto-activates when
// entering the filter and restores the previous sort state when exiting.
let similarFilterActive = false;
let similarGroups = []; // Cache of similar groups from server (arrays of filenames)
let similarDistances = {}; // Map of "fileA|fileB" -> distance
let similarBreakpoints = []; // Breakpoints for slider ticks
let preSimilarSortState = null; // Saved sort state before entering similar filter
let similarThreshold = 38; // Default threshold for similar images (adjustable via slider)

// Non 16:9 filter - shows images that are not 16:9 aspect ratio
let non169FilterActive = false;

// Portrait filter - shows images where height > width (aspect ratio < 1)
let portraitFilterActive = false;

// Recently Displayed filter - shows current and previous images from each TV
let recentlyDisplayedFilterActive = false;
let recentlyDisplayedData = {}; // Map of filename -> [{ tv_id, tv_name, time, timestamp }]
let preRecentSortState = null; // Saved sort state before entering recently displayed filter

/**
 * Fetch recently displayed images from all TVs
 * Returns map of filename -> [{ tv_id, tv_name, time, timestamp }]
 */
async function fetchRecentlyDisplayed() {
  try {
    const response = await fetch(`${API_BASE}/ha/recently-displayed`);
    if (!response.ok) throw new Error('Failed to fetch recently displayed');
    const data = await response.json();
    recentlyDisplayedData = data.images || {};
    // Update TV status dots when recently displayed data changes
    renderTVStatusDots();
    return recentlyDisplayedData;
  } catch (error) {
    console.error('Error fetching recently displayed:', error);
    recentlyDisplayedData = {};
    return {};
  }
}

// Last displayed timestamps for sorting (filename -> timestamp)
let lastDisplayedTimes = null; // null = not fetched yet, {} = fetched but empty

/**
 * Fetch last displayed timestamps for all images
 * Returns map of filename -> timestamp (most recent completed_at)
 */
async function fetchLastDisplayedTimes() {
  // Return cached data if already fetched
  if (lastDisplayedTimes !== null) {
    return lastDisplayedTimes;
  }
  
  try {
    const response = await fetch(`${API_BASE}/analytics/last-displayed`);
    if (!response.ok) throw new Error('Failed to fetch last displayed times');
    const data = await response.json();
    lastDisplayedTimes = data.lastDisplayed || {};
    return lastDisplayedTimes;
  } catch (error) {
    console.error('Error fetching last displayed times:', error);
    lastDisplayedTimes = {}; // Set to empty so we don't keep retrying
    return {};
  }
}

/**
 * Get set of filenames that are recently displayed
 */
function getRecentlyDisplayedFilenames() {
  return new Set(Object.keys(recentlyDisplayedData));
}

/**
 * Format time ago for recently displayed badge
 * @param {string|number} time - 'now' or timestamp
 * @returns {string} - Formatted time like 'Now', '5m ago', '2h ago', '1d ago'
 */
function formatRecentTimeAgo(time) {
  if (time === 'now') return 'Now';
  
  const timestamp = typeof time === 'number' ? time : new Date(time).getTime();
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMinutes < 1) return '1m ago';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Format time until next shuffle
 * @param {string|null} isoDateString - ISO date string of next shuffle time, or null
 * @returns {string|null} - Formatted time like '5m left', '2h 15m left', or null if no shuffle scheduled or time passed
 */
function formatTimeUntilShuffle(isoDateString) {
  if (!isoDateString) return null;
  
  const nextTime = new Date(isoDateString);
  if (isNaN(nextTime.getTime())) return null; // Invalid date
  
  const now = Date.now();
  const diffMs = nextTime.getTime() - now;
  
  // If time has already passed, don't show
  if (diffMs <= 0) return null;
  
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  
  if (diffMinutes < 60) {
    return `${diffMinutes}m left`;
  }
  
  const diffHours = Math.floor(diffMinutes / 60);
  const remainingMins = diffMinutes % 60;
  
  if (remainingMins > 0) {
    return `${diffHours}h ${remainingMins}m left`;
  }
  return `${diffHours}h left`;
}

/**
 * TV Status Polling - refreshes TV data every 10 seconds
 * Keeps bubbles current with screen state, current image, shuffle times, etc.
 */
let tvStatusPollInterval = null;

function startTVStatusPolling() {
  // Clear any existing interval
  if (tvStatusPollInterval) {
    clearInterval(tvStatusPollInterval);
  }
  
  // Poll every 10 seconds
  tvStatusPollInterval = setInterval(() => {
    // Only poll if tab is visible to save resources
    if (document.visibilityState === 'visible') {
      loadTVs();
    }
  }, 10000);
  
  // Also refresh when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadTVs();
    }
  });
}

/**
 * Shuffle Countdown Timer - updates countdown display every 30 seconds
 * Uses already-fetched next_shuffle_time data, just recalculates the display
 * Since we only show minutes (not seconds), 30s interval is plenty frequent
 */
let shuffleCountdownInterval = null;

function startShuffleCountdownTimer() {
  // Clear any existing interval
  if (shuffleCountdownInterval) {
    clearInterval(shuffleCountdownInterval);
  }
  
  // Update countdown every 30 seconds (we only show minutes, not seconds)
  shuffleCountdownInterval = setInterval(() => {
    // Only update if tab is visible
    if (document.visibilityState !== 'visible') return;
    
    // Update desktop pill countdown times
    document.querySelectorAll('.tv-status-dot').forEach(dot => {
      const tvId = dot.dataset.tvId;
      const tv = allTVs.find(t => t.device_id === tvId);
      const timeEl = dot.querySelector('.pill-shuffle-time');
      
      if (tv?.next_shuffle_time) {
        const newTime = formatTimeUntilShuffle(tv.next_shuffle_time);
        if (newTime) {
          if (timeEl) {
            timeEl.textContent = newTime;
          } else {
            // Add time element if it doesn't exist
            const imageEl = dot.querySelector('.pill-image');
            if (imageEl) {
              const span = document.createElement('span');
              span.className = 'pill-shuffle-time';
              span.textContent = newTime;
              imageEl.insertAdjacentHTML('afterend', ` <span class="pill-shuffle-time">${escapeHtml(newTime)}</span>`);
            }
          }
        } else if (timeEl) {
          // Time passed, remove the element
          timeEl.remove();
        }
      } else if (timeEl) {
        timeEl.remove();
      }
    });
    
    // Update mobile bar countdown times
    document.querySelectorAll('.tv-status-bar').forEach(bar => {
      const tvId = bar.dataset.tvId;
      const tv = allTVs.find(t => t.device_id === tvId);
      const timeEl = bar.querySelector('.bar-shuffle-time');
      
      if (tv?.next_shuffle_time) {
        const newTime = formatTimeUntilShuffle(tv.next_shuffle_time);
        if (newTime) {
          if (timeEl) {
            timeEl.textContent = newTime;
          } else {
            // Add time element if it doesn't exist
            const imageEl = bar.querySelector('.bar-image');
            if (imageEl) {
              imageEl.insertAdjacentHTML('afterend', ` <span class="bar-shuffle-time">${escapeHtml(newTime)}</span>`);
            }
          }
        } else if (timeEl) {
          // Time passed, remove the element
          timeEl.remove();
        }
      } else if (timeEl) {
        timeEl.remove();
      }
    });
  }, 30000);
}

/**
 * Clear the recently displayed filter
 */
function clearRecentlyDisplayedFilter() {
  recentlyDisplayedFilterActive = false;
  const checkbox = document.querySelector('.recently-displayed-checkbox');
  if (checkbox) checkbox.checked = false;
}

/**
 * Get recently displayed info for an image
 * Returns array of { tvName: string, timeAgo: string } for badge display
 */
function getRecentlyDisplayedInfoForFile(filename) {
  if (!recentlyDisplayedFilterActive) return [];
  
  const entries = recentlyDisplayedData[filename] || [];
  if (entries.length === 0) return [];
  
  // Max TV name length for truncation
  const MAX_TV_NAME_LENGTH = 12;
  
  return entries.map(entry => {
    let tvName = entry.tv_name || 'Unknown TV';
    // Truncate long TV names
    if (tvName.length > MAX_TV_NAME_LENGTH) {
      tvName = tvName.substring(0, MAX_TV_NAME_LENGTH - 1) + '…';
    }
    const timeAgo = formatRecentTimeAgo(entry.time);
    return { tvName, timeAgo };
  });
}

/**
 * Get TV status data by combining allTVs with recentlyDisplayedData
 * Returns array of { tvId, tvName, activeTagset, currentImage, isOn }
 */
function getTVStatusData() {
  if (!allTVs || allTVs.length === 0) return [];
  
  // Build a map of tv_id -> { filename, isOn } from recentlyDisplayedData
  const tvCurrentImage = {};
  for (const [filename, entries] of Object.entries(recentlyDisplayedData)) {
    for (const entry of entries) {
      const tvId = entry.tv_id;
      const isNow = entry.time === 'now';
      // If this TV already has a 'now' entry, skip older entries
      if (tvCurrentImage[tvId]?.isOn && !isNow) continue;
      // Prefer 'now' entries, or most recent timestamp
      if (!tvCurrentImage[tvId] || isNow || entry.timestamp > tvCurrentImage[tvId].timestamp) {
        tvCurrentImage[tvId] = { filename, isOn: isNow, timestamp: entry.timestamp };
      }
    }
  }
  
  return allTVs.map(tv => {
    const current = tvCurrentImage[tv.device_id];
    return {
      tvId: tv.device_id,
      tvName: tv.name || 'Unknown TV',
      activeTagset: tv.active_tagset || '-',
      hasOverride: !!tv.override_tagset,
      currentImage: current?.filename || null,
      isOn: tv.screen_on === true,  // Use actual screen state from HA binary_sensor
      nextShuffleTime: tv.next_shuffle_time || null  // ISO datetime of next auto-shuffle
    };
  }).sort((a, b) => a.tvName.localeCompare(b.tvName));
}

/**
 * Render TV status dots in both desktop and mobile containers
 */
function renderTVStatusDots() {
  const desktopContainer = document.getElementById('tv-status-container');
  const mobileContainer = document.getElementById('tv-status-container-mobile');
  
  const tvStatus = getTVStatusData();
  
  if (tvStatus.length === 0) {
    if (desktopContainer) desktopContainer.innerHTML = '';
    if (mobileContainer) mobileContainer.innerHTML = '';
    return;
  }
  
  // Desktop: dots with hover pills
  const dotsHtml = tvStatus.map(tv => {
    const displayName = tv.currentImage ? getDisplayName(tv.currentImage) : 'None';
    const truncatedName = displayName.length > 20 ? displayName.substring(0, 19) + '…' : displayName;
    // Status: override (orange) > on (green) > off (gray)
    const statusClass = tv.hasOverride ? 'override' : (tv.isOn ? 'on' : 'off');
    // Format time until next shuffle (null if none scheduled or passed)
    const shuffleTimeLeft = formatTimeUntilShuffle(tv.nextShuffleTime);
    
    // Only show image/time info when TV is on
    let imageTimeHtml = '';
    if (tv.isOn) {
      // Build parts without any extra whitespace
      const imagePart = '<span class="pill-image">' + escapeHtml(truncatedName) + '</span>';
      const timePart = shuffleTimeLeft ? ' <span class="pill-shuffle-time">' + escapeHtml(shuffleTimeLeft) + '</span>' : '';
      imageTimeHtml = ' (' + imagePart + timePart + ')';
    }
    
    const tvNamePart = '<span class="pill-tv-name">' + escapeHtml(tv.tvName) + '</span>';
    const tagsetPart = '<span class="pill-tagset">' + escapeHtml(tv.activeTagset) + '</span>';
    const pillContent = tvNamePart + ': ' + tagsetPart + imageTimeHtml;
    
    return '<div class="tv-status-dot ' + statusClass + '" data-tv-id="' + tv.tvId + '" data-filename="' + (tv.currentImage || '') + '" title="' + tv.tvName + '"><div class="tv-status-pill">' + pillContent + '</div></div>';
  }).join('');
  
  // Mobile: bars with text always visible (same format as desktop pill)
  const barsHtml = tvStatus.map(tv => {
    const displayName = tv.currentImage ? getDisplayName(tv.currentImage) : 'None';
    const truncatedName = displayName.length > 20 ? displayName.substring(0, 19) + '…' : displayName;
    const statusClass = tv.hasOverride ? 'override' : (tv.isOn ? 'on' : 'off');
    // Format time until next shuffle (null if none scheduled or passed)
    const shuffleTimeLeft = formatTimeUntilShuffle(tv.nextShuffleTime);
    
    // Only show image/time info when TV is on
    let imageTimeHtml = '';
    if (tv.isOn) {
      // Build parts without any extra whitespace
      const imagePart = '<span class="bar-image">' + escapeHtml(truncatedName) + '</span>';
      const timePart = shuffleTimeLeft ? ' <span class="bar-shuffle-time">' + escapeHtml(shuffleTimeLeft) + '</span>' : '';
      imageTimeHtml = ' (' + imagePart + timePart + ')';
    }
    
    const tvNamePart = '<span class="bar-tv-name">' + escapeHtml(tv.tvName) + '</span>';
    const tagsetPart = '<span class="bar-tagset">' + escapeHtml(tv.activeTagset) + '</span>';
    const barContent = tvNamePart + ': ' + tagsetPart + imageTimeHtml;
    
    return '<div class="tv-status-bar ' + statusClass + '" data-tv-id="' + tv.tvId + '" data-filename="' + (tv.currentImage || '') + '">' + barContent + '</div>';
  }).join('');
  
  if (desktopContainer) desktopContainer.innerHTML = dotsHtml;
  if (mobileContainer) mobileContainer.innerHTML = barsHtml;
  
  // Add click listeners for desktop dots
  document.querySelectorAll('.tv-status-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      const filename = dot.dataset.filename;
      if (filename && allImages[filename]) {
        openImageModal(filename);
      } else if (filename) {
        showToast('Image not found in library');
      }
    });
  });
  
  // Add click listeners for mobile bars
  document.querySelectorAll('.tv-status-bar').forEach(bar => {
    bar.addEventListener('click', (e) => {
      const filename = bar.dataset.filename;
      if (filename && allImages[filename]) {
        openImageModal(filename);
      } else if (filename) {
        showToast('Image not found in library');
      }
    });
  });
}

/**
 * Check if an aspect ratio is approximately 16:9
 * Uses same tolerance as badge display (~1.78 ± 0.05)
 */
function isAspectRatio16x9(aspectRatio) {
  if (!aspectRatio) return false;
  return Math.abs(aspectRatio - 1.78) < 0.05;
}

/**
 * Count landscape images that are NOT 16:9 aspect ratio
 */
function countNon169Images() {
  let count = 0;
  for (const [filename, data] of Object.entries(allImages)) {
    // Only count landscape images (not portrait) that are not 16:9
    if (!isPortrait(data.aspectRatio) && !isAspectRatio16x9(data.aspectRatio)) {
      count++;
    }
  }
  return count;
}

/**
 * Check if an image is portrait orientation (height > width)
 */
function isPortrait(aspectRatio) {
  return aspectRatio && aspectRatio < 1.0;
}

/**
 * Count images that are portrait orientation
 */
function countPortraitImages() {
  let count = 0;
  for (const [filename, data] of Object.entries(allImages)) {
    if (isPortrait(data.aspectRatio)) {
      count++;
    }
  }
  return count;
}

/**
 * Check if a file might be a duplicate of existing images
 * @param {File} file - The file to check
 * @returns {Promise<{duplicates: string[]}>}
 */
async function checkForDuplicates(file) {
  try {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch(`${API_BASE}/images/check-duplicate`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error('Duplicate check failed');
    }

    return await response.json();
  } catch (error) {
    console.warn('Duplicate check error:', error);
    return { duplicates: [] };
  }
}

/**
 * Show duplicate warning in upload form
 * @param {string[]} duplicates - Array of duplicate filenames
 */
function showDuplicateWarning(duplicates) {
  const warningEl = document.getElementById('duplicate-warning');
  if (!warningEl) return;

  if (!duplicates || duplicates.length === 0) {
    warningEl.classList.add('hidden');
    warningEl.innerHTML = '';
    return;
  }

  // Build thumbnails for each duplicate
  const thumbsHtml = duplicates.map(filename => 
    `<div class="dupe-thumb-item">
      <img src="thumbs/thumb_${encodeURIComponent(filename)}" alt="${escapeHtml(filename)}" onerror="this.style.display='none'">
      <span class="dupe-thumb-name">${escapeHtml(filename)}</span>
    </div>`
  ).join('');

  warningEl.innerHTML = `
    <div class="dupe-warning-text">⚠️ This image is potentially a duplicate of:</div>
    <div class="dupe-thumbs">${thumbsHtml}</div>
  `;
  warningEl.classList.remove('hidden');
}

/**
 * Fetch all similar image groups from server (higher threshold than duplicates)
 * @param {number} threshold - Optional threshold override
 */
async function fetchSimilarGroups(threshold = similarThreshold) {
  try {
    const response = await fetch(`${API_BASE}/images/similar?threshold=${threshold}`);
    if (!response.ok) throw new Error('Failed to fetch similar images');
    const data = await response.json();
    similarGroups = data.groups || [];
    similarDistances = data.distances || {};
    return similarGroups;
  } catch (error) {
    console.error('Error fetching similar groups:', error);
    similarGroups = [];
    similarDistances = {};
    return [];
  }
}

/**
 * Fetch threshold breakpoints for the slider ticks
 */
async function fetchSimilarBreakpoints() {
  try {
    const response = await fetch(`${API_BASE}/images/similar/breakpoints`);
    if (!response.ok) throw new Error('Failed to fetch breakpoints');
    const data = await response.json();
    similarBreakpoints = data.breakpoints || [];
    return similarBreakpoints;
  } catch (error) {
    console.error('Error fetching similar breakpoints:', error);
    similarBreakpoints = [];
    return [];
  }
}

/**
 * Get set of filenames that are similar images
 */
function getSimilarFilenames() {
  const filenames = new Set();
  for (const group of similarGroups) {
    for (const filename of group) {
      filenames.add(filename);
    }
  }
  return filenames;
}

/**
 * Get counts for duplicates (threshold<=10) and similar (threshold<=38) from breakpoints
 * Breakpoints are sorted by threshold ascending, each has totalImages at that threshold
 * @returns {{ dupeCount: number, simCount: number }}
 */
function getSimilarBreakpointCounts() {
  if (!similarBreakpoints || similarBreakpoints.length === 0) {
    return { dupeCount: 0, simCount: 0 };
  }
  
  let dupeCount = 0;
  let totalAt38 = 0;
  
  // Find the highest totalImages at or below each threshold
  for (const bp of similarBreakpoints) {
    if (bp.threshold <= 10) {
      dupeCount = bp.totalImages || 0;
    }
    if (bp.threshold <= 38) {
      totalAt38 = bp.totalImages || 0;
    }
  }
  
  // simCount is images that are similar but not duplicates
  const simCount = totalAt38 - dupeCount;
  return { dupeCount, simCount: Math.max(0, simCount) };
}

const ADVANCED_TAB_DEFAULT = 'tags';
const VALID_ADVANCED_TABS = new Set(['tags', 'custom-data', 'web-sources', 'recency', 'settings', 'metadata', 'sync']);

function normalizeEditingFilterName(name) {
  if (!name) return 'none';
  const key = String(name).toLowerCase();
  const mapped = FILTER_ALIASES[key] || key;
  return AVAILABLE_FILTERS.has(mapped) ? mapped : 'none';
}

let editState = createDefaultEditState();
let editControls = null;
let cropInteraction = null;

function detectNavigationContext() {
  const defaultType = 'navigate';
  let detectedType = defaultType;

  try {
    if (typeof performance !== 'undefined') {
      if (typeof performance.getEntriesByType === 'function') {
        const entries = performance.getEntriesByType('navigation');
        if (entries && entries.length > 0) {
          detectedType = entries[0]?.type || defaultType;
        }
      } else if (performance.navigation) {
        switch (performance.navigation.type) {
          case performance.navigation.TYPE_RELOAD:
            detectedType = 'reload';
            break;
          case performance.navigation.TYPE_BACK_FORWARD:
            detectedType = 'back_forward';
            break;
          case performance.navigation.TYPE_NAVIGATE:
            detectedType = 'navigate';
            break;
          default:
            detectedType = defaultType;
            break;
        }
      }
    }
  } catch (error) {
    console.warn('Navigation context detection failed:', error);
  }

  if (!['navigate', 'reload', 'back_forward', 'prerender'].includes(detectedType)) {
    detectedType = defaultType;
  }

  return {
    navigationType: detectedType,
    isReloadNavigation: detectedType === 'reload',
    isBackForwardNavigation: detectedType === 'back_forward',
    isFirstLoadInTab: detectedType === 'navigate'
  };
}

// Hash-based routing
function handleRoute() {
  const hash = window.location.hash.slice(1) || '/'; // Remove '#' and default to '/'
  const [path, queryString] = hash.split('?');
  const params = new URLSearchParams(queryString || '');
  
  if (path.startsWith('/advanced')) {
    const parts = path.split('/');
    const requestedTab = parts[2] || ADVANCED_TAB_DEFAULT; // /advanced/sync -> 'sync'
    // Redirect old analytics URL to new location
    if (requestedTab === 'analytics') {
      navigateTo('/analytics');
      return;
    }
    const subTab = VALID_ADVANCED_TABS.has(requestedTab) ? requestedTab : ADVANCED_TAB_DEFAULT;
    switchToTab('advanced');
    switchToAdvancedSubTab(subTab);
  } else if (path === '/analytics') {
    switchToTab('analytics');
    const imageParam = params.get('image');
    loadAnalytics(imageParam);
  } else if (path === '/upload') {
    switchToTab('upload');
  } else {
    // Default to gallery
    switchToTab('gallery');
  }
}

function navigateTo(path) {
  window.location.hash = '#' + path;
  // handleRoute will be called automatically by hashchange event
}

function switchToAdvancedSubTab(tabName) {
  const requested = typeof tabName === 'string' ? tabName.trim().toLowerCase() : '';
  const targetTab = VALID_ADVANCED_TABS.has(requested) ? requested : ADVANCED_TAB_DEFAULT;

  document.querySelectorAll('.advanced-tab-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === targetTab);
  });

  document.querySelectorAll('.advanced-tab-content').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `advanced-${targetTab}-content`);
  });

  if (targetTab === 'sync') {
    setTimeout(() => {
      loadSyncStatus();
      loadSyncLogs();
    }, 0);
  } else if (targetTab === 'metadata') {
    loadMetadata();
  } else if (targetTab === 'tags') {
    loadTagsTab();
  } else if (targetTab === 'custom-data') {
    loadCustomDataTab();
  } else if (targetTab === 'web-sources') {
    loadWebSourcesTab();
  } else if (targetTab === 'recency') {
    loadRecencyTab();
  }
}

// Debug flag: force the tag filter dropdown to always be visible
let DEBUG_ALWAYS_SHOW_TAG_DROPDOWN = false;

// Dropdown portal state for reliable visibility/positioning
const tagDropdownState = {
  isOpen: false,
  originalParent: null,
  originalNextSibling: null,
  resizeHandler: null,
  scrollHandler: null,
};

function getTagFilterElements() {
  return {
    btn: document.getElementById('tag-filter-btn'),
    dropdown: document.getElementById('tag-filter-dropdown'),
    text: document.getElementById('tag-filter-text')
  };
}

function positionTagDropdownToButton() {
  const { btn, dropdown } = getTagFilterElements();
  if (!btn || !dropdown) return;
  // Ensure it's visible to measure size
  dropdown.style.visibility = 'hidden';
  dropdown.style.display = 'block';
  // Use fixed positioning relative to viewport
  dropdown.style.position = 'fixed';
  const rect = btn.getBoundingClientRect();
  // Minimum width matches the button
  dropdown.style.minWidth = `${Math.max(rect.width, 150)}px`;
  const dropdownWidth = dropdown.offsetWidth;
  const margin = 6; // small gap below the button
  // Align the dropdown's right edge with the button's right edge
  let left = rect.right - dropdownWidth;
  let top = rect.bottom + margin;
  // Prevent overflow to the right
  if (left + dropdownWidth > window.innerWidth - 8) {
    const targetRight = Math.min(rect.right, window.innerWidth - 8);
    left = targetRight - dropdownWidth;
  }
  // Prevent overflow to the left
  if (left < 8) left = 8;
  // Prevent overflow to the bottom
  const dropdownHeight = dropdown.offsetHeight;
  if (top + dropdownHeight > window.innerHeight - 8) {
    // Try placing above the button
    const aboveTop = rect.top - dropdownHeight - margin;
    if (aboveTop >= 8) {
      top = aboveTop;
    } else {
      // Clamp to viewport and let it scroll internally
      top = Math.max(8, window.innerHeight - dropdownHeight - 8);
    }
  }
  dropdown.style.left = `${left}px`;
  dropdown.style.top = `${top}px`;
  dropdown.style.visibility = 'visible';
}

function openTagDropdownPortal() {
  const { btn, dropdown } = getTagFilterElements();
  if (!btn || !dropdown) return;
  if (tagDropdownState.isOpen) return;

  // Save original placement
  tagDropdownState.originalParent = dropdown.parentNode;
  tagDropdownState.originalNextSibling = dropdown.nextSibling;

  // Remove any existing shield first
  const existingShield = document.getElementById('dropdown-click-shield');
  if (existingShield) existingShield.remove();
  
  // Create fresh click shield to catch outside clicks without triggering elements underneath
  const shield = document.createElement('div');
  shield.id = 'dropdown-click-shield';
  shield.className = 'dropdown-click-shield';
  
  // Absorb all touch events to prevent them reaching cards underneath
  shield.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  shield.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Close on touchend instead of touchstart, so shield absorbs the full touch sequence
    closeTagDropdownPortal();
  }, { passive: false });
  shield.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  // Also handle click for mouse/desktop
  shield.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeTagDropdownPortal();
  });
  document.body.appendChild(shield);

  // Disable hover effects on gallery cards while dropdown is open
  document.body.classList.add('dropdown-open');

  // Move to body and show
  document.body.appendChild(dropdown);
  dropdown.classList.add('active');
  dropdown.classList.remove('debug-visible');
  dropdown.style.display = 'block';
  dropdown.style.pointerEvents = 'auto'; // Re-enable clicks when open
  dropdown.style.zIndex = '9999';
  dropdown.style.right = 'auto';
  positionTagDropdownToButton();

  // Mark button active
  btn.classList.add('active');
  btn.setAttribute('aria-expanded', 'true');
  dropdown.setAttribute('aria-hidden', 'false');

  // Ensure options exist on first open
  const optionsContainer = dropdown.querySelector('.multiselect-options');
  if (optionsContainer && optionsContainer.children.length === 0) {
    try { void loadTagsForFilter(); } catch {}
  }

  // Reposition on resize/scroll while open (but ignore scroll events from within the dropdown)
  tagDropdownState.resizeHandler = () => positionTagDropdownToButton();
  tagDropdownState.scrollHandler = (e) => {
    // Don't reposition if scrolling inside the dropdown itself
    if (dropdown.contains(e.target)) return;
    positionTagDropdownToButton();
  };
  window.addEventListener('resize', tagDropdownState.resizeHandler);
  window.addEventListener('scroll', tagDropdownState.scrollHandler, true);

  tagDropdownState.isOpen = true;
}

function closeTagDropdownPortal() {
  const { btn, dropdown } = getTagFilterElements();
  
  // Remove click shield and re-enable hover effects
  const shield = document.getElementById('dropdown-click-shield');
  if (shield) shield.remove();
  // Delay removing dropdown-open class to ensure hover suppression stays active through touch end
  setTimeout(() => document.body.classList.remove('dropdown-open'), 300);
  
  if (!dropdown || !tagDropdownState.isOpen) {
    // Also ensure inline display is off even if we think it's closed
    if (dropdown) {
      dropdown.classList.remove('active');
      dropdown.style.display = 'none';
      dropdown.style.pointerEvents = 'none'; // Ensure it can't intercept clicks
      dropdown.setAttribute('aria-hidden', 'true');
    }
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  // Hide and restore to original parent
  dropdown.classList.remove('active');
  dropdown.style.display = 'none';
  dropdown.style.pointerEvents = 'none'; // Ensure it can't intercept clicks when closed
  dropdown.style.position = '';
  dropdown.style.left = '';
  dropdown.style.top = '';
  dropdown.style.minWidth = '';
  dropdown.style.right = '';
  dropdown.style.zIndex = ''; // Reset z-index

  if (tagDropdownState.originalParent) {
    if (tagDropdownState.originalNextSibling && tagDropdownState.originalNextSibling.parentNode === tagDropdownState.originalParent) {
      tagDropdownState.originalParent.insertBefore(dropdown, tagDropdownState.originalNextSibling);
    } else {
      tagDropdownState.originalParent.appendChild(dropdown);
    }
  }

  // Button state
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
  dropdown.setAttribute('aria-hidden', 'true');

  // Remove handlers
  if (tagDropdownState.resizeHandler) {
    window.removeEventListener('resize', tagDropdownState.resizeHandler);
    tagDropdownState.resizeHandler = null;
  }
  if (tagDropdownState.scrollHandler) {
    window.removeEventListener('scroll', tagDropdownState.scrollHandler, true);
    tagDropdownState.scrollHandler = null;
  }

  tagDropdownState.isOpen = false;
}

const UUID_SUFFIX_PATTERN = /-[0-9a-f]{8}$/i;

function extractBaseComponents(fn) {
  const lastDotIndex = fn.lastIndexOf('.');
  if (lastDotIndex <= 0) {
    return {
      base: fn,
      ext: '',
      hasUuid: false
    };
  }

  const ext = fn.substring(lastDotIndex);
  const nameWithoutExt = fn.substring(0, lastDotIndex);

  if (UUID_SUFFIX_PATTERN.test(nameWithoutExt)) {
    return {
      base: nameWithoutExt.substring(0, nameWithoutExt.lastIndexOf('-')),
      ext,
      hasUuid: true
    };
  }

  return {
    base: nameWithoutExt,
    ext,
    hasUuid: false
  };
}

// Helper function to get display name without UUID
function getDisplayName(filename) {
  const { base, hasUuid } = extractBaseComponents(filename);
  if (!hasUuid) {
    return filename;
  }

  const allFilenames = Object.keys(allImages);
  const sharedBaseCount = allFilenames.filter(fn => {
    const parsed = extractBaseComponents(fn);
    return parsed.base === base;
  }).length;

  if (sharedBaseCount > 1) {
    return filename;
  }

  return base;
}

// Helper function to get similar images for a filename (excluding itself)
// Returns array of {filename, distance} objects with actual pairwise distances
function getSimilarImagesForFile(filename) {
  if (!similarFilterActive || similarGroups.length === 0) return [];
  
  // Find the group containing this filename
  const group = similarGroups.find(g => g.includes(filename));
  if (!group) return [];
  
  // Return other images in the group with their pairwise distances to this file
  return group
    .filter(other => other !== filename)
    .map(other => {
      // Look up distance using canonical key (alphabetically sorted)
      const key = filename < other ? `${filename}|${other}` : `${other}|${filename}`;
      const distance = similarDistances[key] || 0;
      return { filename: other, distance };
    })
    .sort((a, b) => a.distance - b.distance); // Sort by distance
}

// Helper function to format date
function formatDate(dateString) {
  if (!dateString) return '';
  
  const date = new Date(dateString);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  
  return `${month} ${day}, ${year}`;
}

// Short date format for mobile: m/d/yy
function formatDateShort(dateString) {
  if (!dateString) return '';
  
  const date = new Date(dateString);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = String(date.getFullYear()).slice(-2);
  
  return `${month}/${day}/${year}`;
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  loadLibraryPath();
  initCloudSyncButton(); // Initialize cloud sync button in toolbar - BEFORE checking sync
  
  const sortOrderSelect = document.getElementById('sort-order');
  if (sortOrderSelect) {
    sortOrderSelect.value = initialSortOrderPreference;
  }

  updateSortDirectionIcon();
  saveSortPreference(sortOrderSelect ? sortOrderSelect.value : initialSortOrderPreference, sortAscending);

  // Set up hash-based routing
  window.addEventListener('hashchange', handleRoute);
  window.addEventListener('load', handleRoute);
  
  // Load UI first so user can start working immediately
  loadGallery();
  loadTags();
  loadAttributes();
  loadEntities();
  loadTVs();
  loadWebSourcesConfig();
  initUploadForm();
  initBatchUploadForm(); // Initialize batch upload
  initModal();
  initMetadataViewer();
  initSyncDetail();
  initBulkActions();
  initSettingsNavigation();
  initUploadNavigation();
  initTvModal();
  initGalleryInfiniteScroll(); // Initialize infinite scroll for gallery
  initTagsetModalListeners(); // Initialize tagset modal event listeners
  initWebSourceSettingsModal(); // Initialize web source settings modal
  initVirtualTagModal(); // Initialize virtual tag modal
  
  // Pre-fetch similar groups for filter counts
  fetchSimilarGroups();
  fetchSimilarBreakpoints();
  
  // Pre-fetch recently displayed for filter counts
  fetchRecentlyDisplayed();
  
  // Handle initial route
  handleRoute();
  
  // Check for sync updates in the background (after UI is loaded)
  checkSyncOnLoad();
  
  // Load analytics data in background for gallery "last display" info
  loadAnalyticsDataForGallery();
  
  // Start polling for TV status updates (every 10 seconds)
  // This keeps the TV bubbles current with screen state, shuffle times, etc.
  startTVStatusPolling();
  
  // Start countdown timer for shuffle time display (every second)
  startShuffleCountdownTimer();
});

// Check for sync updates on page load
async function checkSyncOnLoad() {
  // Check if sync is already in progress
  if (isSyncInProgress) {
    console.log('Sync already in progress, skipping load check...');
    return;
  }
  
  try {
    isSyncInProgress = true; // Mark as in progress
    
    // Show checking state
    updateSyncButtonState('syncing', 'Syncing...', null, null, null);
    
    console.log('Checking for cloud updates...');
    const response = await fetch(`${API_BASE}/sync/check`);
    const data = await response.json();
    
    if (data.success && (data.pulledChanges || data.autoResolvedConflict)) {
      console.log(`✅ ${data.message}`);
      if (data.autoResolvedConflict) {
        alertLostLocalChanges(data.lostChangesSummary);
      }
      // Release lock before fetching new data
      isSyncInProgress = false;
      await refreshGalleryAfterSync(data);
      await loadTags();
      await updateSyncStatus();
      await loadSyncLogs();
      return; // Skip the finally block since we already released
    } else if (data.skipped) {
      console.log(`⚠️ Sync skipped: ${data.reason}`);
      // There are uncommitted local changes - auto-push them
      console.log('Auto-pushing local changes...');
      isSyncInProgress = false; // Clear before calling autoPush (it sets its own flag)
      await autoPushLocalChanges();
      return; // autoPushLocalChanges will clear the flag
    } else if (!data.success && data.error) {
      console.warn(`⚠️ Sync check failed: ${data.error}`);
      updateSyncButtonState('error', 'Error', null, null, data.error);
    } else {
  console.log('✅ Already up to date');
  // We're synced - release lock before checking for local changes
  isSyncInProgress = false;
  // Check if there are local changes
  await updateSyncStatus();
  return; // Skip the finally block since we already released
    }
  } catch (error) {
    console.error('Error checking sync on load:', error);
    // Fail silently - don't block page load if sync check fails
    updateSyncButtonState('error', 'Error', null, null, error.message);
    await loadSyncLogs();
  } finally {
    isSyncInProgress = false; // Always clear flag
  }
}

// Auto-push local changes on page load
async function autoPushLocalChanges() {
  const callId = Math.random().toString(36).substring(7);
  console.log(`\n🟦 [FE-${callId}] autoPushLocalChanges() called`);
  
  // Check if sync is already in progress
  if (isSyncInProgress) {
    console.log(`⏸️  [FE-${callId}] Sync already in progress (frontend lock), skipping...`);
    return;
  }
  
  try {
    isSyncInProgress = true; // Mark as in progress
    console.log(`🔒 [FE-${callId}] Frontend lock acquired`);
    console.log(`📡 [FE-${callId}] Calling /api/sync/full...`);
    
    // Use atomic full sync endpoint (same as manual sync)
    const syncResponse = await fetch(`${API_BASE}/sync/full`, {
      method: 'POST'
    });
    
    console.log(`📨 [FE-${callId}] Response status: ${syncResponse.status}`);
    const syncData = await syncResponse.json();
    console.log(`📦 [FE-${callId}] Response data:`, syncData);
    
    if (syncData.success) {
      console.log(`✅ [FE-${callId}] Auto-sync successful:`, syncData.message);
      if (syncData.autoResolvedConflict) {
        alertLostLocalChanges(syncData.lostChangesSummary);
      }
      await refreshGalleryAfterSync(syncData);
      await loadTags();
      // Update status to show we're synced
      await updateSyncStatus();
      await loadSyncLogs();
    } else {
      const validationDetails = formatValidationErrors(syncData.validationErrors);

      if (validationDetails) {
        const message = `Uploaded files failed validation and were removed.\n\n${validationDetails}`;
        console.error(`❌ [FE-${callId}] Auto-sync validation failure:`, syncData.validationErrors);
        alert(message);
        updateSyncButtonState('error', 'Error', null, null, message);
      } else {
        console.error(`❌ [FE-${callId}] Auto-sync failed:`, syncData.error);
        updateSyncButtonState('error', 'Error', null, null, syncData.error);
      }
      // Fetch the current sync status to show proper badge/tooltip
      await updateSyncStatus();
      await loadSyncLogs();
    }
  } catch (error) {
    console.error(`💥 [FE-${callId}] Error during auto-sync:`, error);
    // Fetch the current sync status to show proper badge/tooltip
    await updateSyncStatus();
    await loadSyncLogs();
  } finally {
    console.log(`🔓 [FE-${callId}] Frontend lock released\n`);
    isSyncInProgress = false; // Always clear flag
  }
}

// Update sync button status
async function updateSyncStatus() {
  // Don't update status if sync is in progress - let the sync operation control the button state
  if (isSyncInProgress) {
    console.log('⏸️  Skipping status update - sync in progress');
    return;
  }
  
  console.log('🔍 updateSyncStatus() called');
  
  try {
    const response = await fetch(`${API_BASE}/sync/status`);
    const data = await response.json();
    
    console.log('📊 Sync status response:', data);
    
    if (!data.success) {
      console.error('❌ Sync status check failed');
      updateSyncButtonState('error', 'Error', null, null, null);
      return;
    }

    if (data.syncDisabled) {
      const controlSync = document.querySelector('.control-sync');
      if (controlSync) controlSync.style.display = 'none';
      return;
    }

    // Ensure the button is visible (in case sync was previously disabled)
    const controlSync = document.querySelector('.control-sync');
    if (controlSync) controlSync.style.display = '';

    const status = data.status;

    // Determine state based on status
    if (status.hasChanges) {
      console.log('⚠️  Has changes - setting unsynced state');
      updateSyncButtonState('unsynced', 'Unsynced', status, null, null);
    } else {
      console.log('✅ No changes - setting synced state');
      updateSyncButtonState('synced', 'Synced', null, null, null);
    }
    
  } catch (error) {
    console.error('Error updating sync status:', error);
    updateSyncButtonState('error', 'Error', null, null, error.message);
  }
}

// Update sync button visual state
function updateSyncButtonState(state, text, syncStatus, _unused, errorMessage) {
  console.log(`🎨 updateSyncButtonState() called with state: ${state}, text: ${text}`);
  
  const syncBtn = document.getElementById('sync-btn');
  const syncIcon = document.getElementById('sync-icon');
  const syncText = document.getElementById('sync-text');
  const syncBadge = document.getElementById('sync-badge');
  
  if (!syncBtn) {
    console.error('❌ Sync button element not found!');
    return;
  }
  
  // Remove all state classes
  syncBtn.classList.remove('synced', 'syncing', 'unsynced', 'error');
  
  // Add current state class
  syncBtn.classList.add(state);
  
  // Set icon based on state
  const icons = {
    synced: '✅',
    syncing: '🔄',
    unsynced: '⚠️',
    error: '❌'
  };
  syncIcon.textContent = icons[state] || '☁️';
  
  // Set text label
  if (syncText) {
    syncText.textContent = text;
  }
  
  // Update badge with up/down triangle format
  if (state === 'unsynced' && syncStatus) {
    const uploadCount = syncStatus.upload.count;
    const downloadCount = syncStatus.download.count;
    
    let badgeText = '';
    if (uploadCount > 0 && downloadCount > 0) {
      badgeText = `${uploadCount}▲/${downloadCount}▼`;
    } else if (uploadCount > 0) {
      badgeText = `${uploadCount}▲`;
    } else if (downloadCount > 0) {
      badgeText = `${downloadCount}▼`;
    }
    
    if (badgeText) {
      syncBadge.textContent = badgeText;
      syncBadge.style.display = 'block';
    } else {
      syncBadge.style.display = 'none';
    }
  } else {
    syncBadge.style.display = 'none';
  }
  
  // Update tooltip
  let tooltip;
  
  if (state === 'synced') {
    tooltip = libraryPath 
      ? `Frame Art Gallery is synced to cloud Git LFS repo at ${libraryPath}`
      : 'All changes synced to cloud';
  } else if (state === 'unsynced' && syncStatus) {
    // Build multi-line tooltip
    const lines = [];
    
    // Upload changes
    if (syncStatus.upload.newImages > 0) {
      const plural = syncStatus.upload.newImages !== 1 ? 's' : '';
      lines.push(`${syncStatus.upload.newImages} new image${plural} to upload`);
    }
    // Combine modifications and renames
    const uploadModCount = (syncStatus.upload.modifiedImages || 0) + (syncStatus.upload.renamedImages || 0);
    if (uploadModCount > 0) {
      const text = uploadModCount === 1 ? 'image modification' : 'image modifications';
      lines.push(`${uploadModCount} ${text} to upload`);
    }
    if (syncStatus.upload.deletedImages > 0) {
      const count = syncStatus.upload.deletedImages;
      const text = count === 1 ? 'image deletion' : 'image deletions';
      lines.push(`${count} ${text} to upload`);
    }
    
    // Download changes
    if (syncStatus.download.newImages > 0) {
      const plural = syncStatus.download.newImages !== 1 ? 's' : '';
      lines.push(`${syncStatus.download.newImages} new image${plural} to download`);
    }
    // Combine modifications and renames
    const downloadModCount = (syncStatus.download.modifiedImages || 0) + (syncStatus.download.renamedImages || 0);
    if (downloadModCount > 0) {
      const text = downloadModCount === 1 ? 'image modification' : 'image modifications';
      lines.push(`${downloadModCount} ${text} to download`);
    }
    if (syncStatus.download.deletedImages > 0) {
      const count = syncStatus.download.deletedImages;
      const text = count === 1 ? 'image deletion' : 'image deletions';
      lines.push(`${count} ${text} to download`);
    }
    
    // Add blank line before "Click to sync" if there are any changes
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Click to sync');
    tooltip = lines.join('\n');
  } else if (state === 'error' && errorMessage) {
    // Show the actual error in the tooltip
    tooltip = `Sync error: ${errorMessage}. Click to retry.`;
  } else {
    const tooltips = {
      syncing: 'Syncing with cloud...',
      unsynced: 'Changes not synced - click to sync',
      error: 'Sync error - click to retry'
    };
    tooltip = tooltips[state] || 'Sync with cloud';
  }
  
  syncBtn.title = tooltip;
  
  // Disable button when syncing
  syncBtn.disabled = (state === 'syncing');
}

// Initialize cloud sync button (toolbar)
function initCloudSyncButton() {
  const syncBtn = document.getElementById('sync-btn');
  if (!syncBtn) {
    console.warn('Cloud sync button not found - skipping initialization');
    return;
  }
  
  syncBtn.addEventListener('click', async () => {
    await manualSync();
  });
}

function alertLostLocalChanges(lostChangesSummary) {
  const lines = Array.isArray(lostChangesSummary) && lostChangesSummary.length > 0
    ? lostChangesSummary
    : ['Local changes were discarded in favor of the cloud version.'];
  const message = ['Sync completed using the cloud version.', 'Local changes were discarded:', '']
    .concat(lines)
    .join('\n');
  alert(message);
}

function formatValidationErrors(validationErrors) {
  if (!Array.isArray(validationErrors) || validationErrors.length === 0) {
    return null;
  }

  return validationErrors
    .map(err => {
      const file = err?.file || 'Unknown file';
      const reason = err?.reason || 'Unknown reason';
      return `• ${file}: ${reason}`;
    })
    .join('\n');
}

function hasRemoteNewImages(syncData) {
  if (!syncData) return false;
  const summaries = [];

  if (Array.isArray(syncData.remoteChangesSummary)) {
    summaries.push(...syncData.remoteChangesSummary);
  }

  if (Array.isArray(syncData.remoteChanges)) {
    summaries.push(...syncData.remoteChanges);
  }

  return summaries.some(entry => typeof entry === 'string' && /remote added image/i.test(entry));
}

function setGallerySortToNewestFirst() {
  sortAscending = false;
  const sortOrderSelect = document.getElementById('sort-order');
  let changeDispatched = false;

  if (sortOrderSelect) {
    if (sortOrderSelect.value !== 'date') {
      sortOrderSelect.value = 'date';
      const changeEvent = new Event('change', { bubbles: true });
      sortOrderSelect.dispatchEvent(changeEvent);
      changeDispatched = true;
    }
  }

  updateSortDirectionIcon();

  if (!changeDispatched) {
    renderGallery();
  }

  const orderValue = sortOrderSelect ? sortOrderSelect.value : 'date';
  saveSortPreference(orderValue, sortAscending);
}

async function refreshGalleryAfterSync(syncData) {
  const hadGalleryBefore = galleryHasLoadedAtLeastOnce;
  const previousKeys = new Set(Object.keys(allImages || {}));
  await loadGallery();
  const currentKeys = Object.keys(allImages || {});
  const addedKeys = currentKeys.filter(key => !previousKeys.has(key));

  const hasNewImagesFromRemote = hasRemoteNewImages(syncData);
  if ((hadGalleryBefore && addedKeys.length > 0) || hasNewImagesFromRemote) {
    setGallerySortToNewestFirst();
  }

  return addedKeys;
}

// Manual sync (commit, pull, then push)
async function manualSync() {
  const callId = Math.random().toString(36).substring(7);
  console.log(`\n🟩 [FE-${callId}] manualSync() called (user clicked sync button)`);
  
  // Check if sync is already in progress
  if (isSyncInProgress) {
    console.log(`⏸️  [FE-${callId}] Sync already in progress (frontend lock), skipping...`);
    return;
  }
  
  try {
    // Mark sync as in progress
    isSyncInProgress = true;
    console.log(`🔒 [FE-${callId}] Frontend lock acquired`);
    
    // Set syncing state
    updateSyncButtonState('syncing', 'Syncing...', null, null, null);
    
    console.log(`📡 [FE-${callId}] Calling /api/sync/full...`);
    
    // Use the atomic full sync endpoint (commit → pull → push in one transaction)
    const syncResponse = await fetch(`${API_BASE}/sync/full`, {
      method: 'POST'
    });
    
    console.log(`📨 [FE-${callId}] Response status: ${syncResponse.status}`);
    const syncData = await syncResponse.json();
    console.log(`📦 [FE-${callId}] Response data:`, syncData);
    
    // Check both HTTP status and success flag
    if (!syncResponse.ok || !syncData.success) {
      // Check if another sync is in progress (backend lock)
      if (syncData.syncInProgress) {
        console.log(`⚠️  [FE-${callId}] Backend sync in progress, will retry automatically`);
        updateSyncButtonState('syncing', 'Syncing...', null, null, null);
        isSyncInProgress = false; // Clear frontend flag
        return;
      }
      
      const validationDetails = formatValidationErrors(syncData.validationErrors);

      if (validationDetails) {
        const message = `Uploaded files failed validation and were removed.\n\n${validationDetails}`;
        console.error(`❌ [FE-${callId}] Validation failure:`, syncData.validationErrors);
        alert(message);
        updateSyncButtonState('error', 'Error', null, null, message);
      }
      // Check for conflicts
      else if (syncData.hasConflicts) {
        console.error(`❌ [FE-${callId}] Sync conflict detected:`, syncData.error);
        alert('Git sync conflict detected!\n\nThis requires manual resolution. Please check the Sync Detail tab in Advanced settings.');
        updateSyncButtonState('error', 'Conflict', null, null, syncData.error);
      } else {
        console.error(`❌ [FE-${callId}] Sync failed:`, syncData.error);
        alert(`Sync failed: ${syncData.error}`);
        updateSyncButtonState('error', 'Error', null, null, syncData.error);
      }
      await loadSyncLogs();
      isSyncInProgress = false; // Clear flag
      return;
    }
    
    console.log(`✅ [FE-${callId}] Full sync complete:`, syncData.message);

    if (syncData.autoResolvedConflict) {
      alertLostLocalChanges(syncData.lostChangesSummary);
    }
    
    // Reload gallery to show any new images from pull
    await refreshGalleryAfterSync(syncData);
    await loadTags();
    await loadSyncLogs();
    
    // Release lock before updating status so the status update isn't skipped
    console.log(`🔓 [FE-${callId}] Frontend lock released\n`);
    isSyncInProgress = false; // Clear flag on success
    
    // Update sync status (now that lock is released)
    try {
      await updateSyncStatus();
    } catch (statusError) {
      console.error(`⚠️  [FE-${callId}] Failed to update sync status:`, statusError);
      // Fallback: ensure button is at least set to synced state
      updateSyncButtonState('synced', 'Synced', null, null, null);
    }
    
  } catch (error) {
    console.error(`💥 [FE-${callId}] Error during manual sync:`, error);
    const errorMsg = error.message || 'Network error or server unavailable';
    alert(`Sync error: ${errorMsg}`);
    updateSyncButtonState('error', 'Error', null, null, errorMsg);
    await loadSyncLogs();
    console.log(`🔓 [FE-${callId}] Frontend lock released (error path)\n`);
    isSyncInProgress = false; // Clear flag on exception
  }
}

// Load and display library path
async function loadLibraryPath() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();
    const pathValue = data.frameArtPath || 'Unknown';
    
    // Store globally
    libraryPath = pathValue;
    appEnvironment = data.env || 'development';
    
    // Update advanced tab path display
    const advancedPathElement = document.getElementById('advanced-path-value');
    if (advancedPathElement) {
      advancedPathElement.textContent = pathValue;
    }
  } catch (error) {
    console.error('Error loading library path:', error);
    const advancedPathElement = document.getElementById('advanced-path-value');
    if (advancedPathElement) {
      advancedPathElement.textContent = 'Error loading path';
    }
  }
}

// Tab Navigation (simplified - no actual tabs, just for switchToTab function)
function initTabs() {
  // No tab buttons anymore, but keep function for compatibility
}

// Programmatic tab switching (used by gear/home/add buttons)
function switchToTab(tabName) {
  const tabContents = document.querySelectorAll('.tab-content');

  // Clear active state from all
  tabContents.forEach(content => content.classList.remove('active'));

  // Show target tab content
  const targetContent = document.getElementById(`${tabName}-tab`);
  if (targetContent) {
    targetContent.classList.add('active');
  }

  // Reload data similar to initTabs click behavior
  if (tabName === 'gallery') {
    // Only load gallery if not already loaded - prevents wiping filter state
    if (!galleryHasLoadedAtLeastOnce) {
      loadGallery();
    } else {
      // Sync TV/tagset shortcut checkboxes with current tag filter state before rendering.
      // This prevents stale checkbox state (e.g., a TV whose tagset changed while on the
      // Advanced tab) from causing the gallery to display incorrect results.
      updateTVShortcutStates();
      renderGallery();
    }
  }
  if (tabName === 'advanced') {
    loadLibraryPath();
    loadTags();
    loadMetadata();
  }
  if (tabName === 'upload') {
    // Render suggested tags when entering upload tab
    renderUploadTvTagsHelper();
    renderUploadAppliedTags();
    renderUploadAttributes();
    renderUploadEntities();
  }
}

function initUploadNavigation() {
  const openUploadBtn = document.getElementById('open-upload-btn');
  const goHomeUploadBtn = document.getElementById('go-home-upload-btn');

  if (openUploadBtn) {
    openUploadBtn.addEventListener('click', () => {
      navigateTo('/upload');
    });
  }

  if (goHomeUploadBtn) {
    goHomeUploadBtn.addEventListener('click', () => {
      navigateTo('/');
    });
  }
}

function initSettingsNavigation() {
  const openAdvancedBtn = document.getElementById('open-advanced-btn');
  const openAnalyticsBtn = document.getElementById('open-analytics-btn');
  const goHomeBtn = document.getElementById('go-home-btn');
  const goHomeAnalyticsBtn = document.getElementById('go-home-analytics-btn');

  if (openAdvancedBtn) {
    openAdvancedBtn.addEventListener('click', () => {
      // Close any open dropdowns in the gallery toolbar
      const tagFilterBtn = document.getElementById('tag-filter-btn');
      const tagFilterDropdown = document.getElementById('tag-filter-dropdown');
      tagFilterBtn?.classList.remove('active');
      tagFilterDropdown?.classList.remove('active');
      // Also ensure hidden and portal closed
      closeTagDropdownPortal();
      navigateTo(`/advanced/${ADVANCED_TAB_DEFAULT}`);
    });
  }

  if (openAnalyticsBtn) {
    openAnalyticsBtn.addEventListener('click', () => {
      // Close any open dropdowns in the gallery toolbar
      const tagFilterBtn = document.getElementById('tag-filter-btn');
      const tagFilterDropdown = document.getElementById('tag-filter-dropdown');
      tagFilterBtn?.classList.remove('active');
      tagFilterDropdown?.classList.remove('active');
      closeTagDropdownPortal();
      navigateTo('/analytics');
    });
  }

  if (goHomeBtn) {
    goHomeBtn.addEventListener('click', () => {
      navigateTo('/');
    });
  }

  if (goHomeAnalyticsBtn) {
    goHomeAnalyticsBtn.addEventListener('click', () => {
      navigateTo('/');
    });
  }

  // Initialize advanced sub-tabs
  initAdvancedSubTabs();
  
  // Initialize analytics mobile tabs
  initAnalyticsMobileTabs();
}

function initAdvancedSubTabs() {
  const tabButtons = document.querySelectorAll('.advanced-tab-btn');

  tabButtons.forEach((button) => {
    button.setAttribute('type', 'button');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const requestedTab = typeof button.dataset.tab === 'string' ? button.dataset.tab : '';
      const safeTab = VALID_ADVANCED_TABS.has(requestedTab) ? requestedTab : ADVANCED_TAB_DEFAULT;
      navigateTo(`/advanced/${safeTab}`);
    });
  });
}

function initAnalyticsMobileTabs() {
  const tabButtons = document.querySelectorAll('.analytics-mobile-tab');
  
  tabButtons.forEach((button) => {
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => {
      const targetColumn = button.dataset.column;
      
      // Update tab buttons
      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // Update visibility via data attribute on page content container
      const pageContent = document.querySelector('.analytics-page-content');
      if (pageContent) {
        pageContent.dataset.activeColumn = targetColumn;
      }
    });
  });
}

// Gallery Functions
async function loadGallery() {
  const grid = document.getElementById('image-grid');
  if (!grid) {
    console.warn('Image grid element not found; skipping gallery load.');
    return;
  }

  grid.innerHTML = '<div class="loading">Loading images...</div>';

  try {
    const response = await fetch(`${API_BASE}/images`);
    allImages = await response.json();
    galleryHasLoadedAtLeastOnce = true;

    // Also load tags for filter dropdown
    await loadTagsForFilter();
    
    // Prefetch last displayed times if needed for 'displayed' sort
    const sortOrderSelect = document.getElementById('sort-order');
    const currentSortOrder = sortOrderSelect ? sortOrderSelect.value : initialSortOrderPreference;
    if (currentSortOrder === 'displayed' && lastDisplayedTimes === null) {
      await fetchLastDisplayedTimes();
    }

    renderGallery();
  } catch (error) {
    console.error('Error loading gallery:', error);
    if (grid) {
      grid.innerHTML = '<div class="error">Failed to load images</div>';
    }
  }
}

// Selection Functions

/**
 * Update only the visual selection state of gallery cards without re-rendering.
 * This prevents scroll position reset and flickering when selecting images.
 */
function updateGallerySelectionVisual() {
  const grid = document.getElementById('image-grid');
  if (!grid) return;
  
  const allCards = grid.querySelectorAll('.image-card');
  allCards.forEach(card => {
    const filename = card.dataset.filename;
    if (selectedImages.has(filename)) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
  
  // Update the bulk actions bar
  updateBulkActionsBar(currentFilteredImages.length);
}

function handleImageClick(filename, index, event) {
  event.stopPropagation();
  
  const grid = document.getElementById('image-grid');
  const allCards = Array.from(grid.querySelectorAll('.image-card'));
  
  if (event.shiftKey && lastClickedIndex !== null) {
    // Range selection
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);
    
    for (let i = start; i <= end; i++) {
      const card = allCards[i];
      if (card) {
        selectedImages.add(card.dataset.filename);
      }
    }
  } else if (event.metaKey || event.ctrlKey) {
    // Individual toggle (Cmd/Ctrl + click)
    if (selectedImages.has(filename)) {
      selectedImages.delete(filename);
    } else {
      selectedImages.add(filename);
    }
  } else {
    // Single selection (clear others)
    selectedImages.clear();
    selectedImages.add(filename);
  }
  
  lastClickedIndex = index;
  // Use lightweight visual update instead of full re-render to prevent scroll flickering
  updateGallerySelectionVisual();
}

function updateBulkActionsBar(totalSelectableCount) {
  const bulkActions = document.getElementById('bulk-actions');
  const selectedCount = document.getElementById('selected-count');
  const selectedCountMobile = document.getElementById('selected-count-mobile');
  const selectAllBtn = document.getElementById('select-all-btn');
  
  // Update Select All button with count (use provided count or fallback to total images)
  const count = totalSelectableCount ?? Object.keys(allImages).length;
  
  if (selectAllBtn) {
    const desktopText = selectAllBtn.querySelector('.desktop-text');
    const mobileText = selectAllBtn.querySelector('.mobile-text');
    if (desktopText) desktopText.textContent = `Select All (${count})`;
    if (mobileText) mobileText.innerHTML = `Select<br>All (${count})`;
  }
  
  if (selectedImages.size > 0) {
    bulkActions.classList.add('visible');
    selectedCount.textContent = selectedImages.size;
    if (selectedCountMobile) {
      selectedCountMobile.textContent = selectedImages.size;
    }
  } else {
    bulkActions.classList.remove('visible');
  }
}

function clearSelection() {
  selectedImages.clear();
  lastClickedIndex = null;
  // Use lightweight visual update instead of full re-render to prevent scroll flickering
  updateGallerySelectionVisual();
}

function selectAllImages() {
  // Get all currently visible/filtered images
  const searchInput = document.getElementById('search-input');
  const searchTerm = (searchInput?.value || '').toLowerCase();
  const includedTags = getIncludedTags();
  const excludedTags = getExcludedTags();

  let filteredImages = Object.entries(allImages);

  // Apply same filters as renderGallery
  if (searchTerm) {
    filteredImages = filteredImages.filter(([filename]) => 
      filename.toLowerCase().includes(searchTerm)
    );
  }

  // Filter by included tags
  if (includedTags.length > 0) {
    filteredImages = filteredImages.filter(([_, data]) => 
      data.tags && includedTags.some(tag => data.tags.includes(tag))
    );
  }

  // Filter by excluded tags
  if (excludedTags.length > 0) {
    filteredImages = filteredImages.filter(([_, data]) => {
      const imageTags = data.tags || [];
      return !excludedTags.some(tag => imageTags.includes(tag));
    });
  }

  // Filter for "None" - images not shown on any TV
  const noneCheckbox = document.querySelector('.tv-none-checkbox');
  if (noneCheckbox && noneCheckbox.checked) {
    filteredImages = filteredImages.filter(([_, data]) => {
      const imageTagSet = new Set(data.tags || []);
      
      for (const tv of allTVs) {
        const tvIncludeTags = tv.tags || [];
        const tvExcludeTags = tv.exclude_tags || [];
        
        if (tvIncludeTags.length > 0 && !tvIncludeTags.some(tag => imageTagSet.has(tag))) {
          continue;
        }
        
        if (tvExcludeTags.length > 0 && tvExcludeTags.some(tag => imageTagSet.has(tag))) {
          continue;
        }
        
        return false;
      }
      
      return true;
    });
  }

  // Add all filtered images to selection
  filteredImages.forEach(([filename]) => {
    selectedImages.add(filename);
  });

  renderGallery();
}

function openBulkTagModal() {
  console.log('openBulkTagModal called, selectedImages:', selectedImages);
  const modal = document.getElementById('bulk-tag-modal');
  const countSpan = document.getElementById('bulk-count');
  console.log('modal:', modal, 'countSpan:', countSpan);
  countSpan.textContent = selectedImages.size;
  
  // Calculate tag frequencies across selected images
  const tagCounts = {};
  const selectedArray = Array.from(selectedImages);
  
  selectedArray.forEach(filename => {
    const imageData = allImages[filename];
    const tags = imageData.tags || [];
    tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  // Separate tags into "all" and "some"
  const allTags = [];
  const someTags = [];
  
  Object.entries(tagCounts).forEach(([tag, count]) => {
    if (count === selectedArray.length) {
      allTags.push(tag);
    } else {
      someTags.push(tag);
    }
  });
  
  // Render the tag badges
  renderBulkTagBadges('bulk-all-tags', allTags, false);
  renderBulkTagBadges('bulk-some-tags', someTags, true);
  
  // Render suggested TV tags
  renderBulkTvTagsHelper(allTags);
  
  modal.classList.add('visible');
  console.log('modal classes after add:', modal.className);
}

function renderBulkTagBadges(containerId, tags, isPartial) {
  const container = document.getElementById(containerId);
  
  if (tags.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  container.innerHTML = tags.sort().map(tag => {
    // Get TV info for this tag (same as image modal)
    const tvMatches = getTvMatchesForTag(tag);
    let tooltip = '';
    let tvInfoHtml = '';
    
    if (tvMatches.length > 0) {
      const matchStrings = tvMatches
        .sort((a, b) => a.tvName.localeCompare(b.tvName))
        .map(m => m.isExclude ? `${m.tvName} (exclude)` : m.tvName);
      tooltip = matchStrings.join(', ');
      
      const excludeCount = tvMatches.filter(m => m.isExclude).length;
      const allExclude = excludeCount === tvMatches.length;
      const someExclude = excludeCount > 0 && !allExclude;
      
      let tvLabel;
      let colorClass = '';
      
      if (tvMatches.length === 1) {
        tvLabel = tvMatches[0].isExclude ? `ex:${tvMatches[0].tvName}` : tvMatches[0].tvName;
        if (tvMatches[0].isExclude) colorClass = ' tv-info-exclude';
      } else if (allExclude) {
        tvLabel = `${tvMatches.length} TVs`;
        colorClass = ' tv-info-exclude';
      } else if (someExclude) {
        tvInfoHtml = `<span class="tag-tv-info">${tvMatches.length} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
      } else {
        tvLabel = `${tvMatches.length} TVs`;
      }
      
      if (!tvInfoHtml) {
        if (tvLabel.length > 12) {
          tvLabel = tvLabel.substring(0, 11) + '…';
        }
        tvInfoHtml = `<span class="tag-tv-info${colorClass}">${escapeHtml(tvLabel)}</span>`;
      }
    }
    
    const hasMatchClass = tvMatches.length > 0 ? ' has-tv-match' : '';
    
    // Both tag types are fully clickable - clicking removes the tag
    // For "on all" tags: removes from all selected images
    // For "on some" tags: removes from images that have it
    const clickHandler = `onclick="removeBulkTag('${escapeHtml(tag)}', ${isPartial})"`;
    
    return `
    <div class="tag-item${isPartial ? ' partial' : ''}${hasMatchClass} clickable" ${tooltip ? `title="${escapeHtml(tooltip)}"` : ''} ${clickHandler}>
      <div class="tag-content">
        <span class="tag-name">${escapeHtml(tag)}</span>
        ${tvInfoHtml}
      </div>
      <button class="tag-remove" onclick="event.stopPropagation(); removeBulkTag('${escapeHtml(tag)}', ${isPartial})" title="Remove tag">×</button>
    </div>
  `;
  }).join('');
}

// Render suggested TV tags for bulk modal
// Shows TV tags that are NOT already applied to ALL selected images
function renderBulkTvTagsHelper(allAppliedTags) {
  const container = document.getElementById('bulk-tv-tags-helper');
  const wrapper = document.getElementById('bulk-tv-tags-wrapper');
  if (!container) return;

  const appliedTagsSet = new Set(allAppliedTags);

  // Collect all TV tags - aggregate by tag
  const tvTagsMap = new Map();

  for (const tv of allTVs) {
    const tvName = tv.name || 'Unknown TV';

    // Include tags
    for (const tag of (tv.tags || [])) {
      // Show tag if not applied to ALL selected images
      if (!appliedTagsSet.has(tag)) {
        if (!tvTagsMap.has(tag)) {
          tvTagsMap.set(tag, { includeTvNames: [], excludeTvNames: [] });
        }
        tvTagsMap.get(tag).includeTvNames.push(tvName);
      }
    }

    // Exclude tags
    for (const tag of (tv.exclude_tags || [])) {
      if (!appliedTagsSet.has(tag)) {
        if (!tvTagsMap.has(tag)) {
          tvTagsMap.set(tag, { includeTvNames: [], excludeTvNames: [] });
        }
        tvTagsMap.get(tag).excludeTvNames.push(tvName);
      }
    }
  }

  // Convert to array and sort
  const tvTags = [];
  for (const [tag, data] of tvTagsMap) {
    const totalTvs = data.includeTvNames.length + data.excludeTvNames.length;
    const allExclude = data.includeTvNames.length === 0;
    tvTags.push({
      tag,
      includeTvNames: data.includeTvNames,
      excludeTvNames: data.excludeTvNames,
      totalTvs,
      allExclude
    });
  }

  tvTags.sort((a, b) => {
    if (a.allExclude !== b.allExclude) return a.allExclude ? 1 : -1;
    return a.tag.localeCompare(b.tag);
  });

  // Get all TV tag names for filtering
  const tvTagNames = new Set(tvTags.map(t => t.tag));

  // Get non-TV tags: all tags minus TV tags minus applied tags
  const otherTags = (allTags || [])
    .filter(tag => !tvTagNames.has(tag) && !appliedTagsSet.has(tag))
    .sort();

  if (tvTags.length === 0 && otherTags.length === 0) {
    container.innerHTML = '';
    if (wrapper) wrapper.style.display = 'none';
    return;
  }

  if (wrapper) wrapper.style.display = 'block';

  // Render TV tags with badges
  const tvPillsHtml = tvTags.map(item => {
    const excludeClass = item.allExclude ? ' exclude' : '';
    const excludeCount = item.excludeTvNames.length;
    const hasExcludes = excludeCount > 0;

    const tooltipParts = [];
    if (item.includeTvNames.length > 0) {
      tooltipParts.push(item.includeTvNames.join(', '));
    }
    if (item.excludeTvNames.length > 0) {
      tooltipParts.push(item.excludeTvNames.map(n => `${n} (exclude)`).join(', '));
    }
    const tooltip = tooltipParts.join(', ');

    let tvLabelHtml;
    if (item.totalTvs === 1) {
      const tvName = item.includeTvNames[0] || item.excludeTvNames[0];
      const prefix = item.allExclude ? 'ex:' : '';
      tvLabelHtml = `<span class="tv-name">${escapeHtml(prefix + tvName)}</span>`;
    } else if (item.allExclude) {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    } else if (hasExcludes) {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
    } else {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    }

    return `<button class="tv-tag-pill${excludeClass}" data-tag="${escapeHtml(item.tag)}" title="${escapeHtml(tooltip)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(item.tag)}</span>
      ${tvLabelHtml}
    </button>`;
  }).join('');

  // Render non-TV tags without badges
  const otherPillsHtml = otherTags.map(tag => {
    return `<button class="tv-tag-pill" data-tag="${escapeHtml(tag)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(tag)}</span>
    </button>`;
  }).join('');

  container.innerHTML = tvPillsHtml + otherPillsHtml;

  // Add click handlers for bulk suggested tags
  container.querySelectorAll('.tv-tag-pill').forEach(pill => {
    pill.addEventListener('click', async (e) => {
      pill.blur();
      e.target.blur();
      if (document.activeElement) document.activeElement.blur();

      const tag = pill.dataset.tag;
      await addBulkTagFromHelper(tag);
    });
  });
}

// Add a tag to all selected images from bulk helper (uses batch API)
async function addBulkTagFromHelper(tagName) {
  const selectedArray = Array.from(selectedImages);
  
  try {
    const response = await fetch(`${API_BASE}/images/batch/add-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: selectedArray, tag: tagName })
    });
    
    const result = await response.json();
    if (result.success) {
      // Update local cache - add tag to each image
      for (const filename of selectedArray) {
        if (allImages[filename]) {
          if (!allImages[filename].tags) {
            allImages[filename].tags = [];
          }
          if (!allImages[filename].tags.includes(tagName)) {
            allImages[filename].tags.push(tagName);
          }
        }
      }
      console.log(`Batch add tag: ${result.message}`);
    } else {
      console.error('Batch add tag failed:', result.error);
    }
  } catch (error) {
    console.error('Error in batch add tag:', error);
  }
  
  // Refresh the bulk modal to show updated state
  refreshBulkTagModal();
  
  // Update sync status since metadata changed
  await updateSyncStatus();
}

// Refresh the bulk tag modal with current state
function refreshBulkTagModal() {
  const selectedArray = Array.from(selectedImages);
  const countSpan = document.getElementById('bulk-count');
  if (countSpan) countSpan.textContent = selectedImages.size;
  
  const tagCounts = {};
  selectedArray.forEach(filename => {
    const imageData = allImages[filename];
    const tags = imageData.tags || [];
    tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  const allTags = [];
  const someTags = [];
  
  Object.entries(tagCounts).forEach(([tag, count]) => {
    if (count === selectedArray.length) {
      allTags.push(tag);
    } else {
      someTags.push(tag);
    }
  });
  
  renderBulkTagBadges('bulk-all-tags', allTags, false);
  renderBulkTagBadges('bulk-some-tags', someTags, true);
  renderBulkTvTagsHelper(allTags);
}

async function removeBulkTag(tagName, isPartial) {
  const selectedArray = Array.from(selectedImages);
  
  try {
    const response = await fetch(`${API_BASE}/images/batch/remove-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: selectedArray, tag: tagName })
    });
    
    const result = await response.json();
    if (result.success) {
      // Update local cache - remove tag from each image
      for (const filename of selectedArray) {
        if (allImages[filename] && allImages[filename].tags) {
          allImages[filename].tags = allImages[filename].tags.filter(t => t !== tagName);
        }
      }
      console.log(`Batch remove tag: ${result.message}`);
    } else {
      console.error('Batch remove tag failed:', result.error);
    }
  } catch (error) {
    console.error('Error in batch remove tag:', error);
  }
  
  // Refresh the modal to show updated tags
  const countSpan = document.getElementById('bulk-count');
  countSpan.textContent = selectedImages.size;
  
  // Recalculate tag frequencies
  const tagCounts = {};
  selectedArray.forEach(filename => {
    const imageData = allImages[filename];
    const tags = imageData.tags || [];
    tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  const allTags = [];
  const someTags = [];
  
  Object.entries(tagCounts).forEach(([tag, count]) => {
    if (count === selectedArray.length) {
      allTags.push(tag);
    } else {
      someTags.push(tag);
    }
  });
  
  renderBulkTagBadges('bulk-all-tags', allTags, false);
  renderBulkTagBadges('bulk-some-tags', someTags, true);
  renderBulkTvTagsHelper(allTags);
  
  // Update sync status since metadata changed
  await updateSyncStatus();
}

async function makeTagAll(tagName) {
  const selectedArray = Array.from(selectedImages);
  
  try {
    const response = await fetch(`${API_BASE}/images/batch/add-tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: selectedArray, tag: tagName })
    });
    
    const result = await response.json();
    if (result.success) {
      // Update local cache - add tag to each image
      for (const filename of selectedArray) {
        if (allImages[filename]) {
          if (!allImages[filename].tags) {
            allImages[filename].tags = [];
          }
          if (!allImages[filename].tags.includes(tagName)) {
            allImages[filename].tags.push(tagName);
          }
        }
      }
      console.log(`Batch add tag (makeTagAll): ${result.message}`);
    } else {
      console.error('Batch add tag failed:', result.error);
    }
  } catch (error) {
    console.error('Error in batch add tag:', error);
  }
  
  // Refresh the modal to show updated tags
  const countSpan = document.getElementById('bulk-count');
  countSpan.textContent = selectedImages.size;
  
  // Recalculate tag frequencies
  const tagCounts = {};
  selectedArray.forEach(filename => {
    const imageData = allImages[filename];
    const tags = imageData.tags || [];
    tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  const allTags = [];
  const someTags = [];
  
  Object.entries(tagCounts).forEach(([tag, count]) => {
    if (count === selectedArray.length) {
      allTags.push(tag);
    } else {
      someTags.push(tag);
    }
  });
  
  renderBulkTagBadges('bulk-all-tags', allTags, false);
  renderBulkTagBadges('bulk-some-tags', someTags, true);
  renderBulkTvTagsHelper(allTags);
  
  // Update sync status since metadata changed
  await updateSyncStatus();
}

function closeBulkTagModal() {
  const modal = document.getElementById('bulk-tag-modal');
  modal.classList.remove('visible');
  document.getElementById('bulk-tags-input').value = '';
  
  // Update tag displays on visible image cards to reflect changes
  updateGalleryCardTags();
  
  // Deselect all images
  selectedImages.clear();
  lastClickedIndex = null;
  updateGallerySelectionVisual();
}

/**
 * Update the tag badges on all visible gallery cards to reflect current state.
 * Called after bulk tag operations to show updated tags without full re-render.
 */
function updateGalleryCardTags() {
  const grid = document.getElementById('image-grid');
  if (!grid) return;
  
  const cards = grid.querySelectorAll('.image-card');
  cards.forEach(card => {
    const filename = card.dataset.filename;
    const imageData = allImages[filename];
    if (!imageData) return;
    
    const tagsContainer = card.querySelector('.image-tags');
    if (tagsContainer) {
      const tags = imageData.tags || [];
      tagsContainer.innerHTML = tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
    }
  });
}

async function saveBulkTags() {
  const tagsInput = document.getElementById('bulk-tags-input').value;
  const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);
  
  if (tags.length === 0) {
    alert('Please enter at least one tag');
    return;
  }
  
  const selectedArray = Array.from(selectedImages);
  let totalSuccess = 0;
  let hasError = false;
  
  // Use batch API for each tag
  for (const tag of tags) {
    try {
      const response = await fetch(`${API_BASE}/images/batch/add-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames: selectedArray, tag })
      });
      
      const result = await response.json();
      if (result.success) {
        totalSuccess += result.results.success;
        // Update local cache - add tag to each image (case-insensitive check)
        for (const filename of selectedArray) {
          if (allImages[filename]) {
            if (!allImages[filename].tags) {
              allImages[filename].tags = [];
            }
            const lowerTags = allImages[filename].tags.map(t => t.toLowerCase());
            if (!lowerTags.includes(tag.toLowerCase())) {
              allImages[filename].tags.push(tag);
            }
          }
        }
        console.log(`Batch add tag "${tag}": ${result.message}`);
      } else {
        hasError = true;
        console.error(`Batch add tag "${tag}" failed:`, result.error);
      }
    } catch (error) {
      hasError = true;
      console.error(`Error adding tag "${tag}":`, error);
    }
  }
  
  // Clear the input
  document.getElementById('bulk-tags-input').value = '';
  
  // Recalculate and re-render the tag badges
  const countSpan = document.getElementById('bulk-count');
  countSpan.textContent = selectedImages.size;
  
  const tagCounts = {};
  selectedArray.forEach(filename => {
    const imageData = allImages[filename];
    const imgTags = imageData.tags || [];
    imgTags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  const allTags = [];
  const someTags = [];
  
  Object.entries(tagCounts).forEach(([tag, count]) => {
    if (count === selectedArray.length) {
      allTags.push(tag);
    } else {
      someTags.push(tag);
    }
  });
  
  renderBulkTagBadges('bulk-all-tags', allTags, false);
  renderBulkTagBadges('bulk-some-tags', someTags, true);
  renderBulkTvTagsHelper(allTags);
  
  // Show result if there were errors
  if (hasError) {
    alert(`Some tags may not have been added. Check console for details.`);
  }
  
  // Update sync status since metadata changed
  await updateSyncStatus();
}

// Get TV tags that aren't already applied to the current image
// Returns aggregated data: each tag appears once with lists of include/exclude TVs
function getAvailableTvTags() {
  if (!currentImage || !allTVs || allTVs.length === 0) return [];
  
  const imageData = allImages[currentImage];
  const appliedTags = new Set(imageData?.tags || []);
  
  return getTvTagsExcluding(appliedTags);
}

// Get all TV tags regardless of current image (for upload form)
function getAllTvTags() {
  if (!allTVs || allTVs.length === 0) return [];
  return getTvTagsExcluding(new Set());
}

// Helper: Get TV tags excluding specified tags
function getTvTagsExcluding(excludeSet) {
  // Collect all TV tags with metadata - aggregate by tag
  // tag -> { includeTvNames: [], excludeTvNames: [] }
  const tvTagsMap = new Map();
  
  for (const tv of allTVs) {
    const tvName = tv.name || 'Unknown TV';
    
    // Include tags
    for (const tag of (tv.tags || [])) {
      if (!excludeSet.has(tag)) {
        if (!tvTagsMap.has(tag)) {
          tvTagsMap.set(tag, { includeTvNames: [], excludeTvNames: [] });
        }
        tvTagsMap.get(tag).includeTvNames.push(tvName);
      }
    }
    
    // Exclude tags
    for (const tag of (tv.exclude_tags || [])) {
      if (!excludeSet.has(tag)) {
        if (!tvTagsMap.has(tag)) {
          tvTagsMap.set(tag, { includeTvNames: [], excludeTvNames: [] });
        }
        tvTagsMap.get(tag).excludeTvNames.push(tvName);
      }
    }
  }
  
  // Convert to array and sort
  const result = [];
  for (const [tag, data] of tvTagsMap) {
    const totalTvs = data.includeTvNames.length + data.excludeTvNames.length;
    const allExclude = data.includeTvNames.length === 0;
    result.push({
      tag,
      includeTvNames: data.includeTvNames,
      excludeTvNames: data.excludeTvNames,
      totalTvs,
      allExclude
    });
  }
  
  result.sort((a, b) => {
    // Tags with includes first, then exclude-only tags
    if (a.allExclude !== b.allExclude) return a.allExclude ? 1 : -1;
    // Then alphabetically
    return a.tag.localeCompare(b.tag);
  });
  
  return result;
}

// Render the TV tags helper row
function renderTvTagsHelper() {
  const container = document.getElementById('tv-tags-helper');
  const wrapper = document.getElementById('tv-tags-wrapper');
  if (!container) return;

  const tvTags = getAvailableTvTags();
  const tvTagNames = new Set(tvTags.map(t => t.tag));

  // Get applied tags for current image
  const imageData = currentImage ? allImages[currentImage] : null;
  const appliedTags = new Set(imageData?.tags || []);

  // Get non-TV tags: all tags minus TV tags minus applied tags
  const otherTags = (allTags || [])
    .filter(tag => !tvTagNames.has(tag) && !appliedTags.has(tag))
    .sort();

  if (tvTags.length === 0 && otherTags.length === 0) {
    container.innerHTML = '';
    if (wrapper) wrapper.style.display = 'none';
    return;
  }

  if (wrapper) wrapper.style.display = 'block';

  // Render TV tags with badges
  const tvPillsHtml = tvTags.map(item => {
    const excludeClass = item.allExclude ? ' exclude' : '';
    const excludeCount = item.excludeTvNames.length;
    const hasExcludes = excludeCount > 0;

    // Build tooltip showing all TV names
    const tooltipParts = [];
    if (item.includeTvNames.length > 0) {
      tooltipParts.push(item.includeTvNames.join(', '));
    }
    if (item.excludeTvNames.length > 0) {
      tooltipParts.push(item.excludeTvNames.map(n => `${n} (exclude)`).join(', '));
    }
    const tooltip = tooltipParts.join(', ');

    // Build TV label - similar to applied tags format
    let tvLabelHtml;
    if (item.totalTvs === 1) {
      // Single TV
      const tvName = item.includeTvNames[0] || item.excludeTvNames[0];
      const prefix = item.allExclude ? 'ex:' : '';
      tvLabelHtml = `<span class="tv-name">${escapeHtml(prefix + tvName)}</span>`;
    } else if (item.allExclude) {
      // All exclude
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    } else if (hasExcludes) {
      // Mixed: some include, some exclude - show "X TVs (Y ex)" with Y ex in red
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
    } else {
      // All include
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    }

    return `<button class="tv-tag-pill${excludeClass}" data-tag="${escapeHtml(item.tag)}" title="${escapeHtml(tooltip)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(item.tag)}</span>
      ${tvLabelHtml}
    </button>`;
  }).join('');

  // Render non-TV tags without badges
  const otherPillsHtml = otherTags.map(tag => {
    return `<button class="tv-tag-pill" data-tag="${escapeHtml(tag)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(tag)}</span>
    </button>`;
  }).join('');

  container.innerHTML = tvPillsHtml + otherPillsHtml;

  // Add click handlers
  container.querySelectorAll('.tv-tag-pill').forEach(pill => {
    pill.addEventListener('click', async (e) => {
      // Immediately blur the clicked button to prevent focus transfer on mobile
      pill.blur();
      e.target.blur();
      if (document.activeElement) document.activeElement.blur();

      const tag = pill.dataset.tag;
      await addTagFromHelper(tag);
    });
  });
}

// Add a single tag from the helper and re-render
async function addTagFromHelper(tagName) {
  if (!currentImage) return;
  
  try {
    const imageData = allImages[currentImage];
    const existingTags = imageData.tags || [];
    const newTags = mergeTagsCaseInsensitive(existingTags, [tagName]);
    
    const response = await fetch(`${API_BASE}/images/${currentImage}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: newTags })
    });
    
    const result = await response.json();
    if (result.success && result.data) {
      allImages[currentImage] = result.data;
      renderImageTagBadges(result.data.tags || []);
      renderTvTagsHelper(); // Re-render to remove the added tag
      loadTags();
      await updateSyncStatus();
    }
  } catch (error) {
    console.error('Error adding tag from helper:', error);
  }
}

// Get TV matches for a specific tag (for tooltips)
function getTvMatchesForTag(tag) {
  if (!allTVs || allTVs.length === 0) return [];
  
  const matches = [];
  
  for (const tv of allTVs) {
    const tvName = tv.name || 'Unknown TV';
    const includeTags = tv.tags || [];
    const excludeTags = tv.exclude_tags || [];
    
    if (includeTags.includes(tag)) {
      matches.push({ tvName, isExclude: false });
    }
    if (excludeTags.includes(tag)) {
      matches.push({ tvName, isExclude: true });
    }
  }
  
  return matches;
}

// Image modal tag management functions
function renderImageTagBadges(tags) {
  const container = document.getElementById('modal-tags-badges');
  
  if (tags.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  container.innerHTML = tags.sort().map(tag => {
    const tvMatches = getTvMatchesForTag(tag);
    let tooltip = '';
    let tvInfoHtml = '';
    
    if (tvMatches.length > 0) {
      const matchStrings = tvMatches
        .sort((a, b) => a.tvName.localeCompare(b.tvName))
        .map(m => m.isExclude ? `${m.tvName} (exclude)` : m.tvName);
      tooltip = matchStrings.join(', ');
      
      // Build compact TV info display
      const excludeCount = tvMatches.filter(m => m.isExclude).length;
      const allExclude = excludeCount === tvMatches.length;
      const someExclude = excludeCount > 0 && !allExclude;
      
      let tvLabel;
      let colorClass = '';
      
      if (tvMatches.length === 1) {
        tvLabel = tvMatches[0].isExclude ? `ex:${tvMatches[0].tvName}` : tvMatches[0].tvName;
        if (tvMatches[0].isExclude) colorClass = ' tv-info-exclude';
      } else if (allExclude) {
        tvLabel = `${tvMatches.length} TVs`;
        colorClass = ' tv-info-exclude';
      } else if (someExclude) {
        // Show "X TVs (Y ex)" with Y ex in red
        tvInfoHtml = `<span class="tag-tv-info">${tvMatches.length} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
      } else {
        tvLabel = `${tvMatches.length} TVs`;
      }
      
      // Only build tvInfoHtml if not already set (for partial exclude case)
      if (!tvInfoHtml) {
        // Truncate to keep tags uniform width
        if (tvLabel.length > 12) {
          tvLabel = tvLabel.substring(0, 11) + '…';
        }
        tvInfoHtml = `<span class="tag-tv-info${colorClass}">${escapeHtml(tvLabel)}</span>`;
      }
    }
    
    const hasMatchClass = tvMatches.length > 0 ? ' has-tv-match' : '';
    
    return `
    <div class="tag-item${hasMatchClass}" ${tooltip ? `title="${escapeHtml(tooltip)}"` : ''} onclick="removeImageTag('${escapeHtml(tag)}')">
      <div class="tag-content">
        <span class="tag-name">${escapeHtml(tag)}</span>
        ${tvInfoHtml}
      </div>
      <span class="tag-remove">×</span>
    </div>
  `;
  }).join('');
  
  // Update the TV shuffle indicator
  updateTvShuffleIndicator(tags);
}

/**
 * Calculate and display which TVs will shuffle this image based on its applied tags.
 * 
 * This logic mirrors the shuffle eligibility check in frame-art-shuffler's shuffle.py:
 * - If a TV has include_tags set, the image must have at least ONE of those tags
 * - If a TV has exclude_tags set, the image must NOT have ANY of those tags
 * - If a TV has no include_tags and no exclude_tags, the image is always eligible
 * 
 * NOTE: If frame-art-shuffler's shuffle implementation changes, this logic may need updating.
 */
function updateTvShuffleIndicator(imageTags) {
  const indicator = document.getElementById('tv-shuffle-indicator');
  if (!indicator) return;
  
  if (!allTVs || allTVs.length === 0) {
    indicator.textContent = '';
    indicator.title = '';
    return;
  }
  
  const imageTagSet = new Set(imageTags || []);
  const eligibleTvNames = [];
  
  for (const tv of allTVs) {
    const tvName = tv.name || 'Unknown TV';
    const includeTags = tv.tags || [];
    const excludeTags = tv.exclude_tags || [];
    
    // Check include tags: if set, image must have at least one
    if (includeTags.length > 0 && !includeTags.some(tag => imageTagSet.has(tag))) {
      continue;
    }
    
    // Check exclude tags: if set, image must not have any
    if (excludeTags.length > 0 && excludeTags.some(tag => imageTagSet.has(tag))) {
      continue;
    }
    
    // Image is eligible for this TV
    eligibleTvNames.push(tvName);
  }
  
  if (eligibleTvNames.length === 0) {
    indicator.innerHTML = 'Will shuffle on: <span style="white-space:nowrap">none</span>';
    indicator.title = 'No TVs will shuffle this image with current tags';
  } else if (eligibleTvNames.length === 1) {
    // Single TV - keep on same line
    indicator.innerHTML = `Will shuffle on: <span style="white-space:nowrap">${escapeHtml(eligibleTvNames[0])}</span>`;
    indicator.title = eligibleTvNames[0];
  } else {
    // Multiple TVs (including all TVs) - use mobile-br class that only breaks on mobile
    const wrappedNames = eligibleTvNames.slice(0, 3).map(name => 
      `<span style="white-space:nowrap">${escapeHtml(name)}</span>`
    ).join(', ');
    const suffix = eligibleTvNames.length > 3 ? `, +${eligibleTvNames.length - 3} more` : '';
    indicator.innerHTML = `Will shuffle on:<span class="mobile-br"></span> ${wrappedNames}${suffix}`;
    indicator.title = eligibleTvNames.join(', ');
  }
}

async function removeImageTag(tagName) {
  if (!currentImage) return;
  
  try {
    const imageData = allImages[currentImage];
    const existingTags = imageData.tags || [];
    const newTags = existingTags.filter(t => t !== tagName);
    
    const response = await fetch(`${API_BASE}/images/${currentImage}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: newTags })
    });
    
    const result = await response.json();
    if (result.success) {
      // Update local cache
      allImages[currentImage].tags = newTags;
      
      // Re-render badges and TV tags helper
      renderImageTagBadges(newTags);
      renderTvTagsHelper();
      
      // Update sync status since metadata changed
      await updateSyncStatus();
    } else {
      alert('Failed to remove tag');
    }
  } catch (error) {
    console.error('Error removing tag:', error);
    alert('Error removing tag');
  }
}

async function addImageTags() {
  if (!currentImage) return;
  
  const tagsInput = document.getElementById('modal-tags-input').value;
  const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);
  
  if (tags.length === 0) {
    alert('Please enter at least one tag');
    return;
  }
  
  console.log(`\n🏷️  [TAG CHANGE] Adding tags to ${currentImage}:`, tags);
  
  try {
    const imageData = allImages[currentImage];
    const existingTags = imageData.tags || [];
    const newTags = mergeTagsCaseInsensitive(existingTags, tags);
    
    const response = await fetch(`${API_BASE}/images/${currentImage}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: newTags })
    });
    
    const result = await response.json();
    if (result.success && result.data) {
      console.log(`✅ [TAG CHANGE] Tags updated successfully for ${currentImage}`);
      
      // Update local cache with full response (includes updated timestamp)
      allImages[currentImage] = result.data;
      
      // Clear input and re-render badges
      document.getElementById('modal-tags-input').value = '';
      renderImageTagBadges(result.data.tags || []);
      
      // Reload tags list in background (but not gallery - causes jitter)
      // Gallery will be reloaded when modal closes if there are changes
      loadTags();
      
      // Update sync status since metadata changed
      console.log(`📊 [TAG CHANGE] Updating sync status...`);
      await updateSyncStatus();
      console.log(`📊 [TAG CHANGE] Sync status updated\n`);
    } else {
      alert('Failed to add tags');
    }
  } catch (error) {
    console.error('💥 [TAG CHANGE] Error adding tags:', error);
    alert('Error adding tags');
  }
}

// Get last display info for an image from analytics data
function getLastDisplayInfo(filename) {
  // First check if image is currently displaying (from recently displayed data)
  const recentEntries = recentlyDisplayedData[filename] || [];
  const currentlyDisplaying = recentEntries.find(entry => entry.time === 'now');
  if (currentlyDisplaying) {
    return { timeAgo: 'Now', tvName: currentlyDisplaying.tv_name || 'Unknown TV' };
  }
  
  // Fall back to analytics data for historical display info
  const imageData = analyticsData?.images?.[filename];
  if (!imageData?.display_periods) return null;
  
  let lastEnd = 0;
  let lastTvId = null;
  
  for (const [tvId, periods] of Object.entries(imageData.display_periods)) {
    for (const period of periods) {
      if (period.end > lastEnd) {
        lastEnd = period.end;
        lastTvId = tvId;
      }
    }
  }
  
  if (!lastEnd || !lastTvId) return null;
  
  // Format time ago - use largest meaningful unit, rounded to nearest
  const now = Date.now();
  const diffMs = now - lastEnd;
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const diffMonths = Math.round(diffDays / 30);
  
  let timeAgo;
  if (diffMonths >= 1) {
    timeAgo = `${diffMonths}mo ago`;
  } else if (diffDays >= 1) {
    timeAgo = `${diffDays}d ago`;
  } else if (diffHours >= 1) {
    timeAgo = `${diffHours}h ago`;
  } else {
    timeAgo = `${diffMinutes}m ago`;
  }
  
  // Get TV name
  const tvName = analyticsData?.tvs?.[lastTvId]?.name || 'Unknown TV';
  
  return { timeAgo, tvName };
}

/**
 * Update the similar threshold slider bar visibility and state
 */
function updateSimilarThresholdBar() {
  let bar = document.getElementById('similar-threshold-bar');
  
  if (!similarFilterActive) {
    if (bar) bar.style.display = 'none';
    return;
  }
  
  // Create bar if it doesn't exist
  if (!bar) {
    const grid = document.getElementById('image-grid');
    if (!grid) return;
    
    bar = document.createElement('div');
    bar.id = 'similar-threshold-bar';
    bar.className = 'similar-threshold-bar';
    bar.innerHTML = `
      <label for="similar-threshold-slider">Threshold:</label>
      <div class="slider-wrapper">
        <div class="slider-container">
          <span class="slider-scale-label left">10</span>
          <input type="range" id="similar-threshold-slider" min="10" max="60" value="${similarThreshold}">
          <span class="slider-scale-label right">60</span>
          <div class="slider-ticks" id="slider-ticks"></div>
          <div class="slider-preset-ticks">
            <span class="preset-tick" style="left: 0%"></span>
            <span class="preset-tick" style="left: 56%"></span>
          </div>
          <div class="slider-labels">
            <span class="slider-preset-label clickable" data-threshold="10" style="left: 0%">Duplicate</span>
            <span class="slider-preset-label clickable" data-threshold="38" style="left: 56%">Similar</span>
          </div>
        </div>
      </div>
      <span id="similar-threshold-value">${similarThreshold}</span>
    `;
    grid.parentNode.insertBefore(bar, grid);
    
    // Add change listener for slider
    const slider = bar.querySelector('#similar-threshold-slider');
    const valueDisplay = bar.querySelector('#similar-threshold-value');
    
    slider.addEventListener('input', (e) => {
      valueDisplay.textContent = e.target.value;
    });
    
    slider.addEventListener('change', async (e) => {
      similarThreshold = parseInt(e.target.value, 10);
      await fetchSimilarGroups(similarThreshold);
      await loadTagsForFilter(); // Update count in dropdown
      renderGallery();
    });
    
    // Add click listeners for preset labels
    bar.querySelectorAll('.slider-preset-label.clickable').forEach(label => {
      label.addEventListener('click', async (e) => {
        const threshold = parseInt(e.target.dataset.threshold, 10);
        similarThreshold = threshold;
        slider.value = threshold;
        valueDisplay.textContent = threshold;
        await fetchSimilarGroups(similarThreshold);
        await loadTagsForFilter();
        renderGallery();
      });
    });
  }
  
  bar.style.display = 'flex';
  
  // Update slider value in case threshold changed elsewhere
  const slider = bar.querySelector('#similar-threshold-slider');
  const valueDisplay = bar.querySelector('#similar-threshold-value');
  if (slider && slider.value != similarThreshold) {
    slider.value = similarThreshold;
    valueDisplay.textContent = similarThreshold;
  }
  
  // Update ticks based on breakpoints
  updateSliderTicks();
}

/**
 * Update the slider ticks to show where images are added
 */
function updateSliderTicks() {
  const ticksContainer = document.getElementById('slider-ticks');
  if (!ticksContainer) return;
  
  // Clear existing ticks
  ticksContainer.innerHTML = '';
  
  // Create ticks for each breakpoint within the slider range
  const sliderMin = 10;
  const sliderMax = 60;
  const sliderRange = sliderMax - sliderMin;
  
  for (const bp of similarBreakpoints) {
    if (bp.threshold >= sliderMin && bp.threshold <= sliderMax) {
      const tick = document.createElement('div');
      tick.className = 'slider-tick';
      const position = ((bp.threshold - sliderMin) / sliderRange) * 100;
      tick.style.left = `${position}%`;
      tick.title = `${bp.threshold}: +${bp.addedImages} image${bp.addedImages > 1 ? 's' : ''} (${bp.totalImages} total)`;
      
      // Add count label below tick
      const countLabel = document.createElement('span');
      countLabel.className = 'tick-count';
      countLabel.textContent = `+${bp.addedImages}`;
      tick.appendChild(countLabel);
      
      ticksContainer.appendChild(tick);
    }
  }
}

function renderGallery(filter = '') {
  const grid = document.getElementById('image-grid');
  if (!grid) {
    console.warn('Gallery render skipped: image grid element not found.');
    return;
  }
  
  // Update similar threshold bar visibility
  updateSimilarThresholdBar();

  const searchInput = document.getElementById('search-input');
  const searchTerm = (searchInput?.value || '').toLowerCase();
  const sortOrderSelect = document.getElementById('sort-order');
  const sortOrder = sortOrderSelect ? sortOrderSelect.value : initialSortOrderPreference;

  // Determine include/exclude tags - check if any TV shortcuts are selected first
  const checkedTvCheckboxes = document.querySelectorAll('.tv-checkbox:checked');
  let includedTags = [];
  let excludedTags = [];
  
  if (checkedTvCheckboxes.length > 0) {
    // TV shortcuts are checked - get tags directly from TV configs (union of all checked TVs)
    const includedSet = new Set();
    const excludedSet = new Set();
    
    checkedTvCheckboxes.forEach(checkbox => {
      const tvId = checkbox.value;
      const tv = allTVs.find(t => (t.device_id || t.entity_id) === tvId);
      if (tv) {
        (tv.tags || []).forEach(tag => includedSet.add(tag));
        (tv.exclude_tags || []).forEach(tag => excludedSet.add(tag));
      }
    });
    
    includedTags = Array.from(includedSet);
    excludedTags = Array.from(excludedSet);
  } else {
    // No TV shortcuts - use tag checkbox states
    includedTags = getIncludedTags();
    excludedTags = getExcludedTags();
  }

  let filteredImages = Object.entries(allImages);

  // Filter by search term
  if (searchTerm) {
    filteredImages = filteredImages.filter(([filename]) => 
      filename.toLowerCase().includes(searchTerm)
    );
  }

  // Filter by included tags (image must have ANY of the included tags)
  if (includedTags.length > 0) {
    filteredImages = filteredImages.filter(([_, data]) => 
      data.tags && includedTags.some(tag => data.tags.includes(tag))
    );
  }

  // Filter by excluded tags (image must NOT have ANY of the excluded tags)
  if (excludedTags.length > 0) {
    filteredImages = filteredImages.filter(([_, data]) => {
      const imageTags = data.tags || [];
      return !excludedTags.some(tag => imageTags.includes(tag));
    });
  }

  // Filter for "None" - images not shown on any TV
  const noneCheckbox = document.querySelector('.tv-none-checkbox');
  if (noneCheckbox && noneCheckbox.checked) {
    filteredImages = filteredImages.filter(([_, data]) => {
      const imageTagSet = new Set(data.tags || []);
      
      // Check if this image is eligible for ANY TV
      for (const tv of allTVs) {
        const includeTags = tv.tags || [];
        const excludeTags = tv.exclude_tags || [];
        
        // Check include tags: if set, image must have at least one
        if (includeTags.length > 0 && !includeTags.some(tag => imageTagSet.has(tag))) {
          continue;
        }
        
        // Check exclude tags: if set, image must not have any
        if (excludeTags.length > 0 && excludeTags.some(tag => imageTagSet.has(tag))) {
          continue;
        }
        
        // Image is eligible for this TV, so it's NOT a "None" image
        return false;
      }
      
      // Image is not eligible for any TV
      return true;
    });
  }

  // Filter for "Recently Displayed" - current and previous images on each TV
  if (recentlyDisplayedFilterActive) {
    const recentFilenames = getRecentlyDisplayedFilenames();
    filteredImages = filteredImages.filter(([filename]) => recentFilenames.has(filename));
  }

  // Filter for "Similar Images" - images that may be visually related
  if (similarFilterActive) {
    const similarFilenames = getSimilarFilenames();
    filteredImages = filteredImages.filter(([filename]) => similarFilenames.has(filename));
  }

  // Filter for "Portrait" - images where height > width
  if (portraitFilterActive) {
    filteredImages = filteredImages.filter(([filename, data]) => isPortrait(data.aspectRatio));
  }

  // Filter for "Landscape (Non 16:9)" - landscape images that are not 16:9 aspect ratio
  if (non169FilterActive) {
    filteredImages = filteredImages.filter(([filename, data]) => !isPortrait(data.aspectRatio) && !isAspectRatio16x9(data.aspectRatio));
  }

  // ============================================
  // Sort images
  // ============================================
  // There are 3 sort modes:
  //   1. "name" - alphabetical by filename (visible in dropdown)
  //   2. "date" - by upload date (visible in dropdown)
  //   3. "duplicates"/"similar" - IMPLICIT, auto-activated when special filters are on
  //
  // The "duplicates"/"similar" sort mode groups related images together,
  // then sorts groups by the newest image date in each group.
  // Within each group, images are sorted by their individual upload date.
  // This mode does NOT appear in the sort dropdown - it's automatically
  // engaged when entering duplicate/similar filter mode, and the previous sort
  // state is restored when exiting.
  // ============================================
  
  // Determine if a special grouping filter is active and which groups to use
  const specialFilterActive = similarFilterActive;
  const activeGroups = similarFilterActive ? similarGroups : [];
  
  if (specialFilterActive && activeGroups.length > 0) {
    // IMPLICIT grouping sort mode - groups related images together
    // For similar filter: groups ordered by minimum hamming distance (most similar first)
    // For duplicate filter: groups ordered by newest image's date
    // Images within each group are sorted by their individual upload date
    
    // Build a map of filename -> group index and calculate sort key per group
    const filenameToGroupIndex = new Map();
    const groupSortKeys = [];
    
    activeGroups.forEach((group, groupIndex) => {
      let maxDate = 0;
      let minDistance = Infinity;
      
      group.forEach(filename => {
        filenameToGroupIndex.set(filename, groupIndex);
        const imgData = allImages[filename];
        if (imgData && imgData.added) {
          const date = new Date(imgData.added).getTime();
          if (date > maxDate) maxDate = date;
        }
      });
      
      // For similar filter, find minimum pairwise distance in this group
      if (similarFilterActive && similarDistances) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const f1 = group[i];
            const f2 = group[j];
            const key = f1 < f2 ? `${f1}|${f2}` : `${f2}|${f1}`;
            const dist = similarDistances[key];
            if (dist !== undefined && dist < minDistance) {
              minDistance = dist;
            }
          }
        }
      }
      
      groupSortKeys[groupIndex] = {
        maxDate,
        minDistance: minDistance === Infinity ? 0 : minDistance
      };
    });
    
    filteredImages.sort((a, b) => {
      const [filenameA, dataA] = a;
      const [filenameB, dataB] = b;
      
      const groupA = filenameToGroupIndex.get(filenameA) ?? -1;
      const groupB = filenameToGroupIndex.get(filenameB) ?? -1;
      
      // Different groups: sort by group's sort key
      if (groupA !== groupB) {
        if (similarFilterActive) {
          // Sort by minimum distance (smaller = more similar = first)
          const distA = groupSortKeys[groupA]?.minDistance ?? Infinity;
          const distB = groupSortKeys[groupB]?.minDistance ?? Infinity;
          if (distA !== distB) {
            return distA - distB;
          }
          // Tiebreaker: use group index to keep groups together
          return groupA - groupB;
        } else {
          // Duplicate mode: sort by max date
          const maxDateA = groupSortKeys[groupA]?.maxDate || 0;
          const maxDateB = groupSortKeys[groupB]?.maxDate || 0;
          const comparison = maxDateA - maxDateB;
          if (comparison !== 0) {
            return sortAscending ? comparison : -comparison;
          }
          // Tiebreaker: use group index to keep groups together
          return groupA - groupB;
        }
      }
      
      // Same group: sort by individual image upload date
      const dateA = new Date(dataA.added || 0).getTime();
      const dateB = new Date(dataB.added || 0).getTime();
      const comparison = dateA - dateB;
      return sortAscending ? comparison : -comparison;
    });
  } else if (recentlyDisplayedFilterActive) {
    // Sort by most recent display time (Now first, then by timestamp)
    filteredImages.sort((a, b) => {
      const [filenameA] = a;
      const [filenameB] = b;
      
      const entriesA = recentlyDisplayedData[filenameA] || [];
      const entriesB = recentlyDisplayedData[filenameB] || [];
      
      // Get most recent timestamp for each image
      const getMostRecentTimestamp = (entries) => {
        if (entries.length === 0) return 0;
        // 'now' entries get current timestamp (highest priority)
        const hasNow = entries.some(e => e.time === 'now');
        if (hasNow) return Date.now();
        // Otherwise use highest timestamp
        return Math.max(...entries.map(e => e.timestamp || 0));
      };
      
      const timestampA = getMostRecentTimestamp(entriesA);
      const timestampB = getMostRecentTimestamp(entriesB);
      
      // Sort descending (most recent first)
      return timestampB - timestampA;
    });
  } else {
    // Standard sort modes: "name", "date", "modified", or "displayed" (from dropdown)
    filteredImages.sort((a, b) => {
      const [filenameA, dataA] = a;
      const [filenameB, dataB] = b;
      
      let comparison = 0;
      if (sortOrder === 'date') {
        // Sort by date added
        const dateA = new Date(dataA.added || 0);
        const dateB = new Date(dataB.added || 0);
        comparison = dateA - dateB; // older first when ascending
      } else if (sortOrder === 'modified') {
        // Sort by last modified (fall back to added if never modified)
        const dateA = new Date(dataA.updated || dataA.added || 0);
        const dateB = new Date(dataB.updated || dataB.added || 0);
        comparison = dateA - dateB; // older first when ascending
      } else if (sortOrder === 'displayed') {
        // Sort by last displayed time
        // Images currently displaying (time: 'now') get Date.now() as their timestamp
        // Secondary sort: added date, then filename for images with same/no display time
        const isCurrentlyDisplayingA = recentlyDisplayedData[filenameA]?.some(d => d.time === 'now');
        const isCurrentlyDisplayingB = recentlyDisplayedData[filenameB]?.some(d => d.time === 'now');
        const timeA = isCurrentlyDisplayingA ? Date.now() : (lastDisplayedTimes?.[filenameA] || 0);
        const timeB = isCurrentlyDisplayingB ? Date.now() : (lastDisplayedTimes?.[filenameB] || 0);
        comparison = timeA - timeB;
        
        // If both have same display time (or both never displayed), use added date as tiebreaker
        if (comparison === 0) {
          const dateA = new Date(dataA.added || 0);
          const dateB = new Date(dataB.added || 0);
          comparison = dateA - dateB;
          
          // If still tied, use filename
          if (comparison === 0) {
            comparison = filenameA.localeCompare(filenameB);
          }
        }
      } else {
        // Sort by name (alphabetically)
        comparison = filenameA.localeCompare(filenameB);
      }
      
      // Reverse if descending
      return sortAscending ? comparison : -comparison;
    });
  }

  // Store filtered results for chunked loading
  currentFilteredImages = filteredImages;
  renderedCount = 0;

  // Deselect any images that are no longer visible after filtering
  if (selectedImages.size > 0) {
    const visibleFilenames = new Set(filteredImages.map(([filename]) => filename));
    let deselectedCount = 0;
    for (const filename of selectedImages) {
      if (!visibleFilenames.has(filename)) {
        selectedImages.delete(filename);
        deselectedCount++;
      }
    }
    if (deselectedCount > 0) {
      console.log(`Deselected ${deselectedCount} image(s) no longer visible after filter change`);
    }
  }

  if (filteredImages.length === 0) {
    grid.innerHTML = '<div class="empty-state">No images found</div>';
    updateSearchPlaceholder(0);
    updateBulkActionsBar(0);
    return;
  }

  // Clear grid and render first chunk
  grid.innerHTML = '';
  renderGalleryChunk(grid, Math.min(GALLERY_CHUNK_SIZE, filteredImages.length));

  updateSearchPlaceholder(filteredImages.length);
  updateBulkActionsBar(filteredImages.length);
}

// Render a chunk of gallery images (used for initial load and infinite scroll)
function renderGalleryChunk(grid, count) {
  const startIndex = renderedCount;
  const endIndex = Math.min(startIndex + count, currentFilteredImages.length);
  
  if (startIndex >= currentFilteredImages.length) return;
  
  const chunk = currentFilteredImages.slice(startIndex, endIndex);
  
  const chunkHtml = chunk.map(([filename, data], chunkIndex) => {
    const index = startIndex + chunkIndex; // Global index for selection
    const isSelected = selectedImages.has(filename);
    
    // Check if image is 16:9 (aspect ratio ~1.78)
    const is16x9 = data.aspectRatio && Math.abs(data.aspectRatio - 1.78) < 0.05;
    
    // Check if image meets "sam" criteria: 3840x2160 and <= 20MB
    const width = data.dimensions?.width || 0;
    const height = data.dimensions?.height || 0;
    const fileSize = data.fileSize || 0;
    const fileSizeMB = fileSize / (1024 * 1024);
    const isSam = width === 3840 && height === 2160 && fileSizeMB <= 20;
    
    // Format date
    const dateAdded = formatDate(data.added);
    
    // Build badges HTML for bottom of card
    let badgesHtml = '';
    if (isSam) {
      badgesHtml += '<span class="sam-badge-card" title="Image resolution and size (<20MB) is correct target for Frame TVs">sam</span>';
    }
    if (is16x9) {
      badgesHtml += '<span class="aspect-badge-card">16:9</span>';
    }
    
    // Build filter/matte indicator
    const filterMatteSuffix = formatFilterMatteSuffix(data.filter, data.matte);
    
    // Get last display info from analytics (skip if recently displayed filter is active)
    const lastDisplay = recentlyDisplayedFilterActive ? null : getLastDisplayInfo(filename);
    const lastDisplayHtml = lastDisplay 
      ? `<div class="image-last-display">${lastDisplay.timeAgo} (${escapeHtml(lastDisplay.tvName)})</div>`
      : '';
    
    // Get similar images overlay (only when similar filter is active)
    const similarImages = getSimilarImagesForFile(filename);
    const similarOverlayHtml = similarImages.length > 0
      ? `<div class="similar-overlay">Similar: ${similarImages.map(item => `${getDisplayName(item.filename)} (${item.distance})`).join(', ')}</div>`
      : '';
    
    // Get recently displayed overlay (only when recently displayed filter is active)
    const recentlyDisplayedInfo = getRecentlyDisplayedInfoForFile(filename);
    const recentlyDisplayedHtml = recentlyDisplayedInfo.length > 0
      ? `<div class="similar-overlay">${recentlyDisplayedInfo.map(item => `${escapeHtml(item.tvName)} (${item.timeAgo})`).join(', ')}</div>`
      : '';
    
    return `
    <div class="image-card ${isSelected ? 'selected' : ''}" 
         data-filename="${filename}" 
         data-index="${index}">
      <div class="image-wrapper">
        <img src="thumbs/thumb_${filename}${thumbnailCacheBusters[filename] ? '?v=' + thumbnailCacheBusters[filename] : ''}" 
             onerror="this.src='library/${filename}'" 
             alt="${getDisplayName(filename)}" />
        <button class="select-badge" data-filename="${filename}" data-index="${index}" title="Select image">
          <span class="select-icon">☑</span>
        </button>
        ${similarOverlayHtml}
        ${recentlyDisplayedHtml}
      </div>
      <div class="image-info">
        <button class="stats-link" data-filename="${filename}" title="Stats">📊</button>
        <div class="image-filename"><span class="image-filename-text">${getDisplayName(filename)}</span>${filterMatteSuffix}${badgesHtml ? ' ' + badgesHtml : ''}</div>
        <div class="image-tags">
          ${(data.tags || []).map(tag => `<span class="tag">${tag}</span>`).join('')}
        </div>
        <div class="image-info-footer">
          ${lastDisplayHtml}
          ${dateAdded ? `<div class="image-date">${dateAdded}</div>` : ''}
        </div>
      </div>
    </div>
  `;
  }).join('');
  
  // Append to grid
  grid.insertAdjacentHTML('beforeend', chunkHtml);
  renderedCount = endIndex;
  
  // Add click listeners to newly added cards
  const newCards = grid.querySelectorAll(`.image-card[data-index]`);
  newCards.forEach(card => {
    const cardIndex = parseInt(card.dataset.index);
    // Only add listeners to cards in this chunk (avoid duplicates)
    if (cardIndex >= startIndex && cardIndex < endIndex && !card.dataset.listenerAdded) {
      card.dataset.listenerAdded = 'true';
      card.addEventListener('click', (e) => {
        // Check if clicked on stats link
        if (e.target.closest('.stats-link')) {
          e.stopPropagation();
          const filename = e.target.closest('.stats-link').dataset.filename;
          navigateTo('/analytics');
          setTimeout(() => selectAnalyticsImage(filename), 300);
          return;
        }
        
        // Check if clicked on select badge
        if (e.target.closest('.select-badge')) {
          e.stopPropagation();
          const syntheticEvent = {
            ...e,
            metaKey: true,
            stopPropagation: () => e.stopPropagation()
          };
          handleImageClick(card.dataset.filename, parseInt(card.dataset.index), syntheticEvent);
          return;
        }
        
        // If shift or cmd/ctrl is held, select
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          handleImageClick(card.dataset.filename, parseInt(card.dataset.index), e);
        } else {
          openImageModal(card.dataset.filename);
        }
      });
    }
  });
  
  // Show/hide "load more" indicator
  updateLoadMoreIndicator(grid);
}

// Load more images when scrolling near bottom
function loadMoreGalleryImages() {
  if (isLoadingMoreImages) return;
  if (renderedCount >= currentFilteredImages.length) return;
  
  const grid = document.getElementById('image-grid');
  if (!grid) return;
  
  isLoadingMoreImages = true;
  renderGalleryChunk(grid, GALLERY_CHUNK_SIZE);
  isLoadingMoreImages = false;
}

// Update the "load more" indicator at bottom of gallery
function updateLoadMoreIndicator(grid) {
  // Remove existing indicator
  const existingIndicator = grid.querySelector('.gallery-load-more');
  if (existingIndicator) existingIndicator.remove();
  
  // Add indicator if there are more images to load
  if (renderedCount < currentFilteredImages.length) {
    const remaining = currentFilteredImages.length - renderedCount;
    const indicator = document.createElement('div');
    indicator.className = 'gallery-load-more';
    indicator.innerHTML = `<span>Scroll for ${remaining} more image${remaining !== 1 ? 's' : ''}...</span>`;
    grid.appendChild(indicator);
  }
}

// Initialize gallery scroll listener for infinite scroll
function initGalleryInfiniteScroll() {
  // Use the main content area or window for scroll detection
  const scrollContainer = document.querySelector('main') || window;
  
  const handleScroll = () => {
    const grid = document.getElementById('image-grid');
    if (!grid) return;
    
    // Check if gallery tab is active
    const galleryTab = document.getElementById('gallery-tab');
    if (!galleryTab || !galleryTab.classList.contains('active')) return;
    
    // Get scroll position
    let scrollBottom;
    if (scrollContainer === window) {
      scrollBottom = window.innerHeight + window.scrollY;
    } else {
      scrollBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
    }
    
    const gridBottom = grid.offsetTop + grid.offsetHeight;
    const threshold = 300; // Load more when within 300px of bottom
    
    if (scrollBottom >= gridBottom - threshold) {
      loadMoreGalleryImages();
    }
  };
  
  // Throttle scroll handler
  let scrollTimeout;
  const throttledScroll = () => {
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(() => {
      handleScroll();
      scrollTimeout = null;
    }, 100);
  };
  
  scrollContainer.addEventListener('scroll', throttledScroll);
}

function updateSearchPlaceholder(count) {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.placeholder = `Search ${count} images`;
  }
}

// Search and Filter
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search-input');
  const tagFilterBtn = document.getElementById('tag-filter-btn');
  const tagFilterDropdown = document.getElementById('tag-filter-dropdown');
  const clearTagFilterBtn = document.getElementById('clear-tag-filter-btn');
  const sortOrderSelect = document.getElementById('sort-order');
  const sortDirectionBtn = document.getElementById('sort-direction-btn');

  if (searchInput) {
    searchInput.addEventListener('input', () => renderGallery());
  }

  // Clear tag filter button
  if (clearTagFilterBtn) {
    clearTagFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Reset all tag checkboxes to unchecked state
      const checkboxes = document.querySelectorAll('.tag-checkbox');
      checkboxes.forEach(cb => setTagState(cb, 'unchecked'));
      // Uncheck all TV checkboxes
      const tvCheckboxes = document.querySelectorAll('.tv-checkbox');
      tvCheckboxes.forEach(cb => cb.checked = false);
      // Uncheck all tagset checkboxes
      const tagsetCheckboxes = document.querySelectorAll('.tagset-checkbox');
      tagsetCheckboxes.forEach(cb => cb.checked = false);
      // Uncheck "None" checkbox
      const noneCheckbox = document.querySelector('.tv-none-checkbox');
      if (noneCheckbox) {
        noneCheckbox.checked = false;
      }
      // Uncheck "Duplicates" checkbox (legacy - may not exist)
      const dupesCheckbox = document.querySelector('.duplicates-checkbox');
      if (dupesCheckbox) {
        dupesCheckbox.checked = false;
      }
      // Uncheck "Similar" checkbox and clear filter
      const similarCheckbox = document.querySelector('.similar-checkbox');
      if (similarCheckbox) {
        similarCheckbox.checked = false;
      }
      // Uncheck "Portrait" checkbox and clear filter
      const portraitCheckbox = document.querySelector('.portrait-checkbox');
      if (portraitCheckbox) {
        portraitCheckbox.checked = false;
      }
      // Uncheck "Non 16:9" checkbox and clear filter
      const non169Checkbox = document.querySelector('.non169-checkbox');
      if (non169Checkbox) {
        non169Checkbox.checked = false;
      }
      // Uncheck "Recently Displayed" checkbox and clear filter
      const recentlyDisplayedCheckbox = document.querySelector('.recently-displayed-checkbox');
      if (recentlyDisplayedCheckbox) {
        recentlyDisplayedCheckbox.checked = false;
      }
      // Restore sort state if we were in similar filter mode
      if (similarFilterActive && preSimilarSortState) {
        const sortOrderSelect = document.getElementById('sort-order');
        if (sortOrderSelect) sortOrderSelect.value = preSimilarSortState.order;
        sortAscending = preSimilarSortState.ascending;
        updateSortDirectionIcon();
        preSimilarSortState = null;
      }
      // Restore sort state if we were in recently displayed filter mode
      if (recentlyDisplayedFilterActive && preRecentSortState) {
        const sortOrderSelect = document.getElementById('sort-order');
        if (sortOrderSelect) sortOrderSelect.value = preRecentSortState.order;
        sortAscending = preRecentSortState.ascending;
        updateSortDirectionIcon();
        preRecentSortState = null;
      }
      similarFilterActive = false;
      portraitFilterActive = false;
      non169FilterActive = false;
      recentlyDisplayedFilterActive = false;
      updateTagFilterDisplay();
      // Re-render gallery with no filters
      filterAndRenderGallery();
      // Close the dropdown if it's open
      if (!DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
        closeTagDropdownPortal();
      }
    });
  }

  // Toggle tag filter dropdown
  if (tagFilterBtn) {
    tagFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Debug log
      console.log('[TagDropdown] button click');
      const dbg = document.getElementById('tag-dropdown-debug');
      if (dbg) dbg.textContent = 'Debug: click received at ' + new Date().toLocaleTimeString();
      if (DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
        // Keep it visible; just ensure populated
        if (tagFilterDropdown) {
          tagFilterDropdown.classList.add('active');
          tagFilterDropdown.style.display = 'block';
          const optionsContainer = tagFilterDropdown.querySelector('.multiselect-options');
          if (optionsContainer && optionsContainer.children.length === 0) {
            loadTagsForFilter();
          }
        }
        tagFilterBtn.classList.add('active');
        return;
      }
      // Normal toggle behavior when debug is off (use portal)
      if (tagDropdownState.isOpen) {
        closeTagDropdownPortal();
      } else {
        openTagDropdownPortal();
      }
    });
  }

  // Fallback: Close dropdown when clicking outside (shield handles most cases, this is backup)
  document.addEventListener('click', (e) => {
    if (DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) return;
    const { btn, dropdown } = getTagFilterElements();
    if (!dropdown || !btn) return;
    
    // Only act if dropdown is open
    if (!tagDropdownState.isOpen) return;
    
    const clickInsideDropdown = dropdown.contains(e.target);
    const clickOnButton = btn.contains(e.target);
    const clickOnShield = e.target.id === 'dropdown-click-shield';
    // IMPORTANT: Don't intercept clicks on the gear button
    const clickOnGear = e.target.closest('#open-advanced-btn');
    if (!clickInsideDropdown && !clickOnButton && !clickOnShield && !clickOnGear) {
      console.log('[TagDropdown] outside click (fallback) - closing');
      closeTagDropdownPortal();
    }
  });

  // Function to resize sort select based on selected option
  function resizeSortSelect(trigger) {
    if (!sortOrderSelect) return;
    
    // Create a temporary span to measure text width
    const tempSpan = document.createElement('span');
    tempSpan.style.visibility = 'hidden';
    tempSpan.style.position = 'absolute';
    tempSpan.style.whiteSpace = 'nowrap';
    tempSpan.style.fontSize = '13px';
    tempSpan.style.fontFamily = window.getComputedStyle(sortOrderSelect).fontFamily;
    tempSpan.textContent = sortOrderSelect.options[sortOrderSelect.selectedIndex].text;
    document.body.appendChild(tempSpan);
    
    const textWidth = tempSpan.offsetWidth;
    document.body.removeChild(tempSpan);
    
    // Set width to text width plus space for arrow (16px)
  const computedWidth = textWidth + 2; // tiny buffer to prevent truncation
    sortOrderSelect.style.setProperty('box-sizing', 'content-box');
    sortOrderSelect.style.setProperty('width', `${computedWidth}px`, 'important');
    sortOrderSelect.style.setProperty('min-width', `${computedWidth}px`, 'important');
    sortOrderSelect.style.setProperty('max-width', `${computedWidth}px`, 'important');

    if (trigger) {
      console.log('[Gallery] resizeSortSelect', {
        trigger,
        text: tempSpan.textContent,
        textWidth,
        computedWidth
      });
    }
  }

  if (sortOrderSelect) {
    sortOrderSelect.addEventListener('change', async () => {
      resizeSortSelect('change');
      
      // Fetch last displayed times if needed for 'displayed' sort
      if (sortOrderSelect.value === 'displayed' && lastDisplayedTimes === null) {
        await fetchLastDisplayedTimes();
      }
      
      renderGallery();
      saveSortPreference(sortOrderSelect.value, sortAscending);
    });
    // Initial resize
    resizeSortSelect('init');
  }

  // Toggle sort direction
  if (sortDirectionBtn) {
    sortDirectionBtn.addEventListener('click', () => {
      sortAscending = !sortAscending;
      updateSortDirectionIcon();
      renderGallery();
      const orderValue = sortOrderSelect ? sortOrderSelect.value : initialSortOrderPreference;
      saveSortPreference(orderValue, sortAscending);
    });
  }

  updateSortDirectionIcon();
});

// Fallback: ensure gear button opens Advanced even if initSettingsNavigation didn't bind
// (No fallback gear handler needed now that UI binds first.)

function updateSortDirectionIcon() {
  const sortDirectionBtn = document.getElementById('sort-direction-btn');
  if (!sortDirectionBtn) {
    return;
  }

  const isAscending = !!sortAscending;
  const icon = isAscending ? '↑' : '↓';
  sortDirectionBtn.textContent = icon;
  sortDirectionBtn.setAttribute('data-direction', isAscending ? 'asc' : 'desc');
  sortDirectionBtn.setAttribute('aria-pressed', String(isAscending));
  sortDirectionBtn.setAttribute('aria-label', isAscending ? 'Sort ascending' : 'Sort descending');
  sortDirectionBtn.title = isAscending ? 'Sort ascending' : 'Sort descending';
}

function updateTagFilterCount() {
  // This function is no longer needed with custom dropdown
  // Keeping for backwards compatibility
}

// Upload Functions
function isHeicUpload(file) {
  if (!file) return false;
  const filename = (file.name || '').toLowerCase();
  const mimetype = (file.type || '').toLowerCase();
  return (
    filename.endsWith('.heic') ||
    filename.endsWith('.heif') ||
    mimetype.startsWith('image/heic') ||
    mimetype.startsWith('image/heif')
  );
}

async function createPreviewUrl(file) {
  if (!isHeicUpload(file)) {
    const url = URL.createObjectURL(file);
    return {
      url,
      alt: 'Selected image preview'
    };
  }

  const formData = new FormData();
  formData.append('image', file, file.name || 'preview.heic');

  const response = await fetch(`${API_BASE}/images/preview`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Preview conversion failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  return {
    url,
    alt: 'Preview converted from HEIC source'
  };
}

async function updateUploadPreview(file) {
  const container = document.getElementById('upload-preview-container');
  const previewImage = document.getElementById('upload-preview-image');
  const spinner = document.getElementById('upload-preview-spinner');
  const errorEl = document.getElementById('upload-preview-error');

  if (!container || !previewImage) {
    return;
  }

  activeUploadPreviewToken += 1;
  const requestToken = activeUploadPreviewToken;

  const hideSpinner = () => {
    if (spinner) {
      spinner.classList.add('hidden');
    }
  };

  const showSpinner = () => {
    if (spinner) {
      spinner.classList.remove('hidden');
    }
  };

  const hideError = () => {
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  };

  const showError = message => {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
  };

  if (currentUploadPreviewUrl) {
    URL.revokeObjectURL(currentUploadPreviewUrl);
    currentUploadPreviewUrl = null;
  }

  previewImage.classList.add('hidden');
  previewImage.removeAttribute('src');
  previewImage.onload = null;
  previewImage.onerror = null;
  previewImage.alt = 'Upload preview';
  hideSpinner();
  hideError();

  if (!file) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  showSpinner();

  try {
    const { url, alt } = await createPreviewUrl(file);

    if (requestToken !== activeUploadPreviewToken) {
      URL.revokeObjectURL(url);
      return;
    }

    currentUploadPreviewUrl = url;
    previewImage.alt = alt;
    previewImage.onload = () => {
      if (requestToken !== activeUploadPreviewToken) {
        return;
      }
      hideSpinner();
      hideError();
      previewImage.classList.remove('hidden');
      if (currentUploadPreviewUrl === url) {
        URL.revokeObjectURL(url);
        currentUploadPreviewUrl = null;
      }
    };
    previewImage.onerror = () => {
      if (requestToken !== activeUploadPreviewToken) {
        return;
      }
      hideSpinner();
      previewImage.classList.add('hidden');
      showError('Preview unavailable.');
      if (currentUploadPreviewUrl === url) {
        URL.revokeObjectURL(url);
        currentUploadPreviewUrl = null;
      }
    };

    previewImage.src = url;
  } catch (error) {
    console.error('Upload preview failed:', error);
    if (requestToken !== activeUploadPreviewToken) {
      return;
    }
    hideSpinner();
    previewImage.classList.add('hidden');
    showError('Preview unavailable.');
  }
}

// Track active upload XHR for cancellation
let activeUploadXhr = null;

function initUploadForm() {
  const form = document.getElementById('upload-form');
  if (!form) return;

  const fileInput = document.getElementById('image-file');
  const clearFileBtn = document.getElementById('clear-file-btn');
  
  if (fileInput) {
    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      await updateUploadPreview(file);
      
      // Detect image orientation and update matte dropdown
      if (file) {
        detectImageOrientation(file).then(isPortrait => {
          currentUploadIsPortrait = isPortrait;
          updateMatteOptionsForOrientation('matte-select', isPortrait);
        });
      } else {
        // No file - show all mattes (default to landscape)
        currentUploadIsPortrait = false;
        updateMatteOptionsForOrientation('matte-select', false);
      }
      
      // Check for duplicates if a file was selected
      if (file) {
        const result = await checkForDuplicates(file);
        showDuplicateWarning(result.duplicates);
      } else {
        showDuplicateWarning([]);
      }
      
      // Show/hide clear button based on file selection
      if (clearFileBtn) {
        clearFileBtn.classList.toggle('hidden', !file);
      }
    });
  }

  if (clearFileBtn && fileInput) {
    clearFileBtn.addEventListener('click', async () => {
      fileInput.value = '';
      await updateUploadPreview(null);
      showDuplicateWarning([]);
      clearFileBtn.classList.add('hidden');
      // Reset matte options to show all
      currentUploadIsPortrait = false;
      updateMatteOptionsForOrientation('matte-select', false);
    });
  }

  form.addEventListener('reset', () => {
    updateUploadPreview(null);
    showDuplicateWarning([]);
    if (clearFileBtn) clearFileBtn.classList.add('hidden');
    // Reset matte options to show all
    currentUploadIsPortrait = false;
    updateMatteOptionsForOrientation('matte-select', false);
  });
  updateUploadPreview(null);

  // Cancel button handler
  const cancelBtn = document.getElementById('upload-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (activeUploadXhr) {
        activeUploadXhr.abort();
        activeUploadXhr = null;
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    // Always use uploadAppliedTags as the authoritative source for tags.
    // The tags-input text box has name="tags" in HTML, so its raw text would otherwise
    // be submitted even if the user never clicked "Add" — causing unintended tags.
    formData.delete('tags');
    if (uploadAppliedTags.length > 0) {
      formData.append('tags', uploadAppliedTags.join(', '));
    }
    const statusDiv = document.getElementById('upload-status');
    const submitButton = form.querySelector('button[type="submit"]');
    const progressContainer = document.getElementById('upload-progress-container');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressText = document.getElementById('upload-progress-text');
    
    // Reset and show progress UI
    statusDiv.innerHTML = '';
    submitButton.disabled = true;
    submitButton.style.display = 'none';
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressBar.classList.remove('success', 'error');
    progressText.textContent = 'Uploading... 0%';

    // Create XHR for progress tracking
    const xhr = new XMLHttpRequest();
    activeUploadXhr = xhr;

    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = percent + '%';
        progressText.textContent = `Uploading... ${percent}%`;
      }
    });

    // Handle completion
    xhr.addEventListener('load', async () => {
      activeUploadXhr = null;
      
      try {
        const result = JSON.parse(xhr.responseText);
        
        if (xhr.status >= 200 && xhr.status < 300 && result.success) {
          // Show success state briefly
          progressBar.style.width = '100%';
          progressBar.classList.add('success');
          progressText.textContent = 'Upload complete!';
          
          // Set sort to Date Added, descending (newest first) BEFORE navigation
          sortAscending = false;
          const sortOrderSelect = document.getElementById('sort-order');
          if (sortOrderSelect) {
            sortOrderSelect.value = 'date';
            const event = new Event('change', { bubbles: true });
            sortOrderSelect.dispatchEvent(event);
          }
          updateSortDirectionIcon();
          const orderValue = sortOrderSelect ? sortOrderSelect.value : 'date';
          saveSortPreference(orderValue, sortAscending);
          
          // Brief delay to show success, then reset and navigate
          setTimeout(async () => {
            // Reset form for next use
            form.reset();
            resetUploadProgressUI(submitButton, progressContainer, progressBar);
            
            // Clear upload applied tags and attributes
            uploadAppliedTags = [];
            renderUploadAppliedTags();
            renderUploadTvTagsHelper();
            renderUploadAttributes();
            renderUploadEntities();
            
            // Reload tags in case new ones were added
            await loadTags();
            
            // Refresh similar groups and filter count
            await fetchSimilarGroups();
            await fetchSimilarBreakpoints();
            await loadTagsForFilter();
            
            // Close upload modal and return to gallery
            navigateTo('/');

            // Fetch fresh image data so the new image appears in gallery
            await loadGallery();
            // Refresh entity instances so any newly created entity appears in the modal
            await loadEntities();

            // Re-render gallery if special filter is active
            if (similarFilterActive) {
              renderGallery();
            }
            
            // Trigger auto-sync
            await manualSync();
          }, 500);
        } else {
          // Server returned error
          progressBar.classList.add('error');
          progressText.textContent = 'Upload failed';
          statusDiv.innerHTML = `<div class="error">Upload failed: ${result.error || 'Unknown error'}</div>`;
          resetUploadProgressUI(submitButton, progressContainer, progressBar);
        }
      } catch (parseError) {
        // JSON parse error
        progressBar.classList.add('error');
        progressText.textContent = 'Upload failed';
        statusDiv.innerHTML = '<div class="error">Upload failed: Invalid server response</div>';
        resetUploadProgressUI(submitButton, progressContainer, progressBar);
      }
    });

    // Handle network errors
    xhr.addEventListener('error', () => {
      activeUploadXhr = null;
      progressBar.classList.add('error');
      progressText.textContent = 'Upload failed';
      statusDiv.innerHTML = '<div class="error">Upload failed: Network error</div>';
      resetUploadProgressUI(submitButton, progressContainer, progressBar);
    });

    // Handle cancellation
    xhr.addEventListener('abort', () => {
      activeUploadXhr = null;
      statusDiv.innerHTML = '<div class="info">Upload cancelled</div>';
      resetUploadProgressUI(submitButton, progressContainer, progressBar);
    });

    // Append custom attribute values as JSON
    const attributeValues = collectUploadAttributes();
    if (attributeValues) {
      formData.append('attributesJson', JSON.stringify(attributeValues));
    }

    // Append entity data as JSON
    const entityValues = collectUploadEntities();
    if (entityValues) {
      formData.append('entityDataJson', JSON.stringify(entityValues));
    }

    // Send the request
    xhr.open('POST', `${API_BASE}/images/upload`);
    xhr.send(formData);
  });

  // Initialize upload tags functionality
  initUploadTags();
}

// Render custom attribute inputs in the upload form
function renderUploadAttributes() {
  const section = document.getElementById('upload-attributes-section');
  if (!section) return;

  if (!allAttributes || allAttributes.length === 0) {
    section.style.display = 'none';
    section.innerHTML = '';
    return;
  }

  section.style.display = '';
  section.innerHTML = allAttributes.map(attrName => `
    <div class="modal-attribute-row">
      <label class="modal-attribute-label">${escapeHtml(attrName)}:</label>
      <input type="text" class="modal-attribute-input upload-attribute-input" data-attribute="${escapeHtml(attrName)}" value="" placeholder="" />
    </div>
  `).join('');
}

// Collect current custom attribute values from the upload form
function collectUploadAttributes() {
  if (!allAttributes || allAttributes.length === 0) return null;
  const result = {};
  document.querySelectorAll('#upload-attributes-section .upload-attribute-input').forEach(input => {
    result[input.dataset.attribute] = input.value;
  });
  return result;
}

// Helper to reset upload progress UI
function resetUploadProgressUI(submitButton, progressContainer, progressBar) {
  submitButton.disabled = false;
  submitButton.style.display = '';
  progressContainer.classList.add('hidden');
  progressBar.style.width = '0%';
  progressBar.classList.remove('success', 'error');
}

// Track applied tags for upload form
let uploadAppliedTags = [];

// Initialize upload tags - suggested tags and applied tags
function initUploadTags() {
  const addTagsBtn = document.getElementById('upload-add-tags-btn');
  const tagsInput = document.getElementById('tags-input');
  
  if (addTagsBtn && tagsInput) {
    addTagsBtn.addEventListener('click', () => {
      addUploadTags();
    });
    
    tagsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addUploadTags();
      }
    });
  }
  
  // Render initial state
  renderUploadTvTagsHelper();
  renderUploadAppliedTags();
}

// Add tags from upload form input
function addUploadTags() {
  const tagsInput = document.getElementById('tags-input');
  if (!tagsInput) return;
  
  const inputValue = tagsInput.value;
  const tags = inputValue.split(',').map(t => t.trim()).filter(t => t);
  
  if (tags.length === 0) return;
  
  // Add new tags to applied list (avoiding case-insensitive duplicates)
  uploadAppliedTags = mergeTagsCaseInsensitive(uploadAppliedTags, tags);
  
  // Clear input
  tagsInput.value = '';
  
  // Update hidden form field with comma-separated tags
  updateUploadTagsFormField();
  
  // Re-render
  renderUploadAppliedTags();
  renderUploadTvTagsHelper();
}

// Update the hidden tags input field with current applied tags
function updateUploadTagsFormField() {
  // We need to update what gets submitted - the tags-input now just adds tags
  // So we create/update a hidden field with the actual tags
  let hiddenField = document.getElementById('upload-tags-hidden');
  if (!hiddenField) {
    hiddenField = document.createElement('input');
    hiddenField.type = 'hidden';
    hiddenField.id = 'upload-tags-hidden';
    hiddenField.name = 'tags';
    const form = document.getElementById('upload-form');
    if (form) form.appendChild(hiddenField);
  }
  hiddenField.value = uploadAppliedTags.join(', ');
  
  // Remove name from original input so it doesn't conflict
  const tagsInput = document.getElementById('tags-input');
  if (tagsInput) tagsInput.removeAttribute('name');
}

// Add a tag from the suggested helper
function addUploadTagFromHelper(tagName) {
  if (!uploadAppliedTags.includes(tagName)) {
    uploadAppliedTags.push(tagName);
    updateUploadTagsFormField();
    renderUploadAppliedTags();
    renderUploadTvTagsHelper();
  }
}

// Remove a tag from upload applied tags
function removeUploadTag(tagName) {
  uploadAppliedTags = uploadAppliedTags.filter(t => t !== tagName);
  updateUploadTagsFormField();
  renderUploadAppliedTags();
  renderUploadTvTagsHelper();
}

// Render the TV tags helper for upload form (suggested tags)
function renderUploadTvTagsHelper() {
  const container = document.getElementById('upload-tv-tags-helper');
  const wrapper = document.getElementById('upload-tv-tags-wrapper');
  if (!container) return;

  // Get all TV tags (not dependent on currentImage)
  const tvTags = getAllTvTags();

  // Filter out tags that are already applied
  const suggestedTvTags = tvTags.filter(item => !uploadAppliedTags.includes(item.tag));

  // Get all TV tag names for filtering
  const tvTagNames = new Set(tvTags.map(t => t.tag));

  // Get non-TV tags: all tags minus TV tags minus applied tags
  const otherTags = (allTags || [])
    .filter(tag => !tvTagNames.has(tag) && !uploadAppliedTags.includes(tag))
    .sort();

  if (suggestedTvTags.length === 0 && otherTags.length === 0) {
    container.innerHTML = '';
    if (wrapper) wrapper.style.display = 'none';
    return;
  }

  if (wrapper) wrapper.style.display = 'block';

  // Render TV tags with badges
  const tvPillsHtml = suggestedTvTags.map(item => {
    const excludeClass = item.allExclude ? ' exclude' : '';
    const excludeCount = item.excludeTvNames.length;
    const hasExcludes = excludeCount > 0;

    // Build tooltip showing all TV names
    const tooltipParts = [];
    if (item.includeTvNames.length > 0) {
      tooltipParts.push(item.includeTvNames.join(', '));
    }
    if (item.excludeTvNames.length > 0) {
      tooltipParts.push(item.excludeTvNames.map(n => `${n} (exclude)`).join(', '));
    }
    const tooltip = tooltipParts.join(', ');

    // Build TV label
    let tvLabelHtml;
    if (item.totalTvs === 1) {
      const tvName = item.includeTvNames[0] || item.excludeTvNames[0];
      const prefix = item.allExclude ? 'ex:' : '';
      tvLabelHtml = `<span class="tv-name">${escapeHtml(prefix + tvName)}</span>`;
    } else if (item.allExclude) {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    } else if (hasExcludes) {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
    } else {
      tvLabelHtml = `<span class="tv-name">${item.totalTvs} TVs</span>`;
    }

    return `<button type="button" class="tv-tag-pill${excludeClass}" data-tag="${escapeHtml(item.tag)}" title="${escapeHtml(tooltip)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(item.tag)}</span>
      ${tvLabelHtml}
    </button>`;
  }).join('');

  // Render non-TV tags without badges
  const otherPillsHtml = otherTags.map(tag => {
    return `<button type="button" class="tv-tag-pill" data-tag="${escapeHtml(tag)}" tabindex="-1">
      <span class="tag-label">${escapeHtml(tag)}</span>
    </button>`;
  }).join('');

  container.innerHTML = tvPillsHtml + otherPillsHtml;

  // Add click handlers
  container.querySelectorAll('.tv-tag-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      pill.blur();
      const tag = pill.dataset.tag;
      addUploadTagFromHelper(tag);
    });
  });
}

// Render the applied tags for upload form
function renderUploadAppliedTags() {
  const container = document.getElementById('upload-applied-tags');
  if (!container) return;
  
  if (uploadAppliedTags.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  const tagsHtml = uploadAppliedTags.map(tag => {
    // Get TV matches for this tag (reuse existing function)
    const tvMatches = getTvMatchesForTag(tag);
    let tooltip = '';
    let tvInfoHtml = '';
    
    if (tvMatches.length > 0) {
      const matchStrings = tvMatches
        .sort((a, b) => a.tvName.localeCompare(b.tvName))
        .map(m => m.isExclude ? `${m.tvName} (exclude)` : m.tvName);
      tooltip = matchStrings.join(', ');
      
      // Build compact TV info display
      const excludeCount = tvMatches.filter(m => m.isExclude).length;
      const allExclude = excludeCount === tvMatches.length;
      const someExclude = excludeCount > 0 && !allExclude;
      
      let tvLabel;
      let colorClass = '';
      
      if (tvMatches.length === 1) {
        tvLabel = tvMatches[0].isExclude ? `ex:${tvMatches[0].tvName}` : tvMatches[0].tvName;
        if (tvMatches[0].isExclude) colorClass = ' tv-info-exclude';
      } else if (allExclude) {
        tvLabel = `${tvMatches.length} TVs`;
        colorClass = ' tv-info-exclude';
      } else if (someExclude) {
        // Show "X TVs (Y ex)" with Y ex in red
        tvInfoHtml = `<span class="tag-tv-info">${tvMatches.length} TVs <span class="tv-info-exclude">(${excludeCount} ex)</span></span>`;
      } else {
        tvLabel = `${tvMatches.length} TVs`;
      }
      
      // Only build tvInfoHtml if not already set (for partial exclude case)
      if (!tvInfoHtml) {
        // Truncate to keep tags uniform width
        if (tvLabel.length > 12) {
          tvLabel = tvLabel.substring(0, 11) + '…';
        }
        tvInfoHtml = `<span class="tag-tv-info${colorClass}">${escapeHtml(tvLabel)}</span>`;
      }
    }
    
    const hasMatchClass = tvMatches.length > 0 ? ' has-tv-match' : '';
    
    return `<div class="tag-item${hasMatchClass}" onclick="removeUploadTag('${escapeHtml(tag)}')" ${tooltip ? `title="${escapeHtml(tooltip)}"` : 'title="Click to remove"'}>
      <div class="tag-content">
        <span class="tag-name">${escapeHtml(tag)}</span>
        ${tvInfoHtml}
      </div>
      <span class="tag-remove">×</span>
    </div>`;
  }).join('');
  
  container.innerHTML = tagsHtml;
}

// Batch Upload Functions
function initBatchUploadForm() {
  const batchUploadBtn = document.getElementById('open-batch-upload-btn');
  
  if (batchUploadBtn) {
    batchUploadBtn.addEventListener('click', () => {
      // Create a file input that allows multiple selection
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';
      
      // Attach to DOM - required for iOS to reliably deliver multi-select files
      document.body.appendChild(fileInput);
      
      fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        // Clean up input after getting files
        fileInput.remove();
        
        if (files.length === 0) return;
        
        await uploadBatchImages(files);
      });
      
      // Trigger file picker
      fileInput.click();
    });
  }
}

// Helper function to format file size in human-readable format
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

async function uploadBatchImages(files) {
  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB in bytes
  const UPLOAD_TIMEOUT_MS = 120000; // 2 minute timeout per file
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  const skippedFiles = [];
  const errorFiles = []; // Track files that failed with error details
  const uploadedFilenames = []; // Track successfully uploaded filenames (server names with hash)
  const uploadedOriginalNames = {}; // Map server filename -> original filename
  const totalFiles = files.length;
  let cancelled = false;
  
  console.log(`[BatchUpload] Starting upload of ${totalFiles} files`);
  
  // Show progress indicator in gallery with progress bar
  const grid = document.getElementById('image-grid');
  const progressDiv = document.createElement('div');
  progressDiv.className = 'loading batch-upload-progress';
  progressDiv.style.fontSize = '1rem';
  progressDiv.style.padding = '30px';
  progressDiv.innerHTML = `
    <div style="margin-bottom: 12px;">Uploading ${totalFiles} image${totalFiles !== 1 ? 's' : ''}...</div>
    <div style="font-size: 1.3rem; font-weight: bold; margin-bottom: 10px;">0 / ${totalFiles}</div>
    <div class="batch-progress-bar-wrapper" style="width: 100%; max-width: 300px; height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; margin: 0 auto 10px;">
      <div class="batch-progress-bar" style="width: 0%; height: 100%; background: #4a90d9; transition: width 0.15s ease;"></div>
    </div>
    <div class="batch-progress-file" style="font-size: 0.85rem; color: #666; margin-bottom: 8px;"></div>
    <div class="batch-status-detail" style="font-size: 0.8rem; color: #888; margin-bottom: 12px; max-height: 100px; overflow-y: auto; text-align: left; max-width: 400px; margin-left: auto; margin-right: auto;"></div>
    <button class="batch-cancel-btn btn-secondary" style="padding: 6px 16px; font-size: 0.9rem;">Cancel</button>
  `;
  grid.innerHTML = '';
  grid.appendChild(progressDiv);
  
  const counterEl = progressDiv.querySelector('div:nth-child(2)');
  const progressBar = progressDiv.querySelector('.batch-progress-bar');
  const statusDetail = progressDiv.querySelector('.batch-status-detail');
  const fileLabel = progressDiv.querySelector('.batch-progress-file');
  const cancelBtn = progressDiv.querySelector('.batch-cancel-btn');
  
  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    cancelBtn.textContent = 'Cancelling...';
    cancelBtn.disabled = true;
    console.log('[BatchUpload] User cancelled upload');
  });
  
  // Helper to add status line
  const addStatusLine = (text, isError = false) => {
    const line = document.createElement('div');
    line.textContent = text;
    line.style.color = isError ? '#c0392b' : '#27ae60';
    statusDetail.insertBefore(line, statusDetail.firstChild);
    // Keep only last 10 status lines
    while (statusDetail.children.length > 10) {
      statusDetail.removeChild(statusDetail.lastChild);
    }
  };
  
  // Upload each file with XHR for progress
  for (let i = 0; i < files.length; i++) {
    if (cancelled) {
      console.log(`[BatchUpload] Skipping remaining ${files.length - i} files due to cancellation`);
      break;
    }
    
    const file = files[i];
    const shortName = file.name.length > 30 ? file.name.substring(0, 27) + '...' : file.name;
    
    console.log(`[BatchUpload] Processing file ${i + 1}/${totalFiles}: ${file.name} (${formatFileSize(file.size)})`);
    
    // Check file size before uploading
    if (file.size > MAX_FILE_SIZE) {
      skippedCount++;
      skippedFiles.push({
        name: file.name,
        size: formatFileSize(file.size)
      });
      console.warn(`[BatchUpload] Skipped ${file.name}: ${formatFileSize(file.size)} exceeds 20MB limit`);
      addStatusLine(`⊘ ${shortName} - too large`, true);
      
      const completedCount = i + 1;
      counterEl.textContent = `${completedCount} / ${totalFiles}`;
      continue;
    }
    
    // Show current file being uploaded
    fileLabel.textContent = `Uploading: ${shortName}`;
    progressBar.style.width = '0%';
    
    const uploadStartTime = Date.now();
    try {
      const result = await uploadSingleFileWithProgress(file, (percent) => {
        progressBar.style.width = `${percent}%`;
      }, UPLOAD_TIMEOUT_MS);
      
      const uploadDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      
      if (result.success) {
        successCount++;
        if (result.filename) {
          uploadedFilenames.push(result.filename);
        }
        console.log(`[BatchUpload] ✓ ${file.name} uploaded successfully in ${uploadDuration}s`);
        addStatusLine(`✓ ${shortName}`);
      } else {
        errorCount++;
        const errorMsg = result.error || 'Unknown error';
        errorFiles.push({ name: file.name, error: errorMsg });
        console.error(`[BatchUpload] ✗ Failed to upload ${file.name}:`, errorMsg);
        addStatusLine(`✗ ${shortName} - ${errorMsg}`, true);
      }
      
      const completedCount = i + 1;
      counterEl.textContent = `${completedCount} / ${totalFiles}`;
      progressBar.style.width = '100%';
      
    } catch (error) {
      errorCount++;
      const errorMsg = error.message || 'Unknown error';
      errorFiles.push({ name: file.name, error: errorMsg });
      console.error(`[BatchUpload] ✗ Error uploading ${file.name}:`, error);
      addStatusLine(`✗ ${shortName} - ${errorMsg}`, true);
      
      const completedCount = i + 1;
      counterEl.textContent = `${completedCount} / ${totalFiles}`;
    }
  }
  
  console.log(`[BatchUpload] Completed: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped`);
  
  fileLabel.textContent = '';
  
  // Build summary message
  let summaryParts = [];
  
  if (successCount > 0) {
    summaryParts.push(`${successCount} image${successCount !== 1 ? 's' : ''} uploaded successfully`);
  }
  
  if (skippedCount > 0) {
    summaryParts.push(`${skippedCount} skipped (over 20MB limit)`);
  }
  
  if (errorCount > 0) {
    summaryParts.push(`${errorCount} failed`);
  }
  
  if (cancelled) {
    const remaining = totalFiles - (successCount + errorCount + skippedCount);
    if (remaining > 0) {
      summaryParts.push(`${remaining} cancelled`);
    }
  }
  
  // Show result summary if there were issues
  if (skippedCount > 0 || errorCount > 0 || cancelled) {
    let message = 'Batch upload completed:\n\n' + summaryParts.join('\n');
    
    if (skippedFiles.length > 0) {
      message += '\n\nSkipped files (over 20MB):';
      skippedFiles.forEach(file => {
        message += `\n• ${file.name} (${file.size})`;
      });
    }
    
    if (errorFiles.length > 0) {
      message += '\n\nFailed files:';
      errorFiles.forEach(file => {
        message += `\n• ${file.name}: ${file.error}`;
      });
    }
    
    alert(message);
  }
  
  if (successCount > 0) {
    setGallerySortToNewestFirst();
  }

  // Reload gallery and tags
  await loadGallery();
  await loadTags();
  
  // Refresh similar groups for filter counts
  if (uploadedFilenames.length > 0) {
    await fetchSimilarGroups();
    await fetchSimilarBreakpoints();
    // Refresh tag filter to show updated similar counts
    await loadTagsForFilter();
    
    // Re-render gallery if special filter is active (so new items appear)
    if (similarFilterActive) {
      renderGallery();
    }
    
    const similarFilenames = getSimilarFilenames();
    const uploadedSimilar = uploadedFilenames.filter(f => similarFilenames.has(f));
    
    // If any uploaded images are similar to existing images, show notification
    if (uploadedSimilar.length > 0) {
      // Find which existing images they are similar to
      const similarInfo = [];
      for (const filename of uploadedSimilar) {
        for (const group of similarGroups) {
          if (group.includes(filename)) {
            const others = group.filter(f => f !== filename);
            if (others.length > 0) {
              similarInfo.push(`${getBaseName(filename)} is similar to ${others.map(f => getBaseName(f)).join(', ')}`);
            }
            break;
          }
        }
      }
      
      if (similarInfo.length > 0) {
        alert(`Some uploaded images may be duplicates:\n\n${similarInfo.join('\n\n')}\n\nSelect "Similar Images" in the tag filter to investigate.`);
      }
    }
  }
  
  // Auto-select the uploaded images for easy batch tagging
  if (uploadedFilenames.length > 0) {
    selectedImages.clear();
    uploadedFilenames.forEach(filename => {
      selectedImages.add(filename);
    });
    // Use lightweight visual update instead of full re-render to prevent scroll flickering
    updateGallerySelectionVisual();
  }
  
  // Trigger auto-sync
  await manualSync();
}

// Upload a single file with XHR progress tracking
function uploadSingleFileWithProgress(file, onProgress, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('image', file);
    formData.append('matte', 'none');
    formData.append('filter', 'none');
    formData.append('tags', '');
    
    // Set timeout for the request
    xhr.timeout = timeoutMs;
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        onProgress(percent);
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          resolve(result);
        } catch (e) {
          resolve({ success: false, error: 'Invalid server response' });
        }
      } else {
        // Handle HTTP errors
        let errorMsg = `Server error (${xhr.status})`;
        try {
          const errorResult = JSON.parse(xhr.responseText);
          if (errorResult.error) {
            errorMsg = errorResult.error;
          }
        } catch (e) {
          // Use default error message
        }
        resolve({ success: false, error: errorMsg });
      }
    });
    
    xhr.addEventListener('error', () => {
      reject(new Error('Network error - check your connection'));
    });
    
    xhr.addEventListener('timeout', () => {
      reject(new Error('Upload timed out - file may be too large or connection too slow'));
    });
    
    xhr.addEventListener('abort', () => {
      resolve({ success: false, error: 'Cancelled' });
    });
    
    xhr.open('POST', `${API_BASE}/images/upload`);
    xhr.send(formData);
  });
}

// Tag Management
async function loadTVs() {
  try {
    const response = await fetch(`${API_BASE}/ha/tvs`);
    const data = await response.json();
    if (data.success) {
      // Store TVs array
      if (Array.isArray(data.tvs)) {
        allTVs = data.tvs;
      }
      // Store global tagsets (name -> definition)
      if (data.tagsets && typeof data.tagsets === 'object') {
        allGlobalTagsets = data.tagsets;
      }
      // Refresh filter dropdown if it's already rendered (to update counts)
      // Pass skipRender: true to prevent gallery re-render during periodic updates
      const dropdownOptions = document.querySelector('.multiselect-options');
      if (dropdownOptions && dropdownOptions.children.length > 0) {
        loadTagsForFilter({ skipRender: true });
      }
      // Update TV status dots
      renderTVStatusDots();
    }
  } catch (error) {
    console.error('Error loading TVs:', error);
  }
}

async function loadTags() {
  try {
    const response = await fetch(`${API_BASE}/tags`);
    allTags = await response.json();
  } catch (error) {
    console.error('Error loading tags:', error);
  }
}

async function loadAttributes() {
  try {
    const response = await fetch(`${API_BASE}/attributes`);
    allAttributes = await response.json();
    renderUploadAttributes();
  } catch (error) {
    console.error('Error loading attributes:', error);
  }
}

async function loadEntities() {
  try {
    const response = await fetch(`${API_BASE}/entities/with-instances`);
    const data = await response.json();
    allEntityTypes = data.entityTypes || [];
    allEntityInstances = data.entityInstances || {};
    allCustomDataOrder = data.customDataOrder || [];
    renderUploadEntities();
  } catch (error) {
    console.error('Error loading entities:', error);
  }
}

// Count images that match a TV's include/exclude tag criteria
function countImagesForTV(tv) {
  const includeTags = tv.tags || [];
  const excludeTags = tv.exclude_tags || [];
  
  let count = 0;
  for (const [filename, data] of Object.entries(allImages)) {
    const imageTagSet = new Set(data.tags || []);
    
    // Check include tags: if set, image must have at least one
    if (includeTags.length > 0 && !includeTags.some(tag => imageTagSet.has(tag))) {
      continue;
    }
    
    // Check exclude tags: if set, image must not have any
    if (excludeTags.length > 0 && excludeTags.some(tag => imageTagSet.has(tag))) {
      continue;
    }
    
    count++;
  }
  return count;
}

// Count images that have a specific tag
function countImagesForTag(tag) {
  let count = 0;
  for (const [filename, data] of Object.entries(allImages)) {
    const imageTags = data.tags || [];
    if (imageTags.includes(tag)) {
      count++;
    }
  }
  return count;
}

// Count images that don't match any TV's criteria
function countImagesForNone() {
  let count = 0;
  for (const [filename, data] of Object.entries(allImages)) {
    const imageTagSet = new Set(data.tags || []);
    let matchesAnyTV = false;
    
    for (const tv of allTVs) {
      const includeTags = tv.tags || [];
      const excludeTags = tv.exclude_tags || [];
      
      // Check include tags: if set, image must have at least one
      if (includeTags.length > 0 && !includeTags.some(tag => imageTagSet.has(tag))) {
        continue;
      }
      
      // Check exclude tags: if set, image must not have any
      if (excludeTags.length > 0 && excludeTags.some(tag => imageTagSet.has(tag))) {
        continue;
      }
      
      // Image matches this TV
      matchesAnyTV = true;
      break;
    }
    
    if (!matchesAnyTV) {
      count++;
    }
  }
  return count;
}

/**
 * Load tags for the filter dropdown and rebuild the UI.
 * @param {Object} options - Options for the load
 * @param {boolean} options.skipRender - If true, don't re-render gallery (used for count updates)
 */
async function loadTagsForFilter(options = {}) {
  const { skipRender = false } = options;
  
  try {
    // *** SAVE CURRENT FILTER STATE BEFORE REBUILDING ***
    // This preserves user selections when the dropdown is rebuilt (e.g., after tag count updates)
    const savedState = {
      includedTags: new Set(getIncludedTags().map(t => t.toLowerCase())),
      excludedTags: new Set(getExcludedTags().map(t => t.toLowerCase())),
      checkedTVs: new Set(Array.from(document.querySelectorAll('.tv-checkbox:checked')).map(cb => cb.value)),
      checkedTagsets: new Set(Array.from(document.querySelectorAll('.tagset-checkbox:checked')).map(cb => cb.value)),
      noneChecked: document.querySelector('.tv-none-checkbox')?.checked || false,
      // Special filters are stored in global variables, no need to save/restore
    };
    const hadSelections = savedState.includedTags.size > 0 || savedState.excludedTags.size > 0 || 
                          savedState.checkedTVs.size > 0 || savedState.checkedTagsets.size > 0 || savedState.noneChecked;
    
    const response = await fetch(`${API_BASE}/tags`);
    allTags = await response.json();

    allTags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const dropdownOptions = document.querySelector('.multiselect-options');
    if (!dropdownOptions) {
      return;
    }

    let html = '';

    // Special Filters Section (at top)
    html += `<div class="tv-shortcuts-header">Filters</div>`;
    
    // Similar Images filter
    const { dupeCount, simCount } = getSimilarBreakpointCounts();
    html += `
      <div class="multiselect-option tv-shortcut similar-filter">
        <input type="checkbox" id="filter-similar" 
               value="similar" 
               class="similar-checkbox"
               ${similarFilterActive ? 'checked' : ''}>
        <label for="filter-similar">
          <div class="tv-name">Similar Images <span class="tv-count">(${dupeCount}dup/${simCount}sim)</span></div>
          <div class="tv-tags-subtitle">Find duplicates and visually similar images</div>
        </label>
      </div>
    `;
    
    // Portrait filter
    const portraitCount = countPortraitImages();
    html += `
      <div class="multiselect-option tv-shortcut portrait-filter">
        <input type="checkbox" id="filter-portrait" 
               value="portrait" 
               class="portrait-checkbox"
               ${portraitFilterActive ? 'checked' : ''}>
        <label for="filter-portrait">
          <div class="tv-name">Portrait <span class="tv-count">(${portraitCount})</span></div>
          <div class="tv-tags-subtitle">Images where height > width</div>
        </label>
      </div>
    `;
    
    // Non 16:9 filter
    const non169Count = countNon169Images();
    html += `
      <div class="multiselect-option tv-shortcut non169-filter">
        <input type="checkbox" id="filter-non169" 
               value="non169" 
               class="non169-checkbox"
               ${non169FilterActive ? 'checked' : ''}>
        <label for="filter-non169">
          <div class="tv-name">Landscape (Non 16:9) <span class="tv-count">(${non169Count})</span></div>
          <div class="tv-tags-subtitle">Landscape images that are not 16:9</div>
        </label>
      </div>
    `;
    
    // Recently Displayed filter (at bottom of special filters)
    const recentCount = getRecentlyDisplayedFilenames().size;
    html += `
      <div class="multiselect-option tv-shortcut recently-displayed-filter">
        <input type="checkbox" id="filter-recently-displayed" 
               value="recently-displayed" 
               class="recently-displayed-checkbox"
               ${recentlyDisplayedFilterActive ? 'checked' : ''}>
        <label for="filter-recently-displayed">
          <div class="tv-name">Recently Displayed <span class="tv-count">(${recentCount})</span></div>
          <div class="tv-tags-subtitle">Current and previous images on each TV</div>
        </label>
      </div>
    `;
    
    html += `<div class="tv-shortcuts-divider"></div>`;

    // TV Shortcuts Section
    if (allTVs.length > 0) {
      html += `<div class="tv-shortcuts-header">TVs</div>`;
      
      // None filter at top of TVs
      const noneCount = countImagesForNone();
      html += `
        <div class="multiselect-option tv-shortcut">
          <input type="checkbox" id="tv-shortcut-none" 
                 value="none" 
                 class="tv-none-checkbox">
          <label for="tv-shortcut-none">
            <div class="tv-name">None <span class="tv-count">(${noneCount})</span></div>
            <div class="tv-tags-subtitle">Will not shuffle onto any TV</div>
          </label>
        </div>
      `;
      
      html += allTVs.map(tv => {
        const safeTags = JSON.stringify(tv.tags || []).replace(/"/g, '&quot;');
        const id = tv.device_id || tv.entity_id;
        
        // Count images that match this TV's criteria
        const matchCount = countImagesForTV(tv);
        
        // Get active tagset name (override takes precedence)
        const activeTagset = tv.override_tagset || tv.selected_tagset;
        
        let subtitleHtml = '';
        if (activeTagset) {
          subtitleHtml += `<div class="tv-tags-subtitle">Tagset: ${escapeHtml(activeTagset)}</div>`;
        }
        if (tv.tags && tv.tags.length > 0) {
          subtitleHtml += `<div class="tv-tags-subtitle">+ ${tv.tags.join(', ')}</div>`;
        }
        if (tv.exclude_tags && tv.exclude_tags.length > 0) {
          subtitleHtml += `<div class="tv-tags-subtitle">- ${tv.exclude_tags.join(', ')}</div>`;
        }

        return `
        <div class="multiselect-option tv-shortcut">
          <input type="checkbox" id="tv-shortcut-${id}" 
                 value="${id}" 
                 class="tv-checkbox"
                 data-tags="${safeTags}">
          <label for="tv-shortcut-${id}">
            <div class="tv-name">${escapeHtml(tv.name)} <span class="tv-count">(${matchCount})</span></div>
            ${subtitleHtml}
          </label>
        </div>
      `}).join('');
      html += `<div class="tv-shortcuts-divider"></div>`;
    }
    
    // Tagsets Section
    const tagsetNames = Object.keys(allGlobalTagsets || {});
    if (tagsetNames.length > 0) {
      html += `<div class="tv-shortcuts-header">Tagsets</div>`;
      
      html += tagsetNames.map(tagsetName => {
        const tagset = allGlobalTagsets[tagsetName];
        const includeTags = tagset.tags || [];
        const excludeTags = tagset.exclude_tags || [];
        const safeIncludeTags = JSON.stringify(includeTags).replace(/"/g, '&quot;');
        const safeExcludeTags = JSON.stringify(excludeTags).replace(/"/g, '&quot;');
        
        // Count images that match this tagset's criteria
        let matchCount = 0;
        for (const [filename, data] of Object.entries(allImages)) {
          const imageTagSet = new Set(data.tags || []);
          if (includeTags.length > 0 && !includeTags.some(tag => imageTagSet.has(tag))) {
            continue;
          }
          if (excludeTags.length > 0 && excludeTags.some(tag => imageTagSet.has(tag))) {
            continue;
          }
          matchCount++;
        }
        
        let subtitleHtml = '';
        if (includeTags.length > 0) {
          subtitleHtml += `<div class="tv-tags-subtitle">+ ${includeTags.join(', ')}</div>`;
        }
        if (excludeTags.length > 0) {
          subtitleHtml += `<div class="tv-tags-subtitle">- ${excludeTags.join(', ')}</div>`;
        }
        if (!subtitleHtml) {
          subtitleHtml = `<div class="tv-tags-subtitle">All images (no filter)</div>`;
        }

        return `
        <div class="multiselect-option tv-shortcut">
          <input type="checkbox" id="tagset-shortcut-${escapeHtml(tagsetName)}" 
                 value="${escapeHtml(tagsetName)}" 
                 class="tagset-checkbox"
                 data-include-tags="${safeIncludeTags}"
                 data-exclude-tags="${safeExcludeTags}">
          <label for="tagset-shortcut-${escapeHtml(tagsetName)}">
            <div class="tv-name">${escapeHtml(tagsetName)} <span class="tv-count">(${matchCount})</span></div>
            ${subtitleHtml}
          </label>
        </div>
      `}).join('');
      html += `<div class="tv-shortcuts-divider"></div>`;
    }
    
    // Tags Section
    html += `<div class="tags-header">Tags</div>`;
    html += allTags.map(tag => {
      const safeValue = tag.replace(/"/g, '&quot;');
      const tagCount = countImagesForTag(tag);
      return `
      <div class="multiselect-option" data-state="unchecked">
        <input type="checkbox" value="${safeValue}" class="tag-checkbox" data-state="unchecked">
        <label>${escapeHtml(tag)} <span class="tv-count">(${tagCount})</span></label>
      </div>
    `}).join('');

    dropdownOptions.innerHTML = html;

    // Add listeners for tags (three-state: unchecked → included → excluded → unchecked)
    const checkboxes = dropdownOptions.querySelectorAll('.tag-checkbox');
    checkboxes.forEach(checkbox => {
      const option = checkbox.closest('.multiselect-option');
      
      // Handle click on checkbox or label to cycle through states
      const cycleTagState = (e) => {
        e.stopPropagation();
        
        const currentState = checkbox.dataset.state || 'unchecked';
        let newState;
        
        // Cycle: unchecked → included → excluded → unchecked
        if (currentState === 'unchecked') {
          newState = 'included';
        } else if (currentState === 'included') {
          newState = 'excluded';
        } else {
          newState = 'unchecked';
        }
        
        // Use setTimeout to let the native click complete first, then override
        setTimeout(() => {
          setTagState(checkbox, newState);
          
          // Clear "None" checkbox when manually selecting tags
          const noneCheckbox = document.querySelector('.tv-none-checkbox');
          if (noneCheckbox) {
            noneCheckbox.checked = false;
          }
          
          // Clear special filters when selecting tags
          clearSimilarFilter();
          clearPortraitFilter();
          clearNon169Filter();
          clearRecentlyDisplayedFilter();
          
          updateTagFilterDisplay();
          updateTVShortcutStates();
        }, 0);
      };
      
      checkbox.addEventListener('click', cycleTagState);
      
      const label = checkbox.nextElementSibling;
      if (label) {
        label.addEventListener('click', (e) => {
          e.preventDefault();
          cycleTagState(e);
        });
      }
    });

    // Add listeners for TV shortcuts
    const tvCheckboxes = dropdownOptions.querySelectorAll('.tv-checkbox');
    tvCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => handleTVShortcutChange(e));
    });

    // Add listeners for Tagset shortcuts
    const tagsetCheckboxes = dropdownOptions.querySelectorAll('.tagset-checkbox');
    tagsetCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => handleTagsetShortcutChange(e));
    });

    // Add listener for "None" checkbox
    const noneCheckbox = dropdownOptions.querySelector('.tv-none-checkbox');
    if (noneCheckbox) {
      noneCheckbox.addEventListener('change', (e) => handleNoneShortcutChange(e));
    }

    // Add listener for "Recently Displayed" checkbox
    const recentlyDisplayedCheckbox = dropdownOptions.querySelector('.recently-displayed-checkbox');
    if (recentlyDisplayedCheckbox) {
      recentlyDisplayedCheckbox.addEventListener('change', async (e) => {
        const wasActive = recentlyDisplayedFilterActive;
        recentlyDisplayedFilterActive = e.target.checked;
        
        if (recentlyDisplayedFilterActive && !wasActive) {
          // Save current sort state before entering recently displayed filter mode
          const sortOrderSelect = document.getElementById('sort-order');
          preRecentSortState = {
            order: sortOrderSelect ? sortOrderSelect.value : 'date',
            ascending: sortAscending
          };
          
          // Fetch fresh recently displayed data
          await fetchRecentlyDisplayed();
          
          // Clear other filters when enabling recently displayed filter
          const noneCheckbox = document.querySelector('.tv-none-checkbox');
          if (noneCheckbox) noneCheckbox.checked = false;
          clearSimilarFilter();
          clearPortraitFilter();
          clearNon169Filter();
          // Clear tag selections
          document.querySelectorAll('.tag-checkbox').forEach(cb => setTagState(cb, 'unchecked'));
          document.querySelectorAll('.tv-checkbox').forEach(cb => { cb.checked = false; });
        } else if (!recentlyDisplayedFilterActive && wasActive) {
          // Restore previous sort state
          if (preRecentSortState) {
            const sortOrderSelect = document.getElementById('sort-order');
            if (sortOrderSelect) sortOrderSelect.value = preRecentSortState.order;
            sortAscending = preRecentSortState.ascending;
            updateSortDirectionIcon();
            preRecentSortState = null;
          }
        }
        
        updateTagFilterDisplay();
        filterAndRenderGallery();
        // Close dropdown after selecting special filter
        if (!DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
          closeTagDropdownPortal();
        }
      });
    }

    // Add listener for "Similar Images" checkbox
    const similarCheckbox = dropdownOptions.querySelector('.similar-checkbox');
    if (similarCheckbox) {
      similarCheckbox.addEventListener('change', async (e) => {
        const wasActive = similarFilterActive;
        similarFilterActive = e.target.checked;
        
        if (similarFilterActive && !wasActive) {
          // Save current sort state before entering similar filter mode
          const sortOrderSelect = document.getElementById('sort-order');
          preSimilarSortState = {
            order: sortOrderSelect ? sortOrderSelect.value : 'date',
            ascending: sortAscending
          };
          // Switch to date sort, descending (newest first) for similar view
          if (sortOrderSelect) sortOrderSelect.value = 'date';
          sortAscending = false;
          updateSortDirectionIcon();
          
          // Fetch fresh similar data and breakpoints
          await Promise.all([
            fetchSimilarGroups(),
            fetchSimilarBreakpoints()
          ]);
          // Clear other filters when enabling similar filter
          const noneCheckbox = document.querySelector('.tv-none-checkbox');
          if (noneCheckbox) noneCheckbox.checked = false;
          // Clear portrait filter
          clearPortraitFilter();
          // Clear non-16:9 filter
          clearNon169Filter();
          // Clear recently displayed filter
          clearRecentlyDisplayedFilter();
          // Clear tag selections
          document.querySelectorAll('.tag-checkbox').forEach(cb => setTagState(cb, 'unchecked'));
          document.querySelectorAll('.tv-checkbox').forEach(cb => { cb.checked = false; });
        } else if (!similarFilterActive && wasActive) {
          // Restore previous sort state
          if (preSimilarSortState) {
            const sortOrderSelect = document.getElementById('sort-order');
            if (sortOrderSelect) sortOrderSelect.value = preSimilarSortState.order;
            sortAscending = preSimilarSortState.ascending;
            updateSortDirectionIcon();
            preSimilarSortState = null;
          }
        }
        
        updateTagFilterDisplay();
        filterAndRenderGallery();
        // Close dropdown after selecting special filter
        if (!DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
          closeTagDropdownPortal();
        }
      });
    }

    // Add listener for "Portrait" checkbox
    const portraitCheckbox = dropdownOptions.querySelector('.portrait-checkbox');
    if (portraitCheckbox) {
      portraitCheckbox.addEventListener('change', (e) => {
        portraitFilterActive = e.target.checked;
        
        if (portraitFilterActive) {
          // Clear other filters when enabling portrait filter
          const noneCheckbox = document.querySelector('.tv-none-checkbox');
          if (noneCheckbox) noneCheckbox.checked = false;
          // Clear similar filter
          clearSimilarFilter();
          // Clear non-16:9 filter
          clearNon169Filter();
          // Clear recently displayed filter
          clearRecentlyDisplayedFilter();
          // Clear tag selections
          document.querySelectorAll('.tag-checkbox').forEach(cb => setTagState(cb, 'unchecked'));
          document.querySelectorAll('.tv-checkbox').forEach(cb => { cb.checked = false; });
        }
        
        updateTagFilterDisplay();
        filterAndRenderGallery();
        // Close dropdown after selecting special filter
        if (!DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
          closeTagDropdownPortal();
        }
      });
    }

    // Add listener for "Non 16:9" checkbox
    const non169Checkbox = dropdownOptions.querySelector('.non169-checkbox');
    if (non169Checkbox) {
      non169Checkbox.addEventListener('change', (e) => {
        non169FilterActive = e.target.checked;
        
        if (non169FilterActive) {
          // Clear other filters when enabling non-16:9 filter
          const noneCheckbox = document.querySelector('.tv-none-checkbox');
          if (noneCheckbox) noneCheckbox.checked = false;
          // Clear similar filter
          clearSimilarFilter();
          // Clear portrait filter
          clearPortraitFilter();
          // Clear recently displayed filter
          clearRecentlyDisplayedFilter();
          // Clear tag selections
          document.querySelectorAll('.tag-checkbox').forEach(cb => setTagState(cb, 'unchecked'));
          document.querySelectorAll('.tv-checkbox').forEach(cb => { cb.checked = false; });
        }
        
        updateTagFilterDisplay();
        filterAndRenderGallery();
        // Close dropdown after selecting special filter
        if (!DEBUG_ALWAYS_SHOW_TAG_DROPDOWN) {
          closeTagDropdownPortal();
        }
      });
    }

    // *** RESTORE SAVED FILTER STATE ***
    if (hadSelections) {
      console.log('[TagFilter] Restoring filter state after rebuild');
      
      // Restore tag states
      document.querySelectorAll('.tag-checkbox').forEach(cb => {
        const tagLower = cb.value.toLowerCase();
        if (savedState.includedTags.has(tagLower)) {
          setTagState(cb, 'included');
        } else if (savedState.excludedTags.has(tagLower)) {
          setTagState(cb, 'excluded');
        }
      });
      
      // Restore TV checkbox states
      document.querySelectorAll('.tv-checkbox').forEach(cb => {
        cb.checked = savedState.checkedTVs.has(cb.value);
      });
      
      // Restore tagset checkbox states
      document.querySelectorAll('.tagset-checkbox').forEach(cb => {
        cb.checked = savedState.checkedTagsets.has(cb.value);
      });
      
      // Restore "None" checkbox state
      const noneCheckbox = document.querySelector('.tv-none-checkbox');
      if (noneCheckbox) {
        noneCheckbox.checked = savedState.noneChecked;
      }
    }

    // Skip render if:
    // 1. Caller explicitly requested skipRender (e.g., periodic count updates)
    // 2. We're restoring saved state (filter hasn't actually changed)
    const shouldSkipRender = skipRender || hadSelections;
    // Correct TV/tagset shortcut checkboxes BEFORE rendering, so the gallery
    // reads consistent checkbox state (e.g., virtual-tag TVs/tagsets are unchecked).
    updateTVShortcutStates();
    updateTagFilterDisplay(shouldSkipRender);
  } catch (error) {
    console.error('Error loading tags for filter:', error);
  }
}

function getTagCheckbox(tagName) {
  // Case-insensitive search for tag checkbox by value
  const checkboxes = Array.from(document.querySelectorAll('.tag-checkbox'));
  return checkboxes.find(cb => cb.value.toLowerCase() === tagName.toLowerCase());
}

// Set a tag checkbox to one of three states: unchecked, included, excluded
function setTagState(checkbox, state) {
  const option = checkbox.closest('.multiselect-option');
  
  checkbox.dataset.state = state;
  if (option) {
    option.dataset.state = state;
  }
  
  // We don't actually use the checked property for display anymore,
  // but keep it somewhat in sync for any code that might check it
  if (state === 'unchecked') {
    checkbox.checked = false;
  } else {
    checkbox.checked = true;
  }
}

// Get the current state of a tag checkbox
function getTagState(checkbox) {
  return checkbox.dataset.state || 'unchecked';
}

/**
 * Clear the similar filter and restore sort state if it was active.
 * Call this when any other filter (tags, None, TV shortcuts) is selected.
 */
function clearSimilarFilter() {
  if (!similarFilterActive) return;
  
  // Uncheck the similar checkbox in the UI
  const similarCheckbox = document.querySelector('.similar-checkbox');
  if (similarCheckbox) {
    similarCheckbox.checked = false;
  }
  
  // Restore previous sort state
  if (preSimilarSortState) {
    const sortOrderSelect = document.getElementById('sort-order');
    if (sortOrderSelect) sortOrderSelect.value = preSimilarSortState.order;
    sortAscending = preSimilarSortState.ascending;
    updateSortDirectionIcon();
    preSimilarSortState = null;
  }
  
  similarFilterActive = false;
}

/**
 * Clear the Non 16:9 filter.
 * Call this when any other filter (tags, None, TV shortcuts, similar) is selected.
 */
function clearNon169Filter() {
  if (!non169FilterActive) return;
  
  // Uncheck the non169 checkbox in the UI
  const non169Checkbox = document.querySelector('.non169-checkbox');
  if (non169Checkbox) {
    non169Checkbox.checked = false;
  }
  
  non169FilterActive = false;
}

/**
 * Clear the Portrait filter.
 * Call this when any other filter (tags, None, TV shortcuts, similar, non-16:9) is selected.
 */
function clearPortraitFilter() {
  if (!portraitFilterActive) return;
  
  // Uncheck the portrait checkbox in the UI
  const portraitCheckbox = document.querySelector('.portrait-checkbox');
  if (portraitCheckbox) {
    portraitCheckbox.checked = false;
  }
  
  portraitFilterActive = false;
}

// Get all included tags
function getIncludedTags() {
  const checkboxes = document.querySelectorAll('.tag-checkbox');
  return Array.from(checkboxes)
    .filter(cb => getTagState(cb) === 'included')
    .map(cb => cb.value);
}

// Get all excluded tags
function getExcludedTags() {
  const checkboxes = document.querySelectorAll('.tag-checkbox');
  return Array.from(checkboxes)
    .filter(cb => getTagState(cb) === 'excluded')
    .map(cb => cb.value);
}

function handleTVShortcutChange(event) {
  const tvCheckbox = event.target;
  const tvId = tvCheckbox.value;
  
  // Find the TV object to get both include and exclude tags
  const tv = allTVs.find(t => (t.device_id || t.entity_id) === tvId);
  if (!tv) return;
  
  const includeTags = tv.tags || [];
  const excludeTags = tv.exclude_tags || [];
  const isChecked = tvCheckbox.checked;
  
  // Clear "None" checkbox when selecting a TV
  const noneCheckbox = document.querySelector('.tv-none-checkbox');
  if (noneCheckbox) {
    noneCheckbox.checked = false;
  }
  
  // Clear tagset checkboxes (mutually exclusive)
  const allTagsetCheckboxes = document.querySelectorAll('.tagset-checkbox');
  allTagsetCheckboxes.forEach(cb => cb.checked = false);
  
  // Clear special filters when selecting a TV shortcut
  clearSimilarFilter();
  clearPortraitFilter();
  clearNon169Filter();
  clearRecentlyDisplayedFilter();
  
  // Clear all tag states first
  const allTagCheckboxes = document.querySelectorAll('.tag-checkbox');
  allTagCheckboxes.forEach(cb => setTagState(cb, 'unchecked'));
  
  if (isChecked) {
    // Set include tags to 'included' state
    includeTags.forEach(tag => {
      const tagCheckbox = getTagCheckbox(tag);
      if (tagCheckbox) {
        setTagState(tagCheckbox, 'included');
      }
    });
    
    // Set exclude tags to 'excluded' state
    excludeTags.forEach(tag => {
      const tagCheckbox = getTagCheckbox(tag);
      if (tagCheckbox) {
        setTagState(tagCheckbox, 'excluded');
      }
    });
  }
  
  updateTagFilterDisplay();
  filterAndRenderGallery();
}

function handleTagsetShortcutChange(event) {
  const tagsetCheckbox = event.target;
  const tagsetName = tagsetCheckbox.value;
  
  // Get include/exclude tags from data attributes
  let includeTags = [];
  let excludeTags = [];
  try {
    includeTags = JSON.parse(tagsetCheckbox.dataset.includeTags || '[]');
    excludeTags = JSON.parse(tagsetCheckbox.dataset.excludeTags || '[]');
  } catch (e) {
    console.error('Error parsing tagset tags:', e);
  }
  
  const isChecked = tagsetCheckbox.checked;
  
  // Clear "None" checkbox when selecting a tagset
  const noneCheckbox = document.querySelector('.tv-none-checkbox');
  if (noneCheckbox) {
    noneCheckbox.checked = false;
  }
  
  // Clear TV checkboxes (mutually exclusive)
  const allTvCheckboxes = document.querySelectorAll('.tv-checkbox');
  allTvCheckboxes.forEach(cb => cb.checked = false);
  
  // Clear other tagset checkboxes (mutually exclusive)
  const allTagsetCheckboxes = document.querySelectorAll('.tagset-checkbox');
  allTagsetCheckboxes.forEach(cb => {
    if (cb !== tagsetCheckbox) cb.checked = false;
  });
  
  // Clear special filters when selecting a tagset shortcut
  clearSimilarFilter();
  clearPortraitFilter();
  clearNon169Filter();
  clearRecentlyDisplayedFilter();
  
  // Clear all tag states first
  const allTagCheckboxes = document.querySelectorAll('.tag-checkbox');
  allTagCheckboxes.forEach(cb => setTagState(cb, 'unchecked'));
  
  if (isChecked) {
    // Set include tags to 'included' state
    includeTags.forEach(tag => {
      const tagCheckbox = getTagCheckbox(tag);
      if (tagCheckbox) {
        setTagState(tagCheckbox, 'included');
      }
    });
    
    // Set exclude tags to 'excluded' state
    excludeTags.forEach(tag => {
      const tagCheckbox = getTagCheckbox(tag);
      if (tagCheckbox) {
        setTagState(tagCheckbox, 'excluded');
      }
    });
  }
  
  updateTagFilterDisplay();
  filterAndRenderGallery();
}

function handleNoneShortcutChange(event) {
  const noneCheckbox = event.target;
  const isChecked = noneCheckbox.checked;
  
  if (isChecked) {
    // Clear all TV shortcuts when selecting "None"
    const allTvCheckboxes = document.querySelectorAll('.tv-checkbox');
    allTvCheckboxes.forEach(cb => cb.checked = false);
    
    // Clear all tagset shortcuts when selecting "None"
    const allTagsetCheckboxes = document.querySelectorAll('.tagset-checkbox');
    allTagsetCheckboxes.forEach(cb => cb.checked = false);
    
    // Reset all tag checkboxes to unchecked state
    const allTagCheckboxes = document.querySelectorAll('.tag-checkbox');
    allTagCheckboxes.forEach(cb => setTagState(cb, 'unchecked'));
    
    // Clear special filters when selecting None
    clearSimilarFilter();
    clearPortraitFilter();
    clearNon169Filter();
    clearRecentlyDisplayedFilter();
  }
  
  updateTagFilterDisplay();
  filterAndRenderGallery();
}

function updateTVShortcutStates() {
  // Get currently included and excluded tags (lowercase for comparison)
  const includedTags = getIncludedTags().map(t => t.toLowerCase());
  const excludedTags = getExcludedTags().map(t => t.toLowerCase());
  const includedTagsSet = new Set(includedTags);
  const excludedTagsSet = new Set(excludedTags);

  // Create a Set of all available tags (lowercase)
  const availableTagsSet = new Set(
    Array.from(document.querySelectorAll('.tag-checkbox')).map(cb => cb.value.toLowerCase())
  );

  // Update TV checkboxes
  const tvCheckboxes = document.querySelectorAll('.tv-checkbox');
  
  tvCheckboxes.forEach(tvCheckbox => {
    const tvId = tvCheckbox.value;
    const tv = allTVs.find(t => (t.device_id || t.entity_id) === tvId);
    
    if (!tv) {
      tvCheckbox.checked = false;
      tvCheckbox.indeterminate = false;
      return;
    }
    
    const rawTvIncludeTags = (tv.tags || []).map(tag => tag.toLowerCase());
    const tvIncludeTags = rawTvIncludeTags.filter(tag => availableTagsSet.has(tag));
    const tvExcludeTags = (tv.exclude_tags || []).map(tag => tag.toLowerCase()).filter(tag => availableTagsSet.has(tag));

    // If the TV's tagset has tags but none are real library tags (all virtual), it
    // cannot match any real filter state — skip rather than false-matching empty filter.
    if (rawTvIncludeTags.length > 0 && tvIncludeTags.length === 0) {
      tvCheckbox.checked = false;
      tvCheckbox.indeterminate = false;
      return;
    }

    // EXACT match: same size AND same contents (bidirectional)
    const includeMatch =
      tvIncludeTags.length === includedTagsSet.size &&
      tvIncludeTags.every(tag => includedTagsSet.has(tag)) &&
      includedTags.every(tag => tvIncludeTags.includes(tag));
    
    const excludeMatch = 
      tvExcludeTags.length === excludedTagsSet.size &&
      tvExcludeTags.every(tag => excludedTagsSet.has(tag)) &&
      excludedTags.every(tag => tvExcludeTags.includes(tag));
    
    if (includeMatch && excludeMatch) {
      tvCheckbox.checked = true;
      tvCheckbox.indeterminate = false;
    } else {
      tvCheckbox.checked = false;
      tvCheckbox.indeterminate = false;
    }
  });

  // Update Tagset checkboxes
  const tagsetCheckboxes = document.querySelectorAll('.tagset-checkbox');
  
  tagsetCheckboxes.forEach(tagsetCheckbox => {
    const tagsetName = tagsetCheckbox.value;
    const tagset = allGlobalTagsets?.[tagsetName];
    
    if (!tagset) {
      tagsetCheckbox.checked = false;
      return;
    }
    
    const rawTagsetIncludeTags = (tagset.tags || []).map(tag => tag.toLowerCase());
    const tagsetIncludeTags = rawTagsetIncludeTags.filter(tag => availableTagsSet.has(tag));
    const tagsetExcludeTags = (tagset.exclude_tags || []).map(tag => tag.toLowerCase()).filter(tag => availableTagsSet.has(tag));

    // If the tagset has tags but none are real library tags (all virtual), it
    // cannot match any real filter state — skip rather than false-matching empty filter.
    if (rawTagsetIncludeTags.length > 0 && tagsetIncludeTags.length === 0) {
      tagsetCheckbox.checked = false;
      return;
    }

    // EXACT match: same size AND same contents (bidirectional)
    const includeMatch =
      tagsetIncludeTags.length === includedTagsSet.size &&
      tagsetIncludeTags.every(tag => includedTagsSet.has(tag)) &&
      includedTags.every(tag => tagsetIncludeTags.includes(tag));
    
    const excludeMatch = 
      tagsetExcludeTags.length === excludedTagsSet.size &&
      tagsetExcludeTags.every(tag => excludedTagsSet.has(tag)) &&
      excludedTags.every(tag => tagsetExcludeTags.includes(tag));
    
    if (includeMatch && excludeMatch) {
      tagsetCheckbox.checked = true;
    } else {
      tagsetCheckbox.checked = false;
    }
  });
}

function updateTagFilterDisplay(skipRender = false) {
  const includedTags = getIncludedTags();
  const excludedTags = getExcludedTags();
  const noneCheckbox = document.querySelector('.tv-none-checkbox');
  const noneSelected = noneCheckbox && noneCheckbox.checked;
  const buttonText = document.getElementById('tag-filter-text');
  const clearBtn = document.getElementById('clear-tag-filter-btn');
  
  let label = 'All Tags';
  let showClear = false;

  if (recentlyDisplayedFilterActive) {
    label = 'Recently Displayed';
    showClear = true;
  } else if (similarFilterActive) {
    label = 'Similar Images';
    showClear = true;
  } else if (portraitFilterActive) {
    label = 'Portrait';
    showClear = true;
  } else if (non169FilterActive) {
    label = 'Non 16:9';
    showClear = true;
  } else if (noneSelected) {
    label = 'None';
    showClear = true;
  } else if (includedTags.length > 0 || excludedTags.length > 0) {
    // Build label with includes and excludes (excludes prefixed with -)
    const parts = [];
    parts.push(...includedTags);
    parts.push(...excludedTags.map(t => `-${t}`));
    label = parts.join(', ');
    showClear = true;
  }

  if (buttonText) {
    buttonText.textContent = label;
  }

  if (clearBtn) {
    clearBtn.style.display = showClear ? 'block' : 'none';
  }
  
  // Only re-render gallery if explicitly requested (not during periodic count updates)
  if (!skipRender) {
    renderGallery();
  }
}

// Wrapper to filter and render gallery (used for async filter changes)
function filterAndRenderGallery() {
  renderGallery();
}

// Image Editing Helpers
const MIN_CROP_PERCENT = 4;
const CROP_RATIO_TOLERANCE = 0.001;
const CROP_PRESET_MATCH_TOLERANCE = 0.02;
const CROP_PRESET_DETAILS = {
  '1:1': { ratio: 1 },
  '4:3': { ratio: 4 / 3 },
  '3:2': { ratio: 3 / 2 },
  '16:9': { ratio: 16 / 9 },
  '16:9sam': { ratio: 16 / 9, targetResolution: { width: 3840, height: 2160 } }
};

const CROP_PRESET_RATIOS = Object.fromEntries(
  Object.entries(CROP_PRESET_DETAILS).map(([preset, detail]) => [preset, detail.ratio])
);

const CROP_INSET_EPSILON = 0.0001;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Calculate the largest axis-aligned inscribed rectangle after rotation.
 * When an image is rotated by an arbitrary angle, the corners extend beyond
 * the original bounds. This function computes the largest rectangle that
 * fits entirely within the rotated image without showing any background.
 * 
 * @param {number} width - Original image width
 * @param {number} height - Original image height  
 * @param {number} angleDegrees - Rotation angle in degrees
 * @returns {{ width: number, height: number, scale: number }} Inscribed dimensions and scale factor
 */
function getInscribedDimensions(width, height, angleDegrees) {
  if (!width || !height) return { width: 0, height: 0, scale: 1 };
  if (Math.abs(angleDegrees) < 0.01) return { width, height, scale: 1 };
  
  const angle = Math.abs(angleDegrees) * Math.PI / 180;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  
  // For a W×H rectangle rotated by angle θ around its center,
  // the largest inscribed axis-aligned rectangle (same aspect ratio) is:
  // 
  // The rotated corners extend beyond original bounds, creating black triangles.
  // The inscribed rectangle must avoid these corners.
  //
  // For the inscribed rectangle that maintains the original aspect ratio:
  // scale = 1 / (cosA + sinA * max(aspectRatio, 1/aspectRatio))
  // But we need separate scales for width and height when aspect ratios differ.
  //
  // Correct formula for inscribed rectangle in rotated rectangle:
  const W = width;
  const H = height;
  
  // The inscribed rectangle dimensions (maintaining original aspect ratio):
  // inscribed_W = W * cos(θ) - H * sin(θ)  -- but only works when positive
  // inscribed_H = H * cos(θ) - W * sin(θ)  -- but only works when positive
  //
  // These can go negative for large angles, so we use the proper formula:
  // The scale factor for same-aspect-ratio inscribed rectangle is:
  const denom = cosA + sinA * Math.max(W/H, H/W);
  const scale = 1 / denom;
  
  let inscribedWidth = width * scale;
  let inscribedHeight = height * scale;
  
  // Ensure positive dimensions
  inscribedWidth = Math.max(1, Math.floor(inscribedWidth));
  inscribedHeight = Math.max(1, Math.floor(inscribedHeight));
  
  return { 
    width: inscribedWidth, 
    height: inscribedHeight,
    scale: Math.max(0.1, scale)
  };
}

/**
 * Get the effective dimensions for crop calculations, accounting for rotation.
 * Returns the inscribed rectangle dimensions if rotation is applied.
 */
function getEffectiveCropDimensions() {
  const { naturalWidth, naturalHeight, rotation } = editState;
  if (!naturalWidth || !naturalHeight) return { width: 0, height: 0, scale: 1 };
  
  return getInscribedDimensions(naturalWidth, naturalHeight, rotation);
}

function initImageEditor() {
  if (editControls) return;

  const modalImage = document.getElementById('modal-image');
  const toolbar = document.getElementById('image-edit-toolbar');
  const stage = document.getElementById('modal-image-stage');
  if (!modalImage || !toolbar || !stage) return;

  editControls = {
    modalImage,
    stage,
    toolbar: {
      root: toolbar,
      editBtn: document.getElementById('toolbar-edit-btn'),
      applyBtn: document.getElementById('toolbar-apply-btn'),
      cancelBtn: document.getElementById('toolbar-cancel-btn'),
      showTvBtn: document.getElementById('modal-show-tv-btn'),
      toolButtons: Array.from(toolbar.querySelectorAll('.toolbar-icon-btn[data-tool]')),
      toolGroup: toolbar.querySelector('.toolbar-group-tools'),
      divider: toolbar.querySelector('.toolbar-divider'),
      previewToggleBtn: document.getElementById('toolbar-preview-toggle-btn')
    },
    revertBtn: document.getElementById('revert-original-btn'),
    popovers: {
      container: document.getElementById('edit-popover-container'),
      adjustments: document.getElementById('adjustments-popover'),
      filters: document.getElementById('filters-popover'),
      crop: document.getElementById('crop-popover')
    },
    adjustments: {
      brightnessInput: document.getElementById('adjust-brightness'),
      contrastInput: document.getElementById('adjust-contrast'),
      brightnessValue: document.getElementById('adjust-brightness-value'),
      contrastValue: document.getElementById('adjust-contrast-value'),
      hueInput: document.getElementById('adjust-hue'),
      saturationInput: document.getElementById('adjust-saturation'),
      lightnessInput: document.getElementById('adjust-lightness'),
      hueValue: document.getElementById('adjust-hue-value'),
      saturationValue: document.getElementById('adjust-saturation-value'),
      lightnessValue: document.getElementById('adjust-lightness-value')
    },
    filters: {
      chips: Array.from(document.querySelectorAll('#filter-chip-row .filter-chip'))
    },
    crop: {
      overlay: document.getElementById('crop-overlay'),
      box: document.getElementById('crop-box'),
      handles: Array.from(document.querySelectorAll('#crop-box .crop-handle')),
      presetButtons: Array.from(document.querySelectorAll('#crop-popover .crop-preset')),
      warning: document.getElementById('crop-upsampling-warning')
    },
    rotation: {
      slider: document.getElementById('rotation-slider'),
      zeroBtn: document.getElementById('rotation-zero-btn')
    }
  };

  // Hide legacy edit panel elements
  document.getElementById('modal-edit-panel')?.classList.add('hidden');
  document.getElementById('open-edit-panel-btn')?.classList.add('hidden');
  document.querySelector('.image-edit-entry')?.classList.add('hidden');

  editControls.toolbar.editBtn?.addEventListener('click', () => {
    if (!currentImage) {
      setToolbarStatus('Open an image to start editing.', 'error');
      return;
    }
    if (editState.active) {
      return;
    }
    enterEditMode();
  });

  editControls.toolbar.applyBtn?.addEventListener('click', submitImageEdits);
  editControls.toolbar.cancelBtn?.addEventListener('click', cancelEdits);
  editControls.toolbar.previewToggleBtn?.addEventListener('click', () => {
    if (!editState.active) {
      return;
    }
    setPreviewEnabled(!editState.previewEnabled);
  });
  editControls.revertBtn?.addEventListener('click', revertImageToOriginal);
  editControls.revertBtn?.classList.add('hidden');

  editControls.toolbar.toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!editState.active) return;
      setActiveTool(btn.dataset.tool);
    });
  });

  editControls.adjustments.brightnessInput?.addEventListener('input', handleAdjustmentInput);
  editControls.adjustments.contrastInput?.addEventListener('input', handleAdjustmentInput);
  editControls.adjustments.hueInput?.addEventListener('input', handleAdjustmentInput);
  editControls.adjustments.saturationInput?.addEventListener('input', handleAdjustmentInput);
  editControls.adjustments.lightnessInput?.addEventListener('input', handleAdjustmentInput);

  editControls.filters.chips.forEach(chip => {
    chip.addEventListener('click', () => {
      if (!editState.active) return;
      selectFilter(chip.dataset.filter || 'none');
    });
  });

  editControls.crop.presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!editState.active) return;
      selectCropPreset(btn.dataset.crop || 'free');
    });
  });

  // Rotation slider event handlers
  editControls.rotation.slider?.addEventListener('input', handleRotationInput);
  editControls.rotation.zeroBtn?.addEventListener('click', resetRotation);

  // Prevent text/image selection during crop interactions
  const preventSelection = (e) => e.preventDefault();
  
  editControls.crop.box?.addEventListener('pointerdown', (event) => {
    if (!editState.active || editState.activeTool !== 'crop') return;
    // Only handle move if the target is the box itself, not a handle
    if (event.target.classList.contains('crop-handle')) return;
    startCropInteraction('move', 'move', event);
  });

  editControls.crop.handles.forEach(handle => {
    handle.addEventListener('pointerdown', (event) => {
      if (!editState.active || editState.activeTool !== 'crop') return;
      // Stop propagation immediately to prevent box from also receiving the event
      event.stopPropagation();
      startCropInteraction('resize', handle.dataset.handle, event);
    });
  });

  // Prevent selection on the modal image during any crop interaction
  modalImage.addEventListener('selectstart', preventSelection);
  modalImage.addEventListener('dragstart', preventSelection);

  // Prevent iOS Safari back gesture during crop interactions
  document.addEventListener('touchmove', (e) => {
    if (cropInteraction && e.touches.length === 1) {
      e.preventDefault();
    }
  }, { passive: false });

  modalImage.addEventListener('load', handleModalImageLoad);
  modalImage.addEventListener('error', handleModalImageError);
  window.addEventListener('resize', () => {
    if (editState.active) {
      updateCropOverlay();
    }
  });

  updateAdjustmentUI();
  updateFilterButtons(editState.filter);
  updateCropPresetButtons(editState.cropPreset);
  updateRotationUI();
  updateToolbarState();
  applyPreviewFilters();
}

function handleModalImageLoad() {
  if (!editControls?.modalImage) return;
  const img = editControls.modalImage;
  delete img.dataset.loadRetries;
  if (img.naturalWidth && img.naturalHeight) {
    editState.naturalWidth = img.naturalWidth;
    editState.naturalHeight = img.naturalHeight;
  }
  updateCropOverlay();
  if (editState.active && editState.activeTool === 'crop') {
    setActiveTool('crop', { force: true, silent: true });
  }
  applyPreviewFilters();
}

function handleModalImageError() {
  if (!editControls?.modalImage || !currentImage) return;
  const img = editControls.modalImage;
  const retries = Number(img.dataset.loadRetries || 0);

  if (retries >= 4) {
    setToolbarStatus('Preview failed to load. Close and reopen the modal to retry.', 'error');
    return;
  }

  img.dataset.loadRetries = String(retries + 1);
  const delay = 150 * (retries + 1);
  setTimeout(() => {
    reloadModalImage(Date.now() + retries + 1);
  }, delay);
}

function resetEditState(options = {}) {
  const {
    hasBackup = false,
    keepActive = false,
    keepPreset = false,
    keepDimensions = true,
    restoreTool = false,
    silent = false,
    initialPreset = null
  } = options;

  const previousTool = editState.activeTool;
  const previousPreset = editState.cropPreset;
  const preservedWidth = keepDimensions ? editState.naturalWidth : 0;
  const preservedHeight = keepDimensions ? editState.naturalHeight : 0;

  editState = createDefaultEditState();
  editState.hasBackup = hasBackup;
  if (keepDimensions) {
    editState.naturalWidth = preservedWidth;
    editState.naturalHeight = preservedHeight;
  }
  if (keepActive) {
    editState.active = true;
    if (restoreTool && previousTool) {
      editState.activeTool = previousTool;
    }
  }
  let targetPreset = null;
  if (keepPreset && previousPreset) {
    targetPreset = previousPreset;
  } else if (initialPreset) {
    targetPreset = initialPreset;
  }
  if (targetPreset) {
    editState.cropPreset = targetPreset;
    editState.targetResolution = getPresetTargetResolution(targetPreset);
  }

  editState.userSelectedCropPreset = false;
  editState.autoPresetApplied = false;

  editState.isDirty = false;

  updateAdjustmentUI();
  updateFilterButtons(editState.filter);
  updateCropPresetButtons(editState.cropPreset);
  updateRotationUI();
  applyRotationPreview();
  updateCropOverlay();
  updateToolbarState();
  if (!silent) {
    clearToolbarStatus();
  }
  if (editState.active && editState.activeTool) {
    setActiveTool(editState.activeTool, { force: true, silent: true });
  }
  applyPreviewFilters();
}

function updateToolbarState() {
  if (!editControls?.toolbar) return;
  const { editBtn, applyBtn, cancelBtn, toolButtons, previewToggleBtn, showTvBtn } = editControls.toolbar;
  const isActive = editState.active;
  const isMobile = window.innerWidth <= 768;
  
  // Add class to toolbar for CSS styling
  const toolbar = document.getElementById('image-edit-toolbar');
  if (toolbar) {
    toolbar.classList.toggle('editing-mode', isActive);
  }

  if (showTvBtn) {
    showTvBtn.classList.toggle('hidden', isActive);
  }

  if (editBtn) {
    const shouldDisable = !currentImage || isActive;
    editBtn.disabled = shouldDisable;
    editBtn.textContent = 'Edit';
    if (shouldDisable) {
      editBtn.setAttribute('aria-disabled', 'true');
    } else {
      editBtn.removeAttribute('aria-disabled');
    }
    // Hide Edit button on mobile when in edit mode
    if (isMobile) {
      editBtn.classList.toggle('hidden', isActive);
    }
  }

  if (editControls.toolbar.toolGroup) {
    editControls.toolbar.toolGroup.classList.toggle('hidden', !isActive);
  }

  if (editControls.toolbar.divider) {
    editControls.toolbar.divider.classList.toggle('hidden', !isActive);
  }

  if (previewToggleBtn) {
    const wasDisabled = previewToggleBtn.disabled;
    previewToggleBtn.disabled = !isActive;
    if (!isActive && !editState.previewEnabled) {
      setPreviewEnabled(true, { silent: true, force: true });
    } else if (!wasDisabled || isActive) {
      updatePreviewToggleUI();
    }
  }

  toolButtons?.forEach(btn => {
    const isCurrent = editState.activeTool === btn.dataset.tool;
    btn.disabled = !isActive;
    btn.classList.toggle('active', isActive && isCurrent);
  });

  if (cancelBtn) {
    cancelBtn.disabled = !isActive;
    cancelBtn.classList.toggle('hidden', !isActive);
  }
  if (applyBtn) {
    applyBtn.disabled = !isActive || !editState.isDirty;
    applyBtn.classList.toggle('hidden', !isActive);
  }
  if (editControls.revertBtn) {
    const hasBackup = !!editState.hasBackup;
    const showRevert = hasBackup && !isActive;
    editControls.revertBtn.disabled = !hasBackup;
    editControls.revertBtn.classList.toggle('hidden', !showRevert);
  }

  if (editControls.popovers?.container) {
    editControls.popovers.container.classList.toggle('hidden', !isActive);
  }

  if (!isActive) {
    hidePopovers();
  }
}

function setToolbarStatus(message, type = 'info') {
  if (!editControls?.toolbar?.status) return;
  const el = editControls.toolbar.status;
  el.textContent = message || '';
  el.classList.remove('error', 'success');
  if (!message) return;
  if (type === 'error') {
    el.classList.add('error');
  } else if (type === 'success') {
    el.classList.add('success');
  }
}

function clearToolbarStatus() {
  setToolbarStatus('');
}

function enterEditMode() {
  if (!editControls) return;
  editState.active = true;
  setPreviewEnabled(true, { silent: true, force: true });
  document.body.classList.add('editing-active');
  if (!editState.naturalWidth || !editState.naturalHeight) {
    const img = editControls.modalImage;
    if (img?.naturalWidth && img.naturalHeight) {
      editState.naturalWidth = img.naturalWidth;
      editState.naturalHeight = img.naturalHeight;
    }
  }
  updateToolbarState();
  
  // On mobile, auto-activate crop tool when entering edit mode
  const isMobile = window.innerWidth <= 768;
  if (isMobile && !editState.activeTool) {
    setActiveTool('crop', { force: true, silent: true });
  } else if (editState.activeTool) {
    setActiveTool(editState.activeTool, { force: true, silent: true });
  } else {
    hidePopovers();
    editControls.toolbar.toolButtons?.forEach(btn => btn.classList.remove('active'));
  }
  updateCropOverlay();
  applyPreviewFilters();
}

function exitEditMode(options = {}) {
  const { resetState = false } = options;
  if (!editControls) return;
  editState.active = false;
  setPreviewEnabled(true, { silent: true, force: true });
  document.body.classList.remove('editing-active');
  editState.activeTool = null;
  hidePopovers();
  updateToolbarState();
  updateCropOverlay();
  applyPreviewFilters();
  if (resetState) {
    const refreshedPreset = detectInitialCropPreset(allImages[currentImage]);
    resetEditState({ hasBackup: editState.hasBackup, keepDimensions: true, silent: true, initialPreset: refreshedPreset });
  }
}

function cancelEdits() {
  const hasBackup = editState.hasBackup;
  resetEditState({ hasBackup, keepDimensions: true });
  exitEditMode();
}

function setActiveTool(tool, options = {}) {
  if (!editControls?.toolbar) return;
  const { force = false, silent = false } = options;
  if (!editState.active) return;

  if (!tool) {
    editState.activeTool = null;
    editControls.toolbar.toolButtons.forEach(btn => btn.classList.remove('active'));
    hidePopovers();
    updateCropOverlay();
    return;
  }

  if (!force && editState.activeTool === tool) {
    editState.activeTool = null;
    hidePopovers();
    updateToolbarState();
    updateCropOverlay();
    return;
  }

  editState.activeTool = tool;
  editControls.toolbar.toolButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  showPopover(tool);
  if (tool === 'crop') {
    autoSelectCropPresetForCurrentImage();
  }
  updateCropOverlay();

  if (!silent) {
    if (tool === 'crop') {
      setToolbarStatus('Drag the handles or choose a preset to crop.');
    } else if (tool === 'adjust') {
      setToolbarStatus('Adjust brightness or contrast.');
    } else if (tool === 'filter') {
      setToolbarStatus('Pick a filter to preview.');
    }
  }
}

function showPopover(tool) {
  if (!editControls?.popovers) return;
  const { adjustments, filters, crop } = editControls.popovers;
  adjustments?.classList.add('hidden');
  filters?.classList.add('hidden');
  crop?.classList.add('hidden');

  if (tool === 'adjust') {
    adjustments?.classList.remove('hidden');
  } else if (tool === 'filter') {
    filters?.classList.remove('hidden');
  } else if (tool === 'crop') {
    crop?.classList.remove('hidden');
  }
}

function hidePopovers() {
  if (!editControls?.popovers) return;
  editControls.popovers.adjustments?.classList.add('hidden');
  editControls.popovers.filters?.classList.add('hidden');
  editControls.popovers.crop?.classList.add('hidden');
}

function updatePreviewToggleUI() {
  const btn = editControls?.toolbar?.previewToggleBtn;
  if (!btn) return;
  const previewOff = !editState.previewEnabled;
  btn.classList.toggle('preview-off', previewOff);
  btn.setAttribute('aria-pressed', previewOff ? 'true' : 'false');
  btn.title = previewOff ? 'Show Preview' : 'Hide Preview';
}

function setPreviewEnabled(enabled, options = {}) {
  const { silent = false, force = false } = options;
  if (!force && editState.previewEnabled === enabled) {
    updatePreviewToggleUI();
    return;
  }
  editState.previewEnabled = enabled;
  updatePreviewToggleUI();
  if (!silent) {
    if (enabled) {
      clearToolbarStatus();
    } else {
      setToolbarStatus('Preview hidden. Toggle the eye to view edits.', 'info');
    }
  }
  applyPreviewFilters();
  updateCropOverlay();
}

function handleAdjustmentInput(event) {
  const input = event.target;
  const value = Number(input.value) || 0;
  if (input.id === 'adjust-brightness') {
    editState.adjustments.brightness = value;
  } else if (input.id === 'adjust-contrast') {
    editState.adjustments.contrast = value;
  } else if (input.id === 'adjust-hue') {
    editState.adjustments.hue = clamp(value, -180, 180);
  } else if (input.id === 'adjust-saturation') {
    editState.adjustments.saturation = clamp(value, -100, 100);
  } else if (input.id === 'adjust-lightness') {
    editState.adjustments.lightness = clamp(value, -100, 100);
  }
  updateAdjustmentUI();
  markEditsDirty();
  applyPreviewFilters();
}

function updateAdjustmentUI() {
  if (!editControls?.adjustments) return;
  const {
    brightnessInput,
    contrastInput,
    hueInput,
    saturationInput,
    lightnessInput,
    brightnessValue,
    contrastValue,
    hueValue,
    saturationValue,
    lightnessValue
  } = editControls.adjustments;
  if (brightnessInput) {
    brightnessInput.value = editState.adjustments.brightness;
  }
  if (contrastInput) {
    contrastInput.value = editState.adjustments.contrast;
  }
  if (hueInput) {
    hueInput.value = editState.adjustments.hue;
  }
  if (saturationInput) {
    saturationInput.value = editState.adjustments.saturation;
  }
  if (lightnessInput) {
    lightnessInput.value = editState.adjustments.lightness;
  }
  if (brightnessValue) {
    brightnessValue.textContent = editState.adjustments.brightness;
  }
  if (contrastValue) {
    contrastValue.textContent = editState.adjustments.contrast;
  }
  if (hueValue) {
    hueValue.textContent = `${editState.adjustments.hue}°`;
  }
  if (saturationValue) {
    saturationValue.textContent = editState.adjustments.saturation;
  }
  if (lightnessValue) {
    lightnessValue.textContent = editState.adjustments.lightness;
  }
}

function handleRotationInput(event) {
  if (!editState.active) return;
  const value = Number(event.target.value) || 0;
  editState.rotation = clamp(value, -45, 45);
  updateRotationUI();
  markEditsDirty();
  applyRotationPreview();
  updateCropOverlay();
}

function resetRotation() {
  if (!editState.active) return;
  editState.rotation = 0;
  // Reset crop to full image since rotation constraint is removed
  editState.crop = { top: 0, right: 0, bottom: 0, left: 0 };
  updateRotationUI();
  markEditsDirty();
  applyRotationPreview();
  updateCropOverlay();
}

function updateRotationUI() {
  if (!editControls?.rotation) return;
  const { slider, zeroBtn } = editControls.rotation;
  
  if (slider) {
    slider.value = editState.rotation;
  }
  if (zeroBtn) {
    const isZero = Math.abs(editState.rotation) < 0.25;
    zeroBtn.classList.toggle('active', isZero);
    // Show current value in button, or "0°" when at zero
    if (isZero) {
      zeroBtn.textContent = '0°';
    } else {
      // Format: show 1 decimal if half-degree, otherwise integer
      const val = editState.rotation;
      const isHalf = Math.abs(val - Math.round(val)) > 0.1;
      zeroBtn.textContent = isHalf ? `${val.toFixed(1)}°` : `${Math.round(val)}°`;
    }
  }
}

function applyRotationPreview() {
  if (!editControls?.modalImage || !editControls?.stage) return;
  
  const img = editControls.modalImage;
  const stage = editControls.stage;
  const rotation = editState.rotation || 0;
  
  if (Math.abs(rotation) < 0.01) {
    // No rotation - reset transforms
    img.style.transform = '';
    stage.style.overflow = '';
  } else {
    // Apply rotation - black corners will be visible
    img.style.transform = `rotate(${rotation}deg)`;
    stage.style.overflow = 'visible';
  }
  
  // Constrain crop box to stay within the inscribed (valid) region
  constrainCropToInscribedRegion();
}

/**
 * Get the valid crop region as percentage bounds based on current rotation.
 * When rotated, the valid region is the inscribed rectangle (no black corners).
 * Returns { minLeft, minTop, maxRight, maxBottom } as percentages.
 */
function getValidCropRegion() {
  const rotation = editState.rotation || 0;
  
  if (Math.abs(rotation) < 0.01) {
    // No rotation - entire image is valid
    return { minLeft: 0, minTop: 0, maxRight: 0, maxBottom: 0 };
  }
  
  const { naturalWidth, naturalHeight } = editState;
  if (!naturalWidth || !naturalHeight) {
    return { minLeft: 0, minTop: 0, maxRight: 0, maxBottom: 0 };
  }
  
  const inscribed = getInscribedDimensions(naturalWidth, naturalHeight, rotation);
  
  // Calculate how much smaller the inscribed rectangle is as a ratio
  const widthRatio = inscribed.width / naturalWidth;
  const heightRatio = inscribed.height / naturalHeight;
  
  // The inscribed rectangle is centered, so margins are equal on both sides
  const marginX = (1 - widthRatio) / 2 * 100;
  const marginY = (1 - heightRatio) / 2 * 100;
  
  return {
    minLeft: marginX,
    minTop: marginY,
    maxRight: marginX,
    maxBottom: marginY
  };
}

/**
 * Constrain the current crop insets to stay within the valid inscribed region.
 * Called when rotation changes.
 * 
 * Crop insets represent how much is cut off each edge (0 = no crop, 50 = half cut).
 * When rotated, the minimum insets must be at least the inscribed bounds to avoid
 * showing black corners.
 */
function constrainCropToInscribedRegion() {
  const bounds = getValidCropRegion();
  const { crop } = editState;
  
  let needsUpdate = false;
  const newCrop = { ...crop };
  
  // Ensure crop insets are at least as large as the inscribed bounds
  // (crop.left < bounds.minLeft means the crop extends into black region)
  if (crop.left < bounds.minLeft) {
    newCrop.left = bounds.minLeft;
    needsUpdate = true;
  }
  if (crop.top < bounds.minTop) {
    newCrop.top = bounds.minTop;
    needsUpdate = true;
  }
  if (crop.right < bounds.maxRight) {
    newCrop.right = bounds.maxRight;
    needsUpdate = true;
  }
  if (crop.bottom < bounds.maxBottom) {
    newCrop.bottom = bounds.maxBottom;
    needsUpdate = true;
  }
  
  if (needsUpdate) {
    // Force immediate visual update
    editState.crop = newCrop;
    updateCropOverlay();
  }
}

function selectFilter(name, options = {}) {
  const filterName = normalizeEditingFilterName(name);
  editState.filter = filterName;
  updateFilterButtons(filterName);
  if (!options.silent) {
    markEditsDirty();
  }
  applyPreviewFilters();
}

function updateFilterButtons(activeFilter) {
  if (!editControls?.filters?.chips) return;
  editControls.filters.chips.forEach(chip => {
  const chipFilter = normalizeEditingFilterName(chip.dataset.filter || 'none');
    chip.classList.toggle('active', chipFilter === activeFilter);
  });
}

function selectCropPreset(preset, options = {}) {
  const { silent = false, suppressUserTracking = false } = options;
  editState.cropPreset = preset;
  editState.targetResolution = getPresetTargetResolution(preset);
  if (!suppressUserTracking) {
    editState.userSelectedCropPreset = true;
  }
  updateCropPresetButtons(preset);
  applyCropPreset(preset, { silent });
  updateUpsamplingWarning();
  if (!silent) {
    markEditsDirty();
  }
}

function updateCropPresetButtons(activePreset) {
  if (!editControls?.crop?.presetButtons) return;
  editControls.crop.presetButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.crop === activePreset);
  });
}

function getPresetRatio(preset) {
  if (preset === 'original') {
    if (editState.naturalWidth && editState.naturalHeight) {
      return editState.naturalWidth / editState.naturalHeight;
    }
    return null;
  }
  return CROP_PRESET_RATIOS[preset] || null;
}

function getPresetTargetResolution(preset) {
  const detail = CROP_PRESET_DETAILS[preset];
  if (!detail?.targetResolution) {
    return null;
  }
  const { width, height } = detail.targetResolution;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    width,
    height
  };
}

function isZeroCropInsets(insets = {}) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = insets;
  return (
    Math.abs(top) <= CROP_INSET_EPSILON &&
    Math.abs(right) <= CROP_INSET_EPSILON &&
    Math.abs(bottom) <= CROP_INSET_EPSILON &&
    Math.abs(left) <= CROP_INSET_EPSILON
  );
}

function determinePresetForDimensions(width, height) {
  const roundedWidth = Math.round(Number(width) || 0);
  const roundedHeight = Math.round(Number(height) || 0);

  if (roundedWidth <= 0 || roundedHeight <= 0) {
    return null;
  }

  if (roundedWidth === 3840 && roundedHeight === 2160) {
    return '16:9sam';
  }

  const aspect = roundedWidth / roundedHeight;
  let bestPreset = null;
  let bestDiff = Infinity;

  for (const [preset, presetRatio] of Object.entries(CROP_PRESET_RATIOS)) {
    if (preset === '16:9sam') {
      continue; // Only select 16:9sam on exact resolution match
    }
    const diff = Math.abs(aspect - presetRatio);
    if (diff < bestDiff && diff <= CROP_PRESET_MATCH_TOLERANCE) {
      bestDiff = diff;
      bestPreset = preset;
    }
  }

  return bestPreset;
}

function getNaturalDimensions() {
  const imageData = currentImage ? allImages[currentImage] : null;
  const width = editState.naturalWidth || imageData?.dimensions?.width || 0;
  const height = editState.naturalHeight || imageData?.dimensions?.height || 0;
  return {
    width,
    height
  };
}

function calculateCropOutputSize() {
  // Use effective dimensions that account for rotation
  const effectiveDims = getEffectiveCropDimensions();
  const naturalWidth = effectiveDims.width;
  const naturalHeight = effectiveDims.height;
  if (!naturalWidth || !naturalHeight) {
    return { width: 0, height: 0 };
  }

  const widthPercent = Math.max(MIN_CROP_PERCENT, 100 - editState.crop.left - editState.crop.right);
  const heightPercent = Math.max(MIN_CROP_PERCENT, 100 - editState.crop.top - editState.crop.bottom);

  const outputWidth = Math.round((widthPercent / 100) * naturalWidth);
  const outputHeight = Math.round((heightPercent / 100) * naturalHeight);

  return {
    width: Math.max(1, outputWidth),
    height: Math.max(1, outputHeight)
  };
}

function shouldShowUpsamplingWarning() {
  if (editState.cropPreset !== '16:9sam') {
    return false;
  }

  const target = getPresetTargetResolution(editState.cropPreset);
  if (!target) {
    return false;
  }

  const { width, height } = calculateCropOutputSize();
  if (!width || !height) {
    return false;
  }

  return width < target.width || height < target.height;
}

function updateUpsamplingWarning() {
  const warningEl = editControls?.crop?.warning;
  if (!warningEl) {
    return;
  }

  if (!editState.active || editState.activeTool !== 'crop') {
    warningEl.style.display = 'none';
    return;
  }

  if (shouldShowUpsamplingWarning()) {
    warningEl.style.display = 'flex';
  } else {
    warningEl.style.display = 'none';
  }
}

function autoSelectCropPresetForCurrentImage() {
  if (!currentImage) {
    return;
  }

  if (editState.autoPresetApplied || editState.userSelectedCropPreset) {
    return;
  }

  const hasCustomCrop = !isZeroCropInsets(editState.crop);
  if (hasCustomCrop) {
    editState.autoPresetApplied = true;
    return;
  }

  const imageData = allImages[currentImage];
  const width = editState.naturalWidth || imageData?.dimensions?.width;
  const height = editState.naturalHeight || imageData?.dimensions?.height;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }

  const candidate = determinePresetForDimensions(width, height);
  editState.autoPresetApplied = true;

  if (!candidate || candidate === editState.cropPreset) {
    return;
  }

  selectCropPreset(candidate, { silent: true, suppressUserTracking: true });
}

function applyCropPreset(preset, options = {}) {
  const { silent = false } = options;
  if (preset === 'free') {
    updateCropOverlay();
    if (!silent) {
      markEditsDirty();
    }
    return;
  }

  const ratio = getPresetRatio(preset);
  if (!ratio) {
    updateCropOverlay();
    return;
  }

  const insets = computeInsetsForRatio(ratio);
  setCropInsets(insets, { silent: true });
  if (!silent) {
    markEditsDirty();
  }
}

function computeInsetsForRatio(ratio) {
  const naturalWidth = editState.naturalWidth || 1;
  const naturalHeight = editState.naturalHeight || 1;
  const naturalRatio = naturalWidth / naturalHeight || 1;

  let widthPercent = 100;
  let heightPercent = 100;

  if (naturalRatio >= ratio) {
    heightPercent = 100;
    widthPercent = clamp((ratio / naturalRatio) * 100, MIN_CROP_PERCENT, 100);
  } else {
    widthPercent = 100;
    heightPercent = clamp((naturalRatio / ratio) * 100, MIN_CROP_PERCENT, 100);
  }

  const horizontalInset = (100 - widthPercent) / 2;
  const verticalInset = (100 - heightPercent) / 2;

  return clampInsets({
    top: verticalInset,
    bottom: verticalInset,
    left: horizontalInset,
    right: horizontalInset
  });
}

function setCropInsets(insets, options = {}) {
  const { silent = false, skipNormalize = false } = options;
  let next = clampInsets(insets);
  const ratio = getPresetRatio(editState.cropPreset);
  if (ratio && !skipNormalize) {
    next = normalizeInsetsForRatio(next, ratio);
  }
  editState.crop = next;
  updateCropOverlay();
  updateUpsamplingWarning();
  if (!silent) {
    markEditsDirty();
  }
}

function clampInsets(insets) {
  let { top, right, bottom, left } = insets;
  
  // Get rotation-based bounds (0 if no rotation)
  const bounds = getValidCropRegion();

  // Clamp to valid region (respects rotation inscribed area)
  top = clamp(top, bounds.minTop, 100);
  bottom = clamp(bottom, bounds.maxBottom, 100);
  left = clamp(left, bounds.minLeft, 100);
  right = clamp(right, bounds.maxRight, 100);

  // Calculate max available dimensions within valid region
  const maxAvailableWidth = 100 - bounds.minLeft - bounds.maxRight;
  const maxAvailableHeight = 100 - bounds.minTop - bounds.maxBottom;
  
  let width = 100 - left - right;
  if (width < MIN_CROP_PERCENT) {
    const shortfall = MIN_CROP_PERCENT - width;
    if (left >= right) {
      left = clamp(left - shortfall, bounds.minLeft, 100 - right - MIN_CROP_PERCENT);
    } else {
      right = clamp(right - shortfall, bounds.maxRight, 100 - left - MIN_CROP_PERCENT);
    }
    width = 100 - left - right;
  }

  let height = 100 - top - bottom;
  if (height < MIN_CROP_PERCENT) {
    const shortfall = MIN_CROP_PERCENT - height;
    if (top >= bottom) {
      top = clamp(top - shortfall, bounds.minTop, 100 - bottom - MIN_CROP_PERCENT);
    } else {
      bottom = clamp(bottom - shortfall, bounds.maxBottom, 100 - top - MIN_CROP_PERCENT);
    }
    height = 100 - top - bottom;
  }

  return { top, right, bottom, left };
}

function normalizeInsetsForRatio(insets, ratio) {
  if (!ratio || ratio <= 0) {
    return clampInsets(insets);
  }

  const naturalWidth = editState.naturalWidth || 1;
  const naturalHeight = editState.naturalHeight || 1;
  const naturalRatio = naturalWidth / naturalHeight || 1;

  const clamped = clampInsets(insets);
  let { top, right, bottom, left } = clamped;

  let widthPercent = Math.max(MIN_CROP_PERCENT, 100 - left - right);
  let heightPercent = Math.max(MIN_CROP_PERCENT, 100 - top - bottom);

  const actualRatio = (widthPercent / heightPercent) * naturalRatio;
  const adjustedDiff = actualRatio - ratio;

  if (Math.abs(adjustedDiff) <= CROP_RATIO_TOLERANCE) {
    return clamped;
  }

  const widthActual = (widthPercent / 100) * naturalWidth;
  const heightActual = (heightPercent / 100) * naturalHeight;

  const minWidthActual = (MIN_CROP_PERCENT / 100) * naturalWidth;
  const minHeightActual = (MIN_CROP_PERCENT / 100) * naturalHeight;

  const minHeightAllowed = Math.max(minHeightActual, minWidthActual / ratio);
  const maxHeightAllowed = Math.min(naturalHeight, naturalWidth / ratio);
  const minWidthAllowed = Math.max(minWidthActual, minHeightActual * ratio);
  const maxWidthAllowed = Math.min(naturalWidth, naturalHeight * ratio);

  let targetWidthActual;
  let targetHeightActual;

  if (adjustedDiff > 0) {
    const candidateHeight = clamp(widthActual / ratio, minHeightAllowed, maxHeightAllowed);
    targetHeightActual = candidateHeight;
    targetWidthActual = ratio * candidateHeight;
  } else {
    const candidateWidth = clamp(heightActual * ratio, minWidthAllowed, maxWidthAllowed);
    targetWidthActual = candidateWidth;
    targetHeightActual = candidateWidth / ratio;
  }

  targetWidthActual = clamp(targetWidthActual, minWidthAllowed, maxWidthAllowed);
  targetHeightActual = targetWidthActual / ratio;

  if (targetHeightActual < minHeightAllowed) {
    targetHeightActual = minHeightAllowed;
    targetWidthActual = ratio * targetHeightActual;
  } else if (targetHeightActual > maxHeightAllowed) {
    targetHeightActual = maxHeightAllowed;
    targetWidthActual = ratio * targetHeightActual;
  }

  const targetWidthPercent = clamp((targetWidthActual / naturalWidth) * 100, MIN_CROP_PERCENT, 100);
  const targetHeightPercent = clamp((targetHeightActual / naturalHeight) * 100, MIN_CROP_PERCENT, 100);

  const centerXPercent = left + widthPercent / 2;
  const centerYPercent = top + heightPercent / 2;

  const nextLeft = clamp(centerXPercent - targetWidthPercent / 2, 0, 100 - targetWidthPercent);
  const nextTop = clamp(centerYPercent - targetHeightPercent / 2, 0, 100 - targetHeightPercent);
  const nextRight = 100 - targetWidthPercent - nextLeft;
  const nextBottom = 100 - targetHeightPercent - nextTop;

  return {
    top: nextTop,
    right: nextRight,
    bottom: nextBottom,
    left: nextLeft
  };
}

function findPresetForAspectRatio(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return null;
  }

  let bestPreset = null;
  let bestDiff = Infinity;

  for (const [preset, presetRatio] of Object.entries(CROP_PRESET_RATIOS)) {
    if (preset === '16:9sam') {
      continue;
    }
    const diff = Math.abs(aspect - presetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPreset = preset;
    }
  }

  if (bestPreset && bestDiff <= CROP_PRESET_MATCH_TOLERANCE) {
    return bestPreset;
  }

  return null;
}

function detectInitialCropPreset(imageData) {
  if (!imageData) {
    return 'free';
  }

  // If image has no crop applied (all insets are 0), use 'free' preset
  // This prevents aspect ratio enforcement when user hasn't cropped yet
  if (imageData.crop) {
    const { top = 0, right = 0, bottom = 0, left = 0 } = imageData.crop;
    if (top === 0 && right === 0 && bottom === 0 && left === 0) {
      return 'free';
    }
  } else {
    return 'free';
  }

  const exactResolutionPreset = determinePresetForDimensions(
    imageData.dimensions?.width,
    imageData.dimensions?.height
  );
  if (exactResolutionPreset === '16:9sam') {
    return exactResolutionPreset;
  }

  const toNumeric = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  let ratio = toNumeric(imageData.aspectRatio);

  if (!Number.isFinite(ratio) && imageData.dimensions?.width && imageData.dimensions?.height) {
    ratio = imageData.dimensions.width / imageData.dimensions.height;
  }

  if (!Number.isFinite(ratio) && imageData.crop?.width && imageData.crop?.height) {
    ratio = imageData.crop.width / imageData.crop.height;
  }

  if (!Number.isFinite(ratio) && imageData.crop?.aspectRatio) {
    ratio = toNumeric(imageData.crop.aspectRatio);
  }

  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 'free';
  }

  const matchedPreset = findPresetForAspectRatio(ratio);
  if (matchedPreset) {
    return matchedPreset;
  }

  return 'free';
}

function updateCropOverlay() {
  if (!editControls?.crop?.overlay || !editControls.crop.box) return;
  const overlay = editControls.crop.overlay;
  const box = editControls.crop.box;

  const overlayVisible = editState.active;

  overlay.classList.toggle('hidden', !overlayVisible);
  overlay.classList.toggle('preview-muted', overlayVisible && !editState.previewEnabled);
  overlay.classList.toggle('active', overlayVisible && editState.activeTool === 'crop');

  const { top, right, bottom, left } = editState.crop;
  const widthPercent = Math.max(MIN_CROP_PERCENT, 100 - left - right);
  const heightPercent = Math.max(MIN_CROP_PERCENT, 100 - top - bottom);

  box.style.top = `${top}%`;
  box.style.left = `${left}%`;
  box.style.width = `${widthPercent}%`;
  box.style.height = `${heightPercent}%`;

  updateUpsamplingWarning();
}

function startCropInteraction(type, handle, event) {
  if (!editControls?.modalImage) return;
  event.preventDefault();
  event.stopPropagation();

  const rect = editControls.modalImage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  cropInteraction = {
    type,
    handle,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startInsets: { ...editState.crop },
    startWidth: 100 - editState.crop.left - editState.crop.right,
    startHeight: 100 - editState.crop.top - editState.crop.bottom,
    aspectRatio: getPresetRatio(editState.cropPreset),
    bounds: rect,
    pendingInsets: { ...editState.crop },
    targetElement: event.target // Save for releasing pointer capture
  };

  // Capture pointer to prevent text selection and ensure all events come to us
  try {
    event.target.setPointerCapture(event.pointerId);
  } catch (e) {
    console.error('Failed to capture pointer for crop interaction:', e);
  }

  editControls.crop.box.classList.add('dragging');
  document.addEventListener('pointermove', handleCropPointerMove);
  document.addEventListener('pointerup', handleCropPointerUp, { once: false });
  document.addEventListener('pointercancel', handleCropPointerUp, { once: false });
}

function handleCropPointerMove(event) {
  if (!cropInteraction) return;
  const { type, handle, startX, startY, startInsets, bounds, aspectRatio } = cropInteraction;
  const dx = ((event.clientX - startX) / bounds.width) * 100;
  const dy = ((event.clientY - startY) / bounds.height) * 100;
  
  // Get rotation-based bounds
  const validRegion = getValidCropRegion();

  let nextInsets = { ...startInsets };

  if (type === 'move') {
    const width = 100 - startInsets.left - startInsets.right;
    const height = 100 - startInsets.top - startInsets.bottom;

    // Constrain movement to valid region
    const maxLeft = 100 - validRegion.maxRight - width;
    const maxTop = 100 - validRegion.maxBottom - height;
    let newLeft = clamp(startInsets.left + dx, validRegion.minLeft, maxLeft);
    let newTop = clamp(startInsets.top + dy, validRegion.minTop, maxTop);
    const newRight = 100 - width - newLeft;
    const newBottom = 100 - height - newTop;

    nextInsets = clampInsets({ top: newTop, right: newRight, bottom: newBottom, left: newLeft });
  } else {
    let { top, right, bottom, left } = startInsets;

    // For handle resizing: 
    // - Min bound ensures we don't go into black region (validRegion.minXxx)
    // - Max bound ensures we keep minimum crop size
    if (handle.includes('w')) {
      // West handle: dragging right increases left inset, dragging left decreases it
      const maxLeft = 100 - right - MIN_CROP_PERCENT; // Can't make crop too small
      left = clamp(startInsets.left + dx, validRegion.minLeft, maxLeft);
    }
    if (handle.includes('e')) {
      // East handle: dragging left increases right inset, dragging right decreases it
      const maxRight = 100 - left - MIN_CROP_PERCENT;
      right = clamp(startInsets.right - dx, validRegion.maxRight, maxRight);
    }
    if (handle.includes('n')) {
      // North handle
      const maxTop = 100 - bottom - MIN_CROP_PERCENT;
      top = clamp(startInsets.top + dy, validRegion.minTop, maxTop);
    }
    if (handle.includes('s')) {
      // South handle
      const maxBottom = 100 - top - MIN_CROP_PERCENT;
      bottom = clamp(startInsets.bottom - dy, validRegion.maxBottom, maxBottom);
    }

    nextInsets = clampInsets({ top, right, bottom, left });

    if (aspectRatio) {
      nextInsets = enforceAspectRatio(nextInsets, handle, aspectRatio);
    }
  }

  cropInteraction.pendingInsets = nextInsets;
  // Skip normalization because enforceAspectRatio already handled it
  setCropInsets(nextInsets, { silent: true, skipNormalize: !!aspectRatio });
}

function handleCropPointerUp() {
  if (!cropInteraction) return;
  
  // Release pointer capture
  if (cropInteraction.targetElement && cropInteraction.pointerId !== undefined) {
    try {
      cropInteraction.targetElement.releasePointerCapture(cropInteraction.pointerId);
    } catch (e) {
      console.error('Failed to release pointer for crop interaction:', e);
    }
  }
  
  editControls?.crop?.box?.classList.remove('dragging');
  document.removeEventListener('pointermove', handleCropPointerMove);
  document.removeEventListener('pointerup', handleCropPointerUp, { once: false });
  document.removeEventListener('pointercancel', handleCropPointerUp, { once: false });

  const finalInsets = cropInteraction.pendingInsets || editState.crop;
  const aspectRatio = cropInteraction.aspectRatio;
  // Skip normalization if aspect ratio was already enforced during drag
  setCropInsets(finalInsets, { silent: false, skipNormalize: !!aspectRatio });

  cropInteraction = null;
}

function enforceAspectRatio(insets, handle, aspectRatio) {
  // Use effective dimensions that account for rotation
  const effectiveDims = getEffectiveCropDimensions();
  const naturalWidth = effectiveDims.width || 1;
  const naturalHeight = effectiveDims.height || 1;
  const naturalRatio = naturalWidth / naturalHeight || 1;

  let { top, right, bottom, left } = insets;
  let widthPercent = 100 - left - right;
  let heightPercent = 100 - top - bottom;

  if (widthPercent <= 0 || heightPercent <= 0) {
    return clampInsets(insets);
  }

  const centerX = left + widthPercent / 2;
  const centerY = top + heightPercent / 2;

  const actualRatio = (widthPercent / heightPercent) * naturalRatio;
  const ratioDiff = actualRatio - aspectRatio;
  const tolerance = CROP_RATIO_TOLERANCE;

  const applyWidth = (targetWidthPercent, anchor) => {
    targetWidthPercent = clamp(targetWidthPercent, MIN_CROP_PERCENT, 100);

    if (anchor === 'left') {
      right = clamp(100 - targetWidthPercent - left, 0, 100 - left - MIN_CROP_PERCENT);
    } else if (anchor === 'right') {
      left = clamp(100 - targetWidthPercent - right, 0, 100 - right - MIN_CROP_PERCENT);
    } else {
      const newLeft = clamp(centerX - targetWidthPercent / 2, 0, 100 - targetWidthPercent);
      left = newLeft;
      right = clamp(100 - targetWidthPercent - left, 0, 100 - left - MIN_CROP_PERCENT);
    }

    widthPercent = 100 - left - right;
  };

  const applyHeight = (targetHeightPercent, anchor) => {
    targetHeightPercent = clamp(targetHeightPercent, MIN_CROP_PERCENT, 100);

    if (anchor === 'top') {
      bottom = clamp(100 - targetHeightPercent - top, 0, 100 - top - MIN_CROP_PERCENT);
    } else if (anchor === 'bottom') {
      top = clamp(100 - targetHeightPercent - bottom, 0, 100 - bottom - MIN_CROP_PERCENT);
    } else {
      const newTop = clamp(centerY - targetHeightPercent / 2, 0, 100 - targetHeightPercent);
      top = newTop;
      bottom = clamp(100 - targetHeightPercent - top, 0, 100 - top - MIN_CROP_PERCENT);
    }

    heightPercent = 100 - top - bottom;
  };

  const cornerAnchors = {
    ne: { horizontal: 'left', vertical: 'bottom' },
    nw: { horizontal: 'right', vertical: 'bottom' },
    se: { horizontal: 'left', vertical: 'top' },
    sw: { horizontal: 'right', vertical: 'top' }
  };

  const isCornerHandle = Object.prototype.hasOwnProperty.call(cornerAnchors, handle);

  if (isCornerHandle) {
    const anchors = cornerAnchors[handle];

    if (ratioDiff > tolerance) {
      const targetWidthPercent = heightPercent * (aspectRatio / naturalRatio);
      applyWidth(targetWidthPercent, anchors.horizontal);
    } else if (ratioDiff < -tolerance) {
      const targetHeightPercent = widthPercent * (naturalRatio / aspectRatio);
      applyHeight(targetHeightPercent, anchors.vertical);
    }

    // If constraints prevented us from hitting the ratio exactly, fall back to adjusting the
    // opposite dimension so we stay as close as possible without drifting the anchored corner.
    widthPercent = 100 - left - right;
    heightPercent = 100 - top - bottom;
    const adjustedRatio = (widthPercent / heightPercent) * naturalRatio;
    const adjustedDiff = adjustedRatio - aspectRatio;

    if (adjustedDiff > tolerance) {
      const targetHeightPercent = widthPercent * (naturalRatio / aspectRatio);
      applyHeight(targetHeightPercent, anchors.vertical);
    } else if (adjustedDiff < -tolerance) {
      const targetWidthPercent = heightPercent * (aspectRatio / naturalRatio);
      applyWidth(targetWidthPercent, anchors.horizontal);
    }
  } else if (handle === 'n' || handle === 's') {
    const targetWidthPercent = heightPercent * (aspectRatio / naturalRatio);
    applyWidth(targetWidthPercent, 'center');

    widthPercent = 100 - left - right;
    heightPercent = 100 - top - bottom;
    const adjustedRatio = (widthPercent / heightPercent) * naturalRatio;
    const adjustedDiff = adjustedRatio - aspectRatio;

    if (Math.abs(adjustedDiff) > tolerance) {
      const targetHeightPercent = widthPercent * (naturalRatio / aspectRatio);
      const verticalAnchor = handle === 'n' ? 'bottom' : 'top';
      applyHeight(targetHeightPercent, verticalAnchor);
    }
  } else if (handle === 'e' || handle === 'w') {
    const targetHeightPercent = widthPercent * (naturalRatio / aspectRatio);
    applyHeight(targetHeightPercent, 'center');

    widthPercent = 100 - left - right;
    heightPercent = 100 - top - bottom;
    const adjustedRatio = (widthPercent / heightPercent) * naturalRatio;
    const adjustedDiff = adjustedRatio - aspectRatio;

    if (Math.abs(adjustedDiff) > tolerance) {
      const targetWidthPercent = heightPercent * (aspectRatio / naturalRatio);
      const horizontalAnchor = handle === 'w' ? 'right' : 'left';
      applyWidth(targetWidthPercent, horizontalAnchor);
    }
  }

  return clampInsets({ top, right, bottom, left });
}

function markEditsDirty() {
  editState.isDirty = true;
  updateToolbarState();
  clearToolbarStatus();
}

function applyPreviewFilters() {
  if (!editControls?.modalImage) return;
  const img = editControls.modalImage;
  if (!editState.active || !editState.previewEnabled) {
    img.style.filter = '';
    return;
  }

  const adjustments = editState.adjustments || {};
  const brightnessFactor = clamp(1 + (adjustments.brightness || 0) / 100, 0.1, 3);
  const lightnessFactor = clamp(1 + (adjustments.lightness || 0) / 100, 0.1, 3);
  const combinedBrightness = clamp(brightnessFactor * lightnessFactor, 0.1, 5).toFixed(3);
  const contrast = clamp(1 + (adjustments.contrast || 0) / 100, 0.1, 3).toFixed(3);
  const saturationFactor = clamp(1 + (adjustments.saturation || 0) / 100, 0.1, 5);
  const hueRotate = clamp(adjustments.hue || 0, -180, 180);

  const parts = [`brightness(${combinedBrightness})`, `contrast(${contrast})`];
  if (Math.abs(hueRotate) > 0.001) {
    parts.push(`hue-rotate(${hueRotate}deg)`);
  }
  if (Math.abs(adjustments.saturation || 0) > 0.001) {
    parts.push(`saturate(${saturationFactor.toFixed(3)})`);
  }

  const normalizedFilter = normalizeEditingFilterName(editState.filter);

  switch (normalizedFilter) {
    case 'sketch':
      parts.push('grayscale(1)', 'contrast(2.15)', 'brightness(1.15)', 'invert(0.05)');
      break;
    case 'oil-paint':
      parts.push('saturate(1.55)', 'contrast(1.18)', 'brightness(1.08)', 'blur(0.7px)');
      break;
    case 'watercolor':
      parts.push('saturate(1.35)', 'contrast(0.9)', 'brightness(1.12)', 'blur(1.15px)');
      break;
    case 'impressionist':
      parts.push('saturate(1.52)', 'contrast(1.12)', 'brightness(1.1)', 'blur(0.75px)');
      break;
    case 'pop-art':
      parts.push('saturate(2.4)', 'contrast(1.85)', 'brightness(1.05)');
      break;
    case 'art-deco':
      parts.push('sepia(0.45)', 'saturate(1.22)', 'contrast(1.22)');
      break;
    case 'neural-style':
      parts.push('saturate(1.85)', 'contrast(1.28)', 'hue-rotate(32deg)');
      break;
    case 'noir-cinema':
      parts.push('grayscale(1)', 'contrast(1.4)', 'brightness(0.95)');
      break;
    case 'silver-pearl':
      parts.push('grayscale(1)', 'brightness(1.08)', 'contrast(0.95)');
      break;
    case 'graphite-ink':
      parts.push('grayscale(1)', 'contrast(1.2)', 'brightness(1.02)');
      break;
    default:
      break;
  }

  img.style.filter = parts.join(' ');
}

function buildEditPayload() {
  const targetResolution = getPresetTargetResolution(editState.cropPreset);

  return {
    crop: { ...editState.crop },
    adjustments: { ...editState.adjustments },
    filter: editState.filter,
    rotation: editState.rotation || 0,
    cropPreset: editState.cropPreset,
    targetResolution
  };
}

/**
 * Check if there are any real edits (non-default values).
 * Returns false if all settings are at their defaults.
 */
function hasRealEdits() {
  // Check crop
  const { crop, adjustments, filter, rotation, cropPreset } = editState;
  const hasCrop = Object.values(crop).some(v => Math.abs(v) > 0.01);
  
  // Check rotation
  const hasRotation = Math.abs(rotation || 0) > 0.01;
  
  // Check adjustments
  const hasAdjustments = Object.values(adjustments).some(v => Math.abs(v) > 0.01);
  
  // Check filter
  const hasFilter = filter && filter !== 'none';
  
  // Check if 16:9SAM preset which forces resize
  const hasResizePreset = cropPreset === '16:9sam';
  
  return hasCrop || hasRotation || hasAdjustments || hasFilter || hasResizePreset;
}

async function submitImageEdits() {
  if (!currentImage || !editState.isDirty) {
    setToolbarStatus('Adjust settings before applying edits.', 'info');
    return;
  }

  // Check if there are actual changes (not just defaults)
  const hasActualEdits = hasRealEdits();
  if (!hasActualEdits) {
    // No real changes - treat as cancel
    cancelEdits();
    return;
  }

  const applyBtn = editControls?.toolbar?.applyBtn;
  if (applyBtn) {
    applyBtn.disabled = true;
  }
  setToolbarStatus('Applying edits...', 'info');

  try {
    const payload = buildEditPayload();
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to apply edits');
    }

  editState.hasBackup = true;
  editState.isDirty = false;

    // Set cache buster for this image's thumbnail
    thumbnailCacheBusters[currentImage] = Date.now();

    if (allImages[currentImage] && data.imageData) {
      // Update local cache with full response (includes updated timestamp)
      allImages[currentImage] = data.imageData;
    }

    setToolbarStatus('Edits applied. Sync when ready.', 'success');
    exitEditMode({ resetState: true });
    refreshModalImageAfterEdit();
  } catch (error) {
    console.error('Error applying edits:', error);
    setToolbarStatus(error.message || 'Failed to apply edits', 'error');
  } finally {
    if (applyBtn) {
      applyBtn.disabled = !editState.active || !editState.isDirty;
    }
    await updateSyncStatus();
  }
}

function refreshModalImageAfterEdit() {
  if (!currentImage) return;
  const bust = Date.now();
  reloadModalImage(bust);

  if (allImages[currentImage]) {
    renderModalResolutionFromMetadata(allImages[currentImage]);
  }

  loadGallery().catch(error => {
    console.error('Error refreshing gallery after edit:', error);
  });
}

function reloadModalImage(cacheBuster = Date.now()) {
  if (!editControls?.modalImage || !currentImage) return;
  editControls.modalImage.src = `library/${currentImage}?v=${cacheBuster}`;
}

async function loadEditStateForImage(filename) {
  if (!filename) return;
  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(filename)}/edit-state`);
    const data = await response.json();
    if (data.success) {
      editState.hasBackup = !!data.hasBackup;
      updateToolbarState();
    }
  } catch (error) {
    console.error('Error loading edit state:', error);
  }
}

async function revertImageToOriginal() {
  if (!currentImage) return;
  if (!confirm('Revert this image to the original version? This will discard current edits.')) {
    return;
  }

  if (editState.active) {
    cancelEdits();
  }

  setToolbarStatus('Reverting to original...', 'info');
  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}/revert`, {
      method: 'POST'
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to revert image');
    }

    editState.hasBackup = !!data.hasBackup;

    if (allImages[currentImage] && data.imageData) {
      // Update local cache with full response (includes updated timestamp)
      allImages[currentImage] = data.imageData;
    }

    resetEditState({ hasBackup: editState.hasBackup, keepDimensions: true, silent: true });
    updateToolbarState();
    refreshModalImageAfterEdit();
    setToolbarStatus('Reverted to original image.', 'success');

    await updateSyncStatus();
  } catch (error) {
    console.error('Error reverting image:', error);
    setToolbarStatus(error.message || 'Failed to revert image', 'error');
  }
}

function renderModalResolutionFromMetadata(imageData) {
  const resolutionEl = document.getElementById('modal-resolution');
  const aspectBadgeEl = document.getElementById('modal-aspect-badge');
  const fileSizeEl = document.getElementById('modal-file-size');

  if (!resolutionEl || !aspectBadgeEl) return;

  if (imageData?.dimensions?.width && imageData?.dimensions?.height) {
    const { width, height } = imageData.dimensions;
    const aspectRatio = imageData.aspectRatio || (width / height);
    const is16x9 = Math.abs(aspectRatio - 1.78) < 0.05;
    const fileSize = imageData.fileSize || 0;
    const fileSizeMB = fileSize / (1024 * 1024);
    
    // Check if image meets "sam" criteria: 3840x2160 and <= 20MB
    const isSam = width === 3840 && height === 2160 && fileSizeMB <= 20;
    
    resolutionEl.textContent = `${width} × ${height}`;
    
    let badgesHtml = '';
    if (isSam) {
      badgesHtml += '<span class="sam-badge-inline" title="Image resolution and size (<20MB) is correct target for Frame TVs">sam</span>';
    }
    if (is16x9) {
      badgesHtml += '<span class="aspect-badge-inline">16:9</span>';
    }
    aspectBadgeEl.innerHTML = badgesHtml;
  } else {
    resolutionEl.textContent = 'Unknown';
    aspectBadgeEl.innerHTML = '';
  }
  
  // Display file size
  if (fileSizeEl) {
    if (imageData?.fileSize) {
      fileSizeEl.textContent = formatFileSize(imageData.fileSize);
    } else {
      fileSizeEl.textContent = 'Unknown';
    }
  }
}

// Modal Functions
function initModal() {
  const modal = document.getElementById('image-modal');
  if (!modal) {
    console.warn('Image modal element not found; skipping modal initialization.');
    return;
  }

  const closeBtn = document.getElementById('image-modal-close');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  const deleteBtn = document.getElementById('modal-delete-btn');
  const editFilenameBtn = document.getElementById('edit-filename-btn');
  const saveFilenameBtn = document.getElementById('save-filename-btn');
  const cancelFilenameBtn = document.getElementById('cancel-filename-btn');
  const addTagsBtn = document.getElementById('modal-add-tags-btn');
  const tagsInput = document.getElementById('modal-tags-input');
  const matteSelect = document.getElementById('modal-matte');
  const filterSelect = document.getElementById('modal-filter');
  const expandBtn = document.getElementById('expand-image-btn');

  const closeModalAndSync = async () => {
    if (editState.active) {
      cancelEdits();
    }
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
    renderGallery();
    resetEditState({ hasBackup: false, keepDimensions: false, silent: true });
    clearToolbarStatus();
    try {
      const status = await fetch(`${API_BASE}/sync/status`).then(r => r.json());
      if (status.success && status.status?.hasChanges) {
        await manualSync();
      }
    } catch (error) {
      console.error('Error checking sync status on modal close:', error);
    }
  };

  closeBtn?.addEventListener('click', closeModalAndSync);
  cancelBtn?.addEventListener('click', closeModalAndSync);

  window.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeModalAndSync();
    }
  });

  // Mobile modal tab switching
  const modalContent = modal.querySelector('.modal-content');
  const mobileTabs = modal.querySelectorAll('.mobile-modal-tab');
  
  mobileTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.modalTab;
      
      // Update active tab button
      mobileTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update modal content data attribute to control visibility
      if (modalContent) {
        modalContent.dataset.mobileTab = targetTab;
      }
    });
  });

  // Create Show on TV button for mobile action row (next to Delete on left side)
  const modalActions = modal.querySelector('.modal-actions');
  const modalActionsLeft = modal.querySelector('.modal-actions-left');
  if (modalActionsLeft && window.matchMedia('(max-width: 768px)').matches) {
    // Create the Show on TV button for mobile
    const mobileShowTvAction = document.createElement('button');
    mobileShowTvAction.id = 'mobile-show-tv-action';
    mobileShowTvAction.className = 'btn-primary mobile-show-tv-action';
    mobileShowTvAction.textContent = 'Show on TV';
    modalActionsLeft.appendChild(mobileShowTvAction);
    
    // Wire up click handler (same as mobile-show-tv-btn)
    mobileShowTvAction.addEventListener('click', () => {
      const mobileShowTvBtn = document.getElementById('mobile-show-tv-btn');
      if (mobileShowTvBtn) {
        mobileShowTvBtn.click();
      }
    });
  }

  // Reset to preview tab when modal opens
  const originalOpenModal = window.openImageModal;
  if (typeof originalOpenModal === 'function') {
    window.openImageModal = function(...args) {
      // Reset to preview tab
      mobileTabs.forEach(t => t.classList.toggle('active', t.dataset.modalTab === 'preview'));
      if (modalContent) {
        modalContent.dataset.mobileTab = 'preview';
      }
      return originalOpenModal.apply(this, args);
    };
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', deleteImage);
  }

  if (editFilenameBtn && saveFilenameBtn && cancelFilenameBtn) {
    editFilenameBtn.addEventListener('click', showEditFilenameForm);
    saveFilenameBtn.addEventListener('click', saveFilenameChange);
    cancelFilenameBtn.addEventListener('click', hideEditFilenameForm);
  } else {
    if (editFilenameBtn || saveFilenameBtn || cancelFilenameBtn) {
      console.warn('Incomplete filename editing controls detected; skipping filename editing bindings.');
    }
  }

  if (addTagsBtn) {
    addTagsBtn.addEventListener('click', addImageTags);
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      if (currentImage) {
        showFullScreenImage(currentImage);
      }
    });
  }

  // Stats link in modal - navigate to analytics page with this image selected
  const modalStatsLink = document.getElementById('modal-stats-link');
  if (modalStatsLink) {
    modalStatsLink.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentImage) {
        modal.classList.remove('active');
        window.location.hash = `#/analytics?image=${encodeURIComponent(currentImage)}`;
      }
    });
  }
  if (matteSelect) {
    matteSelect.addEventListener('change', saveImageChanges);
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', saveImageChanges);
  }

  if (tagsInput) {
    tagsInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addImageTags();
      }
    });
  }

  initImageEditor();
}

function showFullScreenImage(filename) {
  // Create full-screen overlay
  const overlay = document.createElement('div');
  overlay.id = 'fullscreen-image-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: pointer;
  `;
  
  // Create image element
  const img = document.createElement('img');
  img.src = `library/${filename}`;
  img.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  `;
  
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  
  // Click anywhere to close
  overlay.onclick = () => {
    document.body.removeChild(overlay);
  };
  
  // ESC key to close
  const handleEsc = (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('fullscreen-image-overlay')) {
        document.body.removeChild(overlay);
        document.removeEventListener('keydown', handleEsc);
      }
    }
  };
  document.addEventListener('keydown', handleEsc);
}

function openImageModal(filename) {
  const modal = document.getElementById('image-modal');
  const imageData = allImages[filename];
  
  currentImage = filename;

  if (!modal) {
    console.warn('Image modal not found; cannot open image modal view.');
    return;
  }

  // Hide bulk actions bar while modal is open (selection is preserved)
  const bulkActions = document.getElementById('bulk-actions');
  if (bulkActions) {
    bulkActions.classList.remove('visible');
  }

  // Set image
  const cacheBuster = Date.now();
  const modalImageEl = document.getElementById('modal-image');
  if (modalImageEl) {
    modalImageEl.src = `library/${filename}?v=${cacheBuster}`;
  }
  document.getElementById('modal-filename').textContent = getDisplayName(filename);
  document.getElementById('modal-actual-filename').textContent = filename;
  
  renderModalResolutionFromMetadata(imageData);

  // Set form values
  const metadataMatte = imageData.matte || METADATA_DEFAULT_MATTE;
  const metadataFilter = imageData.filter || METADATA_DEFAULT_FILTER;

  // Determine if image is portrait and update matte dropdown accordingly
  const imgWidth = imageData.dimensions?.width || 0;
  const imgHeight = imageData.dimensions?.height || 0;
  const isPortrait = imgHeight > imgWidth;
  updateMatteOptionsForOrientation('modal-matte', isPortrait, metadataMatte);

  document.getElementById('modal-matte').value = metadataMatte;
  document.getElementById('modal-filter').value = metadataFilter;

  if (allImages[currentImage]) {
    allImages[currentImage].matte = metadataMatte;
    allImages[currentImage].filter = metadataFilter;
  }

  selectFilter('none', { silent: true });
  
  // Render tag badges and TV tags helper
  renderImageTagBadges(imageData.tags || []);
  renderTvTagsHelper();

  // Render custom attributes and entities
  renderModalAttributes(imageData.attributes || {});
  renderModalEntities(imageData);

  exitEditMode();
  const initialPreset = detectInitialCropPreset(imageData);
  resetEditState({ hasBackup: false, keepDimensions: false, silent: true, initialPreset });
  
  // Load existing crop values if present
  if (imageData.crop && typeof imageData.crop === 'object') {
    const { top = 0, right = 0, bottom = 0, left = 0 } = imageData.crop;
    setCropInsets({ top, right, bottom, left }, { silent: true });
  }
  
  clearToolbarStatus();
  updateToolbarState();
  updateCropOverlay();
  applyPreviewFilters();

  loadEditStateForImage(filename);

  modal.classList.add('active');
  document.body.classList.add('modal-open');
}

function showEditFilenameForm() {
  const filenameContainer = document.querySelector('.modal-filename-container');
  const editForm = document.getElementById('edit-filename-form');
  const editInput = document.getElementById('edit-filename-input');
  
  // Extract just the base name (without UUID and extension)
  // currentImage format: basename-uuid.ext
  const ext = currentImage.substring(currentImage.lastIndexOf('.'));
  const nameWithoutExt = currentImage.substring(0, currentImage.lastIndexOf('.'));
  
  // Check if it has UUID pattern (dash followed by 8 hex chars at the end)
  const uuidPattern = /-[0-9a-f]{8}$/i;
  let baseName;
  
  if (uuidPattern.test(nameWithoutExt)) {
    // Extract base name without UUID
    baseName = nameWithoutExt.substring(0, nameWithoutExt.lastIndexOf('-'));
  } else {
    // No UUID found, use the name without extension
    baseName = nameWithoutExt;
  }
  
  editInput.value = baseName;
  
  // Hide the h3 and show the form
  filenameContainer.style.display = 'none';
  editForm.style.display = 'flex';
  editInput.focus();
  editInput.select();
}

function hideEditFilenameForm() {
  const filenameContainer = document.querySelector('.modal-filename-container');
  const editForm = document.getElementById('edit-filename-form');
  
  filenameContainer.style.display = 'flex';
  editForm.style.display = 'none';
}

async function saveFilenameChange() {
  if (!currentImage) return;
  
  const newBaseName = document.getElementById('edit-filename-input').value.trim();
  
  if (!newBaseName) {
    alert('Please enter a valid name');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newBaseName })
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Update current image reference
      currentImage = result.newFilename;
      
      // Reload gallery and refresh modal
      await loadGallery();
      
      // Update modal display
      document.getElementById('modal-filename').textContent = getDisplayName(result.newFilename);
      document.getElementById('modal-actual-filename').textContent = result.newFilename;
      document.getElementById('modal-image').src = `library/${result.newFilename}`;
      
      hideEditFilenameForm();
      
      // Update sync status since files changed
      await updateSyncStatus();
    } else {
      alert(result.error || 'Failed to rename image');
    }
  } catch (error) {
    console.error('Error renaming image:', error);
    alert('Failed to rename image');
  }
}

function renderModalAttributes(imageAttributes) {
  const section = document.getElementById('modal-attributes-section');
  const container = document.getElementById('modal-attributes-inputs');
  if (!section || !container) return;

  if (!allAttributes || allAttributes.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  container.innerHTML = allAttributes.map(attrName => {
    const value = escapeHtml(String((imageAttributes && imageAttributes[attrName]) || ''));
    return `
      <div class="modal-attribute-row">
        <label class="modal-attribute-label">${escapeHtml(attrName)}:</label>
        <input type="text" class="modal-attribute-input" data-attribute="${escapeHtml(attrName)}" value="${value}" placeholder="" />
      </div>
    `;
  }).join('');

  container.querySelectorAll('.modal-attribute-input').forEach(input => {
    input.addEventListener('change', () => saveImageAttribute(input.dataset.attribute, input.value));
  });
}

async function saveImageAttribute(attributeName, value) {
  if (!currentImage) return;
  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { [attributeName]: value } })
    });
    const result = await response.json();
    if (result.success && result.data) {
      allImages[currentImage] = result.data;
    }
  } catch (error) {
    console.error('Error saving attribute:', error);
  }
}

async function saveImageChanges() {
  if (!currentImage) return;

  const matte = document.getElementById('modal-matte').value || METADATA_DEFAULT_MATTE;
  const filter = document.getElementById('modal-filter').value || METADATA_DEFAULT_FILTER;

  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matte, filter })
    });

    const result = await response.json();

    if (result.success && result.data) {
      // Update local cache with full response (includes updated timestamp)
      allImages[currentImage] = result.data;
      
      // Don't reload gallery on every dropdown change - it causes visual jitter
      // Gallery will be reloaded when modal closes if there are changes
      
      // Update sync status since metadata changed
      await updateSyncStatus();
    }
  } catch (error) {
    console.error('Error saving changes:', error);
    alert('Failed to save changes');
  }
}

async function deleteImage() {
  if (!currentImage) return;
  if (!confirm(`Delete "${currentImage}"? This cannot be undone.`)) return;

  if (editState.active) {
    cancelEdits();
  }

  try {
    const response = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      document.getElementById('image-modal').classList.remove('active');
      await loadGallery();
      
      // Update sync status since file was deleted
      await updateSyncStatus();
      
      // Refresh similar groups and filter count
      await fetchSimilarGroups();
      await loadTagsForFilter();
      if (similarFilterActive) {
        renderGallery();
      }
      
      // Auto-sync after deletion (same as closing modal with changes)
      const status = await fetch(`${API_BASE}/sync/status`).then(r => r.json());
      if (status.success && status.status.hasChanges) {
        await manualSync();
      }
    }
  } catch (error) {
    console.error('Error deleting image:', error);
    alert('Failed to delete image');
  }
}

// Metadata Viewer Functions
function initMetadataViewer() {
  const btn = document.getElementById('refresh-metadata-btn');
  btn.addEventListener('click', loadMetadata);
  
  // Load metadata on initial page load
  loadMetadata();
}

async function loadMetadata() {
  const contentDiv = document.getElementById('metadata-content');
  contentDiv.textContent = 'Loading metadata...';

  try {
    const response = await fetch(`${API_BASE}/metadata`);
    const metadata = await response.json();
    
    // Pretty print the JSON with syntax highlighting
    contentDiv.textContent = JSON.stringify(metadata, null, 2);
  } catch (error) {
    console.error('Error loading metadata:', error);
    contentDiv.textContent = 'Error loading metadata: ' + error.message;
  }
}

// Sync Detail Functions
function initSyncDetail() {
  // Load initial data
  loadSyncStatus();
  loadSyncLogs();
  
  // Set up conflict filter checkbox
  const problemsCheckbox = document.getElementById('show-problems-only');
  if (problemsCheckbox) {
    problemsCheckbox.addEventListener('change', () => {
      loadSyncLogs();
    });
  }
}

async function loadSyncLogs() {
  const container = document.getElementById('sync-log-container');
  if (!container) return;

  // Show loading state when the container is empty
  if (!container.dataset.loaded) {
    container.innerHTML = '<div class="loading-indicator">Loading sync history...</div>';
  }

  try {
    const response = await fetch(`${API_BASE}/sync/logs`);
    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Failed to load sync history');
    }

    let logs = Array.isArray(data.logs) ? data.logs : [];
    
    // Apply conflict filter if checkbox is checked
    const problemsCheckbox = document.getElementById('show-problems-only');
    const showProblemsOnly = problemsCheckbox && problemsCheckbox.checked;
    
    if (showProblemsOnly) {
      logs = logs.filter(entry => {
        const status = (entry.status || '').toLowerCase();
        return status !== 'success';
      });
    }

    if (logs.length === 0) {
      const emptyMessage = showProblemsOnly 
        ? 'No sync problems found in history.' 
        : 'No sync history yet. Run a sync to see activity here.';
      container.innerHTML = `<div class="sync-log-empty">${emptyMessage}</div>`;
      container.dataset.loaded = 'true';
      return;
    }

    const entriesHtml = logs.map(renderSyncLogEntry).join('');
    container.innerHTML = `<ul class="sync-log-list-compact">${entriesHtml}</ul>`;
    container.dataset.loaded = 'true';
  } catch (error) {
    console.error('Error loading sync logs:', error);
    container.innerHTML = `<div class="error">Failed to load sync history: ${escapeHtml(error.message || 'Unknown error')}</div>`;
    container.dataset.loaded = 'true';
  }
}

function renderSyncLogEntry(entry) {
  const statusMap = {
    success: { className: 'success', label: 'Success' },
    warning: { className: 'warning', label: 'Warning' },
    failure: { className: 'failure', label: 'Error' }
  };

  const normalizedStatus = (entry.status || '').toLowerCase();
  const statusMeta = statusMap[normalizedStatus] || { className: 'info', label: formatStatusLabel(entry.status) };

  const timestamp = entry.timestamp
    ? formatSyncLogTimestamp(entry.timestamp)
    : '—';

  const mainMessage = entry.message
    || formatOperationLabel(entry.operation)
    || 'Sync update';

  const detailLines = [];

  // Simple non-conflict details
  if (entry.remoteCommit) {
    detailLines.push(`Commit: ${entry.remoteCommit.slice(0, 7)}`);
  }

  if (entry.branch && entry.branch !== 'unknown') {
    detailLines.push(`Branch: ${entry.branch}`);
  }

  // Format conflicts with newlines
  if (entry.hasConflicts && Array.isArray(entry.conflictedFiles) && entry.conflictedFiles.length > 0) {
    const conflictType = entry.conflictType ? `${entry.conflictType}: ` : '';
    detailLines.push(`Conflicts: ${conflictType}`);
    entry.conflictedFiles.forEach(file => {
      const filename = file.split('/').pop();
      detailLines.push(`---${filename}`);
    });
    detailLines.push(''); // blank line after conflicts
  }

  // Format remote changes with newlines
  if (Array.isArray(entry.remoteChanges) && entry.remoteChanges.length > 0) {
    detailLines.push('Remote:');
    entry.remoteChanges.forEach(change => {
      const cleaned = change.trim().replace(/^[-•]\s*/, '');
      if (cleaned) {
        detailLines.push(`---${cleaned}`);
      }
    });
    detailLines.push(''); // blank line after remote
  }

  // Format discarded changes with newlines
  if (Array.isArray(entry.lostChanges) && entry.lostChanges.length > 0) {
    detailLines.push('Discarded:');
    entry.lostChanges.forEach(change => {
      const cleaned = change.trim().replace(/^[-•]\s*/, '');
      if (cleaned) {
        detailLines.push(`---${cleaned}`);
      }
    });
    detailLines.push(''); // blank line after discarded
  }

  // Error info
  if (entry.error) {
    detailLines.push(`Error: ${entry.error}`);
  }

  const detailText = detailLines.join('\n').trim();

  return `
    <li class="sync-log-row">
      <div class="sync-log-main">
        <span class="sync-log-time">${escapeHtml(timestamp)}</span>
        <span class="sync-log-status ${statusMeta.className}">${escapeHtml(statusMeta.label)}</span>
        <span class="sync-log-message">${escapeHtml(mainMessage)}</span>
      </div>
      ${detailText ? `<div class="sync-log-detail"><pre>${escapeHtml(detailText)}</pre></div>` : ''}
    </li>
  `;
}

function summarizeLogLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '';
  }

  const result = [];
  let currentHeading = null;
  let buffer = [];

  const flush = () => {
    if (currentHeading && buffer.length > 0) {
      result.push(`${currentHeading}: ${buffer.join('; ')}`);
    } else if (currentHeading) {
      result.push(currentHeading);
    } else if (buffer.length > 0) {
      result.push(buffer.join('; '));
    }
    currentHeading = null;
    buffer = [];
  };

  lines.forEach(raw => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return;

    if (trimmed.endsWith(':')) {
      flush();
      currentHeading = trimmed.slice(0, -1).trim();
      return;
    }

    const normalized = trimmed
      .replace(/^[-•]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized) {
      buffer.push(normalized);
    }
  });

  flush();
  return result.join(' • ');
}

function formatOperationLabel(operation) {
  if (!operation) return 'Sync';
  return operation
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatStatusLabel(status) {
  if (!status) return 'Info';
  const normalized = status.replace(/[-_\s]+/g, ' ').trim();
  if (!normalized) return 'Info';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatSyncLogTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function escapeHtml(untrustedValue) {
  if (untrustedValue === null || untrustedValue === undefined) return '';
  return String(untrustedValue)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Merge tags with case-insensitive deduplication.
 * When adding a new tag that matches an existing tag (case-insensitive),
 * the existing tag's casing is preserved.
 * @param {string[]} existingTags - Current tags on the image
 * @param {string[]} newTags - Tags to add
 * @returns {string[]} - Merged tags without case-insensitive duplicates
 */
function mergeTagsCaseInsensitive(existingTags, newTags) {
  const result = [...existingTags];
  const lowerExisting = existingTags.map(t => t.toLowerCase());
  
  for (const tag of newTags) {
    const lowerTag = tag.toLowerCase();
    if (!lowerExisting.includes(lowerTag)) {
      result.push(tag);
      lowerExisting.push(lowerTag);
    }
  }
  
  return result;
}

async function loadSyncStatus() {
  const container = document.getElementById('git-status-container');
  
  container.innerHTML = '<div class="loading-indicator">Loading git status...</div>';

  try {
    const response = await fetch(`${API_BASE}/sync/git-status`);
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error);
    }

    if (data.syncDisabled) {
      container.innerHTML = '<div class="info-box" style="padding:16px;"><strong>GitHub sync is disabled.</strong> Enable <em>GitHub Sync</em> in the add-on Configuration to sync changes with GitHub.</div>';
      return;
    }

    const status = data.gitStatus;
    
    // Build status display
    let html = '<div class="git-status-container">';
    
    // Status grid
    html += '<div class="git-status-grid">';
    
    // Sync status
    html += '<div class="git-status-label">Sync Status:</div>';
    html += '<div class="git-status-value">';
    const uncommittedCount = (status.modified || []).length + (status.created || []).length + (status.deleted || []).length;
    
    // Build badges
    let badges = '';
    let explanation = '';
    
    if (status.ahead === 0 && status.behind === 0 && uncommittedCount === 0) {
      badges += '<span class="status-badge clean">✓ Clean</span>';
      explanation = '<span class="sync-explanation">Your local repository is fully synced with the cloud. All changes have been committed and pushed.</span>';
    } else {
      // Build explanation based on what's present
      let explanationParts = [];
      
      if (status.ahead > 0) {
        badges += `<span class="status-badge ahead">↑ ${status.ahead} ahead</span>`;
        const commitWord = status.ahead === 1 ? 'commit' : 'commits';
        explanationParts.push(`${status.ahead} local ${commitWord} not pushed to cloud`);
      }
      
      if (status.behind > 0) {
        badges += `<span class="status-badge behind">↓ ${status.behind} behind</span>`;
        const commitWord = status.behind === 1 ? 'commit' : 'commits';
        explanationParts.push(`${status.behind} cloud ${commitWord} not downloaded`);
      }
      
      if (uncommittedCount > 0) {
        badges += '<span class="status-badge uncommitted">● Uncommitted</span>';
        
        // Fetch detailed changes for metadata.json
        const modFiles = status.modified || [];
        let detailedDescription = '';
        
        if (modFiles.includes('metadata.json')) {
          // Fetch detailed metadata changes
          try {
            const detailsResponse = await fetch(`${API_BASE}/sync/uncommitted-details`);
            const detailsData = await detailsResponse.json();
            
            if (detailsData.success && detailsData.changes && detailsData.changes.length > 0) {
              // Format the changes as a readable list
              detailedDescription = detailsData.changes.join('; ');
            } else {
              detailedDescription = 'modified: metadata.json';
            }
          } catch (detailsError) {
            console.warn('Could not fetch uncommitted details:', detailsError);
            detailedDescription = 'modified: metadata.json';
          }
        } else {
          // For non-metadata files, list them
          let fileDetails = [];
          
          if (modFiles.length > 0) {
            const fileNames = modFiles.map(f => f.split('/').pop()).join(', ');
            fileDetails.push(`modified: ${fileNames}`);
          }
          const addFiles = status.created || [];
          if (addFiles.length > 0) {
            const fileNames = addFiles.map(f => f.split('/').pop()).join(', ');
            fileDetails.push(`new: ${fileNames}`);
          }
          const delFiles = status.deleted || [];
          if (delFiles.length > 0) {
            const fileNames = delFiles.map(f => f.split('/').pop()).join(', ');
            fileDetails.push(`deleted: ${fileNames}`);
          }
          
          detailedDescription = fileDetails.join('; ');
        }
        
        explanationParts.push(detailedDescription);
      }
      
      if (status.hasConflicts) {
        badges += '<span class="status-badge conflict">⚠ Conflicts</span>';
        const conflictFiles = status.conflicted || [];
        const fileNames = conflictFiles.map(f => f.split('/').pop()).join(', ');
        explanationParts.push(`Merge conflicts in: ${fileNames}`);
      }
      
      explanation = '<span class="sync-explanation">' + explanationParts.join('. ') + '.</span>';
    }
    
    html += badges + ' ' + explanation;
    html += '</div>';
    
    html += '</div>'; // Close git-status-grid
    
    // Recent commits - scrollable list (completely outside the grid)
    if (status.recentCommits && status.recentCommits.length > 0) {
      html += '<div style="margin-top:20px; display:block; clear:both;"><strong>Recent Commits:</strong>';
      html += '<div class="commits-container-scrollable"><ul class="commits-list-compact">';
      status.recentCommits.forEach(commit => {
        // Escape HTML first
        const escapedMessage = commit.message
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, ' '); // Replace newlines with space
        // Replace -- separators with line breaks for better readability
        // Then format with bold base names and gray parentheticals
        // Pattern: "baseName: action (filename)" - bold only up to first colon
        const formattedMessage = escapedMessage
          .replace(/ -- /g, '<br>')
          .replace(/(^|<br>)(\s*)([^:]+?):/g, '$1$2<span class="commit-base-name">$3</span>:')
          .replace(/(\([^)]+\))/g, '<span class="commit-filename-paren">$1</span>');
        // Format date/time
        const commitDate = new Date(commit.date);
        const dateStr = commitDate.toLocaleDateString() + ' ' + commitDate.toLocaleTimeString();
        // No truncation - let CSS handle wrapping
        html += `<li><code class="commit-hash-small">${commit.hash}</code> <span class="commit-date">${dateStr}</span> <span class="commit-message-text">${formattedMessage}</span></li>`;
      });
      html += '</ul></div></div>';
    }
    
    html += '</div>'; // Close git-status-container
    
    container.innerHTML = html;
    
  } catch (error) {
    console.error('Error loading sync status:', error);
    container.innerHTML = `<div class="error">Error loading status: ${error.message}</div>`;
  }
}

function getFileStatusIcon(status) {
  switch(status) {
    case 'M': return 'M';
    case 'A': case '?': return '+';
    case 'D': return '−';
    case 'R': return '→';
    default: return '•';
  }
}

function getFileStatusClass(status) {
  switch(status) {
    case 'M': return 'modified';
    case 'A': case '?': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    default: return '';
  }
}

// Bulk Actions Functions
function initBulkActions() {
  const bulkTagBtn = document.getElementById('bulk-tag-btn');
  const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
  const selectAllBtn = document.getElementById('select-all-btn');
  const clearBtn = document.getElementById('clear-selection-btn');
  const addTagsBtn = document.getElementById('add-bulk-tags-btn');
  const cancelBtn = document.getElementById('cancel-bulk-tags-btn');
  const closeBtn = document.getElementById('bulk-modal-close');
  
  console.log('initBulkActions - bulkTagBtn:', bulkTagBtn);
  
  if (bulkTagBtn) {
    bulkTagBtn.addEventListener('click', openBulkTagModal);
  }
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', deleteBulkImages);
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', selectAllImages);
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', clearSelection);
  }
  if (addTagsBtn) {
    addTagsBtn.addEventListener('click', saveBulkTags);
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeBulkTagModal);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeBulkTagModal);
  }
  
  // Add Enter key support to bulk tags input
  const bulkTagsInput = document.getElementById('bulk-tags-input');
  if (bulkTagsInput) {
    bulkTagsInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBulkTags();
      }
    });
  }
  
  // Close modal on outside click
  const modal = document.getElementById('bulk-tag-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeBulkTagModal();
      }
    });
  }
}

async function deleteBulkImages() {
  const count = selectedImages.size;
  const plural = count !== 1 ? 's' : '';
  
  if (!confirm(`Are you sure you want to delete ${count} image${plural}? This cannot be undone.`)) {
    return;
  }
  
  const selectedArray = Array.from(selectedImages);
  let successCount = 0;
  let errorCount = 0;
  
  // Delete each selected image
  for (const filename of selectedArray) {
    try {
      const response = await fetch(`${API_BASE}/images/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      
      const result = await response.json();
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    } catch (error) {
      console.error(`Error deleting ${filename}:`, error);
      errorCount++;
    }
  }
  
  // Show result
  if (errorCount > 0) {
    alert(`Deleted ${successCount} image${successCount !== 1 ? 's' : ''}. ${errorCount} failed.`);
  }
  
  // Clear selection and refresh gallery
  clearSelection();
  await loadGallery();
  
  // Update sync status since files were deleted
  await updateSyncStatus();
  
  // Refresh similar groups and filter count
  await fetchSimilarGroups();
  await loadTagsForFilter();
  if (similarFilterActive) {
    renderGallery();
  }
  
  // Auto-sync after deletion if there are changes
  const status = await fetch(`${API_BASE}/sync/status`).then(r => r.json());
  if (status.success && status.status.hasChanges) {
    await manualSync();
  }
}

// TV Selection Modal
function initTvModal() {
  const tvModal = document.getElementById('tv-select-modal');
  const showTvBtn = document.getElementById('modal-show-tv-btn');
  const mobileShowTvBtn = document.getElementById('mobile-show-tv-btn');
  const closeBtn = document.getElementById('tv-modal-close');
  const tvListContainer = document.getElementById('tv-list-container');
  const logContainer = document.getElementById('tv-upload-logs');

  if (!tvModal) return;

  const handleShowTvClick = async () => {
    if (!currentImage) return;
    
    tvModal.classList.add('active');
    tvListContainer.innerHTML = '<div class="loading-indicator">Loading TVs...</div>';
    if (logContainer) {
      logContainer.style.display = 'none';
      logContainer.textContent = '';
    }
    
    try {
      const response = await fetch(`${API_BASE}/ha/tvs`);
      const data = await response.json();
      
      if (data.success && Array.isArray(data.tvs)) {
        renderTvList(data.tvs);
      } else {
        const errorMsg = data.details || data.error || 'Unknown error';
        console.error('TV Load Error:', data);
        tvListContainer.innerHTML = `<div class="error-message">Failed to load TVs: ${escapeHtml(errorMsg)}<br><br>Ensure the integration is installed and check Add-on logs.</div>`;
      }
    } catch (error) {
      console.error('Error fetching TVs:', error);
      tvListContainer.innerHTML = `<div class="error-message">Error connecting to Home Assistant: ${escapeHtml(error.message)}</div>`;
    }
  };

  // Attach handler to both desktop and mobile Show on TV buttons
  showTvBtn?.addEventListener('click', handleShowTvClick);
  mobileShowTvBtn?.addEventListener('click', handleShowTvClick);

  const closeModal = () => {
    tvModal.classList.remove('active');
  };

  closeBtn?.addEventListener('click', closeModal);
  
  window.addEventListener('click', (event) => {
    if (event.target === tvModal) {
      closeModal();
    }
  });
}

function renderTvList(tvs) {
  const container = document.getElementById('tv-list-container');
  if (!container) return;

  if (tvs.length === 0) {
    container.innerHTML = '<div class="empty-state">No Frame TVs found.</div>';
    return;
  }

  container.innerHTML = tvs.map((tv, index) => {
    const id = tv.device_id || tv.entity_id;
    const idType = tv.device_id ? 'device_id' : 'entity_id';
    // Escape ID for use in onclick and selector
    const safeId = id.replace(/['"\\]/g, '');
    
    // Only add border if not the last item
    const borderStyle = index === tvs.length - 1 ? '' : 'border-bottom: 1px solid #eee;';
    
    return `
    <div class="tv-item" onclick="selectOnTv('${safeId}', '${idType}')" style="display: flex; align-items: center; padding: 15px; ${borderStyle} cursor: pointer; transition: background 0.2s;">
      <div class="tv-info" style="flex: 1;">
        <div class="tv-name" style="font-weight: bold; font-size: 1.1em;">${tv.name}</div>
      </div>
      <button class="btn-primary btn-small" id="btn-${safeId}">Show</button>
    </div>
  `}).join('');
  
  // Add hover effect via JS since we're using inline styles for speed
  const items = container.querySelectorAll('.tv-item');
  items.forEach(item => {
    item.addEventListener('mouseenter', () => item.style.background = '#f5f5f5');
    item.addEventListener('mouseleave', () => item.style.background = 'transparent');
  });
}

// Make selectOnTv globally available since it's called from onclick
window.selectOnTv = async function(id, type) {
  if (!currentImage) return;
  
  const tvModal = document.getElementById('tv-select-modal');
  const safeId = id.replace(/['"\\]/g, '');
  const btn = document.getElementById(`btn-${safeId}`);
  const logContainer = document.getElementById('tv-upload-logs');
  
  // Prevent double-clicks if button is already disabled
  if (btn && btn.disabled) return;

  // Show loading state
  const originalText = btn ? btn.textContent : 'Show';
  if (btn) {
    btn.textContent = 'Sending...';
    btn.disabled = true;
  }
  
  // UX: Create a local "Initializing" log line immediately so the user sees instant feedback.
  // We format it to match the backend log style ([HH:MM:SS] Message) so it looks seamless
  // when the real logs are appended below it later.
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
  const initMsg = `[${timeStr}] Initializing upload...`;

  // Define pollLogs helper
  const pollLogs = async () => {
    if (!logContainer) return;
    try {
      const res = await fetch(`${API_BASE}/ha/upload-log`);
      const data = await res.json();
      if (data.success) {
        const remoteLogs = data.logs || '';
        // UX: Prepend our local init message to the remote logs.
        // This prevents the "Initializing..." message from disappearing when the first
        // real log arrives, creating a smooth, continuous log history for the user.
        const fullLogs = remoteLogs ? `${initMsg}\n${remoteLogs}` : initMsg;
        
        if (logContainer.textContent !== fullLogs) {
          logContainer.textContent = fullLogs;
          logContainer.scrollTop = logContainer.scrollHeight;
        }
      }
    } catch (e) {
      console.error('Log poll error:', e);
    }
  };

  // Start log polling
  let pollInterval;
  if (logContainer) {
    logContainer.style.display = 'block';
    logContainer.textContent = initMsg;
    
    // UX: Wait 1s before first poll to allow backend to clear the log file.
    // If we poll immediately, we might fetch the logs from the *previous* run
    // before the backend has a chance to truncate the file, causing a confusing flash of old data.
    pollInterval = setInterval(pollLogs, 1000);
  }

  try {
    const payload = {
      filename: currentImage
    };

    // Add matte and filter if selected in the modal
    const matteSelect = document.getElementById('modal-matte');
    const filterSelect = document.getElementById('modal-filter');
    
    if (matteSelect && matteSelect.value && matteSelect.value !== 'none') {
      payload.matte = matteSelect.value;
    }
    
    if (filterSelect && filterSelect.value && filterSelect.value !== 'None') {
      payload.filter = filterSelect.value;
    }
    
    if (type === 'device_id') {
      payload.device_id = id;
    } else {
      payload.entity_id = id;
    }

    const response = await fetch(`${API_BASE}/ha/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    
    // Stop polling
    if (pollInterval) clearInterval(pollInterval);
    
    // Fetch logs one last time to ensure we see the final message
    await pollLogs();

    // Check if modal is still open - if user closed it, suppress all feedback
    if (!tvModal.classList.contains('active')) {
      console.log('Modal closed by user during send. Suppressing result.');
      return;
    }

    if (result.success) {
      if (btn) btn.textContent = 'Sent!';
      
      // Refresh TV status to update bubbles with new image
      // Need both: loadTVs() for screen state, fetchRecentlyDisplayed() for current image
      loadTVs();
      fetchRecentlyDisplayed();
      
      // Close modal after short delay
      setTimeout(() => {
        tvModal.classList.remove('active');
        // Only show alert in development
        if (appEnvironment === 'development') {
          alert('Image sent to TV!');
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }, 2000); // Increased delay so user can see final logs
    } else {
      // Failure - show error message in log container
      if (logContainer && result.error) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
        logContainer.textContent = `[${timeStr}] Error: ${result.error}`;
        logContainer.style.color = '#d32f2f';
      }
      if (btn) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  } catch (error) {
    if (pollInterval) clearInterval(pollInterval);
    console.error('Error sending to TV:', error);
    // Only alert if modal is still open
    if (tvModal.classList.contains('active')) {
      if (btn) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  }
};

// ===== Analytics Functions =====

// Analytics state
let analyticsData = null;
let selectedTag = null;
let selectedImage = null;
let selectedTv = null;
let selectedTimeRange = '1w'; // default to 1 week
let globalTvColorMap = {}; // Consistent TV colors across all views

// Time range options in milliseconds
const TIME_RANGES = {
  '1h': 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1mo': 30 * 24 * 60 * 60 * 1000,
  '6mo': 180 * 24 * 60 * 60 * 1000
};

// Chart colors for pie charts
const CHART_COLORS = [
  '#3498db', // blue
  '#e74c3c', // red
  '#2ecc71', // green
  '#9b59b6', // purple
  '#f39c12', // orange
  '#1abc9c', // teal
  '#e67e22', // dark orange
  '#95a5a6'  // gray (for "other" / "<none>")
];

// Load analytics data silently in background for gallery "last display" info
async function loadAnalyticsDataForGallery() {
  try {
    const response = await fetch(`${API_BASE}/analytics/summary`);
    const result = await response.json();
    if (result.success && result.data) {
      analyticsData = result.data;
      // Re-render gallery to show "last display" info
      if (galleryHasLoadedAtLeastOnce) {
        renderGallery();
      }
    }
  } catch (error) {
    // Silently fail - analytics data is optional for gallery
    console.log('Could not load analytics data for gallery:', error.message);
  }
}

async function loadAnalytics(selectedImage = null) {
  const emptyState = document.getElementById('analytics-empty-state');
  const errorState = document.getElementById('analytics-error-state');
  const content = document.getElementById('analytics-content');
  
  // Hide states, show loading
  if (emptyState) emptyState.style.display = 'none';
  if (errorState) errorState.style.display = 'none';
  if (content) content.style.display = 'none';
  
  // Show loading in summary
  const tvSummaryList = document.getElementById('analytics-tv-summary-list');
  if (tvSummaryList) tvSummaryList.innerHTML = '<div class="loading-indicator">Loading analytics...</div>';
  
  try {
    // Ensure gallery data is loaded (needed for histogram)
    if (!galleryHasLoadedAtLeastOnce) {
      const galleryResponse = await fetch(`${API_BASE}/images`);
      allImages = await galleryResponse.json();
      galleryHasLoadedAtLeastOnce = true;
    }
    
    const response = await fetch(`${API_BASE}/analytics/summary`);
    const result = await response.json();
    
    if (!result.success) {
      if (result.reason === 'no_data') {
        // Show empty state
        if (emptyState) emptyState.style.display = 'block';
        return;
      }
      throw new Error(result.message || 'Failed to load analytics');
    }
    
    analyticsData = result.data;
    
    // Build global TV color map for consistent colors across all views
    // Sort TVs by total display time descending for consistent ordering
    const tvIds = Object.keys(analyticsData.tvs || {});
    tvIds.sort((a, b) => (analyticsData.tvs[b].total_display_seconds || 0) - (analyticsData.tvs[a].total_display_seconds || 0));
    globalTvColorMap = {};
    tvIds.forEach((tvId, index) => {
      globalTvColorMap[tvId] = CHART_COLORS[index % CHART_COLORS.length];
    });
    
    // Check if logging is disabled
    if (analyticsData.logging_enabled === false) {
      if (emptyState) {
        emptyState.querySelector('h3').textContent = 'Activity logging is disabled';
        emptyState.querySelector('p').textContent = 'Enable logging in the Frame Art Shuffler integration settings to start tracking display statistics.';
        emptyState.style.display = 'block';
      }
      return;
    }
    
    // Ensure TVs/tagsets are loaded for the tag selector
    if (!allTVs || allTVs.length === 0 || Object.keys(allGlobalTagsets || {}).length === 0) {
      await loadTVs();
    }
    
    // Show content
    if (content) content.style.display = 'block';
    
    // Render all sections
    renderAnalyticsSummary();
    renderOverallPieChart();
    renderTVSelector();
    renderTagSelector();
    renderImageSelector();
    setupAnalyticsEventListeners();
    
    // If an image was specified, try to select it
    if (selectedImage) {
      // On mobile, switch to the Images tab
      const pageContent = document.querySelector('.analytics-page-content');
      if (pageContent) {
        pageContent.dataset.activeColumn = 'images';
        // Update tab button states
        document.querySelectorAll('.analytics-mobile-tab').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.column === 'images');
        });
      }
      
      // Try to select the image in the dropdown
      const imageSelect = document.getElementById('analytics-image-select');
      if (imageSelect) {
        // Check if the exact filename exists as an option
        const options = Array.from(imageSelect.options);
        const exactMatch = options.find(opt => opt.value === selectedImage);
        
        if (exactMatch) {
          imageSelect.value = selectedImage;
          imageSelect.dispatchEvent(new Event('change'));
        } else {
          // Try partial match (filename without path)
          const baseFilename = selectedImage.split('/').pop();
          const partialMatch = options.find(opt => opt.value.includes(baseFilename) || baseFilename.includes(opt.value));
          if (partialMatch) {
            imageSelect.value = partialMatch.value;
            imageSelect.dispatchEvent(new Event('change'));
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error loading analytics:', error);
    if (errorState) {
      const errorMsg = document.getElementById('analytics-error-message');
      if (errorMsg) errorMsg.textContent = error.message;
      errorState.style.display = 'block';
    }
  }
}

function renderAnalyticsSummary() {
  if (!analyticsData) return;
  
  const imageCount = Object.keys(analyticsData.images || {}).length;
  
  // Update image count
  const imagesEl = document.getElementById('analytics-total-images');
  if (imagesEl) imagesEl.textContent = imageCount;
  
  // Render TV summary list
  const tvSummaryList = document.getElementById('analytics-tv-summary-list');
  if (!tvSummaryList) return;
  
  const tvs = analyticsData.tvs || {};
  const tvIds = Object.keys(tvs);
  
  if (tvIds.length === 0) {
    tvSummaryList.innerHTML = '<div class="empty-state-small">No TV data</div>';
    return;
  }
  
  // Sort by display time descending
  tvIds.sort((a, b) => (tvs[b].total_display_seconds || 0) - (tvs[a].total_display_seconds || 0));
  
  tvSummaryList.innerHTML = tvIds.map(tvId => {
    const tv = tvs[tvId];
    const hours = formatHoursNice(tv.total_display_seconds || 0);
    // Derive unique image count from per_image array length
    const imageCount = Array.isArray(tv.per_image) ? tv.per_image.length : 0;
    return `
      <div class="tv-summary-item">
        <span class="tv-summary-name">${escapeHtml(tv.name || 'Unknown TV')}</span>
        <span class="tv-summary-stats">${hours} / ${imageCount} images</span>
      </div>
    `;
  }).join('');
}

// Store buckets globally for click handlers
let histogramBuckets = [];
let selectedBucketIndex = -1;
let bucketSortColumn = 'time'; // 'time' or 'count'
let bucketSortAsc = true;

function renderOverallPieChart() {
  const container = document.getElementById('analytics-image-pie');
  const statsContainer = document.getElementById('analytics-distribution-stats');
  const detailContainer = document.getElementById('analytics-bucket-detail');
  if (!container) return;
  
  const analyticsImages = analyticsData?.images || {};
  const galleryImageNames = Object.keys(allImages || {});
  
  // Calculate time-filtered display seconds for each image
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Helper to calculate display seconds and count within the time range for an image
  function getImageStatsInRange(imageData) {
    if (!imageData?.display_periods) return { seconds: 0, count: 0 };
    let seconds = 0;
    let count = 0;
    for (const [tvId, periods] of Object.entries(imageData.display_periods)) {
      for (const period of periods) {
        if (period.end > rangeStart) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          seconds += (end - start) / 1000;
          count++;
        }
      }
    }
    return { seconds, count };
  }
  
  // Merge gallery images with analytics data - include ALL images from gallery
  // Images not in analytics get 0 seconds, others get time-filtered seconds
  // Note: We only include images that exist in the gallery. Deleted images that
  // may still have analytics data are excluded from the histogram.
  const mergedImages = galleryImageNames.map(name => {
    const stats = getImageStatsInRange(analyticsImages[name]);
    return {
      name,
      seconds: stats.seconds,
      displayCount: stats.count
    };
  });
  
  if (mergedImages.length === 0) {
    container.innerHTML = '<div class="empty-state-small">No image data</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    if (detailContainer) detailContainer.innerHTML = '';
    return;
  }
  
  // Sort by display time descending
  const imageList = mergedImages.sort((a, b) => b.seconds - a.seconds);
  
  const totalSeconds = imageList.reduce((sum, img) => sum + img.seconds, 0);
  
  // Calculate stats
  const count = imageList.length;
  const avgSeconds = count > 0 ? totalSeconds / count : 0;
  const sortedByTime = [...imageList].sort((a, b) => a.seconds - b.seconds);
  const medianSeconds = count === 0 ? 0 : (count % 2 === 0 
    ? (sortedByTime[count/2 - 1].seconds + sortedByTime[count/2].seconds) / 2
    : sortedByTime[Math.floor(count/2)].seconds);
  const minSeconds = sortedByTime[0]?.seconds || 0;
  const maxSeconds = sortedByTime[count - 1]?.seconds || 0;
  
  // Render stats line
  if (statsContainer) {
    statsContainer.innerHTML = `
      <span class="dist-title">Accumulated Display Time</span>
      <span class="dist-metrics">
        <span class="dist-stat">${count} images</span>
        <span class="dist-stat-sep">•</span>
        <span class="dist-stat">Avg: ${formatHoursNice(avgSeconds)}</span>
        <span class="dist-stat-sep">•</span>
        <span class="dist-stat">Median: ${formatHoursNice(medianSeconds)}</span>
        <span class="dist-stat-sep">•</span>
        <span class="dist-stat">Range: ${formatHoursNice(minSeconds)} – ${formatHoursNice(maxSeconds)}</span>
      </span>
    `;
  }
  
  // Define histogram buckets (in seconds)
  histogramBuckets = [
    { min: 0, max: 0, label: '0m', images: [] },
    { min: 1, max: 15 * 60, label: '<15m', images: [] },
    { min: 15 * 60, max: 60 * 60, label: '15m-1h', images: [] },
    { min: 60 * 60, max: 3 * 60 * 60, label: '1-3h', images: [] },
    { min: 3 * 60 * 60, max: 6 * 60 * 60, label: '3-6h', images: [] },
    { min: 6 * 60 * 60, max: 12 * 60 * 60, label: '6-12h', images: [] },
    { min: 12 * 60 * 60, max: 24 * 60 * 60, label: '12-24h', images: [] },
    { min: 24 * 60 * 60, max: 48 * 60 * 60, label: '1-2d', images: [] },
    { min: 48 * 60 * 60, max: Infinity, label: '2d+', images: [] }
  ];
  
  // Distribute images into buckets
  imageList.forEach(img => {
    for (const bucket of histogramBuckets) {
      if (img.seconds >= bucket.min && img.seconds < bucket.max) {
        bucket.images.push(img);
        break;
      }
      // Handle exact 0 case
      if (bucket.min === 0 && bucket.max === 0 && img.seconds === 0) {
        bucket.images.push(img);
        break;
      }
    }
  });
  
  // Find max bucket count for scaling
  const maxBucketCount = Math.max(...histogramBuckets.map(b => b.images.length), 1);
  const maxBarHeight = 90; // pixels
  
  // Build histogram bars
  const barsHtml = histogramBuckets.map((bucket, index) => {
    const heightPx = Math.max((bucket.images.length / maxBucketCount) * maxBarHeight, bucket.images.length > 0 ? 18 : 0);
    const isZeroBucket = bucket.min === 0 && bucket.max === 0;
    const hasImages = bucket.images.length > 0;
    const isSelected = index === selectedBucketIndex;
    const bucketClass = `histogram-bar ${isZeroBucket && hasImages ? 'zero-bucket' : ''} ${hasImages ? 'clickable' : ''} ${isSelected ? 'selected' : ''}`;
    
    // Only show bar if bucket has images
    const barInnerHtml = hasImages ? `
      <div class="histogram-bar-inner" style="height: ${heightPx}px">
        <span class="histogram-count">${bucket.images.length}</span>
      </div>
    ` : '';
    
    return `
      <div class="${bucketClass}" data-bucket-index="${index}">
        ${barInnerHtml}
        <div class="histogram-label">${bucket.label}</div>
      </div>
    `;
  }).join('');
  
  container.innerHTML = `
    <div class="histogram-chart">
      <div class="histogram-bars">${barsHtml}</div>
    </div>
  `;
  
  // Clear detail container
  if (detailContainer) detailContainer.innerHTML = '';
  selectedBucketIndex = -1;
  
  // Add click handlers for histogram bars
  container.querySelectorAll('.histogram-bar.clickable').forEach(bar => {
    bar.addEventListener('click', () => {
      const bucketIndex = parseInt(bar.dataset.bucketIndex);
      toggleBucketDetail(bucketIndex);
    });
  });

  // On mobile, auto-select the first clickable bar to show the table
  if (window.innerWidth <= 768) {
    const firstClickableBar = container.querySelector('.histogram-bar.clickable');
    if (firstClickableBar) {
      const bucketIndex = parseInt(firstClickableBar.dataset.bucketIndex);
      toggleBucketDetail(bucketIndex);
    }
  }
}

// Helper to format days ago
function formatDaysAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return `${diffDays}d`;
}

// Toggle bucket detail table
function toggleBucketDetail(bucketIndex) {
  const container = document.getElementById('analytics-image-pie');
  const detailContainer = document.getElementById('analytics-bucket-detail');
  if (!detailContainer) return;
  
  // If clicking the same bucket, collapse it
  if (selectedBucketIndex === bucketIndex) {
    selectedBucketIndex = -1;
    detailContainer.innerHTML = '';
    // Remove selected class from all bars
    container.querySelectorAll('.histogram-bar').forEach(bar => bar.classList.remove('selected'));
    return;
  }
  
  selectedBucketIndex = bucketIndex;
  
  // Update selected state on bars
  container.querySelectorAll('.histogram-bar').forEach(bar => {
    bar.classList.toggle('selected', parseInt(bar.dataset.bucketIndex) === bucketIndex);
  });
  
  // Reset sort to default when opening new bucket
  bucketSortColumn = 'time';
  bucketSortAsc = true;
  
  renderBucketDetailTable();
}

// Render the bucket detail table (called by toggleBucketDetail and sort handlers)
function renderBucketDetailTable() {
  const detailContainer = document.getElementById('analytics-bucket-detail');
  if (!detailContainer || selectedBucketIndex < 0) return;
  
  const bucket = histogramBuckets[selectedBucketIndex];
  if (!bucket || bucket.images.length === 0) {
    detailContainer.innerHTML = '';
    return;
  }
  
  // Sort images based on current sort column and direction
  const sortedImages = [...bucket.images].sort((a, b) => {
    let cmp = 0;
    if (bucketSortColumn === 'time') {
      cmp = a.seconds - b.seconds;
    } else if (bucketSortColumn === 'count') {
      cmp = (a.displayCount || 0) - (b.displayCount || 0);
    }
    // Apply primary sort direction
    cmp = bucketSortAsc ? cmp : -cmp;
    // Secondary sort by upload date ascending (oldest to newest) - always ascending
    if (cmp === 0) {
      const dateA = allImages[a.name]?.added || '';
      const dateB = allImages[b.name]?.added || '';
      cmp = dateA.localeCompare(dateB);
    }
    return cmp;
  });
  
  // Build table rows
  const rows = sortedImages.map(img => {
    const imageData = allImages[img.name] || {};
    const tags = imageData.tags || [];
    const tagsHtml = tags.length > 0 
      ? tags.map(t => escapeHtml(t)).join(', ')
      : '<span class="bucket-tag untagged">(untagged)</span>';
    const displayTime = formatHoursNice(img.seconds);
    const isZeroTime = img.seconds === 0;
    const displayCount = img.displayCount || 0;
    // Calculate average time per appearance
    const avgSecondsPerAppearance = displayCount > 0 ? img.seconds / displayCount : 0;
    const avgTimeStr = displayCount > 0 ? ` (${formatHoursNice(avgSecondsPerAppearance)})` : '';
    const displayCountStr = `${displayCount}${avgTimeStr}`;
    const addedDateShort = imageData.added ? formatDateShort(imageData.added) : '—';
    const daysAgo = imageData.added ? formatDaysAgo(imageData.added) : '';
    // Mobile-friendly format: m/d/yy (Xd)
    const uploadDisplay = imageData.added ? `${addedDateShort} (${daysAgo})` : '—';
    const displayName = getAnalyticsDisplayName(img.name);
    
    // Use current metadata for filter/matte, fallback to display history for deleted images
    let currentFilter = imageData.filter;
    let currentMatte = imageData.matte;
    
    // Fallback to display history if image not in gallery (deleted)
    if (!currentFilter && !currentMatte) {
      const imgAnalytics = analyticsData?.images?.[img.name];
      if (imgAnalytics?.display_periods) {
        for (const periods of Object.values(imgAnalytics.display_periods)) {
          for (const p of periods) {
            if (p.photo_filter && p.photo_filter.toLowerCase() !== 'none') currentFilter = p.photo_filter;
            if (p.matte && p.matte.toLowerCase() !== 'none') currentMatte = p.matte;
          }
        }
      }
    }
    const filterMatteSuffix = formatFilterMatteSuffix(currentFilter, currentMatte);
    
    return `
      <div class="bucket-row" data-filename="${escapeHtml(img.name)}">
        <span class="bucket-time${isZeroTime ? ' zero' : ''}">${displayTime}</span>
        <span class="bucket-count">${displayCountStr}</span>
        <span class="bucket-filename" title="${escapeHtml(img.name)}"><span class="bucket-filename-text">${escapeHtml(displayName)}</span>${filterMatteSuffix}<button class="bucket-open-btn" title="Open image">⧉</button></span>
        <span class="bucket-tags">${tagsHtml}</span>
        <span class="bucket-date">${uploadDisplay}</span>
      </div>
    `;
  }).join('');
  
  const timeArrow = bucketSortColumn === 'time' ? (bucketSortAsc ? ' ▲' : ' ▼') : '';
  const countArrow = bucketSortColumn === 'count' ? (bucketSortAsc ? ' ▲' : ' ▼') : '';
  
  detailContainer.innerHTML = `
    <div class="bucket-table-wrapper">
      <div class="bucket-table-header">
        <span class="sortable" data-sort="time">Time${timeArrow}</span>
        <span class="sortable center" data-sort="count"># (avg)${countArrow}</span>
        <span>Filename</span>
        <span>Tags</span>
        <span class="bucket-date">Upload Date</span>
      </div>
      <div class="bucket-table-scroll">
        ${rows}
      </div>
    </div>
  `;
  
  // Add click handlers for sortable headers
  detailContainer.querySelectorAll('.bucket-table-header .sortable').forEach(header => {
    header.addEventListener('click', () => {
      const col = header.dataset.sort;
      if (bucketSortColumn === col) {
        bucketSortAsc = !bucketSortAsc;
      } else {
        bucketSortColumn = col;
        bucketSortAsc = true;
      }
      renderBucketDetailTable();
    });
  });
  
  // Add click handlers for rows (select image in 3rd column, or open modal on mobile)
  detailContainer.querySelectorAll('.bucket-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't handle if clicking the open button
      if (e.target.classList.contains('bucket-open-btn')) return;
      
      const filename = row.dataset.filename;
      if (filename) {
        // On mobile, open the image modal directly
        if (window.innerWidth <= 768) {
          if (allImages[filename]) openImageModal(filename);
        } else {
          // On desktop, select the row and update 3rd column display
          detailContainer.querySelectorAll('.bucket-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          selectAnalyticsImage(filename);
        }
      }
    });
  });
  
  // Add click handlers for open buttons (desktop only, hidden on mobile)
  detailContainer.querySelectorAll('.bucket-open-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.bucket-row');
      const filename = row?.dataset.filename;
      if (filename && allImages[filename]) openImageModal(filename);
    });
  });
}

function renderTVSelector() {
  const select = document.getElementById('analytics-tv-select');
  if (!select || !analyticsData) return;
  
  const tvs = analyticsData.tvs || {};
  const tvIds = Object.keys(tvs);
  
  // Sort by display time descending
  tvIds.sort((a, b) => (tvs[b].total_display_seconds || 0) - (tvs[a].total_display_seconds || 0));
  
  select.innerHTML = tvIds.map(tvId => {
      const tv = tvs[tvId];
      return `<option value="${escapeHtml(tvId)}">${escapeHtml(tv.name || 'Unknown TV')}</option>`;
    }).join('');
  
  // Auto-select first TV
  if (tvIds.length > 0) {
    selectedTv = tvIds[0];
    select.value = selectedTv;
    renderTVDetail(selectedTv);
  }
}

function renderTVDetail(tvId) {
  const container = document.getElementById('analytics-tv-detail');
  const statsContainer = document.getElementById('analytics-tv-stats');
  if (!container || !analyticsData) return;
  
  if (!tvId) {
    container.innerHTML = '<div class="empty-state-small">Select a TV to view details</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    return;
  }
  
  const tvData = analyticsData.tvs?.[tvId];
  if (!tvData) {
    container.innerHTML = '<div class="empty-state-small">TV not found in analytics data</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    return;
  }
  
  // Get time-filtered data for this TV
  const perImage = getTopImagesForTVInRange(tvId);
  
  // Calculate stats for selected time range
  const tvStats = calculateTVStatsForRange(tvId);
  
  // Render stats in header area
  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-row-inline">
        <span class="stat-inline"><strong>${formatHoursNice(tvStats.totalSeconds)}</strong> display time</span>
        <span class="stat-sep">·</span>
        <span class="stat-inline"><strong>${tvStats.eventCount}</strong> shuffles</span>
      </div>
    `;
  }
  
  let html = '';
  
  // Activity timeline (when TV was displaying vs not)
  html += renderTVActivityTimeline(tvId);
  
  // Event log for this TV
  html += renderTVEventLog(tvId);
  
  container.innerHTML = html;
  
  // Add click handlers for event log rows
  container.querySelectorAll('.event-log-row.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const filename = row.dataset.filename;
      if (filename) selectAnalyticsImage(filename);
    });
  });
}

// Generate timeline axis with edge labels and tick marks based on time range
function generateTimelineAxis(rangeStart, rangeMs, isCompact = false) {
  const now = Date.now();
  
  // Determine tick interval based on selected time range
  const tickConfig = {
    '1h': { interval: 15 * 60 * 1000, format: { hour: 'numeric', minute: '2-digit' } },           // 15 min
    '12h': { interval: 2 * 60 * 60 * 1000, format: { hour: 'numeric' } },                         // 2 hours
    '1d': { interval: 4 * 60 * 60 * 1000, format: { hour: 'numeric' } },                          // 4 hours
    '1w': { interval: 24 * 60 * 60 * 1000, format: { weekday: 'short' } },                        // 1 day
    '1mo': { interval: 7 * 24 * 60 * 60 * 1000, format: { month: 'short', day: 'numeric' } },     // 1 week
    '6mo': { interval: 30 * 24 * 60 * 60 * 1000, format: { month: 'short' } }                     // 1 month
  };
  
  const config = tickConfig[selectedTimeRange] || tickConfig['1w'];
  
  // Generate tick marks
  const ticks = [];
  let tickTime = Math.ceil(rangeStart / config.interval) * config.interval; // Start at first clean interval
  
  while (tickTime < now) {
    const pct = ((tickTime - rangeStart) / rangeMs) * 100;
    if (pct > 5 && pct < 95) { // Avoid ticks too close to edges
      const label = new Date(tickTime).toLocaleString(undefined, config.format);
      ticks.push({ pct, label });
    }
    tickTime += config.interval;
  }
  
  // Edge labels
  const startDate = new Date(rangeStart);
  const startFormat = (selectedTimeRange === '1h' || selectedTimeRange === '12h' || selectedTimeRange === '1d') 
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' };
  const startLabel = startDate.toLocaleString(undefined, startFormat);
  
  // Build tick marks HTML
  const tickMarks = ticks.map(t => 
    `<div class="timeline-tick" style="left: ${t.pct}%"><span class="timeline-tick-label">${t.label}</span></div>`
  ).join('');
  
  // Edge labels HTML (above track)
  const edgesHtml = `<div class="timeline-edges"><span>${startLabel}</span><span>Now</span></div>`;
  
  // Ticks HTML (below track)
  const ticksHtml = tickMarks ? `<div class="timeline-ticks">${tickMarks}</div>` : '';
  
  // For compact (inline) timelines, just return edges
  if (isCompact) {
    return { edges: edgesHtml, ticks: '' };
  }
  
  return { edges: edgesHtml, ticks: ticksHtml };
}

// Render activity timeline for a TV (showing when it was on/displaying) with image tooltips
function renderTVActivityTimeline(tvId) {
  const tvData = analyticsData?.tvs?.[tvId];
  if (!tvData) return '';
  
  // Collect all display periods from all images for this TV (with image names)
  const allPeriods = [];
  const images = analyticsData.images || {};
  
  for (const [filename, imageData] of Object.entries(images)) {
    const periods = imageData.display_periods?.[tvId] || [];
    for (const period of periods) {
      allPeriods.push({ start: period.start, end: period.end, filename });
    }
  }
  
  if (allPeriods.length === 0) {
    return '<div class="tv-timeline"><div class="inline-timeline-empty">No timeline data available</div></div>';
  }
  
  // Sort by start time
  allPeriods.sort((a, b) => a.start - b.start);
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Build timeline segments with tooltips showing image name and time
  const segments = allPeriods
    .filter(p => p.end > rangeStart)
    .map(period => {
      const start = Math.max(period.start, rangeStart);
      const end = Math.min(period.end, now);
      const leftPct = ((start - rangeStart) / rangeMs) * 100;
      const widthPct = Math.max(((end - start) / rangeMs) * 100, 0.3);
      const startTime = new Date(period.start).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const duration = formatHoursNice((period.end - period.start) / 1000);
      const tooltip = `${period.filename} (${startTime}, ${duration})`;
      return `<div class="tv-timeline-segment" style="left: ${leftPct}%; width: ${widthPct}%" title="${escapeHtml(tooltip)}"></div>`;
    })
    .join('');
  
  // Generate axis parts (edges above, ticks below)
  const axis = generateTimelineAxis(rangeStart, rangeMs, false);
  
  return `
    <div class="tv-timeline">
      ${axis.edges}
      <div class="tv-timeline-track">${segments || '<div class="tv-timeline-empty">No activity</div>'}</div>
      ${axis.ticks}
    </div>
  `;
}

// Render event log for a specific TV
function renderTVEventLog(tvId) {
  const images = analyticsData?.images || {};
  const tvName = analyticsData?.tvs?.[tvId]?.name || 'Unknown TV';
  
  // Collect all events for this TV
  const allEvents = [];
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  for (const [filename, imageData] of Object.entries(images)) {
    const periods = imageData.display_periods?.[tvId] || [];
    for (const period of periods) {
      if (period.end > rangeStart) {
        allEvents.push({
          filename,
          start: period.start,
          end: period.end,
          duration: period.end - period.start,
          matte: period.matte,
          photo_filter: period.photo_filter
        });
      }
    }
  }
  
  if (allEvents.length === 0) {
    return '<div class="event-log"><div class="event-log-title">Display Events</div><div class="event-log-empty">No events in selected time range</div></div>';
  }
  
  // Sort by start time descending
  allEvents.sort((a, b) => b.start - a.start);
  
  const eventRows = allEvents.map(evt => {
    const startDate = new Date(evt.start);
    // duration is in ms, convert to seconds for formatHoursNice
    const durationFormatted = formatHoursNice(evt.duration / 1000);
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const imageName = truncateFilename(evt.filename, 18);
    const filterMatteSuffix = formatFilterMatteSuffix(evt.photo_filter, evt.matte);
    
    return `
      <div class="event-log-row clickable" data-filename="${escapeHtml(evt.filename)}">
        <span class="event-log-date">${dateStr}</span>
        <span class="event-log-time">${timeStr}</span>
        <span class="event-log-image"><span class="event-log-image-text">${escapeHtml(imageName)}</span>${filterMatteSuffix}</span>
        <span class="event-log-duration">${durationFormatted}</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="event-log">
      <div class="event-log-title">Display Events (${allEvents.length})</div>
      <div class="event-log-header">
        <span>Date</span>
        <span>Time</span>
        <span>Image</span>
        <span>Duration</span>
      </div>
      <div class="event-log-scroll">
        ${eventRows}
      </div>
    </div>
  `;
}

function renderPieChart(tags, tvId) {
  if (!tags || tags.length === 0) {
    return '<div class="empty-state-small" style="padding: 10px;">No tag data</div>';
  }
  
  // Take top 5 tags, combine rest into "other"
  const sortedTags = [...tags].sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
  const topTags = sortedTags.slice(0, 5);
  const otherSeconds = sortedTags.slice(5).reduce((sum, t) => sum + (t.seconds || 0), 0);
  
  if (otherSeconds > 0) {
    const totalSeconds = sortedTags.reduce((sum, t) => sum + (t.seconds || 0), 0);
    topTags.push({
      tag: 'other',
      seconds: otherSeconds,
      share: (otherSeconds / totalSeconds) * 100
    });
  }
  
  // Build conic gradient
  let gradientStops = [];
  let currentPct = 0;
  
  topTags.forEach((tag, index) => {
    const pct = tag.share || 0;
    const color = tag.tag === '<none>' || tag.tag === 'other' 
      ? CHART_COLORS[7] 
      : CHART_COLORS[index % (CHART_COLORS.length - 1)];
    
    gradientStops.push(`${color} ${currentPct}% ${currentPct + pct}%`);
    currentPct += pct;
  });
  
  // Fill remaining to 100% if needed
  if (currentPct < 100) {
    gradientStops.push(`#e9ecef ${currentPct}% 100%`);
  }
  
  const gradient = `conic-gradient(${gradientStops.join(', ')})`;
  
  // Build legend
  const legendItems = topTags.map((tag, index) => {
    const color = tag.tag === '<none>' || tag.tag === 'other' 
      ? CHART_COLORS[7] 
      : CHART_COLORS[index % (CHART_COLORS.length - 1)];
    const displayTag = tag.tag === '<none>' ? '(untagged)' : tag.tag;
    
    return `
      <div class="pie-legend-item" data-tag="${escapeHtml(tag.tag)}" title="Click to view tag details">
        <span class="pie-legend-color" style="background: ${color}"></span>
        <span class="pie-legend-label">${escapeHtml(displayTag)}</span>
        <span class="pie-legend-pct">${(tag.share || 0).toFixed(0)}%</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="pie-chart-container">
      <div class="pie-chart" style="background: ${gradient}"></div>
      <div class="pie-legend">${legendItems}</div>
    </div>
  `;
}

function renderTagSelector() {
  const select = document.getElementById('analytics-tag-select');
  if (!select || !analyticsData) return;
  
  // Get tagsets and tags that have activity in the selected time range
  const tagsetsWithActivity = getTagsetsWithActivityInRange();
  const tagsWithActivity = getTagsWithActivityInRange();
  
  // Sort tagsets alphabetically
  tagsetsWithActivity.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  
  // Sort tags alphabetically, but keep <none> (untagged) at the end
  tagsWithActivity.sort((a, b) => {
    if (a === '<none>') return 1;
    if (b === '<none>') return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  
  let html = '';
  
  // Add tagsets optgroup if any exist
  if (tagsetsWithActivity.length > 0) {
    html += '<optgroup label="Tagsets">';
    html += tagsetsWithActivity.map(name => 
      `<option value="tagset:${escapeHtml(name)}">${escapeHtml(name)}</option>`
    ).join('');
    html += '</optgroup>';
  }
  
  // Add tags optgroup
  if (tagsWithActivity.length > 0) {
    html += '<optgroup label="Tags">';
    html += tagsWithActivity.map(tag => {
      const displayTag = tag === '<none>' ? '(untagged)' : tag;
      return `<option value="${escapeHtml(tag)}">${escapeHtml(displayTag)}</option>`;
    }).join('');
    html += '</optgroup>';
  }
  
  select.innerHTML = html;
  
  // Determine all available options (tagsets prefixed, then tags)
  const allOptions = [
    ...tagsetsWithActivity.map(n => `tagset:${n}`),
    ...tagsWithActivity
  ];
  
  // If current selection is no longer available, auto-select first
  if (allOptions.length > 0) {
    if (!selectedTag || !allOptions.includes(selectedTag)) {
      selectedTag = allOptions[0];
    }
    select.value = selectedTag;
    renderTagDetail(selectedTag);
  } else {
    selectedTag = null;
    renderTagDetail(null);
  }
}

function renderImageSelector() {
  const select = document.getElementById('analytics-image-select');
  if (!select) return;
  
  // Use ALL gallery images, not just ones with analytics data
  const analyticsImages = analyticsData?.images || {};
  const galleryImageNames = Object.keys(allImages || {});
  
  // If no gallery images loaded yet, fall back to analytics images only
  const imageNames = galleryImageNames.length > 0 ? galleryImageNames : Object.keys(analyticsImages);
  
  // Sort alphabetically for easy lookup
  imageNames.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  
  select.innerHTML = imageNames.map(filename => {
      const displayName = truncateFilename(filename, 40);
      return `<option value="${escapeHtml(filename)}">${escapeHtml(displayName)}</option>`;
    }).join('');
  
  // Auto-select first image
  if (imageNames.length > 0) {
    selectedImage = imageNames[0];
    select.value = selectedImage;
    renderImageDetail(selectedImage);
  }
}

function renderTagDetail(selection) {
  const container = document.getElementById('analytics-tag-detail');
  const statsContainer = document.getElementById('analytics-tag-stats');
  if (!container || !analyticsData) return;
  
  if (!selection) {
    container.innerHTML = '<div class="empty-state-small">Select a tag to view details</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    return;
  }
  
  // Check if this is a tagset selection
  const isTagset = selection.startsWith('tagset:');
  
  if (isTagset) {
    const tagsetName = selection.substring(7); // Remove 'tagset:' prefix
    renderTagsetDetail(tagsetName, container, statsContainer);
  } else {
    renderSingleTagDetail(selection, container, statsContainer);
  }
}

// Render detail view for a single tag
function renderSingleTagDetail(tagName, container, statsContainer) {
  const tagData = analyticsData.tags?.[tagName];
  if (!tagData) {
    container.innerHTML = '<div class="empty-state-small">Tag not found</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    return;
  }
  
  // Get time-filtered data for this tag
  const perTv = getPerTVStatsForTagInRange(tagName);
  
  // Calculate stats for selected time range
  const tagStats = calculateTagStatsForRange(tagName);
  
  // Render stats in header area
  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-row-inline">
        <span class="stat-inline"><strong>${formatHoursNice(tagStats.totalSeconds)}</strong> display time</span>
        <span class="stat-sep">·</span>
        <span class="stat-inline"><strong>${tagStats.eventCount}</strong> appearances</span>
      </div>
    `;
  }
  
  let html = '';
  
  // TV breakdown - stacked horizontal bar (only if multiple TVs)
  const totalTvCount = Object.keys(analyticsData.tvs || {}).length;
  const showStackedBar = perTv.length > 0 && totalTvCount > 1;
  
  // Use global TV color map for consistent colors across all views
  const tvColorMap = globalTvColorMap;
  
  if (showStackedBar) {
    const segments = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      const pct = tv.share || 0;
      return `<div class="stacked-bar-segment clickable" data-tv-id="${escapeHtml(tv.tv_id)}" style="width: ${pct}%; background: ${color}" title="${escapeHtml(tvName)} (${formatPercent(pct)}, ${formatHoursNice(tv.seconds || 0)})"></div>`;
    }).join('');
    
    const legend = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      return `<span class="stacked-bar-legend-item clickable" data-tv-id="${escapeHtml(tv.tv_id)}"><span class="stacked-bar-legend-color" style="background: ${color}"></span>${escapeHtml(tvName)}</span>`;
    }).join('');
    
    html += `
      <div class="stacked-bar-section">
        <div class="stacked-bar-track">${segments}</div>
        <div class="stacked-bar-legend">${legend}</div>
      </div>
    `;
  }
  
  // Event log for this tag (show separator only if stacked bar is shown, pass TV colors for dots)
  html += renderTagEventLog(tagName, showStackedBar, tvColorMap);
  
  container.innerHTML = html;
  attachTagDetailClickHandlers(container);
}

// Render detail view for a tagset
function renderTagsetDetail(tagsetName, container, statsContainer) {
  const tagset = allGlobalTagsets?.[tagsetName];
  if (!tagset) {
    container.innerHTML = '<div class="empty-state-small">Tagset not found</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    return;
  }
  
  // Get time-filtered data for this tagset
  const perTv = getPerTVStatsForTagsetInRange(tagsetName);
  
  // Calculate stats for selected time range
  const tagsetStats = calculateTagsetStatsForRange(tagsetName);
  
  // Render stats in header area
  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-row-inline">
        <span class="stat-inline"><strong>${formatHoursNice(tagsetStats.totalSeconds)}</strong> display time</span>
        <span class="stat-sep">·</span>
        <span class="stat-inline"><strong>${tagsetStats.eventCount}</strong> appearances</span>
      </div>
    `;
  }
  
  let html = '';
  
  // TV breakdown - stacked horizontal bar (only if multiple TVs)
  const totalTvCount = Object.keys(analyticsData.tvs || {}).length;
  const showStackedBar = perTv.length > 0 && totalTvCount > 1;
  
  // Use global TV color map for consistent colors across all views
  const tvColorMap = globalTvColorMap;
  
  if (showStackedBar) {
    const segments = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      const pct = tv.share || 0;
      return `<div class="stacked-bar-segment clickable" data-tv-id="${escapeHtml(tv.tv_id)}" style="width: ${pct}%; background: ${color}" title="${escapeHtml(tvName)} (${formatPercent(pct)}, ${formatHoursNice(tv.seconds || 0)})"></div>`;
    }).join('');
    
    const legend = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      return `<span class="stacked-bar-legend-item clickable" data-tv-id="${escapeHtml(tv.tv_id)}"><span class="stacked-bar-legend-color" style="background: ${color}"></span>${escapeHtml(tvName)}</span>`;
    }).join('');
    
    html += `
      <div class="stacked-bar-section">
        <div class="stacked-bar-track">${segments}</div>
        <div class="stacked-bar-legend">${legend}</div>
      </div>
    `;
  }
  
  // Event log for this tagset
  html += renderTagsetEventLog(tagsetName, showStackedBar, tvColorMap);
  
  container.innerHTML = html;
  attachTagDetailClickHandlers(container);
}

// Attach click handlers for tag/tagset detail views
function attachTagDetailClickHandlers(container) {
  // Add click handlers for stacked bar segments
  container.querySelectorAll('.stacked-bar-segment.clickable').forEach(segment => {
    segment.addEventListener('click', () => {
      const tvId = segment.dataset.tvId;
      if (tvId) selectAnalyticsTv(tvId);
    });
  });
  
  // Add click handlers for stacked bar legend items
  container.querySelectorAll('.stacked-bar-legend-item.clickable').forEach(item => {
    item.addEventListener('click', () => {
      const tvId = item.dataset.tvId;
      if (tvId) selectAnalyticsTv(tvId);
    });
  });
  
  // Add click handlers for event log rows
  container.querySelectorAll('.event-log-row.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const filename = row.dataset.filename;
      selectAnalyticsImage(filename);
    });
  });
}

function renderImageDetail(filename) {
  const container = document.getElementById('analytics-image-detail');
  const statsContainer = document.getElementById('analytics-image-stats');
  const tagsContainer = document.getElementById('analytics-image-tags');
  
  if (!container) return;
  
  if (!filename) {
    container.innerHTML = '<div class="empty-state-small">Select an image to view details</div>';
    if (statsContainer) statsContainer.innerHTML = '';
    if (tagsContainer) tagsContainer.innerHTML = '';
    return;
  }
  
  const imageData = analyticsData?.images?.[filename];
  const galleryData = allImages?.[filename];
  
  // Get tags from gallery data if no analytics data, or from analytics data
  const tags = imageData?.tags || galleryData?.tags || [];
  
  // Render tags in header row (next to title)
  if (tagsContainer) {
    tagsContainer.innerHTML = tags.length > 0 
      ? tags.map(tag => `<span class="image-tag-pill-small">${escapeHtml(tag)}</span>`).join('')
      : '<span class="image-tag-pill-small untagged">(untagged)</span>';
  }
  
  // Get time-filtered data for this image (will be empty arrays/zeros if no analytics data)
  const perTv = imageData ? getPerTVStatsForImageInRange(filename) : [];
  
  // Calculate stats for selected time range (will be zeros if no analytics data)
  const imageStats = imageData ? calculateImageStatsForRange(filename) : { totalSeconds: 0, eventCount: 0 };
  
  // Render stats below dropdown
  if (statsContainer) {
    const lastDisplay = imageData ? getLastDisplayInfo(filename) : null;
    const lastDisplayText = lastDisplay ? lastDisplay.timeAgo : 'N/A';
    statsContainer.innerHTML = `
      <div class="stat-row-inline">
        <span class="stat-inline"><strong>${formatHoursNice(imageStats.totalSeconds)}</strong> time</span>
        <span class="stat-sep">·</span>
        <span class="stat-inline"><strong>${imageStats.eventCount}</strong> appearances</span>
        <span class="stat-sep">·</span>
        <span class="stat-inline">Last display <strong>${lastDisplayText}</strong></span>
      </div>
    `;
  }
  
  let html = '';
  
  // Image thumbnail with fallback handling for deleted images
  const displayName = getAnalyticsDisplayName(filename);
  html += `
    <div class="analytics-image-preview">
      <img src="thumbs/thumb_${encodeURIComponent(filename)}" 
           onerror="this.onerror=null; this.style.display='none'; this.nextElementSibling.style.display='flex';" 
           alt="${escapeHtml(displayName)}" />
      <div class="analytics-image-unavailable" style="display:none;">Image not available</div>
    </div>
  `;
  
  // Use global TV color map for consistent colors across all views
  const tvColorMap = globalTvColorMap;
  
  // TV breakdown - stacked horizontal bar (only if multiple TVs)
  const totalTvCount = Object.keys(analyticsData?.tvs || {}).length;
  if (perTv.length > 0 && totalTvCount > 1) {
    const segments = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      const pct = tv.share || 0;
      return `<div class="stacked-bar-segment" style="width: ${pct}%; background: ${color}" title="${escapeHtml(tvName)} (${formatPercent(pct)}, ${formatHoursNice(tv.seconds || 0)})"></div>`;
    }).join('');
    
    const legend = perTv.map((tv, index) => {
      const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
      const color = tvColorMap[tv.tv_id];
      return `<span class="stacked-bar-legend-item"><span class="stacked-bar-legend-color" style="background: ${color}"></span>${escapeHtml(tvName)}</span>`;
    }).join('');
    
    html += `
      <div class="stacked-bar-section">
        <div class="stacked-bar-track">${segments}</div>
        <div class="stacked-bar-legend">${legend}</div>
      </div>
    `;
  }
    
  // Labeled timelines section
  if (perTv.length > 0) {
    html += `
      <div class="labeled-timelines-section">
        <div class="labeled-timelines-title">Activity Timeline</div>
        ${perTv.map((tv, index) => {
          const tvName = analyticsData.tvs?.[tv.tv_id]?.name || tv.tv_id || 'Unknown';
          const color = tvColorMap[tv.tv_id];
          const timelineHtml = renderInlineTimeline(filename, tv.tv_id);
          // Only show TV label if multiple TVs
          const labelHtml = totalTvCount > 1 ? `
            <div class="labeled-timeline-header">
              <span class="labeled-timeline-color" style="background: ${color}"></span>
              <span class="labeled-timeline-name">${escapeHtml(tvName)}</span>
              <span class="labeled-timeline-hours">${formatHoursNice(tv.seconds || 0)}</span>
            </div>
          ` : '';
          return `
          <div class="labeled-timeline-row">
            ${labelHtml}
            ${timelineHtml}
          </div>
        `}).join('')}
      </div>
    `;
  }
  
  // Event log section (pass TV colors for dots)
  html += renderImageEventLog(filename, tvColorMap);
  
  container.innerHTML = html;
}

// Helper to format relative time ago
function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const diffWeeks = diffDays / 7;
  const diffMonths = diffDays / 30;
  
  if (diffHours < 1) return 'less than an hour ago';
  if (diffHours < 24) return diffHours < 2 ? 'an hour ago' : `${Math.floor(diffHours)} hours ago`;
  if (diffDays < 7) return diffDays < 2 ? 'a day ago' : `${Math.floor(diffDays)} days ago`;
  if (diffWeeks < 4) return diffWeeks < 2 ? 'a week ago' : `${Math.floor(diffWeeks)} weeks ago`;
  return diffMonths < 2 ? 'a month ago' : `${Math.floor(diffMonths)} months ago`;
}

// Render inline timeline for a specific TV
function renderInlineTimeline(filename, tvId) {
  const imageData = analyticsData?.images?.[filename];
  if (!imageData) return '';
  
  const displayPeriods = imageData.display_periods?.[tvId] || [];
  
  if (displayPeriods.length === 0) {
    // No display_periods means we have aggregate data but no timeline detail for this TV
    return '<div class="inline-timeline"><div class="inline-timeline-empty">No detailed timeline available</div></div>';
  }
  
  // Calculate timeline using selected time range
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Build timeline segments with detailed tooltips
  const segments = displayPeriods
    .filter(p => p.end > rangeStart)
    .map(period => {
      const start = Math.max(period.start, rangeStart);
      const end = Math.min(period.end, now);
      const leftPct = ((start - rangeStart) / rangeMs) * 100;
      const widthPct = Math.max(((end - start) / rangeMs) * 100, 0.5); // min width for visibility
      const startTime = new Date(period.start).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const duration = formatHoursNice((period.end - period.start) / 1000);
      const tooltip = `${startTime} (${duration})`;
      return `<div class="inline-timeline-segment" style="left: ${leftPct}%; width: ${widthPct}%" title="${escapeHtml(tooltip)}"></div>`;
    })
    .join('');
  
  if (!segments) {
    // Has display_periods but none in the selected time range - find most recent
    const mostRecent = displayPeriods.reduce((latest, p) => p.end > latest ? p.end : latest, 0);
    const timeAgo = formatTimeAgo(mostRecent);
    return `<div class="inline-timeline"><div class="inline-timeline-empty">Not displayed since ${timeAgo}</div></div>`;
  }
  
  // Generate full axis (edge labels above, ticks below)
  const axis = generateTimelineAxis(rangeStart, rangeMs, false);
  
  return `
    <div class="inline-timeline">
      ${axis.edges}
      <div class="inline-timeline-track">${segments}</div>
      ${axis.ticks}
    </div>
  `;
}

// Render event log for an image (all events in selected time range)
function renderImageEventLog(filename, tvColorMap = {}) {
  const imageData = analyticsData?.images?.[filename];
  if (!imageData || !imageData.display_periods) {
    return '';
  }
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Collect all events from all TVs within time range
  const allEvents = [];
  for (const [tvId, periods] of Object.entries(imageData.display_periods)) {
    const tvName = analyticsData.tvs?.[tvId]?.name || 'Unknown TV';
    for (const period of periods) {
      if (period.end > rangeStart) {
        allEvents.push({
          tvName,
          tvId,
          start: period.start,
          end: period.end,
          duration: period.end - period.start,
          matte: period.matte,
          photo_filter: period.photo_filter
        });
      }
    }
  }
  
  if (allEvents.length === 0) {
    return '<div class="event-log"><div class="event-log-title">Display Events</div><div class="event-log-empty">No events in selected time range</div></div>';
  }
  
  // Sort by start time descending (most recent first)
  allEvents.sort((a, b) => b.start - a.start);
  
  const hasTvColors = Object.keys(tvColorMap).length > 0;
  
  const eventRows = allEvents.map(evt => {
    const startDate = new Date(evt.start);
    // duration is in ms, convert to seconds for formatHoursNice
    const durationFormatted = formatHoursNice(evt.duration / 1000);
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const filterMatteSuffix = formatFilterMatteSuffix(evt.photo_filter, evt.matte);
    const tvColor = tvColorMap[evt.tvId] || '#95a5a6';
    const tvDot = hasTvColors ? `<span class="event-log-tv-dot" style="background: ${tvColor}" title="${escapeHtml(evt.tvName)}"></span>` : '';
    
    return `
      <div class="event-log-row">
        <span class="event-log-date">${tvDot}${dateStr}</span>
        <span class="event-log-time">${timeStr}</span>
        <span class="event-log-tv"><span class="event-log-tv-text">${escapeHtml(evt.tvName)}</span>${filterMatteSuffix}</span>
        <span class="event-log-duration">${durationFormatted}</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="event-log">
      <div class="event-log-title">Display Events (${allEvents.length})</div>
      <div class="event-log-header">
        <span>Date</span>
        <span>Time</span>
        <span>TV</span>
        <span>Duration</span>
      </div>
      <div class="event-log-scroll">
        ${eventRows}
      </div>
    </div>
  `;
}

function renderImageTimeline(filename, tvId) {
  const container = document.getElementById('analytics-timeline-container');
  if (!container || !analyticsData) return;
  
  const imageData = analyticsData.images?.[filename];
  if (!imageData) {
    container.style.display = 'none';
    return;
  }
  
  // Get display periods for this TV (from imageData.display_periods if available)
  const displayPeriods = imageData.display_periods?.[tvId] || [];
  
  if (displayPeriods.length === 0) {
    // Show placeholder with generic timeline
    container.style.display = 'block';
    container.innerHTML = `
      <div class="timeline-bar-container">
        <div class="timeline-bar">
          <div class="timeline-bar-track">
            <div class="timeline-bar-empty">No detailed timeline data available</div>
          </div>
        </div>
      </div>
    `;
    return;
  }
  
  // Calculate timeline (last 7 days)
  const now = Date.now();
  const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
  const totalRange = now - weekAgo;
  
  // Build timeline segments
  const segments = displayPeriods
    .filter(p => p.end > weekAgo)
    .map(period => {
      const start = Math.max(period.start, weekAgo);
      const end = Math.min(period.end, now);
      const leftPct = ((start - weekAgo) / totalRange) * 100;
      const widthPct = ((end - start) / totalRange) * 100;
      return `<div class="timeline-bar-segment" style="left: ${leftPct}%; width: ${widthPct}%" title="${new Date(start).toLocaleString()}"></div>`;
    })
    .join('');
  
  container.style.display = 'block';
  container.innerHTML = `
    <div class="timeline-bar-container">
      <div class="timeline-bar-label">Display history (last 7 days)</div>
      <div class="timeline-bar">
        <div class="timeline-bar-track">
          ${segments || '<div class="timeline-bar-empty">No displays in last 7 days</div>'}
        </div>
      </div>
      <div class="timeline-bar-axis">
        <span>7d ago</span>
        <span>Now</span>
      </div>
    </div>
  `;
}

function setupAnalyticsEventListeners() {
  // Retry button
  const retryBtn = document.getElementById('analytics-retry-btn');
  if (retryBtn) {
    retryBtn.onclick = () => loadAnalytics();
  }
  
  // Time range buttons (time pills)
  document.querySelectorAll('#analytics-time-range-buttons .time-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      // Update active state
      document.querySelectorAll('#analytics-time-range-buttons .time-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update selected range and re-render affected views
      selectedTimeRange = btn.dataset.range;
      updateDateRangeHint();
      if (selectedTv) renderTVDetail(selectedTv);
      // Re-render tag selector (filters by time range)
      renderTagSelector();
      if (selectedImage) renderImageDetail(selectedImage);
      // Re-render main chart too
      renderOverallPieChart();
    });
  });
  
  // Initial date range hint
  updateDateRangeHint();
  
  // TV selector
  const tvSelect = document.getElementById('analytics-tv-select');
  if (tvSelect) {
    tvSelect.onchange = (e) => {
      selectedTv = e.target.value || null;
      renderTVDetail(selectedTv);
    };
  }
  
  // Tag selector
  const tagSelect = document.getElementById('analytics-tag-select');
  if (tagSelect) {
    tagSelect.onchange = (e) => {
      selectedTag = e.target.value || null;
      renderTagDetail(selectedTag);
    };
  }
  
  // Image selector (dropdown)
  const imageSelect = document.getElementById('analytics-image-select');
  if (imageSelect) {
    imageSelect.onchange = (e) => {
      selectedImage = e.target.value || null;
      renderImageDetail(selectedImage);
    };
  }
}

function selectAnalyticsTv(tvId) {
  selectedTv = tvId;
  
  // Update TV dropdown
  const tvSelect = document.getElementById('analytics-tv-select');
  if (tvSelect) {
    tvSelect.value = tvId;
  }
  
  renderTVDetail(tvId);
}

function selectAnalyticsImage(filename) {
  selectedImage = filename;
  
  // Update image dropdown
  const imageSelect = document.getElementById('analytics-image-select');
  if (imageSelect) {
    imageSelect.value = filename;
  }
  
  renderImageDetail(filename);
}

// Helper: get display name for analytics (remove hash if unique)
function getAnalyticsDisplayName(filename) {
  const { base, ext, hasUuid } = extractBaseComponents(filename);
  if (!hasUuid) {
    return filename;
  }
  
  // Check if removing the hash would cause ambiguity with other files
  // Use allImages (all gallery files) since we now show all images in the dropdown
  const allFilenames = Object.keys(allImages || {});
  const baseWithExt = base + ext;
  const sharedBaseCount = allFilenames.filter(fn => {
    const parsed = extractBaseComponents(fn);
    return (parsed.base + parsed.ext) === baseWithExt;
  }).length;
  
  if (sharedBaseCount > 1) {
    return filename; // Keep hash to disambiguate
  }
  
  return baseWithExt; // Safe to remove hash
}

// Helper: truncate filename for display
function truncateFilename(filename, maxLen) {
  // First, get the display name (remove hash if unique)
  const displayName = getAnalyticsDisplayName(filename);
  
  if (!displayName || displayName.length <= maxLen) return displayName;
  const ext = displayName.lastIndexOf('.');
  if (ext > 0 && displayName.length - ext < 6) {
    // Keep extension
    const extPart = displayName.substring(ext);
    const namePart = displayName.substring(0, ext);
    const availLen = maxLen - extPart.length - 3;
    if (availLen > 5) {
      return namePart.substring(0, availLen) + '...' + extPart;
    }
  }
  return displayName.substring(0, maxLen - 3) + '...';
}

// Helper: format filter/matte suffix for display in event logs and gallery
// Returns a small icon with tooltip showing the non-none filter/matte values
function formatFilterMatteSuffix(photoFilter, matte) {
  const hasFilter = photoFilter && photoFilter.toLowerCase() !== 'none';
  const hasMatte = matte && matte.toLowerCase() !== 'none';
  
  if (!hasFilter && !hasMatte) return '';
  
  let html = '';
  if (hasFilter) {
    html += `<span class="indicator-filter" title="filter: ${photoFilter}">✦</span>`;
  }
  if (hasMatte) {
    html += `<span class="indicator-matte" title="matte: ${matte}">⧈</span>`;
  }
  
  return ` <span class="filter-matte-indicators">${html}</span>`;
}

// Helper: format seconds to hours (1 decimal) - legacy
function formatHours(seconds) {
  return (seconds / 3600).toFixed(1);
}

// Helper: format seconds to nice hours display (XhYm format, no decimals)
function formatHoursNice(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  
  // Show days for >= 48 hours
  if (hours >= 48) {
    const days = Math.round(hours / 24);
    return days + 'd';
  }
  // Just minutes if under 1 hour
  if (hours < 1) {
    return mins + 'm';
  }
  // XhYm format for hours >= 1
  if (mins === 0) {
    return hours + 'h';
  }
  return hours + 'h' + mins + 'm';
}

// Helper: format percentage nicely (no unnecessary decimals)
function formatPercent(value) {
  if (value >= 10 || value === 0) {
    return Math.round(value) + '%';
  }
  return value.toFixed(1).replace(/\.0$/, '') + '%';
}

// Helper: calculate TV stats for the selected time range
function calculateTVStatsForRange(tvId) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  let totalSeconds = 0;
  let eventCount = 0;
  
  // Sum up display time for this TV across all images in the time range
  for (const [filename, imageData] of Object.entries(images)) {
    const periods = imageData.display_periods?.[tvId] || [];
    for (const period of periods) {
      if (period.end > rangeStart) {
        const start = Math.max(period.start, rangeStart);
        const end = Math.min(period.end, now);
        totalSeconds += (end - start) / 1000;
        eventCount++;
      }
    }
  }
  
  // Calculate share of total (all TVs in this time range)
  let allTVsTotal = 0;
  const tvIds = Object.keys(analyticsData?.tvs || {});
  for (const otherTvId of tvIds) {
    for (const [filename, imageData] of Object.entries(images)) {
      const periods = imageData.display_periods?.[otherTvId] || [];
      for (const period of periods) {
        if (period.end > rangeStart) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          allTVsTotal += (end - start) / 1000;
        }
      }
    }
  }
  
  const shareOfTotal = allTVsTotal > 0 ? (totalSeconds / allTVsTotal) * 100 : 0;
  
  return { totalSeconds, eventCount, shareOfTotal };
}

// Helper: get tags that have activity in the selected time range
function getTagsWithActivityInRange() {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const tagsWithActivity = new Set();
  
  for (const [filename, imageData] of Object.entries(images)) {
    // Check if this image has any display periods in range
    let hasActivityInRange = false;
    for (const periods of Object.values(imageData.display_periods || {})) {
      for (const period of periods) {
        if (period.end > rangeStart) {
          hasActivityInRange = true;
          break;
        }
      }
      if (hasActivityInRange) break;
    }
    
    if (hasActivityInRange) {
      const imageTags = imageData.tags || [];
      if (imageTags.length === 0) {
        tagsWithActivity.add('<none>');
      } else {
        imageTags.forEach(tag => tagsWithActivity.add(tag));
      }
    }
  }
  
  return Array.from(tagsWithActivity);
}

// Helper: check if an image matches a tagset filter (has any include tag AND no exclude tags)
// Case-insensitive matching to handle different tag casing between systems
function imageMatchesTagset(imageData, tagset) {
  const imageTags = (imageData.tags || []).map(t => t.toLowerCase());
  // Strip virtual tags — no library image carries them; if all include tags are virtual,
  // treat it the same as having no include tags (all images eligible).
  const includeTags = (tagset.tags || [])
    .map(t => t.toLowerCase())
    .filter(t => t !== WEB_SOURCES_VIRTUAL_TAG && !t.startsWith('ws:'));
  const excludeTags = (tagset.exclude_tags || []).map(t => t.toLowerCase());

  // If no library include tags specified, all images match (unless excluded)
  const matchesInclude = includeTags.length === 0 ||
    imageTags.some(tag => includeTags.includes(tag));

  // Check none of the image tags are in exclude list
  const matchesExclude = !imageTags.some(tag => excludeTags.includes(tag));

  return matchesInclude && matchesExclude;
}

// Helper: get tagsets that have activity in the selected time range
// Only includes tagsets that have events where tagset_name strictly matches
function getTagsetsWithActivityInRange() {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const activeSets = new Set();
  
  // Find all tagset_names recorded in events within the time range
  for (const [filename, imageData] of Object.entries(images)) {
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        if (period.end > rangeStart && period.tagset_name) {
          // Only add if this tagset still exists in our config
          if (allGlobalTagsets?.[period.tagset_name]) {
            activeSets.add(period.tagset_name);
          }
        }
      }
    }
  }
  
  return Array.from(activeSets).sort((a, b) => a.localeCompare(b));
}

// Helper: calculate tagset stats for the selected time range
// Filters by tagset_name recorded in events, not current tag matching
function calculateTagsetStatsForRange(tagsetName) {
  if (!tagsetName) return { totalSeconds: 0, eventCount: 0 };
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  let totalSeconds = 0;
  let eventCount = 0;
  
  for (const [filename, imageData] of Object.entries(images)) {
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        // Only count events where tagset_name matches
        if (period.end > rangeStart && period.tagset_name === tagsetName) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          totalSeconds += (end - start) / 1000;
          eventCount++;
        }
      }
    }
  }
  
  return { totalSeconds, eventCount };
}

// Helper: get per-TV stats for a tagset within the selected time range
// Filters by tagset_name recorded in events, not current tag matching
function getPerTVStatsForTagsetInRange(tagsetName) {
  if (!tagsetName) return [];
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const tvStats = {};
  let totalSeconds = 0;
  
  for (const [filename, imageData] of Object.entries(images)) {
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        // Only count events where tagset_name matches
        if (period.end > rangeStart && period.tagset_name === tagsetName) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          const seconds = (end - start) / 1000;
          tvStats[tvId] = (tvStats[tvId] || 0) + seconds;
          totalSeconds += seconds;
        }
      }
    }
  }
  
  return Object.entries(tvStats)
    .map(([tv_id, seconds]) => ({
      tv_id,
      seconds,
      share: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Render event log for a tagset (events where tagset_name matches)
function renderTagsetEventLog(tagsetName, showSeparator = true, tvColorMap = {}) {
  if (!tagsetName) return '<div class="event-log"><div class="event-log-empty">Tagset not found</div></div>';
  
  const images = analyticsData?.images || {};
  const tvs = analyticsData?.tvs || {};
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Collect all events where tagset_name matches
  const allEvents = [];
  
  for (const [filename, imageData] of Object.entries(images)) {
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      const tvName = tvs[tvId]?.name || 'Unknown TV';
      for (const period of periods) {
        // Only include events where tagset_name matches
        if (period.end > rangeStart && period.tagset_name === tagsetName) {
          allEvents.push({
            filename,
            tvId,
            tvName,
            start: period.start,
            end: period.end,
            duration: period.end - period.start,
            matte: period.matte,
            photo_filter: period.photo_filter
          });
        }
      }
    }
  }
  
  const separatorClass = showSeparator ? '' : ' no-separator';
  const hasTvColors = Object.keys(tvColorMap).length > 0;
  
  if (allEvents.length === 0) {
    return `<div class="event-log${separatorClass}"><div class="event-log-title">Display Events</div><div class="event-log-empty">No events in selected time range</div></div>`;
  }
  
  // Sort by start time descending
  allEvents.sort((a, b) => b.start - a.start);
  
  const eventRows = allEvents.map(evt => {
    const startDate = new Date(evt.start);
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const imageName = truncateFilename(evt.filename, 18);
    const filterMatteSuffix = formatFilterMatteSuffix(evt.photo_filter, evt.matte);
    const tvColor = tvColorMap[evt.tvId] || '#95a5a6';
    const tvDot = hasTvColors ? `<span class="event-log-tv-dot" style="background: ${tvColor}" title="${escapeHtml(evt.tvName)}"></span>` : '';
    
    return `
      <div class="event-log-row clickable" data-filename="${escapeHtml(evt.filename)}">
        <span class="event-log-date">${tvDot}${dateStr}</span>
        <span class="event-log-time">${timeStr}</span>
        <span class="event-log-image"><span class="event-log-image-text">${escapeHtml(imageName)}</span>${filterMatteSuffix}</span>
        <span class="event-log-duration">${formatHoursNice((evt.duration) / 1000)}</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="event-log${separatorClass}">
      <div class="event-log-title">Display Events (${allEvents.length})</div>
      <div class="event-log-header">
        <span>Date</span>
        <span>Time</span>
        <span>Image</span>
        <span>Duration</span>
      </div>
      <div class="event-log-rows">${eventRows}</div>
    </div>
  `;
}

// Helper: calculate tag stats for the selected time range
function calculateTagStatsForRange(tagName) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;

  const images = analyticsData?.images || {};
  let totalSeconds = 0;
  let eventCount = 0;
  
  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = imageData.tags || [];
    const hasTag = tagName === '<none>' 
      ? imageTags.length === 0 
      : imageTags.includes(tagName);
    
    if (!hasTag) continue;
    
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        if (period.end > rangeStart) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          totalSeconds += (end - start) / 1000;
          eventCount++;
        }
      }
    }
  }
  
  return { totalSeconds, eventCount };
}

// Helper: calculate image stats for the selected time range
function calculateImageStatsForRange(filename) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const imageData = analyticsData?.images?.[filename];
  if (!imageData) return { totalSeconds: 0, eventCount: 0, tvCount: 0 };
  
  let totalSeconds = 0;
  let eventCount = 0;
  const tvsWithActivity = new Set();
  
  for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
    for (const period of periods) {
      if (period.end > rangeStart) {
        const start = Math.max(period.start, rangeStart);
        const end = Math.min(period.end, now);
        totalSeconds += (end - start) / 1000;
        eventCount++;
        tvsWithActivity.add(tvId);
      }
    }
  }
  
  return { totalSeconds, eventCount, tvCount: tvsWithActivity.size };
}

// Helper: get top images for a TV within the selected time range
function getTopImagesForTVInRange(tvId) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const imageSeconds = {};
  
  for (const [filename, imageData] of Object.entries(images)) {
    const periods = imageData.display_periods?.[tvId] || [];
    let seconds = 0;
    for (const period of periods) {
      if (period.end > rangeStart) {
        const start = Math.max(period.start, rangeStart);
        const end = Math.min(period.end, now);
        seconds += (end - start) / 1000;
      }
    }
    if (seconds > 0) {
      imageSeconds[filename] = seconds;
    }
  }
  
  // Sort by seconds descending and return top entries
  return Object.entries(imageSeconds)
    .map(([filename, seconds]) => ({ filename, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Helper: get top images for a tag within the selected time range
function getTopImagesForTagInRange(tagName) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const imageSeconds = {};
  
  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = imageData.tags || [];
    const hasTag = tagName === '<none>' 
      ? imageTags.length === 0 
      : imageTags.includes(tagName);
    
    if (!hasTag) continue;
    
    let seconds = 0;
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        if (period.end > rangeStart) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          seconds += (end - start) / 1000;
        }
      }
    }
    if (seconds > 0) {
      imageSeconds[filename] = seconds;
    }
  }
  
  return Object.entries(imageSeconds)
    .map(([filename, seconds]) => ({ filename, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Helper: get per-TV stats for an image within the selected time range
function getPerTVStatsForImageInRange(filename) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const imageData = analyticsData?.images?.[filename];
  if (!imageData) return [];
  
  const tvStats = {};
  let totalSeconds = 0;
  
  for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
    let seconds = 0;
    for (const period of periods) {
      if (period.end > rangeStart) {
        const start = Math.max(period.start, rangeStart);
        const end = Math.min(period.end, now);
        seconds += (end - start) / 1000;
      }
    }
    if (seconds > 0) {
      tvStats[tvId] = seconds;
      totalSeconds += seconds;
    }
  }
  
  // Return array with share percentages
  return Object.entries(tvStats)
    .map(([tv_id, seconds]) => ({
      tv_id,
      seconds,
      share: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Helper: get per-TV stats for a tag within the selected time range
function getPerTVStatsForTagInRange(tagName) {
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  const images = analyticsData?.images || {};
  const tvStats = {};
  let totalSeconds = 0;
  
  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = imageData.tags || [];
    const hasTag = tagName === '<none>' 
      ? imageTags.length === 0 
      : imageTags.includes(tagName);
    
    if (!hasTag) continue;
    
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      for (const period of periods) {
        if (period.end > rangeStart) {
          const start = Math.max(period.start, rangeStart);
          const end = Math.min(period.end, now);
          const seconds = (end - start) / 1000;
          tvStats[tvId] = (tvStats[tvId] || 0) + seconds;
          totalSeconds += seconds;
        }
      }
    }
  }
  
  return Object.entries(tvStats)
    .map(([tv_id, seconds]) => ({
      tv_id,
      seconds,
      share: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0
    }))
    .sort((a, b) => b.seconds - a.seconds);
}

// Helper: format date range for display
function formatDateRange(startMs, endMs) {
  const startDate = new Date(startMs);
  const startStr = startDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return `[data since ${startStr}]`;
}

// Update the date range hint in the header
function updateDateRangeHint() {
  const hintEl = document.getElementById('analytics-date-range');
  if (!hintEl) return;
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Map time range to human-readable label
  const rangeLabels = {
    '1h': 'hour',
    '1d': 'day',
    '1w': 'week',
    '1mo': 'month',
    '6mo': '6 months'
  };
  const rangeLabel = rangeLabels[selectedTimeRange] || 'week';
  
  const startDate = new Date(rangeStart);
  
  // For hour/day, include time; for longer ranges, just date
  let dateStr;
  if (selectedTimeRange === '1h' || selectedTimeRange === '1d') {
    dateStr = startDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) +
              ' at ' + startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } else {
    dateStr = startDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  }
  
  hintEl.textContent = `Displaying last ${rangeLabel} of shuffle data (since ${dateStr})`;
}

// Render event log for a tag (all events for images with this tag)
function renderTagEventLog(tagName, showSeparator = true, tvColorMap = {}) {
  const images = analyticsData?.images || {};
  const tvs = analyticsData?.tvs || {};
  
  const now = Date.now();
  const rangeMs = TIME_RANGES[selectedTimeRange] || TIME_RANGES['1w'];
  const rangeStart = now - rangeMs;
  
  // Collect all events for images with this tag
  const allEvents = [];
  
  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = imageData.tags || [];
    const hasTag = tagName === '<none>' 
      ? imageTags.length === 0 
      : imageTags.includes(tagName);
    
    if (!hasTag) continue;
    
    for (const [tvId, periods] of Object.entries(imageData.display_periods || {})) {
      const tvName = tvs[tvId]?.name || 'Unknown TV';
      for (const period of periods) {
        if (period.end > rangeStart) {
          allEvents.push({
            filename,
            tvId,
            tvName,
            start: period.start,
            end: period.end,
            duration: period.end - period.start,
            matte: period.matte,
            photo_filter: period.photo_filter
          });
        }
      }
    }
  }
  
  const separatorClass = showSeparator ? '' : ' no-separator';
  const hasTvColors = Object.keys(tvColorMap).length > 0;
  
  if (allEvents.length === 0) {
    return `<div class="event-log${separatorClass}"><div class="event-log-title">Display Events</div><div class="event-log-empty">No events in selected time range</div></div>`;
  }
  
  // Sort by start time descending
  allEvents.sort((a, b) => b.start - a.start);
  
  const eventRows = allEvents.map(evt => {
    const startDate = new Date(evt.start);
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const imageName = truncateFilename(evt.filename, 18);
    const filterMatteSuffix = formatFilterMatteSuffix(evt.photo_filter, evt.matte);
    const tvColor = tvColorMap[evt.tvId] || '#95a5a6';
    const tvDot = hasTvColors ? `<span class="event-log-tv-dot" style="background: ${tvColor}" title="${escapeHtml(evt.tvName)}"></span>` : '';
    
    return `
      <div class="event-log-row clickable" data-filename="${escapeHtml(evt.filename)}">
        <span class="event-log-date">${tvDot}${dateStr}</span>
        <span class="event-log-time">${timeStr}</span>
        <span class="event-log-image"><span class="event-log-image-text">${escapeHtml(imageName)}</span>${filterMatteSuffix}</span>
        <span class="event-log-duration">${formatHoursNice((evt.duration) / 1000)}</span>
      </div>
    `;
  }).join('');
  
  return `
    <div class="event-log${separatorClass}">
      <div class="event-log-title">Display Events (${allEvents.length})</div>
      <div class="event-log-header">
        <span>Date</span>
        <span>Time</span>
        <span>Image</span>
        <span>Duration</span>
      </div>
      <div class="event-log-scroll">
        ${eventRows}
      </div>
    </div>
  `;
}

// ============================================================================
// TAGSETS MANAGEMENT
// ============================================================================

// Load and render the Tags tab content
async function loadTagsTab() {
  // Ensure we have TV data
  if (!allTVs || allTVs.length === 0) {
    await loadTVs();
  }

  renderTagsetsTable();
  renderTVAssignments();
}

// ============================================================================
// FIELDS TAB
// ============================================================================

async function loadCustomDataTab() {
  await Promise.all([loadAttributes(), loadEntities()]);
  renderCustomDataList();
  initNewAttributeButton();
  initNewEntityButton();
}

function renderAttributesTable() {
  const container = document.getElementById('attributes-table-container');
  if (!container) return;

  if (!allAttributes || allAttributes.length === 0) {
    container.innerHTML = '<p class="empty-state">No attributes defined. Click "+ New Attribute" to create one.</p>';
    return;
  }

  let html = `
    <table class="tagsets-table attributes-table">
      <thead>
        <tr>
          <th class="th-drag"></th>
          <th>Attribute Name</th>
          <th class="th-actions"></th>
        </tr>
      </thead>
      <tbody id="attributes-tbody">
  `;

  for (const attrName of allAttributes) {
    html += `
      <tr draggable="true" data-attribute="${escapeHtml(attrName)}">
        <td class="td-drag"><span class="drag-handle" title="Drag to reorder">⠿</span></td>
        <td>${escapeHtml(attrName)}</td>
        <td class="td-actions">
          <button class="btn-icon btn-danger-icon delete-attribute-btn" data-attribute="${escapeHtml(attrName)}" title="Delete attribute">✕</button>
        </td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  container.querySelectorAll('.delete-attribute-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteAttribute(btn.dataset.attribute));
  });

  initAttributesDragAndDrop(container.querySelector('#attributes-tbody'));
}

function initAttributesDragAndDrop(tbody) {
  if (!tbody) return;
  let dragSrc = null;

  tbody.addEventListener('dragstart', e => {
    const row = e.target.closest('tr');
    if (!row) return;
    dragSrc = row;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.attribute);
    row.classList.add('dragging');
  });

  tbody.addEventListener('dragend', e => {
    const row = e.target.closest('tr');
    if (row) row.classList.remove('dragging');
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    dragSrc = null;
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('tr');
    if (!row || row === dragSrc) return;
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });

  tbody.addEventListener('dragleave', e => {
    const row = e.target.closest('tr');
    if (row) row.classList.remove('drag-over');
  });

  tbody.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('tr');
    if (!target || !dragSrc || target === dragSrc) return;
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));

    // Reorder DOM
    const rows = [...tbody.querySelectorAll('tr')];
    const srcIdx = rows.indexOf(dragSrc);
    const tgtIdx = rows.indexOf(target);
    if (srcIdx < tgtIdx) {
      target.after(dragSrc);
    } else {
      target.before(dragSrc);
    }

    // Sync allAttributes to new DOM order and persist
    allAttributes = [...tbody.querySelectorAll('tr')].map(r => r.dataset.attribute);
    saveAttributeOrder();
  });
}

async function saveAttributeOrder() {
  try {
    await fetch(`${API_BASE}/attributes/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: allAttributes })
    });
  } catch (error) {
    console.error('Error saving attribute order:', error);
  }
}

function initNewAttributeButton() {
  const btn = document.getElementById('new-attribute-btn');
  if (!btn || btn.dataset.attributesInitialized) return;
  btn.dataset.attributesInitialized = '1';
  btn.addEventListener('click', promptNewAttribute);
}

async function promptNewAttribute() {
  const name = prompt('Enter attribute name:');
  if (!name || !name.trim()) return;

  const trimmed = name.trim();

  if (allAttributes.includes(trimmed)) {
    alert(`Attribute "${trimmed}" already exists.`);
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    const result = await response.json();
    if (result.success) {
      allAttributes = result.attributes;
      // Rebuild customDataOrder to include new attribute
      await loadEntities();
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to add attribute');
    }
  } catch (error) {
    console.error('Error adding attribute:', error);
    alert('Failed to add attribute');
  }
}

async function deleteAttribute(attributeName) {
  try {
    // Check if any images have a non-empty value for this attribute
    const usageResponse = await fetch(`${API_BASE}/attributes/${encodeURIComponent(attributeName)}/usage`);
    const usageData = await usageResponse.json();
    const imagesWithValue = usageData.imagesWithValue || [];

    if (imagesWithValue.length > 0) {
      const confirmMsg = `${imagesWithValue.length} image(s) have a value for "${attributeName}". Deleting this attribute will remove those values. Continue?`;
      if (!confirm(confirmMsg)) return;
    }

    const response = await fetch(`${API_BASE}/attributes/${encodeURIComponent(attributeName)}`, {
      method: 'DELETE'
    });
    const result = await response.json();
    if (result.success) {
      allAttributes = result.attributes;
      // Update local image cache to remove this attribute
      for (const imageData of Object.values(allImages)) {
        if (imageData.attributes) {
          delete imageData.attributes[attributeName];
        }
      }
      await loadEntities(); // refresh customDataOrder
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to delete attribute');
    }
  } catch (error) {
    console.error('Error deleting attribute:', error);
    alert('Failed to delete attribute');
  }
}

// ============================================================================
// Entity-related helpers
// ============================================================================

// Must match server-side slugify in metadata_helper.js
function entitySlugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'entity';
}

// Build entity input box HTML (shared by upload and modal contexts)
function renderEntityInputBox(entityType, instanceData, instanceKey) {
  return `
    <div class="entity-input-box" data-entity-id="${escapeHtml(entityType.id)}" data-instance-key="${escapeHtml(instanceKey || '')}">
      <div class="entity-input-header">${escapeHtml(entityType.name)}</div>
      <div class="entity-input-attrs">
        ${entityType.attributes.map((attrName, i) => {
          const val = escapeHtml(String((instanceData && instanceData[attrName]) || ''));
          const isKey = i === 0;
          return `
            <div class="modal-attribute-row">
              <label class="modal-attribute-label">
                ${isKey ? '<span class="entity-key-star" title="Key attribute">★</span> ' : ''}${escapeHtml(attrName)}:
              </label>
              <div class="entity-attr-field-wrapper">
                <input type="text"
                       class="modal-attribute-input entity-field-input${isKey ? ' entity-key-input' : ''}"
                       data-entity-id="${escapeHtml(entityType.id)}"
                       data-attribute="${escapeHtml(attrName)}"
                       data-is-key="${isKey ? '1' : '0'}"
                       value="${val}"
                       placeholder="${isKey ? 'Type to search or add new…' : ''}"
                       autocomplete="off" />
                ${isKey ? `<div class="entity-autocomplete-dropdown" data-entity-id="${escapeHtml(entityType.id)}"></div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// Render entity input boxes in the upload form
function renderUploadEntities() {
  const section = document.getElementById('upload-entities-section');
  if (!section) return;

  if (!allEntityTypes || allEntityTypes.length === 0) {
    section.style.display = 'none';
    section.innerHTML = '';
    return;
  }

  section.style.display = '';
  section.innerHTML = allEntityTypes.map(et => renderEntityInputBox(et, {}, '')).join('');

  section.querySelectorAll('.entity-key-input').forEach(input => {
    initEntityKeyAutocomplete(input, allEntityInstances[input.dataset.entityId] || {});
  });
}

// Collect entity data from the upload form
function collectUploadEntities() {
  const result = {};
  document.querySelectorAll('#upload-entities-section .entity-input-box').forEach(box => {
    const entityId = box.dataset.entityId;
    const data = {};
    box.querySelectorAll('.entity-field-input').forEach(input => {
      data[input.dataset.attribute] = input.value;
    });
    const entityType = allEntityTypes.find(e => e.id === entityId);
    const keyAttr = entityType && entityType.attributes[0];
    if (keyAttr && data[keyAttr] && data[keyAttr].trim()) {
      result[entityId] = data;
    }
  });
  return Object.keys(result).length > 0 ? result : null;
}

// Render entity input boxes in the image edit modal
function renderModalEntities(imageData) {
  const section = document.getElementById('modal-entities-section');
  const container = document.getElementById('modal-entities-inputs');
  if (!section || !container) return;

  if (!allEntityTypes || allEntityTypes.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  const entityRefs = (imageData && imageData.entityRefs) || {};

  container.innerHTML = allEntityTypes.map(entityType => {
    const instanceKey = entityRefs[entityType.id] || '';
    const instanceData = instanceKey ? ((allEntityInstances[entityType.id] || {})[instanceKey] || {}) : {};
    return renderEntityInputBox(entityType, instanceData, instanceKey);
  }).join('');

  container.querySelectorAll('.entity-input-box').forEach(box => {
    const entityId = box.dataset.entityId;
    const keyInput = box.querySelector('.entity-key-input');
    if (keyInput) {
      initEntityKeyAutocomplete(keyInput, allEntityInstances[entityId] || {});
    }
    box.querySelectorAll('.entity-field-input').forEach(input => {
      input.addEventListener('blur', () => {
        setTimeout(() => saveModalEntityBox(box), 150);
      });
    });
  });
}

// Initialize autocomplete on an entity key field
function initEntityKeyAutocomplete(keyInput, instances) {
  const entityId = keyInput.dataset.entityId;
  const entityType = allEntityTypes.find(e => e.id === entityId);
  if (!entityType) return;
  const keyAttr = entityType.attributes[0];
  const wrapper = keyInput.closest('.entity-attr-field-wrapper');
  const dropdown = wrapper && wrapper.querySelector('.entity-autocomplete-dropdown');
  if (!dropdown) return;

  function showDropdown(matches) {
    if (matches.length === 0) {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
      return;
    }
    dropdown.innerHTML = matches
      .map(([key, data]) => `<div class="entity-autocomplete-item" data-key="${escapeHtml(key)}">${escapeHtml(data[keyAttr] || key)}</div>`)
      .join('');
    dropdown.style.display = '';
    dropdown.querySelectorAll('.entity-autocomplete-item').forEach(item => {
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        selectEntityInstance(keyInput, instances, item.dataset.key, entityType);
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
      });
    });
  }

  keyInput.addEventListener('input', () => {
    const q = keyInput.value.trim().toLowerCase();
    if (!q) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
    const matches = Object.entries(instances).filter(([, data]) =>
      String(data[keyAttr] || '').toLowerCase().includes(q)
    );
    showDropdown(matches);
  });

  keyInput.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }, 200);
  });

  keyInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  });
}

// Fill entity fields from a selected autocomplete instance
function selectEntityInstance(keyInput, instances, instanceKey, entityType) {
  const instanceData = instances[instanceKey];
  if (!instanceData) return;
  const box = keyInput.closest('.entity-input-box');
  if (!box) return;
  box.dataset.instanceKey = instanceKey;
  box.querySelectorAll('.entity-field-input').forEach(input => {
    const attr = input.dataset.attribute;
    if (attr in instanceData) input.value = instanceData[attr];
  });
}

// Save entity data from the modal after blur
async function saveModalEntityBox(box) {
  if (!currentImage) return;
  const entityId = box.dataset.entityId;
  const entityType = allEntityTypes.find(e => e.id === entityId);
  if (!entityType) return;

  const keyAttr = entityType.attributes[0];
  const data = {};
  box.querySelectorAll('.entity-field-input').forEach(input => {
    data[input.dataset.attribute] = input.value;
  });

  const keyValue = (data[keyAttr] || '').trim();

  // If key is empty, clear any existing ref
  if (!keyValue) {
    const oldKey = box.dataset.instanceKey;
    if (oldKey) {
      try {
        const resp = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entityRefs: { [entityId]: null } })
        });
        const result = await resp.json();
        if (result.success && result.data) allImages[currentImage] = result.data;
      } catch (e) {
        console.error('Error clearing entity ref:', e);
      }
      box.dataset.instanceKey = '';
    }
    return;
  }

  const candidateKey = entitySlugify(keyValue);
  const existingInstances = allEntityInstances[entityId] || {};
  const oldKey = box.dataset.instanceKey;

  // Warn if modifying an existing instance also used by other images
  if (candidateKey in existingInstances && candidateKey === oldKey) {
    const otherImages = Object.keys(allImages).filter(f =>
      f !== currentImage && ((allImages[f].entityRefs || {})[entityId] === candidateKey)
    );
    if (otherImages.length > 0) {
      const plural = otherImages.length === 1 ? 'image' : 'images';
      const confirmed = confirm(
        `This ${entityType.name} is also linked to ${otherImages.length} other ${plural}. ` +
        `Saving will update the ${entityType.name} data for all of them. Continue?`
      );
      if (!confirmed) {
        // Revert fields to original instance data
        const orig = existingInstances[oldKey] || {};
        box.querySelectorAll('.entity-field-input').forEach(input => {
          input.value = orig[input.dataset.attribute] || '';
        });
        return;
      }
    }
  }

  try {
    const upsertResp = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    });
    const upsertResult = await upsertResp.json();
    if (!upsertResult.success) {
      console.error('Failed to save entity instance:', upsertResult.error);
      return;
    }

    const newKey = upsertResult.key;
    const refResp = await fetch(`${API_BASE}/images/${encodeURIComponent(currentImage)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityRefs: { [entityId]: newKey } })
    });
    const refResult = await refResp.json();
    if (refResult.success && refResult.data) {
      allImages[currentImage] = refResult.data;
      box.dataset.instanceKey = newKey;
      if (!allEntityInstances[entityId]) allEntityInstances[entityId] = {};
      allEntityInstances[entityId][newKey] = upsertResult.data;
    }
  } catch (error) {
    console.error('Error saving entity data:', error);
  }
}

// ============================================================================
// Custom Data tab — unified list (attributes + entity types)
// ============================================================================

function renderCustomDataList() {
  const container = document.getElementById('custom-data-list-container');
  if (!container) return;

  // Build ordered list
  let order = allCustomDataOrder;
  if (!order || order.length === 0) {
    order = [
      ...allAttributes.map(name => ({ type: 'attribute', name })),
      ...allEntityTypes.map(e => ({ type: 'entity', id: e.id }))
    ];
  }

  if (order.length === 0) {
    container.innerHTML = '<p class="empty-state">No custom data defined. Click "+ New Attribute" or "+ New Entity" to create one.</p>';
    return;
  }

  // Preserve collapsed state across re-renders
  const collapsedEntities = new Set(
    [...container.querySelectorAll('.item-entity.collapsed')].map(el => el.dataset.entityId)
  );

  const entityMap = Object.fromEntries(allEntityTypes.map(e => [e.id, e]));

  let html = '<div class="custom-data-list" id="custom-data-list">';
  for (const item of order) {
    if (item.type === 'attribute' && allAttributes.includes(item.name)) {
      const role = item.displayRole || '';
      html += `
        <div class="custom-data-item item-attribute" draggable="true" data-type="attribute" data-name="${escapeHtml(item.name)}" data-display-role="${escapeHtml(role)}">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <span class="item-label item-attribute-name">${escapeHtml(item.name)}</span>
          <div class="item-actions">
            <button class="btn-icon display-role-btn${role ? ' role-active' : ''}" data-type="attribute" data-name-or-id="${escapeHtml(item.name)}" title="Gallery page display role: ${role || 'detail'}">${role === 'primary' ? '①' : role === 'secondary' ? '②' : '·'}</button>
            <button class="btn-icon btn-danger-icon delete-attribute-btn" data-attribute="${escapeHtml(item.name)}" title="Delete attribute">✕</button>
          </div>
        </div>
      `;
    } else if (item.type === 'entity' && entityMap[item.id]) {
      const et = entityMap[item.id];
      const role = item.displayRole || '';
      const collapsed = collapsedEntities.has(item.id);
      const attrRows = et.attributes.length === 0
        ? '<div class="entity-attr-empty">No attributes. Click "+ Attribute" to add one.</div>'
        : et.attributes.map((attrName, i) => `
          <div class="entity-attr-item" draggable="true" data-attribute="${escapeHtml(attrName)}" data-entity-id="${escapeHtml(et.id)}">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            ${i === 0 ? '<span class="entity-key-star" title="Key attribute">★</span>' : '<span class="entity-key-placeholder"></span>'}
            <span class="entity-attr-name">${escapeHtml(attrName)}</span>
            <div class="item-actions">
              <button class="btn-icon btn-danger-icon delete-entity-attr-btn" data-entity-id="${escapeHtml(et.id)}" data-attribute="${escapeHtml(attrName)}" title="Delete attribute">✕</button>
            </div>
          </div>
        `).join('');

      html += `
        <div class="custom-data-item item-entity${collapsed ? ' collapsed' : ''}" draggable="true" data-type="entity" data-entity-id="${escapeHtml(et.id)}" data-display-role="${escapeHtml(role)}">
          <div class="entity-item-header">
            <span class="drag-handle" title="Drag to reorder">⠿</span>
            <button class="entity-toggle-btn btn-icon" data-entity-id="${escapeHtml(et.id)}" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>
            <span class="item-label entity-type-name">${escapeHtml(et.name)}</span>
            <div class="item-actions">
              <button class="btn-icon display-role-btn${role ? ' role-active' : ''}" data-type="entity" data-name-or-id="${escapeHtml(et.id)}" title="Gallery page display role: ${role || 'detail'}">${role === 'primary' ? '①' : role === 'secondary' ? '②' : '·'}</button>
              <button class="btn-secondary btn-small add-entity-attr-btn" data-entity-id="${escapeHtml(et.id)}">+ Attribute</button>
              <button class="btn-icon btn-danger-icon delete-entity-btn" data-entity-id="${escapeHtml(et.id)}" title="Delete entity type">✕</button>
            </div>
          </div>
          <div class="entity-attrs-sublist${collapsed ? ' hidden' : ''}" data-entity-id="${escapeHtml(et.id)}">
            ${attrRows}
          </div>
        </div>
      `;
    }
  }
  html += '</div>';
  container.innerHTML = html;

  const list = container.querySelector('#custom-data-list');

  container.querySelectorAll('.delete-attribute-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteAttribute(btn.dataset.attribute));
  });
  container.querySelectorAll('.delete-entity-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteEntityType(btn.dataset.entityId));
  });
  container.querySelectorAll('.entity-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleEntityCollapse(btn.dataset.entityId, container));
  });
  container.querySelectorAll('.add-entity-attr-btn').forEach(btn => {
    btn.addEventListener('click', () => promptNewEntityAttribute(btn.dataset.entityId));
  });
  container.querySelectorAll('.delete-entity-attr-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteEntityTypeAttribute(btn.dataset.entityId, btn.dataset.attribute));
  });
  container.querySelectorAll('.display-role-btn').forEach(btn => {
    btn.addEventListener('click', () => cycleDisplayRole(btn));
  });

  initCustomDataDragAndDrop(list);
  container.querySelectorAll('.entity-attrs-sublist').forEach(sublist => {
    initEntityAttrsDragAndDrop(sublist);
  });
}

function toggleEntityCollapse(entityId, container) {
  const entityItem = container.querySelector(`.item-entity[data-entity-id="${entityId}"]`);
  if (!entityItem) return;
  const sublist = entityItem.querySelector('.entity-attrs-sublist');
  const toggleBtn = entityItem.querySelector('.entity-toggle-btn');
  const collapsed = entityItem.classList.contains('collapsed');
  entityItem.classList.toggle('collapsed', !collapsed);
  sublist.classList.toggle('hidden', !collapsed);
  toggleBtn.textContent = collapsed ? '▾' : '▸';
  toggleBtn.title = collapsed ? 'Collapse' : 'Expand';
}

// Outer drag-and-drop: reorders attributes and entity boxes
function initCustomDataDragAndDrop(list) {
  if (!list) return;
  let dragSrc = null;

  list.addEventListener('dragstart', e => {
    if (e.target.closest('.entity-attrs-sublist')) { e.stopPropagation(); return; }
    const item = e.target.closest('.custom-data-item');
    if (!item) return;
    dragSrc = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    setTimeout(() => item.classList.add('dragging'), 0);
  });

  list.addEventListener('dragend', e => {
    if (e.target.closest('.entity-attrs-sublist')) return;
    const item = e.target.closest('.custom-data-item');
    if (item) item.classList.remove('dragging');
    list.querySelectorAll('.custom-data-item').forEach(r => r.classList.remove('drag-over'));
    dragSrc = null;
  });

  list.addEventListener('dragover', e => {
    if (e.target.closest('.entity-attrs-sublist')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.custom-data-item');
    if (!item || item === dragSrc) return;
    list.querySelectorAll('.custom-data-item').forEach(r => r.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });

  list.addEventListener('dragleave', e => {
    if (e.target.closest('.entity-attrs-sublist')) return;
    const item = e.target.closest('.custom-data-item');
    if (item) item.classList.remove('drag-over');
  });

  list.addEventListener('drop', e => {
    if (e.target.closest('.entity-attrs-sublist')) return;
    e.preventDefault();
    const target = e.target.closest('.custom-data-item');
    if (!target || !dragSrc || target === dragSrc) return;
    list.querySelectorAll('.custom-data-item').forEach(r => r.classList.remove('drag-over'));
    const items = [...list.querySelectorAll(':scope > .custom-data-item')];
    const srcIdx = items.indexOf(dragSrc);
    const tgtIdx = items.indexOf(target);
    if (srcIdx < tgtIdx) target.after(dragSrc); else target.before(dragSrc);
    saveCustomDataOrder(list);
  });
}

// Inner drag-and-drop: reorders attributes within an entity type
function initEntityAttrsDragAndDrop(sublist) {
  if (!sublist) return;
  let dragSrc = null;
  const entityId = sublist.dataset.entityId;

  sublist.addEventListener('dragstart', e => {
    e.stopPropagation();
    const item = e.target.closest('.entity-attr-item');
    if (!item) return;
    dragSrc = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    setTimeout(() => item.classList.add('dragging'), 0);
  });

  sublist.addEventListener('dragend', e => {
    e.stopPropagation();
    const item = e.target.closest('.entity-attr-item');
    if (item) item.classList.remove('dragging');
    sublist.querySelectorAll('.entity-attr-item').forEach(r => r.classList.remove('drag-over'));
    dragSrc = null;
  });

  sublist.addEventListener('dragover', e => {
    e.stopPropagation();
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.entity-attr-item');
    if (!item || item === dragSrc) return;
    sublist.querySelectorAll('.entity-attr-item').forEach(r => r.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });

  sublist.addEventListener('dragleave', e => {
    e.stopPropagation();
    const item = e.target.closest('.entity-attr-item');
    if (item) item.classList.remove('drag-over');
  });

  sublist.addEventListener('drop', e => {
    e.stopPropagation();
    e.preventDefault();
    const target = e.target.closest('.entity-attr-item');
    if (!target || !dragSrc || target === dragSrc) return;
    sublist.querySelectorAll('.entity-attr-item').forEach(r => r.classList.remove('drag-over'));
    const items = [...sublist.querySelectorAll('.entity-attr-item')];
    const srcIdx = items.indexOf(dragSrc);
    const tgtIdx = items.indexOf(target);
    if (srcIdx < tgtIdx) target.after(dragSrc); else target.before(dragSrc);

    const newOrder = [...sublist.querySelectorAll('.entity-attr-item')].map(r => r.dataset.attribute);
    // Update key star indicators
    sublist.querySelectorAll('.entity-attr-item').forEach((item, i) => {
      const star = item.querySelector('.entity-key-star, .entity-key-placeholder');
      if (star) {
        star.className = i === 0 ? 'entity-key-star' : 'entity-key-placeholder';
        star.title = i === 0 ? 'Key attribute' : '';
        star.textContent = i === 0 ? '★' : '';
      }
    });
    const et = allEntityTypes.find(e => e.id === entityId);
    if (et) et.attributes = newOrder;
    saveEntityAttributeOrder(entityId, newOrder);
  });
}

async function cycleDisplayRole(btn) {
  const roles = ['', 'primary', 'secondary'];
  const labels = { '': '·', 'primary': '①', 'secondary': '②' };
  const item = btn.closest('.custom-data-item');
  const currentRole = item.dataset.displayRole || '';
  const nextRole = roles[(roles.indexOf(currentRole) + 1) % roles.length];

  item.dataset.displayRole = nextRole;
  btn.textContent = labels[nextRole];
  btn.title = `Gallery page display role: ${nextRole || 'detail'}`;
  btn.classList.toggle('role-active', !!nextRole);

  // Update in-memory order
  const type = btn.dataset.type;
  const nameOrId = btn.dataset.nameOrId;
  const entry = allCustomDataOrder.find(e =>
    e.type === type && (type === 'attribute' ? e.name === nameOrId : e.id === nameOrId)
  );
  if (entry) {
    if (nextRole) {
      entry.displayRole = nextRole;
    } else {
      delete entry.displayRole;
    }
  }

  try {
    await fetch(`${API_BASE}/entities/custom-data-order/display-role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, nameOrId, role: nextRole || null })
    });
  } catch (error) {
    console.error('Error saving display role:', error);
  }
}

async function saveCustomDataOrder(list) {
  const items = [...list.querySelectorAll(':scope > .custom-data-item')];
  const order = items.map(item => {
    const entry = item.dataset.type === 'attribute'
      ? { type: 'attribute', name: item.dataset.name }
      : { type: 'entity', id: item.dataset.entityId };
    if (item.dataset.displayRole) entry.displayRole = item.dataset.displayRole;
    return entry;
  });
  allCustomDataOrder = order;
  allAttributes = order.filter(i => i.type === 'attribute').map(i => i.name);
  const entityMap = Object.fromEntries(allEntityTypes.map(e => [e.id, e]));
  allEntityTypes = order.filter(i => i.type === 'entity').map(i => entityMap[i.id]).filter(Boolean);
  try {
    await fetch(`${API_BASE}/entities/custom-data-order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order })
    });
  } catch (error) {
    console.error('Error saving custom data order:', error);
  }
}

async function saveEntityAttributeOrder(entityId, newOrder) {
  try {
    await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}/attributes/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: newOrder })
    });
  } catch (error) {
    console.error('Error saving entity attribute order:', error);
  }
}

function initNewEntityButton() {
  const btn = document.getElementById('new-entity-btn');
  if (!btn || btn.dataset.entityInitialized) return;
  btn.dataset.entityInitialized = '1';
  btn.addEventListener('click', promptNewEntity);
}

async function promptNewEntity() {
  const name = prompt('Enter entity type name (e.g. "Artist", "Location"):');
  if (!name || !name.trim()) return;
  try {
    const response = await fetch(`${API_BASE}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    const result = await response.json();
    if (result.success) {
      allEntityTypes = result.entityTypes;
      allCustomDataOrder = result.customDataOrder;
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to add entity type');
    }
  } catch (error) {
    console.error('Error adding entity type:', error);
    alert('Failed to add entity type');
  }
}

async function promptNewEntityAttribute(entityId) {
  const entityType = allEntityTypes.find(e => e.id === entityId);
  const name = prompt(`Enter attribute name for "${entityType ? entityType.name : entityId}":`);
  if (!name || !name.trim()) return;
  try {
    const response = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}/attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    const result = await response.json();
    if (result.success) {
      const et = allEntityTypes.find(e => e.id === entityId);
      if (et) et.attributes = result.entityType.attributes;
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to add entity attribute');
    }
  } catch (error) {
    console.error('Error adding entity attribute:', error);
    alert('Failed to add entity attribute');
  }
}

async function deleteEntityType(entityId) {
  const entityType = allEntityTypes.find(e => e.id === entityId);
  const entityName = entityType ? entityType.name : entityId;
  const instances = allEntityInstances[entityId] || {};
  const instanceCount = Object.keys(instances).length;
  let confirmMsg = `Delete entity type "${entityName}"?`;
  if (instanceCount > 0) {
    const s = instanceCount === 1 ? 'instance' : 'instances';
    confirmMsg += ` This will also delete ${instanceCount} saved ${s} and remove entity links from all images.`;
  }
  if (!confirm(confirmMsg)) return;

  try {
    const response = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}`, { method: 'DELETE' });
    const result = await response.json();
    if (result.success) {
      allEntityTypes = result.entityTypes;
      allCustomDataOrder = result.customDataOrder;
      delete allEntityInstances[entityId];
      for (const img of Object.values(allImages)) {
        if (img.entityRefs) delete img.entityRefs[entityId];
      }
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to delete entity type');
    }
  } catch (error) {
    console.error('Error deleting entity type:', error);
    alert('Failed to delete entity type');
  }
}

async function deleteEntityTypeAttribute(entityId, attrName) {
  const entityType = allEntityTypes.find(e => e.id === entityId);
  const isKeyAttr = entityType && entityType.attributes[0] === attrName;
  const instances = allEntityInstances[entityId] || {};
  const instanceCount = Object.keys(instances).length;

  // Prevent deleting key attribute when existing instances depend on it
  if (isKeyAttr && instanceCount > 0) {
    alert(`"${attrName}" is the key attribute for "${entityType.name}" and cannot be deleted while there are ${instanceCount} existing instance(s). Delete the entity type instead, or delete its instances first.`);
    return;
  }

  let confirmMsg = `Delete attribute "${attrName}" from "${entityType ? entityType.name : entityId}"?`;
  if (instanceCount > 0) {
    const s = instanceCount === 1 ? 'instance' : 'instances';
    confirmMsg += ` This will remove this field from ${instanceCount} saved ${s}.`;
  }
  if (!confirm(confirmMsg)) return;

  try {
    const response = await fetch(
      `${API_BASE}/entities/${encodeURIComponent(entityId)}/attributes/${encodeURIComponent(attrName)}`,
      { method: 'DELETE' }
    );
    const result = await response.json();
    if (result.success) {
      const et = allEntityTypes.find(e => e.id === entityId);
      if (et) et.attributes = result.entityType.attributes;
      if (allEntityInstances[entityId]) {
        for (const instance of Object.values(allEntityInstances[entityId])) {
          delete instance[attrName];
        }
      }
      renderCustomDataList();
    } else {
      alert(result.error || 'Failed to delete entity attribute');
    }
  } catch (error) {
    console.error('Error deleting entity attribute:', error);
    alert('Failed to delete entity attribute');
  }
}

// ============================================================================
// Load and render the Recency tab content
async function loadRecencyTab() {
  // Initialize controls if not already done
  initPoolHealthRefreshButton();
  initRecencySliders();
  // Load pool health data
  loadPoolHealth();
}

// Track which tagsets have expanded tag lists
const expandedTagsets = new Set();

// Count images per tag (for tag pool display)
function getImageCountPerTag() {
  const counts = {};
  for (const [filename, imageData] of Object.entries(allImages || {})) {
    for (const tag of (imageData.tags || [])) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return counts;
}

// Count images matching a tagset
function countImagesForTagset(tagset) {
  let count = 0;
  for (const [filename, imageData] of Object.entries(allImages || {})) {
    if (imageMatchesTagset(imageData, tagset)) {
      count++;
    }
  }
  return count;
}

// Render the tagsets as an expandable table
function renderTagsetsTable() {
  const container = document.getElementById('tagsets-table-container');
  if (!container) return;
  
  const tagsetNames = Object.keys(allGlobalTagsets || {}).sort((a, b) => a.localeCompare(b));
  
  if (tagsetNames.length === 0) {
    container.innerHTML = '<p class="empty-state">No tagsets defined. Click "+ New" to create one.</p>';
    initNewTagsetButton();
    return;
  }
  
  let html = `
    <table class="tagsets-table">
      <thead>
        <tr>
          <th>Name</th>
          <th class="desktop-only th-weighting">Weighting Basis</th>
          <th class="desktop-only">Include Tags</th>
          <th class="desktop-only">Exclude Tags</th>
          <th class="desktop-only">Used By</th>
          <th class="th-actions"></th>
        </tr>
      </thead>
      <tbody>
  `;
  
  for (const name of tagsetNames) {
    const tagset = allGlobalTagsets[name];
    const includeTags = [...(tagset.tags || [])].sort((a, b) => a.localeCompare(b));
    const excludeTags = [...(tagset.exclude_tags || [])].sort((a, b) => a.localeCompare(b));
    const tagWeights = tagset.tag_weights || {};
    const weightingType = tagset.weighting_type || 'image';
    const hasCustomWeights = Object.keys(tagWeights).length > 0;
    
    // Find TVs using this tagset
    const tvsUsing = allTVs.filter(tv => tv.selected_tagset === name);
    const tvsOverride = allTVs.filter(tv => tv.override_tagset === name);
    
    const isExpanded = expandedTagsets.has(name);
    
    // Format tag list - text when collapsed, chips when expanded
    // showWeights: if true and hasCustomWeights, show percentages
    const formatTagList = (tags, emptyText, showWeights = false) => {
      if (tags.length === 0) return `<span class="tag-summary-none">${emptyText}</span>`;
      
      // Calculate percentages if showing weights
      let percentages = {};
      if (showWeights && hasCustomWeights) {
        const total = tags.reduce((sum, tag) => sum + (tagWeights[tag] || 1), 0);
        tags.forEach(tag => {
          const weight = tagWeights[tag] || 1;
          percentages[tag] = ((weight / total) * 100).toFixed(1);
        });
      }
      
      const tagStr = tags.join(', ');
      const needsTruncation = tagStr.length > 120;
      
      // Helper to format a single tag with optional percentage
      const formatTag = (t) => {
        if (showWeights && hasCustomWeights && percentages[t]) {
          return `${escapeHtml(t)} (${percentages[t]}%)`;
        }
        return escapeHtml(t);
      };
      
      if (isExpanded || !needsTruncation) {
        // Show all tags
        if (needsTruncation) {
          // Expanded view - show as chips with collapse option
          const chips = tags.map(t => `<span class="tag-chip-inline">${formatTag(t)}</span>`).join('');
          return `<div class="tag-chips-inline">${chips}<span class="collapse-link" data-tagset-name="${escapeHtml(name)}">&lt;&lt;</span></div>`;
        }
        if (showWeights && hasCustomWeights) {
          return `<span>${tags.map(t => formatTag(t)).join(', ')}</span>`;
        }
        return `<span>${escapeHtml(tagStr)}</span>`;
      }
      
      // Truncated view - show as text
      let shown = [];
      let len = 0;
      for (const tag of tags) {
        const displayTag = formatTag(tag);
        if (len + displayTag.length + 2 > 100 && shown.length > 0) break;
        shown.push(displayTag);
        len += displayTag.length + 2;
      }
      const remaining = tags.length - shown.length;
      const fullTitle = tags.map(t => formatTag(t)).join(', ');
      return `<span class="tag-list-truncated" title="${escapeHtml(fullTitle)}">${shown.join(', ')} <span class="more-count expandable" data-tagset-name="${escapeHtml(name)}">+${remaining}</span></span>`;
    };
    
    const includeSummary = formatTagList(includeTags, 'All', true);
    const excludeSummary = formatTagList(excludeTags, 'None', false);
    
    // Used by summary - overrides first, then regular assignments on new line
    let usedByParts = [];
    
    // Build override text first
    if (tvsOverride.length > 0) {
      const overrideParts = tvsOverride.map(tv => {
        const timeStr = formatOverrideTimeCompact(tv.override_expiry_time);
        return `<span class="override-indicator">Overrides ${escapeHtml(tv.name)} ${timeStr}</span>`;
      });
      usedByParts.push(overrideParts.join(', '));
    }
    
    // Then regular assignments on new line
    if (tvsUsing.length > 0) {
      const tvNames = tvsUsing.length <= 2 
        ? tvsUsing.map(tv => tv.name).join(', ')
        : `${tvsUsing.length} TVs`;
      usedByParts.push(tvNames);
    }
    
    const usedBySummary = usedByParts.length > 0 
      ? usedByParts.join('<br>')
      : '<span class="tag-summary-none">—</span>';
    
    const hasOverride = tvsOverride.length > 0;
    
    // Count images matching this tagset
    const matchCount = countImagesForTagset(tagset);
    
    // Build mobile override callout text
    let mobileOverrideText = '';
    if (hasOverride) {
      const overrideParts = tvsOverride.map(tv => {
        const timeStr = formatOverrideTimeCompact(tv.override_expiry_time);
        return `Overriding ${escapeHtml(tv.name)} ${timeStr}`;
      });
      mobileOverrideText = overrideParts.join('; ');
    }
    
    // Build mobile "used by" text (non-override TVs only)
    let mobileUsedByText = '';
    if (tvsUsing.length > 0) {
      mobileUsedByText = tvsUsing.length <= 3 
        ? tvsUsing.map(tv => tv.name).join(', ')
        : `${tvsUsing.length} TVs`;
    }
    
    // Mobile tag counts
    const includeCount = includeTags.length;
    const excludeCount = excludeTags.length;
    
    // Check if this tagset is expanded (for mobile tag details)
    const isMobileExpanded = expandedTagsets.has(name);

    html += `
        <tr class="tagset-row clickable-row${hasOverride ? ' has-override' : ''}" data-tagset-name="${escapeHtml(name)}"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
          <td class="td-name"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            <div class="tagset-name-row">
              <button class="btn-icon mobile-expand-btn" data-tagset-name="${escapeHtml(name)}" title="${isMobileExpanded ? 'Collapse' : 'Expand'}">
                <span class="expand-arrow ${isMobileExpanded ? 'expanded' : ''}">▶</span>
              </button>
              <span class="tagset-name-text">${escapeHtml(name)}</span>
              <span class="tagset-tag-counts mobile-only">(+${includeCount}/-${excludeCount})</span>
            </div>
            ${mobileUsedByText ? `
            <div class="mobile-tagset-meta mobile-tagset-tvs">
              <span class="used-by-info">${escapeHtml(mobileUsedByText)}</span>
            </div>
            <div class="mobile-tagset-meta mobile-tagset-stats">
              <span class="tag-counts">${matchCount} image${matchCount !== 1 ? 's' : ''}</span>
              <span class="weighting-info">· ${weightingType}-weighted</span>
            </div>
            ` : `
            <div class="mobile-tagset-meta">
              <span class="tag-counts">${matchCount} image${matchCount !== 1 ? 's' : ''}</span>
              <span class="weighting-info">· ${weightingType}-weighted</span>
            </div>
            `}
          </td>
          <td class="td-weighting desktop-only"><span class="weighting-badge weighting-${weightingType}">${weightingType === 'image' ? 'Image' : 'Tag'}</span></td>
          <td class="td-include desktop-only">${includeSummary}</td>
          <td class="td-exclude desktop-only">${excludeSummary}</td>
          <td class="td-used-by desktop-only${hasOverride ? ' has-override' : ''}">${usedBySummary}</td>
          <td class="td-actions"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            <button class="btn-icon tagset-edit-btn mobile-only" data-tagset-name="${escapeHtml(name)}" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-icon tagset-delete-btn" data-tagset-name="${escapeHtml(name)}" title="Delete"
              ${tagsetNames.length <= 1 ? 'disabled' : ''}>×</button>
          </td>
        </tr>
        ${isMobileExpanded ? `
        <tr class="mobile-tagset-tags-row${hasOverride ? ' has-override' : ''}" data-tagset-name="${escapeHtml(name)}"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
          <td colspan="2"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            <div class="mobile-tags-detail">
              <div class="tag-group">
                <span class="tag-label">Include:</span>
                <span class="tag-list">${includeTags.length > 0 ? (() => {
                  const pcts = hasCustomWeights ? calculateTagPercentages(includeTags, tagWeights) : {};
                  return includeTags.map(t => {
                    const pctStr = hasCustomWeights ? `<span class="tag-percent">${pcts[t] || 0}%</span> ` : '';
                    return `<span class="tag-chip-small">${escapeHtml(t)} ${pctStr}</span>`;
                  }).join('');
                })() : '<em>All</em>'}</span>
              </div>
              ${excludeTags.length > 0 ? `
              <div class="tag-group">
                <span class="tag-label">Exclude:</span>
                <span class="tag-list">${excludeTags.map(t => `<span class="tag-chip-small exclude">${escapeHtml(t)}</span>`).join('')}</span>
              </div>
              ` : ''}
            </div>
          </td>
        </tr>
        ` : ''}
        ${hasOverride ? `
        <tr class="mobile-tagset-override-row" data-tagset-name="${escapeHtml(name)}" style="background: #fffaf0 !important;">
          <td colspan="2" style="background: #fffaf0 !important;"><span class="mobile-tagset-override-info">${mobileOverrideText}</span></td>
        </tr>
        ` : ''}
    `;
  }
  
  html += `
      </tbody>
    </table>
  `;
  
  container.innerHTML = html;
  
  // Attach event listeners - row click: edit on desktop, expand/collapse on mobile
  container.querySelectorAll('.tagset-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't handle if clicking action buttons
      if (e.target.closest('.tagset-edit-btn') || e.target.closest('.tagset-delete-btn') || e.target.closest('.more-count') || e.target.closest('.collapse-link') || e.target.closest('.mobile-expand-btn')) return;
      const tagsetName = row.dataset.tagsetName;
      
      // On desktop (>768px), open edit modal; on mobile, toggle expand
      if (window.innerWidth > 768) {
        openTagsetModal(tagsetName);
      } else {
        if (expandedTagsets.has(tagsetName)) {
          expandedTagsets.delete(tagsetName);
        } else {
          expandedTagsets.add(tagsetName);
        }
        renderTagsetsTable();
      }
    });
  });
  
  // Edit button opens modal
  container.querySelectorAll('.tagset-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTagsetModal(btn.dataset.tagsetName);
    });
  });
  
  // Mobile expand/collapse button
  container.querySelectorAll('.mobile-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tagsetName = btn.dataset.tagsetName;
      if (expandedTagsets.has(tagsetName)) {
        expandedTagsets.delete(tagsetName);
      } else {
        expandedTagsets.add(tagsetName);
      }
      renderTagsetsTable();
    });
  });
  
  // Make +N more text clickable to expand
  container.querySelectorAll('.more-count.expandable').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      expandedTagsets.add(el.dataset.tagsetName);
      renderTagsetsTable();
    });
  });
  
  // Override row click also toggles expand/collapse
  container.querySelectorAll('.mobile-tagset-override-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const tagsetName = row.dataset.tagsetName;
      if (expandedTagsets.has(tagsetName)) {
        expandedTagsets.delete(tagsetName);
      } else {
        expandedTagsets.add(tagsetName);
      }
      renderTagsetsTable();
    });
  });
  
  // Expanded tags row click collapses
  container.querySelectorAll('.mobile-tagset-tags-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const tagsetName = row.dataset.tagsetName;
      if (tagsetName && expandedTagsets.has(tagsetName)) {
        expandedTagsets.delete(tagsetName);
        renderTagsetsTable();
      }
    });
  });
  
  // Make << collapse link clickable
  container.querySelectorAll('.collapse-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      expandedTagsets.delete(el.dataset.tagsetName);
      renderTagsetsTable();
    });
  });
  
  container.querySelectorAll('.tagset-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      const tagsetName = btn.dataset.tagsetName;
      if (confirm(`Delete tagset "${tagsetName}"?`)) {
        await deleteTagset(tagsetName);
      }
    });
  });
  
  initNewTagsetButton();
}

// Toggle expand/collapse for a tagset row (legacy - now handled inline)
function toggleTagsetRow(tagsetName) {
  if (expandedTagsets.has(tagsetName)) {
    expandedTagsets.delete(tagsetName);
  } else {
    expandedTagsets.add(tagsetName);
  }
  renderTagsetsTable();
}

// Initialize the new tagset button
function initNewTagsetButton() {
  const newBtn = document.getElementById('new-tagset-btn');
  if (newBtn) {
    newBtn.onclick = () => {
      openTagsetModal(null);
    };
  }
}

// Legacy function - now just calls renderTagsetsTable
function populateTagsetDropdowns() {
  renderTagsetsTable();
}

// NOTE: This function is deprecated - tagsets are now global
function updateTagsetDropdownForTV(deviceId, preserveTagset) {
  renderTagsetsTable();
}

// Format override time compact for tagsets table: "until 3:00pm (45m)"
function formatOverrideTimeCompact(expiryTime) {
  if (!expiryTime) return '';
  
  const now = new Date();
  const expiry = new Date(expiryTime);
  const diffMs = expiry - now;
  
  if (diffMs <= 0) return '(expired)';
  
  const diffMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  
  // Format remaining time
  let remaining;
  if (hours > 0) {
    remaining = `${hours}h${mins > 0 ? mins + 'm' : ''}`;
  } else {
    remaining = `${mins}m`;
  }
  
  // Format expiry time
  const timeStr = expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  
  return `until ${timeStr} (${remaining})`;
}

// Format override time remaining with expiry
function formatOverrideTimeDisplay(expiryTime) {
  if (!expiryTime) return '-';
  
  const now = new Date();
  const expiry = new Date(expiryTime);
  const diffMs = expiry - now;
  
  if (diffMs <= 0) return 'Expired';
  
  const diffMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  
  // Format remaining time
  let remaining;
  if (hours > 0) {
    remaining = `${hours}h ${mins}m`;
  } else {
    remaining = `${mins}m`;
  }
  
  // Format expiry time
  const isToday = expiry.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = expiry.toDateString() === tomorrow.toDateString();
  
  const timeStr = expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  
  let expiryStr;
  if (isToday) {
    expiryStr = timeStr;
  } else if (isTomorrow) {
    expiryStr = `tomorrow ${timeStr}`;
  } else {
    expiryStr = `${expiry.toLocaleDateString([], { weekday: 'short' })} ${timeStr}`;
  }
  
  return `${remaining} (until ${expiryStr})`;
}

// Render the "TV Tagset Assignments" section as a table
function renderTVAssignments() {
  const container = document.getElementById('tv-tagset-assignments');
  if (!container) return;
  
  if (!allTVs || allTVs.length === 0) {
    container.innerHTML = '<p class="empty-state">No TVs found.</p>';
    return;
  }
  
  // Use GLOBAL tagsets for all TVs
  const tagsetNames = Object.keys(allGlobalTagsets || {});
  
  // Sort TVs alphabetically by name
  const sortedTVs = [...allTVs].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  
  let html = `
    <table class="tv-assignments-table">
      <thead>
        <tr>
          <th>TV</th>
          <th>Tagset</th>
          <th></th>
          <th class="desktop-only">Override Tagset</th>
          <th class="desktop-only">Override Time</th>
        </tr>
      </thead>
      <tbody>
  `;
  
  for (const tv of sortedTVs) {
    const hasOverride = !!tv.override_tagset;
    const selectedTagset = tv.selected_tagset || '-';
    const overrideTagset = hasOverride ? tv.override_tagset : '-';
    const overrideTime = hasOverride ? formatOverrideTimeDisplay(tv.override_expiry_time) : '-';
    
    // Build tagset dropdown options
    const tagsetOptions = `
      <option value="">-- None --</option>
      ${tagsetNames.map(name => `
        <option value="${escapeHtml(name)}" ${tv.selected_tagset === name ? 'selected' : ''}>
          ${escapeHtml(name)}
        </option>
      `).join('')}
    `;
    
    html += `
        <tr class="tv-assignment-row${hasOverride ? ' has-override' : ''}" data-device-id="${escapeHtml(tv.device_id)}"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
          <td class="tv-col-name" data-label="TV"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            <span class="tv-name">${escapeHtml(tv.name)}</span>
          </td>
          <td class="tv-col-tagset" data-label="Selected Tagset"${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            <select class="tagset-select" data-device-id="${escapeHtml(tv.device_id)}" data-tv-name="${escapeHtml(tv.name)}">
              ${tagsetOptions}
            </select>
            <button class="tagset-undo-btn" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a5 5 0 0 1 0 10H9"/><path d="M3 10l4-4M3 10l4 4"/></svg></button>
          </td>
          <td class="tv-col-actions" data-label=""${hasOverride ? ' style="background: #fffaf0 !important;"' : ''}>
            ${hasOverride ? `
              <button class="btn btn-small btn-warning clear-override-btn" data-device-id="${escapeHtml(tv.device_id)}">
                Clear
              </button>
            ` : `
              <button class="btn btn-small set-override-btn" data-device-id="${escapeHtml(tv.device_id)}">
                Override...
              </button>
            `}
          </td>
          <td class="tv-col-override desktop-only" data-label="Override">
            <span class="${hasOverride ? 'override-text' : 'override-none'}">${escapeHtml(overrideTagset)}</span>
          </td>
          <td class="tv-col-override-time desktop-only" data-label="Override Time">
            <span class="${hasOverride ? 'override-text' : 'override-none'}">${overrideTime}</span>
          </td>
        </tr>
        ${hasOverride ? `
        <tr class="mobile-override-row" style="background: #fffaf0 !important;">
          <td colspan="3" style="background: #fffaf0 !important;"><span class="mobile-override-info">Overridden: ${escapeHtml(overrideTagset)} for ${overrideTime}</span></td>
        </tr>
        ` : ''}
    `;
  }
  
  html += `
      </tbody>
    </table>
  `;
  
  container.innerHTML = html;
  
  // Attach event listeners for tagset dropdown changes
  container.querySelectorAll('.tagset-select').forEach(select => {
    // Store original value for undo
    let previousValue = select.value;
    let undoTimeout = null;
    const undoBtn = select.parentElement.querySelector('.tagset-undo-btn');
    
    select.addEventListener('change', async (e) => {
      const deviceId = select.dataset.deviceId;
      const tvName = select.dataset.tvName;
      const tagsetName = select.value;
      
      const fromName = previousValue || 'None';
      const toName = tagsetName || 'None';
      const undoValue = previousValue; // Capture for undo closure
      
      await selectTagset(deviceId, tagsetName || null, true); // Skip re-render
      
      // Show toast
      showToast(`${tvName}: tagset changed from "${fromName}" to "${toName}"`);
      
      // Show undo button with tooltip
      undoBtn.title = `Undo - revert to "${fromName}"`;
      undoBtn.classList.add('show');
      
      // Clear any existing timeout
      if (undoTimeout) clearTimeout(undoTimeout);
      
      // Hide undo after 6 seconds
      undoTimeout = setTimeout(() => {
        undoBtn.classList.remove('show');
      }, 6000);
      
      // Set up undo handler (replace any existing)
      undoBtn.onclick = async () => {
        if (undoTimeout) clearTimeout(undoTimeout);
        undoBtn.classList.remove('show');
        
        select.value = undoValue;
        await selectTagset(deviceId, undoValue || null, true); // Skip re-render
        showToast(`${tvName}: tagset reverted to "${undoValue || 'None'}"`);
        previousValue = undoValue;
      };
      
      // Update previous value for next change
      previousValue = tagsetName;
    });
  });
  
  container.querySelectorAll('.clear-override-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const deviceId = btn.dataset.deviceId;
      await clearOverride(deviceId);
    });
  });
  
  container.querySelectorAll('.set-override-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openOverrideModal(btn.dataset.deviceId);
    });
  });
}

// Start inline editing of tagset selection
function startTagsetEdit(row) {
  const display = row.querySelector('.tagset-display');
  const select = row.querySelector('.tagset-edit-select');
  const editBtn = row.querySelector('.tagset-edit-btn');
  const saveBtn = row.querySelector('.tagset-save-btn');
  const cancelBtn = row.querySelector('.tagset-cancel-btn');
  
  display.classList.add('hidden');
  select.classList.remove('hidden');
  editBtn.classList.add('hidden');
  saveBtn.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  
  select.focus();
}

// Show a toast notification
function showToast(message, duration = 3000) {
  // Remove any existing toast
  const existingToast = document.querySelector('.toast-notification');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Remove after duration
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================================
// POOL HEALTH
// ============================================================================

// Global pool health data cache
let poolHealthData = null;

/**
 * Generate an inline SVG sparkline for pool health history
 * @param {Array} history - Array of {timestamp, pool_size, pool_available}
 * @param {number} poolSize - Current pool size for scaling
 * @returns {string} SVG markup string
 */
function generatePoolHealthSparkline(history, poolSize) {
  const width = 80;
  const height = 24;
  const padding = 2;
  const maxHours = 168; // 7 days

  if (!history || history.length < 2) {
    // Show full gray placeholder for no data
    return `
      <svg class="pool-health-sparkline" width="${width}" height="${height}" title="History accumulates with each auto-shuffle">
        <line x1="${padding}" y1="${height/2}" x2="${width - padding}" y2="${height/2}"
              stroke="#e5e7eb" stroke-width="1" stroke-dasharray="2,2"/>
      </svg>
    `;
  }

  // Calculate what portion of 7 days we have data for
  const firstDate = new Date(history[0].timestamp);
  const lastDate = new Date(history[history.length - 1].timestamp);
  const hoursSpan = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60));
  const dataPct = Math.min(1, hoursSpan / maxHours);

  // Gray section on left (missing data), sparkline on right (actual data)
  const grayWidth = (1 - dataPct) * (width - 2 * padding);
  const sparklineWidth = dataPct * (width - 2 * padding);
  const sparklineStart = padding + grayWidth;

  // Extract available values
  const values = history.map(h => h.pool_available);
  const maxVal = Math.max(...values, poolSize * 0.5);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;

  // Generate path points (scaled to sparkline portion only)
  const points = values.map((val, i) => {
    const x = sparklineStart + (i / (values.length - 1)) * sparklineWidth;
    const y = height - padding - ((val - minVal) / range) * (height - 2 * padding);
    return `${x},${y}`;
  });

  // Determine color based on latest value trend
  const latestValue = values[values.length - 1];
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
  const strokeColor = latestValue >= avgValue ? '#22c55e' : '#ef4444';

  // Create tooltip
  const timeLabel = hoursSpan >= 24 ? `${Math.round(hoursSpan / 24)}d` : `${Math.round(hoursSpan)}h`;
  const tooltip = `Available over ${timeLabel}: ${values[0]} → ${latestValue} (${history.length} samples)`;

  // Build SVG with gray placeholder on left, sparkline on right
  let svg = `<svg class="pool-health-sparkline" width="${width}" height="${height}" title="${escapeHtml(tooltip)}">`;

  // Gray dotted line for missing data (only if less than ~95% coverage)
  if (dataPct < 0.95 && grayWidth > 3) {
    svg += `<line x1="${padding}" y1="${height/2}" x2="${sparklineStart - 1}" y2="${height/2}"
                  stroke="#d1d5db" stroke-width="1" stroke-dasharray="2,2"/>`;
  }

  // Actual sparkline
  svg += `<polyline fill="none" stroke="${strokeColor}" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}"/>`;
  svg += `</svg>`;

  return svg;
}

// Load pool health data from API
async function loadPoolHealth() {
  const container = document.getElementById('pool-health-container');
  if (!container) return;

  try {
    const response = await fetch(`${API_BASE}/ha/pool-health`);
    const result = await response.json();

    if (result.success && result.data) {
      poolHealthData = result.data;
      renderPoolHealthTable();
      updateRecencySlidersFromData();
    } else {
      container.innerHTML = `<p class="empty-state">Failed to load pool health: ${result.error || 'Unknown error'}</p>`;
    }
  } catch (error) {
    console.error('Error loading pool health:', error);
    container.innerHTML = `<p class="empty-state">Error loading pool health data.</p>`;
  }
}

// Render the pool health table
function renderPoolHealthTable() {
  const container = document.getElementById('pool-health-container');
  if (!container) return;

  if (!poolHealthData || !poolHealthData.tvs || Object.keys(poolHealthData.tvs).length === 0) {
    container.innerHTML = '<p class="empty-state">No pool health data available.</p>';
    return;
  }

  const windows = poolHealthData.windows || {};
  const sameTvHours = windows.same_tv_hours || 120;
  const crossTvHours = windows.cross_tv_hours || 72;

  // Sort TVs alphabetically by name
  const sortedTVs = Object.entries(poolHealthData.tvs).sort((a, b) =>
    (a[1].name || '').localeCompare(b[1].name || '')
  );

  let html = `
    <table class="pool-health-table">
      <thead>
        <tr>
          <th>TV</th>
          <th>Pool</th>
          <th class="desktop-only" title="Images shown on this TV within ${sameTvHours}h">Same-TV Recent</th>
          <th class="desktop-only" title="Images shown on other TVs within ${crossTvHours}h (excludes same-TV)">Cross-TV Recent</th>
          <th class="desktop-only" title="Total images deprioritized (same-TV + cross-TV)">Total Recent</th>
          <th class="pool-health-available-header" title="Images not recently shown, preferred for selection">Available</th>
          <th class="pool-health-trend-header desktop-only">
            Trend (7d)
            <span class="info-icon" data-tooltip="Available count over the last 7 days. Shows how your pool availability has changed over time.">ⓘ</span>
          </th>
          <th>
            Variety
            <span class="info-icon" data-tooltip="Hours of unique shuffles before the sequence may start repeating. Green (>10h) = healthy variety. Yellow (5-10h) = moderate. Red (<5h) = low variety, consider adding images or reducing windows.">ⓘ</span>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const [tvId, data] of sortedTVs) {
    const poolSize = data.pool_size || 0;
    const sameTvRecent = data.same_tv_recent || 0;
    const crossTvRecent = data.cross_tv_recent || 0;
    const totalRecent = data.total_recent || 0;
    const available = data.available || 0;
    const availablePct = poolSize > 0 ? Math.round((available / poolSize) * 100) : 0;
    const shuffleFrequency = data.shuffle_frequency_minutes || 60;

    // Calculate variety hours: how long until fresh pool is exhausted
    const varietyHours = (available * shuffleFrequency) / 60;
    const varietyDisplay = varietyHours >= 100 ? '99+' : Math.round(varietyHours);

    // Determine health status for variety (more intuitive than available %)
    let varietyClass = 'health-good';
    if (varietyHours < 5) {
      varietyClass = 'health-low';
    } else if (varietyHours < 10) {
      varietyClass = 'health-medium';
    }

    // Generate sparkline from history data
    const sparkline = generatePoolHealthSparkline(data.history, poolSize);

    html += `
      <tr data-tv-id="${escapeHtml(tvId)}">
        <td class="pool-health-tv-name">${escapeHtml(data.name || tvId)}</td>
        <td class="pool-health-pool">${poolSize}</td>
        <td class="pool-health-same-tv desktop-only">${sameTvRecent}</td>
        <td class="pool-health-cross-tv desktop-only">${crossTvRecent}</td>
        <td class="pool-health-total desktop-only">${totalRecent}</td>
        <td class="pool-health-available">${available} (${availablePct}%)</td>
        <td class="pool-health-trend desktop-only">${sparkline}</td>
        <td class="pool-health-variety ${varietyClass}">${varietyDisplay}h</td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
    <p class="pool-health-footer">
      Windows: Same-TV ${sameTvHours}h, Cross-TV ${crossTvHours}h
    </p>
  `;

  container.innerHTML = html;
}

// Initialize pool health refresh button
function initPoolHealthRefreshButton() {
  const btn = document.getElementById('refresh-pool-health-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading...';
    await loadPoolHealth();
    btn.disabled = false;
    btn.textContent = 'Refresh';
  });
}

// Recency windows configuration state
let configuredSameTvHours = 120;
let configuredCrossTvHours = 72;
let currentPoolHealthData = null; // Store current data separately from preview
let previewTimeout = null;
let recencySlidersInitialized = false;

// Initialize recency window sliders
function initRecencySliders() {
  if (recencySlidersInitialized) return;

  const sameTvSlider = document.getElementById('same-tv-slider');
  const crossTvSlider = document.getElementById('cross-tv-slider');
  const sameTvValue = document.getElementById('same-tv-value');
  const crossTvValue = document.getElementById('cross-tv-value');
  const sameTvMarker = document.getElementById('same-tv-marker');
  const crossTvMarker = document.getElementById('cross-tv-marker');
  const applyBtn = document.getElementById('apply-recency-btn');
  const resetBtn = document.getElementById('reset-recency-btn');

  if (!sameTvSlider || !crossTvSlider) return;

  recencySlidersInitialized = true;

  // Update value display on slider input
  sameTvSlider.addEventListener('input', () => {
    sameTvValue.textContent = `${sameTvSlider.value}h`;
    onSliderChange();
  });

  crossTvSlider.addEventListener('input', () => {
    crossTvValue.textContent = `${crossTvSlider.value}h`;
    onSliderChange();
  });

  // Marker click handlers - reset to saved value
  if (sameTvMarker) {
    sameTvMarker.addEventListener('click', () => {
      sameTvSlider.value = configuredSameTvHours;
      sameTvValue.textContent = `${configuredSameTvHours}h`;
      onSliderChange();
    });
  }

  if (crossTvMarker) {
    crossTvMarker.addEventListener('click', () => {
      crossTvSlider.value = configuredCrossTvHours;
      crossTvValue.textContent = `${configuredCrossTvHours}h`;
      onSliderChange();
    });
  }

  // Debounced preview fetch
  function onSliderChange() {
    const sameTv = parseInt(sameTvSlider.value, 10);
    const crossTv = parseInt(crossTvSlider.value, 10);

    // Enable apply/reset buttons if values differ from configured
    const hasChanges = sameTv !== configuredSameTvHours || crossTv !== configuredCrossTvHours;
    applyBtn.disabled = !hasChanges;
    if (resetBtn) resetBtn.disabled = !hasChanges;

    clearTimeout(previewTimeout);
    if (hasChanges) {
      previewTimeout = setTimeout(() => fetchVarietyPreview(sameTv, crossTv), 300);
    } else {
      // Reset preview to show current values (no change)
      renderVarietyTable(null);
    }
  }

  // Reset button handler - revert sliders to saved values
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      sameTvSlider.value = configuredSameTvHours;
      crossTvSlider.value = configuredCrossTvHours;
      sameTvValue.textContent = `${configuredSameTvHours}h`;
      crossTvValue.textContent = `${configuredCrossTvHours}h`;
      onSliderChange();
    });
  }

  // Apply button handler
  applyBtn.addEventListener('click', async () => {
    const sameTv = parseInt(sameTvSlider.value, 10);
    const crossTv = parseInt(crossTvSlider.value, 10);

    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';

    try {
      const response = await fetch(`${API_BASE}/ha/set-recency-windows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ same_tv_hours: sameTv, cross_tv_hours: crossTv }),
      });
      const result = await response.json();

      if (result.success) {
        // Refresh table with new actual values
        await loadPoolHealth();
        // Override configured values (server response may lag behind our new values)
        configuredSameTvHours = sameTv;
        configuredCrossTvHours = crossTv;
        // Update marker positions to reflect new saved values
        updateMarkerPositions();
        // Keep buttons disabled since values now match configured
        applyBtn.textContent = 'Apply Changes';
        applyBtn.disabled = true;
        if (resetBtn) resetBtn.disabled = true;
        // Clear preview (values match)
        renderVarietyTable(null);
      } else {
        console.error('Error applying recency windows:', result.error);
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Changes';
      }
    } catch (error) {
      console.error('Error applying recency windows:', error);
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply Changes';
    }
  });
}

// Position the saved-value markers on the sliders and update their labels
function updateMarkerPositions() {
  const sameTvMarker = document.getElementById('same-tv-marker');
  const crossTvMarker = document.getElementById('cross-tv-marker');

  if (sameTvMarker) {
    const pct = ((configuredSameTvHours - 6) / (168 - 6)) * 100;
    sameTvMarker.style.left = `${pct}%`;
    const label = sameTvMarker.querySelector('.marker-label');
    if (label) label.textContent = `${configuredSameTvHours}h`;
  }

  if (crossTvMarker) {
    const pct = ((configuredCrossTvHours - 6) / (168 - 6)) * 100;
    crossTvMarker.style.left = `${pct}%`;
    const label = crossTvMarker.querySelector('.marker-label');
    if (label) label.textContent = `${configuredCrossTvHours}h`;
  }
}

// Fetch preview data and show variety changes
async function fetchVarietyPreview(sameTvHours, crossTvHours) {
  try {
    const params = new URLSearchParams();
    params.append('same_tv_hours', sameTvHours);
    params.append('cross_tv_hours', crossTvHours);

    const response = await fetch(`${API_BASE}/ha/pool-health?${params.toString()}`);
    const result = await response.json();

    if (result.success && result.data && currentPoolHealthData) {
      renderVarietyTable(result.data);
    }
  } catch (error) {
    console.error('Error fetching variety preview:', error);
  }
}

// Render the side-by-side variety table (always visible)
function renderVarietyTable(previewData) {
  const previewContainer = document.getElementById('recency-variety-preview');
  if (!previewContainer || !currentPoolHealthData) return;

  const currentTvs = currentPoolHealthData.tvs || {};
  const previewTvs = previewData ? (previewData.tvs || {}) : null;

  // Sort TVs alphabetically
  const sortedTvIds = Object.keys(currentTvs).sort((a, b) =>
    (currentTvs[a].name || '').localeCompare(currentTvs[b].name || '')
  );

  let html = `
    <table class="recency-variety-table">
      <thead>
        <tr>
          <th>TV</th>
          <th style="text-align:center;">Available</th>
          <th style="text-align:center;">
            Variety
            <span class="info-icon" data-tooltip="Hours of unique shuffles before repeating. Green (>10h) = healthy. Yellow (5-10h) = moderate. Red (<5h) = low variety.">ⓘ</span>
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const tvId of sortedTvIds) {
    const currentData = currentTvs[tvId];
    const currentAvailable = currentData.available || 0;
    const poolSize = currentData.pool_size || 0;
    const shuffleFreq = currentData.shuffle_frequency_minutes || 60;
    const currentVariety = Math.round((currentAvailable * shuffleFreq) / 60);

    let previewAvailableVal = currentAvailable;
    let previewVariety = currentVariety;
    let availableClass = 'no-change';
    let varietyClass = 'no-change';
    let availableDisplay = `${currentAvailable}`;
    let varietyDisplay = `${currentVariety}h`;

    if (previewTvs && previewTvs[tvId]) {
      previewAvailableVal = previewTvs[tvId].available || 0;
      previewVariety = Math.round((previewAvailableVal * shuffleFreq) / 60);

      if (previewAvailableVal > currentAvailable) {
        availableClass = 'increase';
        availableDisplay = `${currentAvailable} → ${previewAvailableVal}`;
      } else if (previewAvailableVal < currentAvailable) {
        availableClass = 'decrease';
        availableDisplay = `${currentAvailable} → ${previewAvailableVal}`;
      }

      if (previewVariety > currentVariety) {
        varietyClass = 'increase';
        varietyDisplay = `${currentVariety}h → ${previewVariety}h`;
      } else if (previewVariety < currentVariety) {
        varietyClass = 'decrease';
        varietyDisplay = `${currentVariety}h → ${previewVariety}h`;
      }
    }

    html += `
      <tr>
        <td class="tv-name">${escapeHtml(currentData.name || tvId)}</td>
        <td class="preview-value ${availableClass}">${availableDisplay}${poolSize ? ` / ${poolSize}` : ''}</td>
        <td class="preview-value ${varietyClass}">${varietyDisplay}</td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
  `;

  previewContainer.innerHTML = html;
}

// Update slider values from loaded pool health data
function updateRecencySlidersFromData() {
  if (!poolHealthData || !poolHealthData.windows) return;

  // Store current data for preview comparisons
  currentPoolHealthData = poolHealthData;

  const windows = poolHealthData.windows;
  configuredSameTvHours = windows.configured_same_tv_hours || windows.same_tv_hours || 120;
  configuredCrossTvHours = windows.configured_cross_tv_hours || windows.cross_tv_hours || 72;

  const sameTvSlider = document.getElementById('same-tv-slider');
  const crossTvSlider = document.getElementById('cross-tv-slider');
  const sameTvValue = document.getElementById('same-tv-value');
  const crossTvValue = document.getElementById('cross-tv-value');
  const applyBtn = document.getElementById('apply-recency-btn');

  const resetBtn = document.getElementById('reset-recency-btn');

  if (sameTvSlider && crossTvSlider) {
    sameTvSlider.value = configuredSameTvHours;
    crossTvSlider.value = configuredCrossTvHours;
    sameTvValue.textContent = `${configuredSameTvHours}h`;
    crossTvValue.textContent = `${configuredCrossTvHours}h`;
    applyBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
  }

  // Position the saved-value markers
  updateMarkerPositions();

  // Render the variety table showing current values
  renderVarietyTable(null);
}

// Tagset modal state
let tagsetModalIncludeTags = [];
let tagsetModalExcludeTags = [];
let tagsetModalTagWeights = {}; // { tag: weight } - weights for include tags
let tagsetModalWeightingType = 'image'; // 'image' or 'tag'
let tagsetModalMode = 'include'; // 'include' or 'exclude'
let tagsetModalActiveTab = 'tags'; // 'tags' or 'weights'

// Open the tagset edit/create modal
// tagsetName: name of tagset to edit, or null to create new
function openTagsetModal(tagsetName) {
  const modal = document.getElementById('tagset-modal');
  const titleEl = document.getElementById('tagset-modal-title');
  const form = document.getElementById('tagset-form');
  const nameInput = document.getElementById('tagset-name-input');
  const deleteBtn = document.getElementById('delete-tagset-btn');
  
  // Store original name for rename support
  form.dataset.originalName = tagsetName || '';
  
  let existingTagset = null;
  const tagsetCount = Object.keys(allGlobalTagsets || {}).length;
  
  if (tagsetName) {
    // Edit mode - get from global tagsets
    titleEl.textContent = `Edit Tagset: ${tagsetName}`;
    existingTagset = allGlobalTagsets?.[tagsetName];
    nameInput.value = tagsetName;
    nameInput.readOnly = false;
    nameInput.classList.remove('readonly');
    // Show delete but disable if only 1 tagset exists
    deleteBtn.style.display = 'inline-block';
    if (tagsetCount <= 1) {
      deleteBtn.disabled = true;
      deleteBtn.title = 'Cannot delete the only tagset';
    } else {
      deleteBtn.disabled = false;
      deleteBtn.title = '';
    }
  } else {
    // Create mode
    titleEl.textContent = 'New Tagset';
    nameInput.value = '';
    nameInput.readOnly = false;
    nameInput.classList.remove('readonly');
    deleteBtn.style.display = 'none';
  }
  
  // Initialize state from existing tagset or empty
  tagsetModalIncludeTags = [...(existingTagset?.tags || [])];
  tagsetModalExcludeTags = [...(existingTagset?.exclude_tags || [])];
  tagsetModalTagWeights = {...(existingTagset?.tag_weights || {})};
  tagsetModalWeightingType = existingTagset?.weighting_type || 'image';
  tagsetModalMode = 'include';
  tagsetModalActiveTab = 'tags';
  
  // Render the UI
  renderTagsetModalUI();
  initTagsetModalHandlers();
  initTagsetTabHandlers();
  
  modal.classList.add('active');
}

// Render all parts of the tagset modal UI
function renderTagsetModalUI() {
  renderTagsetTabs();
  renderTagsetModeToggle();
  renderTagsetTagPool();
  renderTagsetSelectedTags('include');
  renderTagsetSelectedTags('exclude');
  renderTagsetWeightsTab();
}

// Render tab navigation
function renderTagsetTabs() {
  const tabs = document.querySelectorAll('.tagset-tab');
  const contents = document.querySelectorAll('.tagset-tab-content');
  
  tabs.forEach(tab => {
    if (tab.dataset.tab === tagsetModalActiveTab) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  contents.forEach(content => {
    const tabName = content.id.replace('tagset-tab-', '');
    if (tabName === tagsetModalActiveTab) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });
  
  // Update reset weights button state
  updateResetWeightsButton();
}

// Initialize tab click handlers
function initTagsetTabHandlers() {
  const tabs = document.querySelectorAll('.tagset-tab');
  
  tabs.forEach(tab => {
    // Clone to remove old handlers
    const newTab = tab.cloneNode(true);
    tab.parentNode.replaceChild(newTab, tab);
  });
  
  // Re-attach handlers
  document.querySelectorAll('.tagset-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      tagsetModalActiveTab = tab.dataset.tab;
      renderTagsetTabs();
      if (tagsetModalActiveTab === 'weights') {
        renderTagsetWeightsTab();
      }
    });
  });
  
  // Reset weights button
  const resetBtn = document.getElementById('reset-weights-btn');
  if (resetBtn) {
    const newResetBtn = resetBtn.cloneNode(true);
    resetBtn.parentNode.replaceChild(newResetBtn, resetBtn);
    
    document.getElementById('reset-weights-btn').addEventListener('click', (e) => {
      e.preventDefault();
      if (confirm('Reset all tag weights to 1? This will give all tags equal selection probability.')) {
        tagsetModalTagWeights = {};
        renderTagsetWeightsTab();
        renderTagsetSelectedTags('include'); // Update percentages on Tags tab
      }
    });
  }
}

// Render the mode toggle buttons
function renderTagsetModeToggle() {
  const buttons = document.querySelectorAll('.tagset-mode-toggle .mode-btn');
  buttons.forEach(btn => {
    if (btn.dataset.mode === tagsetModalMode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Render the available tags pool (excluding already selected tags)
function renderTagsetTagPool() {
  const container = document.getElementById('tagset-tag-pool');
  if (!container) return;

  const allTagNames = allTags || [];
  const tagCounts = getImageCountPerTag();

  // Filter out tags already in include or exclude
  const assignedTags = new Set([...tagsetModalIncludeTags, ...tagsetModalExcludeTags]);
  const availableTags = allTagNames.filter(tag => !assignedTags.has(tag)).sort();

  // Virtual tags: only available in include mode (exclude doesn't apply to virtual tags)
  const virtualTags = webSourcesConfig?.virtualTags || {};
  const hasSources = Object.keys(webSourcesConfig?.sources || {}).length > 0;
  const availableVirtualPills = [];

  if (tagsetModalMode === 'include') {
    // Umbrella "Web Sources" tag (picks random source)
    if (hasSources && !assignedTags.has(WEB_SOURCES_VIRTUAL_TAG)) {
      availableVirtualPills.push({
        tag: WEB_SOURCES_VIRTUAL_TAG,
        label: 'Web Sources',
        title: 'Virtual tag: when selected during shuffle, displays a random image from any web source',
      });
    }
    // Specific ws:tagId virtual tags
    for (const [id, vt] of Object.entries(virtualTags)) {
      const wsTag = `ws:${id}`;
      if (!assignedTags.has(wsTag)) {
        availableVirtualPills.push({
          tag: wsTag,
          label: vt.label || id,
          title: `Virtual tag: ${vt.label || id} (${vt.sourceId || 'web source'})`,
        });
      }
    }
  }

  if (allTagNames.length === 0 && availableVirtualPills.length === 0) {
    container.innerHTML = '<span class="no-tags-message">No tags available</span>';
    return;
  }

  if (availableTags.length === 0 && availableVirtualPills.length === 0) {
    container.innerHTML = '<span class="no-tags-message">All tags assigned</span>';
    return;
  }

  const regularPills = availableTags.map(tag => {
    const count = tagCounts[tag] || 0;
    return `<span class="tag-pill" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span class="tag-count">(${count})</span></span>`;
  }).join('');

  const virtualPillsHtml = availableVirtualPills.map(vt =>
    `<span class="tag-pill web-sources-virtual-tag" data-tag="${escapeHtml(vt.tag)}" title="${escapeHtml(vt.title)}">${escapeHtml(vt.label)} <span class="tag-count">(virtual)</span></span>`
  ).join('');

  container.innerHTML = virtualPillsHtml + regularPills;

  // Add click handlers
  container.querySelectorAll('.tag-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      if (tagsetModalMode === 'include') {
        tagsetModalIncludeTags.push(tag);
        tagsetModalIncludeTags.sort();
      } else {
        tagsetModalExcludeTags.push(tag);
        tagsetModalExcludeTags.sort();
      }
      renderTagsetTagPool();
      renderTagsetSelectedTags(tagsetModalMode);
    });
  });
}

// Render selected tags for include or exclude section
function renderTagsetSelectedTags(type) {
  const containerId = type === 'include' ? 'tagset-include-tags' : 'tagset-exclude-tags';
  const container = document.getElementById(containerId);
  if (!container) return;
  
  const tags = type === 'include' ? tagsetModalIncludeTags : tagsetModalExcludeTags;
  const tagCounts = getImageCountPerTag();
  
  if (tags.length === 0) {
    const hint = type === 'include' ? 'Click tags above to include' : 'Click tags above to exclude';
    container.innerHTML = `<span class="empty-hint">${hint}</span>`;
    return;
  }
  
  // For include tags, check if any weights are non-default and calculate percentages
  const hasCustomWeights = type === 'include' && tags.some(t => (tagsetModalTagWeights[t] || 1) !== 1);
  const percentages = type === 'include' ? calculateTagPercentages(tags, tagsetModalTagWeights) : {};
  
  const virtualTags = webSourcesConfig?.virtualTags || {};
  container.innerHTML = tags.map(tag => {
    // Virtual tags: umbrella or ws:tagId
    if (tag === WEB_SOURCES_VIRTUAL_TAG || tag.startsWith('ws:')) {
      const vtId = tag.startsWith('ws:') ? tag.slice(3) : null;
      const vtLabel = vtId ? (virtualTags[vtId]?.label || vtId) : 'Web Sources';
      const percentStr = hasCustomWeights ? `<span class="tag-percent">${percentages[tag] || 0}%</span> ` : '';
      return `<span class="tag-pill web-sources-virtual-tag" data-tag="${escapeHtml(tag)}" title="Virtual tag: ${escapeHtml(vtLabel)}">
        ${escapeHtml(vtLabel)} ${percentStr}<span class="tag-count">(virtual)</span>
        <span class="tag-remove">×</span>
      </span>`;
    }
    const count = tagCounts[tag] || 0;
    const percentStr = hasCustomWeights ? `<span class="tag-percent">${percentages[tag] || 0}%</span> ` : '';
    return `<span class="tag-pill" data-tag="${escapeHtml(tag)}">
      ${escapeHtml(tag)} ${percentStr}<span class="tag-count">(${count})</span>
      <span class="tag-remove">×</span>
    </span>`;
  }).join('');
  
  // Add click handlers to remove
  container.querySelectorAll('.tag-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      if (type === 'include') {
        tagsetModalIncludeTags = tagsetModalIncludeTags.filter(t => t !== tag);
        // Also remove from weights
        delete tagsetModalTagWeights[tag];
      } else {
        tagsetModalExcludeTags = tagsetModalExcludeTags.filter(t => t !== tag);
      }
      renderTagsetTagPool();
      renderTagsetSelectedTags(type);
      if (type === 'include') {
        renderTagsetWeightsTab(); // Update weights tab when include tags change
      }
    });
  });
}

// Calculate percentages for tags based on weights
function calculateTagPercentages(tags, weights) {
  if (!tags || tags.length === 0) return {};
  
  const total = tags.reduce((sum, tag) => sum + (weights[tag] || 1), 0);
  if (total === 0) return {};
  
  const percentages = {};
  tags.forEach(tag => {
    const weight = weights[tag] || 1;
    percentages[tag] = ((weight / total) * 100).toFixed(1);
  });
  return percentages;
}

// Generate a pie chart showing tag weight distribution
function generateWeightsPieChart(tags, percentages) {
  if (!tags || tags.length === 0) return '';
  
  // Color palette for pie segments
  const colors = [
    '#4a90d9', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6',
    '#1abc9c', '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#8e44ad', '#16a085', '#c0392b', '#2980b9', '#27ae60'
  ];
  
  // Build conic-gradient stops
  let cumulative = 0;
  const gradientStops = [];
  
  tags.forEach((tag, i) => {
    const pct = parseFloat(percentages[tag]) || 0;
    const color = colors[i % colors.length];
    gradientStops.push(`${color} ${cumulative}%`);
    cumulative += pct;
    gradientStops.push(`${color} ${cumulative}%`);
  });
  
  const gradient = gradientStops.join(', ');
  
  // Build legend items
  const legendItems = tags.map((tag, i) => {
    const color = colors[i % colors.length];
    const pct = percentages[tag] || 0;
    return `<div class="pie-legend-item">
      <span class="pie-legend-color" style="background: ${color}"></span>
      <span class="pie-legend-text">${escapeHtml(tag)} <span class="pie-legend-pct">${pct}%</span></span>
    </div>`;
  }).join('');
  
  return `
    <div class="weights-pie-container">
      <div class="weights-pie-chart" style="background: conic-gradient(${gradient})"></div>
      <div class="weights-pie-legend">${legendItems}</div>
    </div>
  `;
}

// Update pie chart in-place when weights change
function updateWeightsPieChart(tags, percentages) {
  const pieChart = document.querySelector('.weights-pie-chart');
  const legend = document.querySelector('.weights-pie-legend');
  if (!pieChart || !legend) return;
  
  const colors = [
    '#4a90d9', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6',
    '#1abc9c', '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#8e44ad', '#16a085', '#c0392b', '#2980b9', '#27ae60'
  ];
  
  // Update gradient
  let cumulative = 0;
  const gradientStops = [];
  tags.forEach((tag, i) => {
    const pct = parseFloat(percentages[tag]) || 0;
    const color = colors[i % colors.length];
    gradientStops.push(`${color} ${cumulative}%`);
    cumulative += pct;
    gradientStops.push(`${color} ${cumulative}%`);
  });
  pieChart.style.background = `conic-gradient(${gradientStops.join(', ')})`;
  
  // Update legend percentages
  const legendItems = legend.querySelectorAll('.pie-legend-item');
  legendItems.forEach((item, i) => {
    const tag = tags[i];
    const pctSpan = item.querySelector('.pie-legend-pct');
    if (pctSpan) pctSpan.textContent = `${percentages[tag] || 0}%`;
  });
}

// Format weight for display: 0.5 for decimals, 4 for integers
function formatWeightDisplay(weight) {
  if (weight === Math.floor(weight)) {
    return String(Math.floor(weight));
  }
  return weight.toFixed(1);
}

// Convert slider position (0-18) to weight value
// Positions 0-8: 0.1 to 0.9 (step 0.1)
// Position 9: 1 (center, exactly 50%)
// Positions 10-18: 2 to 10 (step 1)
function sliderPositionToWeight(position) {
  if (position < 9) {
    return 0.1 + (position * 0.1); // 0.1, 0.2, ... 0.9
  } else if (position === 9) {
    return 1;
  } else {
    return position - 8; // 2, 3, 4, ... 10
  }
}

// Convert weight value to slider position (0-18)
function weightToSliderPosition(weight) {
  if (weight < 1) {
    // 0.1 -> 0, 0.2 -> 1, ... 0.9 -> 8
    return Math.round((weight - 0.1) / 0.1);
  } else if (weight === 1) {
    return 9;
  } else {
    // 2 -> 10, 3 -> 11, ... 10 -> 18
    return Math.round(weight) + 8;
  }
}

// Render the Weights tab content
function renderTagsetWeightsTab() {
  const container = document.getElementById('tagset-weights-container');
  if (!container) return;
  
  const tags = tagsetModalIncludeTags;
  
  if (tags.length === 0) {
    container.innerHTML = '<p class="empty-hint">Add include tags on the Tags tab first</p>';
    return;
  }
  
  // Build weighting type toggle
  const weightingToggle = `
    <div class="weighting-type-toggle">
      <span class="weighting-type-label">Weighting Mode:</span>
      <div class="weighting-type-buttons">
        <button type="button" class="weighting-type-btn ${tagsetModalWeightingType === 'image' ? 'active' : ''}" data-type="image">
          Image Weighted
        </button>
        <button type="button" class="weighting-type-btn ${tagsetModalWeightingType === 'tag' ? 'active' : ''}" data-type="tag">
          Tag Weighted
        </button>
      </div>
    </div>
  `;
  
  let content = '';
  
  if (tagsetModalWeightingType === 'image') {
    // Image-weighted mode: show tables of included/excluded images
    content = renderImageWeightedContent();
  } else {
    // Tag-weighted mode: show sliders
    content = renderTagWeightedContent();
  }
  
  container.innerHTML = weightingToggle + content;
  
  // Add weighting type toggle handlers
  container.querySelectorAll('.weighting-type-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      tagsetModalWeightingType = btn.dataset.type;
      renderTagsetWeightsTab();
      updateResetWeightsButton();
    });
  });
  
  // Add slider handlers if in tag-weighted mode
  if (tagsetModalWeightingType === 'tag') {
    initTagWeightSliders(container);
  }
}

// Render content for image-weighted mode
function renderImageWeightedContent() {
  const includeTags = tagsetModalIncludeTags;
  const excludeTags = tagsetModalExcludeTags;
  const hasWebSources = includeTags.some(t => t === WEB_SOURCES_VIRTUAL_TAG || t.startsWith('ws:'));
  const libraryIncludeTags = includeTags.filter(t => t !== WEB_SOURCES_VIRTUAL_TAG && !t.startsWith('ws:'));

  // Get all images from global allImages (populated on app load)
  const images = allImages || {};

  // Categorize images (library tags only; web_sources is virtual)
  const includedImages = [];
  const excludedImages = [];

  for (const [filename, imageData] of Object.entries(images)) {
    const imageTags = imageData.tags || [];

    // Check if image has any library include tag
    const hasIncludeTag = libraryIncludeTags.some(t => imageTags.includes(t));
    if (!hasIncludeTag) continue; // Not relevant to this tagset

    // Check if image has any exclude tag
    const excludeTag = excludeTags.find(t => imageTags.includes(t));
    if (excludeTag) {
      excludedImages.push({ filename, tags: imageTags, reason: excludeTag });
    } else {
      includedImages.push({ filename, tags: imageTags });
    }
  }

  // Web sources effective count = avg images per library tag (approximates one tag's weight)
  const webEffective = hasWebSources
    ? Math.max(1, Math.floor(includedImages.length / Math.max(1, libraryIncludeTags.length)))
    : 0;
  const totalEffective = includedImages.length + webEffective;

  // Per-slot percentage (library images share the non-web-sources portion)
  const libPct = includedImages.length > 0 ? (100 / totalEffective).toFixed(1) : '0.0';
  
  // Build included table
  let includedHtml = `
    <div class="image-weighted-section included-section">
      <div class="image-weighted-header">
        <span class="image-weighted-title">Included</span>
        <span class="image-weighted-summary">${includedImages.length} images${hasWebSources ? ' + Web Sources' : ''} · ${libPct}% each</span>
      </div>
      <div class="image-weighted-table-wrapper">
        <table class="image-weighted-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Tags</th>
              <th>Chance</th>
            </tr>
          </thead>
          <tbody>
  `;

  if (hasWebSources) {
    const webPct = totalEffective > 0 ? ((webEffective / totalEffective) * 100).toFixed(1) : '0.0';
    includedHtml += `
      <tr class="web-sources-virtual-row">
        <td class="filename-cell web-sources-virtual-tag">Web Sources</td>
        <td class="tags-cell web-sources-virtual-tag">virtual · ~${webEffective} effective images</td>
        <td class="chance-cell">${webPct}%</td>
      </tr>
    `;
  }

  if (includedImages.length === 0 && !hasWebSources) {
    includedHtml += `<tr><td colspan="3" class="empty-row">No matching images</td></tr>`;
  } else {
    for (const img of includedImages) {
      includedHtml += `
        <tr>
          <td class="filename-cell">${escapeHtml(img.filename)}</td>
          <td class="tags-cell">${img.tags.map(t => escapeHtml(t)).join(', ')}</td>
          <td class="chance-cell">${libPct}%</td>
        </tr>
      `;
    }
  }

  includedHtml += `
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  // Build excluded table (always show, even if empty)
  let excludedHtml = `
    <div class="image-weighted-section excluded-section">
      <div class="image-weighted-header">
        <span class="image-weighted-title">Excluded</span>
        <span class="image-weighted-summary">${excludedImages.length} image${excludedImages.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="image-weighted-table-wrapper">
        <table class="image-weighted-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
  `;
  
  if (excludedImages.length === 0) {
    excludedHtml += `<tr><td colspan="2" class="empty-row">No excluded images</td></tr>`;
  } else {
    for (const img of excludedImages) {
      excludedHtml += `
        <tr>
          <td class="filename-cell">${escapeHtml(img.filename)}</td>
          <td class="reason-cell">${escapeHtml(img.reason)}</td>
        </tr>
      `;
    }
  }
  
  excludedHtml += `
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  return includedHtml + excludedHtml;
}

// Render content for tag-weighted mode (sliders)
function renderTagWeightedContent() {
  const tags = tagsetModalIncludeTags;
  const tagCounts = getImageCountPerTag();
  const virtualTags = webSourcesConfig?.virtualTags || {};
  const percentages = calculateTagPercentages(tags, tagsetModalTagWeights);
  
  // Generate pie chart
  const pieChart = generateWeightsPieChart(tags, percentages);
  
  const sliders = tags.map(tag => {
    const weight = tagsetModalTagWeights[tag] || 1;
    const sliderPos = weightToSliderPosition(weight);
    const pct = percentages[tag] || 0;

    if (tag === WEB_SOURCES_VIRTUAL_TAG || tag.startsWith('ws:')) {
      const vtId = tag.startsWith('ws:') ? tag.slice(3) : null;
      const vtLabel = vtId ? (virtualTags[vtId]?.label || vtId) : 'Web Sources';
      return `
        <div class="weight-slider-row web-sources-slider-row" data-tag="${escapeHtml(tag)}">
          <div class="weight-slider-header">
            <span class="weight-slider-tag web-sources-virtual-tag">${escapeHtml(vtLabel)} <span class="tag-count">(virtual)</span></span>
          </div>
          <div class="weight-slider-body">
            <span class="weight-slider-percent">${pct}%</span>
            <div class="weight-slider-track-wrapper">
              <span class="weight-slider-value">${formatWeightDisplay(weight)}</span>
              <input type="range"
                     class="weight-slider"
                     min="0"
                     max="18"
                     step="1"
                     value="${sliderPos}"
                     data-tag="${escapeHtml(tag)}" />
              <div class="weight-slider-ticks">
                <span class="tick tick-start" style="left: 0"><span class="tick-label">0.1</span></span>
                <span class="tick tick-center" style="left: 50%"><span class="tick-label">1</span></span>
                <span class="tick tick-end" style="right: 0"><span class="tick-label">10</span></span>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const count = tagCounts[tag] || 0;
    return `
      <div class="weight-slider-row" data-tag="${escapeHtml(tag)}">
        <div class="weight-slider-header">
          <span class="weight-slider-tag">${escapeHtml(tag)} <span class="tag-count">(${count} images)</span></span>
        </div>
        <div class="weight-slider-body">
          <span class="weight-slider-percent">${pct}%</span>
          <div class="weight-slider-track-wrapper">
            <span class="weight-slider-value">${formatWeightDisplay(weight)}</span>
            <input type="range"
                   class="weight-slider"
                   min="0"
                   max="18"
                   step="1"
                   value="${sliderPos}"
                   data-tag="${escapeHtml(tag)}" />
            <div class="weight-slider-ticks">
              <span class="tick tick-start" style="left: 0"><span class="tick-label">0.1</span></span>
              <span class="tick tick-center" style="left: 50%"><span class="tick-label">1</span></span>
              <span class="tick tick-end" style="right: 0"><span class="tick-label">10</span></span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  return pieChart + '<div class="weights-sliders">' + sliders + '</div>';
}

// Initialize slider event handlers for tag-weighted mode
function initTagWeightSliders(container) {
  container.querySelectorAll('.weight-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const tag = slider.dataset.tag;
      const position = parseInt(e.target.value);
      const weight = sliderPositionToWeight(position);
      
      // Update weight state
      if (weight === 1) {
        delete tagsetModalTagWeights[tag]; // Remove default weights
      } else {
        tagsetModalTagWeights[tag] = weight;
      }
      
      // Update display
      const row = slider.closest('.weight-slider-row');
      row.querySelector('.weight-slider-value').textContent = formatWeightDisplay(weight);
      
      // Recalculate all percentages
      const newPercentages = calculateTagPercentages(tagsetModalIncludeTags, tagsetModalTagWeights);
      container.querySelectorAll('.weight-slider-row').forEach(r => {
        const t = r.dataset.tag;
        r.querySelector('.weight-slider-percent').textContent = `${newPercentages[t] || 0}%`;
      });
      
      // Update pie chart
      updateWeightsPieChart(tagsetModalIncludeTags, newPercentages);
      
      // Update reset button state
      updateResetWeightsButton();
      
      // Also update Tags tab include pills if visible
      renderTagsetSelectedTags('include');
    });
  });
}

// Update reset weights button state
function updateResetWeightsButton() {
  const resetBtn = document.getElementById('reset-weights-btn');
  if (resetBtn) {
    // Only enable reset if in tag mode AND has custom weights
    const hasCustomWeights = Object.keys(tagsetModalTagWeights).length > 0;
    const canReset = tagsetModalWeightingType === 'tag' && hasCustomWeights;
    resetBtn.disabled = !canReset;
    if (tagsetModalWeightingType === 'image') {
      resetBtn.title = 'Not applicable in image-weighted mode';
    } else if (!hasCustomWeights) {
      resetBtn.title = 'All weights are already at default';
    } else {
      resetBtn.title = '';
    }
  }
}

// Initialize mode toggle handlers (only once per modal open)
function initTagsetModalHandlers() {
  const buttons = document.querySelectorAll('.tagset-mode-toggle .mode-btn');
  
  // Remove old handlers and add new ones
  buttons.forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
  });
  
  // Re-select after cloning
  document.querySelectorAll('.tagset-mode-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      tagsetModalMode = btn.dataset.mode;
      renderTagsetModeToggle();
    });
  });
}

// Close the tagset modal
function closeTagsetModal() {
  const modal = document.getElementById('tagset-modal');
  modal.classList.remove('active');
}

// Sanitize tagset name: lowercase, replace spaces with hyphens, remove invalid chars
function sanitizeTagsetName(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')           // spaces to hyphens
    .replace(/[^a-z0-9-]/g, '')     // remove invalid chars
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}

// Save tagset (create or update) - GLOBAL tagsets, no device_id needed
// Supports renaming via original_name parameter
async function saveTagset(e) {
  if (e) e.preventDefault();
  
  const form = document.getElementById('tagset-form');
  const nameInput = document.getElementById('tagset-name-input');
  
  // Sanitize the name
  const name = sanitizeTagsetName(nameInput.value);
  nameInput.value = name; // Update input to show sanitized value
  
  const originalName = form.dataset.originalName || '';
  
  if (!name) {
    alert('Tagset name is required');
    return;
  }
  
  // Check for case-insensitive duplicate tagset names
  const existingTagsets = window.tvData?.global_tagsets || {};
  const nameLower = name.toLowerCase();
  const originalNameLower = originalName.toLowerCase();
  
  for (const existingName of Object.keys(existingTagsets)) {
    // Skip if this is the same tagset we're editing (case-insensitive match)
    if (originalName && existingName.toLowerCase() === originalNameLower) {
      continue;
    }
    // Check for duplicate name
    if (existingName.toLowerCase() === nameLower) {
      alert(`A tagset named "${existingName}" already exists (names are case-insensitive)`);
      return;
    }
  }
  
  // Get selected tags from modal state
  const tags = tagsetModalIncludeTags;
  const excludeTags = tagsetModalExcludeTags;
  
  // Validate at least one include tag
  if (tags.length === 0) {
    alert('At least one include tag is required');
    return;
  }
  
  try {
    const payload = {
      name: name,
      tags: tags,
      exclude_tags: excludeTags,
      weighting_type: tagsetModalWeightingType
    };
    
    // Include original_name for rename support
    if (originalName && originalName !== name) {
      payload.original_name = originalName;
    }
    
    // Include tag_weights if any non-default weights exist (only relevant for tag-weighted mode)
    if (Object.keys(tagsetModalTagWeights).length > 0) {
      payload.tag_weights = tagsetModalTagWeights;
    }
    
    const response = await fetch(`${API_BASE}/ha/tagsets/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    
    if (result.success) {
      closeTagsetModal();
      // Refresh TV data and re-render
      await loadTVs();
      loadTagsTab();
    } else {
      alert(result.error || 'Failed to save tagset');
    }
  } catch (error) {
    console.error('Error saving tagset:', error);
    alert('Error saving tagset: ' + error.message);
  }
}

// Delete tagset - GLOBAL tagsets, no device_id needed
// Passes tagsets and tvs for pre-validation (HA Supervisor strips error messages)
async function deleteTagset(tagsetName) {
  try {
    const response = await fetch(`${API_BASE}/ha/tagsets/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tagsetName,
        tagsets: allGlobalTagsets,
        tvs: allTVs
      })
    });
    
    const result = await response.json();
    console.log('Delete tagset response:', response.status, result);
    
    if (result.success) {
      // Update local state immediately
      delete allGlobalTagsets[tagsetName];
      
      // Re-render the tagsets UI
      populateTagsetDropdowns();
      renderTVAssignments();
    } else {
      // Show detailed error from backend
      const errorMsg = result.details || result.error || 'Failed to delete tagset';
      console.error('Delete tagset failed:', errorMsg);
      alert(errorMsg);
    }
  } catch (error) {
    console.error('Error deleting tagset:', error);
    alert('Error deleting tagset: ' + error.message);
  }
}

// Select a tagset for a TV
async function selectTagset(deviceId, tagsetName, skipRender = false) {
  try {
    const response = await fetch(`${API_BASE}/ha/tagsets/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId,
        name: tagsetName
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Refresh TV data but optionally skip re-render
      await loadTVs();
      if (!skipRender) {
        renderTVAssignments();
      }
    } else {
      alert(result.error || 'Failed to select tagset');
    }
  } catch (error) {
    console.error('Error selecting tagset:', error);
    alert('Error selecting tagset: ' + error.message);
  }
}

// Format expiry time for display
function formatExpiryTime(minutes) {
  const now = new Date();
  const expiry = new Date(now.getTime() + minutes * 60 * 1000);
  const isToday = expiry.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = expiry.toDateString() === tomorrow.toDateString();
  
  const timeStr = expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  
  if (isToday) {
    return `(${timeStr})`;
  } else if (isTomorrow) {
    return `(tomorrow ${timeStr})`;
  } else {
    return `(${expiry.toLocaleDateString([], { weekday: 'short' })} ${timeStr})`;
  }
}

// Open the override modal
function openOverrideModal(deviceId) {
  const modal = document.getElementById('override-modal');
  const form = document.getElementById('override-form');
  const select = document.getElementById('override-tagset-select');
  const durationSelect = document.getElementById('override-duration-select');
  const customDurationInput = document.getElementById('override-custom-duration');
  const deviceIdInput = document.getElementById('override-device-id');
  const tvNameSpan = document.getElementById('override-tv-name');
  
  // Find the TV
  const tv = allTVs.find(t => t.device_id === deviceId);
  if (!tv) {
    alert('TV not found');
    return;
  }
  
  // Store device ID
  deviceIdInput.value = deviceId;
  tvNameSpan.textContent = tv.name;
  
  // Populate tagset options from GLOBAL tagsets - exclude currently selected tagset
  const tagsetNames = Object.keys(allGlobalTagsets || {})
    .filter(name => name !== tv.selected_tagset);
  
  select.innerHTML = '<option value="">-- Select Tagset --</option>' + 
    tagsetNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  
  // Update duration options with expiry times
  const durations = [
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '120', label: '2 hours' },
    { value: '240', label: '4 hours' },
    { value: '480', label: '8 hours' },
    { value: '720', label: '12 hours' },
    { value: '1440', label: '24 hours' },
    { value: 'custom', label: 'Custom...' }
  ];
  
  durationSelect.innerHTML = durations.map(d => {
    const expiryStr = d.value !== 'custom' ? ' ' + formatExpiryTime(parseInt(d.value)) : '';
    return `<option value="${d.value}"${d.value === '240' ? ' selected' : ''}>${d.label}${expiryStr}</option>`;
  }).join('');
  
  customDurationInput.classList.add('hidden');
  customDurationInput.value = '';
  
  modal.classList.add('active');
}

// Close the override modal
function closeOverrideModal() {
  const modal = document.getElementById('override-modal');
  modal.classList.remove('active');
}

// Apply override
async function applyOverride(e) {
  if (e) e.preventDefault();
  
  const deviceIdInput = document.getElementById('override-device-id');
  const select = document.getElementById('override-tagset-select');
  const durationSelect = document.getElementById('override-duration-select');
  const customDurationInput = document.getElementById('override-custom-duration');
  
  const deviceId = deviceIdInput.value;
  const tagsetName = select.value;
  
  if (!tagsetName) {
    alert('Please select a tagset');
    return;
  }
  
  // Get duration in minutes
  let durationMinutes;
  if (durationSelect.value === 'custom') {
    durationMinutes = parseInt(customDurationInput.value) || 0;
  } else {
    durationMinutes = parseInt(durationSelect.value) || 0;
  }
  
  if (durationMinutes <= 0) {
    alert('Please select a duration');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/ha/tagsets/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId,
        name: tagsetName,
        duration_minutes: durationMinutes
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      closeOverrideModal();
      // Refresh TV data and re-render
      await loadTVs();
      loadTagsTab();
    } else {
      alert(result.error || 'Failed to set override');
    }
  } catch (error) {
    console.error('Error setting override:', error);
    alert('Error setting override: ' + error.message);
  }
}

// Clear override
async function clearOverride(deviceId) {
  try {
    const response = await fetch(`${API_BASE}/ha/tagsets/clear-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Refresh TV data and re-render
      await loadTVs();
      loadTagsTab();
    } else {
      alert(result.error || 'Failed to clear override');
    }
  } catch (error) {
    console.error('Error clearing override:', error);
    alert('Error clearing override: ' + error.message);
  }
}

// Initialize tagset modal event listeners
function initTagsetModalListeners() {
  // Tagset modal
  const tagsetModal = document.getElementById('tagset-modal');
  if (tagsetModal) {
    // Close button
    document.getElementById('tagset-modal-close')?.addEventListener('click', closeTagsetModal);
    
    // Cancel button
    document.getElementById('cancel-tagset-btn')?.addEventListener('click', closeTagsetModal);
    
    // Form submission
    const tagsetForm = document.getElementById('tagset-form');
    tagsetForm?.addEventListener('submit', saveTagset);
    
    // Delete button - GLOBAL tagsets, no device_id needed
    document.getElementById('delete-tagset-btn')?.addEventListener('click', async () => {
      const form = document.getElementById('tagset-form');
      const tagsetName = form.dataset.originalName;
      if (tagsetName && confirm(`Delete tagset "${tagsetName}"?`)) {
        await deleteTagset(tagsetName);
        closeTagsetModal();
      }
    });
    
    // Close on background click
    tagsetModal.addEventListener('click', (e) => {
      if (e.target === tagsetModal) {
        closeTagsetModal();
      }
    });
  }
  
  // Override modal
  const overrideModal = document.getElementById('override-modal');
  if (overrideModal) {
    // Close button
    document.getElementById('override-modal-close')?.addEventListener('click', closeOverrideModal);
    
    // Cancel button
    document.getElementById('cancel-override-btn')?.addEventListener('click', closeOverrideModal);
    
    // Form submission
    const overrideForm = document.getElementById('override-form');
    overrideForm?.addEventListener('submit', applyOverride);
    
    // Duration select change handler for custom option
    const durationSelect = document.getElementById('override-duration-select');
    const customDurationInput = document.getElementById('override-custom-duration');
    durationSelect?.addEventListener('change', () => {
      if (durationSelect.value === 'custom') {
        customDurationInput?.classList.remove('hidden');
        customDurationInput?.focus();
      } else {
        customDurationInput?.classList.add('hidden');
      }
    });
    
    // Close on background click
    overrideModal.addEventListener('click', (e) => {
      if (e.target === overrideModal) {
        closeOverrideModal();
      }
    });
  }
  
  // "New Tagset" button in Tags tab - needs to open modal with no device pre-selected
  // We'll handle this differently - through the individual TV sections
}



// ============================================================================
// WEB SOURCES TAB
// ============================================================================

let webSourcesConfig = null;       // Cached web sources config
let webSourceSettingsSchemas = {}; // Cached settings schemas from GET /config
let webSourceSourceConstraints = {}; // Cached per-source constraints (e.g. aspectRatioConstraint)
let webSourceMetadata = {};        // Cached per-source { fields, defaultMapping } from GET /config
let webSourceSettingsSourceId = null; // Which source is currently open in the settings modal
let webSourceFilterTypes = {};     // Cached per-source filter type definitions from GET /config
let webSourceCapabilities = {};    // Cached per-source capabilities (e.g. hasCookies) from GET /config
let webSourceCoreFilterTypes = []; // Cached framework-level filter types (e.g. orientation)
let webSourceImageProcessingSchema = {}; // Cached imageProcessingSchema from GET /config
let webSourceTestOrientation = 'landscape'; // Simulated TV orientation for test fetches
let webSourceSpecificImage = ''; // Optional specific image URL or ID for test fetches
let webSourceTestMode = 'virtual-tag'; // 'virtual-tag' | 'ad-hoc' | 'specific'
let webSourceTestVirtualTagId = ''; // Selected virtual tag for test
let webSourceTestAdHocSourceId = ''; // Selected source for ad-hoc test
let webSourceTestAdHocFilters = []; // Ad-hoc filters built inline

const WEB_SOURCES_VIRTUAL_TAG = 'web_sources';

/**
 * Show an image in a full-screen lightbox overlay.
 * The lightbox is created lazily on first call and reused thereafter.
 */
function showImageLightbox(src, alt) {
  let lb = document.getElementById('ws-img-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ws-img-lightbox';
    lb.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,0.88)', 'display:flex',
      'align-items:center', 'justify-content:center', 'cursor:zoom-out',
    ].join(';');
    const img = document.createElement('img');
    img.style.cssText = 'max-width:95vw;max-height:95vh;border-radius:4px;box-shadow:0 4px 32px rgba(0,0,0,0.7);';
    lb.appendChild(img);
    document.body.appendChild(lb);
    lb.addEventListener('click', () => { lb.style.display = 'none'; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb.style.display !== 'none') lb.style.display = 'none';
    });
  }
  lb.querySelector('img').src = src;
  lb.querySelector('img').alt = alt || '';
  lb.style.display = 'flex';
}

async function loadWebSourcesTab() {
  if (!allTVs || allTVs.length === 0) {
    await loadTVs();
  }
  if (!allAttributes || allAttributes.length === 0) {
    await loadAttributes();
  }
  if (!allEntityTypes || allEntityTypes.length === 0) {
    await loadEntities();
  }
  await loadWebSourcesConfig();
  renderWebSourcesGlobalSettings();
  renderWebSourcesList();
  renderVirtualTagsList();
  renderWebSourcesTestSection();
}

async function loadWebSourcesConfig() {
  try {
    const response = await fetch(`${API_BASE}/web-sources/config`);
    const data = await response.json();
    if (data.success) {
      webSourcesConfig = data.webSources;
      webSourceSettingsSchemas = data.settingsSchemas || {};
      webSourceSourceConstraints = data.sourceConstraints || {};
      webSourceFilterTypes = data.filterTypes || {};
      webSourceCapabilities = data.sourceCapabilities || {};
      webSourceCoreFilterTypes = data.coreFilterTypes || [];
      webSourceMetadata = data.sourceMetadata || {};
      webSourceImageProcessingSchema = data.imageProcessingSchema || {};
    }
  } catch (error) {
    console.error('Error loading web sources config:', error);
  }
}

function renderWebSourcesGlobalSettings(expandedTypes) {
  const container = document.getElementById('web-sources-global-settings');
  if (!container) return;

  const globalFilters = webSourcesConfig?.globalFilters || [];
  const coreFilterTypes = webSourceCoreFilterTypes || [];

  let html = '<div class="ws-global-filters-section">';
  html += '<label class="ws-global-label">Global Filters</label>';
  html += '<p class="pool-health-description">Filters applied to all sources and virtual tags. These constrain corresponding values at lower levels.</p>';
  html += renderFilterList({
    containerId: 'ws-global-filters',
    availableFilterTypes: coreFilterTypes,
    currentFilters: globalFilters,
    lockedFilters: [],
    expandedTypes,
  });
  html += '</div>';
  container.innerHTML = html;

  // Bind interactions for the global filter list
  initFilterListInteractions(container, {
    onAdd: async (filterType, filterMode) => {
      const ftDef = coreFilterTypes.find(ft => ft.type === filterType);
      if (!ftDef) return;
      const defaultValue = ftDef.values?.[0]?.value;
      if (!defaultValue) return;
      const mode = filterMode || 'require';
      const newGlobalFilters = [...globalFilters, { type: filterType, mode, values: [defaultValue] }];
      await saveGlobalFilters(newGlobalFilters, new Set([`${filterType}:${mode}`]));
    },
    onRemove: async (filterType, filterMode) => {
      const newGlobalFilters = globalFilters.filter(f => !(f.type === filterType && (!filterMode || f.mode === filterMode)));
      await saveGlobalFilters(newGlobalFilters);
    },
    onCoreValueChange: async (filterType, newValue) => {
      const newGlobalFilters = globalFilters.map(f =>
        f.type === filterType ? { ...f, values: [newValue] } : f
      );
      await saveGlobalFilters(newGlobalFilters);
    },
  });

  async function saveGlobalFilters(newGlobalFilters, expandedTypes) {
    try {
      const response = await fetch(`${API_BASE}/web-sources/global-filters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: newGlobalFilters }),
      });
      const data = await response.json();
      if (data.success) {
        if (webSourcesConfig) webSourcesConfig.globalFilters = newGlobalFilters;
        renderWebSourcesGlobalSettings(expandedTypes);
        renderWebSourcesList();
        showToast('Global filters updated');
      } else {
        throw new Error(data.error || 'Failed to update global filters');
      }
    } catch (error) {
      console.error('Error updating global filters:', error);
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // Image processing settings

  // Returns the HTML for a processor's options panel (recursively for preProcessor-type options).
  // processorSchema: the schema entry ({ value, label, options })
  // currentOptions: the saved options object for this processor (e.g. preProcessorOptions)
  // idPrefix: DOM ID prefix for this level's controls
  // allProcessors: the full preProcessors array from the schema (for preProcessor-type options)
  function renderProcessorOptionsPanel(processorSchema, currentOptions, idPrefix, allProcessors) {
    if (!processorSchema?.options?.length) return '';
    const fields = processorSchema.options.map((opt, i) => {
      const fieldId = `${idPrefix}-${opt.key}`;
      const currentVal = currentOptions?.[opt.key] ?? opt.default;
      const marginTop = i > 0 ? 'margin-top:12px;' : '';

      if (opt.type === 'select') {
        return `
          <div style="${marginTop}">
            <label class="ws-global-label" style="display:block;">${escapeHtml(opt.label)}</label>
            ${opt.description ? `<p class="pool-health-description">${escapeHtml(opt.description)}</p>` : ''}
            <select id="${fieldId}" class="ws-select" data-option-key="${escapeHtml(opt.key)}">
              ${opt.choices.map(c => `<option value="${c.value}" ${currentVal === c.value ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
            </select>
          </div>`;
      }

      if (opt.type === 'preProcessor') {
        const available = allProcessors.filter(p => !(opt.excludeValues || []).includes(p.value));
        const nestedOpts = currentOptions?.[`${opt.key}Options`] ?? {};
        const selectedSchema = available.find(p => p.value === currentVal) || available.find(p => p.value === opt.default);
        return `
          <div style="${marginTop}">
            <label class="ws-global-label" style="display:block;">${escapeHtml(opt.label)}</label>
            ${opt.description ? `<p class="pool-health-description">${escapeHtml(opt.description)}</p>` : ''}
            <select id="${fieldId}" class="ws-select" data-option-key="${escapeHtml(opt.key)}">
              ${available.map(p => `<option value="${p.value}" ${currentVal === p.value ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
            <div id="${fieldId}-nested">
              ${renderProcessorOptionsPanel(selectedSchema, nestedOpts, `${fieldId}-nested`, allProcessors)}
            </div>
          </div>`;
      }

      return '';
    }).join('');

    return `<div class="ws-processor-options-panel" style="margin-top:12px;padding:12px;border:1px solid var(--border-color,#ddd);border-radius:6px;background:var(--card-background-color,var(--background-secondary,#f8f9fa));">${fields}</div>`;
  }

  // Collects the complete options object from the DOM for a given processor.
  function collectProcessorOptions(processorSchema, idPrefix, allProcessors) {
    const opts = {};
    if (!processorSchema?.options?.length) return opts;
    for (const opt of processorSchema.options) {
      const el = document.getElementById(`${idPrefix}-${opt.key}`);
      if (!el) continue;
      opts[opt.key] = el.value;
      if (opt.type === 'preProcessor') {
        const nestedIdPrefix = `${idPrefix}-${opt.key}-nested`;
        const nestedSchema = allProcessors.find(p => p.value === el.value);
        opts[`${opt.key}Options`] = collectProcessorOptions(nestedSchema, nestedIdPrefix, allProcessors);
      }
    }
    return opts;
  }

  const preProcessors  = webSourceImageProcessingSchema.preProcessors || [];
  const cropEngines    = webSourceImageProcessingSchema.cropEngines   || [];
  const currentPreProc = webSourcesConfig?.imageProcessing?.preProcessor  || 'corner_consensus';
  const currentEngine  = webSourcesConfig?.imageProcessing?.cropEngine    || 'sharp';
  const currentPreProcOpts   = webSourcesConfig?.imageProcessing?.preProcessorOptions  || {};
  const currentCropEngOpts   = webSourcesConfig?.imageProcessing?.cropEngineOptions    || {};
  const currentSkipLowRes    = webSourcesConfig?.imageProcessing?.skipLowRes   ?? false;
  const currentMinResolution = webSourcesConfig?.imageProcessing?.minResolution ?? 1080;

  const currentPreProcSchema = preProcessors.find(p => p.value === currentPreProc);
  const currentEngineSchema  = cropEngines.find(e => e.value === currentEngine);

  if (preProcessors.length > 0 || cropEngines.length > 0) {
    const processingHtml = `
      <div class="ws-global-setting" style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border-color,#e0e0e0);">
        ${preProcessors.length > 0 ? `
          <label class="ws-global-label">Frame Detection</label>
          <p class="pool-health-description">Detect and remove decorative frames or borders from artwork images before cropping.</p>
          <select id="ws-pre-processor-select" class="ws-select">
            ${preProcessors.map(p => `<option value="${p.value}" ${currentPreProc === p.value ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
          </select>
          <div id="ws-pre-processor-options">
            ${renderProcessorOptionsPanel(currentPreProcSchema, currentPreProcOpts, 'ws-pre-processor-options', preProcessors)}
          </div>
        ` : ''}
        ${cropEngines.length > 0 ? `
          <label class="ws-global-label" style="margin-top:16px;display:block;">Crop Engine</label>
          <p class="pool-health-description">How to scale and crop the image to fit the TV's 4K aspect ratio.</p>
          <select id="ws-crop-engine-select" class="ws-select">
            ${cropEngines.map(e => `<option value="${e.value}" ${currentEngine === e.value ? 'selected' : ''}>${escapeHtml(e.label)}</option>`).join('')}
          </select>
          <div id="ws-crop-engine-options">
            ${renderProcessorOptionsPanel(currentEngineSchema, currentCropEngOpts, 'ws-crop-engine-options', preProcessors)}
          </div>
        ` : ''}
        <label class="ws-global-label" style="margin-top:16px;display:block;">Minimum Resolution</label>
        <p class="pool-health-description">Skip images whose shorter side is below this threshold (pixels) and fetch a different one. Uses up to 3 attempts. Useful for sources that occasionally serve very small images.</p>
        <div style="display:flex;align-items:center;gap:12px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="ws-skip-low-res-toggle" ${currentSkipLowRes ? 'checked' : ''}>
            <span>Skip low-resolution images</span>
          </label>
        </div>
        <div id="ws-min-resolution-row" style="display:${currentSkipLowRes ? 'flex' : 'none'};align-items:center;gap:8px;margin-top:8px;">
          <label for="ws-min-resolution-input" style="white-space:nowrap;">Minimum short side:</label>
          <input type="number" id="ws-min-resolution-input" class="ws-select" style="width:100px;"
            min="360" max="3840" step="1" value="${currentMinResolution}">
          <span style="opacity:0.7;">px</span>
        </div>
      </div>`;
    container.insertAdjacentHTML('beforeend', processingHtml);

    // Helper: save preProcessorOptions after any pre-processor option changes.
    async function savePreProcessorOptions() {
      const selEl = document.getElementById('ws-pre-processor-select');
      if (!selEl) return;
      const schema = preProcessors.find(p => p.value === selEl.value);
      const opts = collectProcessorOptions(schema, 'ws-pre-processor-options', preProcessors);
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preProcessorOptions: opts }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast('Frame detection options updated');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating pre-processor options:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    }

    // Helper: save cropEngineOptions after any crop engine option changes.
    async function saveCropEngineOptions() {
      const selEl = document.getElementById('ws-crop-engine-select');
      if (!selEl) return;
      const schema = cropEngines.find(e => e.value === selEl.value);
      const opts = collectProcessorOptions(schema, 'ws-crop-engine-options', preProcessors);
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cropEngineOptions: opts }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast('Crop engine options updated');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating crop engine options:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    }

    // Helper: bind option panel change listeners (called after render and after re-render).
    function bindOptionsPanelListeners(panelId, saveFn, processorSchema, idPrefix, allProcs) {
      const panel = document.getElementById(panelId);
      if (!panel || !processorSchema?.options?.length) return;
      for (const opt of processorSchema.options) {
        const fieldEl = document.getElementById(`${idPrefix}-${opt.key}`);
        if (!fieldEl) continue;
        if (opt.type === 'preProcessor') {
          fieldEl.addEventListener('change', async () => {
            // Re-render the nested options panel for the newly selected sub-processor.
            const nestedPanelEl = document.getElementById(`${idPrefix}-${opt.key}-nested`);
            if (nestedPanelEl) {
              const subSchema = allProcs.find(p => p.value === fieldEl.value);
              nestedPanelEl.innerHTML = renderProcessorOptionsPanel(subSchema, {}, `${idPrefix}-${opt.key}-nested`, allProcs);
              // Bind listeners for the newly rendered nested panel.
              bindOptionsPanelListeners(`${idPrefix}-${opt.key}-nested`, saveFn, subSchema, `${idPrefix}-${opt.key}-nested`, allProcs);
            }
            await saveFn();
          });
          // Bind listeners for the initially rendered nested panel too.
          const nestedSchema = allProcs.find(p => p.value === (fieldEl.value));
          bindOptionsPanelListeners(`${idPrefix}-${opt.key}-nested`, saveFn, nestedSchema, `${idPrefix}-${opt.key}-nested`, allProcs);
        } else {
          fieldEl.addEventListener('change', saveFn);
        }
      }
    }

    document.getElementById('ws-pre-processor-select')?.addEventListener('change', async (e) => {
      const preProcessor = e.target.value;
      // Re-render the options panel for the newly selected pre-processor.
      const schema = preProcessors.find(p => p.value === preProcessor);
      const optsPanelEl = document.getElementById('ws-pre-processor-options');
      if (optsPanelEl) {
        optsPanelEl.innerHTML = renderProcessorOptionsPanel(schema, {}, 'ws-pre-processor-options', preProcessors);
        bindOptionsPanelListeners('ws-pre-processor-options', savePreProcessorOptions, schema, 'ws-pre-processor-options', preProcessors);
      }
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preProcessor, preProcessorOptions: {} }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast('Frame detection updated');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating frame detection setting:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    });

    // Bind initial option panel listeners.
    bindOptionsPanelListeners('ws-pre-processor-options', savePreProcessorOptions, currentPreProcSchema, 'ws-pre-processor-options', preProcessors);

    document.getElementById('ws-crop-engine-select')?.addEventListener('change', async (e) => {
      const cropEngine = e.target.value;
      const schema = cropEngines.find(eng => eng.value === cropEngine);
      const optsPanelEl = document.getElementById('ws-crop-engine-options');
      if (optsPanelEl) {
        optsPanelEl.innerHTML = renderProcessorOptionsPanel(schema, {}, 'ws-crop-engine-options', preProcessors);
        bindOptionsPanelListeners('ws-crop-engine-options', saveCropEngineOptions, schema, 'ws-crop-engine-options', preProcessors);
      }
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cropEngine, cropEngineOptions: {} }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast('Crop engine updated');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating crop engine setting:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    });

    // Bind initial crop engine option panel listeners.
    bindOptionsPanelListeners('ws-crop-engine-options', saveCropEngineOptions, currentEngineSchema, 'ws-crop-engine-options', preProcessors);

    document.getElementById('ws-skip-low-res-toggle')?.addEventListener('change', async (e) => {
      const skipLowRes = e.target.checked;
      document.getElementById('ws-min-resolution-row').style.display = skipLowRes ? 'flex' : 'none';
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skipLowRes }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast(skipLowRes ? 'Low-res skip enabled' : 'Low-res skip disabled');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating skip low-res setting:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    });

    document.getElementById('ws-min-resolution-input')?.addEventListener('change', async (e) => {
      const minResolution = parseInt(e.target.value, 10);
      if (!Number.isFinite(minResolution) || minResolution < 1) return;
      try {
        const response = await fetch(`${API_BASE}/web-sources/image-processing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minResolution }),
        });
        const data = await response.json();
        if (data.success) {
          if (webSourcesConfig) webSourcesConfig.imageProcessing = data.imageProcessing;
          showToast('Minimum resolution updated');
        } else {
          throw new Error(data.error || 'Failed to update setting');
        }
      } catch (error) {
        console.error('Error updating minimum resolution:', error);
        showToast(`Error: ${error.message}`, 'error');
      }
    });
  }

  // Metadata formatting settings
  const currentFormatDates = webSourcesConfig?.formatDates !== false;
  const formattingHtml = `
    <div class="ws-global-setting" style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border-color,#e0e0e0);">
      <label class="ws-global-label">Metadata Formatting</label>
      <p class="pool-health-description">Normalize metadata fields before they are mapped to Home Assistant attributes. Raw values are always preserved in the Testing view.</p>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:4px;">
        <input type="checkbox" id="ws-format-dates-toggle" ${currentFormatDates ? 'checked' : ''}>
        <span>Format dates</span>
      </label>
      <p class="pool-health-description" style="margin-top:4px;">Normalize date fields to year-only display (e.g. "ca. 1920", "1872-1926"). Applies to Date Created, Creator Lifespan, and any other date-type fields.</p>
    </div>`;
  container.insertAdjacentHTML('beforeend', formattingHtml);

  document.getElementById('ws-format-dates-toggle')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      const response = await fetch(`${API_BASE}/web-sources/format-dates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json();
      if (data.success) {
        if (webSourcesConfig) webSourcesConfig.formatDates = enabled;
        showToast(`Date formatting ${enabled ? 'enabled' : 'disabled'}`);
      } else {
        throw new Error(data.error || 'Failed to update setting');
      }
    } catch (error) {
      console.error('Error updating format-dates setting:', error);
      showToast(`Error: ${error.message}`, 'error');
    }
  });
}

function hasEnabledWebSources() {
  return Object.values(webSourcesConfig?.sources || {}).some(s => s.enabled);
}

function renderWebSourcesList() {
  const container = document.getElementById('web-sources-list');
  if (!container) return;

  const sources = webSourcesConfig?.sources || {};

  if (Object.keys(sources).length === 0) {
    container.innerHTML = '<p class="empty-state">No web sources available.</p>';
    return;
  }

  // Resolve current orientation from globalFilters
  const globalFilters = webSourcesConfig?.globalFilters || [];
  const orientationFilter = globalFilters.find(f => f.type === 'orientation' && f.mode === 'require');
  const currentAspectRatio = orientationFilter?.values?.[0] || 'all';

  let html = '<div class="web-sources-cards">';
  for (const [sourceId, source] of Object.entries(sources)) {
    const hasFilters = (webSourceFilterTypes[sourceId]?.length > 0);
    const hasSettings = hasFilters || !!webSourceSettingsSchemas[sourceId] || webSourceCapabilities[sourceId]?.hasCookies || (webSourceMetadata[sourceId]?.fields?.length > 0);
    const constraint = webSourceSourceConstraints[sourceId]?.aspectRatioConstraint;
    const isIncompatible =
      (constraint === 'landscape' && currentAspectRatio === 'portrait') ||
      (constraint === 'portrait'  && currentAspectRatio === 'landscape');
    const constraintLabel = constraint === 'landscape' ? 'landscape-only' : constraint === 'portrait' ? 'portrait-only' : '';
    const incompatibleNote = isIncompatible
      ? `<span class="ws-incompatible-note">Unavailable: ${constraintLabel} source, incompatible with ${currentAspectRatio} filter</span>`
      : '';
    html += `
      <div class="web-source-card${isIncompatible ? ' ws-source-incompatible' : ''}">
        <div class="web-source-card-header">
          <div class="web-source-info">
            <strong>${escapeHtml(source.name)}</strong>
            <span class="web-source-description">${escapeHtml(source.description || '')}</span>
            ${incompatibleNote}
          </div>
          <div class="web-source-card-actions">
            ${hasSettings ? `<button type="button" class="btn-secondary btn-small web-source-settings-btn" data-source-id="${escapeHtml(sourceId)}" title="Settings">Settings</button>` : ''}
          </div>
        </div>
      </div>`;
  }
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.web-source-settings-btn').forEach(btn => {
    btn.addEventListener('click', () => openWebSourceSettings(btn.dataset.sourceId));
  });
}

// ── Web Source Settings Modal ─────────────────────────────────────────────────

// ── Generic filter renderer ──────────────────────────────────────────────────

/**
 * Render the filter sections for a source based on its declared filter types.
 * Returns an HTML string containing all filter type sections.
 * The current filter values are read from webSourcesConfig.sources[sourceId].filters.
 */
/**
 * Render all filter sections for a source.
 * @param {string} sourceId
 * @param {Array} [currentFilters] - Current filter values. Defaults to source config filters.
 * @param {Array} [lockedFilters] - Filters from higher cascade levels (shown as locked/disabled).
 */
function renderSourceFilters(sourceId, currentFilters, lockedFilters, expandedTypes) {
  const sourceFilterTypes = webSourceFilterTypes[sourceId] || [];
  const coreTypes = webSourceCoreFilterTypes || [];
  const allFilterTypes = [...coreTypes, ...sourceFilterTypes];
  if (currentFilters === undefined) {
    currentFilters = webSourcesConfig?.sources?.[sourceId]?.filters || [];
  }
  // Global filters are locked at the source level
  if (!lockedFilters) lockedFilters = webSourcesConfig?.globalFilters || [];

  return renderFilterList({
    containerId: `ws-filters-${sourceId}`,
    availableFilterTypes: allFilterTypes,
    currentFilters,
    lockedFilters,
    sourceId,
    expandedTypes,
  });
}

/**
 * Unified filter list component. Renders a list of active filters with add/remove,
 * reusable at global, source, and virtual tag levels.
 *
 * @param {object} options
 * @param {string} options.containerId - Unique DOM ID prefix
 * @param {Array} options.availableFilterTypes - Filter type definitions that can be added
 * @param {Array} options.currentFilters - Active filters [{type, mode, values}]
 * @param {Array} [options.lockedFilters] - Parent-level filters (shown locked, not removable)
 * @param {string} [options.sourceId] - Source ID for data attributes (used by readFiltersFromUI)
 * @returns {string} HTML
 */
function renderFilterList({ containerId, availableFilterTypes, currentFilters, lockedFilters = [], sourceId = '', expandedTypes = null }) {
  // Track active type:mode pairs for dual-mode support
  const activeTypeModePairs = new Set(currentFilters.map(f => `${f.type}:${f.mode}`));
  const activeTypes = new Set(currentFilters.map(f => f.type));
  const lockedTypes = new Set(lockedFilters.map(f => f.type));

  // Build addable options: each entry is { type, mode, label } where mode is the
  // specific mode to add. A filter type with multiple modes can appear twice if one
  // mode is already active and another is available.
  const addableOptions = [];
  for (const ft of availableFilterTypes) {
    // Single-value non-multiValue filters locked by parent are not addable
    if (lockedTypes.has(ft.type) && !ft.multiValue) continue;
    // Modes already active at this level are always blocked.
    // Locked modes from parent are only blocked for non-multiValue types;
    // multiValue types can add the same mode at a lower level to narrow further
    // (require = intersection, exclude = union).
    const usedModes = [
      ...currentFilters.filter(f => f.type === ft.type).map(f => f.mode),
      ...(!ft.multiValue ? lockedFilters.filter(f => f.type === ft.type).map(f => f.mode) : []),
    ];
    const availableModes = (ft.modes || ['require']).filter(m => !usedModes.includes(m));
    if (availableModes.length === 0) continue;
    if (!activeTypes.has(ft.type)) {
      // Type not active at all — add as single option (mode chosen via radio or default)
      addableOptions.push({ type: ft.type, mode: availableModes[0], label: ft.label, modes: availableModes });
    } else if (ft.modes && ft.modes.length > 1) {
      // Type already has one mode active — offer remaining modes individually
      for (const m of availableModes) {
        const modeLabel = m === 'exclude' ? 'Exclude' : 'Include Only';
        addableOptions.push({ type: ft.type, mode: m, label: `${ft.label} (${modeLabel})` });
      }
    }
  }

  let html = `<div class="ws-filter-list" id="${escapeHtml(containerId)}">`;

  // 1. Locked filters from parent level (not removable, not editable)
  for (const lockedFilter of lockedFilters) {
    const ft = availableFilterTypes.find(f => f.type === lockedFilter.type);
    if (!ft) continue;
    html += renderLockedFilterEntry(ft, lockedFilter);
  }

  // 2. Active filters (user-added, removable)
  for (const filter of currentFilters) {
    const ft = availableFilterTypes.find(f => f.type === filter.type);
    if (!ft) continue;
    // Collect ALL parent filters of the same type (regardless of mode).
    // The child's mode determines how each parent filter contributes to locking:
    // - For child Include: parent excludes lock as "will never apply", parent requires
    //   define the available universe (values outside it lock as "will never apply")
    // - For child Exclude: parent excludes lock as "already applied" (redundant)
    const parentFiltersForType = lockedFilters.filter(f => f.type === filter.type);
    const expanded = expandedTypes ? (expandedTypes.has(`${filter.type}:${filter.mode}`) || expandedTypes.has(filter.type)) : false;
    // Check if both modes are active for this type (dual-mode)
    const bothModesActive = ft.modes?.length > 1 && ft.modes.every(m => activeTypeModePairs.has(`${ft.type}:${m}`));
    html += renderActiveFilterEntry(sourceId, ft, filter, parentFiltersForType, { expanded, fixedMode: bothModesActive });
  }

  // 3. Add filter button
  if (addableOptions.length > 0) {
    html += `<div class="ws-filter-add-row">
      <button type="button" class="ws-filter-add-btn" data-container-id="${escapeHtml(containerId)}">+ Add Filter</button>
      <div class="ws-filter-add-options" style="display:none;">
        ${addableOptions.map(opt => `<button type="button" class="ws-filter-add-option" data-filter-type="${escapeHtml(opt.type)}" data-filter-mode="${escapeHtml(opt.mode)}">${escapeHtml(opt.label)}</button>`).join('')}
      </div>
    </div>`;
  }

  if (currentFilters.length === 0 && lockedFilters.length === 0 && addableOptions.length === 0) {
    html += '<p class="pool-health-description" style="font-style:italic;">No filter types available for this source.</p>';
  }

  html += '</div>';
  return html;
}

/**
 * Render a locked (inherited) filter entry. Shows the filter state but is not editable.
 */
function renderLockedFilterEntry(filterType, filter) {
  const valueLabels = filter.values.map(v => {
    const vDef = (filterType.values || []).find(fv => fv.value === v);
    return vDef?.label || v;
  });
  const modeLabel = filter.mode === 'require' ? 'Include only' : 'Exclude';
  let html = `<div class="ws-filter-entry ws-filter-entry-locked">
    <div class="ws-filter-entry-header">
      <span class="ws-filter-entry-title">🔒 ${escapeHtml(filterType.label)}</span>
      <span class="ws-filter-entry-summary">${escapeHtml(modeLabel)}: ${escapeHtml(valueLabels.join(', '))}</span>
    </div>
  </div>`;
  return html;
}

/**
 * Generate a short summary string for a single filter (used in collapsed headers).
 */
function generateFilterSummary(filterType, filter) {
  if (!filter || !filter.values) return '';
  // Core single-value (e.g. orientation)
  if (filterType.core && !filterType.multiValue) {
    const vDef = (filterType.values || []).find(fv => fv.value === filter.values[0]);
    return vDef?.label || filter.values[0] || '';
  }
  // Search filter (single-value text)
  if (filterType.inputStyle === 'search') {
    return filter.values[0] ? `"${filter.values[0]}"` : 'no query';
  }
  // Checkbox/text multi-value
  const modeLabel = filter.mode === 'require' ? 'Include only' : 'Exclude';
  if (!filter.values.length) return `${modeLabel}: none selected`;
  const valueLabels = filter.values.slice(0, 3).map(v => {
    const vDef = (filterType.values || []).find(fv => fv.value.toLowerCase() === v.toLowerCase());
    return vDef?.label || v;
  });
  const suffix = filter.values.length > 3 ? ` +${filter.values.length - 3} more` : '';
  return `${modeLabel}: ${valueLabels.join(', ')}${suffix}`;
}

/**
 * Render an active (user-added) filter entry with its value picker and remove button.
 */
function renderActiveFilterEntry(sourceId, filterType, currentFilter, parentFilters, { expanded = false, fixedMode = false } = {}) {
  const collapsed = !expanded;
  const filterMode = currentFilter?.mode || filterType.modes?.[0] || 'require';
  const summary = generateFilterSummary(filterType, currentFilter);
  // When in dual-mode (both require+exclude active), show mode in title
  const titleSuffix = fixedMode ? ` (${filterMode === 'exclude' ? 'Exclude' : 'Include Only'})` : '';
  let html = `<div class="ws-filter-entry" data-filter-type="${escapeHtml(filterType.type)}" data-filter-mode="${escapeHtml(filterMode)}" data-collapsed="${collapsed}">
    <div class="ws-filter-entry-header">
      <span class="ws-filter-entry-title">${escapeHtml(filterType.label)}${escapeHtml(titleSuffix)}</span>
      <span class="ws-filter-entry-summary">${escapeHtml(summary)}</span>
      <button type="button" class="btn-secondary btn-small ws-filter-entry-remove" data-filter-type="${escapeHtml(filterType.type)}" data-filter-mode="${escapeHtml(filterMode)}" title="Remove this filter">&times;</button>
    </div>
    <div class="ws-filter-entry-body">`;

  if (filterType.core && !filterType.multiValue) {
    // Simple select (e.g. orientation)
    html += `<select class="ws-select ws-filter-core-value" data-filter-type="${escapeHtml(filterType.type)}">
      ${(filterType.values || []).map(v =>
        `<option value="${escapeHtml(v.value)}" ${currentFilter.values.includes(v.value) ? 'selected' : ''}>${escapeHtml(v.label)}</option>`
      ).join('')}
    </select>`;
  } else if (filterType.inputStyle === 'search') {
    // Single-value search input
    const searchVal = currentFilter?.values?.[0] || '';
    html += `<div class="ws-filter-search-input-wrap">
      <input type="text" class="ws-type-input ws-filter-search-value"
             data-source-id="${escapeHtml(sourceId)}" data-filter-type="${escapeHtml(filterType.type)}"
             placeholder="${escapeHtml(filterType.description || 'Enter search query...')}"
             value="${escapeHtml(searchVal)}">
    </div>`;
  } else if (filterType.inputStyle === 'text') {
    // Text input filter (rendered inline)
    html += renderTextFilterSection(sourceId, filterType, currentFilter, parentFilters, { fixedMode });
  } else {
    // Checkbox filter (rendered inline)
    html += renderCheckboxFilterSection(sourceId, filterType, currentFilter, parentFilters, { fixedMode });
  }

  html += '</div></div>';
  return html;
}

/**
 * Render a checkbox-based filter section (for filter types with enumerated values/groups).
 * Used for media categories and similar grouped value lists.
 * @param {Array} [parentFilters] - All parent filters of the same type from higher cascade levels.
 *   Used to compute which values are locked and why.
 */
function renderCheckboxFilterSection(sourceId, filterType, currentFilter, parentFilters, { fixedMode = false } = {}) {
  // Current excluded/required values
  const filterValues = new Set((currentFilter?.values || []).map(v => v.toLowerCase()));
  const filterMode = currentFilter?.mode || 'require';

  // Compute aggregate parent state from ALL parent filters of this type.
  // parentExcluded: union of all exclude values (these are explicitly blocked upstream)
  // parentRequired: intersection of all require values (null if no require filters exist)
  const parentExcluded = new Set();
  let parentRequired = null; // null = no require constraint (all allowed)
  for (const pf of (parentFilters || [])) {
    const vals = (pf.values || []).map(v => v.toLowerCase());
    if (pf.mode === 'exclude') {
      for (const v of vals) parentExcluded.add(v);
    } else if (pf.mode === 'require') {
      const reqSet = new Set(vals);
      if (parentRequired === null) {
        parentRequired = reqSet;
      } else {
        // Intersection: only values in both sets survive
        parentRequired = new Set([...parentRequired].filter(v => reqSet.has(v)));
      }
    }
  }
  const hasParent = parentExcluded.size > 0 || parentRequired !== null;

  // Determine lock state and reason for each value based on the CHILD's mode.
  // Returns: { locked: boolean, reason: 'redundant' | 'excluded' | null }
  //
  // For Include (require): lock values that are excluded upstream (contradiction)
  //   or not in the required set upstream (also contradiction). Both = "will never apply".
  // For Exclude: lock only values already excluded upstream (redundant = "already applied").
  const getLockInfo = (value) => {
    if (!hasParent) return { locked: false, reason: null };
    const vl = value.toLowerCase();

    if (filterMode === 'require') {
      // Include mode: lock contradictions
      if (parentExcluded.has(vl)) return { locked: true, reason: 'excluded' };
      if (parentRequired !== null && !parentRequired.has(vl)) return { locked: true, reason: 'excluded' };
      return { locked: false, reason: null };
    } else {
      // Exclude mode: lock only redundancies
      if (parentExcluded.has(vl)) return { locked: true, reason: 'redundant' };
      return { locked: false, reason: null };
    }
  };

  const isLocked = (value) => getLockInfo(value).locked;

  // Checked state depends on mode, but only for available values.
  // Locked values: always unchecked.
  // Default for NEW filters (empty values): include = all checked, exclude = none checked.
  const hasExplicitValues = currentFilter?.values?.length > 0;
  const isChecked = (value) => {
    if (isLocked(value)) return false;
    if (!hasExplicitValues) {
      return filterMode === 'require';
    }
    return filterValues.has(value.toLowerCase());
  };

  const groups = filterType.groups || [];
  const hasGroups = groups.length > 0;

  // Store parent context as data attribute for mode-switch re-computation
  const parentContext = JSON.stringify({
    excluded: [...parentExcluded],
    required: parentRequired ? [...parentRequired] : null,
  });

  let html = `<div class="ws-filter-section" data-filter-type="${escapeHtml(filterType.type)}" data-source-id="${escapeHtml(sourceId)}" data-parent-context="${escapeHtml(parentContext)}">
    <div style="padding:14px 16px;">
      <h4 style="margin:0 0 4px;">${escapeHtml(filterType.label)}</h4>
      <p style="margin:0 0 12px;font-size:13px;color:#555;">${escapeHtml(filterType.description)}</p>`;

  // Mode selector (only show if more than one mode available AND not in fixed/dual mode)
  if (filterType.modes.length > 1 && !fixedMode) {
    html += `<div class="ws-filter-mode-row" style="margin-bottom:12px;">
      <label style="font-size:13px;font-weight:500;">Mode:</label>
      ${filterType.modes.map(m => `
        <label class="ws-filter-mode-label" style="margin-left:12px;">
          <input type="radio" name="ws-filter-mode-${escapeHtml(sourceId)}-${escapeHtml(filterType.type)}" value="${m}" class="ws-filter-mode-radio" ${filterMode === m ? 'checked' : ''}>
          <span>${m === 'exclude' ? 'Exclude selected' : 'Include only selected'}</span>
        </label>
      `).join('')}
    </div>`;
  }

  html += `<div class="ws-media-toolbar">
      <button type="button" class="btn-secondary btn-small ws-filter-select-all">Select All</button>
      <button type="button" class="btn-secondary btn-small ws-filter-select-none">Select None</button>
    </div>
    <div class="ws-media-categories">`;

  if (hasGroups) {
    for (const group of groups) {
      const groupValues = group.values || [];
      const lockedInGroup = groupValues.filter(v => isLocked(v));
      const availableInGroup = groupValues.filter(v => !isLocked(v));
      const checkedAvailable = availableInGroup.filter(v => isChecked(v)).length;
      const allAvailableChecked = availableInGroup.length > 0 && checkedAvailable === availableInGroup.length;
      const noneAvailableChecked = checkedAvailable === 0;
      // Only show as locked if there are actual locked items (not just an empty group)
      const allLocked = lockedInGroup.length > 0 && availableInGroup.length === 0;
      const catChecked = allAvailableChecked ? 'checked' : '';
      const catIndeterminate = (!allAvailableChecked && !noneAvailableChecked) ? 'data-indeterminate="true"' : '';
      const catDisabled = allLocked ? 'disabled' : '';

      html += `<div class="ws-media-category">
        <div class="ws-media-category-header${allLocked ? ' ws-filter-locked' : ''}">
          <label class="ws-category-label" onclick="event.stopPropagation()">
            <input type="checkbox" class="ws-category-checkbox" ${catChecked} ${catIndeterminate} ${catDisabled}>
            ${escapeHtml(group.name)}${allLocked ? ' <span class="ws-filter-locked-icon">🔒</span>' : ''}
          </label>
          <button type="button" class="ws-category-toggle-btn" title="Expand/collapse">${allLocked ? '▶' : '▼'}</button>
        </div>
        <div class="ws-media-category-items"${allLocked ? ' style="display:none"' : ''}>`;

      for (const value of groupValues) {
        const checked = isChecked(value);
        const lockInfo = getLockInfo(value);
        const lockClass = lockInfo.locked ? (lockInfo.reason === 'redundant' ? ' ws-filter-locked-redundant' : ' ws-filter-locked-excluded') : '';
        const lockTitle = lockInfo.locked ? (lockInfo.reason === 'redundant' ? 'Already applied by parent filter' : 'Excluded by parent filter') : '';
        const lockIcon = lockInfo.locked ? (lockInfo.reason === 'redundant' ? '↑' : '🚫') : '';
        html += `<label class="ws-media-item${lockClass}">
          <input type="checkbox" class="ws-filter-value-checkbox" data-value="${escapeHtml(value)}" ${checked ? 'checked' : ''} ${lockInfo.locked ? 'disabled' : ''}>
          ${escapeHtml(value)}${lockInfo.locked ? ` <span class="ws-filter-locked-icon" title="${lockTitle}">${lockIcon}</span>` : ''}
        </label>`;
      }

      html += `</div></div>`;
    }
  } else {
    // Flat list of values (no groups)
    for (const v of (filterType.values || [])) {
      const checked = isChecked(v.value);
      const lockInfo = getLockInfo(v.value);
      const lockClass = lockInfo.locked ? (lockInfo.reason === 'redundant' ? ' ws-filter-locked-redundant' : ' ws-filter-locked-excluded') : '';
      const lockTitle = lockInfo.locked ? (lockInfo.reason === 'redundant' ? 'Already applied by parent filter' : 'Excluded by parent filter') : '';
      const lockIcon = lockInfo.locked ? (lockInfo.reason === 'redundant' ? '↑' : '🚫') : '';
      html += `<label class="ws-media-item${lockClass}">
        <input type="checkbox" class="ws-filter-value-checkbox" data-value="${escapeHtml(v.value)}" ${checked ? 'checked' : ''} ${lockInfo.locked ? 'disabled' : ''}>
        ${escapeHtml(v.label || v.value)}${lockInfo.locked ? ` <span class="ws-filter-locked-icon" title="${lockTitle}">${lockIcon}</span>` : ''}
      </label>`;
    }
  }

  html += `</div></div></div>`;
  return html;
}

/**
 * Render a text-input filter section (for filter types with inputStyle: 'text').
 * Used for objectType and similar free-text filters with optional suggestions.
 */
function renderTextFilterSection(sourceId, filterType, currentFilter, parentFilters, { fixedMode = false } = {}) {
  const values = currentFilter?.values || [];
  const filterMode = currentFilter?.mode || 'require';

  // Compute aggregate parent state (same logic as checkbox section)
  const parentExcluded = new Set();
  let parentRequired = null;
  for (const pf of (parentFilters || [])) {
    const vals = (pf.values || []).map(v => v.toLowerCase());
    if (pf.mode === 'exclude') {
      for (const v of vals) parentExcluded.add(v);
    } else if (pf.mode === 'require') {
      const reqSet = new Set(vals);
      parentRequired = parentRequired === null ? reqSet : new Set([...parentRequired].filter(v => reqSet.has(v)));
    }
  }

  // Locked values: for exclude mode, only values already excluded upstream (redundant).
  // For include mode, values excluded upstream or outside required set (will never apply).
  const isLockedValue = (v) => {
    const vl = v.toLowerCase();
    if (filterMode === 'require') {
      return parentExcluded.has(vl) || (parentRequired !== null && !parentRequired.has(vl));
    } else {
      return parentExcluded.has(vl);
    }
  };
  const getLockReason = (v) => {
    const vl = v.toLowerCase();
    if (filterMode === 'exclude' && parentExcluded.has(vl)) return 'redundant';
    if (filterMode === 'require' && (parentExcluded.has(vl) || (parentRequired !== null && !parentRequired.has(vl)))) return 'excluded';
    return null;
  };

  // Collect all locked values from parent filters for display
  const allParentValues = new Set();
  for (const pf of (parentFilters || [])) {
    for (const v of (pf.values || [])) allParentValues.add(v);
  }
  const lockedValues = new Set([...allParentValues].filter(v => isLockedValue(v)).map(v => v.toLowerCase()));

  // Locked values from parent filter appear as non-removable tags with reason-specific styling
  const lockedTags = [...allParentValues].filter(v => isLockedValue(v)).map(t => {
    const reason = getLockReason(t);
    const cls = reason === 'redundant' ? 'ws-type-tag-locked-redundant' : 'ws-type-tag-locked-excluded';
    const title = reason === 'redundant' ? 'Already applied by parent filter' : 'Excluded by parent filter';
    return `<span class="ws-type-tag ws-type-tag-locked ${cls}" data-type="${escapeHtml(t)}" title="${title}">${escapeHtml(t)}</span>`;
  }).join('');
  const editableTags = values
    .filter(t => !lockedValues.has(t.toLowerCase()))
    .map(t =>
      `<span class="ws-type-tag" data-type="${escapeHtml(t)}">${escapeHtml(t)}<button type="button" class="ws-type-tag-remove" aria-label="Remove">\u00d7</button></span>`
    ).join('');
  const typeTags = lockedTags + editableTags;

  let html = `<div class="ws-filter-section ws-filter-text-section" data-filter-type="${escapeHtml(filterType.type)}" data-source-id="${escapeHtml(sourceId)}">
    <div class="ws-mapping-section">
      <h4>${escapeHtml(filterType.label)}</h4>
      <p class="pool-health-description">${escapeHtml(filterType.description)}</p>
      <div class="ws-type-tags ws-filter-text-tags">${typeTags}</div>
      <div class="ws-type-add-row">
        <input type="text" class="ws-type-input ws-filter-text-input" placeholder="e.g. ${escapeHtml((filterType.suggestions || [])[0] || 'value')}">
        <button type="button" class="btn-secondary btn-small ws-filter-text-add">Add</button>
      </div>`;

  // Show suggestions if available
  if (filterType.suggestions?.length > 0) {
    const unusedSuggestions = filterType.suggestions.filter(s => !values.some(v => v.toLowerCase() === s.toLowerCase()));
    if (unusedSuggestions.length > 0) {
      html += `<div class="ws-filter-suggestions" style="margin-top:8px;">
        <span style="font-size:12px;color:#888;">Suggestions:</span>
        ${unusedSuggestions.map(s => `<button type="button" class="ws-filter-suggestion-btn btn-secondary btn-small" style="margin:2px 4px;padding:2px 8px;font-size:12px;" data-value="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
      </div>`;
    }
  }

  html += `</div></div>`;
  return html;
}

/**
 * Read the current filter state from the settings modal DOM for a given source.
 * Returns an array of filter objects [{type, mode, values}].
 */
function readFiltersFromUI(sourceId) {
  const body = document.getElementById('web-source-settings-body');
  if (!body) return [];

  const filters = [];

  // Search filters (single-value text input, not inside .ws-filter-section)
  body.querySelectorAll(`.ws-filter-search-value[data-source-id="${CSS.escape(sourceId)}"]`).forEach(input => {
    const val = input.value.trim();
    if (val) {
      filters.push({ type: input.dataset.filterType, mode: 'require', values: [val] });
    }
  });

  body.querySelectorAll(`.ws-filter-section[data-source-id="${CSS.escape(sourceId)}"]`).forEach(section => {
    const filterType = section.dataset.filterType;
    const filterTypeDef = (webSourceFilterTypes[sourceId] || []).find(ft => ft.type === filterType);
    if (!filterTypeDef) return;

    // Read mode from the parent entry's data-filter-mode (authoritative in dual-mode),
    // falling back to radio button selection, then filter type default.
    const parentEntry = section.closest('.ws-filter-entry');
    const entryMode = parentEntry?.dataset?.filterMode;
    const modeRadio = section.querySelector('.ws-filter-mode-radio:checked');

    if (filterTypeDef.inputStyle === 'text') {
      // Text filter: collect tag values (skip locked tags from higher cascade levels)
      const values = [];
      section.querySelectorAll('.ws-type-tag:not(.ws-type-tag-locked)').forEach(tag => values.push(tag.dataset.type));
      if (values.length > 0) {
        filters.push({ type: filterType, mode: entryMode || 'exclude', values });
      }
    } else {
      // Checkbox filter: collect based on mode (skip disabled/locked checkboxes)
      const mode = entryMode || modeRadio?.value || filterTypeDef.modes[0] || 'require';
      const allValues = [];
      const checkedValues = [];
      section.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)').forEach(cb => {
        allValues.push(cb.dataset.value);
        if (cb.checked) checkedValues.push(cb.dataset.value);
      });

      // Both modes: checked values = the list. Include: checked = included. Exclude: checked = excluded.
      if (mode === 'exclude') {
        if (checkedValues.length > 0) {
          filters.push({ type: filterType, mode: 'exclude', values: checkedValues });
        }
      } else {
        if (checkedValues.length > 0 && checkedValues.length < allValues.length) {
          filters.push({ type: filterType, mode: 'require', values: checkedValues });
        }
      }
    }
  });

  return filters;
}

/**
 * Attach event handlers for generic filter sections after rendering.
 * Called by initWebSourceSettingsInteractions.
 */
function initFilterSectionInteractions(body) {
  // Expand/collapse category items
  body.querySelectorAll('.ws-filter-section .ws-media-category-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.type === 'checkbox') return;
      const category = header.closest('.ws-media-category');
      const items = category.querySelector('.ws-media-category-items');
      const btn = header.querySelector('.ws-category-toggle-btn');
      const expanded = items.style.display !== 'none';
      items.style.display = expanded ? 'none' : '';
      btn.textContent = expanded ? '\u25b6' : '\u25bc';
    });
  });

  // Category checkbox → check/uncheck all available (non-disabled) in that category
  body.querySelectorAll('.ws-filter-section .ws-category-checkbox').forEach(catCb => {
    catCb.addEventListener('change', () => {
      const category = catCb.closest('.ws-media-category');
      category.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)').forEach(cb => {
        cb.checked = catCb.checked;
      });
      catCb.indeterminate = false;
    });
  });

  // Individual checkbox → update category checkbox state
  body.querySelectorAll('.ws-filter-section .ws-filter-value-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const category = cb.closest('.ws-media-category');
      if (!category) return;
      const catCb = category.querySelector('.ws-category-checkbox');
      if (!catCb) return;
      const all = Array.from(category.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)'));
      const checkedCount = all.filter(c => c.checked).length;
      if (all.length === 0 || checkedCount === 0) {
        catCb.checked = false; catCb.indeterminate = false;
      } else if (checkedCount === all.length) {
        catCb.checked = true; catCb.indeterminate = false;
      } else {
        catCb.checked = false; catCb.indeterminate = true;
      }
    });
  });

  // Select All / Select None per filter section
  body.querySelectorAll('.ws-filter-section .ws-filter-select-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.ws-filter-section');
      section.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)').forEach(cb => { cb.checked = true; });
      section.querySelectorAll('.ws-category-checkbox:not(:disabled)').forEach(cb => { cb.checked = true; cb.indeterminate = false; });
    });
  });
  body.querySelectorAll('.ws-filter-section .ws-filter-select-none').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.ws-filter-section');
      section.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)').forEach(cb => { cb.checked = false; });
      section.querySelectorAll('.ws-category-checkbox:not(:disabled)').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
    });
  });

  // Text filter: add/remove tags
  body.querySelectorAll('.ws-filter-section .ws-filter-text-add').forEach(addBtn => {
    addBtn.addEventListener('click', () => {
      const section = addBtn.closest('.ws-filter-section');
      const input = section.querySelector('.ws-filter-text-input');
      addFilterTextTag(section, input.value);
      input.value = '';
      input.focus();
    });
  });

  body.querySelectorAll('.ws-filter-section .ws-filter-text-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const section = input.closest('.ws-filter-section');
        addFilterTextTag(section, input.value);
        input.value = '';
      }
    });
  });

  body.querySelectorAll('.ws-filter-section .ws-type-tag-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.ws-type-tag').remove());
  });

  // Suggestion buttons
  body.querySelectorAll('.ws-filter-section .ws-filter-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.ws-filter-section');
      addFilterTextTag(section, btn.dataset.value);
      btn.remove();
    });
  });

  // Mode radio changes: flip checkbox semantics and re-compute locks
  body.querySelectorAll('.ws-filter-section .ws-filter-mode-radio').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const section = radio.closest('.ws-filter-section');
      const newMode = radio.value;

      // Re-compute lock state based on parent context and new mode
      const parentContextStr = section.dataset.parentContext;
      let parentExcluded = new Set();
      let parentRequired = null;
      if (parentContextStr) {
        try {
          const ctx = JSON.parse(parentContextStr);
          parentExcluded = new Set((ctx.excluded || []).map(v => v.toLowerCase()));
          parentRequired = ctx.required ? new Set(ctx.required.map(v => v.toLowerCase())) : null;
        } catch (e) { /* ignore parse errors */ }
      }

      const shouldLock = (value) => {
        const vl = value.toLowerCase();
        if (newMode === 'require') {
          return parentExcluded.has(vl) || (parentRequired !== null && !parentRequired.has(vl));
        } else {
          return parentExcluded.has(vl);
        }
      };
      const getLockReason = (value) => {
        const vl = value.toLowerCase();
        if (newMode === 'exclude' && parentExcluded.has(vl)) return 'redundant';
        if (newMode === 'require' && (parentExcluded.has(vl) || (parentRequired !== null && !parentRequired.has(vl)))) return 'excluded';
        return null;
      };

      // Update each checkbox: invert available ones, update lock state for all
      section.querySelectorAll('.ws-filter-value-checkbox').forEach(cb => {
        const value = cb.dataset.value;
        const wasLocked = cb.disabled;
        const nowLocked = shouldLock(value);
        const label = cb.closest('label');

        if (nowLocked !== wasLocked) {
          // Lock state changed
          cb.disabled = nowLocked;
          if (nowLocked) {
            cb.checked = false;
          }
        } else if (!nowLocked) {
          // Same unlock state — invert checkbox
          cb.checked = !cb.checked;
        }

        // Update label styling
        if (label) {
          label.classList.remove('ws-filter-locked-redundant', 'ws-filter-locked-excluded');
          const existingIcon = label.querySelector('.ws-filter-locked-icon');
          if (existingIcon) existingIcon.remove();
          if (nowLocked) {
            const reason = getLockReason(value);
            label.classList.add(reason === 'redundant' ? 'ws-filter-locked-redundant' : 'ws-filter-locked-excluded');
            const icon = reason === 'redundant' ? '↑' : '🚫';
            const title = reason === 'redundant' ? 'Already applied by parent filter' : 'Excluded by parent filter';
            const span = document.createElement('span');
            span.className = 'ws-filter-locked-icon';
            span.title = title;
            span.textContent = icon;
            label.appendChild(span);
          }
        }
      });

      // Update category checkboxes
      section.querySelectorAll('.ws-media-category').forEach(cat => {
        const catCb = cat.querySelector('.ws-category-checkbox');
        if (!catCb) return;
        const header = cat.querySelector('.ws-media-category-header');
        const all = Array.from(cat.querySelectorAll('.ws-filter-value-checkbox'));
        const available = all.filter(c => !c.disabled);
        const allLocked = available.length === 0;

        catCb.disabled = allLocked;
        header?.classList.remove('ws-filter-locked');
        // Update category header lock icon
        const headerLabel = header?.querySelector('.ws-category-label');
        const existingCatIcon = headerLabel?.querySelector('.ws-filter-locked-icon');
        if (allLocked && !existingCatIcon && headerLabel) {
          const span = document.createElement('span');
          span.className = 'ws-filter-locked-icon';
          span.textContent = '🔒';
          headerLabel.appendChild(span);
        } else if (!allLocked && existingCatIcon) {
          existingCatIcon.remove();
        }
        if (allLocked) header?.classList.add('ws-filter-locked');

        // Auto-collapse fully locked categories, expand unlocked ones
        const items = cat.querySelector('.ws-media-category-items');
        const toggleBtn = cat.querySelector('.ws-category-toggle-btn');
        if (items && toggleBtn) {
          if (allLocked) {
            items.style.display = 'none';
            toggleBtn.textContent = '\u25b6';
          } else if (items.style.display === 'none') {
            items.style.display = '';
            toggleBtn.textContent = '\u25bc';
          }
        }

        if (!allLocked) {
          const checkedCount = available.filter(c => c.checked).length;
          if (checkedCount === 0) { catCb.checked = false; catCb.indeterminate = false; }
          else if (checkedCount === available.length) { catCb.checked = true; catCb.indeterminate = false; }
          else { catCb.checked = false; catCb.indeterminate = true; }
        }
      });
    });
  });
}

/**
 * Add a text tag to a text-input filter section.
 */
function addFilterTextTag(section, value) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return;
  const list = section.querySelector('.ws-filter-text-tags');
  if (!list) return;
  if (list.querySelector(`.ws-type-tag[data-type="${CSS.escape(trimmed)}"]`)) return;
  const span = document.createElement('span');
  span.className = 'ws-type-tag';
  span.dataset.type = trimmed;
  span.innerHTML = `${escapeHtml(trimmed)}<button type="button" class="ws-type-tag-remove" aria-label="Remove">\u00d7</button>`;
  span.querySelector('.ws-type-tag-remove').addEventListener('click', () => span.remove());
  list.appendChild(span);
}

/**
 * Attach event handlers for the unified filter list component (add/remove/core-value).
 * @param {HTMLElement} container - The container element holding the filter list
 * @param {object} callbacks - { onAdd(filterType), onRemove(filterType), onCoreValueChange(filterType, value) }
 */
/**
 * Re-render the filter list inside the source settings modal and re-init interactions.
 */
function reRenderSourceFilters(sourceId, currentFilters, expandedTypes) {
  const body = document.getElementById('web-source-settings-body');
  const filterListEl = body?.querySelector('.ws-filter-list');
  if (!filterListEl) return;
  const html = renderSourceFilters(sourceId, currentFilters, undefined, expandedTypes);
  filterListEl.outerHTML = html;
  // Re-init interactions on the new DOM
  initFilterSectionInteractions(body);
  body.querySelectorAll('.ws-category-checkbox[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });
  initFilterListInteractions(body, {
    onAdd: (filterType, filterMode) => {
      const filters = readFiltersFromUI(sourceId);
      const mode = filterMode || 'require';
      filters.push({ type: filterType, mode, values: [] });
      reRenderSourceFilters(sourceId, filters, new Set([`${filterType}:${mode}`]));
    },
    onRemove: (filterType, filterMode) => {
      const filters = readFiltersFromUI(sourceId).filter(f => !(f.type === filterType && (!filterMode || f.mode === filterMode)));
      reRenderSourceFilters(sourceId, filters);
    },
  });
}

function initFilterListInteractions(container, callbacks = {}) {
  // Add filter button + type picker
  container.querySelectorAll('.ws-filter-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.ws-filter-add-row');
      const options = row.querySelector('.ws-filter-add-options');
      // If only one option, add it directly
      const optionBtns = options.querySelectorAll('.ws-filter-add-option');
      if (optionBtns.length === 1) {
        callbacks.onAdd?.(optionBtns[0].dataset.filterType, optionBtns[0].dataset.filterMode);
        return;
      }
      // Toggle options visibility
      const isVisible = options.style.display !== 'none';
      options.style.display = isVisible ? 'none' : '';
    });
  });

  container.querySelectorAll('.ws-filter-add-option').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.onAdd?.(btn.dataset.filterType, btn.dataset.filterMode);
    });
  });

  // Close options on outside click
  const closeHandler = (e) => {
    container.querySelectorAll('.ws-filter-add-options').forEach(opts => {
      if (!opts.contains(e.target) && !opts.previousElementSibling?.contains(e.target)) {
        opts.style.display = 'none';
      }
    });
  };
  document.addEventListener('click', closeHandler);
  // Store handler for cleanup if needed
  container._filterListCloseHandler = closeHandler;

  // Remove filter button
  container.querySelectorAll('.ws-filter-entry-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      callbacks.onRemove?.(btn.dataset.filterType, btn.dataset.filterMode);
    });
  });

  // Core filter value change (simple select, e.g. orientation)
  container.querySelectorAll('.ws-filter-core-value').forEach(select => {
    select.addEventListener('change', () => {
      callbacks.onCoreValueChange?.(select.dataset.filterType, select.value);
    });
  });

  // Collapsible filter entries — toggle on header click
  container.querySelectorAll('.ws-filter-entry:not(.ws-filter-entry-locked) .ws-filter-entry-header').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle when clicking remove button
      if (e.target.closest('.ws-filter-entry-remove')) return;
      const entry = header.closest('.ws-filter-entry');
      const isCollapsed = entry.dataset.collapsed === 'true';
      entry.dataset.collapsed = isCollapsed ? 'false' : 'true';
    });
  });

  // Update search filter summary as user types
  container.querySelectorAll('.ws-filter-search-value').forEach(input => {
    input.addEventListener('input', () => {
      const entry = input.closest('.ws-filter-entry');
      const summary = entry?.querySelector('.ws-filter-entry-summary');
      if (summary) {
        const val = input.value.trim();
        summary.textContent = val ? `"${val}"` : 'no query';
      }
    });
  });
}

/**
 * Render non-filter settings for a source: schema-driven boolean toggles
 * plus any source-specific action buttons (e.g. cookie clear).
 */
function renderSourceExtraSettings(sourceId) {
  let html = '';

  // Schema-driven boolean toggles (generic for any source with a settingsSchema)
  const schema = webSourceSettingsSchemas[sourceId];
  if (schema?.fields?.length) {
    const currentSettings = webSourcesConfig?.sources?.[sourceId]?.settings || {};
    for (const field of schema.fields) {
      if (field.type !== 'boolean') continue;
      // Check whether the required source module is installed (present in sourceMetadata),
      // not whether it's enabled as an active web source.
      const requiredSourceAvailable = !field.requiresSource
        || !!webSourceMetadata[field.requiresSource];
      const currentVal = currentSettings?.[field.key] ?? field.default ?? false;
      const disabledAttr = requiredSourceAvailable ? '' : 'disabled';
      const disabledNote = requiredSourceAvailable ? '' :
        ` <em>(requires the ${field.requiresSource} source module to be installed)</em>`;
      html += `
        <div style="margin-bottom:12px;padding:0 16px;">
          <label class="ws-global-label" style="${requiredSourceAvailable ? '' : 'opacity:0.5;'}">
            <input type="checkbox"
                   class="ws-boolean-setting"
                   data-setting-key="${escapeHtml(field.key)}"
                   ${currentVal ? 'checked' : ''}
                   ${disabledAttr}>
            ${escapeHtml(field.label)}
          </label>
          <p class="pool-health-description">${escapeHtml(field.description)}${disabledNote}</p>
        </div>`;
    }
  }

  // Cookie management (generic — shown for any source that exports clearCookies)
  if (webSourceCapabilities[sourceId]?.hasCookies) {
    html += `<div class="ws-mapping-section">
      <h4>Session Cookies</h4>
      <p class="pool-health-description">This source uses session cookies to reduce rate limiting. Cookies are seeded automatically on the first fetch. If fetches are failing with 429 errors, clearing the cookie jar forces a fresh session.</p>
      <button type="button" class="btn-secondary btn-small ws-clear-cookies-btn" data-source-id="${escapeHtml(sourceId)}">Clear Cookie Jar</button>
    </div>`;
  }

  return html;
}

/**
 * Returns the HTML string for a source's metadata mapping section within
 * the settings modal. Called by openWebSourceSettings for sources that have fields.
 */
function renderSourceMappingSection(sourceId, fields) {
  const attributes = allAttributes || [];
  const entityTypes = (allEntityTypes || []).filter(et => et.attributes?.length > 0);

  if (attributes.length === 0 && entityTypes.length === 0) {
    return `<div class="ws-mapping-section">
      <h4>Metadata Mapping</h4>
      <p class="empty-state">No custom attributes defined. Add them in the Custom Data tab to enable metadata mapping.</p>
    </div>`;
  }

  let html = `<div class="ws-mapping-section">`;
  html += `<h4>Metadata Mapping</h4>`;
  html += `<p class="pool-health-description">Map metadata fields to image attributes. Fields marked <strong>auto</strong> are auto-detected from your attribute names.</p>`;
  html += `<table class="tv-assignments-table"><thead><tr><th>Metadata Field</th><th>Maps To</th></tr></thead><tbody>`;

  for (const field of fields) {
    const currentValue = effectiveMappingTarget(sourceId, field.key);
    const isAutoGuessed = !(field.key in (webSourcesConfig?.sources?.[sourceId]?.userMapping || {}));
    html += `
      <tr>
        <td>
          <strong>${escapeHtml(field.label)}</strong>
          ${isAutoGuessed && currentValue ? '<span class="ws-mapping-auto-badge">auto</span>' : ''}
          <div style="font-size:12px;color:#666;">${escapeHtml(field.description)}</div>
        </td>
        <td>
          <select class="web-source-mapping-select"
                  data-source-id="${escapeHtml(sourceId)}"
                  data-field-key="${escapeHtml(field.key)}">
            ${buildMappingOptionsHtml(currentValue)}
          </select>
        </td>
      </tr>`;
  }

  html += `</tbody></table>`;
  html += `<div style="margin-top:8px;">
    <button type="button" class="btn-secondary btn-small ws-reset-mapping-btn" data-source-id="${escapeHtml(sourceId)}">Reset to Auto-detected</button>
  </div>`;
  html += `</div>`;
  return html;
}

function openWebSourceSettings(sourceId) {
  const filterTypes = webSourceFilterTypes[sourceId] || [];
  const fields = webSourceMetadata[sourceId]?.fields || [];
  const hasExtraSettings = !!webSourceSettingsSchemas[sourceId] || webSourceCapabilities[sourceId]?.hasCookies;

  if (filterTypes.length === 0 && fields.length === 0 && !hasExtraSettings) return;

  const source = webSourcesConfig?.sources?.[sourceId] || {};

  document.getElementById('web-source-settings-title').textContent =
    `${source.name || sourceId} — Settings`;
  const body = document.getElementById('web-source-settings-body');

  let html = '';
  // Filters section
  html += '<div class="ws-filters-section">';
  html += '<label class="ws-section-label">Filters</label>';
  html += '<p class="pool-health-description">Narrow which artwork this source can return. Inherited global filters are shown locked.</p>';
  html += renderSourceFilters(sourceId);
  html += '</div>';
  // Source-specific non-filter settings (cookie clear, boolean toggles)
  html += renderSourceExtraSettings(sourceId);
  // Metadata mapping
  if (fields.length > 0) {
    html += renderSourceMappingSection(sourceId, fields);
  }
  body.innerHTML = html;

  // Apply indeterminate state (can't be set via HTML attribute)
  body.querySelectorAll('.ws-category-checkbox[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });

  webSourceSettingsSourceId = sourceId;

  // Attach expand/collapse and checkbox cascade logic
  initWebSourceSettingsInteractions();

  // Attach add/remove filter interactions
  initFilterListInteractions(body, {
    onAdd: (filterType, filterMode) => {
      // Add a new empty filter of this type and re-render (expanded)
      const currentFilters = readFiltersFromUI(sourceId);
      const mode = filterMode || 'require';
      currentFilters.push({ type: filterType, mode, values: [] });
      reRenderSourceFilters(sourceId, currentFilters, new Set([`${filterType}:${mode}`]));
    },
    onRemove: (filterType, filterMode) => {
      const currentFilters = readFiltersFromUI(sourceId).filter(f => !(f.type === filterType && (!filterMode || f.mode === filterMode)));
      reRenderSourceFilters(sourceId, currentFilters);
    },
  });

  // Bind reset mapping button
  body.querySelector('.ws-reset-mapping-btn')
    ?.addEventListener('click', () => resetSourceMapping(sourceId));

  document.getElementById('web-source-settings-modal').classList.add('active');
}

function closeWebSourceSettings() {
  document.getElementById('web-source-settings-modal').classList.remove('active');
  webSourceSettingsSourceId = null;
}

async function saveWebSourceSettings() {
  const sourceId = webSourceSettingsSourceId;
  if (!sourceId) return;

  const saveBtn = document.getElementById('web-source-settings-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    // Save filters via the generic filter endpoint
    const filterTypes = webSourceFilterTypes[sourceId] || [];
    if (filterTypes.length > 0) {
      const filters = readFiltersFromUI(sourceId);
      const response = await fetch(`${API_BASE}/web-sources/sources/${encodeURIComponent(sourceId)}/filters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to save filters');
      if (webSourcesConfig?.sources?.[sourceId]) {
        webSourcesConfig.sources[sourceId].filters = filters;
      }
    }

    // Save non-filter settings if applicable (e.g. boolean toggles)
    const nonFilterSettings = readNonFilterSettingsFromUI(sourceId);
    if (nonFilterSettings !== null) {
      const response = await fetch(`${API_BASE}/web-sources/sources/${encodeURIComponent(sourceId)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: nonFilterSettings }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to save settings');
      if (webSourcesConfig?.sources?.[sourceId]) {
        webSourcesConfig.sources[sourceId].settings = nonFilterSettings;
      }
    }

    // Save metadata mapping if applicable
    const fields = webSourceMetadata[sourceId]?.fields || [];
    if (fields.length > 0) {
      const meta = webSourceMetadata[sourceId] || {};
      const selects = document.querySelectorAll(
        `#web-source-settings-body .web-source-mapping-select[data-source-id="${CSS.escape(sourceId)}"]`
      );
      const userMapping = {};
      selects.forEach(sel => {
        const fieldKey = sel.dataset.fieldKey;
        const val = sel.value;
        const hint = meta.defaultMapping?.[fieldKey];
        const autoVal = autoGuessMappingTarget(hint);
        if (val !== autoVal) {
          userMapping[fieldKey] = deserializeMappingTarget(val);
        }
      });
      const response = await fetch(`${API_BASE}/web-sources/sources/${encodeURIComponent(sourceId)}/metadata-mapping`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMapping }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Failed to save mapping');
      if (webSourcesConfig?.sources?.[sourceId]) {
        webSourcesConfig.sources[sourceId].userMapping = data.userMapping;
      }
    }

    // Re-fetch config so sourceMetadata reflects any settings-dependent field changes
    // (e.g. google_art_wallpaper's fetchRichMetadata toggling the rich field list).
    const configResp = await fetch(`${API_BASE}/web-sources/config`);
    const configData = await configResp.json();
    if (configData.success) {
      webSourcesConfig = configData.webSources;
      webSourceFilterTypes = configData.filterTypes || {};
      webSourceMetadata = configData.sourceMetadata || {};
      // Re-render the open settings panel with the updated field list.
      openWebSourceSettings(sourceId);
    } else {
      closeWebSourceSettings();
    }
    showToast('Settings saved');
  } catch (error) {
    console.error('Error saving web source settings:', error);
    showToast(`Error: ${error.message}`, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Settings'; }
  }
}

/**
 * Read non-filter settings from the UI (boolean toggles driven by settingsSchema).
 * Returns settings object or null if no non-filter settings exist for this source.
 */
function readNonFilterSettingsFromUI(sourceId) {
  const schema = webSourceSettingsSchemas[sourceId];
  if (!schema?.fields?.length) return null;

  const settings = {};
  const boolFields = schema.fields.filter(f => f.type === 'boolean');
  if (boolFields.length === 0) return null;

  document.querySelectorAll('#web-source-settings-body .ws-boolean-setting').forEach(cb => {
    settings[cb.dataset.settingKey] = cb.checked;
  });
  return settings;
}

/**
 * Attach expand/collapse toggles and checkbox cascade behavior after rendering
 * the settings modal body.
 */
function initWebSourceSettingsInteractions() {
  const body = document.getElementById('web-source-settings-body');

  // Generic filter section interactions (checkboxes, text tags, mode toggles)
  initFilterSectionInteractions(body);

  // Cookie clear button (any source with hasCookies capability)
  body.querySelector('.ws-clear-cookies-btn')?.addEventListener('click', async function () {
    const sourceId = this.dataset.sourceId;
    this.disabled = true;
    this.textContent = 'Clearing…';
    try {
      const response = await fetch(`${API_BASE}/web-sources/sources/${encodeURIComponent(sourceId)}/clear-cookies`, {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        showToast('Cookie jar cleared — will re-seed on next fetch');
      } else {
        throw new Error(data.error || 'Failed to clear cookies');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      this.disabled = false;
      this.textContent = 'Clear Cookie Jar';
    }
  });
}

// Legacy source-specific renderers removed — now using generic renderSourceFilters().

// Wire up the settings modal close/save buttons (called once at startup)
function initWebSourceSettingsModal() {
  document.getElementById('web-source-settings-close')?.addEventListener('click', closeWebSourceSettings);
  document.getElementById('web-source-settings-cancel')?.addEventListener('click', closeWebSourceSettings);
  document.getElementById('web-source-settings-save')?.addEventListener('click', saveWebSourceSettings);
  document.getElementById('web-source-settings-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeWebSourceSettings();
  });
}

// ── Per-source metadata mapping ────────────���─────────────────────────────────

/**
 * Serialize a mapping target (null | string | {entity,attribute}) to a select option value.
 * Uses prefixes: "attr:<name>" for plain attributes, "entity:<id>:<attr>" for entity refs.
 */
function serializeMappingTarget(target) {
  if (!target) return '';
  if (typeof target === 'string') return `attr:${target}`;
  if (target.entity && target.attribute) return `entity:${target.entity}:${target.attribute}`;
  return '';
}

/**
 * Deserialize a select option value back to a mapping target.
 */
function deserializeMappingTarget(val) {
  if (!val) return null;
  if (val.startsWith('attr:')) return val.slice(5);
  if (val.startsWith('entity:')) {
    const parts = val.split(':');
    return { entity: parts[1], attribute: parts.slice(2).join(':') };
  }
  return null;
}

/**
 * Auto-guess the serialized target for a mapping hint string.
 * Looks for an HA attribute whose name matches the hint (case-insensitive),
 * then falls back to looking in entity type attributes.
 * Returns a serialized value ("attr:<name>", "entity:<id>:<attr>") or '' if no match.
 */
function autoGuessMappingTarget(hint) {
  if (!hint) return '';
  const hintLower = hint.toLowerCase();
  const attrMatch = (allAttributes || []).find(a => a.toLowerCase() === hintLower);
  if (attrMatch) return `attr:${attrMatch}`;
  for (const et of (allEntityTypes || []).filter(e => e.attributes?.length > 0)) {
    const eaMatch = (et.attributes || []).find(a => a.toLowerCase() === hintLower);
    if (eaMatch) return `entity:${et.id}:${eaMatch}`;
  }
  return '';
}

/**
 * Get the effective serialized target for a field:
 * - If the user has an explicit override in userMapping, use that.
 * - Otherwise auto-guess from the source's defaultMapping hint.
 */
function effectiveMappingTarget(sourceId, fieldKey) {
  const userMapping = webSourcesConfig?.sources?.[sourceId]?.userMapping || {};
  if (fieldKey in userMapping) return serializeMappingTarget(userMapping[fieldKey]);
  const hint = webSourceMetadata[sourceId]?.defaultMapping?.[fieldKey];
  return autoGuessMappingTarget(hint);
}

/**
 * Build the options HTML for a mapping select dropdown.
 * currentValue is a serialized target string.
 */
function buildMappingOptionsHtml(currentValue) {
  const attributes = allAttributes || [];
  const entityTypes = (allEntityTypes || []).filter(et => et.attributes?.length > 0);

  let html = `<option value="">— Not mapped —</option>`;
  if (attributes.length > 0) {
    html += `<optgroup label="Attributes">` +
      attributes.map(attr => {
        const val = `attr:${attr}`;
        return `<option value="${escapeHtml(val)}" ${currentValue === val ? 'selected' : ''}>${escapeHtml(attr)}</option>`;
      }).join('') +
      `</optgroup>`;
  }
  for (const et of entityTypes) {
    html += `<optgroup label="${escapeHtml(et.name)}">` +
      et.attributes.map(attr => {
        const val = `entity:${et.id}:${attr}`;
        return `<option value="${escapeHtml(val)}" ${currentValue === val ? 'selected' : ''}>${escapeHtml(attr)}</option>`;
      }).join('') +
      `</optgroup>`;
  }
  return html;
}

async function resetSourceMapping(sourceId) {
  try {
    const response = await fetch(`${API_BASE}/web-sources/sources/${encodeURIComponent(sourceId)}/metadata-mapping`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (data.success) {
      if (webSourcesConfig?.sources?.[sourceId]) {
        delete webSourcesConfig.sources[sourceId].userMapping;
      }
      // Re-render the mapping section within the modal
      const fields = webSourceMetadata[sourceId]?.fields || [];
      const existing = document.querySelector('#web-source-settings-body .ws-mapping-section');
      if (existing) {
        existing.outerHTML = renderSourceMappingSection(sourceId, fields);
        document.querySelector('#web-source-settings-body .ws-reset-mapping-btn')
          ?.addEventListener('click', () => resetSourceMapping(sourceId));
      }
      const sourceName = webSourcesConfig?.sources?.[sourceId]?.name || sourceId;
      showToast(`Mapping reset to auto-detected for ${sourceName}`);
    } else {
      throw new Error(data.error || 'Failed to reset');
    }
  } catch (error) {
    console.error('Error resetting metadata mapping:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

// ── Virtual Tags ──────────────────────────────────────────────────────────────

let virtualTagEditingId = null; // null = creating, string = editing existing tag

function renderVirtualTagsList() {
  const container = document.getElementById('ws-virtual-tags-list');
  if (!container) return;

  const virtualTags = webSourcesConfig?.virtualTags || {};
  const tagEntries = Object.entries(virtualTags);

  if (tagEntries.length === 0) {
    container.innerHTML = '<p class="empty-state">No virtual tags defined yet.</p>';
  } else {
    let html = '<div class="ws-virtual-tags-cards">';
    for (const [id, tag] of tagEntries) {
      const sourceName = webSourcesConfig?.sources?.[tag.sourceId]?.name || tag.sourceId;
      const filterSummary = summarizeFilters(tag.filters || []);
      html += `
        <div class="ws-virtual-tag-card" data-tag-id="${escapeHtml(id)}">
          <div class="ws-virtual-tag-info">
            <strong>${escapeHtml(tag.label)}</strong>
            <span class="ws-virtual-tag-id">ws:${escapeHtml(id)}</span>
            <span class="web-source-description">${escapeHtml(sourceName)}${filterSummary ? ' — ' + escapeHtml(filterSummary) : ''}</span>
          </div>
          <div class="ws-virtual-tag-actions">
            <button type="button" class="btn-secondary btn-small ws-virtual-tag-edit" data-tag-id="${escapeHtml(id)}">Edit</button>
            <button type="button" class="btn-secondary btn-small ws-virtual-tag-delete" data-tag-id="${escapeHtml(id)}">Delete</button>
          </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // Bind add button
  document.getElementById('ws-add-virtual-tag-btn')?.addEventListener('click', () => openVirtualTagModal(null));

  // Bind edit/delete buttons
  container.querySelectorAll('.ws-virtual-tag-edit').forEach(btn => {
    btn.addEventListener('click', () => openVirtualTagModal(btn.dataset.tagId));
  });
  container.querySelectorAll('.ws-virtual-tag-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteVirtualTag(btn.dataset.tagId));
  });
}

function summarizeFilters(filters) {
  if (!filters || filters.length === 0) return '';
  return filters.map(f => {
    const modeLabel = f.mode === 'require' ? 'only' : 'excl.';
    const vals = f.values.length <= 3
      ? f.values.join(', ')
      : `${f.values.slice(0, 2).join(', ')} +${f.values.length - 2}`;
    return `${f.type}: ${modeLabel} ${vals}`;
  }).join('; ');
}

function openVirtualTagModal(tagId) {
  virtualTagEditingId = tagId;
  const isEdit = !!tagId;
  const tag = isEdit ? (webSourcesConfig?.virtualTags?.[tagId] || {}) : {};

  document.getElementById('ws-virtual-tag-modal-title').textContent =
    isEdit ? 'Edit Virtual Tag' : 'New Virtual Tag';

  const sources = webSourcesConfig?.sources || {};
  const sourceOptions = Object.entries(sources).map(([id, s]) =>
    `<option value="${escapeHtml(id)}" ${tag.sourceId === id ? 'selected' : ''}>${escapeHtml(s.name || id)}</option>`
  ).join('');

  const body = document.getElementById('ws-virtual-tag-modal-body');
  body.innerHTML = `
    <div style="padding:14px 16px;">
      <div class="form-group-compact" style="margin-bottom:14px;">
        <label class="ws-global-label">Label</label>
        <input type="text" id="ws-vt-label" class="ws-type-input" style="width:100%;" placeholder="e.g. Impressionist Paintings" value="${escapeHtml(tag.label || '')}">
      </div>
      <div class="form-group-compact" style="margin-bottom:14px;">
        <label class="ws-global-label">ID <span style="font-weight:normal;color:#888;">(used as tag name: ws:&lt;id&gt;)</span></label>
        <input type="text" id="ws-vt-id" class="ws-type-input" style="width:100%;" placeholder="e.g. impressionist-paintings" value="${escapeHtml(tagId || '')}" ${isEdit ? 'disabled' : ''}>
        <p class="pool-health-description" style="margin-top:4px;">Lowercase letters, numbers, hyphens, and underscores only.</p>
      </div>
      <div class="form-group-compact" style="margin-bottom:14px;">
        <label class="ws-global-label">Source</label>
        <select id="ws-vt-source" class="ws-select" style="width:100%;">
          <option value="">— Select a source —</option>
          ${sourceOptions}
        </select>
      </div>
      <div class="ws-filters-section">
        <label class="ws-section-label">Filters</label>
        <p class="pool-health-description">Narrow results for this virtual tag. Inherited global and source filters are shown locked.</p>
        <div id="ws-vt-filters-container">
          ${tag.sourceId ? renderVirtualTagFilters(tag.sourceId, tag.filters || []) : '<p class="pool-health-description" style="font-style:italic;">Select a source to configure filters.</p>'}
        </div>
      </div>
    </div>`;

  // Auto-generate ID from label (only on create)
  if (!isEdit) {
    const labelInput = body.querySelector('#ws-vt-label');
    const idInput = body.querySelector('#ws-vt-id');
    labelInput.addEventListener('input', () => {
      idInput.value = labelInput.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    });
  }

  // Source change re-renders filters
  body.querySelector('#ws-vt-source').addEventListener('change', (e) => {
    const sourceId = e.target.value;
    const filtersContainer = document.getElementById('ws-vt-filters-container');
    if (sourceId) {
      initVirtualTagFilterList(filtersContainer, sourceId, []);
    } else {
      filtersContainer.innerHTML = '<p class="pool-health-description">Select a source to configure filters.</p>';
    }
  });

  // Init filter interactions for pre-rendered filters
  const filtersContainer = document.getElementById('ws-vt-filters-container');
  if (tag.sourceId) {
    initVirtualTagFilterList(filtersContainer, tag.sourceId, tag.filters || [], true);
  }

  document.getElementById('ws-virtual-tag-modal').classList.add('active');
}

/**
 * Render filter sections for a virtual tag.
 * Similar to renderSourceFilters but uses a different data-source-id prefix
 * and defaults all checkboxes to unchecked (require mode) for new virtual tags.
 */
/**
 * Render and init a virtual tag filter list inside the given container.
 * @param {boolean} [skipRender] - If true, skip innerHTML (already rendered), just init interactions.
 */
function initVirtualTagFilterList(container, sourceId, currentFilters, skipRender = false, expandedTypes = null) {
  if (!skipRender) {
    container.innerHTML = renderVirtualTagFilters(sourceId, currentFilters, expandedTypes);
  }
  initFilterSectionInteractions(container);
  container.querySelectorAll('.ws-category-checkbox[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });
  initFilterListInteractions(container, {
    onAdd: (filterType, filterMode) => {
      const filters = readVirtualTagFiltersFromUI();
      const mode = filterMode || 'require';
      filters.push({ type: filterType, mode, values: [] });
      initVirtualTagFilterList(container, sourceId, filters, false, new Set([`${filterType}:${mode}`]));
    },
    onRemove: (filterType, filterMode) => {
      const filters = readVirtualTagFiltersFromUI().filter(f => !(f.type === filterType && (!filterMode || f.mode === filterMode)));
      initVirtualTagFilterList(container, sourceId, filters);
    },
  });
}

function renderVirtualTagFilters(sourceId, currentFilters, expandedTypes) {
  const sourceFilterTypes = webSourceFilterTypes[sourceId] || [];
  const coreTypes = webSourceCoreFilterTypes || [];
  const allFilterTypes = [...coreTypes, ...sourceFilterTypes];
  // Both global and source-level filters are locked (inherited).
  const globalFilters = webSourcesConfig?.globalFilters || [];
  const sourceFilters = webSourcesConfig?.sources?.[sourceId]?.filters || [];
  const lockedFilters = [...globalFilters, ...sourceFilters];

  return renderFilterList({
    containerId: `ws-vt-filters-${sourceId}`,
    availableFilterTypes: allFilterTypes,
    currentFilters,
    lockedFilters,
    sourceId,
    expandedTypes,
  });
}

function readVirtualTagFiltersFromUI() {
  const container = document.getElementById('ws-vt-filters-container');
  if (!container) return [];
  const sourceId = document.getElementById('ws-vt-source')?.value;
  if (!sourceId) return [];

  const filters = [];

  // Search filters
  container.querySelectorAll(`.ws-filter-search-value[data-source-id="${CSS.escape(sourceId)}"]`).forEach(input => {
    const val = input.value.trim();
    if (val) {
      filters.push({ type: input.dataset.filterType, mode: 'require', values: [val] });
    }
  });

  container.querySelectorAll(`.ws-filter-section[data-source-id="${CSS.escape(sourceId)}"]`).forEach(section => {
    const filterType = section.dataset.filterType;
    const filterTypeDef = (webSourceFilterTypes[sourceId] || []).find(ft => ft.type === filterType);
    if (!filterTypeDef) return;

    const parentEntry = section.closest('.ws-filter-entry');
    const entryMode = parentEntry?.dataset?.filterMode;
    const modeRadio = section.querySelector('.ws-filter-mode-radio:checked');

    if (filterTypeDef.inputStyle === 'text') {
      const values = [];
      section.querySelectorAll('.ws-type-tag:not(.ws-type-tag-locked)').forEach(tag => values.push(tag.dataset.type));
      if (values.length > 0) {
        filters.push({ type: filterType, mode: entryMode || 'exclude', values });
      }
    } else {
      const mode = entryMode || modeRadio?.value || filterTypeDef.modes[0] || 'require';
      const allValues = [];
      const checkedValues = [];
      section.querySelectorAll('.ws-filter-value-checkbox:not(:disabled)').forEach(cb => {
        allValues.push(cb.dataset.value);
        if (cb.checked) checkedValues.push(cb.dataset.value);
      });

      // Both modes: checked = in the list
      if (mode === 'exclude') {
        if (checkedValues.length > 0) {
          filters.push({ type: filterType, mode: 'exclude', values: checkedValues });
        }
      } else {
        if (checkedValues.length > 0 && checkedValues.length < allValues.length) {
          filters.push({ type: filterType, mode: 'require', values: checkedValues });
        }
      }
    }
  });
  return filters;
}

function closeVirtualTagModal() {
  document.getElementById('ws-virtual-tag-modal').classList.remove('active');
  virtualTagEditingId = null;
}

async function saveVirtualTag() {
  const isEdit = virtualTagEditingId !== null;
  const id = isEdit ? virtualTagEditingId : document.getElementById('ws-vt-id')?.value?.trim();
  const label = document.getElementById('ws-vt-label')?.value?.trim();
  const sourceId = document.getElementById('ws-vt-source')?.value;
  const filters = readVirtualTagFiltersFromUI();

  if (!id || !/^[a-z0-9_-]+$/.test(id)) {
    showToast('ID must be a lowercase slug (a-z, 0-9, hyphens, underscores)', 'error');
    return;
  }
  if (!label) {
    showToast('Label is required', 'error');
    return;
  }
  if (!sourceId) {
    showToast('Please select a source', 'error');
    return;
  }

  const saveBtn = document.getElementById('ws-virtual-tag-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026'; }

  try {
    const url = isEdit
      ? `${API_BASE}/web-sources/virtual-tags/${encodeURIComponent(id)}`
      : `${API_BASE}/web-sources/virtual-tags`;
    const method = isEdit ? 'PUT' : 'POST';
    const body = isEdit
      ? { label, sourceId, filters }
      : { id, label, sourceId, filters };

    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Failed to save virtual tag');

    // Update local cache
    if (!webSourcesConfig.virtualTags) webSourcesConfig.virtualTags = {};
    webSourcesConfig.virtualTags[id] = data.virtualTag;

    closeVirtualTagModal();
    renderVirtualTagsList();
    renderWebSourcesTestSection();
    showToast(isEdit ? 'Virtual tag updated' : `Virtual tag created: ws:${id}`);
  } catch (error) {
    console.error('Error saving virtual tag:', error);
    showToast(`Error: ${error.message}`, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

async function deleteVirtualTag(tagId) {
  const tag = webSourcesConfig?.virtualTags?.[tagId];
  if (!tag) return;
  if (!confirm(`Delete virtual tag "${tag.label}" (ws:${tagId})?`)) return;

  try {
    const response = await fetch(`${API_BASE}/web-sources/virtual-tags/${encodeURIComponent(tagId)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Failed to delete virtual tag');

    delete webSourcesConfig.virtualTags[tagId];
    renderVirtualTagsList();
    renderWebSourcesTestSection();
    showToast(`Virtual tag "ws:${tagId}" deleted`);
  } catch (error) {
    console.error('Error deleting virtual tag:', error);
    showToast(`Error: ${error.message}`, 'error');
  }
}

function initVirtualTagModal() {
  document.getElementById('ws-virtual-tag-close')?.addEventListener('click', closeVirtualTagModal);
  document.getElementById('ws-virtual-tag-cancel')?.addEventListener('click', closeVirtualTagModal);
  document.getElementById('ws-virtual-tag-save')?.addEventListener('click', saveVirtualTag);
  document.getElementById('ws-virtual-tag-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVirtualTagModal();
  });
}

function renderWebSourcesTestSection() {
  const container = document.getElementById('web-sources-test-section');
  if (!container) return;

  const testCache = webSourcesConfig?.testCache || null;
  const virtualTags = webSourcesConfig?.virtualTags || {};
  const sources = webSourcesConfig?.sources || {};

  // Build virtual tag options
  const vtOptions = Object.entries(virtualTags).map(([id, vt]) => {
    const srcName = sources[vt.sourceId]?.name || vt.sourceId;
    return `<option value="${escapeHtml(id)}" ${webSourceTestVirtualTagId === id ? 'selected' : ''}>${escapeHtml(vt.label)} (${escapeHtml(srcName)})</option>`;
  }).join('');

  // Build source options for ad-hoc mode
  const sourceOptions = Object.entries(sources).map(([id, src]) =>
    `<option value="${escapeHtml(id)}" ${webSourceTestAdHocSourceId === id ? 'selected' : ''}>${escapeHtml(src.name)}</option>`
  ).join('');

  let html = '';

  // Test mode tabs
  html += `<div class="ws-test-modes">
    <button type="button" class="ws-test-mode-btn ${webSourceTestMode === 'virtual-tag' ? 'active' : ''}" data-mode="virtual-tag">Virtual Tag</button>
    <button type="button" class="ws-test-mode-btn ${webSourceTestMode === 'ad-hoc' ? 'active' : ''}" data-mode="ad-hoc">Ad-hoc</button>
    <button type="button" class="ws-test-mode-btn ${webSourceTestMode === 'specific' ? 'active' : ''}" data-mode="specific">Specific Image</button>
  </div>`;

  // Virtual Tag mode
  html += `<div class="ws-test-mode-panel" id="ws-test-panel-virtual-tag" style="${webSourceTestMode === 'virtual-tag' ? '' : 'display:none;'}">
    <div style="margin-bottom:10px;">
      <select id="ws-test-virtual-tag" class="ws-select" style="width:100%;">
        <option value="">— Select a virtual tag —</option>
        ${vtOptions}
      </select>
    </div>
  </div>`;

  // Ad-hoc mode
  html += `<div class="ws-test-mode-panel" id="ws-test-panel-ad-hoc" style="${webSourceTestMode === 'ad-hoc' ? '' : 'display:none;'}">
    <div style="margin-bottom:10px;">
      <select id="ws-test-ad-hoc-source" class="ws-select" style="width:100%;">
        <option value="">— Select a source —</option>
        ${sourceOptions}
      </select>
    </div>
    <div id="ws-test-ad-hoc-filters"></div>
  </div>`;

  // Specific Image mode
  html += `<div class="ws-test-mode-panel" id="ws-test-panel-specific" style="${webSourceTestMode === 'specific' ? '' : 'display:none;'}">
    <div style="margin-bottom:10px;">
      <input type="text" id="web-source-specific-image" placeholder="Met Museum ID, collection URL, or direct image URL"
             class="ws-type-input" style="width:100%;"
             value="${escapeHtml(webSourceSpecificImage || '')}">
    </div>
  </div>`;

  // Common controls: orientation + buttons
  html += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
    <button type="button" id="web-source-test-fetch-btn" class="btn-secondary btn-small">Fetch Test Image</button>
    ${testCache ? `<button type="button" id="web-source-test-reprocess-btn" class="btn-secondary btn-small">Reprocess</button>` : ''}
    <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
      <span style="font-weight:600;color:var(--text-muted,#666);">Simulate TV:</span>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
        <input type="radio" name="ws-test-orientation" value="landscape" ${webSourceTestOrientation === 'landscape' ? 'checked' : ''}> Landscape
      </label>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
        <input type="radio" name="ws-test-orientation" value="portrait" ${webSourceTestOrientation === 'portrait' ? 'checked' : ''}> Portrait
      </label>
    </div>
  </div>`;

  if (testCache) {
    const m = testCache.metadata || {};
    const fetched = testCache.fetchedAt ? new Date(testCache.fetchedAt).toLocaleString() : '';

    // Artwork metadata rows — built from source's declared metadataFields so all
    // available fields are shown, with any undeclared extras appended afterward.
    const sourceFields = webSourceMetadata[testCache.sourceId]?.fields || [];
    const declaredKeys = new Set(['artworkUrl', ...sourceFields.map(f => f.key)]);
    const declaredRows = sourceFields
      .filter(f => m[f.key] != null && m[f.key] !== '')
      .map(f => [f.label, String(m[f.key])]);
    const extraRows = Object.entries(m)
      .filter(([k, v]) => !declaredKeys.has(k) && v != null && v !== '')
      .map(([k, v]) => [k, String(v)]);
    const metaRows = [...declaredRows, ...extraRows, fetched ? ['Fetched', fetched] : null]
      .filter(Boolean)
      .map(([k, v]) =>
        `<tr><td style="font-weight:600;padding:3px 12px 3px 0;white-space:nowrap;">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`
      ).join('');

    const artworkLinkRow = testCache.artworkUrl
      ? `<tr><td style="font-weight:600;padding:3px 12px 3px 0;">Artwork</td><td><a href="${escapeHtml(testCache.artworkUrl)}" target="_blank" rel="noopener">${escapeHtml(testCache.artworkUrl)}</a></td></tr>`
      : '';

    // Mapped value rows
    const attrRows = Object.entries(testCache.attributeSnapshot || {}).map(([k, v]) =>
      `<tr><td style="font-weight:600;padding:3px 12px 3px 0;white-space:nowrap;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`
    ).join('');

    const entityRows = Object.entries(testCache.entitySnapshot || {}).flatMap(([entityId, attrs]) =>
      Object.entries(attrs).map(([attrName, value]) =>
        `<tr><td style="font-weight:600;padding:3px 12px 3px 0;white-space:nowrap;">${escapeHtml(entityId)}.${escapeHtml(attrName)}</td><td>${escapeHtml(value)}</td></tr>`
      )
    ).join('');

    const mappedSection = (attrRows || entityRows) ? `
      <div style="margin-top:12px;">
        <div style="font-weight:600;margin-bottom:4px;font-size:13px;">Mapped Values</div>
        <table style="border-collapse:collapse;font-size:13px;">${attrRows}${entityRows}</table>
      </div>` : '';

    const ts = Date.now();
    const rawImg = testCache.rawFilename
      ? `<div style="flex:1;min-width:0;">
           <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-muted,#666);">Original</div>
           <img src="${API_BASE}/web-sources/test-cache/raw-image?t=${ts}" alt="Original artwork"
                style="max-width:100%;max-height:300px;display:block;border-radius:4px;cursor:zoom-in;"
                onclick="showImageLightbox(this.src,'Original artwork')"
                onerror="this.style.display='none'">
         </div>`
      : '';
    const pi = testCache.processingInfo;
    const preprocessedLabel = (() => {
      if (!pi) return 'Frame Removed';
      const actual = pi.actualProcessor || pi.configured;
      return `Frame Removed (${escapeHtml(actual)})`;
    })();
    const processingInfoRow = pi ? (() => {
      const actual = pi.actualProcessor || pi.configured;
      const stopNote = pi.stopReason ? ` — ${pi.stopReason}` : '';
      const mainRow = `<tr><td style="font-weight:600;padding:3px 12px 3px 0;white-space:nowrap;">Processing</td><td>${escapeHtml(actual + stopNote)}</td></tr>`;

      // Render option rows using schema labels for the configured pre-processor and crop engine.
      const preProcessors = webSourceImageProcessingSchema.preProcessors || [];
      const cropEngines   = webSourceImageProcessingSchema.cropEngines   || [];
      function optionRows(schemaList, processorValue, optionsObj) {
        if (!optionsObj || !Object.keys(optionsObj).length) return '';
        const schema = schemaList.find(p => p.value === processorValue);
        if (!schema?.options?.length) return '';
        return schema.options.map(opt => {
          const val = optionsObj[opt.key];
          if (val === undefined || val === null) return '';
          let displayVal;
          if (opt.type === 'select') {
            const choice = (opt.choices || []).find(c => c.value === val);
            displayVal = choice ? choice.label : String(val);
          } else {
            displayVal = String(val);
          }
          return `<tr><td style="padding:3px 12px 3px 0;white-space:nowrap;color:var(--text-muted,#666);">${escapeHtml(opt.label)}</td><td style="color:var(--text-muted,#666);">${escapeHtml(displayVal)}</td></tr>`;
        }).join('');
      }
      const ppRows = optionRows(preProcessors, pi.configured, pi.preProcessorOptions);
      const ceRows = optionRows(cropEngines,   webSourcesConfig?.imageProcessing?.cropEngine || 'sharp', pi.cropEngineOptions);
      return mainRow + ppRows + ceRows;
    })() : '';
    const preprocessedImg = testCache.preprocessedFilename
      ? `<div style="flex:1;min-width:0;">
           <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-muted,#666);">${preprocessedLabel}</div>
           <img src="${API_BASE}/web-sources/test-cache/preprocessed-image?t=${ts}" alt="After frame detection"
                style="max-width:100%;max-height:300px;display:block;border-radius:4px;cursor:zoom-in;"
                onclick="showImageLightbox(this.src,'After frame detection')"
                onerror="this.style.display='none'">
         </div>`
      : '';
    const processedImg = `<div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-muted,#666);">Cropped for TV</div>
      <img src="${API_BASE}/web-sources/test-cache/image?t=${ts}" alt="Cropped artwork"
           style="max-width:100%;max-height:300px;display:block;border-radius:4px;cursor:zoom-in;"
           onclick="showImageLightbox(this.src,'Cropped for TV')"
           onerror="this.style.display='none'">
    </div>`;

    // Fetch trace section
    const ft = testCache.fetchTrace;
    let traceHtml = '';
    if (ft) {
      const traceRows = [];
      const pathLabels = { 'virtual-tag': 'Virtual Tag', 'ad-hoc': 'Ad-hoc', 'specific': 'Specific Image' };
      traceRows.push(['Fetch path', pathLabels[ft.path] || ft.path]);
      if (ft.virtualTagId) {
        const vtLabel = webSourcesConfig?.virtualTags?.[ft.virtualTagId]?.label || ft.virtualTagId;
        traceRows.push(['Virtual tag', `${vtLabel} (${ft.virtualTagId})`]);
      }
      traceRows.push(['Source', testCache.sourceId]);
      if (ft.mode) traceRows.push(['Mode', ft.mode]);
      if (ft.aspectRatio && ft.aspectRatio !== 'all') traceRows.push(['Aspect ratio', ft.aspectRatio]);
      if (ft.mergedFilters?.length > 0) {
        const filterSummary = ft.mergedFilters.map(f => {
          const modeLabel = f.mode === 'require' ? 'include' : 'exclude';
          return `${f.type} (${modeLabel}): ${f.values.join(', ')}`;
        }).join('; ');
        traceRows.push(['Merged filters', filterSummary]);
      }
      if (ft.specificImage) traceRows.push(['Input', ft.specificImage]);
      traceHtml = `<div style="margin-bottom:12px;">
        <div style="font-weight:600;margin-bottom:4px;font-size:13px;">Fetch Trace</div>
        <table style="border-collapse:collapse;font-size:13px;">
          ${traceRows.map(([k, v]) => `<tr><td style="font-weight:600;padding:3px 12px 3px 0;white-space:nowrap;">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}
        </table>
      </div>`;
    }

    html += `<div class="web-source-test-result">
      <div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap;">
        ${rawImg}${preprocessedImg}${processedImg}
      </div>
      ${traceHtml}
      <table style="border-collapse:collapse;font-size:13px;">${processingInfoRow}${metaRows}${artworkLinkRow}</table>
      ${mappedSection}
    </div>`;
  }

  container.innerHTML = html;

  // Mode tabs
  container.querySelectorAll('.ws-test-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      webSourceTestMode = btn.dataset.mode;
      container.querySelectorAll('.ws-test-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === webSourceTestMode));
      container.querySelectorAll('.ws-test-mode-panel').forEach(p => {
        p.style.display = p.id === `ws-test-panel-${webSourceTestMode}` ? '' : 'none';
      });
    });
  });

  // Virtual tag selector
  document.getElementById('ws-test-virtual-tag')?.addEventListener('change', (e) => {
    webSourceTestVirtualTagId = e.target.value;
  });

  // Ad-hoc source selector + filter rendering
  const adHocSourceSelect = document.getElementById('ws-test-ad-hoc-source');
  adHocSourceSelect?.addEventListener('change', (e) => {
    webSourceTestAdHocSourceId = e.target.value;
    webSourceTestAdHocFilters = [];
    renderTestAdHocFilters();
  });
  // Init ad-hoc filters if source already selected
  if (webSourceTestAdHocSourceId) renderTestAdHocFilters();

  // Specific image input
  document.getElementById('web-source-specific-image')?.addEventListener('input', (e) => {
    webSourceSpecificImage = e.target.value;
  });

  // Common controls
  document.getElementById('web-source-test-fetch-btn')?.addEventListener('click', fetchTestWebSource);
  document.getElementById('web-source-test-reprocess-btn')?.addEventListener('click', reprocessTestWebSource);
  container.querySelectorAll('input[name="ws-test-orientation"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) webSourceTestOrientation = radio.value;
    });
  });
}

/**
 * Render the ad-hoc filter editor inside the test panel.
 * Uses the same renderFilterList + initFilterListInteractions pattern.
 */
function renderTestAdHocFilters(expandedTypes) {
  const filtersContainer = document.getElementById('ws-test-ad-hoc-filters');
  if (!filtersContainer) return;

  const sourceId = webSourceTestAdHocSourceId;
  if (!sourceId) {
    filtersContainer.innerHTML = '';
    return;
  }

  const sourceFilterTypes = webSourceFilterTypes[sourceId] || [];
  const coreTypes = webSourceCoreFilterTypes || [];
  const allFilterTypes = [...coreTypes, ...sourceFilterTypes];
  const globalFilters = webSourcesConfig?.globalFilters || [];
  const sourceFilters = webSourcesConfig?.sources?.[sourceId]?.filters || [];
  const lockedFilters = [...globalFilters, ...sourceFilters];

  filtersContainer.innerHTML = renderFilterList({
    containerId: 'ws-test-ad-hoc-filter-list',
    availableFilterTypes: allFilterTypes,
    currentFilters: webSourceTestAdHocFilters,
    lockedFilters,
    sourceId,
    expandedTypes,
  });

  initFilterSectionInteractions(filtersContainer);
  filtersContainer.querySelectorAll('.ws-category-checkbox[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });
  initFilterListInteractions(filtersContainer, {
    onAdd: (filterType, filterMode) => {
      webSourceTestAdHocFilters = readTestAdHocFiltersFromUI();
      const mode = filterMode || 'require';
      webSourceTestAdHocFilters.push({ type: filterType, mode, values: [] });
      renderTestAdHocFilters(new Set([`${filterType}:${mode}`]));
    },
    onRemove: (filterType, filterMode) => {
      webSourceTestAdHocFilters = readTestAdHocFiltersFromUI().filter(f => !(f.type === filterType && (!filterMode || f.mode === filterMode)));
      renderTestAdHocFilters();
    },
  });
}

/**
 * Read ad-hoc filter values from the test panel UI.
 */
function readTestAdHocFiltersFromUI() {
  const container = document.getElementById('ws-test-ad-hoc-filters');
  if (!container) return [];
  const sourceId = webSourceTestAdHocSourceId;
  if (!sourceId) return [];

  const filters = [];
  container.querySelectorAll('.ws-filter-entry:not(.ws-filter-entry-locked)').forEach(entry => {
    const filterType = entry.dataset.filterType;
    if (!filterType) return;
    // Core single-value filter (e.g. orientation)
    const coreSelect = entry.querySelector('.ws-filter-core-value');
    if (coreSelect) {
      filters.push({ type: filterType, mode: 'require', values: [coreSelect.value] });
      return;
    }
    // Search filter (single-value text input)
    const searchInput = entry.querySelector('.ws-filter-search-value');
    if (searchInput) {
      const val = searchInput.value.trim();
      if (val) filters.push({ type: filterType, mode: 'require', values: [val] });
      return;
    }
    // Checkbox filter — read mode from entry's data-filter-mode (authoritative in dual-mode)
    const entryMode = entry.dataset.filterMode;
    const section = entry.querySelector(`.ws-filter-section[data-filter-type="${filterType}"]`);
    const modeRadio = section?.querySelector('.ws-filter-mode-radio:checked');
    const mode = entryMode || modeRadio?.value || 'require';
    const checkedValues = [];
    entry.querySelectorAll(`.ws-filter-checkbox[data-source-id="${sourceId}"][data-filter-type="${filterType}"]:checked:not(:disabled)`).forEach(cb => {
      checkedValues.push(cb.value);
    });
    if (mode === 'exclude') {
      if (checkedValues.length > 0) {
        filters.push({ type: filterType, mode: 'exclude', values: checkedValues });
      }
    } else {
      const allValues = [];
      entry.querySelectorAll(`.ws-filter-checkbox[data-source-id="${sourceId}"][data-filter-type="${filterType}"]:not(:disabled)`).forEach(cb => {
        allValues.push(cb.value);
      });
      if (checkedValues.length < allValues.length) {
        filters.push({ type: filterType, mode: 'require', values: checkedValues });
      }
    }
  });
  return filters;
}

async function fetchTestWebSource() {
  const btn = document.getElementById('web-source-test-fetch-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }

  try {
    const body = { tvOrientation: webSourceTestOrientation };

    if (webSourceTestMode === 'specific') {
      if (!webSourceSpecificImage?.trim()) throw new Error('Enter an image URL or ID');
      body.specificImage = webSourceSpecificImage;
    } else if (webSourceTestMode === 'ad-hoc') {
      if (!webSourceTestAdHocSourceId) throw new Error('Select a source');
      body.sourceId = webSourceTestAdHocSourceId;
      body.filters = readTestAdHocFiltersFromUI();
    } else {
      // virtual-tag mode
      if (!webSourceTestVirtualTagId) throw new Error('Select a virtual tag');
      body.virtualTagId = webSourceTestVirtualTagId;
    }

    const response = await fetch(`${API_BASE}/web-sources/test-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Failed to fetch test image');
    if (webSourcesConfig) webSourcesConfig.testCache = data.testCache;
    // Preserve ad-hoc filters across re-render
    if (webSourceTestMode === 'ad-hoc') {
      webSourceTestAdHocFilters = readTestAdHocFiltersFromUI();
    }
    renderWebSourcesTestSection();
  } catch (error) {
    console.error('Error fetching test image:', error);
    showToast(`Error: ${error.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Fetch Test Image'; }
  }
}

async function reprocessTestWebSource() {
  const btn = document.getElementById('web-source-test-reprocess-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

  try {
    const response = await fetch(`${API_BASE}/web-sources/test-reprocess`, { method: 'POST' });
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Failed to reprocess test image');
    if (webSourcesConfig) webSourcesConfig.testCache = data.testCache;
    renderWebSourcesTestSection();
  } catch (error) {
    console.error('Error reprocessing test image:', error);
    showToast(`Error: ${error.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Reprocess'; }
  }
}
