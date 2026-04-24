// MC Leaderboards - Utility Functions
// Performance and helper utilities

/**
 * Debounce function - delays execution until after wait milliseconds have elapsed
 * @param {Function} func - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @returns {Function} Debounced function
 */
function debounce(func, wait = 300) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function - ensures function is called at most once per wait period
 * @param {Function} func - Function to throttle
 * @param {number} wait - Milliseconds to wait between calls
 * @returns {Function} Throttled function
 */
function throttle(func, wait = 300) {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, wait);
    }
  };
}

/**
 * Lazy load images with Intersection Observer
 */
function lazyLoadImages() {
  if ('IntersectionObserver' in window) {
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
          }
          if (img.dataset.srcset) {
            img.srcset = img.dataset.srcset;
            img.removeAttribute('data-srcset');
          }
          img.classList.add('loaded');
          observer.unobserve(img);
        }
      });
    });

    document.querySelectorAll('img[data-src]').forEach(img => {
      imageObserver.observe(img);
    });
  } else {
    // Fallback for browsers that don't support IntersectionObserver
    document.querySelectorAll('img[data-src]').forEach(img => {
      if (img.dataset.src) {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      }
    });
  }
}

/**
 * Request Animation Frame throttle - limits function calls to animation frames
 * @param {Function} func - Function to throttle
 * @returns {Function} RAF-throttled function
 */
function rafThrottle(func) {
  let rafId = null;
  return function(...args) {
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        func.apply(this, args);
        rafId = null;
      });
    }
  };
}

/**
 * Batch DOM reads and writes to avoid layout thrashing
 */
class DOMBatcher {
  constructor() {
    this.reads = [];
    this.writes = [];
    this.scheduled = false;
  }

  read(fn) {
    this.reads.push(fn);
    this.schedule();
  }

  write(fn) {
    this.writes.push(fn);
    this.schedule();
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    
    requestAnimationFrame(() => {
      // Execute all reads first
      const reads = this.reads.slice();
      this.reads = [];
      reads.forEach(fn => fn());

      // Then execute all writes
      const writes = this.writes.slice();
      this.writes = [];
      writes.forEach(fn => fn());

      this.scheduled = false;
    });
  }
}

// Create global DOM batcher instance
const domBatcher = new DOMBatcher();

/**
 * Memoize function results
 * @param {Function} func - Function to memoize
 * @returns {Function} Memoized function
 */
