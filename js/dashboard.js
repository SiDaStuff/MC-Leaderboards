// MC Leaderboards - Dashboard Functionality

let queueCheckInterval = null;
let activeMatch = null;
let activeMatchPollInterval = null;
let gamemodeStatsInterval = null;
let gamemodeStatsBackoffUntilMs = 0;
let hasLoadedRecentMatches = false;
let hasLoadedGamemodeActivity = false;
let hasLoadedNotificationSettings = false;
let hasLoadedQueueCooldowns = false;
let dashboardInitialized = false;
let notificationPollInterval = null; // legacy, removed
let dashboardRefreshInterval = null; // legacy, removed
let cooldownDisplayInterval = null;
let joinQueueButtonInterval = null;
const seenNotificationIds = new Set();
const MAX_SEEN_NOTIFICATIONS = 500;
const DASHBOARD_ACTIVE_MATCH_POLL_MS = 5000;

const DASHBOARD_ADMIN_CAPABILITY_MATRIX = {
  owner: ['*'],
  lead_admin: ['users:view', 'users:manage', 'blacklist:view', 'blacklist:manage', 'audit:view', 'matches:view', 'matches:manage', 'reports:manage', 'disputes:manage', 'queue:inspect', 'settings:manage'],
  moderator: ['users:view', 'blacklist:view', 'blacklist:manage', 'audit:view', 'matches:view', 'reports:manage', 'disputes:manage'],
  support: ['users:view', 'audit:view', 'matches:view']
};

const DASHBOARD_ADMIN_TAB_REQUIREMENTS = {
  management: ['users:view'],
  moderation: ['blacklist:view'],
  reported: ['reports:manage'],
  matches: ['matches:view'],
  operations: ['matches:view'],
  'security-scores': ['audit:view'],
  servers: ['settings:manage'],
  roles: ['users:manage']
};

// Restore configureUnifiedQueueExperience for dashboard UI
function configureUnifiedQueueExperience() {
  const title = document.getElementById('queueCardTitle');
  const subtitle = document.getElementById('queueCardSubtitle');
  const flowMessage = document.getElementById('queueFlowMessage');
  const testerOptions = document.getElementById('testerQueueOptions');

  if (isTierTesterUser()) {
    if (title) title.textContent = 'Join Shared Queue';
    if (subtitle) subtitle.textContent = 'Use the same shared queue as everyone else. Your tier tester preference is applied automatically.';
    if (flowMessage) {
      flowMessage.innerHTML = '<strong>Queue flow:</strong> Select your gamemodes and regions, choose a whitelisted server, then join the same live queue players use.';
    }
    if (testerOptions) testerOptions.style.display = 'block';
  } else {
    if (title) title.textContent = 'Join Shared Queue';
    if (subtitle) subtitle.textContent = 'One shared queue for players and tier testers.';
    if (flowMessage) {
      flowMessage.innerHTML = '<strong>Queue flow:</strong> Select one or more gamemodes and regions, choose a whitelisted server, then join queue.';
    }
    if (testerOptions) testerOptions.style.display = 'none';
  }

  updateJoinQueueButtonState();
}

function getDashboardAdminCapabilities(profile = {}) {
  const contextCapabilities = Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : null;
  if (contextCapabilities && contextCapabilities.length > 0) {
    return contextCapabilities;
  }

  const role = typeof profile?.adminContext?.role === 'string'
    ? profile.adminContext.role
    : (typeof profile?.adminRole === 'string' ? profile.adminRole : (profile?.admin === true ? 'lead_admin' : null));
  return DASHBOARD_ADMIN_CAPABILITY_MATRIX[role] || [];
}

function dashboardAdminHasCapability(profile, capability) {
  const capabilities = getDashboardAdminCapabilities(profile);
  return capabilities.includes('*') || capabilities.includes(capability);
}

function isDashboardAdminTabVisible(profile, tab) {
  const requirements = DASHBOARD_ADMIN_TAB_REQUIREMENTS[tab] || [];
  if (!requirements.length) return true;
  return requirements.some((capability) => dashboardAdminHasCapability(profile, capability));
}

function scrollToTesterDashboard() {
  const testerSection = document.getElementById('sharedQueueCard');
  if (!testerSection) return;

  if (testerSection.style.display === 'none') {
    testerSection.style.display = 'block';
  }

  const navbar = document.querySelector('.navbar');
  const offset = (navbar ? navbar.offsetHeight : 80) + 16;
  const targetTop = testerSection.getBoundingClientRect().top + window.pageYOffset - offset;
  window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

function isTierTesterUser() {
  return Boolean(AppState.isTierTester && AppState.isTierTester());
}

function getJoinQueueButtonLabel() {
  return isTierTesterUser() ? 'Join as Tier Tester' : 'Join Shared Queue';
}

function renderGamemodeSelectionControls() {
  const gamemodes = (CONFIG?.GAMEMODES || []).filter(gm => gm.id && gm.id !== 'overall');
  if (!gamemodes.length) return;

  const playerGamemodeContainer = document.getElementById('playerGamemodeSelections');
  if (playerGamemodeContainer) {
    playerGamemodeContainer.innerHTML = gamemodes.map(gm => `
      <label class="gamemode-choice">
        <input type="checkbox" class="player-gamemode-checkbox" value="${gm.id}">
        <span class="gamemode-choice-content">
          <img src="${gm.icon}" alt="${escapeHtml(gm.name)}" class="gamemode-choice-icon">
          <span>${escapeHtml(gm.name)}</span>
        </span>
      </label>
    `).join('');
  }

  const playerRegionContainer = document.getElementById('playerRegionSelections');
  if (playerRegionContainer) {
    playerRegionContainer.innerHTML = ['NA', 'EU', 'AS', 'SA', 'AU'].map((region) =>
      `<label class="tester-region-choice"><input type="checkbox" class="player-region-checkbox" value="${region}"> ${region}</label>`
    ).join('');
  }

  const testerContainer = document.getElementById('testerGamemodeSelections');
  if (testerContainer) {
    testerContainer.innerHTML = gamemodes.map(gm => `
      <label class="gamemode-choice">
        <input type="checkbox" class="tester-gamemode-checkbox" value="${gm.id}">
        <span class="gamemode-choice-content">
          <img src="${gm.icon}" alt="${escapeHtml(gm.name)}" class="gamemode-choice-icon">
          <span>${escapeHtml(gm.name)}</span>
        </span>
      </label>
    `).join('');
  }
}

function getSelectedValues(selector) {
  return Array.from(document.querySelectorAll(selector))
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function getSelectedPlayerQueueGamemodes() {
  return getSelectedValues('.player-gamemode-checkbox');
}

function getSelectedPlayerQueueRegions() {
  return getSelectedValues('.player-region-checkbox');
}

function formatQueueSelectionText(values = [], fallback = null, formatter = (value) => value) {
  const normalizedValues = Array.isArray(values) && values.length > 0
    ? values
    : (fallback ? [fallback] : []);

  if (!normalizedValues.length) return '-';
  return normalizedValues.map((value) => formatter(String(value))).join(', ');
}

function calculateQueueTotals(queueStats, queueEntry) {
  const gamemodes = Array.isArray(queueEntry?.gamemodes) && queueEntry.gamemodes.length > 0
    ? queueEntry.gamemodes
    : (queueEntry?.gamemode ? [queueEntry.gamemode] : []);
  const regions = Array.isArray(queueEntry?.regions) && queueEntry.regions.length > 0
    ? queueEntry.regions
    : (queueEntry?.region ? [queueEntry.region] : []);

  let playersInQueue = 0;
  let availableTesters = 0;

  gamemodes.forEach((gamemode) => {
    regions.forEach((region) => {
      playersInQueue += queueStats.playersQueued?.[gamemode]?.[region] || 0;
      availableTesters += queueStats.testersAvailable?.[gamemode]?.[region] || 0;
    });
  });

  return { playersInQueue, availableTesters };
}

async function getBlockedQueueCooldown(gamemodes) {
  for (const gamemode of gamemodes) {
    const cooldownCheck = await checkQueueCooldown(gamemode);
    if (!cooldownCheck.allowed) {
      return { gamemode, ...cooldownCheck };
    }
  }

  return null;
}

/**
 * Initialize dashboard
 */
async function initDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;

  // Authentication is already verified by auth-guard.js
  // Just verify it's still authenticated
  if (!AppState.isAuthenticated()) {
    dashboardInitialized = false;
    return; // Will be handled by auth guard
  }

  renderGamemodeSelectionControls();

  // Update loading status
  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Loading dashboard data...', 85);
  }

  // Load essential data only on page load
  await Promise.all([
    loadUserProfile(),
    checkQueueStatus(),
    checkActiveMatch(),
    checkUserWarnings()
  ]);

  configureUnifiedQueueExperience();

  await loadUserCooldowns();
  hasLoadedQueueCooldowns = true;

  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Loading gamemode activity...', 89);
  }
  await window.loadGamemodeActivityOnDemand();

  // Start cooldown timer updates
  startCooldownTimers();
  startDashboardSSE();
  startActiveMatchPolling();

  // Security hardening: avoid broad client-side Firebase reads (queue/matches/users).
  // Use backend endpoints only for dashboard state and polling.
  // (Firebase Admin SDK bypasses rules on the server; clients should not access privileged data.)

  // OPTIMIZED: Periodic refresh with exponential backoff on errors
  let refreshInterval = 30000; // Start with 30s
  let consecutiveErrors = 0;
  const maxInterval = 120000; // Max 2 minutes
  
  const refreshDashboard = async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      await Promise.all([
        loadUserProfile(),
        checkUserWarnings()
      ]);
      configureUnifiedQueueExperience();
      // Reset on success
      consecutiveErrors = 0;
      refreshInterval = 30000;
    } catch (error) {
      // If rate limited, back off more aggressively
      if (error?.message?.includes('429') || error?.status === 429) {
        consecutiveErrors++;
        refreshInterval = Math.min(refreshInterval * 1.5, maxInterval);
        return;
      }
      console.error('Dashboard refresh error:', error);
      consecutiveErrors++;
      if (consecutiveErrors > 3) {
        refreshInterval = Math.min(refreshInterval * 1.5, maxInterval);
      }
    }
  };
  
  // Start interval (don't run immediately since we just loaded everything above)
  dashboardRefreshInterval = setInterval(refreshDashboard, refreshInterval);

  // Show tier tester application banner if user doesn't have tester role
  showTierTesterBanner();
  renderStaffActionsSection();

  if (isTierTesterUser()) {
    // Update loading status
    if (window.mclbLoadingOverlay) {
      window.mclbLoadingOverlay.updateStatus('Loading tester data...', 90);
    }

    await loadSharedQueueSettings();

    // Set up stay in queue setting listener
    const stayInQueueCheckbox = document.getElementById('stayInQueueAfterMatch');
    if (stayInQueueCheckbox) {
      stayInQueueCheckbox.addEventListener('change', async () => {
        try {
          await apiService.updateProfile({
            stayInQueueAfterMatch: stayInQueueCheckbox.checked
          });
        } catch (error) {
          console.error('Error saving stay in queue setting:', error);
          // Revert the checkbox on error
          stayInQueueCheckbox.checked = !stayInQueueCheckbox.checked;
        }
      });
    }

  }

  // Signal that all initial loading is complete
  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Dashboard ready!', 100);
  }
}

async function loadSharedQueueSettings() {
  try {
    const profile = await getCachedProfile();
    const stayInQueueCheckbox = document.getElementById('stayInQueueAfterMatch');
    if (stayInQueueCheckbox) {
      stayInQueueCheckbox.checked = profile?.stayInQueueAfterMatch === true;
    }
  } catch (error) {
    console.error('Error loading shared queue settings:', error);
  }
}

