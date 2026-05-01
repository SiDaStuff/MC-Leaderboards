function getModerationProfile() {
  return AppState.getProfile?.() || AppState.userProfile || {};
}

function getModerationCapabilities() {
  const profile = getModerationProfile();
  const capabilitySet = new Set();
  [
    Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : [],
    Array.isArray(profile?.staffRole?.capabilities) ? profile.staffRole.capabilities : [],
    Array.isArray(profile?.verifiedStaffRole?.capabilities) ? profile.verifiedStaffRole.capabilities : []
  ].forEach((list) => list.forEach((capability) => capabilitySet.add(capability)));

  if (AppState.isAdmin?.()) {
    capabilitySet.add('moderation:chat_reports:view');
    capabilitySet.add('moderation:chat:block');
    capabilitySet.add('leaderboard:filters:manage');
    capabilitySet.add('moderation:contact_admins');
  }

  return capabilitySet;
}

function moderationCanReviewChatReports() {
  return getModerationCapabilities().has('moderation:chat_reports:view');
}

function moderationCanManageChatRestrictions() {
  return getModerationCapabilities().has('moderation:chat:block');
}

function moderationCanManageLeaderboardFilters() {
  return getModerationCapabilities().has('leaderboard:filters:manage');
}

function moderationCanContactAdmins() {
  const capabilities = getModerationCapabilities();
  return capabilities.has('moderation:contact_admins')
    || capabilities.has('moderation:chat_reports:view')
    || capabilities.has('moderation:chat:block')
    || capabilities.has('leaderboard:filters:manage');
}

function moderationHasAccess() {
  return moderationCanReviewChatReports()
    || moderationCanManageChatRestrictions()
    || moderationCanManageLeaderboardFilters()
    || moderationCanContactAdmins()
    || getModerationAdminCapabilities().size > 0;
}

function getModerationAdminCapabilities() {
  const profile = getModerationProfile();
  const capabilities = [
    ...(Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : []),
    ...(Array.isArray(profile?.staffRole?.adminCapabilities) ? profile.staffRole.adminCapabilities : []),
    ...(Array.isArray(profile?.verifiedStaffRole?.adminCapabilities) ? profile.verifiedStaffRole.adminCapabilities : [])
  ];
  return new Set(capabilities);
}

function moderationAdminHasCapability(capability) {
  const capabilities = getModerationAdminCapabilities();
  return capabilities.has('*') || capabilities.has(capability);
}

function buildStaffAdminShortcuts() {
  const card = document.getElementById('staffAdminShortcutsCard');
  const grid = document.getElementById('staffAdminShortcutsGrid');
  if (!card || !grid) return;

  const shortcuts = [
    { label: 'Tier Tester Applications', icon: 'fa-star', tab: 'moderation', requires: ['applications:manage', 'blacklist:view'] },
    { label: 'Reports', icon: 'fa-flag', tab: 'reported', requires: ['reports:manage'] },
    { label: 'Support Tickets', icon: 'fa-life-ring', tab: 'support', requires: ['users:view'] },
    { label: 'Security Scores', icon: 'fa-shield-alt', tab: 'security-scores', requires: ['audit:view', 'security_scores:view'] },
    { label: 'Send Message', icon: 'fa-envelope', tab: 'send-message', requires: ['users:manage', 'messages:send'] },
    { label: 'Blacklist', icon: 'fa-ban', tab: 'moderation', requires: ['blacklist:view'] },
    { label: 'Ban Waves', icon: 'fa-wave-square', tab: 'ban-waves', requires: ['blacklist:manage'] },
    { label: 'Bans', icon: 'fa-user-slash', tab: 'banned', requires: ['users:manage', 'bans:manage'] },
    { label: 'Punish', icon: 'fa-gavel', tab: 'punish', requires: ['blacklist:manage'] }
  ].filter((shortcut) => shortcut.requires.some((capability) => moderationAdminHasCapability(capability)));

  card.classList.toggle('is-visible', shortcuts.length > 0);
  grid.innerHTML = shortcuts.map((shortcut) => `
    <button type="button" class="btn btn-secondary" onclick="activateModerationAdminTool('${escapeHtml(shortcut.tab)}')">
      <i class="fas ${escapeHtml(shortcut.icon)}"></i> ${escapeHtml(shortcut.label)}
    </button>
  `).join('');
}