function memoize(func) {
  const cache = new Map();
  return function(...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = func.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

/**
 * Format number with commas
 */
const formatNumber = memoize((num) => {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createElementFromHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '').trim();
  return template.content.firstElementChild || null;
}

function resolveAdminRoleForEntity(entity = {}) {
  return String(entity?.adminContext?.role || entity?.verifiedAdminRole || '').trim().toLowerCase();
}

function getStaffRoleForEntity(entity = {}) {
  return entity?.verifiedStaffRole || entity?.staffRole || null;
}

function getRoleBadgeDescriptors(entity = {}, options = {}) {
  const descriptors = [];
  const seen = new Set();
  const includeGenericStaffWithSpecial = options.includeGenericStaffWithSpecial === true;
  const defaultSize = options.size === 'sm' ? 'sm' : 'md';
  const addDescriptor = (key, descriptor) => {
    if (!key || seen.has(key) || !descriptor) return;
    seen.add(key);
    descriptors.push({
      size: defaultSize,
      ...descriptor
    });
  };

  const adminRole = resolveAdminRoleForEntity(entity);
  if (adminRole === 'owner') {
    addDescriptor('admin-owner', {
      label: 'Owner',
      variant: 'admin',
      iconHtml: '<i class="fas fa-crown"></i>'
    });
  } else if (adminRole === 'lead_admin') {
    addDescriptor('admin-lead', {
      label: 'Lead Admin',
      variant: 'admin',
      iconHtml: '<i class="fas fa-crown"></i>'
    });
  } else if (adminRole === 'moderator') {
    addDescriptor('admin-moderator', {
      label: 'Moderator',
      variant: 'moderator',
      iconHtml: '<i class="fas fa-shield-alt"></i>'
    });
  } else if (adminRole === 'support') {
    addDescriptor('admin-support', {
      label: 'Support Staff',
      variant: 'support',
      iconHtml: '<i class="fas fa-life-ring"></i>'
    });
  } else if (entity?.admin === true || entity?.verifiedRoles?.admin === true) {
    addDescriptor('admin-default', {
      label: 'Admin',
      variant: 'admin',
      iconHtml: '<i class="fas fa-crown"></i>'
    });
  }

  if (entity?.tester === true || entity?.verifiedRoles?.tester === true) {
    addDescriptor('tester', {
      label: 'Tier Tester',
      variant: 'tester',
      iconHtml: '<i class="fas fa-check"></i>'
    });
  }

  const staffRole = getStaffRoleForEntity(entity);
  const capabilitySet = new Set(Array.isArray(staffRole?.capabilities) ? staffRole.capabilities : []);
  const specialBadges = Array.isArray(staffRole?.specialBadges) ? staffRole.specialBadges : [];
  const normalizedSpecialBadges = specialBadges.length
    ? specialBadges
    : [
        ...(capabilitySet.has('moderation:chat_reports:view') || capabilitySet.has('moderation:chat:block')
          ? [{ badgeVariant: 'moderator', label: 'Moderator', iconClass: 'fas fa-shield-alt', color: '#facc15' }]
          : []),
        ...(capabilitySet.has('leaderboard:filters:manage')
          ? [{ badgeVariant: 'leaderboard-moderator', label: 'Leaderboard Moderator', iconClass: 'fas fa-filter', color: '#60a5fa' }]
          : [])
      ];

  normalizedSpecialBadges.forEach((badge) => {
    const variant = badge?.badgeVariant === 'leaderboard-moderator'
      ? 'leaderboard-moderator'
      : badge?.badgeVariant === 'moderator'
        ? 'moderator'
        : 'staff';
    addDescriptor(`staff-special:${variant}`, {
      label: badge?.label || staffRole?.name || 'Staff',
      variant,
      iconHtml: `<i class="${escapeHtml(badge?.iconClass || (variant === 'leaderboard-moderator' ? 'fas fa-filter' : 'fas fa-shield-alt'))}"></i>`
    });
  });

  if (staffRole && (includeGenericStaffWithSpecial || normalizedSpecialBadges.length === 0)) {
    addDescriptor(`staff-generic:${staffRole.id || staffRole.name || 'staff'}`, {
      label: staffRole?.name || 'Staff',
      variant: 'staff',
      iconUrl: staffRole?.iconUrl || '',
      iconHtml: staffRole?.iconUrl
        ? ''
        : `<i class="${escapeHtml(staffRole?.iconClass || 'fas fa-shield-alt')}"></i>`,
      color: staffRole?.color || ''
    });
  }

  if (entity?.plus?.active === true && entity?.plus?.showBadge !== false) {
    addDescriptor('plus', {
      label: 'Plus',
      variant: 'plus',
      iconHtml: '<i class="fas fa-star"></i>'
    });
  }

  return descriptors;
}

function buildRoleBadgeHtml(descriptor = {}) {
  const label = escapeHtml(descriptor?.label || 'Badge');
  const variant = escapeHtml(descriptor?.variant || 'staff');
  const sizeClass = descriptor?.size === 'sm' ? ' role-icon-badge--sm' : '';
  const iconUrl = String(descriptor?.iconUrl || '').trim();
  const iconMarkup = iconUrl
    ? `<img src="${escapeHtml(iconUrl)}" alt="${label}" class="role-icon-badge__image">`
    : String(descriptor?.iconHtml || '<i class="fas fa-shield-alt"></i>');
  const customColor = String(descriptor?.color || '').trim();
  const style = /^#([0-9a-fA-F]{6})$/.test(customColor)
    ? ` style="color:${customColor};"`
    : '';

  return `<span class="role-icon-badge role-icon-badge--${variant}${sizeClass}" data-tooltip="${label}" aria-label="${label}"${style}>${iconMarkup}</span>`;
}

function buildStaticRoleBadge(label, variant, iconHtml, options = {}) {
  return buildRoleBadgeHtml({
    label,
    variant,
    iconHtml,
    size: options.size || 'md',
    color: options.color || ''
  });
}

function renderRoleBadges(entity = {}, options = {}) {
  return getRoleBadgeDescriptors(entity, options)
    .map((descriptor) => buildRoleBadgeHtml(descriptor))
    .join('');
}

const OverlayTooltip = (() => {
  let tooltipEl = null;
  let activeAnchor = null;

  function ensureTooltip() {
    if (tooltipEl || typeof document === 'undefined') return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'app-tooltip-overlay';
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
    document.body.classList.add('has-overlay-tooltips');
    return tooltipEl;
  }

  function getTooltipMarkup(anchor) {
    if (!anchor) return '';
    const directTooltip = anchor.getAttribute('data-tooltip');
    if (directTooltip) {
      return escapeHtml(directTooltip);
    }
    const nestedTooltip = anchor.querySelector('.tooltip-content');
    if (nestedTooltip) {
      return nestedTooltip.innerHTML.trim();
    }
    return '';
  }

  function positionTooltip() {
    if (!tooltipEl || !activeAnchor) return;

    tooltipEl.style.visibility = 'hidden';
    tooltipEl.hidden = false;
    tooltipEl.style.maxWidth = `${Math.max(180, Math.min(320, window.innerWidth - 24))}px`;

    const anchorRect = activeAnchor.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const spacing = 12;
    const viewportPadding = 12;
    let placement = 'top';
    let top = anchorRect.top - tooltipRect.height - spacing;

    if (top < viewportPadding) {
      placement = 'bottom';
      top = anchorRect.bottom + spacing;
    }

    let left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
    left = Math.max(viewportPadding, Math.min(left, window.innerWidth - tooltipRect.width - viewportPadding));

    tooltipEl.dataset.placement = placement;
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
    tooltipEl.style.visibility = 'visible';
  }

  function showTooltip(anchor) {
    const markup = getTooltipMarkup(anchor);
    if (!markup || !anchor || typeof document === 'undefined' || !document.body) return;
    ensureTooltip();
    activeAnchor = anchor;
    tooltipEl.innerHTML = markup;
    positionTooltip();
  }

  function hideTooltip(anchor = null) {
    if (anchor && activeAnchor && anchor !== activeAnchor) return;
    if (tooltipEl) {
      tooltipEl.hidden = true;
      tooltipEl.style.visibility = 'hidden';
    }
    activeAnchor = null;
  }

  function handlePointerEnter(event) {
    const anchor = event.target?.closest?.('.role-icon-badge, .tooltip-anchor');
    if (!anchor) return;
    showTooltip(anchor);
  }

  function handlePointerLeave(event) {
    const anchor = event.target?.closest?.('.role-icon-badge, .tooltip-anchor');
    if (!anchor) return;
    const related = event.relatedTarget;
    if (!related || !anchor.contains(related)) {
      hideTooltip(anchor);
    }
  }

  function handleFocusIn(event) {
    const anchor = event.target?.closest?.('.role-icon-badge, .tooltip-anchor');
    if (!anchor) return;
    showTooltip(anchor);
  }

  function handleFocusOut(event) {
    const anchor = event.target?.closest?.('.role-icon-badge, .tooltip-anchor');
    if (!anchor) return;
    const related = event.relatedTarget;
    if (!related || !anchor.contains(related)) {
      hideTooltip(anchor);
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('mouseover', handlePointerEnter);
    document.addEventListener('mouseout', handlePointerLeave);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('scroll', positionTooltip, true);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', positionTooltip);
  }

  return {
    show: showTooltip,
    hide: hideTooltip,
    reposition: positionTooltip
  };
})();

const DateTimeFormatter = (() => {
  const formatterCache = new Map();
  const relativeFormatter = typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
    : null;

  function resolveDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function getFormatter(format = {}) {
    const cacheKey = JSON.stringify(format);
    if (!formatterCache.has(cacheKey)) {
      formatterCache.set(cacheKey, new Intl.DateTimeFormat('en-US', format));
    }
    return formatterCache.get(cacheKey);
  }

  function format(value, {
    fallback = 'Unknown',
    format: formatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }
  } = {}) {
    const date = resolveDate(value);
    if (!date) return fallback;
    return getFormatter(formatOptions).format(date);
  }

  function formatDateOnly(value, options = {}) {
    return format(value, {
      fallback: options.fallback || 'Unknown',
      format: options.format || {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }
    });
  }

  function formatTimeOnly(value, options = {}) {
    return format(value, {
      fallback: options.fallback || 'Unknown',
      format: options.format || {
        hour: 'numeric',
        minute: '2-digit'
      }
    });
  }

  function formatRelative(value, { fallback = '' } = {}) {
    const date = resolveDate(value);
    if (!date) return fallback;

    const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
    const absSeconds = Math.abs(diffSeconds);

    if (!relativeFormatter) {
      if (absSeconds < 60) return 'just now';
      const minutes = Math.round(absSeconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      if (days < 7) return `${days}d ago`;
      return formatDateOnly(date);
    }

    const ranges = [
      { limit: 60, unit: 'second' },
      { limit: 3600, unit: 'minute', divisor: 60 },
      { limit: 86400, unit: 'hour', divisor: 3600 },
      { limit: 604800, unit: 'day', divisor: 86400 }
    ];

    for (const range of ranges) {
      if (absSeconds < range.limit) {
        const valueForUnit = range.divisor ? Math.round(diffSeconds / range.divisor) : diffSeconds;
        return relativeFormatter.format(valueForUnit, range.unit);
      }
    }

    return formatDateOnly(date);
  }

  return {
    resolveDate,
    format,
    formatDate: formatDateOnly,
    formatTime: formatTimeOnly,
    formatRelative
  };
})();

function formatDateTime(value, options = {}) {
  return DateTimeFormatter.format(value, options);
}

function formatDate(value, options = {}) {
  return DateTimeFormatter.formatDate(value, options);
}

function formatTime(value, options = {}) {
  return DateTimeFormatter.formatTime(value, options);
}

function formatRelativeTime(value, options = {}) {
  return DateTimeFormatter.formatRelative(value, options);
}

function buildEmptyStateHTML({
  icon = 'fa-box-open',
  title = 'Nothing here yet',
  description = 'There is no data to show right now.',
  actionLabel = '',
  actionHref = ''
} = {}) {
  const actionHtml = actionLabel && actionHref
    ? `<a class="btn btn-secondary btn-sm empty-state-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
    : '';

  return `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true"><i class="fas ${escapeHtml(icon)}"></i></div>
      <div class="empty-state-title">${escapeHtml(title)}</div>
      <div class="empty-state-desc">${escapeHtml(description)}</div>
      ${actionHtml}
    </div>
  `;
}

function renderEmptyState(target, config = {}) {
  if (!target) return;
  target.innerHTML = buildEmptyStateHTML(config);
}

const Validator = {
  required(value, message = 'This field is required.') {
    return String(value || '').trim() ? null : message;
  },

  email(value, message = 'Please enter a valid email address.') {
    const normalized = String(value || '').trim();
    if (!normalized) return message;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? null : message;
  },

  url(value, message = 'Please enter a valid URL.') {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    try {
      const url = new URL(normalized);
      return ['http:', 'https:'].includes(url.protocol) ? null : message;
    } catch (_) {
      return message;
    }
  },

  minLength(value, length, message = `Please enter at least ${length} characters.`) {
    return String(value || '').trim().length >= length ? null : message;
  },

  maxLength(value, length, message = `Please enter no more than ${length} characters.`) {
    return String(value || '').trim().length <= length ? null : message;
  },

  number(value, {
    min = null,
    max = null,
    message = 'Please enter a valid number.'
  } = {}) {
    if (value === null || value === undefined || value === '') {
      return message;
    }

    const normalized = Number(value);
    if (Number.isNaN(normalized)) {
      return message;
    }
    if (min !== null && normalized < min) {
      return message;
    }
    if (max !== null && normalized > max) {
      return message;
    }
    return null;
  },

  match(value, expected, message = 'The values do not match.') {
    return String(value || '') === String(expected || '') ? null : message;
  },

  minecraftUsername(value, message = 'Please enter a valid Minecraft username.') {
    const normalized = String(value || '').trim();
    if (!normalized) return message;
    return /^[a-zA-Z0-9_]{3,16}$/.test(normalized) ? null : message;
  },

  combine(...checks) {
    return checks.find(Boolean) || null;
  },

  validateFieldMap(fieldChecks = {}) {
    const entries = Object.entries(fieldChecks);
    return entries.reduce((errors, [field, checks]) => {
      const checkList = Array.isArray(checks) ? checks : [checks];
      const firstError = checkList.find(Boolean) || null;
      if (firstError) {
        errors[field] = firstError;
      }
      return errors;
    }, {});
  },

  firstError(fieldChecks = {}) {
    const errors = this.validateFieldMap(fieldChecks);
    const firstField = Object.keys(errors)[0];
    return firstField ? errors[firstField] : null;
  }
};

const ModerationState = {
  resolve(profile = null) {
    const source = profile || (typeof AppState !== 'undefined' && typeof AppState.getProfile === 'function'
      ? AppState.getProfile()
      : null) || {};
    const moderation = source.moderation || {};
    const restrictions = moderation.restrictions || {};
    const activeRestrictions = Object.entries(restrictions)
      .filter(([, config]) => config && config.active)
      .map(([key, config]) => ({ key, ...config }));
    const blacklisted = source.blacklisted === true || moderation.blacklisted === true;

    return {
      profile: source,
      moderation,
      restrictions,
      activeRestrictions,
      blacklisted,
      accountChangesRestricted: blacklisted || activeRestrictions.some((item) => item.key === 'account_changes'),
      reportingRestricted: blacklisted || activeRestrictions.some((item) => item.key === 'reporting'),
      queueRestricted: blacklisted || activeRestrictions.some((item) => item.key === 'queue_access'),
      messagingRestricted: blacklisted || activeRestrictions.some((item) => item.key === 'support_access')
    };
  },

  getBlockingMessage(actionLabel = 'complete this action', profile = null) {
    const state = this.resolve(profile);
    if (state.blacklisted) {
      return `Blacklisted accounts cannot ${actionLabel}.`;
    }

    const firstRestriction = state.activeRestrictions[0];
    if (!firstRestriction) {
      return `You cannot ${actionLabel} right now.`;
    }

    return firstRestriction.reason || `You cannot ${actionLabel} right now.`;
  }
};

/**
 * Check if element is in viewport
 */
function isInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

/**
 * Preload critical resources
 */
function preloadResource(href, as) {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = as;
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Measure performance timing
 */
function measurePerformance(name, fn) {
  const start = performance.now();
  const result = fn();
  const end = performance.now();
  if (CONFIG.DEBUG_MODE) {
    console.log(`[Performance] ${name}: ${(end - start).toFixed(2)}ms`);
  }
  return result;
}

// Export utilities
if (typeof window !== 'undefined') {
  window.debounce = debounce;
  window.throttle = throttle;
  window.rafThrottle = rafThrottle;
  window.lazyLoadImages = lazyLoadImages;
  window.domBatcher = domBatcher;
  window.memoize = memoize;
  window.formatNumber = formatNumber;
  window.escapeHtml = escapeHtml;
  window.createElementFromHTML = createElementFromHTML;
  window.resolveAdminRoleForEntity = resolveAdminRoleForEntity;
  window.getRoleBadgeDescriptors = getRoleBadgeDescriptors;
  window.buildRoleBadgeHtml = buildRoleBadgeHtml;
  window.buildStaticRoleBadge = buildStaticRoleBadge;
  window.renderRoleBadges = renderRoleBadges;
  window.OverlayTooltip = OverlayTooltip;
  window.DateTimeFormatter = DateTimeFormatter;
  window.formatDate = formatDate;
  window.formatDateTime = formatDateTime;
  window.formatTime = formatTime;
  window.formatRelativeTime = formatRelativeTime;
  window.buildEmptyStateHTML = buildEmptyStateHTML;
  window.renderEmptyState = renderEmptyState;
  window.Validator = Validator;
  window.ModerationState = ModerationState;
  window.isInViewport = isInViewport;
  window.preloadResource = preloadResource;
  window.measurePerformance = measurePerformance;
}