function renderStaffActionsSection() {
  const card = document.getElementById('staffActionsCard');
  const intro = document.getElementById('staffActionsIntro');
  const grid = document.getElementById('staffActionsGrid');
  if (!card || !intro || !grid) return;

  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const staffRole = profile.staffRole || null;

  const actionDefs = {
    open_admin_management: { label: 'User Management', icon: 'fa-users-cog', adminTab: 'management', run: () => openAdminTabShortcut('management') },
    open_admin_moderation: { label: 'Blacklist & Applications', icon: 'fa-ban', adminTab: 'moderation', run: () => openAdminTabShortcut('moderation') },
    open_admin_reports: { label: 'Reports Review', icon: 'fa-flag', adminTab: 'reported', run: () => openAdminTabShortcut('reported') },
    open_admin_matches: { label: 'Match Manager', icon: 'fa-gamepad', adminTab: 'matches', run: () => openAdminTabShortcut('matches') },
    open_admin_operations: { label: 'Queue & Match Ops', icon: 'fa-diagram-project', adminTab: 'operations', run: () => openAdminTabShortcut('operations') },
    open_admin_security_scores: { label: 'Security Scores', icon: 'fa-shield-alt', adminTab: 'security-scores', run: () => openAdminTabShortcut('security-scores') },
    open_admin_support: { label: 'Support Tickets', icon: 'fa-life-ring', adminTab: 'support', run: () => openAdminTabShortcut('support') },
    open_admin_servers: { label: 'Whitelisted Servers', icon: 'fa-server', adminTab: 'servers', run: () => openAdminTabShortcut('servers') },
    open_admin_staff_roles: { label: 'Roles', icon: 'fa-user-shield', adminTab: 'roles', run: () => openAdminTabShortcut('roles') },
    open_moderation_chat: { label: 'Chat Reports', icon: 'fa-comments', run: () => { window.location.href = 'moderation.html?tool=moderator-chat'; } },
    open_leaderboard_moderation: { label: 'Leaderboard Filters', icon: 'fa-filter', run: () => { window.location.href = 'moderation.html?tool=leaderboard-filters'; } },
    queue_open: { label: 'Join Queue', icon: 'fa-play', run: () => document.getElementById('queueForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) },
    queue_leave: { label: 'Leave Queue', icon: 'fa-sign-out-alt', run: () => handleLeaveQueue() },
    queue_refresh: { label: 'Refresh Queue', icon: 'fa-sync-alt', run: () => checkQueueStatus() },
    load_activity: { label: 'Load Activity', icon: 'fa-chart-line', run: () => window.loadGamemodeActivityOnDemand?.() },
    load_cooldowns: { label: 'Load Cooldowns', icon: 'fa-clock', run: () => window.loadQueueCooldownsOnDemand?.() },
    open_reports_page: { label: 'Open Reports', icon: 'fa-flag', run: () => { window.location.href = 'support.html?category=player_report'; } },
    open_support_page: { label: 'Open Support', icon: 'fa-life-ring', run: () => { window.location.href = 'support.html'; } },
    open_testing_page: { label: 'Open Testing', icon: 'fa-flask', run: () => openTestingPage() }
  };

  function openAdminTabShortcut(tab) {
    window.location.href = `admin.html?tab=${encodeURIComponent(tab)}`;
  }

  const configuredActions = getDashboardRoleActionIds(profile);
  if (!configuredActions.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  const roleBadges = typeof renderRoleBadges === 'function'
    ? renderRoleBadges(profile, { size: 'sm' })
    : '';
  if (roleBadges) {
    intro.innerHTML = `<span class="role-badge-line"><span class="role-badge-line__name">Active roles</span><span class="role-badge-line__badges">${roleBadges}</span></span>`;
  } else if (staffRole) {
    const introIcon = staffRole.iconUrl
      ? `<img src="${escapeHtml(staffRole.iconUrl)}" alt="${escapeHtml(staffRole.name || 'Staff')}" class="staff-role-inline-icon-image">`
      : `<i class="${escapeHtml(staffRole.iconClass || 'fas fa-shield-alt')} staff-role-inline-icon-glyph"></i>`;
    intro.innerHTML = `Role: <strong style="color:${escapeHtml(staffRole.color || '#38bdf8')};">${introIcon}${escapeHtml(staffRole.name || 'Staff')}</strong>`;
  } else {
    intro.textContent = 'Shortcuts are available based on your current moderation permissions.';
  }

  const visibleActions = configuredActions.filter((actionId) => {
    const def = actionDefs[actionId];
    if (!def) {
      return false;
    }

    if (!def.adminTab) {
      return true;
    }

    return isDashboardAdminTabVisible(profile, def.adminTab);
  });

  if (!visibleActions.length) {
    grid.innerHTML = '<div class="text-muted">No accessible dashboard shortcuts are configured for this role.</div>';
    return;
  }

  grid.innerHTML = visibleActions.map((actionId) => {
    const def = actionDefs[actionId];
    if (!def) return '';
    return `
      <button class="btn btn-secondary" type="button" onclick="runStaffDashboardAction('${escapeHtml(actionId)}')">
        <i class="fas ${escapeHtml(def.icon)}"></i> ${escapeHtml(def.label)}
      </button>
    `;
  }).join('');

  window.runStaffDashboardAction = (actionId) => {
    if (!visibleActions.includes(actionId)) return;
    const def = actionDefs[actionId];
    if (!def || typeof def.run !== 'function') return;
    try {
      def.run();
    } catch (error) {
      console.error('Failed running staff dashboard action:', error);
    }
  };
}

function getStaffRoleCapabilities(profileOverride = null) {
  const profile = profileOverride || AppState.getProfile?.() || AppState.userProfile || {};
  const capabilitySet = new Set();
  (Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : []).forEach((capability) => capabilitySet.add(capability));
  (Array.isArray(profile?.staffRole?.capabilities) ? profile.staffRole.capabilities : []).forEach((capability) => capabilitySet.add(capability));
  return capabilitySet;
}

function hasStaffRoleCapability(capability) {
  return getStaffRoleCapabilities().has(capability);
}

function getDashboardRoleActionIds(profile = AppState.getProfile?.() || AppState.userProfile || {}) {
  const actionIds = new Set(Array.isArray(profile?.staffRole?.dashboardActions) ? profile.staffRole.dashboardActions : []);
  const capabilities = getStaffRoleCapabilities(profile);

  if (capabilities.has('moderation:chat_reports:view') || capabilities.has('moderation:chat:block')) {
    actionIds.add('open_moderation_chat');
  }
  if (capabilities.has('leaderboard:filters:manage')) {
    actionIds.add('open_leaderboard_moderation');
  }

  return [...actionIds];
}

function renderInlineIdentity(name, meta = null, roleLabel = '') {
  const safeName = escapeHtml(name || 'Unknown');
  const safeRoleLabel = roleLabel ? ` (${escapeHtml(roleLabel)})` : '';
  const badgeHtml = typeof renderRoleBadges === 'function'
    ? renderRoleBadges(meta || {}, { size: 'sm' })
    : '';
  if (!badgeHtml) {
    return `${safeName}${safeRoleLabel}`;
  }
  return `<span class="role-badge-line"><span class="role-badge-line__name">${safeName}${safeRoleLabel}</span><span class="role-badge-line__badges">${badgeHtml}</span></span>`;
}

function buildLeaderboardGamemodeFilterGrid() {
  const container = document.getElementById('leaderboardGamemodeFilterGrid');
  if (!container) return;

  container.innerHTML = (CONFIG.GAMEMODES || [])
    .filter((gamemode) => gamemode.id !== 'overall')
    .map((gamemode) => `
      <label style="display: flex; align-items: center; gap: 0.55rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border-color); border-radius: 10px; background: var(--secondary-bg);">
        <input type="checkbox" class="leaderboard-gamemode-filter" value="${escapeHtml(gamemode.id)}">
        <span>${escapeHtml(gamemode.name)}</span>
      </label>
    `)
    .join('');
}

async function loadModeratorChatReports() {
  const list = document.getElementById('moderationChatReportsList');
  if (!list || !hasStaffRoleCapability('moderation:chat_reports:view')) return;

  list.innerHTML = '<div class="text-muted">Loading chat reports...</div>';
  try {
    const response = await apiService.getModeratorChatReports('', 'pending');
    const reports = Array.isArray(response?.reports) ? response.reports.slice(0, 8) : [];

    if (reports.length === 0) {
      list.innerHTML = '<div class="text-muted">No pending chat reports right now.</div>';
      return;
    }

    list.innerHTML = reports.map((report) => {
      const reportedMessage = report?.messageReport?.reportedMessage || {};
      return `
        <div style="border: 1px solid var(--border-color); border-radius: 12px; padding: 0.9rem; background: var(--secondary-bg); margin-bottom: 0.75rem;">
          <div style="display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
            <strong>${escapeHtml(report.reportedPlayer || reportedMessage.username || 'Unknown')}</strong>
            <span class="text-muted">${escapeHtml(new Date(report.createdAt || Date.now()).toLocaleString())}</span>
          </div>
          <div class="text-muted" style="margin-top: 0.35rem;">Reported by ${escapeHtml(report.reporterEmail || 'Unknown')}</div>
          <div style="margin-top: 0.55rem; line-height: 1.55;">${escapeHtml(reportedMessage.text || report.description || 'No message preview available.')}</div>
          <div style="margin-top: 0.75rem; display: flex; gap: 0.6rem; flex-wrap: wrap;">
            <button class="btn btn-warning btn-sm" type="button" onclick="prefillModeratorChatRestriction('${escapeHtml(report.reportedPlayer || '')}', '${escapeHtml(report.reportedPlayer || '')}', 'Chat report ${escapeHtml(report.id || '')}')">
              <i class="fas fa-comment-slash"></i> Restrict Chat
            </button>
            ${report.matchId ? `<a class="btn btn-secondary btn-sm" href="testing.html?matchId=${encodeURIComponent(report.matchId)}"><i class="fas fa-external-link-alt"></i> Match</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    list.innerHTML = `<div class="alert alert-error">Failed to load chat reports: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function prefillModeratorChatRestriction(targetUserId, targetUsername, reason = '') {
  const targetInput = document.getElementById('moderationChatTarget');
  const reasonInput = document.getElementById('moderationChatReason');
  if (targetInput) {
    targetInput.value = targetUserId || targetUsername || '';
  }
  if (reasonInput && reason) {
    reasonInput.value = reason;
  }
  document.getElementById('moderationChatRestrictionForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitModeratorChatRestriction(event, { active = true } = {}) {
  event.preventDefault();

  const target = document.getElementById('moderationChatTarget')?.value?.trim() || '';
  const durationHours = parseInt(document.getElementById('moderationChatDuration')?.value || '24', 10) || 24;
  const reason = document.getElementById('moderationChatReason')?.value?.trim() || '';

  if (!target) {
    Swal.fire('Missing Player', 'Enter a player username or user ID first.', 'warning');
    return;
  }

  try {
    await apiService.setModeratorChatRestriction({
      targetUserId: target,
      targetUsername: target,
      active,
      durationHours,
      reason
    });

    if (active) {
      Swal.fire('Chat Restricted', 'The player can no longer send chat messages until the restriction expires or is removed.', 'success');
    } else {
      Swal.fire('Chat Restored', 'The chat restriction has been removed.', 'success');
    }

    await loadModeratorChatReports();
  } catch (error) {
    Swal.fire('Unable to Update Chat Restriction', error.message || 'Please try again.', 'error');
  }
}

async function clearModeratorChatRestriction() {
  const fakeEvent = { preventDefault() {} };
  await submitModeratorChatRestriction(fakeEvent, { active: false });
}

async function loadLeaderboardModerationFilters() {
  const list = document.getElementById('leaderboardModeratorList');
  if (!list || !hasStaffRoleCapability('leaderboard:filters:manage')) return;

  list.innerHTML = '<div class="text-muted">Loading leaderboard filters...</div>';
  try {
    const response = await apiService.getLeaderboardFilters();
    const entries = Array.isArray(response?.entries) ? response.entries : [];

    if (entries.length === 0) {
      list.innerHTML = '<div class="text-muted">No active leaderboard filters.</div>';
      return;
    }

    list.innerHTML = entries.map((entry) => `
      <div style="border: 1px solid var(--border-color); border-radius: 12px; padding: 0.9rem; background: var(--secondary-bg); margin-bottom: 0.75rem;">
        <div style="display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
          <strong>${escapeHtml(entry.username || entry.userId || 'Unknown')}</strong>
          <button class="btn btn-secondary btn-sm" type="button" onclick="removeLeaderboardFilter('${escapeHtml(entry.userId || '')}')">
            <i class="fas fa-trash"></i> Remove
          </button>
        </div>
        <div class="text-muted" style="margin-top: 0.35rem;">${entry.globalHidden ? 'Hidden from global leaderboard' : 'Visible globally'}</div>
        <div class="text-muted" style="margin-top: 0.25rem;">Gamemodes: ${Object.keys(entry.hiddenGamemodes || {}).length ? Object.keys(entry.hiddenGamemodes).map((gamemode) => escapeHtml(gamemode.toUpperCase())).join(', ') : 'None'}</div>
        ${entry.reason ? `<div style="margin-top: 0.45rem;">Reason: ${escapeHtml(entry.reason)}</div>` : ''}
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="alert alert-error">Failed to load leaderboard filters: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function submitLeaderboardFilter(event) {
  event.preventDefault();

  const target = document.getElementById('leaderboardFilterTarget')?.value?.trim() || '';
  const reason = document.getElementById('leaderboardFilterReason')?.value?.trim() || '';
  const globalHidden = document.getElementById('leaderboardFilterGlobal')?.checked === true;
  const gamemodes = Array.from(document.querySelectorAll('.leaderboard-gamemode-filter:checked')).map((input) => input.value);

  if (!target) {
    Swal.fire('Missing Player', 'Enter a player username or user ID first.', 'warning');
    return;
  }

  if (!globalHidden && gamemodes.length === 0) {
    Swal.fire('Nothing Selected', 'Choose global hide or at least one gamemode filter.', 'warning');
    return;
  }

  try {
    await apiService.saveLeaderboardFilter({
      targetUserId: target,
      targetUsername: target,
      globalHidden,
      gamemodes,
      reason
    });

    apiService.clearCache('/players');
    Swal.fire('Leaderboard Filter Saved', 'Leaderboard responses will now exclude that player from the selected boards.', 'success');
    await loadLeaderboardModerationFilters();
  } catch (error) {
    Swal.fire('Unable to Save Filter', error.message || 'Please try again.', 'error');
  }
}

async function removeLeaderboardFilter(userId) {
  if (!userId) return;

  try {
    await apiService.removeLeaderboardFilter(userId);
    apiService.clearCache('/players');
    await loadLeaderboardModerationFilters();
  } catch (error) {
    Swal.fire('Unable to Remove Filter', error.message || 'Please try again.', 'error');
  }
}

function renderModeratorToolsSection() {
  const card = document.getElementById('moderationToolsCard');
  if (!card) return;

  const canReviewChat = hasStaffRoleCapability('moderation:chat_reports:view');
  const canManageChat = hasStaffRoleCapability('moderation:chat:block');
  const canManageLeaderboardFilters = hasStaffRoleCapability('leaderboard:filters:manage');

  if (!canReviewChat && !canManageChat && !canManageLeaderboardFilters) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  const intro = document.getElementById('moderationToolsIntro');
  if (intro) {
    intro.textContent = canManageLeaderboardFilters && (canReviewChat || canManageChat)
      ? 'Your staff role can review chat abuse and manage who appears on public leaderboard feeds.'
      : canManageLeaderboardFilters
        ? 'Your staff role can remove players from public leaderboard responses while keeping their data accessible through direct lookups.'
        : 'Your staff role can review chat abuse reports and apply chat restrictions without opening the full admin panel.';
  }

  const chatSection = document.getElementById('moderationChatSection');
  if (chatSection) {
    chatSection.style.display = (canReviewChat || canManageChat) ? 'block' : 'none';
  }

  const leaderboardSection = document.getElementById('leaderboardModeratorSection');
  if (leaderboardSection) {
    leaderboardSection.style.display = canManageLeaderboardFilters ? 'block' : 'none';
  }

  if (canManageLeaderboardFilters) {
    buildLeaderboardGamemodeFilterGrid();
    loadLeaderboardModerationFilters();
  }

  if (canReviewChat) {
    loadModeratorChatReports();
  }
}

function focusDashboardToolFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const tool = String(params.get('tool') || '').trim().toLowerCase();
  if (!tool) return;

  const card = document.getElementById('moderationToolsCard');
  const targetId = tool === 'leaderboard-filters'
    ? 'leaderboardModeratorSection'
    : tool === 'moderator-chat'
      ? 'moderationChatSection'
      : '';
  const target = targetId ? document.getElementById(targetId) : null;

  if (!card || !target || card.style.display === 'none' || target.style.display === 'none') {
    return;
  }

  const navbar = document.querySelector('.navbar');
  const offset = (navbar ? navbar.offsetHeight : 80) + 16;
  const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  target.classList.add('dashboard-section-spotlight');
  window.setTimeout(() => target.classList.remove('dashboard-section-spotlight'), 1800);

  params.delete('tool');
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`;
  window.history.replaceState({}, '', nextUrl);
}

window.loadModeratorChatReports = loadModeratorChatReports;
window.submitModeratorChatRestriction = submitModeratorChatRestriction;
window.clearModeratorChatRestriction = clearModeratorChatRestriction;
window.loadLeaderboardModerationFilters = loadLeaderboardModerationFilters;
window.submitLeaderboardFilter = submitLeaderboardFilter;
window.removeLeaderboardFilter = removeLeaderboardFilter;

async function getCachedProfile({ forceRefresh = false } = {}) {
  try {
    const existing = AppState.getProfile?.();
    if (existing && !forceRefresh) return existing;
    const profile = await apiService.getProfile();
    if (profile) {
      AppState.setProfile(profile);
    }
    return profile;
  } catch (error) {
    console.error('Error getting profile:', error);
    return AppState.getProfile?.() || null;
  }
}

/**
 * Load notification settings from profile
 */
async function loadNotificationSettings() {
  try {
    const profile = await getCachedProfile();
    const notifySettings = profile.notificationSettings || {};
    
    const notifyMatchCreated = document.getElementById('notifyMatchCreated');
    const notifyMatchFinalized = document.getElementById('notifyMatchFinalized');
    const notifyTesterAvailable = document.getElementById('notifyTesterAvailable');
    const selectedTesterGamemodes = Array.isArray(notifySettings.testerAvailabilityGamemodes)
      ? notifySettings.testerAvailabilityGamemodes
      : [];
    
    if (notifyMatchCreated) {
      notifyMatchCreated.checked = notifySettings.notifyMatchCreated !== false; // Default true
    }
    if (notifyMatchFinalized) {
      notifyMatchFinalized.checked = notifySettings.notifyMatchFinalized !== false; // Default true
    }
    if (notifyTesterAvailable) {
      if (notifySettings.notifyTesterAvailable === true) {
        notifyTesterAvailable.checked = true;
      } else if (notifySettings.notifyTesterAvailable === false) {
        notifyTesterAvailable.checked = false;
      } else {
        // Backward compatibility: if unset, treat existing gamemode selections as enabled.
        notifyTesterAvailable.checked = selectedTesterGamemodes.length > 0;
      }
    }
    const configureBtn = document.getElementById('configureTesterNotificationsBtn');
    const saveBtn = document.getElementById('saveNotificationSettingsBtn');
    if (configureBtn) configureBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
    hasLoadedNotificationSettings = true;
  } catch (error) {
    console.error('Error loading notification settings:', error);
  }
}

function setButtonLoading(buttonId, loadingText, isLoading) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  if (isLoading) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${loadingText}`;
    return;
  }

  button.disabled = false;
  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
  }
}

window.loadNotificationSettingsOnDemand = async function loadNotificationSettingsOnDemand() {
  if (hasLoadedNotificationSettings) return;
  setButtonLoading('loadNotificationSettingsBtn', 'Loading...', true);
  try {
    await loadNotificationSettings();
  } finally {
    setButtonLoading('loadNotificationSettingsBtn', '', false);
  }
};

window.loadRecentMatchesOnDemand = async function loadRecentMatchesOnDemand() {
  if (hasLoadedRecentMatches) return;
  setButtonLoading('loadRecentMatchesBtn', 'Loading...', true);
  try {
    await loadRecentMatches();
  } finally {
    setButtonLoading('loadRecentMatchesBtn', '', false);
  }
};

window.loadGamemodeActivityOnDemand = async function loadGamemodeActivityOnDemand() {
  setButtonLoading('loadGamemodeActivityBtn', 'Loading...', true);
  try {
    if (hasLoadedGamemodeActivity) {
      await loadGamemodeStats();
      return;
    }
    await loadGamemodeStats();
    hasLoadedGamemodeActivity = true;
  } finally {
    setButtonLoading('loadGamemodeActivityBtn', '', false);
  }
};

window.loadQueueCooldownsOnDemand = async function loadQueueCooldownsOnDemand() {
  if (hasLoadedQueueCooldowns) return;
  setButtonLoading('loadQueueCooldownsBtn', 'Loading...', true);
  try {
    await loadQueueCooldowns();
    await loadUserCooldowns();
    hasLoadedQueueCooldowns = true;
  } finally {
    setButtonLoading('loadQueueCooldownsBtn', '', false);
  }
};

/**
 * Open tester availability settings modal
 * Made globally accessible for onclick handlers
 */
window.openTesterAvailabilitySettings = async function openTesterAvailabilitySettings() {
  try {
    const profile = await getCachedProfile();
    const selectedGamemodes = profile.notificationSettings?.testerAvailabilityGamemodes || [];

    const gamemodeOptions = CONFIG.GAMEMODES
      .filter(gm => gm.id !== 'overall')
      .map(gm => {
        const isSelected = selectedGamemodes.includes(gm.id);
        return `
          <div class="form-group" style="display: flex; align-items: center; padding: 0.5rem; border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 0.5rem;">
            <label style="display: flex; align-items: center; cursor: pointer; flex: 1;">
              <input type="checkbox" class="tester-gamemode-notify-checkbox" value="${gm.id}" ${isSelected ? 'checked' : ''} style="margin-right: 0.5rem;">
              <img src="${gm.icon}" alt="${gm.name}" style="width: 24px; height: 24px; margin-right: 0.5rem; border-radius: 4px;">
              <span>${gm.name}</span>
            </label>
          </div>
        `;
      }).join('');

    const result = await Swal.fire({
      title: 'Tester Availability Notifications',
      html: `
        <p class="text-muted mb-3">Select gamemodes where you want to be notified when a tier tester becomes available:</p>
        <div style="max-height: 400px; overflow-y: auto;">
          ${gamemodeOptions}
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Save',
      preConfirm: () => {
        const checkboxes = document.querySelectorAll('.tester-gamemode-notify-checkbox');
        const selected = Array.from(checkboxes)
          .filter(cb => cb.checked)
          .map(cb => cb.value);
        return selected;
      }
    });

    if (result.isConfirmed) {
      const currentProfile = await getCachedProfile();
      const notifySettings = currentProfile.notificationSettings || {};
      notifySettings.testerAvailabilityGamemodes = result.value;
      
      await apiService.updateProfile({ notificationSettings: notifySettings });
      AppState.setProfile({
        ...currentProfile,
        notificationSettings: notifySettings
      });
      
      // Request browser notification permission if not already granted
      await ensureBrowserNotificationPermission();
      
      const notifyTesterAvailable = document.getElementById('notifyTesterAvailable');
      // Send test notification if enabled and at least one gamemode is selected
      if (notifyTesterAvailable && notifyTesterAvailable.checked && result.value.length > 0) {
        try {
          const testGamemode = CONFIG.GAMEMODES.find(gm => gm.id === result.value[0] && gm.id !== 'overall');
          const gamemodeName = testGamemode ? testGamemode.name : result.value[0];
          const message = `Tester availability notifications configured! You'll be notified when a tier tester becomes available for ${gamemodeName}.`;
          
          await apiService.sendTestNotification('tester_available', message);
          
          // Trigger the notification display
          showNotification({
            type: 'tester_available',
            title: 'Test Notification',
            message: message
          });
        } catch (notifError) {
          console.error('Error sending test notification:', notifError);
          // Don't fail the save if notification fails
        }
      }
      
      Swal.fire({
        icon: 'success',
        title: 'Settings Saved',
        text: result.value.length > 0 
          ? 'Tester availability notifications updated. A test notification has been sent.'
          : 'Tester availability notifications updated.',
        timer: 2000,
        showConfirmButton: false
      });
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Save',
      text: error.message
    });
  }
}

/**
 * Save notification settings
 * Made globally accessible for onclick handlers
 */
window.saveNotificationSettings = async function saveNotificationSettings() {
  const notifyMatchCreated = document.getElementById('notifyMatchCreated');
  const notifyMatchFinalized = document.getElementById('notifyMatchFinalized');
  const notifyTesterAvailable = document.getElementById('notifyTesterAvailable');
  
  if (!notifyMatchCreated || !notifyMatchFinalized || !notifyTesterAvailable) return;

  if (!hasLoadedNotificationSettings) {
    await window.loadNotificationSettingsOnDemand();
    Swal.fire({
      icon: 'info',
      title: 'Settings Loaded',
      text: 'Review your notification toggles, then click Save again.'
    });
    return;
  }

  try {
    const profile = await getCachedProfile();
    const notifySettings = profile.notificationSettings || {};
    notifySettings.notifyMatchCreated = notifyMatchCreated.checked;
    notifySettings.notifyMatchFinalized = notifyMatchFinalized.checked;
    notifySettings.notifyTesterAvailable = notifyTesterAvailable.checked;

    await apiService.updateProfile({ notificationSettings: notifySettings });
    AppState.setProfile({
      ...profile,
      notificationSettings: notifySettings
    });
    
    // Request browser notification permission if not already granted
    await ensureBrowserNotificationPermission();
    
    // Send test notification via backend
    try {
      const testNotif = await apiService.sendTestNotification('test', 'Your notification settings have been saved successfully! If you see this, notifications are working.');
      
      // Trigger the notification display
      showNotification({
        type: 'test',
        title: 'Test Notification',
        message: 'Your notification settings have been saved successfully! If you see this, notifications are working.'
      });
    } catch (notifError) {
      console.error('Error sending test notification:', notifError);
      // Don't fail the save if notification fails
    }
    
    Swal.fire({
      icon: 'success',
      title: 'Settings Saved',
      text: 'Notification preferences updated. A test notification has been sent.',
      timer: 2000,
      showConfirmButton: false
    });
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Save',
      text: error.message
    });
  }
}