const MODERATION_ADMIN_TOOLS = [
  { id: 'moderation', label: 'Applications & Blacklist', icon: 'fa-ban', requires: ['applications:manage', 'blacklist:view', 'blacklist:manage'], load: () => window.switchModerationTab?.('tester') },
  { id: 'reported', label: 'Reports', icon: 'fa-flag', requires: ['reports:manage'], load: () => { window.switchReportsTab?.('alt'); window.loadReportedAccounts?.(); } },
  { id: 'support', label: 'Support', icon: 'fa-life-ring', requires: ['users:view'], load: () => window.loadSupportTickets?.() },
  { id: 'security-scores', label: 'Security Scores', icon: 'fa-shield-alt', requires: ['audit:view', 'security_scores:view'], load: () => window.loadSecurityScores?.() },
  { id: 'send-message', label: 'Send Message', icon: 'fa-envelope', requires: ['messages:send', 'users:manage'], load: () => {} },
  { id: 'banned', label: 'Bans', icon: 'fa-user-slash', requires: ['users:manage', 'bans:manage'], load: () => window.loadBannedAccounts?.() },
  { id: 'ban-waves', label: 'Ban Waves', icon: 'fa-wave-square', requires: ['blacklist:manage'], load: () => { window.loadBanWaves?.(); window.loadWhitelist?.(); } },
  { id: 'punish', label: 'Bulk Punish', icon: 'fa-gavel', requires: ['blacklist:manage'], load: () => window.initPunishTab?.() }
];

function canUseModerationAdminTool(tool) {
  return tool.requires.some((capability) => moderationAdminHasCapability(capability));
}

function getVisibleModerationAdminTools() {
  return MODERATION_ADMIN_TOOLS.filter(canUseModerationAdminTool);
}

function activateModerationAdminTool(toolId) {
  const tools = getVisibleModerationAdminTools();
  const tool = tools.find((entry) => entry.id === toolId) || tools[0];
  const tabs = document.getElementById('staffOperationsTabs');
  const card = document.getElementById('staffOperationsCard');
  if (!tool || !tabs || !card) return;

  card.classList.add('is-visible');
  MODERATION_ADMIN_TOOLS.forEach((entry) => {
    const panel = document.getElementById(`${entry.id}Tab`);
    if (panel) panel.classList.toggle('d-none', entry.id !== tool.id);
  });

  tabs.querySelectorAll('[data-moderation-admin-tool]').forEach((button) => {
    const active = button.getAttribute('data-moderation-admin-tool') === tool.id;
    button.classList.toggle('btn-primary', active);
    button.classList.toggle('btn-secondary', !active);
  });

  try {
    tool.load();
  } catch (error) {
    console.error('Failed loading moderation staff operation:', error);
  }
}

function buildStaffOperations() {
  const card = document.getElementById('staffOperationsCard');
  const tabs = document.getElementById('staffOperationsTabs');
  if (!card || !tabs) return;

  const tools = getVisibleModerationAdminTools();
  card.classList.toggle('is-visible', tools.length > 0);
  tabs.innerHTML = tools.map((tool) => `
    <button type="button" class="btn btn-secondary" data-moderation-admin-tool="${escapeHtml(tool.id)}" onclick="activateModerationAdminTool('${escapeHtml(tool.id)}')">
      <i class="fas ${escapeHtml(tool.icon)}"></i> ${escapeHtml(tool.label)}
    </button>
  `).join('');

  if (!tools.length) return;

  const params = new URLSearchParams(window.location.search);
  const requestedTab = String(params.get('tab') || '').trim();
  if (requestedTab && tools.some((tool) => tool.id === requestedTab)) {
    activateModerationAdminTool(requestedTab);
  } else {
    activateModerationAdminTool(tools[0].id);
  }
}

function buildModerationSummary() {
  const profile = getModerationProfile();
  const title = document.getElementById('moderationSummaryTitle');
  const text = document.getElementById('moderationSummaryText');
  const badges = document.getElementById('moderationRoleBadges');
  const badgeHtml = typeof renderRoleBadges === 'function' ? renderRoleBadges(profile) : '';
  const capabilities = [];

  if (moderationCanReviewChatReports()) capabilities.push('chat report review');
  if (moderationCanManageChatRestrictions()) capabilities.push('chat restriction controls');
  if (moderationCanManageLeaderboardFilters()) capabilities.push('leaderboard visibility filters');
  if (moderationCanContactAdmins()) capabilities.push('admin contact');

  if (title) {
    title.textContent = capabilities.length
      ? `You currently have ${capabilities.length} moderation capability${capabilities.length === 1 ? '' : 'ies'}.`
      : 'No moderation access detected.';
  }
  if (text) {
    text.textContent = capabilities.length
      ? `This page combines your active moderation tools: ${capabilities.join(', ')}.`
      : 'Your account does not currently have moderator or leaderboard moderator permissions.';
  }
  if (badges) {
    badges.innerHTML = badgeHtml || '<span class="text-muted">No staff badges available.</span>';
  }
}