/**
 * Set up real-time notification listener
 */

// Real-time SSE connection for dashboard
let dashboardEventSource = null;
let gamemodeStatsRefreshTimeout = null;
let dashboardRealtimeRefreshTimeout = null;
let dashboardSseRetryTimeout = null;

function scheduleDashboardRealtimeRefresh({
  profile = false,
  queue = false,
  activeMatch = false,
  warnings = false,
  cooldowns = false,
  recentMatches = false,
  sharedQueueSettings = false
} = {}) {
  if (dashboardRealtimeRefreshTimeout) {
    clearTimeout(dashboardRealtimeRefreshTimeout);
  }

  dashboardRealtimeRefreshTimeout = setTimeout(async () => {
    dashboardRealtimeRefreshTimeout = null;

    try {
      const tasks = [];

      if (profile) {
        tasks.push(loadUserProfile());
      }

      if (queue) {
        tasks.push(checkQueueStatus());
      }

      if (activeMatch) {
        tasks.push(checkActiveMatch());
      }

      if (warnings) {
        tasks.push(checkUserWarnings());
      }

      if (cooldowns && hasLoadedQueueCooldowns) {
        tasks.push(loadUserCooldowns());
      }

      if (recentMatches && hasLoadedRecentMatches) {
        tasks.push(loadRecentMatches());
      }

      if (sharedQueueSettings && isTierTesterUser()) {
        tasks.push(loadSharedQueueSettings());
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
      }

      renderStaffActionsSection();
    } catch (error) {
      console.warn('Dashboard realtime refresh failed:', error);
    }
  }, 180);
}

function startDashboardSSE() {
  if (dashboardEventSource) return;
  const userId = AppState.getUserId?.() || AppState.currentUser?.uid || AppState.getProfile?.()?.uid;
  if (!userId) {
    if (!dashboardSseRetryTimeout) {
      dashboardSseRetryTimeout = setTimeout(() => {
        dashboardSseRetryTimeout = null;
        startDashboardSSE();
      }, 500);
    }
    return;
  }
  const sseUrl = `/api/user/${userId}/stream`;

  const handleEvent = (eventName, data) => {
    if (eventName === 'profile') {
      if (data.profile) {
        AppState.setProfile(data.profile);
        if (data.profile.region) {
          const preferredRegionCheckbox = document.querySelector(`.player-region-checkbox[value="${data.profile.region}"]`);
          if (preferredRegionCheckbox) {
            preferredRegionCheckbox.checked = true;
          }
        }
        if (isTierTesterUser()) {
          loadSharedQueueSettings();
        }
        scheduleDashboardRealtimeRefresh({
          profile: true,
          queue: true,
          activeMatch: true,
          warnings: true,
          cooldowns: true,
          recentMatches: true,
          sharedQueueSettings: true
        });
      }
      return;
    }

    if (eventName === 'queue') {
      updateQueueUI(data);
      scheduleDashboardRealtimeRefresh({
        profile: true,
        queue: true,
        activeMatch: true,
        recentMatches: true,
        sharedQueueSettings: true,
        cooldowns: true
      });
      return;
    }

    if (eventName === 'matchState') {
      updateMatchesUI(data);
      scheduleDashboardRealtimeRefresh({
        profile: true,
        queue: true,
        activeMatch: true,
        warnings: true,
        cooldowns: true,
        recentMatches: true,
        sharedQueueSettings: true
      });
      return;
    }

    if (eventName === 'notifications') {
      if (data.notifications) {
        handleRealtimeNotifications(data.notifications);
      }
      return;
    }

    if (eventName === 'inboxUnreadCount') {
      updateInboxBadgeRealtime(data.unreadCount || 0);
      return;
    }

    if (eventName === 'gamemodeStats') {
      const selectedRegion = document.getElementById('regionFilter')?.value || '';
      if (hasLoadedGamemodeActivity && selectedRegion === (data.region || '')) {
        loadGamemodeStats({
          success: true,
          statsByGamemode: data.statsByGamemode || {},
          generatedAt: data.generatedAt || new Date().toISOString()
        });
      } else if (hasLoadedGamemodeActivity && selectedRegion) {
        scheduleGamemodeStatsRefresh();
      }
    }
  };

  if (window.MCLBRealtimeStream?.connect) {
    const connection = window.MCLBRealtimeStream.connect({
      url: sseUrl,
      onOpen: () => {
        console.log('Dashboard SSE connected');
      },
      onEvent: (eventName, data) => {
        if (eventName === 'ping') return;
        handleEvent(eventName, data || {});
      },
      onError: (error) => {
        console.warn('Dashboard SSE error', error);
        startActiveMatchPolling();
      }
    });

    dashboardEventSource = {
      close: () => connection.close()
    };
    return;
  }

  const evtSource = new EventSource(sseUrl, { withCredentials: true });
  dashboardEventSource = evtSource;

  evtSource.onopen = () => {
    console.log('Dashboard SSE connected');
  };
  evtSource.onerror = (e) => {
    console.warn('Dashboard SSE error', e);
    dashboardEventSource = null;
  };

  ['profile', 'queue', 'matchState', 'notifications', 'inboxUnreadCount', 'gamemodeStats', 'onboarding', 'ping'].forEach((eventName) => {
    evtSource.addEventListener(eventName, (event) => {
      if (eventName === 'ping') return;
      const data = event?.data ? JSON.parse(event.data) : {};
      handleEvent(eventName, data);
    });
  });
}

function updateInboxBadgeRealtime(count) {
  const badge = document.getElementById('navInboxBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('d-none');
  } else {
    badge.classList.add('d-none');
  }
}

function scheduleGamemodeStatsRefresh(delayMs = 150) {
  if (!hasLoadedGamemodeActivity) return;
  if (gamemodeStatsRefreshTimeout) {
    clearTimeout(gamemodeStatsRefreshTimeout);
  }
  gamemodeStatsRefreshTimeout = setTimeout(() => {
    gamemodeStatsRefreshTimeout = null;
    loadGamemodeStats();
  }, delayMs);
}

function updateQueueUI(queueState) {
  checkQueueStatus(queueState);
}

function updateMatchesUI(matchState) {
  checkActiveMatch(matchState);
}

function handleRealtimeNotifications(notifications) {
  // Show new notifications as themed popups
  Object.values(notifications).forEach((n) => {
    if (!n || !n.id) return;
    if (seenNotificationIds.has(n.id)) return;
    seenNotificationIds.add(n.id);
    if (seenNotificationIds.size > MAX_SEEN_NOTIFICATIONS) {
      const iterator = seenNotificationIds.values();
      seenNotificationIds.delete(iterator.next().value);
    }
    showThemedPopup(n.title || 'Notification', n.message || 'You have a new update.');
  });
}

function showThemedPopup(title, message) {
  // Use SweetAlert2 with custom theme for consistency
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: `<span style="color:var(--primary-color)">${title}</span>`,
      html: `<div style="color:var(--text-color)">${message}</div>`,
      background: 'var(--background-color, #181a1b)',
      color: 'var(--text-color, #e0e0e0)',
      showConfirmButton: false,
      timer: 4000,
      toast: true,
      position: 'top-end',
      customClass: {
        popup: 'mclb-themed-popup',
        title: 'mclb-themed-popup-title',
        content: 'mclb-themed-popup-content'
      }
    });
  } else {
    alert(title + '\n' + message);
  }
}

/**
 * Show a browser notification
 */
async function ensureBrowserNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch (_) {
      return Notification.permission || 'default';
    }
  }
  return Notification.permission;
}

async function showNotification(notification) {
  const permission = await ensureBrowserNotificationPermission();
  if (permission === 'granted') {
    try {
      const browserNotif = new Notification(notification.title || 'Notification', {
        body: notification.message || 'You have a new update.',
        icon: '/assets/vanilla.svg',
        tag: notification.matchId || notification.id || `mclb-${Date.now()}`
      });
      browserNotif.onclick = () => {
        try {
          window.focus();
        } catch (_) {}
        if (notification.matchId) {
          window.location.href = 'testing.html';
        }
      };
    } catch (error) {
      console.warn('Browser notification failed:', error);
    }
  }

  // Also show in-page notification if possible
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: notification.title || 'Notification',
      text: notification.message || 'You have a new update.',
      timer: 5000,
      showConfirmButton: false,
      toast: true,
      position: 'top-end'
    });
  }
}