function buildLeaderboardGamemodeFilterGrid() {
  const container = document.getElementById('leaderboardGamemodeFilterGrid');
  if (!container) return;

  container.innerHTML = (CONFIG.GAMEMODES || [])
    .filter((gamemode) => gamemode.id !== 'overall')
    .map((gamemode) => `
      <label style="display:flex; align-items:center; gap:0.55rem; padding:0.6rem 0.75rem; border:1px solid var(--border-color); border-radius:10px; background:var(--secondary-bg);">
        <input type="checkbox" class="leaderboard-gamemode-filter" value="${escapeHtml(gamemode.id)}">
        <span>${escapeHtml(gamemode.name)}</span>
      </label>
    `)
    .join('');
}

async function loadModerationChatReports() {
  const list = document.getElementById('moderationChatReportsList');
  if (!list || !moderationCanReviewChatReports()) return;

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
        <div style="border:1px solid var(--border-color); border-radius:12px; padding:0.9rem; background:var(--secondary-bg); margin-bottom:0.75rem;">
          <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
            <strong>${escapeHtml(report.reportedPlayer || reportedMessage.username || 'Unknown')}</strong>
            <span class="text-muted">${escapeHtml(new Date(report.createdAt || Date.now()).toLocaleString())}</span>
          </div>
          <div class="text-muted" style="margin-top:0.35rem;">Reported by ${escapeHtml(report.reporterEmail || 'Unknown')}</div>
          <div style="margin-top:0.55rem; line-height:1.55;">${escapeHtml(reportedMessage.text || report.description || 'No message preview available.')}</div>
          <div style="margin-top:0.75rem; display:flex; gap:0.6rem; flex-wrap:wrap;">
            ${moderationCanManageChatRestrictions() ? `
              <button class="btn btn-warning btn-sm" type="button" onclick="prefillModerationChatRestriction('${escapeHtml(report.reportedPlayer || '')}', '${escapeHtml(report.reportedPlayer || '')}', 'Chat report ${escapeHtml(report.id || '')}')">
                <i class="fas fa-comment-slash"></i> Restrict Chat
              </button>
            ` : ''}
            ${report.matchId ? `<a class="btn btn-secondary btn-sm" href="testing.html?matchId=${encodeURIComponent(report.matchId)}"><i class="fas fa-external-link-alt"></i> Match</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    list.innerHTML = `<div class="alert alert-error">Failed to load chat reports: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function prefillModerationChatRestriction(targetUserId, targetUsername, reason = '') {
  const targetInput = document.getElementById('moderationChatTarget');
  const reasonInput = document.getElementById('moderationChatReason');
  if (targetInput) {
    targetInput.value = targetUserId || targetUsername || '';
  }
  if (reasonInput && reason) {
    reasonInput.value = reason;
  }
}

async function submitModerationChatRestriction(event, { active = true } = {}) {
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

    Swal.fire(active ? 'Chat Restricted' : 'Chat Restored', active
      ? 'The player can no longer send chat messages until the restriction expires or is removed.'
      : 'The chat restriction has been removed.', 'success');
    await loadModerationChatReports();
  } catch (error) {
    Swal.fire('Unable to Update Chat Restriction', error.message || 'Please try again.', 'error');
  }
}

async function clearModerationChatRestriction() {
  const fakeEvent = { preventDefault() {} };
  await submitModerationChatRestriction(fakeEvent, { active: false });
}

async function loadLeaderboardModerationFilters() {
  const list = document.getElementById('leaderboardModeratorList');
  if (!list || !moderationCanManageLeaderboardFilters()) return;

  list.innerHTML = '<div class="text-muted">Loading leaderboard filters...</div>';
  try {
    const response = await apiService.getLeaderboardFilters();
    const entries = Array.isArray(response?.entries) ? response.entries : [];

    if (entries.length === 0) {
      list.innerHTML = '<div class="text-muted">No active leaderboard filters.</div>';
      return;
    }

    list.innerHTML = entries.map((entry) => `
      <div style="border:1px solid var(--border-color); border-radius:12px; padding:0.9rem; background:var(--secondary-bg); margin-bottom:0.75rem;">
        <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
          <strong>${escapeHtml(entry.username || entry.userId || 'Unknown')}</strong>
          <button class="btn btn-secondary btn-sm" type="button" onclick="removeLeaderboardFilter('${escapeHtml(entry.userId || '')}')">
            <i class="fas fa-trash"></i> Remove
          </button>
        </div>
        <div class="text-muted" style="margin-top:0.35rem;">${entry.globalHidden ? 'Hidden from global leaderboard' : 'Visible globally'}</div>
        <div class="text-muted" style="margin-top:0.25rem;">Gamemodes: ${Object.keys(entry.hiddenGamemodes || {}).length ? Object.keys(entry.hiddenGamemodes).map((gamemode) => escapeHtml(gamemode.toUpperCase())).join(', ') : 'None'}</div>
        ${entry.reason ? `<div style="margin-top:0.45rem;">Reason: ${escapeHtml(entry.reason)}</div>` : ''}
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

async function submitContactAdmins(event) {
  event.preventDefault();
  const input = document.getElementById('contactAdminsMessage');
  const btn = document.getElementById('contactAdminsBtn');
  const message = String(input?.value || '').trim();
  if (!message) {
    Swal.fire('Missing Message', 'Type a short request for the admin team first.', 'warning');
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }
    await apiService.contactAdmins(message);
    if (input) input.value = '';
    Swal.fire('Request Sent', 'Your message is now in the admin request queue.', 'success');
  } catch (error) {
    Swal.fire('Unable to Send Request', error.message || 'Please try again.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Request';
    }
  }
}

function focusModerationToolFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const tool = String(params.get('tool') || '').trim().toLowerCase();
  if (!tool) return;

  const targetId = tool === 'leaderboard-filters'
    ? 'leaderboardModerationCard'
    : tool === 'moderator-chat'
      ? 'moderationChatCard'
      : '';
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target || !target.classList.contains('is-visible')) return;

  const navbar = document.querySelector('.navbar');
  const offset = (navbar ? navbar.offsetHeight : 80) + 16;
  const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  target.classList.add('moderation-highlight');
  window.setTimeout(() => target.classList.remove('moderation-highlight'), 1800);
}

function renderModerationSections() {
  const contactCard = document.getElementById('contactAdminsCard');
  const chatCard = document.getElementById('moderationChatCard');
  const leaderboardCard = document.getElementById('leaderboardModerationCard');
  const chatIntro = document.getElementById('moderationChatIntro');
  const leaderboardIntro = document.getElementById('leaderboardModerationIntro');
  const restrictBtn = document.getElementById('moderationRestrictBtn');
  const restoreBtn = document.getElementById('moderationRestoreBtn');

  const canReviewChat = moderationCanReviewChatReports();
  const canManageChat = moderationCanManageChatRestrictions();
  const canManageLeaderboard = moderationCanManageLeaderboardFilters();
  const canContactAdmins = moderationCanContactAdmins();

  contactCard?.classList.toggle('is-visible', canContactAdmins);
  chatCard?.classList.toggle('is-visible', canReviewChat || canManageChat);
  leaderboardCard?.classList.toggle('is-visible', canManageLeaderboard);
  buildStaffAdminShortcuts();
  buildStaffOperations();

  if (chatIntro) {
    chatIntro.textContent = canManageChat
      ? 'Review pending chat reports and apply or remove chat restrictions here.'
      : 'Review pending chat reports here.';
  }
  if (leaderboardIntro) {
    leaderboardIntro.textContent = 'Manage leaderboard visibility filters here without affecting direct player lookups.';
  }
  if (restrictBtn) restrictBtn.style.display = canManageChat ? '' : 'none';
  if (restoreBtn) restoreBtn.style.display = canManageChat ? '' : 'none';

  if (canReviewChat) {
    loadModerationChatReports();
  }
  if (canManageLeaderboard) {
    buildLeaderboardGamemodeFilterGrid();
    loadLeaderboardModerationFilters();
  }
}

async function initModerationPage() {
  const authenticated = await requireAuth(false, false);
  if (!authenticated) return;

  const profile = await apiService.getProfile().catch(() => AppState.getProfile?.() || null);
  if (profile) {
    AppState.setProfile(profile);
  }

  if (!moderationHasAccess()) {
    await Swal.fire({
      icon: 'error',
      title: 'Access Denied',
      text: 'You do not currently have moderator or leaderboard moderator permissions.',
      confirmButtonText: 'Go to Account'
    });
    window.location.href = 'account.html';
    return;
  }

  buildModerationSummary();
  renderModerationSections();
  focusModerationToolFromQuery();

  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Moderation controls ready!', 100);
  }
}

window.loadModerationChatReports = loadModerationChatReports;
window.prefillModerationChatRestriction = prefillModerationChatRestriction;
window.submitModerationChatRestriction = submitModerationChatRestriction;
window.clearModerationChatRestriction = clearModerationChatRestriction;
window.loadLeaderboardModerationFilters = loadLeaderboardModerationFilters;
window.submitLeaderboardFilter = submitLeaderboardFilter;
window.removeLeaderboardFilter = removeLeaderboardFilter;
window.submitContactAdmins = submitContactAdmins;
window.activateModerationAdminTool = activateModerationAdminTool;

window.addEventListener('DOMContentLoaded', async () => {
  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Loading moderation controls...', 85);
  }
  await initModerationPage();
});