function startGamemodeStatsPolling() {
  if (gamemodeStatsInterval) clearInterval(gamemodeStatsInterval);
  gamemodeStatsInterval = null;
}

async function loadGamemodeStats(prefetchedResponse = null) {
  const listEl = document.getElementById('gamemodeStatsList');
  const updatedEl = document.getElementById('gamemodeStatsUpdated');
  const regionFilter = document.getElementById('regionFilter');
  if (!listEl) return;

  try {
    const region = regionFilter ? regionFilter.value : '';
    const resp = prefetchedResponse || await apiService.getDashboardGamemodeStats(region);
    if (!resp?.success || !resp?.statsByGamemode) {
      throw new Error(resp?.message || 'Failed to load gamemode stats');
    }

    renderGamemodeStats(resp.statsByGamemode);
    hasLoadedGamemodeActivity = true;

    if (updatedEl) {
      const t = resp.generatedAt ? new Date(resp.generatedAt) : new Date();
      updatedEl.textContent = `Updated ${t.toLocaleTimeString()}`;
    }
  } catch (error) {
    // If we get rate-limited, back off for 60 seconds
    if (error?.message?.includes('429') || error?.status === 429) {
      gamemodeStatsBackoffUntilMs = Date.now() + 60000;
      return;
    }

    console.error('Error loading gamemode stats:', error);
    listEl.innerHTML = `
      <div class="alert alert-warning">
        <i class="fas fa-exclamation-triangle"></i> Unable to load gamemode activity right now.
      </div>
    `;
  }
}

/**
 * Handle region filter change
 */
function handleRegionFilterChange() {
  if (!hasLoadedGamemodeActivity) {
    window.loadGamemodeActivityOnDemand();
    return;
  }
  loadGamemodeStats();
}

// Mobile animation state for gamemode stats
let mobileStatsAnimationInterval = null;
let currentMobileColumn = 0;

function renderGamemodeStats(statsByGamemode) {
  const listEl = document.getElementById('gamemodeStatsList');
  if (!listEl) return;

  const gamemodes = (CONFIG?.GAMEMODES || []).filter(g => g.id && g.id !== 'overall');
  if (gamemodes.length === 0) {
    listEl.innerHTML = '<div class="text-muted">No gamemodes configured.</div>';
    return;
  }

  const rowsHtml = gamemodes.map(gm => {
    const s = statsByGamemode[gm.id] || { testersAvailable: 0, playersQueued: 0, activeMatches: 0 };
    return `
      <div class="gamemode-stats-row">
        <div class="gamemode-stats-left">
          <img class="gamemode-stats-icon" src="${gm.icon}" alt="${escapeHtml(gm.name)} icon">
          <span class="gamemode-stats-name">${escapeHtml(gm.name)}</span>
        </div>
        <div class="gamemode-stats-metrics">
          <div class="gamemode-stats-metric" data-column="0">
            <span class="gamemode-stats-metric-label">Testers</span>
            <span class="gamemode-stats-metric-value">${Number(s.testersAvailable || 0)}</span>
          </div>
          <div class="gamemode-stats-metric" data-column="1">
            <span class="gamemode-stats-metric-label">Queued</span>
            <span class="gamemode-stats-metric-value">${Number(s.playersQueued || 0)}</span>
          </div>
          <div class="gamemode-stats-metric" data-column="2">
            <span class="gamemode-stats-metric-label">Matches</span>
            <span class="gamemode-stats-metric-value">${Number(s.activeMatches || 0)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = `
    <div class="gamemode-stats-grid">
      ${rowsHtml}
    </div>
  `;
  
  // Initialize mobile animation
  initMobileStatsAnimation();
}

/**
 * Initialize mobile animation for gamemode stats
 */
function initMobileStatsAnimation() {
  // Clear any existing interval
  if (mobileStatsAnimationInterval) {
    clearInterval(mobileStatsAnimationInterval);
    mobileStatsAnimationInterval = null;
  }
  
  // Only animate on mobile (screen width < 768px)
  const isMobile = window.innerWidth < 768;
  
  if (!isMobile) {
    // Show all columns on desktop
    const allMetrics = document.querySelectorAll('.gamemode-stats-metric');
    allMetrics.forEach(metric => {
      metric.style.display = 'flex';
    });
    return;
  }
  
  // Start mobile animation
  currentMobileColumn = 0;
  showMobileColumn(currentMobileColumn);
  
  // Rotate through columns every 3 seconds
  mobileStatsAnimationInterval = setInterval(() => {
    currentMobileColumn = (currentMobileColumn + 1) % 3;
    showMobileColumn(currentMobileColumn);
  }, 3000);
}

/**
 * Show specific column on mobile
 */
function showMobileColumn(columnIndex) {
  const allMetrics = document.querySelectorAll('.gamemode-stats-metric');
  
  allMetrics.forEach(metric => {
    const column = parseInt(metric.getAttribute('data-column'));
    if (column === columnIndex) {
      metric.style.display = 'flex';
      metric.style.animation = 'fadeIn 0.5s ease-in-out';
    } else {
      metric.style.display = 'none';
    }
  });
}

// Handle window resize to restart animation
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    initMobileStatsAnimation();
  }, 250);
});

/**
 * Load user profile
 */
async function loadUserProfile() {
  try {
    const profile = await getCachedProfile();

    AppState.setProfile(profile);
    if (profile?.region) {
      const preferredRegionCheckbox = document.querySelector(`.player-region-checkbox[value="${profile.region}"]`);
      if (preferredRegionCheckbox) {
        preferredRegionCheckbox.checked = true;
      }
    }
  } catch (error) {
    console.error('Error loading profile:', error);
  }
}

// Cooldown tracking for buttons
let joinQueueCooldownUntil = 0;

async function confirmAutoRequeuePreferenceBeforeJoin() {
  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const result = await Swal.fire({
    icon: 'question',
    title: 'Auto-Rejoin After Match?',
    text: 'After this match is finalized, do you want to automatically join the queue again?',
    showCancelButton: true,
    confirmButtonText: 'Yes, rejoin',
    cancelButtonText: 'No, leave queue',
    reverseButtons: true
  });

  const stayInQueueAfterMatch = result.isConfirmed === true;
  await apiService.updateProfile({ stayInQueueAfterMatch });
  AppState.setProfile({
    ...profile,
    stayInQueueAfterMatch
  });

  const stayInQueueCheckbox = document.getElementById('stayInQueueAfterMatch');
  if (stayInQueueCheckbox) {
    stayInQueueCheckbox.checked = stayInQueueAfterMatch;
  }
}

/**
 * Handle join queue
 */
async function handleJoinQueue(event) {
  event.preventDefault();
  const tierTester = isTierTesterUser();

  const now = Date.now();
  if (now < joinQueueCooldownUntil) {
    const remaining = Math.ceil((joinQueueCooldownUntil - now) / 1000);
    Swal.fire({
      icon: 'warning',
      title: 'Cooldown Active',
      text: `Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before joining the queue again.`,
      timer: 2000,
      showConfirmButton: false
    });
    return;
  }

  const gamemodes = getSelectedPlayerQueueGamemodes();
  const regions = getSelectedPlayerQueueRegions();
  const serverIP = (document.getElementById('serverIP').value || '').trim();
  const joinBtn = document.getElementById('joinQueueBtn');

  if (gamemodes.length === 0 || regions.length === 0 || !serverIP) {
    Swal.fire({
      icon: 'warning',
      title: 'Missing Fields',
      text: 'Please select at least one gamemode, one region, and a server before joining queue.'
    });
    return;
  }

  // Check if Minecraft username is linked
  if (!AppState.userProfile?.minecraftUsername) {
    Swal.fire({
      icon: 'warning',
      title: 'Minecraft Username Required',
      text: 'Please link your Minecraft username in Account settings first.',
      confirmButtonText: 'Go to Account',
      showCancelButton: true
    }).then((result) => {
      if (result.isConfirmed) {
        window.location.href = 'account.html';
      }
    });
    return;
  }

  if (!tierTester) {
    const cooldownCheck = await getBlockedQueueCooldown(gamemodes);
    if (cooldownCheck) {
      const timeLeft = formatTimeLeft(cooldownCheck.timeLeft);
      const reason = cooldownCheck.reason || 'You recently participated in a match in this gamemode.';
      Swal.fire({
        icon: 'warning',
        title: 'Queue Cooldown Active',
        html: `<p>${reason}</p><br>You can join the <strong>${cooldownCheck.gamemode.toUpperCase()}</strong> queue again in:<br><br><div style="font-size: 1.2em; font-weight: bold; color: var(--accent-color);">${timeLeft}</div>`,
        confirmButtonText: 'OK'
      });
      return;
    }
  }

  try {
    await confirmAutoRequeuePreferenceBeforeJoin();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Could Not Save Preference',
      text: error.message || 'Please try joining the queue again.'
    });
    return;
  }

  joinBtn.disabled = true;
  joinBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${tierTester ? 'Joining as tester...' : 'Joining...'}`;

  try {
    if (tierTester) {
      const availabilityResponse = await apiService.setTesterAvailability(true, gamemodes, regions, serverIP);

      if (availabilityResponse?.matched && availabilityResponse.matchId) {
        window.location.href = `testing.html?matchId=${encodeURIComponent(availabilityResponse.matchId)}`;
        return;
      }

      localStorage.setItem('queueJoinTime', Date.now());
      localStorage.setItem('queueGamemode', JSON.stringify(gamemodes));
      localStorage.setItem('queueRegion', JSON.stringify(regions));
      await checkQueueStatus();
      await loadSharedQueueSettings();
      return;
    }

    const response = await apiService.joinQueue(gamemodes, regions, serverIP);
    

    if (response.matched) {
      // Immediate match found.
      window.location.href = `testing.html?matchId=${response.matchId}`;
      return;
    } else {
      // Added to the unified queue and waiting for a compatible match.
      // Store queue join time for auto-kick functionality
      localStorage.setItem('queueJoinTime', Date.now());
      localStorage.setItem('queueGamemode', JSON.stringify(gamemodes));
      localStorage.setItem('queueRegion', JSON.stringify(regions));
      await checkQueueStatus();
      return;
    }
  } catch (error) {
    // Check if this is a skill level error
    if (error.message && error.message.includes('skill level')) {
      Swal.fire({
        icon: 'warning',
        title: 'Skill Level Required',
        text: error.message,
        confirmButtonText: 'Go to Account Settings',
        showCancelButton: true,
        cancelButtonText: 'Cancel'
      }).then((result) => {
        if (result.isConfirmed) {
          window.location.href = 'account.html#skill-levels';
        }
      });
    } else if (error?.code === 'GAMEMODE_RETIRED' || error?.data?.code === 'GAMEMODE_RETIRED') {
      Swal.fire({
        icon: 'warning',
        title: 'Gamemode Retired',
        text: error.message || 'You have retired from this gamemode and cannot join its queue.'
      });
    } else if (error.message && error.message.includes('not whitelisted')) {
      // Server IP not whitelisted error
      Swal.fire({
        icon: 'warning',
        title: 'Server Not Whitelisted',
        html: `
          <p>${error.message}</p>
          <p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.9rem;">
            Please use the "Select Server" button to choose from approved servers.
          </p>
        `,
        confirmButtonText: 'OK'
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'Failed to Join Queue',
        text: error.message
      });
    }
  } finally {
    joinBtn.disabled = false;
    joinBtn.innerHTML = `<i class="fas fa-play"></i> ${getJoinQueueButtonLabel()}`;
    updateJoinQueueButtonState();
  }
}

/**
 * Update join queue button state based on cooldown
 */
function updateJoinQueueButtonState() {
  const joinBtn = document.getElementById('joinQueueBtn');
  if (!joinBtn) return;

  const now = Date.now();
  if (now < joinQueueCooldownUntil) {
    const remaining = Math.ceil((joinQueueCooldownUntil - now) / 1000);
    joinBtn.disabled = true;
    joinBtn.innerHTML = `<i class="fas fa-clock"></i> Wait ${remaining}s`;
  } else {
    joinBtn.disabled = false;
    joinBtn.innerHTML = `<i class="fas fa-play"></i> ${getJoinQueueButtonLabel()}`;
  }
}

// Update button state every second during cooldown
if (joinQueueButtonInterval) clearInterval(joinQueueButtonInterval);
joinQueueButtonInterval = setInterval(updateJoinQueueButtonState, 1000);

/**
 * Handle leave queue
 */
async function handleLeaveQueue() {
  try {
    await apiService.leaveQueue();
    await checkQueueStatus({ inQueue: false });
    return;
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Leave Queue',
      text: error.message
    });
  }
}

// Queue waiting timer
let queueWaitingInterval = null;

/**
 * Check queue status
 */
async function checkQueueStatus(prefetchedStatus = null) {
  try {
    const status = prefetchedStatus || await apiService.getQueueStatus();

    if (status.inQueue) {
      document.getElementById('queueForm').style.display = 'none';
      document.getElementById('queueStatus').style.display = 'block';
      document.getElementById('queueGamemode').textContent = formatQueueSelectionText(status.queueEntry.gamemodes, status.queueEntry.gamemode, (value) => value.toUpperCase());
      document.getElementById('queueRegion').textContent = formatQueueSelectionText(status.queueEntry.regions, status.queueEntry.region);

      // Start waiting timer
      startQueueWaitingTimer(status.queueEntry);

      // Update queue statistics
      await updateQueueStatistics(status, !!prefetchedStatus);

      // Check for auto-kick after 5 minutes if no testers available
      checkQueueTimeout(status.queueEntry);
    } else {
      document.getElementById('queueForm').style.display = 'block';
      document.getElementById('queueStatus').style.display = 'none';

      // Clear waiting timer
      if (queueWaitingInterval) {
        clearInterval(queueWaitingInterval);
        queueWaitingInterval = null;
      }

      // Clear stored queue data when not in queue
      localStorage.removeItem('queueJoinTime');
      localStorage.removeItem('queueGamemode');
      localStorage.removeItem('queueRegion');
    }
  } catch (error) {
    console.error('Error checking queue status:', error);
  }
}

/**
 * Start timer to show waiting time
 */
function startQueueWaitingTimer(queueEntry) {
  // Clear existing timer
  if (queueWaitingInterval) {
    clearInterval(queueWaitingInterval);
  }

  const startTime = new Date(queueEntry.joinedAt || Date.now());
  const waitingTimeElement = document.getElementById('queueWaitingTime');

  queueWaitingInterval = setInterval(() => {
    const now = new Date();
    const elapsed = now - startTime;
    const minutes = Math.floor(elapsed / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

    if (minutes > 0) {
      waitingTimeElement.textContent = `Waiting ${minutes}m ${seconds}s`;
    } else {
      waitingTimeElement.textContent = `Waiting ${seconds}s`;
    }
  }, 1000);
}

/**
 * Update queue statistics display
 */
async function updateQueueStatistics(queueState, skipFallbackFetch = false) {
  try {
    const queueEntry = queueState?.queueEntry || queueState;
    const queueSummary = queueState?.queueSummary || null;

    if (queueSummary) {
      const playersInQueue = Number(queueSummary.compatiblePlayers || 0);
      const availableTesters = Number(queueSummary.compatibleTesters || 0);
      const rolePreference = queueSummary.rolePreference === 'tester' ? 'tester' : 'player';
      const position = Math.max(1, Number(queueSummary.yourPosition || 1));
      const etaMinutes = Number.isFinite(Number(queueSummary.estimatedWaitMinutes))
        ? Math.max(1, Number(queueSummary.estimatedWaitMinutes))
        : null;

      document.getElementById('queuePlayersCount').textContent = playersInQueue;
      document.getElementById('queueAvailableTesters').textContent = availableTesters;
      document.getElementById('queuePosition').textContent = position;

      const statusTextEl = document.getElementById('queueStatusText');
      const etaEl = document.getElementById('queueEta');
      const gamemodes = Array.isArray(queueEntry?.gamemodes) && queueEntry.gamemodes.length > 0
        ? queueEntry.gamemodes
        : (queueEntry?.gamemode ? [queueEntry.gamemode] : []);
      const gamemodeName = formatQueueSelectionText(gamemodes, null, (value) => {
        const gamemode = CONFIG.GAMEMODES.find((gm) => gm.id === value);
        return gamemode?.name || value.toUpperCase();
      });

      if (rolePreference === 'tester') {
        if (playersInQueue > 0) {
          if (statusTextEl) {
            statusTextEl.innerHTML = `Compatible players are queued for ${gamemodeName}`;
            statusTextEl.style.color = 'var(--success-color)';
          }
          if (etaEl) {
            etaEl.textContent = etaMinutes ? `~${etaMinutes} min` : 'Calculating...';
          }
        } else {
          if (statusTextEl) {
            statusTextEl.innerHTML = `Waiting for a compatible player in ${gamemodeName}...`;
            statusTextEl.style.color = 'var(--warning-color)';
          }
          if (etaEl) {
            etaEl.textContent = 'No players queued';
          }
        }
      } else if (availableTesters > 0) {
        if (statusTextEl) {
          statusTextEl.innerHTML = `Compatible tier testers are queued for ${gamemodeName}`;
          statusTextEl.style.color = 'var(--success-color)';
        }
        if (etaEl) {
          etaEl.textContent = etaMinutes ? `~${etaMinutes} min` : 'Calculating...';
        }
      } else {
        if (statusTextEl) {
          statusTextEl.innerHTML = `Waiting for a compatible tier tester in ${gamemodeName}...`;
          statusTextEl.style.color = 'var(--warning-color)';
        }
        if (etaEl) {
          etaEl.textContent = 'No tier testers queued';
        }
      }

      return;
    }

    // Get queue stats
    if (skipFallbackFetch) {
      document.getElementById('queuePlayersCount').textContent = '-';
      document.getElementById('queueAvailableTesters').textContent = '-';
      document.getElementById('queuePosition').textContent = '-';
      const etaElMissing = document.getElementById('queueEta');
      if (etaElMissing) etaElMissing.textContent = 'Calculating...';
      return;
    }

    const queueStats = await apiService.getQueueStats();
    const gamemodes = Array.isArray(queueEntry?.gamemodes) && queueEntry.gamemodes.length > 0
      ? queueEntry.gamemodes
      : (queueEntry?.gamemode ? [queueEntry.gamemode] : []);
    const regions = Array.isArray(queueEntry?.regions) && queueEntry.regions.length > 0
      ? queueEntry.regions
      : (queueEntry?.region ? [queueEntry.region] : []);

    if (!gamemodes.length || !regions.length) {
      document.getElementById('queuePlayersCount').textContent = '-';
      document.getElementById('queueAvailableTesters').textContent = '-';
      document.getElementById('queuePosition').textContent = '-';
      const etaElMissing = document.getElementById('queueEta');
      if (etaElMissing) etaElMissing.textContent = '-';
      return;
    }

    const { playersInQueue, availableTesters } = calculateQueueTotals(queueStats, queueEntry);
    document.getElementById('queuePlayersCount').textContent = playersInQueue;

    document.getElementById('queueAvailableTesters').textContent = availableTesters;

    // Calculate approximate queue position (simplified)
    const position = Math.max(1, Math.floor(playersInQueue / Math.max(1, availableTesters)));
    document.getElementById('queuePosition').textContent = position;

    // Update status text based on tester availability
    const statusTextEl = document.getElementById('queueStatusText');
    const etaEl = document.getElementById('queueEta');
    
    const gamemodeName = formatQueueSelectionText(gamemodes, null, (value) => {
      const gamemode = CONFIG.GAMEMODES.find((gm) => gm.id === value);
      return gamemode?.name || value.toUpperCase();
    });
    
    if (availableTesters > 0) {
      if (statusTextEl) {
        statusTextEl.innerHTML = `Compatible tier testers are queued for ${gamemodeName}`;
        statusTextEl.style.color = 'var(--success-color)';
      }
      if (etaEl) {
        const etaMinutes = Math.max(1, Math.ceil(position / Math.max(1, availableTesters)) * 2);
        etaEl.textContent = `~${etaMinutes} min`;
      }
    } else {
      if (statusTextEl) {
        statusTextEl.innerHTML = `Waiting for a compatible tier tester in ${gamemodeName}...`;
        statusTextEl.style.color = 'var(--warning-color)';
      }
      if (etaEl) {
        etaEl.textContent = 'No tier testers queued';
      }
    }

  } catch (error) {
    console.error('Error updating queue statistics:', error);
    // Set fallback values
    document.getElementById('queuePlayersCount').textContent = '-';
    document.getElementById('queueAvailableTesters').textContent = '-';
    document.getElementById('queuePosition').textContent = '-';
    const etaEl = document.getElementById('queueEta');
    if (etaEl) etaEl.textContent = '-';
  }
}

/**
 * Check for queue timeout and auto-kick if no testers available for 5 minutes
 */
async function checkQueueTimeout(queueEntry) {
  const joinTime = localStorage.getItem('queueJoinTime');
  if (!joinTime || !queueEntry) return;

  const elapsed = Date.now() - parseInt(joinTime);
  const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

  if (elapsed >= fiveMinutes) {
    try {
      const stats = await apiService.getQueueStats();
      const { availableTesters } = calculateQueueTotals(stats, queueEntry);

      if (availableTesters === 0) {
        // No testers queued and been waiting 5+ minutes - auto leave queue
        console.log('Auto-kicking from queue: no tier testers queued for 5+ minutes');

        await apiService.leaveQueue();
        const isRegularPlayer = !(typeof AppState !== 'undefined' && AppState.isTierTester && AppState.isTierTester());

        // Clear stored queue data
        localStorage.removeItem('queueJoinTime');
        localStorage.removeItem('queueGamemode');
        localStorage.removeItem('queueRegion');

        Swal.fire({
          icon: 'info',
          title: 'Auto-Left Queue',
          text: 'You were automatically removed from the queue because no compatible tier testers were queued for 5 minutes.',
          confirmButtonText: 'OK'
        });

        // Update UI
        document.getElementById('queueForm').style.display = 'block';
        document.getElementById('queueStatus').style.display = 'none';
        if (isRegularPlayer) {
          window.location.reload();
        }
      }
    } catch (error) {
      console.error('Error checking queue timeout:', error);
    }
  }
}

/**
 * Check for active match
 */
async function checkActiveMatch(prefetchedResponse = null) {
  try {
    const response = prefetchedResponse || await apiService.getActiveMatch();
    
	    if (response.hasMatch) {
	      activeMatch = response.match;
	      document.getElementById('activeMatchCard').style.display = 'block';
	      
	      const isPlayer = activeMatch.playerId === AppState.getUserId();
	      const opponent = isPlayer ? activeMatch.testerUsername : activeMatch.playerUsername;
        const opponentMeta = isPlayer ? activeMatch.testerMeta : activeMatch.playerMeta;
        const opponentRoleLabel = isPlayer ? 'Tier Tester' : 'Player';

      // Check if tester has joined
      const testerJoined = activeMatch.pagestats && activeMatch.pagestats.testerJoined;
      let countdownHtml = '';

      if (isPlayer && !testerJoined && activeMatch.testerJoinTimeout) {
        // Show countdown for player when tester hasn't joined yet
        const startedAt = new Date(activeMatch.testerJoinTimeout.startedAt);
        const timeoutMinutes = activeMatch.testerJoinTimeout.timeoutMinutes || 3;
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const endTime = new Date(startedAt.getTime() + timeoutMs);
        const now = new Date();
        const remainingMs = endTime - now;

        if (remainingMs > 0) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = remainingSeconds % 60;

          countdownHtml = `
            <div class="alert alert-warning mt-2">
              <h5><i class="fas fa-clock"></i> Waiting for Tier Tester to Join</h5>
              <p class="mb-1">Time remaining: <span id="testerCountdown">${minutes}:${seconds.toString().padStart(2, '0')}</span></p>
              <div class="progress">
                <div class="progress-bar progress-bar-striped progress-bar-animated bg-warning"
                     style="width: ${(remainingMs / timeoutMs) * 100}%"></div>
              </div>
              <small class="text-muted">If the tester doesn't join within 3 minutes, the match will be cancelled.</small>
            </div>
          `;

          // Start countdown timer
          startTesterCountdown(endTime);
        } else {
          countdownHtml = `
            <div class="alert alert-danger mt-2">
              <h5><i class="fas fa-exclamation-triangle"></i> Tester Failed to Join</h5>
              <p>The tier tester did not join within the time limit. This match will be cancelled.</p>
            </div>
          `;
        }
      }
      
	      document.getElementById('activeMatchInfo').innerHTML = `
	        <div class="alert alert-success">
	          <h4><i class="fas fa-gamepad"></i> Match Found!</h4>
	          <p><strong>Gamemode:</strong> ${activeMatch.gamemode.toUpperCase()}</p>
	          <p><strong>Opponent:</strong> ${renderInlineIdentity(opponent, opponentMeta, opponentRoleLabel)}</p>
	          <p><strong>Your Role:</strong> ${isPlayer ? 'Player' : 'Tier Tester'}</p>
	          <p><strong>Region:</strong> ${activeMatch.region}</p>
          <p><strong>Server IP:</strong> ${escapeHtml(activeMatch.serverIP)}</p>
          ${activeMatch.roleAssignment?.explanation ? `<p><strong>Role Assignment:</strong> ${escapeHtml(isPlayer ? (activeMatch.roleAssignment.playerReason || activeMatch.roleAssignment.explanation) : (activeMatch.roleAssignment.testerReason || activeMatch.roleAssignment.explanation))}</p>` : ''}
        </div>
        ${countdownHtml}
      `;
      
      openTestingPage();
    } else {
      activeMatch = null;
      document.getElementById('activeMatchCard').style.display = 'none';
    }
  } catch (error) {
    console.error('Error checking active match:', error);
  }
}

function startActiveMatchPolling() {
  if (activeMatchPollInterval) {
    clearInterval(activeMatchPollInterval);
  }

  activeMatchPollInterval = setInterval(() => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    checkActiveMatch();
  }, DASHBOARD_ACTIVE_MATCH_POLL_MS);
}

/**
 * Start countdown timer for tester join timeout
 */
let testerCountdownInterval = null;

function startTesterCountdown(endTime) {
  // Clear any existing countdown
  if (testerCountdownInterval) {
    clearInterval(testerCountdownInterval);
  }

  testerCountdownInterval = setInterval(() => {
    const now = new Date();
    const remainingMs = endTime - now;

    if (remainingMs <= 0) {
      clearInterval(testerCountdownInterval);
      testerCountdownInterval = null;
      // Refresh the active match display
      checkActiveMatch();
      return;
    }

    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;

    const countdownElement = document.getElementById('testerCountdown');
    if (countdownElement) {
      countdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

/**
 * Open testing page
 */
function openTestingPage() {
  if (!activeMatch) return;
  
  sessionStorage.setItem('testingPageOpen', 'true');
  const url = `testing.html?matchId=${activeMatch.matchId}`;
  window.location.href = url;
}

// Add player functionality removed - players are now created automatically through account linking

// ===== Dashboard Stats =====

/**
 * Load dashboard statistics
 */
async function loadDashboardStats() {
  try {
    const stats = await apiService.getDashboardStats();
    updateDashboardStats(stats);
  } catch (error) {
    console.error('Error loading dashboard stats:', error);
    // Don't show error to user, just keep default values
  }
}

/**
 * Update dashboard stats display
 */
async function updateDashboardStats(stats) {
  // Dashboard stats removed from UI; keep function safe for future reuse
  const activeMatchesEl = document.getElementById('activeMatchesCount');
  const totalQueuedEl = document.getElementById('totalQueuedPlayers');
  const totalAvailableEl = document.getElementById('totalAvailableTierTesters');

  if (activeMatchesEl) activeMatchesEl.textContent = stats.activeMatchesCount || 0;
  if (totalQueuedEl) totalQueuedEl.textContent = stats.totalQueuedPlayers || 0;
  if (totalAvailableEl) totalAvailableEl.textContent = stats.totalAvailableTierTesters || 0;

  // Update gamemode breakdown
  const gamemodeStatsContainer = document.getElementById('gamemodeStats');
  if (!gamemodeStatsContainer) return;
  const gamemodes = CONFIG.GAMEMODES.filter(gm => gm.id !== 'overall');

  // Fetch player data to show ratings
  let playerData = null;
  try {
    const players = await apiService.getPlayers();
    playerData = players.players.find(p => p.userId === AppState.getUserId());
  } catch (error) {
    console.error('Error fetching player data for gamemode breakdown:', error);
  }

  let gamemodeStatsHtml = '';

  gamemodes.forEach(gamemode => {
    const playersQueued = stats.playersQueued[gamemode.id] || 0;
    const testersAvailable = stats.testersAvailable[gamemode.id] || 0;
    const playerRating = playerData?.gamemodeRatings?.[gamemode.id] || 0;

    // Determine status text and color
    let statusText = '';
    let statusColor = '';
    
    if (testersAvailable > 0) {
      statusText = `Tier tester queued for ${gamemode.name}`;
      statusColor = 'var(--success-color)';
    } else if (playersQueued > 0) {
      statusText = `Waiting for a tier tester in ${gamemode.name}...`;
      statusColor = 'var(--warning-color)';
    } else {
      statusText = `No Queue Activity`;
      statusColor = 'var(--text-muted)';
    }

    gamemodeStatsHtml += `
      <div class="gamemode-stat-item">
        <div class="gamemode-stat-name">
          <img src="${gamemode.icon}" alt="${gamemode.name}" style="width: 20px; height: 20px; margin-right: 0.5rem;">
          ${gamemode.name} <span class="gamemode-player-rating">(${playerRating} Elo)</span>
        </div>
        <div class="gamemode-stat-status" style="color: ${statusColor}; font-size: 0.875rem; margin: 0.25rem 0;">
          ${statusText}
        </div>
        <div class="gamemode-stat-numbers">
          <div class="gamemode-stat-players">
            <div class="gamemode-stat-label">Queued</div>
            <div class="gamemode-stat-value">${playersQueued}</div>
          </div>
          <div class="gamemode-stat-testers">
            <div class="gamemode-stat-label">Tier Testers</div>
            <div class="gamemode-stat-value">${testersAvailable}</div>
          </div>
        </div>
      </div>
    `;
  });

  gamemodeStatsContainer.innerHTML = gamemodeStatsHtml;
}

/**
 * Toggle testing info section
 */
function toggleTestingInfo() {
  const content = document.getElementById('testingInfoContent');
  const toggle = document.getElementById('testingInfoToggle');

  if (content && toggle) {
    if (content.style.display === 'none' || content.style.display === '') {
      content.style.display = 'block';
      toggle.style.transform = 'rotate(180deg)';
    } else {
      content.style.display = 'none';
      toggle.style.transform = 'rotate(0deg)';
    }
  }
}

// ===== Queue Cooldown Management =====

let cooldownIntervals = {};
let userCooldowns = [];

/**
 * Start cooldown timer updates
 */
function startCooldownTimers() {
  // Update cooldowns every second (only one interval)
  if (cooldownDisplayInterval) clearInterval(cooldownDisplayInterval);
  cooldownDisplayInterval = setInterval(updateCooldownDisplays, 1000);
  // Initial update
  updateCooldownDisplays();
}

/**
 * Update all cooldown displays
 */
function updateCooldownDisplays() {
  const cooldownsContainer = document.getElementById('queueCooldowns');
  if (!cooldownsContainer) return;

  // Update remaining times for active cooldowns
  userCooldowns.forEach(cooldown => {
    cooldown.remainingMs = Math.max(0, (cooldown.remainingMs || 0) - 1000);
  });

  // Remove expired cooldowns
  userCooldowns = userCooldowns.filter(cooldown => cooldown.remainingMs > 0);

  if (userCooldowns.length === 0) {
    cooldownsContainer.innerHTML = '';
    return;
  }

  cooldownsContainer.innerHTML = `
    <div class="cooldown-dashboard-panel">
      <div class="cooldown-dashboard-header">
        <div>
          <h5 class="cooldown-title"><i class="fas fa-clock"></i> Queue Cooldowns</h5>
          <p class="cooldown-subtitle">Each timer shows the exact event that triggered the cooldown.</p>
        </div>
      </div>
      <div class="cooldown-list">
        ${userCooldowns.map(cooldown => `
          <div class="cooldown-item cooldown-item-detailed">
            <div class="cooldown-info cooldown-info-detailed">
              <div>
                <span class="cooldown-gamemode">${cooldown.gamemode.toUpperCase()}</span>
                <div class="cooldown-trigger-label">${escapeHtml(cooldown.eventLabel || 'Cooldown active')}</div>
              </div>
              <span class="cooldown-timer" id="cooldown-${cooldown.gamemode}">${formatTimeRemaining(cooldown.remainingMs)}</span>
            </div>
            <div class="cooldown-progress">
              <div class="cooldown-progress-bar" style="width: ${(cooldown.remainingMs / (30 * 60 * 1000)) * 100}%"></div>
            </div>
            <div class="cooldown-meta-row">
              <span><strong>Triggered:</strong> ${cooldown.startedAt ? new Date(cooldown.startedAt).toLocaleString() : 'Unknown'}</span>
              <span><strong>Expires:</strong> ${cooldown.expiresAt ? new Date(cooldown.expiresAt).toLocaleString() : 'Unknown'}</span>
            </div>
            <div class="cooldown-reason-text">${escapeHtml(cooldown.reason || 'Cooldown active')}</div>
          </div>
        `).join('')}
      </div>
      <div class="cooldown-note">
        <small>You cannot queue as the player for these gamemodes until the cooldown expires.</small>
      </div>
    </div>
  `;
}

/**
 * Load user cooldowns from backend
 */
async function loadUserCooldowns() {
  try {
    const response = await apiService.getUserCooldowns();
    if (response.success) {
      userCooldowns = response.cooldowns || [];
      updateCooldownDisplays();
    }
  } catch (error) {
    console.error('Error loading user cooldowns:', error);
    userCooldowns = [];
  }
}

/**
 * Check if a gamemode is on cooldown
 */
function isGamemodeOnCooldown(gamemode) {
  return userCooldowns.some(cooldown =>
    cooldown.gamemode === gamemode && cooldown.remainingMs > 0
  );
}

/**
 * Get remaining cooldown time for a gamemode
 */
function getCooldownTimeRemaining(gamemode) {
  const cooldown = userCooldowns.find(c => c.gamemode === gamemode);
  return cooldown ? cooldown.remainingMs : 0;
}

/**
 * Format time remaining as MM:SS
 */
function formatTimeRemaining(ms) {
  if (ms <= 0) return '00:00:00';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Setup HT3+ testing interface
 */
function removed_setupHT3TestingInterface() {
  const gamemodeTabs = document.getElementById('ht3GamemodeTabs');

  // Create gamemode tabs for HT3+ testing
  const gamemodes = [
    { id: 'vanilla', name: 'Vanilla', icon: 'assets/gamemodes/vanilla.png' },
    { id: 'uhc', name: 'UHC', icon: 'assets/gamemodes/uhc.png' },
    { id: 'pot', name: 'Pot', icon: 'assets/gamemodes/pot.png' },
    { id: 'nethop', name: 'Nether Hop', icon: 'assets/gamemodes/nethop.png' },
    { id: 'smp', name: 'SMP', icon: 'assets/gamemodes/smp.png' },
    { id: 'sword', name: 'Sword', icon: 'assets/gamemodes/sword.png' },
    { id: 'axe', name: 'Axe', icon: 'assets/gamemodes/axe.png' },
    { id: 'mace', name: 'Mace', icon: 'assets/gamemodes/mace.png' }
  ];

  gamemodeTabs.innerHTML = gamemodes.map(gamemode => `
    <button class="gamemode-tab-btn" onclick="selectHT3Gamemode('${gamemode.id}')">
      <img src="${gamemode.icon}" alt="${gamemode.name}" class="gamemode-icon" onerror="this.style.display='none'">
      <span>${gamemode.name}</span>
    </button>
  `).join('');
}

/**
 * Select gamemode for HT3+ testing
 */
function selectHT3Gamemode(gamemode) {
  // Update tab selection
  const tabs = document.querySelectorAll('#ht3GamemodeTabs .gamemode-tab-btn');
  tabs.forEach(tab => tab.classList.remove('active'));
  event.target.closest('.gamemode-tab-btn').classList.add('active');

  // Load available players for this gamemode
  loadAvailablePlayersForTesting(gamemode);
}

/**
 * Load players available for HT3+ testing
 */
async function loadAvailablePlayersForTesting(gamemode) {
  const availablePlayersSection = document.getElementById('availablePlayersSection');
  const availablePlayersList = document.getElementById('availablePlayersList');
  const noAvailablePlayers = document.getElementById('noAvailablePlayers');

  if (!availablePlayersSection || !availablePlayersList || !noAvailablePlayers) {
    return;
  }

  availablePlayersSection.style.display = 'block';
  availablePlayersList.innerHTML = '<p class="text-muted mt-2">HT3 browser queue access has been removed. Use backend/admin tools for this flow.</p>';
  noAvailablePlayers.style.display = 'none';
}

/**
 * Start HT3 test with a player
 */
async function startHT3Test(playerId, gamemode, playerUsername) {
  try {
    await Swal.fire({
      icon: 'info',
      title: 'HT3 Browser Flow Disabled',
      text: 'Direct HT3 queue access from the browser was removed for security. Use the backend or admin tools for this flow.'
    });
    return;

    const firstTo = CONFIG?.FIRST_TO?.[gamemode] || 3;
    // Confirm the test
    const result = await Swal.fire({
      title: 'Start HT3 Test',
      html: `
        <p>You are about to test <strong>${escapeHtml(playerUsername)}</strong> for HT3 in <strong>${gamemode.toUpperCase()}</strong>.</p>
        <p>This will be a <strong>First to ${firstTo}</strong> match.</p>
        <p>Make sure you have:</p>
        <ul style="text-align: left;">
          <li>8 Totems of Undying</li>
          <li>Proper kit setup</li>
          <li>Server information ready</li>
        </ul>
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Start Test',
      cancelButtonText: 'Cancel'
    });

    if (!result.isConfirmed) return;

    // Get server info from user
    const { value: serverInfo } = await Swal.fire({
      title: 'Server Information',
      html: `
        <div class="form-group" style="margin-bottom: 1rem;">
          <label style="display: block; margin-bottom: 0.5rem;">Server IP:</label>
          <input type="text" id="serverIP" class="form-input" placeholder="mc.server.com" style="width: 100%; padding: 0.5rem;" required>
        </div>
        <div class="form-group">
          <label style="display: block; margin-bottom: 0.5rem;">Region:</label>
          <select id="serverRegion" class="form-select" style="width: 100%; padding: 0.5rem;" required>
            <option value="">Select region...</option>
            <option value="NA">NA - North America</option>
            <option value="EU">EU - Europe</option>
            <option value="AS">AS - Asia</option>
            <option value="SA">SA - South America</option>
            <option value="AU">AU - Australia</option>
          </select>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Create Match',
      preConfirm: () => {
        const serverIP = document.getElementById('serverIP').value.trim();
        const region = document.getElementById('serverRegion').value;

        if (!serverIP || !region) {
          Swal.showValidationMessage('Please fill in all server information');
          return false;
        }

        return { serverIP, region };
      }
    });

    if (!serverInfo) return;

    // Create HT3 test match
    const matchData = {
      gamemode,
      region: serverInfo.region,
      serverIP: serverInfo.serverIP,
      ht3PlayerId: playerId,
      ht3PlayerUsername: playerUsername,
      matchType: 'ht3_test'
    };

    const response = await apiService.createHT3TestMatch(matchData);

    if (response.success) {
      window.location.href = `testing.html?matchId=${response.matchId}`;
      return;
    }

  } catch (error) {
    console.error('Error starting HT3 test:', error);
    Swal.fire({
      icon: 'error',
      title: 'Failed to Start Test',
      text: error.message
    });
  }
}

/**
 * Load player progression tracking
 */
async function loadPlayerProgression() {
  try {
    const profile = await apiService.getProfile();
    if (!profile) return;

    const players = await apiService.getPlayers();
    const playerData = players.players.find(p => p.userId === AppState.getUserId());

    if (!playerData) return;

    // Show progression card
    document.getElementById('progressionCard').style.display = 'block';

    const progressionContent = document.getElementById('progressionContent');
    let progressionHtml = '';

    // Check each gamemode - only show progression for LT3+ players
    const gamemodes = ['vanilla', 'uhc', 'pot', 'nethop', 'smp', 'sword', 'axe', 'mace'];

    gamemodes.forEach(gamemode => {
      const playerTier = playerData.gamemodeTiers?.[gamemode];
      const evaluationStatus = playerData.evaluationStatus?.[gamemode];
      const ht3Status = playerData.ht3Status?.[gamemode];

      // Only show progression for players who are LT3 or better in this gamemode
      // Tiers under LT3 are not phased according to the requirements
      const isLT3OrBetter = playerTier && !['LT5', 'HT5', 'LT4', 'HT4'].includes(playerTier);

      if (isLT3OrBetter) {
        progressionHtml += generateGamemodeProgression(gamemode, playerTier, evaluationStatus, ht3Status);
      }
    });

    if (!progressionHtml) {
      progressionHtml = `
        <div class="alert alert-info">
          <i class="fas fa-info-circle"></i>
          <strong>No testing progression yet.</strong> Join the queue to start your testing journey!
        </div>
      `;
    }

    progressionContent.innerHTML = progressionHtml;

  } catch (error) {
    console.error('Error loading player progression:', error);
  }
}

/**
 * Generate progression HTML for a specific gamemode
 */
function generateGamemodeProgression(gamemode, playerTier, evaluationStatus, ht3Status) {
  const gamemodeName = gamemode.toUpperCase();

  let progressionHtml = `
    <div class="mb-4">
      <h5 style="color: var(--accent-color); border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
        <i class="fas fa-gamepad"></i> ${gamemodeName}
      </h5>
  `;

  if (!playerTier) {
    // Show rating status
    progressionHtml += `
      <div class="alert alert-secondary">
        <strong>Status:</strong> Unranked - Join the queue to begin testing!
      </div>
    `;
  } else if (playerTier === 'LT3' && evaluationStatus === 'passed') {
    // Passed evaluation, eligible for HT3 testing
    progressionHtml += `
      <div class="alert alert-success">
        <strong>Current Tier:</strong> LT3 (Evaluation Passed)
        <br><strong>Next Step:</strong> Wait for HT3+ tester to create test match
      </div>
      <div class="progression-steps">
        <div class="step completed">
          <i class="fas fa-check"></i> Evaluation Completed
        </div>
        <div class="step current">
          <i class="fas fa-clock"></i> Awaiting HT3 Test
        </div>
        <div class="step">
          <i class="fas fa-trophy"></i> HT3 Achievement
        </div>
      </div>
    `;
  } else if (playerTier === 'LT3' && ht3Status === 'failed_attempt') {
    // Failed HT3 test, can try again
    progressionHtml += `
      <div class="alert alert-warning">
        <strong>Current Tier:</strong> LT3
        <br><strong>Status:</strong> Previous HT3 test failed - eligible for retry
      </div>
      <div class="progression-steps">
        <div class="step completed">
          <i class="fas fa-check"></i> Evaluation Completed
        </div>
        <div class="step current">
          <i class="fas fa-redo"></i> HT3 Test Available
        </div>
        <div class="step">
          <i class="fas fa-trophy"></i> HT3 Achievement
        </div>
      </div>
    `;
  } else if (playerTier === 'HT3') {
    // Achieved HT3
    progressionHtml += `
      <div class="alert alert-success">
        <strong>Current Tier:</strong> HT3 <i class="fas fa-crown" style="color: gold;"></i>
        <br><strong>Excellent rating!</strong> You have achieved a high Elo rating!
      </div>
      <div class="progression-steps">
        <div class="step completed">
          <i class="fas fa-check"></i> Evaluation Completed
        </div>
        <div class="step completed">
          <i class="fas fa-check"></i> HT3 Test Passed
        </div>
        <div class="step completed">
          <i class="fas fa-trophy"></i> HT3 Achieved
        </div>
      </div>
    `;
  } else {
    // Show rating information
    progressionHtml += `
      <div class="alert alert-info">
        <strong>Current Rating:</strong> ${playerRating} Elo
        <br><strong>Keep improving!</strong> Your rating updates automatically after each match.
      </div>
    `;
  }

  progressionHtml += '</div>';
  return progressionHtml;
}


/**
 * Toggle testing information visibility
 */
function toggleTestingInfo() {
  const body = document.getElementById('testingInfoBody');
  const toggle = document.getElementById('testingInfoToggle');

  if (body && toggle) {
    const isCollapsed = body.style.display === 'none';
    body.style.display = isCollapsed ? 'block' : 'none';
    toggle.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';

    // Store preference in localStorage
    localStorage.setItem('testingInfoCollapsed', !isCollapsed);
  }
}

// Initialize testing info state on page load
document.addEventListener('DOMContentLoaded', () => {
  const shouldCollapse = localStorage.getItem('testingInfoCollapsed') === 'true';
  if (shouldCollapse) {
    const body = document.getElementById('testingInfoBody');
    const toggle = document.getElementById('testingInfoToggle');
    if (body && toggle) {
      body.style.display = 'none';
      toggle.style.transform = 'rotate(180deg)';
    }
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (queueCheckInterval) {
    clearInterval(queueCheckInterval);
  }
  if (mobileStatsAnimationInterval) {
    clearInterval(mobileStatsAnimationInterval);
  }
  if (dashboardRefreshInterval) {
    clearInterval(dashboardRefreshInterval);
  }
  if (cooldownDisplayInterval) {
    clearInterval(cooldownDisplayInterval);
  }
  if (joinQueueButtonInterval) {
    clearInterval(joinQueueButtonInterval);
  }
  if (notificationPollInterval) {
    clearInterval(notificationPollInterval);
  }
  if (activeMatchPollInterval) {
    clearInterval(activeMatchPollInterval);
  }
  if (gamemodeStatsInterval) {
    clearInterval(gamemodeStatsInterval);
  }
  sessionStorage.removeItem('testingPageOpen');
});

window.addEventListener('beforeunload', () => {
  if (notificationPollInterval) {
    clearInterval(notificationPollInterval);
    notificationPollInterval = null;
  }
});

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboard);
} else {
  initDashboard();
}
