// MC Leaderboards - Admin Panel

let currentTab = 'management';
const adminUiState = {
  blacklist: {
    page: 1,
    limit: 25,
    q: '',
    includeExpired: false,
    totalPages: 1
  },
  unifiedSearch: {
    page: 1,
    limit: 25,
    totalPages: 1,
    lastTerm: ''
  },
  rolesEditor: {
    loadedUser: null,
    searchTerm: ''
  }
};

const CLIENT_ADMIN_CAPABILITY_MATRIX = {
  owner: ['*'],
  lead_admin: ['users:view', 'users:manage', 'blacklist:view', 'blacklist:manage', 'audit:view', 'matches:view', 'matches:manage', 'reports:manage', 'disputes:manage', 'queue:inspect', 'settings:manage'],
  moderator: ['users:view', 'blacklist:view', 'blacklist:manage', 'audit:view', 'matches:view', 'reports:manage', 'disputes:manage', 'messages:send', 'security_scores:view', 'applications:manage'],
  senior_moderator: ['users:view', 'blacklist:view', 'blacklist:manage', 'audit:view', 'matches:view', 'reports:manage', 'disputes:manage', 'messages:send', 'security_scores:view', 'applications:manage', 'bans:manage'],
  support: ['users:view', 'audit:view', 'matches:view']
};

const ADMIN_TAB_REQUIREMENTS = {
  management: ['users:view'],
  moderation: ['blacklist:view', 'applications:manage'],
  reported: ['reports:manage'],
  support: ['users:view'],
  'ban-waves': ['blacklist:manage'],
  banned: ['users:manage', 'bans:manage'],
  testing: ['matches:view'],
  ratings: ['users:manage'],
  audit: ['audit:view'],
  servers: ['settings:manage'],
  matches: ['matches:view'],
  operations: ['matches:view'],
  'security-scores': ['audit:view', 'security_scores:view'],
  roles: ['users:manage'],
  'resolve': ['blacklist:manage'],
  'send-message': ['users:manage', 'messages:send'],
  'punish': ['blacklist:manage'],
  'admin-requests': ['settings:manage']
};

const STAFF_ADMIN_PANEL_TAB_REQUIREMENTS = {
  moderation: ['moderation:chat_reports:view', 'moderation:chat:block', 'leaderboard:filters:manage']
};

let staffRoleCatalog = [];
let staffRoleActionCatalog = [];
let staffRoleIconCatalog = [];

// Ban Waves state
let banWavesCatalog = [];
let banWaveAccounts = [];
let punishUsernames = [];

function getStaffRoleIconPreview(role = {}) {
  if (role.iconType === 'url' && role.iconUrl) {
    return `<img src="${escapeHtml(role.iconUrl)}" alt="${escapeHtml(role.name || 'Staff')}" class="staff-role-icon-preview-image">`;
  }

  return `<span class="staff-role-icon-preview-glyph"><i class="${escapeHtml(role.iconClass || 'fas fa-shield-alt')}"></i></span>`;
}

function isBuiltInStaffRole(role = {}) {
  return role?.builtIn === true;
}

function renderStaffRoleActionOptions() {
  const grid = document.getElementById('staffRoleActionsGrid');
  if (!grid) return;

  const actionEntries = Array.isArray(staffRoleActionCatalog) ? staffRoleActionCatalog : [];
  grid.innerHTML = actionEntries.map((action) => `
    <div class="col-12 col-md-6 col-xl-4">
      <label class="staff-role-action-option">
        <input type="checkbox" class="staff-role-action" value="${escapeHtml(action.id)}">
        <span><i class="fas ${escapeHtml(action.icon || 'fa-square')}"></i> ${escapeHtml(action.label || action.id)}</span>
      </label>
    </div>
  `).join('');
}

function renderStaffRoleIconOptions() {
  const select = document.getElementById('staffRoleIconPreset');
  if (!select) return;

  const iconEntries = Array.isArray(staffRoleIconCatalog) ? staffRoleIconCatalog : [];
  select.innerHTML = iconEntries.map((icon) => `<option value="${escapeHtml(icon.id)}">${escapeHtml(icon.label)}</option>`).join('');

  if (!select.value) {
    select.value = 'shield';
  }
}

function normalizeAdminUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function getClientAdminCapabilities() {
  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const contextCapabilities = Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : null;
  if (contextCapabilities && contextCapabilities.length > 0) {
    return contextCapabilities;
  }

  const role = typeof profile?.adminContext?.role === 'string'
    ? profile.adminContext.role
    : (typeof profile?.adminRole === 'string' ? profile.adminRole : (profile?.admin === true ? 'lead_admin' : null));
  return CLIENT_ADMIN_CAPABILITY_MATRIX[role] || [];
}

function getClientStaffCapabilities() {
  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const capabilitySet = new Set();
  [
    Array.isArray(profile?.staffRole?.capabilities) ? profile.staffRole.capabilities : [],
    Array.isArray(profile?.verifiedStaffRole?.capabilities) ? profile.verifiedStaffRole.capabilities : []
  ].forEach((list) => list.forEach((capability) => capabilitySet.add(capability)));
  return [...capabilitySet];
}

function clientAdminHasCapability(capability) {
  const capabilities = getClientAdminCapabilities();
  return capabilities.includes('*') || capabilities.includes(capability);
}

function clientStaffHasCapability(capability) {
  return getClientStaffCapabilities().includes(capability);
}

function canAccessAdminPanel() {
  return AppState.isAdmin() || getClientStaffCapabilities().length > 0;
}

function isAdminTabVisible(tab) {
  const adminRequirements = ADMIN_TAB_REQUIREMENTS[tab] || [];
  const staffRequirements = STAFF_ADMIN_PANEL_TAB_REQUIREMENTS[tab] || [];
  const hasAdminAccess = adminRequirements.length
    ? adminRequirements.some((capability) => clientAdminHasCapability(capability))
    : AppState.isAdmin();
  const hasStaffAccess = staffRequirements.some((capability) => clientStaffHasCapability(capability));
  return hasAdminAccess || hasStaffAccess;
}

function applyAdminCapabilityVisibility() {
  Object.keys(ADMIN_TAB_REQUIREMENTS).forEach((tab) => {
    const button = document.getElementById(`tab-${tab}`);
    const content = document.getElementById(`${tab}Tab`);
    const visible = isAdminTabVisible(tab);
    if (button) button.style.display = visible ? '' : 'none';
    if (content && !visible) content.classList.add('d-none');
  });

  const summary = document.getElementById('adminContextSummary');
  const chips = document.getElementById('adminCapabilityChips');
  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const role = profile?.adminContext?.role || profile?.adminRole || (profile?.admin === true ? 'lead_admin' : 'staff');
  const capabilities = getClientAdminCapabilities();

  if (summary) {
    summary.textContent = `Role: ${String(role).replace(/_/g, ' ')}${capabilities.includes('*') ? ' · Full access' : ''}`;
  }

  if (chips) {
    chips.innerHTML = capabilities.length
      ? capabilities.map((capability) => `<span class="admin-capability-chip">${escapeHtml(capability)}</span>`).join('')
      : '<span class="admin-capability-chip">No explicit capabilities</span>';
  }
}

function applyAdminCapabilitySummaryEnhancements() {
  const summary = document.getElementById('adminContextSummary');
  const chips = document.getElementById('adminCapabilityChips');
  const profile = AppState.getProfile?.() || AppState.userProfile || {};
  const role = profile?.adminContext?.role || profile?.adminRole || (profile?.admin === true ? 'lead_admin' : 'staff');
  const allCapabilities = [...new Set([...getClientAdminCapabilities(), ...getClientStaffCapabilities()])];

  if (summary) {
    const parts = [`Role: ${String(role).replace(/_/g, ' ')}`];
    if (allCapabilities.includes('*')) {
      parts.push('Full access');
    } else if (getClientStaffCapabilities().length) {
      parts.push(`Staff capabilities: ${getClientStaffCapabilities().length}`);
    }
    summary.textContent = parts.join(' · ');
  }

  if (chips) {
    chips.innerHTML = allCapabilities.length
      ? allCapabilities.map((capability) => `<span class="admin-capability-chip">${escapeHtml(capability)}</span>`).join('')
      : '<span class="admin-capability-chip">No explicit capabilities</span>';
  }
}

/**
 * Initialize admin panel
 */
async function initAdmin() {
  if (!AppState.isAuthenticated()) {
    return;
  }

  if (!canAccessAdminPanel()) {
    Swal.fire({
      icon: 'error',
      title: 'Access Denied',
      text: 'You do not have access to the admin moderation tools.',
      confirmButtonText: 'Go to Account'
    }).then(() => {
      window.location.href = 'account.html';
    });
    return;
  }

  // Update loading status
  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Loading admin panel...', 85);
  }

  applyAdminCapabilityVisibility();
  applyAdminCapabilitySummaryEnhancements();
  const params = new URLSearchParams(window.location.search);
  const requestedTab = params.get('tab') === 'staff-roles' ? 'roles' : params.get('tab');
  const defaultTab = Object.keys(ADMIN_TAB_REQUIREMENTS).find((tab) => isAdminTabVisible(tab)) || 'management';
  switchTab(requestedTab && isAdminTabVisible(requestedTab) ? requestedTab : defaultTab);
  
  // Signal that all initial loading is complete
  if (window.mclbLoadingOverlay) {
    window.mclbLoadingOverlay.updateStatus('Admin panel ready!', 100);
  }
}

/**
 * Switch tab
 */
function switchTab(tab) {
  if (tab === 'staff-roles') {
    tab = 'roles';
  }
  if (!isAdminTabVisible(tab)) {
    return;
  }

  currentTab = tab;
  
  // Update tab buttons
  document.querySelectorAll('#adminTabs button').forEach(btn => {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
  });
  const tabBtn = document.getElementById(`tab-${tab}`);
  if (tabBtn) {
    tabBtn.classList.remove('btn-secondary');
    tabBtn.classList.add('btn-primary');
  }
  
  // Show/hide tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('d-none');
  });
  const tabContent = document.getElementById(`${tab}Tab`);
  if (!tabContent) {
    console.warn(`Tab content not found for '${tab}' (expected #${tab}Tab)`);
    return;
  }
  tabContent.classList.remove('d-none');
  
  // Load tab data
  if (tab === 'management') {
    // Combined Users + Players
    // Unified search handles everything - no need to preload
    // The unifiedSearchResults div will be populated when user searches
    loadPlusCodesAdminPanel();
  } else if (tab === 'moderation') {
    if (clientAdminHasCapability('blacklist:view')) {
      loadBlacklist();
    }
    switchModerationTab('tester');
  } else if (tab === 'reported') {
    switchReportsTab('alt'); // Default to alt reports
    loadReportedAccounts();
  } else if (tab === 'ban-waves') {
    loadBanWaves();
    loadWhitelist();
  } else if (tab === 'banned') {
    loadBannedAccounts();
  } else if (tab === 'testing') {
    loadSystemStatus();
  } else if (tab === 'ratings') {
    loadGamemodeOptions();
  } else if (tab === 'audit') {
    // Load only when user clicks filter; don't spam.
  } else if (tab === 'servers') {
    loadWhitelistedServers();
  } else if (tab === 'matches') {
    loadMatches();
  } else if (tab === 'operations') {
    loadAdminDisputes();
  } else if (tab === 'security-scores') {
    loadSecurityScores();
  } else if (tab === 'roles') {
    if (adminUiState.rolesEditor.loadedUser) {
      renderRolesEditorUser(adminUiState.rolesEditor.loadedUser, adminUiState.rolesEditor.searchTerm);
    } else {
      resetRolesEditor();
    }
  } else if (tab === 'support') {
    loadSupportTickets();
  } else if (tab === 'punish') {
    initPunishTab();
  } else if (tab === 'admin-requests') {
    loadModeratorAdminRequests();
  }

}

function resetStaffRoleForm() {
  const roleIdEl = document.getElementById('staffRoleId');
  const roleNameEl = document.getElementById('staffRoleName');
  const roleColorEl = document.getElementById('staffRoleColor');
  const rolePresetEl = document.getElementById('staffRoleIconPreset');
  const roleUrlEl = document.getElementById('staffRoleIconUrl');
  if (roleIdEl) roleIdEl.value = '';
  if (roleNameEl) roleNameEl.value = '';
  if (roleColorEl) roleColorEl.value = '#38bdf8';
  if (rolePresetEl) rolePresetEl.value = 'shield';
  if (roleUrlEl) roleUrlEl.value = '';
  document.querySelectorAll('.staff-role-action').forEach((cb) => {
    cb.checked = false;
  });
}

function getSelectedStaffRoleActions() {
  return Array.from(document.querySelectorAll('.staff-role-action:checked')).map((el) => el.value);
}

function populateStaffRoleAssignments() {
  const assignSelect = document.getElementById('assignStaffRoleId');
  if (!assignSelect) return;
  assignSelect.innerHTML = '<option value="">Remove staff role</option>';
  staffRoleCatalog.forEach((role) => {
    const option = document.createElement('option');
    option.value = role.id;
    option.textContent = role.name;
    assignSelect.appendChild(option);
  });
}

function renderStaffRoleList() {
  const container = document.getElementById('staffRolesList');
  if (!container) return;

  if (!Array.isArray(staffRoleCatalog) || staffRoleCatalog.length === 0) {
    container.innerHTML = '<div class="empty-state"><p class="text-muted">No staff roles created yet.</p></div>';
    return;
  }

  container.innerHTML = staffRoleCatalog.map((role) => `
    <div class="card mb-2">
      <div class="card-body" style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.4rem;">
            ${getStaffRoleIconPreview(role)}
            <strong style="color:${escapeHtml(role.color || '#38bdf8')};">${escapeHtml(role.name || role.id)}</strong>
            <span class="text-muted" style="font-size:0.8rem;">${escapeHtml(role.id)}</span>
            ${isBuiltInStaffRole(role) ? '<span class="badge badge-info">Built-in</span>' : ''}
          </div>
          <div class="text-muted" style="font-size:0.85rem;">Actions: ${(role.dashboardActions || []).map(escapeHtml).join(', ') || 'None'}</div>
        </div>
        <div style="display:flex; gap:0.5rem;">
          ${isBuiltInStaffRole(role)
            ? '<span class="text-muted" style="font-size:0.85rem;">Assignable, but managed by the system.</span>'
            : `
              <button class="btn btn-secondary btn-sm" onclick="editStaffRole('${escapeHtml(role.id)}')"><i class="fas fa-pen"></i> Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteStaffRole('${escapeHtml(role.id)}')"><i class="fas fa-trash"></i> Delete</button>
            `}
        </div>
      </div>
    </div>
  `).join('');
}

async function loadStaffRoles() {
  const container = document.getElementById('staffRolesList');
  if (container) container.innerHTML = '<div class="spinner"></div>';
  try {
    const response = await apiService.getStaffRoles();
    staffRoleCatalog = Array.isArray(response?.roles) ? response.roles : [];
    staffRoleActionCatalog = Array.isArray(response?.actionCatalog) ? response.actionCatalog : [];
    staffRoleIconCatalog = Array.isArray(response?.badgePresets) ? response.badgePresets : [];
    renderStaffRoleActionOptions();
    renderStaffRoleIconOptions();
    populateStaffRoleAssignments();
    renderStaffRoleList();
  } catch (error) {
    if (container) {
      container.innerHTML = `<div class="alert alert-danger">Failed to load staff roles: ${escapeHtml(error.message || 'Unknown error')}</div>`;
    }
  }
}

window.handleSaveStaffRole = async function handleSaveStaffRole(event) {
  event.preventDefault();
  const roleId = (document.getElementById('staffRoleId')?.value || '').trim();
  const roleName = (document.getElementById('staffRoleName')?.value || '').trim();
  const roleColor = (document.getElementById('staffRoleColor')?.value || '').trim();
  const iconPreset = (document.getElementById('staffRoleIconPreset')?.value || '').trim();
  const iconUrl = (document.getElementById('staffRoleIconUrl')?.value || '').trim();
  const dashboardActions = getSelectedStaffRoleActions();

  if (!roleName || roleName.length < 2) {
    Swal.fire({ icon: 'warning', title: 'Invalid Role', text: 'Role name must be at least 2 characters.' });
    return;
  }

  const payload = {
    id: roleId || roleName,
    name: roleName,
    color: roleColor,
    iconPreset,
    iconUrl,
    dashboardActions
  };

  const existingRole = roleId
    ? staffRoleCatalog.find((item) => item.id === roleId)
    : null;
  if (isBuiltInStaffRole(existingRole)) {
    Swal.fire({ icon: 'info', title: 'Built-in Role', text: 'Built-in roles are managed automatically and cannot be edited here.' });
    return;
  }

  try {
    if (roleId) {
      await apiService.updateStaffRole(roleId, payload);
      Swal.fire({ icon: 'success', title: 'Role Updated', timer: 1200, showConfirmButton: false });
    } else {
      await apiService.createStaffRole(payload);
      Swal.fire({ icon: 'success', title: 'Role Created', timer: 1200, showConfirmButton: false });
    }
    resetStaffRoleForm();
    await loadStaffRoles();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Save Failed', text: error.message || 'Unable to save role.' });
  }
};

window.editStaffRole = function editStaffRole(roleId) {
  const role = staffRoleCatalog.find((item) => item.id === roleId);
  if (!role) return;
  if (isBuiltInStaffRole(role)) {
    Swal.fire({ icon: 'info', title: 'Built-in Role', text: 'This built-in role can be assigned to users, but it is not editable from the admin panel.' });
    return;
  }

  document.getElementById('staffRoleId').value = role.id;
  document.getElementById('staffRoleName').value = role.name || '';
  document.getElementById('staffRoleColor').value = role.color || '#38bdf8';
  document.getElementById('staffRoleIconPreset').value = role.iconType === 'preset' ? (role.iconValue || 'shield') : 'shield';
  document.getElementById('staffRoleIconUrl').value = role.iconType === 'url' ? (role.iconValue || '') : '';

  const actionSet = new Set(role.dashboardActions || []);
  document.querySelectorAll('.staff-role-action').forEach((checkbox) => {
    checkbox.checked = actionSet.has(checkbox.value);
  });
};

window.deleteStaffRole = async function deleteStaffRole(roleId) {
  const role = staffRoleCatalog.find((item) => item.id === roleId);
  if (isBuiltInStaffRole(role)) {
    Swal.fire({ icon: 'info', title: 'Built-in Role', text: 'This built-in role is part of the system and cannot be deleted.' });
    return;
  }

  const confirm = await Swal.fire({
    icon: 'warning',
    title: 'Delete role?',
    text: 'Users with this role will have their staff role removed.',
    showCancelButton: true,
    confirmButtonText: 'Delete',
    cancelButtonText: 'Cancel'
  });
  if (!confirm.isConfirmed) return;

  try {
    await apiService.deleteStaffRole(roleId);
    await loadStaffRoles();
    Swal.fire({ icon: 'success', title: 'Role Deleted', timer: 1200, showConfirmButton: false });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Delete Failed', text: error.message || 'Unable to delete role.' });
  }
};

window.handleAssignStaffRole = async function handleAssignStaffRole(event) {
  event.preventDefault();
  const userId = (document.getElementById('assignStaffUserId')?.value || '').trim();
  const roleId = (document.getElementById('assignStaffRoleId')?.value || '').trim();
  if (!userId) {
    Swal.fire({ icon: 'warning', title: 'Missing UID', text: 'Enter a valid user UID.' });
    return;
  }

  try {
    await apiService.setUserStaffRole(userId, roleId || null);
    Swal.fire({ icon: 'success', title: 'Staff Role Updated', timer: 1200, showConfirmButton: false });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Assignment Failed', text: error.message || 'Unable to assign role.' });
  }
};

window.resetStaffRoleForm = resetStaffRoleForm;

function getBuiltinRoleIdsForUser(user = {}) {
  const roleIds = new Set();
  const legacyRoleId = String(user?.staffRoleId || '').trim();
  if (legacyRoleId === 'moderator' || legacyRoleId === 'leaderboard-moderator' || legacyRoleId === 'senior-moderator') {
    roleIds.add(legacyRoleId);
  }
  (Array.isArray(user?.builtinStaffRoleIds) ? user.builtinStaffRoleIds : []).forEach((roleId) => {
    const normalizedRoleId = String(roleId || '').trim();
    if (normalizedRoleId === 'moderator' || normalizedRoleId === 'leaderboard-moderator' || normalizedRoleId === 'senior-moderator') {
      roleIds.add(normalizedRoleId);
    }
  });
  return [...roleIds];
}

function resetRolesEditor() {
  adminUiState.rolesEditor.loadedUser = null;
  const summary = document.getElementById('rolesEditorSummary');
  const form = document.getElementById('rolesEditorForm');
  const userIdInput = document.getElementById('rolesEditorUserId');
  const tierTesterInput = document.getElementById('rolesEditorTierTester');
  const leaderboardInput = document.getElementById('rolesEditorLeaderboardModerator');
  const moderatorInput = document.getElementById('rolesEditorModerator');
  const seniorModeratorInput = document.getElementById('rolesEditorSeniorModerator');

  if (userIdInput) userIdInput.value = '';
  if (tierTesterInput) tierTesterInput.checked = false;
  if (leaderboardInput) leaderboardInput.checked = false;
  if (moderatorInput) moderatorInput.checked = false;
  if (seniorModeratorInput) seniorModeratorInput.checked = false;
  if (form) form.classList.add('d-none');
  if (summary) {
    summary.innerHTML = '<p class="text-muted">Load a user to edit Tier Tester, Leaderboard Mod, Moderator, and Senior Moderator access.</p>';
  }
}

function pickBestRoleUserMatch(users = [], searchTerm = '') {
  const normalizedSearchTerm = String(searchTerm || '').trim().toLowerCase();
  if (!normalizedSearchTerm) {
    return users[0] || null;
  }

  return users.find((user) => String(user?.id || '').trim().toLowerCase() === normalizedSearchTerm)
    || users.find((user) => String(user?.email || '').trim().toLowerCase() === normalizedSearchTerm)
    || users.find((user) => String(user?.minecraftUsername || '').trim().toLowerCase() === normalizedSearchTerm)
    || users[0]
    || null;
}

function renderRolesEditorUser(user = {}, searchTerm = '') {
  const summary = document.getElementById('rolesEditorSummary');
  const form = document.getElementById('rolesEditorForm');
  const userIdInput = document.getElementById('rolesEditorUserId');
  const tierTesterInput = document.getElementById('rolesEditorTierTester');
  const leaderboardInput = document.getElementById('rolesEditorLeaderboardModerator');
  const moderatorInput = document.getElementById('rolesEditorModerator');
  const seniorModeratorInput = document.getElementById('rolesEditorSeniorModerator');
  const builtinRoleIds = getBuiltinRoleIdsForUser(user);
  const hasCustomStaffRole = Boolean(user?.staffRoleId) && !builtinRoleIds.includes(String(user.staffRoleId));
  const summaryBadges = [];
  if (typeof buildStaticRoleBadge === 'function') {
    if (user?.tester === true || user?.tierTester === true) {
      summaryBadges.push(buildStaticRoleBadge('Tier Tester', 'tester', '<i class="fas fa-check"></i>'));
    }
    if (builtinRoleIds.includes('leaderboard-moderator')) {
      summaryBadges.push(buildStaticRoleBadge('Leaderboard Moderator', 'leaderboard-moderator', '<i class="fas fa-filter"></i>'));
    }
    if (builtinRoleIds.includes('moderator')) {
      summaryBadges.push(buildStaticRoleBadge('Moderator', 'moderator', '<i class="fas fa-shield-alt"></i>'));
    }
    if (builtinRoleIds.includes('senior-moderator')) {
      summaryBadges.push(buildStaticRoleBadge('Senior Moderator', 'senior-moderator', '<i class="fas fa-shield-alt"></i>'));
    }
  }

  adminUiState.rolesEditor.loadedUser = user;
  adminUiState.rolesEditor.searchTerm = searchTerm;

  if (summary) {
    summary.innerHTML = `
      <div class="card" style="margin-bottom: 1rem;">
        <div class="card-body" style="display:grid; gap:0.65rem;">
          <div style="display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; flex-wrap:wrap;">
            <div>
              <strong>${escapeHtml(user?.minecraftUsername || 'Unknown User')}</strong>
              <div class="text-muted">${escapeHtml(user?.email || 'No email on file')}</div>
              <div class="text-muted" style="font-size:0.85rem;">UID: ${escapeHtml(user?.id || '')}</div>
            </div>
            <div style="display:flex; gap:0.45rem; flex-wrap:wrap;">
              ${summaryBadges.join('')}
            </div>
          </div>
          ${hasCustomStaffRole ? `<div class="alert alert-info" style="margin:0;">Custom staff role <strong>${escapeHtml(user?.staffRole?.name || user.staffRoleId)}</strong> stays assigned separately.</div>` : ''}
        </div>
      </div>
    `;
  }

  if (userIdInput) userIdInput.value = user?.id || '';
  if (tierTesterInput) tierTesterInput.checked = user?.tester === true || user?.tierTester === true;
  if (leaderboardInput) leaderboardInput.checked = builtinRoleIds.includes('leaderboard-moderator');
  if (moderatorInput) moderatorInput.checked = builtinRoleIds.includes('moderator');
  if (seniorModeratorInput) seniorModeratorInput.checked = builtinRoleIds.includes('senior-moderator');
  if (form) form.classList.remove('d-none');
}

async function loadRolesEditorUser(event) {
  event?.preventDefault?.();
  const input = document.getElementById('rolesLookupInput');
  const summary = document.getElementById('rolesEditorSummary');
  const searchTerm = String(input?.value || '').trim();
  if (!searchTerm) {
    Swal.fire({ icon: 'warning', title: 'Missing Search', text: 'Enter an email or Firebase UID first.' });
    return;
  }

  if (summary) {
    summary.innerHTML = '<div class="spinner"></div>';
  }
  document.getElementById('rolesEditorForm')?.classList.add('d-none');

  try {
    const response = await apiService.searchUsers(searchTerm, { limit: 10 });
    const users = Array.isArray(response?.users) ? response.users : [];
    const user = pickBestRoleUserMatch(users, searchTerm);

    if (!user) {
      resetRolesEditor();
      if (summary) {
        summary.innerHTML = '<p class="text-muted">No user matched that email or UID.</p>';
      }
      return;
    }

    renderRolesEditorUser(user, searchTerm);
  } catch (error) {
    resetRolesEditor();
    if (summary) {
      summary.innerHTML = `<div class="alert alert-danger">Unable to load roles: ${escapeHtml(error.message || 'Unknown error')}</div>`;
    }
  }
}

async function saveRolesEditor(event) {
  event?.preventDefault?.();
  const userId = String(document.getElementById('rolesEditorUserId')?.value || '').trim();
  if (!userId) {
    Swal.fire({ icon: 'warning', title: 'No User Loaded', text: 'Load a user before saving role changes.' });
    return;
  }

  const tierTesterEnabled = document.getElementById('rolesEditorTierTester')?.checked === true;
  const builtinRoleIds = [];
  if (document.getElementById('rolesEditorLeaderboardModerator')?.checked === true) {
    builtinRoleIds.push('leaderboard-moderator');
  }
  if (document.getElementById('rolesEditorModerator')?.checked === true) {
    builtinRoleIds.push('moderator');
  }
  if (document.getElementById('rolesEditorSeniorModerator')?.checked === true) {
    builtinRoleIds.push('senior-moderator');
  }

  try {
    await Promise.all([
      apiService.setTesterStatus(userId, tierTesterEnabled),
      apiService.setUserBuiltinStaffRoles(userId, builtinRoleIds)
    ]);

    const updatedUser = {
      ...(adminUiState.rolesEditor.loadedUser || {}),
      id: userId,
      tester: tierTesterEnabled,
      tierTester: tierTesterEnabled,
      builtinStaffRoleIds: builtinRoleIds
    };
    adminUiState.rolesEditor.loadedUser = updatedUser;
    renderRolesEditorUser(updatedUser, adminUiState.rolesEditor.searchTerm);
    Swal.fire({ icon: 'success', title: 'Roles Updated', timer: 1200, showConfirmButton: false });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Save Failed', text: error.message || 'Unable to save role changes.' });
  }
}

window.resetRolesEditor = resetRolesEditor;
window.loadRolesEditorUser = loadRolesEditorUser;
window.saveRolesEditor = saveRolesEditor;

function sanitizePlusCodeInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

async function loadPlusCodesAdminPanel() {
  const listEl = document.getElementById('plusCodesAdminList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="spinner"></div>';
  try {
    const response = await apiService.adminListPlusCodes(false);
    const codes = Array.isArray(response?.codes) ? response.codes : [];

    if (codes.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p class="text-muted">No active Plus codes.</p></div>';
      return;
    }

    listEl.innerHTML = `
      <div style="display:grid; gap:0.5rem;">
        ${codes.slice(0, 100).map((entry) => `
          <div class="card" style="border:1px solid var(--border-color);">
            <div class="card-body" style="padding:0.75rem; display:flex; justify-content:space-between; gap:0.75rem; flex-wrap:wrap; align-items:center;">
              <div>
                <div style="font-weight:800; letter-spacing:0.12em;">${escapeHtml(entry.code || '')}</div>
                <div class="text-muted" style="font-size:0.85rem;">
                  Years: ${Number(entry.years || 1)} | Source: ${escapeHtml(entry.source || 'admin')} | Used: ${entry.used === true ? 'Yes' : 'No'}
                </div>
                <div class="text-muted" style="font-size:0.8rem;">
                  ${entry.assignedUserId ? `Assigned: ${escapeHtml(entry.assignedUserId)}` : 'Assigned: any user'}
                </div>
              </div>
              <button class="btn btn-danger btn-sm" onclick="removePlusCodeAdmin('${escapeHtml(entry.code || '')}')" ${entry.used === true ? 'disabled' : ''}>
                <i class="fas fa-trash"></i> Remove
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (error) {
    listEl.innerHTML = `<div class="alert alert-danger">Failed to load Plus codes: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

window.handleCreatePlusCode = async function handleCreatePlusCode(event) {
  event.preventDefault();

  const codeInput = document.getElementById('plusCodeValue');
  const yearsInput = document.getElementById('plusCodeYears');
  const uidInput = document.getElementById('plusCodeAssignedUserId');
  const noteInput = document.getElementById('plusCodeNote');

  const code = sanitizePlusCodeInput(codeInput?.value || '');
  if (codeInput) codeInput.value = code;

  if (code && !/^\d{6}$/.test(code)) {
    Swal.fire({ icon: 'error', title: 'Invalid code', text: 'Code must be exactly 6 digits.' });
    return;
  }

  const years = Math.max(1, Math.min(5, parseInt(yearsInput?.value || '1', 10) || 1));
  if (yearsInput) yearsInput.value = String(years);

  try {
    const response = await apiService.adminCreatePlusCode({
      code: code || null,
      years,
      assignedUserId: (uidInput?.value || '').trim() || null,
      note: (noteInput?.value || '').trim()
    });

    Swal.fire({
      icon: 'success',
      title: 'Code created',
      html: `New code: <strong style="letter-spacing:0.12em;">${escapeHtml(response?.code?.code || '')}</strong>`
    });

    if (codeInput) codeInput.value = '';
    if (uidInput) uidInput.value = '';
    if (noteInput) noteInput.value = '';
    await loadPlusCodesAdminPanel();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Create failed', text: error.message || 'Failed to create code.' });
  }
};

window.removePlusCodeAdmin = async function removePlusCodeAdmin(code) {
  const normalized = sanitizePlusCodeInput(code);
  if (!/^\d{6}$/.test(normalized)) return;

  const confirmation = await Swal.fire({
    icon: 'warning',
    title: 'Remove this code?',
    text: `Code ${normalized} will be disabled and can no longer be redeemed.`,
    showCancelButton: true,
    confirmButtonText: 'Remove',
    cancelButtonText: 'Cancel'
  });
  if (!confirmation.isConfirmed) return;

  try {
    await apiService.adminRemovePlusCode(normalized);
    await loadPlusCodesAdminPanel();
    Swal.fire({ icon: 'success', title: 'Removed', text: 'Code removed successfully.' });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Remove failed', text: error.message || 'Unable to remove code.' });
  }
};

/**
 * Load applications
 */
async function loadApplications() {
  const listDiv = document.getElementById('applicationsList');
  listDiv.innerHTML = '<div class="spinner"></div>';
  
  try {
    const response = await apiService.getApplications();
    
    if (!response || !response.applications) {
      throw new Error('Invalid response from server');
    }
    
    const applications = (response.applications || []).filter(app => app.status === 'pending');
    
    if (applications.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No pending applications</p></div>';
      return;
    }
    
    listDiv.innerHTML = applications.map(app => `
      <div class="card mb-3">
        <div class="card-body">
          <h4>${escapeHtml(app.username || 'Unknown')}</h4>
          <p class="text-muted">${escapeHtml(app.email || 'No email')}</p>
          <p>${escapeHtml(app.reason || 'No reason provided')}</p>
          <div class="mt-3">
            <button class="btn btn-success btn-sm" onclick="approveApplication('${app.id}')">
              <i class="fas fa-check"></i> Approve
            </button>
            <button class="btn btn-danger btn-sm" onclick="denyApplication('${app.id}')">
              <i class="fas fa-times"></i> Deny
            </button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading applications:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading applications: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Approve application
 */
async function approveApplication(applicationId) {
  try {
    await apiService.approveApplication(applicationId);
    Swal.fire({
      icon: 'success',
      title: 'Approved!',
      timer: 1500,
      showConfirmButton: false
    });
    loadApplications();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed',
      text: error.message
    });
  }
}

/**
 * Deny application
 */
async function denyApplication(applicationId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Deny Application?',
    text: 'Are you sure you want to deny this application?',
    showCancelButton: true,
    confirmButtonText: 'Yes, Deny',
    cancelButtonText: 'Cancel'
  });
  
  if (result.isConfirmed) {
    try {
      await apiService.denyApplication(applicationId);
      Swal.fire({
        icon: 'success',
        title: 'Denied',
        timer: 1500,
        showConfirmButton: false
      });
      loadApplications();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Load blacklist
 */
async function loadBlacklist() {
  const listDiv = document.getElementById('blacklistList');
  listDiv.innerHTML = '<div class="spinner"></div>';
  
  try {
    const searchInput = document.getElementById('blacklistSearchInput');
    const includeExpiredInput = document.getElementById('blacklistIncludeExpired');
    const pageSizeInput = document.getElementById('blacklistPageSize');

    if (searchInput) adminUiState.blacklist.q = searchInput.value.trim();
    if (includeExpiredInput) adminUiState.blacklist.includeExpired = includeExpiredInput.value === 'true';
    if (pageSizeInput) adminUiState.blacklist.limit = parseInt(pageSizeInput.value, 10) || 25;

    const response = await apiService.getBlacklist({
      page: adminUiState.blacklist.page,
      limit: adminUiState.blacklist.limit,
      q: adminUiState.blacklist.q,
      includeExpired: adminUiState.blacklist.includeExpired
    });
    
    if (!response || !response.blacklist) {
      throw new Error('Invalid response from server');
    }
    
    const blacklist = response.blacklist || [];
    adminUiState.blacklist.totalPages = response?.pagination?.totalPages || 1;
    
    if (blacklist.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No blacklisted players</p></div>';
      return;
    }
    
    listDiv.innerHTML = blacklist.map(entry => {
      const expiresAt = entry.expiresAt ? new Date(entry.expiresAt) : null;
      const isExpired = expiresAt ? expiresAt.getTime() <= Date.now() : false;
      const disabledFunctions = Object.entries(entry.disabledFunctions || {})
        .filter(([, enabled]) => enabled === true)
        .map(([k]) => k)
        .join(', ');

      return `
      <div class="card mb-3">
        <div class="card-body">
          <h4>${escapeHtml(entry.username)}</h4>
          <p class="text-muted">${escapeHtml(entry.reason || 'No reason provided')}</p>
          <small class="text-muted">Added: ${new Date(entry.addedAt).toLocaleDateString()}</small>
          <br>
          <small class="text-muted">Type: ${entry.temporary ? 'Temporary' : 'Permanent'}${expiresAt ? ` | Expires: ${expiresAt.toLocaleString()}` : ''}${isExpired ? ' (expired)' : ''}</small>
          ${disabledFunctions ? `<br><small class="text-muted">Disabled: ${escapeHtml(disabledFunctions)}</small>` : ''}
          <div class="mt-3">
            <button class="btn btn-danger btn-sm" onclick="removeFromBlacklist('${entry.id}')">
              <i class="fas fa-trash"></i> Remove
            </button>
          </div>
        </div>
      </div>
    `;
    }).join('');

    renderBlacklistPagination(response?.pagination || null);
  } catch (error) {
    console.error('Error loading blacklist:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading blacklist: ${escapeHtml(error.message)}</div>`;
  }
}

function renderBlacklistPagination(pagination) {
  const wrapper = document.getElementById('blacklistPagination');
  const info = document.getElementById('blacklistPageInfo');
  const prevBtn = document.getElementById('blacklistPrevBtn');
  const nextBtn = document.getElementById('blacklistNextBtn');
  if (!wrapper || !info || !prevBtn || !nextBtn) return;

  const page = pagination?.page || adminUiState.blacklist.page;
  const totalPages = pagination?.totalPages || adminUiState.blacklist.totalPages || 1;
  const total = pagination?.total || 0;

  wrapper.style.display = totalPages > 1 ? 'flex' : 'none';
  info.textContent = `Page ${page} / ${totalPages} (${total} total)`;
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= totalPages;
}

function applyBlacklistFilters() {
  adminUiState.blacklist.page = 1;
  loadBlacklist();
}

function changeBlacklistPage(delta) {
  const next = adminUiState.blacklist.page + delta;
  if (next < 1 || next > (adminUiState.blacklist.totalPages || 1)) return;
  adminUiState.blacklist.page = next;
  loadBlacklist();
}

/**
 * Handle add to blacklist
 */
async function handleAddBlacklist(event) {
  event.preventDefault();
  
  const username = document.getElementById('blacklistUsername').value.trim();
  const userId = document.getElementById('blacklistUserId')?.value.trim() || '';
  const reason = document.getElementById('blacklistReason').value.trim();
  const durationHours = parseInt(document.getElementById('blacklistDurationHours')?.value || '0', 10) || 0;
  const disabledFunctions = {
    chat: document.getElementById('blDisableChat')?.checked === true,
    queue: document.getElementById('blDisableQueue')?.checked === true,
    queue_join: document.getElementById('blDisableQueueJoin')?.checked === true,
    queue_leave: document.getElementById('blDisableQueueLeave')?.checked === true,
    reports: document.getElementById('blDisableReports')?.checked === true,
    report_submit: document.getElementById('blDisableReportSubmit')?.checked === true,
    account_changes: document.getElementById('blDisableAccountChanges')?.checked === true,
    applications: document.getElementById('blDisableApplications')?.checked === true,
    applications_submit: document.getElementById('blDisableApplicationsSubmit')?.checked === true,
    support_messages: document.getElementById('blDisableSupportMessages')?.checked === true
  };
  
  try {
    await apiService.addToBlacklist({ username, userId, reason, durationHours, disabledFunctions });
    Swal.fire({
      icon: 'success',
      title: 'Added!',
      timer: 1500,
      showConfirmButton: false
    });
    document.getElementById('blacklistForm').reset();
    loadBlacklist();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed',
      text: error.message
    });
  }
}

/**
 * Remove from blacklist
 */
async function removeFromBlacklist(blacklistId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Remove from Blacklist?',
    text: 'Are you sure you want to remove this player from the blacklist?',
    showCancelButton: true,
    confirmButtonText: 'Yes, Remove',
    cancelButtonText: 'Cancel'
  });
  
  if (result.isConfirmed) {
    try {
      await apiService.removeFromBlacklist(blacklistId);
      Swal.fire({
        icon: 'success',
        title: 'Removed',
        timer: 1500,
        showConfirmButton: false
      });
      loadBlacklist();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Load users
 */
async function loadUsers() {
  const listDiv = document.getElementById('usersList');
  
  // Check if element exists (it was removed when we unified the search)
  if (!listDiv) {
    console.warn('loadUsers called but usersList element does not exist. Use unified search instead.');
    return;
  }
  
  listDiv.innerHTML = '<div class="spinner"></div>';
  
  try {
    const response = await apiService.getUsers();
    
    if (!response || !response.users) {
      throw new Error('Invalid response from server');
    }
    
    const users = response.users || [];
    
    if (users.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No users found</p></div>';
      return;
    }
    
    listDiv.innerHTML = `
      <div class="table-responsive">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border-color);">
              <th style="padding: 1rem; text-align: left;">Minecraft Username</th>
              <th style="padding: 1rem; text-align: left;">Account</th>
              <th style="padding: 1rem; text-align: left;">Identifiers</th>
              <th style="padding: 1rem; text-align: left;">Status</th>
              <th style="padding: 1rem; text-align: left;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(user => `
              <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 1rem;">${escapeHtml(user.minecraftUsername || 'Not linked')}</td>
                <td style="padding: 1rem;">${escapeHtml(user.email || 'No account email')}</td>
                <td style="padding: 1rem; font-size: 0.85em;">
                  <div><strong>User:</strong> <code style="font-size: 0.9em;">${escapeHtml(user.id)}</code></div>
                </td>
                <td style="padding: 1rem;">
                  ${user.admin ? '<span class="badge badge-primary">Admin</span>' : ''}
                  ${user.tester ? '<span class="badge badge-success">Tier Tester</span>' : ''}
                  ${!user.admin && !user.tester ? '<span class="badge badge-secondary">User</span>' : ''}
                </td>
                <td style="padding: 1rem;">
                  <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                    <button class="btn btn-sm ${user.tester ? 'btn-danger' : 'btn-success'}"
                            onclick="toggleTierTester('${user.id}', ${!user.tester})">
                      ${user.tester ? 'Remove Tester' : 'Make Tester'}
                    </button>
                    <button class="btn btn-sm ${user.admin ? 'btn-warning' : 'btn-primary'}" 
                            onclick="toggleAdmin('${user.id}', ${!user.admin})">
                      ${user.admin ? 'Remove Admin' : 'Make Admin'}
                    </button>
                    <button class="btn btn-sm btn-secondary"
                            onclick="openManagementScreen('user', '${user.id}', '${escapeHtml(user.minecraftUsername || user.email || 'Unknown')}', '${escapeHtml(user.minecraftUsername || '')}', '${user.id}', '')">
                      Manage
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    console.error('Error loading users:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading users: ${escapeHtml(error.message)}</div>`;
  }
}

function buildManagementIdentitySummary(context) {
  const lines = [];

  if (context.username) {
    lines.push(`<div><strong>Username:</strong> ${escapeHtml(context.username)}</div>`);
  }

  if (context.accountName && context.accountName !== context.username) {
    lines.push(`<div><strong>Account:</strong> ${escapeHtml(context.accountName)}</div>`);
  }

  if (context.userId) {
    lines.push(`<div><strong>Firebase UID:</strong> <code>${escapeHtml(context.userId)}</code></div>`);
  }

  if (context.playerId) {
    lines.push(`<div><strong>Player ID:</strong> <code>${escapeHtml(context.playerId)}</code></div>`);
  }

  return lines.join('');
}

/**
 * Toggle admin status
 */
async function toggleAdmin(userId, status) {
  try {
    await apiService.setAdminStatus(userId, status);
    Swal.fire({
      icon: 'success',
      title: status ? 'Made Admin' : 'Removed Admin',
      timer: 1500,
      showConfirmButton: false
    });
    // Refresh unified search if it has results
    const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
    if (searchTerm) {
      await handleUnifiedSearch({ preventDefault: () => {} });
    }

    // Clear cached players so leaderboard/admin views pick up new role badges quickly
    if (typeof apiService.clearCache === 'function') {
      apiService.clearCache('/players');
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed',
      text: error.message
    });
  }
}

/**
 * Toggle tier tester status
 */
async function toggleTierTester(userId, status) {
  try {
    await apiService.setTesterStatus(userId, status);
    Swal.fire({
      icon: 'success',
      title: status ? 'Made Tier Tester' : 'Removed Tier Tester',
      timer: 1500,
      showConfirmButton: false
    });
    // Refresh unified search if it has results
    const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
    if (searchTerm) {
      await handleUnifiedSearch({ preventDefault: () => {} });
    }

    // Clear cached players so leaderboard/admin views pick up new role badges quickly
    if (typeof apiService.clearCache === 'function') {
      apiService.clearCache('/players');
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed',
      text: error.message
    });
  }
}

/**
 * Handle add player
 */
async function handleAddPlayer(event) {
  event.preventDefault();

  const username = document.getElementById('playerUsername').value.trim();
  const region = document.getElementById('playerRegion').value || null;

  try {
    await apiService.createPlayer(username, region);
    Swal.fire({
      icon: 'success',
      title: 'Player Added!',
      text: `${username} has been added to the leaderboard.`,
      timer: 1500,
      showConfirmButton: false
    });
    document.getElementById('addPlayerForm').reset();
    // Refresh unified search if it has results
    const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
    if (searchTerm) {
      await handleUnifiedSearch({ preventDefault: () => {} });
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Add Player',
      text: error.message
    });
  }
}

/**
 * Open player management window (10 actions)
 */
/**
 * Open management screen for player or user
 * @param {string} type - 'player' or 'user'
 * @param {string} id - Player ID or User ID
 * @param {string} name - Display name (username or email)
 * @param {string} username - Minecraft username (if available)
 * @param {string} userId - Firebase UID (if available)
 * @param {string} playerId - Player ID (if available)
 */
function openManagementScreen(type, id, name, username = '', userId = '', playerId = '') {
  const section = document.getElementById('managementSection');
  const titleEl = document.getElementById('managementSectionTitle');
  const summaryEl = document.getElementById('managementIdentitySummary');
  const actionGrid = document.getElementById('managementActionGrid');
  const formContainer = document.getElementById('managementFormContainer');
  
  const resolvedUsername = String(username || '').trim();
  const resolvedAccountName = String(name || '').trim();
  const primaryIdentity = resolvedUsername || resolvedAccountName || (type === 'player' ? 'Unknown player' : 'Unknown user');
  let titleText = `Manage ${type === 'player' ? 'Player' : 'Account'}: ${primaryIdentity}`;
  titleEl.textContent = titleText;
  
  // Store current context
  window.currentManagementContext = {
    type,
    id,
    name: primaryIdentity,
    accountName: resolvedAccountName,
    username: resolvedUsername,
    userId,
    playerId
  };

  if (summaryEl) {
    summaryEl.innerHTML = buildManagementIdentitySummary(window.currentManagementContext);
    summaryEl.style.display = summaryEl.innerHTML ? 'block' : 'none';
  }
  
  // Define available actions - ALL actions shown for both users and players
  const actions = [
    { id: 'force_auth', title: 'Force Auth', icon: 'fa-link', desc: 'Link username to account', requires: ['userId', 'username'] },
    { id: 'force_auth_unlink', title: 'Force Auth Unlink', icon: 'fa-unlink', desc: 'Unlink username, keep ratings', requires: ['userId'] },
    { id: 'force_test', title: 'Force Test', icon: 'fa-vial', desc: 'Create match offline', requires: ['userId', 'testerId', 'gamemode'] },
    { id: 'rating_transfer', title: 'Rating Transfer', icon: 'fa-exchange-alt', desc: 'Transfer ratings to another player', requires: ['destinationPlayerId'] },
    { id: 'rating_wipe', title: 'Rating Wipe', icon: 'fa-eraser', desc: 'Remove all ratings', requires: [] },
    { id: 'set_region', title: 'Set Region', icon: 'fa-globe', desc: 'Set player region', requires: ['region'] },
    { id: 'set_note', title: 'Set Note', icon: 'fa-sticky-note', desc: 'Set admin note', requires: ['note'] },
    { id: 'wipe_player_data', title: 'Wipe All Data', icon: 'fa-trash-alt', desc: 'Delete player record', requires: [] },
    { id: 'verify_username', title: 'Manually Verify Username', icon: 'fa-check-circle', desc: 'Bypass verification', requires: [] },
    { id: 'reset_onboarding', title: 'Reset Onboarding', icon: 'fa-redo', desc: 'Allow user to redo onboarding', requires: [] },
    { id: 'ban_user', title: 'Ban User', icon: 'fa-ban', desc: 'Ban user account', requires: ['banReason'] },
    { id: 'unban_user', title: 'Unban User', icon: 'fa-unlock', desc: 'Unban user account', requires: [] },
    { id: 'set_restrictions', title: 'Set Restrictions', icon: 'fa-sliders-h', desc: 'Disable selected user functions', requires: ['userId'] },
    { id: 'view_moderation_history', title: 'Moderation History', icon: 'fa-scroll', desc: 'Warnings, blacklist, restrictions, audit', requires: ['userId'] },
    { id: 'reset_password', title: 'Reset Password', icon: 'fa-key', desc: 'Send password reset email', requires: [] },
    { id: 'delete_account', title: 'Delete Account', icon: 'fa-user-times', desc: 'Permanently delete account', requires: [] },
    { id: 'view_notes', title: 'View Note History', icon: 'fa-history', desc: 'View all admin notes', requires: [] },
    { id: 'plus_subscription', title: 'Plus Subscription', icon: 'fa-crown', desc: 'Grant/cancel/block Plus membership', requires: ['userId'] }
  ];
  
  // Render action cards
  actionGrid.innerHTML = actions.map(action => `
    <div class="action-card" data-action="${action.id}" onclick="selectManagementAction('${action.id}')">
      <div class="action-card-icon"><i class="fas ${action.icon}"></i></div>
      <div class="action-card-title">${action.title}</div>
      <div class="action-card-desc">${action.desc}</div>
    </div>
  `).join('');
  
  // Hide form initially
  formContainer.style.display = 'none';
  
  // Show section and scroll to it
  section.classList.remove('d-none');
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Select management action
 */
function selectManagementAction(actionId) {
  // Update selected state
  document.querySelectorAll('.action-card').forEach(card => {
    card.classList.remove('selected');
  });
  document.querySelector(`.action-card[data-action="${actionId}"]`).classList.add('selected');
  
  // Show form
  const formContainer = document.getElementById('managementFormContainer');
  const formTitle = document.getElementById('managementFormTitle');
  const form = document.getElementById('managementForm');
  
  const context = window.currentManagementContext;
  // All actions available regardless of type
  const actions = [
    { id: 'force_auth', title: 'Force Auth', fields: ['userId', 'username'] },
    { id: 'force_auth_unlink', title: 'Force Auth Unlink', fields: ['userId'] },
    { id: 'force_test', title: 'Force Test', fields: ['userId', 'testerId', 'gamemode', 'region', 'serverIP'] },
    { id: 'rating_transfer', title: 'Rating Transfer', fields: ['destinationPlayerId'] },
    { id: 'rating_wipe', title: 'Rating Wipe', fields: [] },
    { id: 'set_region', title: 'Set Region', fields: ['region'] },
    { id: 'set_note', title: 'Set Note', fields: ['note'] },
    { id: 'wipe_player_data', title: 'Wipe All Data', fields: [] },
    { id: 'verify_username', title: 'Manually Verify Username', fields: [] },
    { id: 'reset_onboarding', title: 'Reset Onboarding', fields: [] },
    { id: 'ban_user', title: 'Ban User', fields: ['banReason'] },
    { id: 'unban_user', title: 'Unban User', fields: [] },
    { id: 'set_restrictions', title: 'Set Restrictions', fields: ['userId', 'restrictionFlags', 'restrictionDurationHours', 'restrictionReason'] },
    { id: 'view_moderation_history', title: 'Moderation History', fields: ['userId'] },
    { id: 'reset_password', title: 'Reset Password', fields: [] },
    { id: 'delete_account', title: 'Delete Account', fields: [] },
    { id: 'view_notes', title: 'View Note History', fields: [] },
    { id: 'plus_subscription', title: 'Plus Subscription', fields: ['userId', 'plusAction', 'plusYears', 'plusBlockReason'] }
  ];
  
  const action = actions.find(a => a.id === actionId);
  if (!action) return;
  
  formTitle.textContent = action.title;
  
  // Build form fields
  let formHTML = '';
  
  if (action.fields.includes('userId')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Firebase UID</label>
        <input type="text" id="mgmtUserId" class="form-input" value="${escapeHtml(context.userId || '')}" placeholder="Enter Firebase UID">
        <div class="form-help">User's Firebase UID</div>
      </div>
    `;
  }
  
  if (action.fields.includes('username')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Minecraft Username</label>
        <input type="text" id="mgmtUsername" class="form-input" value="${escapeHtml(context.username || '')}" placeholder="Enter Minecraft username">
      </div>
    `;
  }
  
  if (action.fields.includes('testerId')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Tester Firebase UID</label>
        <input type="text" id="mgmtTesterId" class="form-input" placeholder="Enter tester's Firebase UID">
      </div>
    `;
  }
  
  if (action.fields.includes('gamemode')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Gamemode</label>
        <select id="mgmtGamemode" class="form-select">
          <option value="">Select gamemode...</option>
          <option value="vanilla">Vanilla</option>
          <option value="uhc">UHC</option>
          <option value="pot">Pot</option>
          <option value="nethop">NethOP</option>
          <option value="smp">SMP</option>
          <option value="sword">Sword</option>
          <option value="axe">Axe</option>
          <option value="mace">Mace</option>
        </select>
      </div>
    `;
  }
  
  if (action.fields.includes('region')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Region</label>
        <select id="mgmtRegion" class="form-select">
          <option value="">Select region...</option>
          <option value="NA">NA</option>
          <option value="EU">EU</option>
          <option value="AS">AS</option>
          <option value="SA">SA</option>
          <option value="AU">AU</option>
        </select>
      </div>
    `;
  }
  
  if (action.fields.includes('serverIP')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Server IP</label>
        <input type="text" id="mgmtServerIP" class="form-input" placeholder="Enter server IP">
      </div>
    `;
  }
  
  if (action.fields.includes('destinationPlayerId')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Destination Player ID</label>
        <input type="text" id="mgmtDestinationPlayerId" class="form-input" placeholder="Enter destination player ID">
        <div class="form-help">Transfer ratings FROM ${escapeHtml(context.username || context.name)} (ID: ${context.id}) TO this player ID</div>
      </div>
    `;
  }
  
  if (action.fields.includes('note')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Admin Note</label>
        <textarea id="mgmtNote" class="form-input" rows="3" placeholder="Internal note (optional)"></textarea>
      </div>
    `;
  }
  
  if (action.fields.includes('banReason')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Ban Reason</label>
        <textarea id="mgmtBanReason" class="form-input" rows="3" placeholder="Reason for ban" required></textarea>
        <div class="form-help">This will be shown to the user</div>
      </div>
    `;
  }

  if (action.fields.includes('restrictionFlags')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Restricted Features</label>
        <div class="row">
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionChat"> Chat</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionQueue"> Queue</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionQueueJoin"> Queue Join</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionQueueLeave"> Queue Leave</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionReports"> Reports</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionReportSubmit"> Report Submit</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionAccountChanges"> Account Changes</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionApplications"> Applications</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionApplicationsSubmit"> Application Submit</label></div>
          <div class="col-6"><label><input type="checkbox" id="mgmtRestrictionSupportMessages"> Support Messages</label></div>
        </div>
      </div>
    `;
  }

  if (action.fields.includes('restrictionDurationHours')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Duration (hours)</label>
        <input type="number" id="mgmtRestrictionDurationHours" class="form-input" min="0" step="1" value="0" placeholder="0 = no expiry">
      </div>
    `;
  }

  if (action.fields.includes('restrictionReason')) {
    formHTML += `
      <div class="form-group">
        <label class="form-label">Reason</label>
        <input type="text" id="mgmtRestrictionReason" class="form-input" placeholder="Reason shown in standing section">
      </div>
    `;
  }
  
  if (formHTML === '') {
    formHTML = '<p class="text-muted">No additional information required. Click Execute to proceed.</p>';
  }

  if (actionId === 'plus_subscription') {
    formHTML = `
      <div class="form-group">
        <label class="form-label">Firebase UID</label>
        <input type="text" id="mgmtUserId" class="form-input" value="${escapeHtml(context.userId || context.id || '')}" placeholder="Enter Firebase UID">
        <div class="form-help">Grant/cancel/block Plus for this user</div>
      </div>
      <div class="form-group">
        <label class="form-label">Action</label>
        <select id="mgmtPlusAction" class="form-select">
          <option value="grant">Grant (add 1+ year)</option>
          <option value="cancel">Cancel (remove perks)</option>
          <option value="block">Block (prevent Plus + remove perks)</option>
          <option value="unblock">Unblock</option>
        </select>
      </div>
      <div class="form-group" id="mgmtPlusYearsGroup">
        <label class="form-label">Years</label>
        <input type="number" id="mgmtPlusYears" class="form-input" min="1" max="5" value="1">
        <div class="form-help">Maximum 5 years at a time</div>
      </div>
      <div class="form-group" id="mgmtPlusReasonGroup" style="display:none;">
        <label class="form-label">Block Reason (optional)</label>
        <input type="text" id="mgmtPlusBlockReason" class="form-input" placeholder="Reason for blocking Plus">
      </div>
    `;
  }
  
  form.innerHTML = formHTML;
  formContainer.style.display = 'block';
  
  // Wire dynamic toggles for Plus form (scripts injected via innerHTML are unreliable)
  if (actionId === 'plus_subscription') {
    const sel = document.getElementById('mgmtPlusAction');
    const years = document.getElementById('mgmtPlusYearsGroup');
    const reason = document.getElementById('mgmtPlusReasonGroup');
    const update = () => {
      const v = sel?.value || 'grant';
      if (years) years.style.display = (v === 'grant') ? 'block' : 'none';
      if (reason) reason.style.display = (v === 'block') ? 'block' : 'none';
    };
    if (sel) sel.addEventListener('change', update);
    update();
  }
  
  // Store selected action
  window.currentManagementAction = actionId;
}

/**
 * Close management screen
 */
function closeManagementScreen() {
  const section = document.getElementById('managementSection');
  section.classList.add('d-none');
  window.currentManagementContext = null;
  window.currentManagementAction = null;
  
  // Reset form
  const formContainer = document.getElementById('managementFormContainer');
  const form = document.getElementById('managementForm');
  if (formContainer) formContainer.style.display = 'none';
  if (form) form.reset();
  
  // Clear selected action cards
  document.querySelectorAll('.action-card.selected').forEach(card => {
    card.classList.remove('selected');
  });
}

/**
 * Reset management form
 */
function resetManagementForm() {
  const form = document.getElementById('managementForm');
  form.reset();
}

/**
 * Execute management action
 */
async function executeManagementAction() {
  const context = window.currentManagementContext;
  const action = window.currentManagementAction;
  
  if (!context || !action) {
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: 'No action selected'
    });
    return;
  }
  
  try {
    // Collect form data
    const formData = {
      userId: document.getElementById('mgmtUserId')?.value?.trim() || context.userId || '',
      username: document.getElementById('mgmtUsername')?.value?.trim() || context.username || '',
      testerId: document.getElementById('mgmtTesterId')?.value?.trim() || '',
      gamemode: document.getElementById('mgmtGamemode')?.value || '',
      region: document.getElementById('mgmtRegion')?.value || '',
      serverIP: document.getElementById('mgmtServerIP')?.value?.trim() || '',
      destinationPlayerId: document.getElementById('mgmtDestinationPlayerId')?.value?.trim() || '',
      note: document.getElementById('mgmtNote')?.value?.trim() || '',
      banReason: document.getElementById('mgmtBanReason')?.value?.trim() || '',
      restrictionDurationHours: parseInt(document.getElementById('mgmtRestrictionDurationHours')?.value || '0', 10) || 0,
      restrictionReason: document.getElementById('mgmtRestrictionReason')?.value?.trim() || '',
      plusAction: document.getElementById('mgmtPlusAction')?.value || '',
      plusYears: parseInt(document.getElementById('mgmtPlusYears')?.value || '1'),
      plusBlockReason: document.getElementById('mgmtPlusBlockReason')?.value?.trim() || ''
    };

    formData.restrictions = {
      chat: document.getElementById('mgmtRestrictionChat')?.checked === true,
      queue: document.getElementById('mgmtRestrictionQueue')?.checked === true,
      queue_join: document.getElementById('mgmtRestrictionQueueJoin')?.checked === true,
      queue_leave: document.getElementById('mgmtRestrictionQueueLeave')?.checked === true,
      reports: document.getElementById('mgmtRestrictionReports')?.checked === true,
      report_submit: document.getElementById('mgmtRestrictionReportSubmit')?.checked === true,
      account_changes: document.getElementById('mgmtRestrictionAccountChanges')?.checked === true,
      applications: document.getElementById('mgmtRestrictionApplications')?.checked === true,
      applications_submit: document.getElementById('mgmtRestrictionApplicationsSubmit')?.checked === true,
      support_messages: document.getElementById('mgmtRestrictionSupportMessages')?.checked === true
    };
    
    // Validate required fields
    if (action === 'force_auth') {
      if (!formData.userId || !formData.username) {
        Swal.fire({
          icon: 'error',
          title: 'Validation Error',
          text: 'Firebase UID and Minecraft username are required'
        });
        return;
      }
    }
    
    if (action === 'force_auth_unlink') {
      if (!formData.userId && context.type === 'user') {
        formData.userId = context.id;
      }
      if (!formData.userId) {
        Swal.fire({
          icon: 'error',
          title: 'Validation Error',
          text: 'Firebase UID is required'
        });
        return;
      }
    }
    
    if (action === 'force_test') {
      if (!formData.userId || !formData.testerId || !formData.gamemode || !formData.region || !formData.serverIP) {
        Swal.fire({
          icon: 'error',
          title: 'Validation Error',
          text: 'All fields are required for force test'
        });
        return;
      }
    }
    
    if (action === 'rating_transfer') {
      if (!formData.destinationPlayerId) {
        Swal.fire({
          icon: 'error',
          title: 'Validation Error',
          text: 'Destination player ID is required'
        });
        return;
      }
    }
    
    // Execute action
    if (action === 'plus_subscription') {
      if (!formData.userId) {
        Swal.fire({ icon: 'error', title: 'Validation Error', text: 'Firebase UID is required' });
        return;
      }
      if (formData.plusAction === 'grant') {
        await apiService.adminGrantPlus(formData.userId, formData.plusYears || 1);
      } else if (formData.plusAction === 'cancel') {
        await apiService.adminCancelPlus(formData.userId);
      } else if (formData.plusAction === 'block') {
        await apiService.adminSetPlusBlocked(formData.userId, true, formData.plusBlockReason || '');
      } else if (formData.plusAction === 'unblock') {
        await apiService.adminSetPlusBlocked(formData.userId, false, '');
      } else {
        throw new Error('Invalid Plus action');
      }
    } else if (action === 'force_auth') {
      await apiService.forceAuth(formData.userId, formData.username);
    } else if (action === 'force_auth_unlink') {
      await apiService.forceAuthUnlink(formData.userId);
    } else if (action === 'force_test') {
      // forceTest expects: testerUserId, playerUserId, gamemode, region, serverIP
      await apiService.forceTest(formData.testerId, formData.userId, formData.gamemode, formData.region, formData.serverIP);
    } else if (action === 'rating_transfer') {
      // ratingTransfer expects: fromPlayerId, toPlayerId
      const fromPlayerId = context.type === 'player' ? context.id : null;
      if (!fromPlayerId) {
        throw new Error('Source player ID is required for rating transfer');
      }
      // For destination, we need to find player by username first
      // For now, require destination to be a player ID or we need to look it up
      // Since the form asks for username, we'll need to find the player ID
      // For simplicity, let's change the form to ask for destination player ID
      if (!formData.destinationPlayerId) {
        throw new Error('Destination player ID is required for rating transfer');
      }
      await apiService.ratingTransfer(fromPlayerId, formData.destinationPlayerId);
    } else if (action === 'rating_wipe') {
      // Try to get player ID from context
      const playerId = context.type === 'player' ? context.id : context.playerId;
      if (!playerId) {
        throw new Error('Player ID is required for rating wipe. This user may not have a linked Minecraft account.');
      }
      await apiService.ratingWipe(playerId);
    } else if (action === 'set_region') {
      // Try to get player ID from context
      const playerId = context.type === 'player' ? context.id : context.playerId;
      if (!playerId) {
        throw new Error('Player ID is required for set region. This user may not have a linked Minecraft account.');
      }
      await apiService.adminManagePlayer(playerId, 'set_region', { region: formData.region });
    } else if (action === 'set_note') {
      // Set note works for both players and users
      if (context.type === 'player') {
        await apiService.adminManagePlayer(context.id, 'set_note', { note: formData.note });
      } else {
        await apiService.adminManageUser(context.id, 'set_note', { note: formData.note });
      }
    } else if (action === 'wipe_player_data') {
      // Try to get player ID from context
      const playerId = context.type === 'player' ? context.id : context.playerId;
      if (!playerId) {
        throw new Error('Player ID is required for wipe player data. This user may not have a linked Minecraft account.');
      }
      await apiService.adminManagePlayer(playerId, 'wipe_player_data', {});
    } else if (action === 'verify_username') {
      // Manually verify username for a player's linked user
      if (!formData.userId) {
        formData.userId = context.userId || context.id;
      }
      await apiService.adminManageUser(formData.userId, 'verify_username', {});
    } else if (action === 'reset_onboarding') {
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required for reset onboarding');
      }
      await apiService.adminManageUser(targetUserId, 'reset_onboarding', {});
    } else if (action === 'ban_user') {
      if (!formData.banReason) {
        throw new Error('Ban reason is required');
      }
      // Try to get user ID from context
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required for ban. This player may not have a linked user account.');
      }
      await apiService.adminManageUser(targetUserId, 'ban_user', { reason: formData.banReason });
    } else if (action === 'unban_user') {
      // Try to get user ID from context
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required for unban. This player may not have a linked user account.');
      }
      await apiService.adminManageUser(targetUserId, 'unban_user', {});
    } else if (action === 'set_restrictions') {
      const targetUserId = formData.userId || (context.type === 'user' ? context.id : context.userId);
      if (!targetUserId) {
        throw new Error('User ID is required for restrictions');
      }
      await apiService.adminSetUserRestrictions(
        targetUserId,
        formData.restrictions,
        formData.restrictionDurationHours,
        formData.restrictionReason
      );
    } else if (action === 'view_moderation_history') {
      const targetUserId = formData.userId || (context.type === 'user' ? context.id : context.userId);
      if (!targetUserId) {
        throw new Error('User ID is required to view moderation history');
      }

      const history = await apiService.adminGetUserModerationHistory(targetUserId);
      const warnings = Array.isArray(history.warnings) ? history.warnings : [];
      const blacklistEntries = Array.isArray(history.blacklistEntries) ? history.blacklistEntries : [];
      const auditLogs = Array.isArray(history.auditLogs) ? history.auditLogs : [];

      const html = `
        <div style="text-align:left; max-height: 520px; overflow-y:auto;">
          <h4>Warnings (${warnings.length})</h4>
          <div>${warnings.slice(0, 10).map(w => `<div style="padding:6px 0; border-bottom:1px solid #333;">${escapeHtml(w.reason || 'No reason')}<br><small>${w.warnedAt ? new Date(w.warnedAt).toLocaleString() : 'Unknown date'}</small></div>`).join('') || '<div class="text-muted">No warnings.</div>'}</div>
          <h4 style="margin-top:1rem;">Blacklist (${blacklistEntries.length})</h4>
          <div>${blacklistEntries.slice(0, 10).map(b => `<div style="padding:6px 0; border-bottom:1px solid #333;">${escapeHtml(b.reason || 'No reason')}<br><small>${b.addedAt ? new Date(b.addedAt).toLocaleString() : 'Unknown date'}${b.expiresAt ? ` | Expires ${new Date(b.expiresAt).toLocaleString()}` : ''}</small></div>`).join('') || '<div class="text-muted">No blacklist entries.</div>'}</div>
          <h4 style="margin-top:1rem;">Audit (${auditLogs.length})</h4>
          <div>${auditLogs.slice(0, 20).map(a => `<div style="padding:6px 0; border-bottom:1px solid #333;"><strong>${escapeHtml(a.action || 'ACTION')}</strong><br><small>${a.timestamp ? new Date(a.timestamp).toLocaleString() : 'Unknown date'}</small></div>`).join('') || '<div class="text-muted">No audit history.</div>'}</div>
        </div>
      `;

      Swal.fire({
        icon: 'info',
        title: 'Moderation History',
        html,
        width: 720
      });
      return;
    } else if (action === 'reset_password') {
      // Try to get user ID from context
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required for password reset. This player may not have a linked user account.');
      }
      await apiService.adminManageUser(targetUserId, 'reset_password', {});
    } else if (action === 'delete_account') {
      // Try to get user ID from context
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required for account deletion. This player may not have a linked user account.');
      }
      
      // Confirm deletion
      const confirmResult = await Swal.fire({
        icon: 'warning',
        title: 'Confirm Account Deletion',
        text: 'This action is PERMANENT and cannot be undone. All user data will be deleted.',
        showCancelButton: true,
        confirmButtonText: 'Yes, Delete',
        confirmButtonColor: '#d33',
        cancelButtonText: 'Cancel'
      });
      
      if (!confirmResult.isConfirmed) {
        return;
      }
      
      await apiService.adminManageUser(targetUserId, 'delete_account', {});
    } else if (action === 'view_notes') {
      // Try to get user ID from context - view notes works for users primarily
      const targetUserId = context.type === 'user' ? context.id : context.userId;
      if (!targetUserId) {
        throw new Error('User ID is required to view notes. This player may not have a linked user account.');
      }
      const notesResult = await apiService.adminManageUser(targetUserId, 'view_notes', {});
      
      let notesHtml = '<div style="text-align: left; max-height: 400px; overflow-y: auto;">';
      if (notesResult.notes && notesResult.notes.length > 0) {
        notesResult.notes.forEach(note => {
          notesHtml += `
            <div style="border-bottom: 1px solid #ddd; padding: 10px 0;">
              <p><strong>${escapeHtml(note.adminEmail || 'Unknown Admin')}</strong></p>
              <p style="color: #666; font-size: 0.9em;">${new Date(note.timestamp).toLocaleString()}</p>
              <p style="margin-top: 5px;">${escapeHtml(note.note)}</p>
            </div>
          `;
        });
      } else {
        notesHtml += '<p class="text-muted">No admin notes found for this user.</p>';
      }
      notesHtml += '</div>';
      
      Swal.fire({
        icon: 'info',
        title: 'Admin Note History',
        html: notesHtml,
        width: '600px'
      });
      return; // Don't close the management screen or show success message
    }
    
    Swal.fire({
      icon: 'success',
      title: 'Success',
      text: 'Action completed successfully',
      timer: 1500,
      showConfirmButton: false
    });
    
    closeManagementScreen();
    
    // Refresh unified search if it has results
    const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
    if (searchTerm) {
      await handleUnifiedSearch({ preventDefault: () => {} });
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: error.message || 'An error occurred'
    });
  }
}

// Legacy function for backwards compatibility
async function openPlayerManagementModal(playerId, username, userId) {
  openManagementScreen('player', playerId, username, username, userId, playerId);
}

/**
 * Open set rating modal
 */
function openSetRatingModal(playerId, username) {
  Swal.fire({
    title: `Set Rating for ${escapeHtml(username)}`,
    html: `
      <div class="form-group">
        <label>Gamemode</label>
        <select id="ratingGamemode" class="form-select">
          <option value="">Select gamemode...</option>
          ${CONFIG.GAMEMODES.filter(gm => gm.id !== 'overall').map(gm => 
            `<option value="${gm.id}">${gm.name}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Elo Rating</label>
        <input type="number" id="ratingInput" class="form-input" placeholder="Enter Elo rating (300-3000)" min="300" max="3000" step="25">
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Set Rating',
    preConfirm: () => {
      const gamemode = document.getElementById('ratingGamemode').value;
      const rating = parseInt(document.getElementById('ratingInput').value);
      if (!gamemode) {
        Swal.showValidationMessage('Please select a gamemode');
        return false;
      }
      if (!rating || rating < 300 || rating > 3000) {
        Swal.showValidationMessage('Please enter a valid Elo rating (300-3000)');
        return false;
      }
      return { gamemode, rating };
    }
  }).then(async (result) => {
    if (result.isConfirmed) {
      try {
        await apiService.setPlayerRating(playerId, result.value.gamemode, result.value.rating);
        Swal.fire({
          icon: 'success',
          title: 'Rating Set!',
          text: `Set ${result.value.gamemode} rating to ${result.value.rating} Elo`,
          timer: 1500,
          showConfirmButton: false
        });
        // Refresh unified search if it has results
        const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
        if (searchTerm) {
          await handleUnifiedSearch({ preventDefault: () => {} });
        }
      } catch (error) {
        Swal.fire({
          icon: 'error',
          title: 'Failed',
          text: error.message
        });
      }
    }
  });
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Handle ban account
 */
async function handleBanAccount(event) {
  event.preventDefault();

  const identifier = document.getElementById('banIdentifier').value.trim();
  const duration = document.getElementById('banDuration').value;
  const reason = document.getElementById('banReason').value.trim();

  try {
    await apiService.banAccount(identifier, duration, reason);
    Swal.fire({
      icon: 'success',
      title: 'Account Banned!',
      text: 'The account has been banned successfully.',
      timer: 2000,
      showConfirmButton: false
    });
    document.getElementById('banAccountForm').reset();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Ban Account',
      text: error.message
    });
  }
}

/**
 * Handle search banned accounts
 */
async function handleSearchBanned(event) {
  event.preventDefault();

  const searchTerm = document.getElementById('bannedSearch').value.trim();
  const listDiv = document.getElementById('bannedAccountsList');

  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.searchBannedAccounts(searchTerm);

    if (!response || !response.bannedAccounts) {
      throw new Error('Invalid response from server');
    }

    const bannedAccounts = response.bannedAccounts || [];

    if (bannedAccounts.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No banned accounts found matching your search</p></div>';
      return;
    }

    listDiv.innerHTML = `
      <div class="table-responsive">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border-color);">
              <th style="padding: 1rem; text-align: left;">Email</th>
              <th style="padding: 1rem; text-align: left;">Firebase UID</th>
              <th style="padding: 1rem; text-align: left;">Banned At</th>
              <th style="padding: 1rem; text-align: left;">Expires</th>
              <th style="padding: 1rem; text-align: left;">Reason</th>
              <th style="padding: 1rem; text-align: left;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${bannedAccounts.map(account => `
              <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 1rem;">${escapeHtml(account.email || 'N/A')}</td>
                <td style="padding: 1rem;">${escapeHtml(account.firebaseUid || 'N/A')}</td>
                <td style="padding: 1rem;">${account.bannedAt ? new Date(account.bannedAt).toLocaleDateString() : 'N/A'}</td>
                <td style="padding: 1rem;">${account.banExpires ? (account.banExpires === 'permanent' ? 'Permanent' : new Date(account.banExpires).toLocaleDateString()) : 'N/A'}</td>
                <td style="padding: 1rem;">${escapeHtml(account.banReason || 'No reason provided')}</td>
                <td style="padding: 1rem;">
                  <button class="btn btn-sm btn-success" onclick="handleUnbanAccount('${account.firebaseUid}')">
                    <i class="fas fa-unlock"></i> Unban
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    console.error('Error searching banned accounts:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error searching banned accounts: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Handle unban account
 */
async function handleUnbanAccount(firebaseUid) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Unban Account?',
    text: 'Are you sure you want to unban this account?',
    showCancelButton: true,
    confirmButtonText: 'Yes, Unban',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.unbanAccount(firebaseUid);
      Swal.fire({
        icon: 'success',
        title: 'Account Unbanned',
        timer: 1500,
        showConfirmButton: false
      });
      // Refresh search results
      document.getElementById('searchBannedForm').dispatchEvent(new Event('submit'));
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed to Unban',
        text: error.message
      });
    }
  }
}

/**
 * Handle search blacklist
 */
async function handleSearchBlacklist(event) {
  event.preventDefault();

  const searchTerm = document.getElementById('blacklistSearch').value.trim();
  const listDiv = document.getElementById('blacklistList');

  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.searchBlacklist(searchTerm);

    if (!response || !response.blacklist) {
      throw new Error('Invalid response from server');
    }

    const blacklist = response.blacklist || [];

    if (blacklist.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No blacklisted players found matching your search</p></div>';
      return;
    }

    listDiv.innerHTML = blacklist.map(entry => `
      <div class="card mb-3">
        <div class="card-body">
          <h4>${escapeHtml(entry.username)}</h4>
          <p class="text-muted">${escapeHtml(entry.reason || 'No reason provided')}</p>
          <small class="text-muted">Added: ${new Date(entry.addedAt).toLocaleDateString()}</small>
          <div class="mt-3">
            <button class="btn btn-danger btn-sm" onclick="removeFromBlacklist('${entry.id}')">
              <i class="fas fa-trash"></i> Remove
            </button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error searching blacklist:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error searching blacklist: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Handle unified search (users and players)
 */
async function handleUnifiedSearch(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();

  const searchTerm = document.getElementById('unifiedSearch').value.trim();
  const resultsDiv = document.getElementById('unifiedSearchResults');

  if (!searchTerm) {
    resultsDiv.innerHTML = '<div class="empty-state"><p class="text-muted">Please enter a search term</p></div>';
    return;
  }

  if (searchTerm !== adminUiState.unifiedSearch.lastTerm) {
    adminUiState.unifiedSearch.page = 1;
    adminUiState.unifiedSearch.lastTerm = searchTerm;
  }

  resultsDiv.innerHTML = '<div class="spinner"></div>';

  try {
    // Search both users and players in parallel
    const [usersResponse, playersResponse] = await Promise.all([
      apiService.searchUsers(searchTerm, {
        page: adminUiState.unifiedSearch.page,
        limit: adminUiState.unifiedSearch.limit
      }).catch(err => {
        console.warn('Error searching users:', err);
        return { users: [] };
      }),
      apiService.searchPlayers(searchTerm, {
        page: adminUiState.unifiedSearch.page,
        limit: adminUiState.unifiedSearch.limit
      }).catch(err => {
        console.warn('Error searching players:', err);
        return { players: [] };
      })
    ]);

    const users = usersResponse?.users || [];
    const players = playersResponse?.players || [];
    adminUiState.unifiedSearch.totalPages = Math.max(
      usersResponse?.pagination?.totalPages || 1,
      playersResponse?.pagination?.totalPages || 1
    );

    // Combine and deduplicate results using explicit linkage metadata first,
    // then fall back to userId or normalized username matching.
    const combinedResults = [];
    const processedPlayerIds = new Set();
    const playersById = new Map();
    const playersByUserId = new Map();
    const playersByUsername = new Map();

    for (const player of players) {
      const normalizedPlayerUsername = normalizeAdminUsername(player.username);
      const playerUserId = String(player.userId || '').trim();

      if (player.id) {
        playersById.set(player.id, player);
      }
      if (playerUserId && !playersByUserId.has(playerUserId)) {
        playersByUserId.set(playerUserId, player);
      }
      if (normalizedPlayerUsername && !playersByUsername.has(normalizedPlayerUsername)) {
        playersByUsername.set(normalizedPlayerUsername, player);
      }
    }

    // Process users first
    for (const user of users) {
      const normalizedUserUsername = normalizeAdminUsername(user.linkedPlayerUsername || user.minecraftUsername);
      const linkedPlayer = (user.linkedPlayerId ? playersById.get(user.linkedPlayerId) : null)
        || playersByUserId.get(user.id)
        || (normalizedUserUsername ? playersByUsername.get(normalizedUserUsername) : null)
        || null;
      const resolvedPlayerId = user.linkedPlayerId || linkedPlayer?.id || null;
      const resolvedMinecraftUsername = user.linkedPlayerUsername
        || linkedPlayer?.username
        || user.minecraftUsername
        || null;
      const resolvedPlayerData = linkedPlayer || (resolvedPlayerId ? {
        id: resolvedPlayerId,
        username: resolvedMinecraftUsername,
        blacklisted: Boolean(user.linkedPlayerBlacklisted)
      } : null);

      const result = {
        type: 'user',
        id: user.id,
        email: user.email,
        minecraftUsername: resolvedMinecraftUsername,
        primaryLabel: resolvedMinecraftUsername || user.email || user.id,
        admin: user.admin || false,
        tierTester: user.tierTester || false,
        banned: user.banned || false,
        staffRole: user.staffRole || null,
        staffRoleId: user.staffRoleId || null,
        userId: user.id,
        playerId: resolvedPlayerId,
        playerData: resolvedPlayerData
      };

      if (resolvedPlayerId) {
        processedPlayerIds.add(resolvedPlayerId);
      }

      combinedResults.push(result);
    }

    // Add players that aren't linked to any user
    for (const player of players) {
      if (!processedPlayerIds.has(player.id)) {
        combinedResults.push({
          type: 'player',
          id: player.id,
          email: player.email || null,
          minecraftUsername: player.username,
          primaryLabel: player.username || player.email || player.id,
          admin: player.admin || false,
          tierTester: player.tierTester || player.tester || false,
          banned: player.banned || false,
          staffRole: player.staffRole || null,
          staffRoleId: player.staffRoleId || null,
          userId: player.userId || null,
          playerId: player.id,
          playerData: player
        });
      }
    }

    if (combinedResults.length === 0) {
      resultsDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No users or players found matching your search</p></div>';
      return;
    }

    // Render results
    resultsDiv.innerHTML = `
      <div class="table-responsive">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 2px solid var(--border-color);">
              <th style="padding: 1rem; text-align: left;">Minecraft Username</th>
              <th style="padding: 1rem; text-align: left;">Account</th>
              <th style="padding: 1rem; text-align: left;">Identifiers</th>
              <th style="padding: 1rem; text-align: left;">Status</th>
              <th style="padding: 1rem; text-align: left;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${combinedResults.map(result => {
              const hasPlayer = result.playerId !== null;
              const hasUser = result.userId !== null;
              const canSetRating = hasPlayer;
              const canMakeTester = hasUser;
              const canMakeAdmin = hasUser;

              return `
              <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 1rem;">
                  ${escapeHtml(result.minecraftUsername || 'Not linked')}
                  ${result.playerData?.blacklisted ? '<span class="badge badge-danger ml-2">Blacklisted</span>' : ''}
                </td>
                <td style="padding: 1rem;">${escapeHtml(result.email || 'No linked account')}</td>
                <td style="padding: 1rem; font-size: 0.85em;">
                  ${result.userId ? `<div><strong>User:</strong> <code style="font-size: 0.9em;">${escapeHtml(result.userId)}</code></div>` : ''}
                  ${result.playerId ? `<div><strong>Player:</strong> <code style="font-size: 0.9em;">${escapeHtml(result.playerId)}</code></div>` : ''}
                  ${!result.userId && !result.playerId ? 'N/A' : ''}
                </td>
                <td style="padding: 1rem;">
                  ${result.admin ? '<span class="badge badge-primary">Admin</span>' : ''}
                  ${result.tierTester ? '<span class="badge badge-success">Tester</span>' : ''}
                  ${result.staffRole ? `<span class="badge badge-info">${escapeHtml(result.staffRole.name || 'Staff')}</span>` : ''}
                  ${result.banned ? '<span class="badge badge-danger">Banned</span>' : ''}
                  ${!result.admin && !result.tierTester && !result.staffRole && !result.banned ? '<span class="badge badge-secondary">User</span>' : ''}
                </td>
                <td style="padding: 1rem;">
                  <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                    <button class="btn btn-sm btn-primary"
                            onclick="handleManageResult('${result.type}', '${result.id}', '${escapeHtml(result.email || '')}', '${escapeHtml(result.minecraftUsername || '')}', '${result.userId || ''}', '${result.playerId || ''}')">
                      <i class="fas fa-cog"></i> Manage
                    </button>
                    ${canSetRating ? `
                      <button class="btn btn-sm btn-info"
                              onclick="openSetRatingModal('${result.playerId}', '${escapeHtml(result.minecraftUsername || 'Unknown')}')">
                        <i class="fas fa-star"></i> Set Rating
                      </button>
                    ` : ''}
                    ${result.minecraftUsername ? `
                      <button class="btn btn-sm btn-warning"
                              onclick="handleResetCooldown('${escapeHtml(result.minecraftUsername)}')">
                        <i class="fas fa-clock"></i> Reset Cooldown
                      </button>
                    ` : ''}
                    ${canMakeTester ? `
                      <button class="btn btn-sm ${result.tierTester ? 'btn-danger' : 'btn-success'}"
                              onclick="handleToggleTester('${result.userId}', ${!result.tierTester})">
                        ${result.tierTester ? '<i class="fas fa-times"></i> Remove Tester' : '<i class="fas fa-check"></i> Make Tester'}
                      </button>
                    ` : ''}
                    ${canMakeAdmin ? `
                      <button class="btn btn-sm ${result.admin ? 'btn-warning' : 'btn-primary'}"
                              onclick="handleToggleAdmin('${result.userId}', ${!result.admin})">
                        ${result.admin ? '<i class="fas fa-times"></i> Remove Admin' : '<i class="fas fa-crown"></i> Make Admin'}
                      </button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-3">
        <button class="btn btn-secondary btn-sm" type="button" ${adminUiState.unifiedSearch.page <= 1 ? 'disabled' : ''} onclick="changeUnifiedSearchPage(-1)">Previous</button>
        <span class="text-muted">Page ${adminUiState.unifiedSearch.page} / ${adminUiState.unifiedSearch.totalPages}</span>
        <button class="btn btn-secondary btn-sm" type="button" ${adminUiState.unifiedSearch.page >= adminUiState.unifiedSearch.totalPages ? 'disabled' : ''} onclick="changeUnifiedSearchPage(1)">Next</button>
      </div>
    `;
  } catch (error) {
    console.error('Error in unified search:', error);
    resultsDiv.innerHTML = `<div class="alert alert-error">Error searching: ${escapeHtml(error.message)}</div>`;
  }
}

async function changeUnifiedSearchPage(delta) {
  const next = adminUiState.unifiedSearch.page + delta;
  if (next < 1 || next > (adminUiState.unifiedSearch.totalPages || 1)) return;
  adminUiState.unifiedSearch.page = next;
  await handleUnifiedSearch({ preventDefault: () => {} });
}

/**
 * Handle manage result button click
 */
function handleManageResult(type, id, name, username, userId, playerId) {
  if (type === 'player') {
    openManagementScreen('player', id, name, username, userId || '', playerId || id);
  } else {
    openManagementScreen('user', id, name, username, userId, playerId || '');
  }
}

/**
 * Handle toggle tester with refresh
 */
async function handleToggleTester(userId, status) {
  try {
    await toggleTierTester(userId, status);
    // Refresh search results after a short delay to ensure backend has updated
    setTimeout(async () => {
      const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
      if (searchTerm) {
        const event = { preventDefault: () => {} };
        await handleUnifiedSearch(event);
      }
    }, 500);
  } catch (error) {
    console.error('Error toggling tester:', error);
  }
}

/**
 * Handle toggle admin with refresh
 */
async function handleToggleAdmin(userId, status) {
  try {
    await toggleAdmin(userId, status);
    // Refresh search results after a short delay to ensure backend has updated
    setTimeout(async () => {
      const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
      if (searchTerm) {
        const event = { preventDefault: () => {} };
        await handleUnifiedSearch(event);
      }
    }, 500);
  } catch (error) {
    console.error('Error toggling admin:', error);
  }
}


/**
 * Load banned accounts (shows search instruction)
 */
async function loadBannedAccounts() {
  const listDiv = document.getElementById('bannedAccountsList');
  listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">Use the search above to find banned accounts</p></div>';
}

/**
 * Handle search reported accounts
 */
async function handleSearchReported(event) {
  event.preventDefault();

  const searchTerm = document.getElementById('reportedSearch').value.trim();
  const listDiv = document.getElementById('reportedAccountsList');

  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.searchReportedAccounts(searchTerm);

    if (!response || !response.reportedAccounts) {
      throw new Error('Invalid response from server');
    }

    const reportedAccounts = response.reportedAccounts || [];

    if (reportedAccounts.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No reported alt groups found matching your search</p></div>';
      return;
    }

    displayReportedAccounts(reportedAccounts);
  } catch (error) {
    console.error('Error searching reported accounts:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error searching reported accounts: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Load reported accounts (shows all)
 */
async function loadReportedAccounts() {
  const listDiv = document.getElementById('reportedAccountsList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.getReportedAccounts();

    if (!response || !response.reportedAccounts) {
      throw new Error('Invalid response from server');
    }

    const reportedAccounts = response.reportedAccounts || [];

    if (reportedAccounts.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No reported alt groups</p></div>';
      return;
    }

    displayReportedAccounts(reportedAccounts);
  } catch (error) {
    console.error('Error loading reported accounts:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading reported accounts: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Display reported accounts
 */
function displayReportedAccounts(reportedAccounts) {
  const listDiv = document.getElementById('reportedAccountsList');

  if (!reportedAccounts || reportedAccounts.length === 0) {
    listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No reported alt groups</p></div>';
    return;
  }

  listDiv.innerHTML = reportedAccounts.map(account => {
    const suspiciousAccounts = account.suspiciousAccounts || [];
    const groupId = account.groupId || '';
    const accountCount = groupId.split('_').length;

    return `
      <div class="card mb-3">
        <div class="card-body">
          <div class="row">
            <div class="col-md-8">
              <h4>Alt Group: ${accountCount} Accounts</h4>
              <div class="mb-2">
                <span class="badge badge-warning">Flagged ${account.flagCount || 1} times</span>
                <span class="badge badge-info">${account.type || 'Unknown'}</span>
              </div>
              <p><strong>Primary Account:</strong> ${escapeHtml(account.primaryAccount || 'Unknown')}</p>
              <p><strong>Detection Reason:</strong> ${escapeHtml(account.detectionReason || 'N/A')}</p>
              ${account.lastDetectionReason && account.lastDetectionReason !== account.detectionReason ? `<p><strong>Last Reason:</strong> ${escapeHtml(account.lastDetectionReason)}</p>` : ''}
              <p><strong>Related Accounts:</strong></p>
              <ul class="mb-2">
                ${suspiciousAccounts.length > 0 ? suspiciousAccounts.map(acc => `
                  <li>${escapeHtml(acc.email || acc.uid || 'Unknown')} ${acc.minecraftUsername ? `(${escapeHtml(acc.minecraftUsername)})` : ''} - ${acc.confidence || 'N/A'} confidence</li>
                `).join('') : '<li>No accounts listed</li>'}
              </ul>
              <p class="text-muted">First reported: ${account.reportedAt ? new Date(account.reportedAt).toLocaleString() : 'Unknown'}</p>
              <p class="text-muted">Last flagged: ${account.lastFlaggedAt || account.reportedAt ? new Date(account.lastFlaggedAt || account.reportedAt).toLocaleString() : 'Unknown'}</p>
              <p class="text-muted">Last IP: ${account.lastClientIP || account.clientIP || 'Unknown'}</p>
            </div>
            <div class="col-md-4">
              <div class="d-flex flex-column gap-2">
                <button class="btn btn-warning btn-sm" onclick="moveToJudgmentDay('${account.id}')">
                  <i class="fas fa-gavel"></i> To Judgment Day
                </button>
                <button class="btn btn-info btn-sm" onclick="resistAltReport('${account.id}', '${account.detectionReason || 'unknown'}')">
                  <i class="fas fa-shield-alt"></i> Resist Report
                </button>
                <button class="btn btn-danger btn-sm" onclick="removeAltReport('${account.id}')">
                  <i class="fas fa-trash"></i> Remove Report
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Move report to judgment day
 */
async function moveToJudgmentDay(reportId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Move to Judgment Day?',
    text: 'This will add the account to the judgment day list for mass banning.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Move',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.moveToJudgmentDay(reportId);
      Swal.fire({
        icon: 'success',
        title: 'Moved to Judgment Day',
        text: 'Report has been removed from the reported list',
        timer: 1500,
        showConfirmButton: false
      });
      loadReportedAccounts();
      if (currentTab === 'judgment') {
        loadJudgmentDayAccounts();
      }
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Remove alt report
 */
async function removeAltReport(reportId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Remove Report?',
    text: 'This will remove the alt report from the system.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Remove',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.removeAltReport(reportId);
      Swal.fire({
        icon: 'success',
        title: 'Report Removed',
        timer: 1500,
        showConfirmButton: false
      });
      loadReportedAccounts();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Resist alt report (whitelist specific detection type)
 */
async function resistAltReport(reportId, detectionReason) {
  // Determine detection type from reason
  let detectionType = 'unknown';
  if (detectionReason.toLowerCase().includes('vpn')) {
    detectionType = 'vpn';
  } else if (detectionReason.toLowerCase().includes('ip') || detectionReason.toLowerCase().includes('subnet')) {
    detectionType = 'ip';
  } else if (detectionReason.toLowerCase().includes('username')) {
    detectionType = 'username';
  } else if (detectionReason.toLowerCase().includes('email')) {
    detectionType = 'email';
  }

  const result = await Swal.fire({
    icon: 'warning',
    title: 'Resist Report?',
    text: `This will whitelist the user for ${detectionType} detection. They won't be flagged for this type again.`,
    showCancelButton: true,
    confirmButtonText: 'Yes, Resist',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      // Get all reports to find this one
      const response = await apiService.getReportedAccounts();
      const allReports = Array.isArray(response?.reportedAccounts) ? response.reportedAccounts : [];
      const report = allReports.find(r => r.id === reportId);
      if (!report) throw new Error('Report not found');

      // Primary account is the identifier
      const primaryAccount = report.primaryAccount || report.email;
      if (!primaryAccount) throw new Error('Could not determine user from report');

      // Add to whitelist for this detection type
      await apiService.addToAltWhitelist(primaryAccount, detectionType);
      
      // Remove the report after whitelisting
      await apiService.removeAltReport(reportId);
      
      Swal.fire({
        icon: 'success',
        title: 'Report Resisted',
        text: `User whitelisted for ${detectionType} detection`,
        timer: 1500,
        showConfirmButton: false
      });
      loadReportedAccounts();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Switch between alt reports and security logs tabs
 */
function switchReportsTab(tab) {
  const altTab = document.getElementById('reportsTabAlt');
  const securityTab = document.getElementById('reportsTabSecurity');
  const noshowTab = document.getElementById('reportsTabNoShow');
  const userTab = document.getElementById('reportsTabUser');
  const messagesTab = document.getElementById('reportsTabMessages');
  
  const altSection = document.getElementById('altReportsSection');
  const securitySection = document.getElementById('securityLogsSection');
  const noshowSection = document.getElementById('noshowReportsSection');
  const userSection = document.getElementById('userReportsSection');
  const messageSection = document.getElementById('messageReportsSection');
  
  // Reset all tabs
  [altTab, securityTab, noshowTab, userTab, messagesTab].forEach(btn => {
    if (btn) {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
    }
  });
  
  [altSection, securitySection, noshowSection, userSection, messageSection].forEach(section => {
    if (section) section.classList.add('d-none');
  });
  
  // Activate selected tab
  if (tab === 'alt') {
    if (altTab) {
      altTab.classList.remove('btn-secondary');
      altTab.classList.add('btn-primary');
    }
    if (altSection) altSection.classList.remove('d-none');
  } else if (tab === 'security') {
    if (securityTab) {
      securityTab.classList.remove('btn-secondary');
      securityTab.classList.add('btn-primary');
    }
    if (securitySection) {
      securitySection.classList.remove('d-none');
      loadSecurityLogs();
      loadSecurityWhitelist();
    }
  } else if (tab === 'noshow') {
    if (noshowTab) {
      noshowTab.classList.remove('btn-secondary');
      noshowTab.classList.add('btn-primary');
    }
    if (noshowSection) {
      noshowSection.classList.remove('d-none');
      loadNoshowReports();
    }
  } else if (tab === 'user') {
    if (userTab) {
      userTab.classList.remove('btn-secondary');
      userTab.classList.add('btn-primary');
    }
    if (userSection) {
      userSection.classList.remove('d-none');
      loadUserReports();
    }
  } else if (tab === 'messages') {
    if (messagesTab) {
      messagesTab.classList.remove('btn-secondary');
      messagesTab.classList.add('btn-primary');
    }
    if (messageSection) {
      messageSection.classList.remove('d-none');
      loadMessageReports();
    }
  }
}

function adminCanReviewChatReports() {
  return clientStaffHasCapability('moderation:chat_reports:view');
}

function adminCanManageChatRestrictions() {
  return clientStaffHasCapability('moderation:chat:block');
}

function adminCanManageLeaderboardFilters() {
  return clientStaffHasCapability('leaderboard:filters:manage');
}

function getVisibleModerationTabs() {
  const visibleTabs = [];
  if (clientAdminHasCapability('applications:manage') || clientAdminHasCapability('blacklist:view')) {
    visibleTabs.push('tester');
  }
  if (clientAdminHasCapability('blacklist:view')) {
    visibleTabs.push('blacklist');
  }
  if (adminCanReviewChatReports() || adminCanManageChatRestrictions() || adminCanManageLeaderboardFilters()) {
    visibleTabs.push('tools');
  }
  return [...new Set(visibleTabs)];
}

function buildAdminLeaderboardGamemodeFilterGrid() {
  const container = document.getElementById('adminLeaderboardGamemodeFilterGrid');
  if (!container) return;

  container.innerHTML = (CONFIG.GAMEMODES || [])
    .filter((gamemode) => gamemode.id !== 'overall')
    .map((gamemode) => `
      <label style="display: flex; align-items: center; gap: 0.55rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border-color); border-radius: 10px; background: var(--secondary-bg);">
        <input type="checkbox" class="admin-leaderboard-gamemode-filter" value="${escapeHtml(gamemode.id)}">
        <span>${escapeHtml(gamemode.name)}</span>
      </label>
    `)
    .join('');
}

async function loadAdminModeratorChatReports() {
  const list = document.getElementById('adminModerationChatReportsList');
  if (!list || !adminCanReviewChatReports()) return;

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
            ${adminCanManageChatRestrictions() ? `
              <button class="btn btn-warning btn-sm" type="button" onclick="prefillAdminModeratorChatRestriction('${escapeHtml(report.reportedPlayer || '')}', '${escapeHtml(report.reportedPlayer || '')}', 'Chat report ${escapeHtml(report.id || '')}')">
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

function prefillAdminModeratorChatRestriction(targetUserId, targetUsername, reason = '') {
  const targetInput = document.getElementById('adminModerationChatTarget');
  const reasonInput = document.getElementById('adminModerationChatReason');
  if (targetInput) {
    targetInput.value = targetUserId || targetUsername || '';
  }
  if (reasonInput && reason) {
    reasonInput.value = reason;
  }
  document.getElementById('adminModerationChatRestrictionForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitAdminModeratorChatRestriction(event, { active = true } = {}) {
  event.preventDefault();

  const target = document.getElementById('adminModerationChatTarget')?.value?.trim() || '';
  const durationHours = parseInt(document.getElementById('adminModerationChatDuration')?.value || '24', 10) || 24;
  const reason = document.getElementById('adminModerationChatReason')?.value?.trim() || '';

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

    await loadAdminModeratorChatReports();
  } catch (error) {
    Swal.fire('Unable to Update Chat Restriction', error.message || 'Please try again.', 'error');
  }
}

async function clearAdminModeratorChatRestriction() {
  const fakeEvent = { preventDefault() {} };
  await submitAdminModeratorChatRestriction(fakeEvent, { active: false });
}

async function loadAdminLeaderboardModerationFilters() {
  const list = document.getElementById('adminLeaderboardModeratorList');
  if (!list || !adminCanManageLeaderboardFilters()) return;

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
          <button class="btn btn-secondary btn-sm" type="button" onclick="removeAdminLeaderboardFilter('${escapeHtml(entry.userId || '')}')">
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

async function submitAdminLeaderboardFilter(event) {
  event.preventDefault();

  const target = document.getElementById('adminLeaderboardFilterTarget')?.value?.trim() || '';
  const reason = document.getElementById('adminLeaderboardFilterReason')?.value?.trim() || '';
  const globalHidden = document.getElementById('adminLeaderboardFilterGlobal')?.checked === true;
  const gamemodes = Array.from(document.querySelectorAll('.admin-leaderboard-gamemode-filter:checked')).map((input) => input.value);

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
    await loadAdminLeaderboardModerationFilters();
  } catch (error) {
    Swal.fire('Unable to Save Filter', error.message || 'Please try again.', 'error');
  }
}

async function removeAdminLeaderboardFilter(userId) {
  if (!userId) return;

  try {
    await apiService.removeLeaderboardFilter(userId);
    apiService.clearCache('/players');
    await loadAdminLeaderboardModerationFilters();
  } catch (error) {
    Swal.fire('Unable to Remove Filter', error.message || 'Please try again.', 'error');
  }
}

function renderAdminModeratorToolsSection() {
  const toolsSection = document.getElementById('moderatorToolsModSection');
  const chatCard = document.getElementById('adminModeratorToolsCard');
  const chatSection = document.getElementById('adminModerationChatSection');
  const leaderboardCard = document.getElementById('adminLeaderboardToolsCard');
  const leaderboardSection = document.getElementById('adminLeaderboardModerationSection');
  const chatIntro = document.getElementById('adminModerationToolsIntro');
  const leaderboardIntro = document.getElementById('adminLeaderboardToolsIntro');

  const canReviewChat = adminCanReviewChatReports();
  const canManageChat = adminCanManageChatRestrictions();
  const canManageLeaderboard = adminCanManageLeaderboardFilters();
  const hasAnyTools = canReviewChat || canManageChat || canManageLeaderboard;

  if (toolsSection) {
    toolsSection.classList.toggle('d-none', !hasAnyTools);
  }
  if (chatCard) {
    chatCard.style.display = (canReviewChat || canManageChat) ? 'block' : 'none';
  }
  if (chatSection) {
    chatSection.style.display = (canReviewChat || canManageChat) ? 'block' : 'none';
  }
  if (leaderboardCard) {
    leaderboardCard.style.display = canManageLeaderboard ? 'block' : 'none';
  }
  if (leaderboardSection) {
    leaderboardSection.style.display = canManageLeaderboard ? 'block' : 'none';
  }
  if (chatIntro) {
    chatIntro.textContent = canManageChat
      ? 'Review pending chat reports and apply or remove chat restrictions from this admin section.'
      : 'Review pending chat reports from this admin section.';
  }
  if (leaderboardIntro) {
    leaderboardIntro.textContent = 'Manage public leaderboard visibility filters here without separating it from the rest of moderation.';
  }

  if (canReviewChat) {
    loadAdminModeratorChatReports();
  }
  if (canManageLeaderboard) {
    buildAdminLeaderboardGamemodeFilterGrid();
    loadAdminLeaderboardModerationFilters();
  }
}

function focusAdminModerationToolFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const tool = String(params.get('tool') || '').trim().toLowerCase();
  if (!tool) return;

  const targetId = tool === 'leaderboard-filters'
    ? 'adminLeaderboardToolsCard'
    : tool === 'moderator-chat'
      ? 'adminModeratorToolsCard'
      : '';
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target || target.style.display === 'none') return;
  const navbar = document.querySelector('.navbar');
  const offset = (navbar ? navbar.offsetHeight : 80) + 16;
  const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  params.delete('tool');
  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`;
  window.history.replaceState({}, '', nextUrl);
}

function switchModerationTab(tab) {
  const buttons = {
    tester: document.getElementById('modTabTester'),
    blacklist: document.getElementById('modTabBlacklist'),
    tools: document.getElementById('modTabTools')
  };
  const sections = {
    tester: document.getElementById('testerModSection'),
    blacklist: document.getElementById('blacklistModSection'),
    tools: document.getElementById('moderatorToolsModSection')
  };
  const visibleTabs = getVisibleModerationTabs();
  const targetTab = visibleTabs.includes(tab) ? tab : (visibleTabs[0] || 'tester');

  Object.entries(buttons).forEach(([key, button]) => {
    const visible = visibleTabs.includes(key);
    if (button) {
      button.style.display = visible ? '' : 'none';
      button.classList.toggle('btn-primary', key === targetTab && visible);
      button.classList.toggle('btn-secondary', key !== targetTab && visible);
    }
  });

  Object.entries(sections).forEach(([key, section]) => {
    if (!section) return;
    section.classList.toggle('d-none', key !== targetTab || !visibleTabs.includes(key));
  });

  if (targetTab === 'tester') {
    loadTierTesterApplications();
  } else if (targetTab === 'tools') {
    renderAdminModeratorToolsSection();
    focusAdminModerationToolFromQuery();
  }
}

/**
 * Old switchReportsTab function kept for backwards compatibility - now handles all 4 tabs (replaced above)

/**
 * Load security logs
 */
async function loadSecurityLogs() {
  const listDiv = document.getElementById('securityLogsList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const severity = document.getElementById('securitySeverityFilter')?.value || null;
    const type = document.getElementById('securityTypeFilter')?.value || null;
    const userId = document.getElementById('securityUserIdFilter')?.value?.trim() || null;
    
    const response = await apiService.getSecurityLogs(100, severity, type, userId);

    if (!response || !response.logs) {
      throw new Error('Invalid response from server');
    }

    const logs = response.logs || [];

    if (logs.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No security logs found</p></div>';
      return;
    }

    displaySecurityLogs(logs);
  } catch (error) {
    console.error('Error loading security logs:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading security logs: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Display security logs
 */
function displaySecurityLogs(logs) {
  const listDiv = document.getElementById('securityLogsList');

  if (logs.length === 0) {
    listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No security logs found</p></div>';
    return;
  }

  listDiv.innerHTML = logs.map(log => {
    const severityColor = log.severity === 'high' ? 'danger' : log.severity === 'medium' ? 'warning' : 'info';
    const typeLabel = log.type ? log.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Unknown';
    
    return `
      <div class="card mb-3">
        <div class="card-body">
          <div class="row">
            <div class="col-md-8">
              <div class="mb-2">
                <span class="badge badge-${severityColor}">${log.severity || 'unknown'}</span>
                <span class="badge badge-info">${typeLabel}</span>
              </div>
              ${log.userId ? `<p><strong>User ID:</strong> <code>${escapeHtml(log.userId)}</code></p>` : ''}
              ${log.gamemode ? `<p><strong>Gamemode:</strong> ${escapeHtml(log.gamemode)}</p>` : ''}
              ${log.matchId ? `<p><strong>Match ID:</strong> <code>${escapeHtml(log.matchId)}</code></p>` : ''}
              ${log.username ? `<p><strong>Username:</strong> ${escapeHtml(log.username)}</p>` : ''}
              ${log.patterns && log.patterns.length > 0 ? `
                <p><strong>Detected Patterns:</strong></p>
                <ul class="mb-2">
                  ${log.patterns.map(pattern => `
                    <li>${escapeHtml(pattern.description || pattern.type || 'Unknown pattern')} (${pattern.severity || 'unknown'})</li>
                  `).join('')}
                </ul>
              ` : ''}
              ${log.anomalies && log.anomalies.length > 0 ? `
                <p><strong>Anomalies:</strong></p>
                <ul class="mb-2">
                  ${log.anomalies.map(anomaly => `
                    <li>${escapeHtml(anomaly.description || anomaly.type || 'Unknown anomaly')} (${anomaly.severity || 'unknown'})</li>
                  `).join('')}
                </ul>
              ` : ''}
              ${log.action ? `<p><strong>Action:</strong> ${escapeHtml(log.action)}</p>` : ''}
              ${log.message ? `<p><strong>Message:</strong> ${escapeHtml(log.message)}</p>` : ''}
              <p class="text-muted">Detected: ${new Date(log.detectedAt).toLocaleString()}</p>
            </div>
            <div class="col-md-4 text-end">
              <div class="d-flex flex-column gap-2">
                <button class="btn btn-danger btn-sm" onclick="removeSecurityLog('${log.id}')">
                  <i class="fas fa-trash"></i> Remove Log
                </button>
                <small class="text-muted">
                  <i class="fas fa-clock"></i> ${new Date(log.detectedAt).toLocaleString()}
                </small>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Remove security log
 */
async function removeSecurityLog(logId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Remove Security Log?',
    text: 'This will remove the security log entry from the system.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Remove',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.removeSecurityLog(logId);
      Swal.fire({
        icon: 'success',
        title: 'Log Removed',
        timer: 1500,
        showConfirmButton: false
      });
      loadSecurityLogs();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Load judgment day accounts
 */
async function loadJudgmentDayAccounts() {
  const listDiv = document.getElementById('judgmentDayList');
  const actionsDiv = document.getElementById('judgmentDayActions');

  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.getJudgmentDayAccounts();

    if (!response || !response.judgmentDayAccounts) {
      throw new Error('Invalid response from server');
    }

    const judgmentDayAccounts = response.judgmentDayAccounts || [];

    if (judgmentDayAccounts.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No accounts in judgment day</p></div>';
      actionsDiv.style.display = 'none';
      return;
    }

    actionsDiv.style.display = 'block';

    listDiv.innerHTML = `
      <div class="alert alert-danger mb-4">
        <strong>${judgmentDayAccounts.length}</strong> alt group(s) awaiting final judgment
        <br><small>⚠️ These reports have been removed from the reported list and will be permanently executed</small>
      </div>
      ${judgmentDayAccounts.map(account => `
        <div class="card mb-3">
          <div class="card-body">
            <div class="row">
              <div class="col-md-8">
                <h5>Alt Group: ${account.groupId.split('_').length} Accounts</h5>
                <div class="mb-2">
                  <span class="badge badge-danger">Flagged ${account.flagCount || 1} times</span>
                  <span class="badge badge-info">${account.type}</span>
                </div>
                <p><strong>Primary Account:</strong> ${escapeHtml(account.primaryAccount || 'Unknown')}</p>
                <p><strong>All Accounts in Group:</strong></p>
                <ul class="mb-2">
                  <li><strong>${escapeHtml(account.primaryAccount || 'Unknown')}</strong> (Primary)</li>
                  ${account.suspiciousAccounts.map(acc => `
                    <li>${escapeHtml(acc.email || acc.uid)} ${acc.minecraftUsername ? `(${escapeHtml(acc.minecraftUsername)})` : ''}</li>
                  `).join('')}
                </ul>
                <p><strong>Latest Detection:</strong> ${escapeHtml(account.lastDetectionReason || account.detectionReason)}</p>
                <p class="text-muted">First reported: ${new Date(account.reportedAt).toLocaleString()}</p>
                <p class="text-muted">Last flagged: ${new Date(account.lastFlaggedAt || account.reportedAt).toLocaleString()}</p>
              </div>
              <div class="col-md-4">
                <div class="alert alert-danger">
                  <strong>Judgment Action:</strong><br>
                  All ${account.groupId.split('_').length} accounts will be banned<br>
                  All Minecraft usernames will be blacklisted
                </div>
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    `;
  } catch (error) {
    console.error('Error loading judgment day accounts:', error);
    const errorMessage = error.message || 'Unknown error occurred';
    if (errorMessage.includes('403') || errorMessage.includes('permission') || errorMessage.includes('admin')) {
      listDiv.innerHTML = `<div class="alert alert-error">Access denied: Admin privileges required to view judgment day accounts.</div>`;
    } else {
      listDiv.innerHTML = `<div class="alert alert-error">Error loading judgment day accounts: ${escapeHtml(errorMessage)}</div>`;
    }
    actionsDiv.style.display = 'none';
  }
}

/**
 * Execute judgment day
 */
async function executeJudgmentDay() {
    const result = await Swal.fire({
      icon: 'warning',
      title: 'Execute FINAL Judgment?',
      html: 'This will <strong>permanently ban ALL accounts</strong> in these alt groups and <strong>blacklist ALL Minecraft usernames</strong>.<br><br>These reports have already been <strong>removed from the reported list</strong>.<br><br>This action <strong>CANNOT BE UNDONE</strong> and will permanently execute these accounts.',
      showCancelButton: true,
      confirmButtonText: 'Execute FINAL Judgment',
      cancelButtonText: 'Cancel',
      confirmButtonColor: '#dc3545'
    });

  if (result.isConfirmed) {
    try {
      const response = await apiService.executeJudgmentDay();

      Swal.fire({
        icon: 'success',
        title: 'Judgment Executed!',
        html: `
          <div style="text-align: left;">
            <p><strong>Results:</strong></p>
            <ul style="text-align: left;">
              <li>${response.stats.bannedCount} accounts banned</li>
              <li>${response.stats.blacklistedCount} usernames blacklisted</li>
              <li>${response.stats.processedCount} alt groups processed</li>
            </ul>
            <p><strong>Executed Groups:</strong></p>
            <ul style="text-align: left; max-height: 200px; overflow-y: auto;">
              ${response.results.map(result => `
                <li><strong>${result.groupId}:</strong> ${result.accountsProcessed || 0} accounts (${result.flagCount || 1} flags)</li>
              `).join('')}
            </ul>
          </div>
        `,
        confirmButtonText: 'OK'
      });

      // Refresh all relevant tabs (judgment day entries are removed after execution)
      loadJudgmentDayAccounts();
      if (currentTab === 'reported') {
        loadReportedAccounts();
      }
      if (currentTab === 'banned') {
        // Refresh banned search if it was loaded
        const bannedForm = document.getElementById('searchBannedForm');
        if (bannedForm) {
          bannedForm.dispatchEvent(new Event('submit'));
        }
      }

    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Judgment Failed',
        text: error.message
      });
    }
  }
}

/**
 * Handle add to whitelist
 */
async function handleAddToWhitelist(event) {
  event.preventDefault();

  const identifier = document.getElementById('whitelistIdentifier').value.trim();

  try {
    await apiService.addToAltWhitelist(identifier);
    Swal.fire({
      icon: 'success',
      title: 'Added to Whitelist',
      text: 'Account added to alt detection whitelist',
      timer: 1500,
      showConfirmButton: false
    });
    document.getElementById('whitelistForm').reset();
    loadWhitelist();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed',
      text: error.message
    });
  }
}

/**
 * Load whitelist
 */
async function loadWhitelist() {
  const listDiv = document.getElementById('whitelistList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.getAltWhitelist();

    if (!response || !response.whitelistedAccounts) {
      throw new Error('Invalid response from server');
    }

    const whitelistedAccounts = response.whitelistedAccounts || [];

    if (whitelistedAccounts.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No whitelisted accounts</p></div>';
      return;
    }

    listDiv.innerHTML = whitelistedAccounts.map(account => `
      <div class="card mb-3">
        <div class="card-body">
          <div class="row align-items-center">
            <div class="col-md-8">
              <h5>${escapeHtml(account.email || 'Unknown')}</h5>
              <p class="text-muted">Firebase UID: ${account.firebaseUid}</p>
              <p class="text-muted">Whitelisted: ${new Date(account.whitelistedAt).toLocaleString()}</p>
            </div>
            <div class="col-md-4">
              <button class="btn btn-danger btn-sm" onclick="handleRemoveFromWhitelist('${account.firebaseUid}')">
                <i class="fas fa-trash"></i> Remove
              </button>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading whitelist:', error);
    const errorMessage = error.message || 'Unknown error occurred';
    if (errorMessage.includes('403') || errorMessage.includes('permission') || errorMessage.includes('admin')) {
      listDiv.innerHTML = `<div class="alert alert-error">Access denied: Admin privileges required to manage whitelist.</div>`;
    } else {
      listDiv.innerHTML = `<div class="alert alert-error">Error loading whitelist: ${escapeHtml(errorMessage)}</div>`;
    }
  }
}

/**
 * Remove from whitelist
 */
async function removeFromWhitelist(firebaseUid) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Remove from Whitelist?',
    text: 'This account will be subject to alt detection again.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Remove',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.removeFromAltWhitelist(firebaseUid);
      Swal.fire({
        icon: 'success',
        title: 'Removed from Whitelist',
        timer: 1500,
        showConfirmButton: false
      });
      loadWhitelist();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Handle remove from whitelist (wrapper for onclick handlers)
 */
async function handleRemoveFromWhitelist(firebaseUid) {
  await removeFromWhitelist(firebaseUid);
}

/**
 * Load gamemode options for manual rating updates
 */
async function loadGamemodeOptions(retryCount = 0) {
  try {
    const gamemodeSelect = document.getElementById('gamemode');
    gamemodeSelect.innerHTML = '<option value="">Loading gamemodes...</option>';

    // Ensure CONFIG is available
    if (!CONFIG || !CONFIG.GAMEMODES) {
      if (retryCount < 10) { // Retry up to 10 times
        console.log(`CONFIG not available, retrying in 200ms... (attempt ${retryCount + 1}/10)`);
        setTimeout(() => loadGamemodeOptions(retryCount + 1), 200);
        return;
      } else {
        gamemodeSelect.innerHTML = '<option value="">Error loading gamemodes</option>';
        console.error('Failed to load CONFIG after 10 retries');
        return;
      }
    }

    gamemodeSelect.innerHTML = '<option value="">Select Gamemode...</option>';

    // Add all individual gamemodes (exclude 'overall' since it's calculated)
    CONFIG.GAMEMODES.forEach(gamemode => {
      if (gamemode.id !== 'overall') { // Skip overall since ratings are per-gamemode
        const option = document.createElement('option');
        option.value = gamemode.id;
        option.textContent = gamemode.name;
        gamemodeSelect.appendChild(option);
      }
    });

    console.log(`Loaded ${CONFIG.GAMEMODES.length - 1} gamemode options`);
  } catch (error) {
    console.error('Error loading gamemode options:', error);
    const gamemodeSelect = document.getElementById('gamemode');
    gamemodeSelect.innerHTML = '<option value="">Error loading gamemodes</option>';
  }
}

/**
 * Handle manual rating update form submission
 */
document.getElementById('manualRatingForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const player1Username = document.getElementById('player1Username').value.trim();
  const player1Score = parseInt(document.getElementById('player1Score').value);
  const player2Username = document.getElementById('player2Username').value.trim();
  const player2Score = parseInt(document.getElementById('player2Score').value);
  const gamemode = document.getElementById('gamemode').value;

  if (!player1Username || !player2Username || isNaN(player1Score) || isNaN(player2Score) || !gamemode) {
    Swal.fire({
      icon: 'error',
      title: 'Validation Error',
      text: 'Please fill in all fields correctly.',
      timer: 3000,
      showConfirmButton: false
    });
    return;
  }

  if (player1Score < 0 || player2Score < 0) {
    Swal.fire({
      icon: 'error',
      title: 'Validation Error',
      text: 'Scores cannot be negative.',
      timer: 3000,
      showConfirmButton: false
    });
    return;
  }

  try {
    const response = await apiService.post('/admin/manual-rating-update', {
      player1Username,
      player2Username,
      player1Score,
      player2Score,
      gamemode
    });

    if (response.success) {
      // Display results
      const resultDiv = document.getElementById('ratingUpdateResult');
      const contentDiv = document.getElementById('ratingUpdateContent');

      contentDiv.innerHTML = `
        <div class="alert alert-success">
          <h5>Ratings Updated Successfully!</h5>
          <p><strong>Gamemode:</strong> ${escapeHtml(CONFIG.GAMEMODES.find(g => g.id === gamemode)?.name || gamemode)}</p>
          <p><strong>Score:</strong> ${escapeHtml(String(player1Score))} - ${escapeHtml(String(player2Score))}</p>
          <div class="row mt-3">
            <div class="col-md-6">
              <div class="card">
                <div class="card-body">
                  <h6>${escapeHtml(String(response.results.player1.username))}</h6>
                  <p class="mb-1">Old Rating: ${escapeHtml(String(response.results.player1.oldRating))}</p>
                  <p class="mb-1">New Rating: ${escapeHtml(String(response.results.player1.newRating))}</p>
                  <p class="mb-0"><strong>Change: ${response.results.player1.ratingChange > 0 ? '+' : ''}${escapeHtml(String(response.results.player1.ratingChange))}</strong></p>
                </div>
              </div>
            </div>
            <div class="col-md-6">
              <div class="card">
                <div class="card-body">
                  <h6>${escapeHtml(String(response.results.player2.username))}</h6>
                  <p class="mb-1">Old Rating: ${escapeHtml(String(response.results.player2.oldRating))}</p>
                  <p class="mb-1">New Rating: ${escapeHtml(String(response.results.player2.newRating))}</p>
                  <p class="mb-0"><strong>Change: ${response.results.player2.ratingChange > 0 ? '+' : ''}${escapeHtml(String(response.results.player2.ratingChange))}</strong></p>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      resultDiv.style.display = 'block';

      // Clear form
      document.getElementById('manualRatingForm').reset();

      Swal.fire({
        icon: 'success',
        title: 'Success!',
        text: 'Player ratings updated successfully!',
        timer: 2000,
        showConfirmButton: false
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: response.message || 'Failed to update ratings.',
        timer: 3000,
        showConfirmButton: false
      });
    }
  } catch (error) {
    console.error('Error updating ratings:', error);
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: 'Error updating ratings. Please try again.',
      timer: 3000,
      showConfirmButton: false
    });
  }
});

/**
 * Load system status for testing tab
 */
async function loadSystemStatus() {
  try {
    const statusDiv = document.getElementById('systemStatus');

    // Get system stats
    const response = await apiService.get('/admin/stats');

    if (response.success && response.stats) {
      const stats = response.stats;

      statusDiv.innerHTML = `
        <div class="row">
          <div class="col-md-6">
            <div class="card">
              <div class="card-body">
                <h6>Active Matches</h6>
                <p class="mb-2">${stats.activeMatches || 0}/${stats.matchCapacity || 100}</p>
                <div class="progress">
                  <div class="progress-bar" style="width: ${stats.matchUtilizationPercent || 0}%"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-md-6">
            <div class="card">
              <div class="card-body">
                <h6>Players in Queue</h6>
                <p class="mb-2">${stats.queuedPlayers || 0}</p>
                <h6>Total Players</h6>
                <p class="mb-0">${stats.totalPlayers || 0}</p>
              </div>
            </div>
          </div>
        </div>
      `;
    } else {
      statusDiv.innerHTML = '<div class="alert alert-warning">Unable to load system statistics</div>';
    }
  } catch (error) {
    console.error('Error loading system status:', error);
    document.getElementById('systemStatus').innerHTML = '<div class="alert alert-danger">Error loading system status. Please try refreshing the page.</div>';
  }
}

/**
 * Test rank-up animation
 */
async function testRankUpAnimation() {
  const titleSelect = document.getElementById('testTitleSelect');
  const selectedTitle = titleSelect.value;

  if (!selectedTitle) {
    Swal.fire({
      icon: 'warning',
      title: 'Selection Required',
      text: 'Please select a title to test.',
      timer: 3000,
      showConfirmButton: false
    });
    return;
  }

  // Ensure CONFIG is available
  if (!CONFIG || !CONFIG.COMBAT_TITLES) {
    Swal.fire({
      icon: 'error',
      title: 'Configuration Error',
      text: 'Configuration not loaded. Please refresh the page.',
      timer: 3000,
      showConfirmButton: false
    });
    return;
  }

  // Find the title data from CONFIG
  const titleData = CONFIG.COMBAT_TITLES.find(t => t.title === selectedTitle);

  if (!titleData) {
    Swal.fire({
      icon: 'error',
      title: 'Configuration Error',
      text: 'Title not found in configuration.',
      timer: 3000,
      showConfirmButton: false
    });
    return;
  }

  // Create a mock rank-up event
  const mockTitleChange = {
    oldTitle: { title: 'Previous Title', icon: 'assets/badgeicons/rookie.svg' },
    newTitle: titleData
  };

  // Show the rank-up animation (reuse the logic from testing.js)
  showRankUpAnimation(mockTitleChange);

  Swal.fire({
    icon: 'info',
    title: 'Testing Animation',
    text: `Testing rank-up animation for: ${selectedTitle}`,
    timer: 2000,
    showConfirmButton: false
  });
}

// Make functions globally available
window.testRankUpAnimation = testRankUpAnimation;

/**
 * Warn a player
 */
async function warnPlayer() {
  // Defensive check to ensure apiService is available
  if (typeof apiService === 'undefined' || !apiService.warnUser) {
    alert('API service not available. Please refresh the page.');
    return;
  }

  const userId = document.getElementById('warnUserId').value.trim();
  const reason = document.getElementById('warnReason').value.trim();

  if (!userId || !reason) {
    alert('Please fill in all fields');
    return;
  }

  try {
    const result = await apiService.warnUser(userId, reason);

    if (result.success) {
      alert('Warning issued successfully');
      document.getElementById('warnUserId').value = '';
      document.getElementById('warnReason').value = '';
    } else {
      alert('Failed to issue warning: ' + (result.message || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error issuing warning:', error);
    alert('Error issuing warning: ' + error.message);
  }
}

/**
 * Load audit log with filters
 */
async function loadAuditLog(loadMore = false) {
  try {
    const action = document.getElementById('auditActionFilter').value;
    const adminUid = document.getElementById('auditAdminFilter').value.trim();
    const targetUserId = document.getElementById('auditTargetFilter').value.trim();
    const startDate = document.getElementById('auditStartDate').value;
    const endDate = document.getElementById('auditEndDate').value;

    const params = new URLSearchParams();
    if (action) params.append('action', action);
    if (adminUid) params.append('adminUid', adminUid);
    if (targetUserId) params.append('targetUserId', targetUserId);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    if (loadMore && window.auditLogOffset) {
      params.append('offset', window.auditLogOffset);
    }

    const response = await apiService.get(`/admin/audit-log?${params}`);

    if (response.success) {
      displayAuditLog(response.logs, loadMore);
      window.auditLogOffset = (window.auditLogOffset || 0) + response.logs.length;

      const loadMoreBtn = document.getElementById('auditLoadMore');
      loadMoreBtn.style.display = response.hasMore ? 'block' : 'none';
    } else {
      throw new Error(response.message || 'Failed to load audit log');
    }
  } catch (error) {
    console.error('Error loading audit log:', error);
    document.getElementById('auditLogResults').innerHTML = `
      <div class="alert alert-danger">
        <i class="fas fa-exclamation-triangle"></i> Error loading audit log: ${error.message}
      </div>
    `;
  }
}

/**
 * Display audit log entries
 */
function displayAuditLog(logs, append = false) {
  const container = document.getElementById('auditLogResults');

  if (!append) {
    container.innerHTML = '';
    window.auditLogOffset = 0;
  }

  if (logs.length === 0) {
    if (!append) {
      container.innerHTML = `
        <div class="empty-state">
          <p class="text-muted">No audit log entries found</p>
        </div>
      `;
    }
    return;
  }

  const logHtml = logs.map(log => {
    const timestamp = new Date(log.timestamp).toLocaleString();
    const actionIcon = getActionIcon(log.action);
    const actionColor = getActionColor(log.action);

    return `
      <div class="audit-log-entry card mb-3">
        <div class="card-body">
          <div class="row">
            <div class="col-md-8">
              <div class="d-flex align-items-center mb-2">
                <span class="badge ${actionColor} me-2">${actionIcon} ${log.action.replace('_', ' ')}</span>
                <small class="text-muted">${timestamp}</small>
              </div>
              <div class="mb-1">
                <strong>Admin:</strong> <code>${log.adminUid}</code>
              </div>
              ${log.targetUserId ? `<div class="mb-1"><strong>Target:</strong> <code>${log.targetUserId}</code></div>` : ''}
              <div class="mb-1">
                <strong>IP:</strong> <code>${log.ipAddress}</code>
              </div>
              ${log.details && Object.keys(log.details).length > 0 ? `
                <div class="mt-2">
                  <strong>Details:</strong>
                  <pre class="bg-light p-2 rounded small mt-1">${JSON.stringify(log.details, null, 2)}</pre>
                </div>
              ` : ''}
            </div>
            <div class="col-md-4 text-end">
              <small class="text-muted">
                <i class="fas fa-clock"></i> ${new Date(log.timestamp).toLocaleString()}
              </small>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (append) {
    container.innerHTML += logHtml;
  } else {
    container.innerHTML = logHtml;
  }
}

/**
 * Get icon for action type
 */
function getActionIcon(action) {
  const icons = {
    'BAN_USER': 'fas fa-ban',
    'UNBAN_USER': 'fas fa-check-circle',
    'WARN_USER': 'fas fa-exclamation-triangle',
    'UPDATE_RATING': 'fas fa-chart-line',
    'UPDATE_ROLES': 'fas fa-user-shield',
    'SET_ADMIN_STATUS': 'fas fa-crown',
    'SET_TESTER_STATUS': 'fas fa-vial'
  };
  return icons[action] || 'fas fa-cog';
}

/**
 * Get color class for action type
 */
function getActionColor(action) {
  const colors = {
    'BAN_USER': 'bg-danger',
    'UNBAN_USER': 'bg-success',
    'WARN_USER': 'bg-warning text-dark',
    'UPDATE_RATING': 'bg-info',
    'UPDATE_ROLES': 'bg-primary',
    'SET_ADMIN_STATUS': 'bg-dark',
    'SET_TESTER_STATUS': 'bg-secondary'
  };
  return colors[action] || 'bg-secondary';
}

/**
 * Load more audit log entries
 */
function loadMoreAuditLog() {
  loadAuditLog(true);
}

/**
 * Clear audit log filters
 */
function clearAuditFilters() {
  document.getElementById('auditActionFilter').value = '';
  document.getElementById('auditAdminFilter').value = '';
  document.getElementById('auditTargetFilter').value = '';
  document.getElementById('auditStartDate').value = '';
  document.getElementById('auditEndDate').value = '';

  document.getElementById('auditLogResults').innerHTML = `
    <div class="empty-state">
      <p class="text-muted">Filters cleared. Use the filters above to load audit log entries</p>
    </div>
  `;

  const loadMoreBtn = document.getElementById('auditLoadMore');
  loadMoreBtn.style.display = 'none';
}

/**
 * Load and display matches for admin management
 */
async function loadMatches() {
  const listDiv = document.getElementById('matchesList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const status = document.getElementById('matchStatusFilter')?.value || null;
    const gamemode = document.getElementById('matchGamemodeFilter')?.value || null;
    const search = document.getElementById('matchSearchInput')?.value?.trim() || null;
    
    const response = await apiService.getAdminMatches(status, gamemode, search, 100);

    if (!response || !response.matches) {
      throw new Error('Invalid response from server');
    }

    const matches = response.matches || [];

    if (matches.length === 0) {
      listDiv.innerHTML = '<div class="alert alert-info">No matches found matching your filters</div>';
      return;
    }

    displayMatches(matches);
  } catch (error) {
    console.error('Error loading matches:', error);
    listDiv.innerHTML = `<div class="alert alert-danger">Error loading matches: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Display matches in admin interface
 */
function displayMatches(matches) {
  const listDiv = document.getElementById('matchesList');

  if (matches.length === 0) {
    listDiv.innerHTML = '<div class="alert alert-info">No matches found</div>';
    return;
  }

  const getRoleAssignmentBadge = (match) => {
    const assignmentType = match?.roleAssignment?.type || '';
    if (assignmentType === 'dual_tier_tester_cooldown_priority') {
      return '<span class="badge badge-danger">Cooldown Forced Roles</span>';
    }
    if (assignmentType === 'dual_tier_tester_random' || match?.roleAssignment?.randomized === true) {
      return '<span class="badge badge-info">Randomized Roles</span>';
    }
    if (assignmentType === 'admin_force_test') {
      return '<span class="badge badge-dark">Force Created</span>';
    }
    return '';
  };

  listDiv.innerHTML = matches.map(match => {
    const isFinalized = match.finalized;
    const isActive = match.status === 'active';
    const canManageMatches = clientAdminHasCapability('matches:manage');
    const canViewTimeline = clientAdminHasCapability('matches:view');
    const canManageDisputes = clientAdminHasCapability('disputes:manage') || clientAdminHasCapability('reports:manage');
    const createdTime = new Date(match.createdAt).toLocaleString();
    const finalizedTime = match.finalizedAt ? new Date(match.finalizedAt).toLocaleString() : '-';
    const ratingChange = match.finalizationData?.ratingChanges?.playerRatingChange;
    const ratingChangeDisplay = ratingChange !== undefined ? (ratingChange >= 0 ? `+${ratingChange}` : ratingChange) : '-';
    const roleAssignmentBadge = getRoleAssignmentBadge(match);
    const roleAssignmentReason = match?.roleAssignment?.explanation || '';

    return `
      <div class="card mb-3">
        <div class="card-body">
          <div class="row">
            <div class="col-md-8">
              <div class="mb-2">
                <span class="badge badge-primary">${match.gamemode.toUpperCase()}</span>
                <span class="badge ${match.finalized ? 'badge-success' : isActive ? 'badge-warning' : 'badge-secondary'}">${match.status.toUpperCase()}</span>
                ${isFinalized ? `<span class="badge badge-info">Finalized</span>` : ''}
                ${match.forceCreated ? `<span class="badge badge-dark">Admin Match</span>` : ''}
                ${roleAssignmentBadge}
              </div>
              <p><strong>Player:</strong> ${escapeHtml(match.playerUsername)} (${escapeHtml(match.playerId?.substring(0, 8))})</p>
              <p><strong>Tester:</strong> ${escapeHtml(match.testerUsername)} (${escapeHtml(match.testerId?.substring(0, 8))})</p>
              <p><strong>Region:</strong> ${escapeHtml(match.region || '-')} | <strong>Server:</strong> ${escapeHtml(match.serverIP || '-')}</p>
              ${roleAssignmentReason ? `<p class="text-muted small mb-2"><strong>Role Debug:</strong> ${escapeHtml(roleAssignmentReason)}</p>` : ''}
              
              ${match.finalizationData ? `
                <p><strong>Score:</strong> ${match.finalizationData.playerScore} - ${match.finalizationData.testerScore}</p>
                <p><strong>Rating Change:</strong> <span class="badge ${ratingChange >= 0 ? 'badge-success' : 'badge-danger'}">${ratingChangeDisplay}</span></p>
              ` : '<p><strong>Score:</strong> Not finalized</p>'}
              
              <p class="text-muted small">Created: ${createdTime}</p>
              ${isFinalized ? `<p class="text-muted small">Finalized: ${finalizedTime}</p>` : ''}
            </div>
            <div class="col-md-4 text-end">
              <div class="d-flex flex-column gap-2">
                ${canViewTimeline ? `
                  <button class="btn btn-secondary btn-sm" onclick="openMatchTimeline('${match.id}')">
                    <i class="fas fa-stream"></i> Timeline
                  </button>
                ` : ''}
                ${canManageDisputes ? `
                  <button class="btn btn-secondary btn-sm" onclick="openMatchDisputeBoard('${match.id}')">
                    <i class="fas fa-balance-scale"></i> Disputes
                  </button>
                ` : ''}
                ${canManageMatches && !isFinalized && !isActive ? `
                  <button class="btn btn-info btn-sm" onclick="openFinalizeDialog('${match.id}', '${escapeHtml(match.playerUsername)}', '${escapeHtml(match.testerUsername)}')">
                    <i class="fas fa-check"></i> Finalize
                  </button>
                ` : ''}
                ${canManageMatches && isFinalized && match.finalizationData?.type !== 'draw_vote' ? `
                  <button class="btn btn-warning btn-sm" onclick="revertAdminMatch('${match.id}', '${escapeHtml(match.playerUsername)}')">
                    <i class="fas fa-undo"></i> Revert
                  </button>
                ` : ''}
                ${canManageMatches ? `
                  <button class="btn btn-danger btn-sm" onclick="deleteAdminMatch('${match.id}', '${escapeHtml(match.playerUsername)}')">
                    <i class="fas fa-trash"></i> Delete
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTimelineEntries(timeline = []) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return '<div class="empty-state"><p class="text-muted">No timeline entries found for this match.</p></div>';
  }

  return `<div class="timeline-list">${timeline.map((entry) => `
    <div class="timeline-item">
      <div class="timeline-item-marker"></div>
      <div class="timeline-item-content">
        <div class="timeline-item-header">
          <strong>${escapeHtml(entry.title || 'Event')}</strong>
          <span class="text-muted">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '-'}</span>
        </div>
        <div class="timeline-item-type">${escapeHtml((entry.type || 'event').replace(/_/g, ' '))}</div>
        ${entry.description ? `<p class="timeline-item-description">${escapeHtml(entry.description)}</p>` : ''}
      </div>
    </div>
  `).join('')}</div>`;
}

async function loadMatchTimeline(matchId = null) {
  const resolvedMatchId = matchId || document.getElementById('timelineMatchIdInput')?.value?.trim();
  const container = document.getElementById('matchTimelineResults');
  if (!resolvedMatchId || !container) return;

  container.innerHTML = '<div class="spinner"></div>';
  try {
    const response = await apiService.getAdminMatchTimeline(resolvedMatchId);
    container.innerHTML = renderTimelineEntries(response.timeline || []);
    const input = document.getElementById('timelineMatchIdInput');
    if (input) input.value = resolvedMatchId;
  } catch (error) {
    container.innerHTML = `<div class="alert alert-danger">Failed to load timeline: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function renderQueueInspectorResponse(response = {}) {
  const analysis = response.analysis || {};
  const previews = Array.isArray(analysis.previews) ? analysis.previews : [];
  const blockers = Array.isArray(analysis.blockers) ? analysis.blockers : [];

  return `
    <div class="admin-inspector-summary ${analysis.canMatch ? 'is-success' : 'is-warning'}">
      <strong>${analysis.canMatch ? 'Compatible pair found' : 'Pair is blocked'}</strong>
      <span>${analysis.canMatch ? 'At least one shared selection can create a match.' : 'The current queue state prevents a match.'}</span>
    </div>
    ${blockers.length ? `<div class="admin-inspector-reasons">${blockers.map((reason) => `<div class="admin-inspector-reason">${escapeHtml(reason)}</div>`).join('')}</div>` : ''}
    <div class="admin-inspector-grid">
      ${previews.map((preview) => `
        <div class="admin-inspector-card">
          <div class="admin-inspector-card-header">
            <strong>${escapeHtml(String(preview.gamemode || '').toUpperCase())}</strong>
            <span>${escapeHtml(preview.region || '-')}</span>
          </div>
          <div class="admin-inspector-card-status ${preview.canMatch ? 'is-success' : 'is-warning'}">${preview.canMatch ? 'Can Match' : 'Blocked'}</div>
          ${preview.assignment ? `<p class="text-muted">${escapeHtml(preview.assignment.explanation || '')}</p>` : ''}
          ${(preview.reasons || []).map((reason) => `<div class="admin-inspector-reason">${escapeHtml(reason)}</div>`).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

async function runQueueInspector() {
  const leftUserId = document.getElementById('queueInspectorLeftUserId')?.value?.trim();
  const rightUserId = document.getElementById('queueInspectorRightUserId')?.value?.trim();
  const container = document.getElementById('queueInspectorResults');
  if (!leftUserId || !rightUserId || !container) return;

  container.innerHTML = '<div class="spinner"></div>';
  try {
    const response = await apiService.inspectQueuePair(leftUserId, rightUserId);
    container.innerHTML = renderQueueInspectorResponse(response);
  } catch (error) {
    container.innerHTML = `<div class="alert alert-danger">Failed to inspect queue: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

function renderAdminDisputes(disputes = []) {
  const container = document.getElementById('adminDisputesList');
  if (!container) return;

  if (!Array.isArray(disputes) || disputes.length === 0) {
    container.innerHTML = '<div class="empty-state"><p class="text-muted">No disputes found for the selected filters.</p></div>';
    return;
  }

  const canManageDisputes = clientAdminHasCapability('disputes:manage') || clientAdminHasCapability('reports:manage');
  container.innerHTML = disputes.map((dispute) => `
    <div class="card mb-3">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">
          <div>
            <div class="mb-1">
              <span class="badge badge-primary">${escapeHtml((dispute.gamemode || 'match').toUpperCase())}</span>
              <span class="badge badge-secondary">${escapeHtml((dispute.status || 'open').replace(/_/g, ' '))}</span>
            </div>
            <strong>${escapeHtml(dispute.reporterUsername || 'Unknown')}</strong> disputed match <code>${escapeHtml(dispute.matchId || '')}</code>
          </div>
          <div class="text-muted small">${dispute.updatedAt ? new Date(dispute.updatedAt).toLocaleString() : '-'}</div>
        </div>
        <p>${escapeHtml(dispute.summary || '')}</p>
        ${Array.isArray(dispute.evidenceLinks) && dispute.evidenceLinks.length ? `<div class="text-muted small mb-2">Evidence: ${dispute.evidenceLinks.map((link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a>`).join(' • ')}</div>` : ''}
        <div class="text-muted small mb-2">History entries: ${Array.isArray(dispute.history) ? dispute.history.length : 0}</div>
        ${canManageDisputes ? `
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn btn-secondary btn-sm" onclick="updateAdminDisputeStatusPrompt('${dispute.disputeId}', 'in_review')">Mark In Review</button>
            <button class="btn btn-success btn-sm" onclick="updateAdminDisputeStatusPrompt('${dispute.disputeId}', 'resolved')">Resolve</button>
            <button class="btn btn-danger btn-sm" onclick="updateAdminDisputeStatusPrompt('${dispute.disputeId}', 'rejected')">Reject</button>
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

async function loadAdminDisputes() {
  const container = document.getElementById('adminDisputesList');
  if (!container) return;
  container.innerHTML = '<div class="spinner"></div>';

  try {
    const filters = {
      status: document.getElementById('disputeStatusFilter')?.value || '',
      matchId: document.getElementById('disputeMatchFilter')?.value?.trim() || '',
      userId: document.getElementById('disputeUserFilter')?.value?.trim() || ''
    };
    const response = await apiService.getAdminDisputes(filters);
    renderAdminDisputes(response.disputes || []);
  } catch (error) {
    container.innerHTML = `<div class="alert alert-danger">Failed to load disputes: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function updateAdminDisputeStatusPrompt(disputeId, status) {
  const { value: note } = await Swal.fire({
    title: `Set dispute to ${status.replace(/_/g, ' ')}`,
    input: 'textarea',
    inputPlaceholder: 'Add an optional resolution note',
    showCancelButton: true,
    confirmButtonText: 'Save'
  });

  if (note === undefined) return;
  try {
    await apiService.updateAdminDisputeStatus(disputeId, status, note || '');
    await loadAdminDisputes();
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Update Failed', text: error.message || 'Unable to update dispute.' });
  }
}

function openMatchTimeline(matchId) {
  switchTab('operations');
  const input = document.getElementById('timelineMatchIdInput');
  if (input) input.value = matchId;
  loadMatchTimeline(matchId);
}

function openMatchDisputeBoard(matchId) {
  switchTab('operations');
  const input = document.getElementById('disputeMatchFilter');
  if (input) input.value = matchId;
  loadAdminDisputes();
}

/**
 * Open dialog to finalize a match
 */
function openFinalizeDialog(matchId, playerUsername, testerUsername) {
  const { value: scores } = Swal.fire({
    title: 'Finalize Match',
    html: `
      <p>Finalize match between ${playerUsername} and ${testerUsername}</p>
      <div class="mb-3">
        <label class="form-label">Player Score</label>
        <input type="number" id="playerScore" class="form-control" min="0" value="1">
      </div>
      <div class="mb-3">
        <label class="form-label">Tester Score</label>
        <input type="number" id="testerScore" class="form-control" min="0" value="0">
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Finalize',
    cancelButtonText: 'Cancel',
    didOpen: () => {
      document.getElementById('playerScore').focus();
    }
  }).then(async (result) => {
    if (result.isConfirmed) {
      const playerScore = parseInt(document.getElementById('playerScore').value);
      const testerScore = parseInt(document.getElementById('testerScore').value);

      if (isNaN(playerScore) || isNaN(testerScore) || playerScore < 0 || testerScore < 0) {
        Swal.fire({
          icon: 'error',
          title: 'Invalid Score',
          text: 'Scores must be non-negative numbers'
        });
        return;
      }

      try {
        await apiService.adminFinalizeMatch(matchId, playerScore, testerScore);
        Swal.fire({
          icon: 'success',
          title: 'Match Finalized',
          text: 'Match has been finalized successfully',
          timer: 1500,
          showConfirmButton: false
        });
        loadMatches();
      } catch (error) {
        Swal.fire({
          icon: 'error',
          title: 'Failed',
          text: error.message
        });
      }
    }
  });
}

/**
 * Revert rating changes for a finalized match
 */
async function revertAdminMatch(matchId, playerUsername) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Revert Match Ratings?',
    html: `This will undo the rating changes from <strong>${escapeHtml(playerUsername)}</strong>'s match and mark it as reverted. This cannot be undone.`,
    showCancelButton: true,
    confirmButtonText: 'Yes, Revert',
    confirmButtonColor: '#f59e0b',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.revertAdminMatch(matchId);
      Swal.fire({
        icon: 'success',
        title: 'Reverted',
        text: 'Rating changes have been reversed.',
        timer: 1800,
        showConfirmButton: false
      });
      loadMatches();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

/**
 * Delete an admin match
 */
async function deleteAdminMatch(matchId, playerUsername) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Delete Match?',
    text: `This will delete the match for ${playerUsername}. This action cannot be undone.`,
    showCancelButton: true,
    confirmButtonText: 'Yes, Delete',
    confirmButtonColor: '#dc3545',
    cancelButtonText: 'Cancel'
  });

  if (result.isConfirmed) {
    try {
      await apiService.deleteAdminMatch(matchId);
      Swal.fire({
        icon: 'success',
        title: 'Deleted',
        text: 'Match has been deleted',
        timer: 1500,
        showConfirmButton: false
      });
      loadMatches();
    } catch (error) {
      Swal.fire({
        icon: 'error',
        title: 'Failed',
        text: error.message
      });
    }
  }
}

// Make functions globally available
if (typeof window !== 'undefined') {
  window.warnPlayer = warnPlayer;
  window.loadAuditLog = loadAuditLog;
  window.loadMoreAuditLog = loadMoreAuditLog;
  window.clearAuditFilters = clearAuditFilters;

  // Core navigation / entrypoints used by admin.html onclick handlers
  window.initAdmin = initAdmin;
  window.switchTab = switchTab;
  window.handleAddPlayer = handleAddPlayer;

  // Common actions used in admin.html inline onclicks
  window.approveApplication = approveApplication;
  window.denyApplication = denyApplication;
  window.removeFromBlacklist = removeFromBlacklist;
  window.toggleTierTester = toggleTierTester;
  // Backwards compat: older HTML/inline handlers used toggleTester()
  window.toggleTester = toggleTierTester;
  window.toggleAdmin = toggleAdmin;
  window.loadUsers = loadUsers;
  window.openPlayerManagementModal = openPlayerManagementModal; // Legacy compatibility
  window.openManagementScreen = openManagementScreen;
  window.closeManagementScreen = closeManagementScreen;
  window.selectManagementAction = selectManagementAction;
  window.resetManagementForm = resetManagementForm;
  window.executeManagementAction = executeManagementAction;
  window.loadBlacklist = loadBlacklist;
  window.loadApplications = loadApplications;

  // Search / misc handlers referenced by forms in admin.html
  window.handleSearchBanned = handleSearchBanned;
  window.handleSearchBlacklist = handleSearchBlacklist;
  window.applyBlacklistFilters = applyBlacklistFilters;
  window.changeBlacklistPage = changeBlacklistPage;
  window.handleUnifiedSearch = handleUnifiedSearch;
  window.changeUnifiedSearchPage = changeUnifiedSearchPage;
  window.handleManageResult = handleManageResult;
  window.handleToggleTester = handleToggleTester;
  window.handleToggleAdmin = handleToggleAdmin;
  window.handleAddBlacklist = handleAddBlacklist;
  window.executeJudgmentDay = executeJudgmentDay;
  window.handleAddToWhitelist = handleAddToWhitelist;
  window.handleRemoveFromWhitelist = handleRemoveFromWhitelist;
  window.switchReportsTab = switchReportsTab;
  window.loadSecurityLogs = loadSecurityLogs;
  window.saveTierTesterAppsOpenSetting = saveTierTesterAppsOpenSetting;
  window.loadMatches = loadMatches;
  window.deleteAdminMatch = deleteAdminMatch;
  window.revertAdminMatch = revertAdminMatch;
  window.openFinalizeDialog = openFinalizeDialog;
  window.addPunishUsername = addPunishUsername;
  window.removePunishUsername = removePunishUsername;
  window.executePunishment = executePunishment;
}

// NOTE: The global export block above must be closed before defining additional functions.

/**
 * Load tier tester applications
 */
async function loadTierTesterApplications() {
  const listDiv = document.getElementById('tierTesterApplicationsList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    // Load current applications-open setting into the toggle (if present)
    try {
      const toggle = document.getElementById('tierTesterAppsOpenToggle');
      if (toggle) {
        const setting = await apiService.adminGetTierTesterApplicationsOpen();
        toggle.checked = setting && setting.open === true;
      }
    } catch (_) {
      // ignore setting load failures
    }

    // Get filter and sort values
    const statusFilter = document.getElementById('testerAppStatusFilter')?.value || 'pending';
    const sortFilter = document.getElementById('testerAppSortFilter')?.value || 'newest';

    // Build query parameters
    const query = new URLSearchParams();
    if (statusFilter !== 'all') {
      query.append('status', statusFilter);
    }
    query.append('sort', sortFilter);

    const response = await apiService.get(`/admin/tier-tester-applications?${query.toString()}`);

    if (!response || !response.applications) {
      throw new Error('Invalid response from server');
    }

    const applications = response.applications || [];

    if (applications.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No tier tester applications found</p></div>';
      return;
    }

    listDiv.innerHTML = applications.map(app => `
      <div class="card mb-3 ${app.status === 'pending' ? 'border-warning' : app.status === 'approved' ? 'border-success' : app.status === 'denied' ? 'border-danger' : 'border-secondary'}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <h5 class="card-title mb-1">${escapeHtml(app.name || 'Unknown')}</h5>
            <span class="badge ${app.status === 'pending' ? 'bg-warning' : app.status === 'approved' ? 'bg-success' : app.status === 'denied' ? 'bg-danger' : app.status === 'blocked' ? 'bg-dark' : 'bg-secondary'}">${escapeHtml(app.status || 'unknown')}</span>
          </div>

          <div class="row mb-2">
            <div class="col-md-6">
              <small class="text-muted">Email:</small><br>
              <span>${escapeHtml(app.userEmail || 'N/A')}</span>
            </div>
            <div class="col-md-6">
              <small class="text-muted">Age:</small><br>
              <span>${app.age || 'N/A'}</span>
            </div>
          </div>

          <div class="row mb-2">
            <div class="col-md-6">
              <small class="text-muted">Experience:</small><br>
              <span>${escapeHtml(app.minecraftExperience || 'N/A')}</span>
            </div>
            <div class="col-md-6">
              <small class="text-muted">Favorite Gamemode:</small><br>
              <span>${escapeHtml(app.favoriteGamemode || 'N/A')}</span>
            </div>
          </div>

          <div class="row mb-3">
            <div class="col-md-6">
              <small class="text-muted">Availability:</small><br>
              <span>${escapeHtml(app.availability || 'N/A')}</span>
            </div>
            <div class="col-md-6">
              <small class="text-muted">Submitted:</small><br>
              <span>${app.submittedAt ? new Date(app.submittedAt).toLocaleDateString() : 'N/A'}</span>
            </div>
          </div>

          <div class="mb-3">
            <small class="text-muted">Why they want to be a tester:</small>
            <p class="mt-1 mb-2">${escapeHtml(app.whyTester || 'N/A')}</p>
          </div>

          ${app.previousTesting ? `
            <div class="mb-3">
              <small class="text-muted">Previous testing experience:</small>
              <p class="mt-1 mb-2">${escapeHtml(app.previousTesting)}</p>
            </div>
          ` : ''}

          ${app.improvementIdeas ? `
            <div class="mb-3">
              <small class="text-muted">Improvement ideas:</small>
              <p class="mt-1 mb-2">${escapeHtml(app.improvementIdeas)}</p>
            </div>
          ` : ''}

          ${app.reviewNotes ? `
            <div class="mb-3">
              <small class="text-muted">Review notes:</small>
              <p class="mt-1 mb-2 fst-italic">${escapeHtml(app.reviewNotes)}</p>
            </div>
          ` : ''}

          ${app.status === 'pending' ? `
            <div class="d-flex gap-2 mt-3">
              <button class="btn btn-success btn-sm" onclick="approveTierTesterApplication('${app.id}')">
                <i class="fas fa-check"></i> Approve
              </button>
              <button class="btn btn-danger btn-sm" onclick="denyTierTesterApplication('${app.id}')">
                <i class="fas fa-times"></i> Deny
              </button>
              <button class="btn btn-dark btn-sm" onclick="blockTierTesterApplication('${app.id}')">
                <i class="fas fa-ban"></i> Block
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading tier tester applications:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading applications: ${escapeHtml(error.message)}</div>`;
  }
}

async function saveTierTesterAppsOpenSetting() {
  try {
    const toggle = document.getElementById('tierTesterAppsOpenToggle');
    const btn = document.getElementById('saveTierTesterAppsOpenBtn');
    if (!toggle) return;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    await apiService.adminSetTierTesterApplicationsOpen(toggle.checked === true);
    Swal.fire({ icon: 'success', title: 'Saved', timer: 1500, showConfirmButton: false });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Save failed', text: error.message || 'Please try again.' });
  } finally {
    const btn = document.getElementById('saveTierTesterAppsOpenBtn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-save"></i> Save';
    }
  }
}

/**
 * Approve tier tester application
 */
async function approveTierTesterApplication(applicationId) {
  const { value: reviewNotes } = await Swal.fire({
    title: 'Approve Application',
    input: 'textarea',
    inputLabel: 'Review notes (optional)',
    inputPlaceholder: 'Add any notes about this approval...',
    showCancelButton: true,
    confirmButtonText: 'Approve',
    cancelButtonText: 'Cancel'
  });

  if (reviewNotes === undefined) return; // Cancelled

  try {
    await apiService.post(`/admin/tier-tester-applications/${applicationId}/approve`, {
      reviewNotes: reviewNotes.trim()
    });

    Swal.fire({
      icon: 'success',
      title: 'Approved!',
      text: 'Tier Tester application has been approved.',
      timer: 2000,
      showConfirmButton: false
    });

    // Bust player cache so new tester badge shows correctly
    if (typeof apiService.clearCache === 'function') {
      apiService.clearCache('/players');
    }

    loadTierTesterApplications(); // Reload the list
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Approve',
      text: error.message
    });
  }
}

/**
 * Deny tier tester application
 */
async function denyTierTesterApplication(applicationId) {
  const { value: reviewNotes } = await Swal.fire({
    title: 'Deny Application',
    input: 'textarea',
    inputLabel: 'Review notes (required)',
    inputPlaceholder: 'Please provide a reason for denying this application...',
    inputValidator: (value) => {
      if (!value || !value.trim()) {
        return 'Review notes are required when denying an application!';
      }
    },
    showCancelButton: true,
    confirmButtonText: 'Deny',
    cancelButtonText: 'Cancel'
  });

  if (reviewNotes === undefined) return; // Cancelled

  try {
    await apiService.post(`/admin/tier-tester-applications/${applicationId}/deny`, {
      reviewNotes: reviewNotes.trim()
    });

    Swal.fire({
      icon: 'success',
      title: 'Denied',
      text: 'Tier Tester application has been denied.',
      timer: 2000,
      showConfirmButton: false
    });

    loadTierTesterApplications(); // Reload the list
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Deny',
      text: error.message
    });
  }
}

/**
 * Block user from future tier tester applications
 */
async function blockTierTesterApplication(applicationId) {
  const { value: reviewNotes } = await Swal.fire({
    title: 'Block User from Future Applications',
    input: 'textarea',
    inputLabel: 'Blocking reason (required)',
    inputPlaceholder: 'Please provide a detailed reason for blocking this user...',
    inputValidator: (value) => {
      if (!value || !value.trim()) {
        return 'Blocking reason is required!';
      }
    },
    showCancelButton: true,
    confirmButtonText: 'Block User',
    confirmButtonColor: '#dc3545',
    cancelButtonText: 'Cancel'
  });

  if (reviewNotes === undefined) return; // Cancelled

  const { value: confirmed } = await Swal.fire({
    title: 'Confirm Blocking',
    text: 'This will prevent the user from submitting any future Tier Tester applications. Are you sure?',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Yes, Block User',
    confirmButtonColor: '#dc3545',
    cancelButtonText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    await apiService.post(`/admin/tier-tester-applications/${applicationId}/block`, {
      reviewNotes: reviewNotes.trim()
    });

    Swal.fire({
      icon: 'success',
      title: 'User Blocked',
      text: 'User has been blocked from future Tier Tester applications.',
      timer: 2000,
      showConfirmButton: false
    });

    loadTierTesterApplications(); // Reload the list
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Block',
      text: error.message
    });
  }
}

/**
 * Handle reset cooldown for a player
 */
async function handleResetCooldown(username) {
  if (!username) {
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: 'No username provided'
    });
    return;
  }

  // Ask which gamemode or all
  const result = await Swal.fire({
    title: 'Reset Cooldown',
    html: `
      <p>Reset testing cooldown for <strong>${escapeHtml(username)}</strong>?</p>
      <div class="form-group" style="margin-top: 1rem;">
        <label class="form-label">Gamemode</label>
        <select id="cooldownGamemode" class="form-select">
          <option value="">All Gamemodes</option>
          <option value="vanilla">Vanilla</option>
          <option value="uhc">UHC</option>
          <option value="pot">Pot</option>
          <option value="nethop">NethOP</option>
          <option value="smp">SMP</option>
          <option value="sword">Sword</option>
          <option value="axe">Axe</option>
          <option value="mace">Mace</option>
        </select>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Reset Cooldown',
    cancelButtonText: 'Cancel',
    preConfirm: () => {
      return document.getElementById('cooldownGamemode').value || null;
    }
  });

  if (!result.isConfirmed) return;

  const gamemode = result.value;

  try {
    const response = await apiService.resetCooldown(username, gamemode);
    
    Swal.fire({
      icon: 'success',
      title: 'Cooldown Reset',
      text: response.message || `Cooldown reset for ${username}`,
      timer: 2000,
      showConfirmButton: false
    });

    // Refresh search results
    setTimeout(async () => {
      const searchTerm = document.getElementById('unifiedSearch')?.value.trim();
      if (searchTerm) {
        const event = { preventDefault: () => {} };
        await handleUnifiedSearch(event);
      }
    }, 500);
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Reset Cooldown',
      text: error.message || 'An error occurred'
    });
  }
}

/**
 * Load whitelisted servers
 */
async function loadWhitelistedServers() {
  const serversList = document.getElementById('whitelistedServersList');
  if (!serversList) return;

  try {
    serversList.innerHTML = '<div class="spinner"></div>';

    const response = await apiService.getWhitelistedServers();

    if (!response.success || !response.servers || response.servers.length === 0) {
      serversList.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-server" style="font-size: 3rem; color: var(--text-muted); margin-bottom: 1rem;"></i>
          <p class="text-muted">No whitelisted servers found. Add one above to get started.</p>
        </div>
      `;
      return;
    }

    serversList.innerHTML = `
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Server Name</th>
              <th>IP/Domain</th>
              <th>Added</th>
              <th style="width: 100px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${response.servers.map(server => `
              <tr>
                <td><strong>${escapeHtml(server.name)}</strong></td>
                <td><code>${escapeHtml(server.ip)}</code></td>
                <td>${server.addedAt ? new Date(server.addedAt).toLocaleDateString() : 'N/A'}</td>
                <td>
                  <button class="btn btn-danger btn-sm" onclick="handleDeleteServer('${server.id}', '${escapeHtml(server.name)}')">
                    <i class="fas fa-trash"></i>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    console.error('Error loading whitelisted servers:', error);
    serversList.innerHTML = `
      <div class="alert alert-danger">
        <i class="fas fa-exclamation-triangle"></i>
        Error loading servers: ${escapeHtml(error.message)}
      </div>
    `;
  }
}

/**
 * Handle add server form submission
 */
async function handleAddServer(event) {
  event.preventDefault();

  const nameInput = document.getElementById('serverName');
  const ipInput = document.getElementById('serverIp');

  const name = nameInput.value.trim();
  const ip = ipInput.value.trim();

  if (!name || !ip) {
    Swal.fire({
      icon: 'warning',
      title: 'Missing Information',
      text: 'Please provide both server name and IP/domain.'
    });
    return;
  }

  try {
    const response = await apiService.addWhitelistedServer(name, ip);

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Server Added',
        text: `${name} has been added to the whitelist.`,
        timer: 2000,
        showConfirmButton: false
      });

      // Clear form
      nameInput.value = '';
      ipInput.value = '';

      // Reload list
      loadWhitelistedServers();
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Add Server',
      text: error.message
    });
  }
}

/**
 * Handle delete server
 */
async function handleDeleteServer(serverId, serverName) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Delete Server?',
    text: `Are you sure you want to remove "${serverName}" from the whitelist?`,
    showCancelButton: true,
    confirmButtonText: 'Yes, Delete',
    confirmButtonColor: '#e74c3c',
    cancelButtonText: 'Cancel'
  });

  if (!result.isConfirmed) return;

  try {
    const response = await apiService.deleteWhitelistedServer(serverId);

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Server Deleted',
        text: `${serverName} has been removed from the whitelist.`,
        timer: 2000,
        showConfirmButton: false
      });

      // Reload list
      loadWhitelistedServers();
    }
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Delete Server',
      text: error.message
    });
  }
}

/**
 * Load No Show Reports
 */
async function loadNoshowReports() {
  const listDiv = document.getElementById('noshowReportsList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const playerFilter = document.getElementById('noshowPlayerFilter')?.value?.trim() || '';
    const statusFilter = document.getElementById('noshowStatusFilter')?.value || '';
    
    const response = await apiService.getNoshowReports(playerFilter, statusFilter);
    
    if (!response || !response.reports) {
      listDiv.innerHTML = '<div class="alert alert-info">No No-Show reports found</div>';
      return;
    }

    const reports = response.reports || [];
    if (reports.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No No-Show reports</p></div>';
      return;
    }

    listDiv.innerHTML = reports.map(report => `
      <div class="card mb-3">
        <div class="card-body">
          <div class="row">
            <div class="col-md-8">
              <h5>${escapeHtml(report.playerName || report.playerId)}</h5>
              <p class="text-muted"><small>Report ID: ${report.id}</small></p>
              <p><strong>Status:</strong> <span class="badge badge-${report.status === 'pending' ? 'warning' : report.status === 'resolved' ? 'success' : 'secondary'}">${report.status}</span></p>
              <p><strong>Times No-Show:</strong> ${report.noShowCount || 0}</p>
              <p class="text-muted">Reported: ${new Date(report.createdAt || Date.now()).toLocaleString()}</p>
            </div>
            <div class="col-md-4">
              <div class="d-flex flex-column gap-2">
                <button class="btn btn-warning btn-sm" onclick="resolveNoshowReport('${report.id}')">
                  <i class="fas fa-check"></i> Resolve
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading no-show reports:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading reports: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Load User Reports
 */
async function loadUserReports() {
  const listDiv = document.getElementById('userReportsList');
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const playerFilter = document.getElementById('userReportsPlayerFilter')?.value?.trim() || '';
    const categoryFilter = document.getElementById('userReportsCategoryFilter')?.value || '';
    const statusFilter = document.getElementById('userReportsStatusFilter')?.value || '';
    
    const response = await apiService.getUserReports(playerFilter, categoryFilter, statusFilter);
    
    if (!response || !response.reports) {
      listDiv.innerHTML = '<div class="empty-state"><i class="fas fa-flag empty-state-icon"></i><p class="empty-state-title">No user reports found</p><p class="empty-state-desc">Try adjusting your filters</p></div>';
      return;
    }

    const reports = response.reports || [];
    if (reports.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><i class="fas fa-inbox empty-state-icon"></i><p class="empty-state-title">No reports</p><p class="empty-state-desc">No user reports match the current filters</p></div>';
      return;
    }

    const pendingCount = reports.filter(r => r.status === 'pending').length;
    const resolvedCount = reports.filter(r => r.status === 'resolved').length;

    listDiv.innerHTML = `
      <div style="display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;">
        <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 0.5rem 0.85rem; font-size: 0.85rem;">
          <i class="fas fa-clock" style="color: #f59e0b;"></i> <strong>${pendingCount}</strong> pending
        </div>
        <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 0.5rem 0.85rem; font-size: 0.85rem;">
          <i class="fas fa-check-circle" style="color: #10b981;"></i> <strong>${resolvedCount}</strong> resolved
        </div>
        <div style="background: rgba(139, 148, 158, 0.12); border: 1px solid rgba(139, 148, 158, 0.3); border-radius: 8px; padding: 0.5rem 0.85rem; font-size: 0.85rem;">
          <i class="fas fa-list" style="color: #8b949e;"></i> <strong>${reports.length}</strong> total
        </div>
      </div>
    ` + reports.map((report, idx) => {
      const statusColor = report.status === 'pending' ? '#f59e0b' : report.status === 'resolved' ? '#10b981' : '#8b949e';
      const statusBg = report.status === 'pending' ? 'rgba(245, 158, 11, 0.12)' : report.status === 'resolved' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(139, 148, 158, 0.12)';
      const categoryIcons = {
        alt_account: 'fa-users', chat_abuse: 'fa-comment-slash', unfair_play: 'fa-skull-crossbones',
        match_throwing: 'fa-hand-fist', impersonation: 'fa-user-secret', other: 'fa-question-circle'
      };
      const categoryIcon = categoryIcons[report.category] || 'fa-flag';
      const hasEvidence = report.hasEvidence || (report.evidenceLinks && report.evidenceLinks.length > 0);
      const timeAgo = formatAdminTimeAgo(report.createdAt);

      return `
      <div class="card mb-3" style="border-left: 3px solid ${statusColor}; animation: staggerFadeIn 0.3s ease forwards; animation-delay: ${idx * 0.04}s; opacity: 0;">
        <div class="card-body" style="padding: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 200px;">
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <i class="fas ${categoryIcon}" style="color: var(--accent-color); font-size: 1.1rem;"></i>
                <strong style="font-size: 1rem;">${escapeHtml(report.reportedPlayer || 'Unknown')}</strong>
                <span style="background: ${statusBg}; color: ${statusColor}; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.72rem; font-weight: 600;">
                  ${(report.status || 'pending').toUpperCase()}
                </span>
                ${hasEvidence ? '<span style="background: rgba(59, 130, 246, 0.12); color: #3b82f6; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.72rem; font-weight: 600;"><i class="fas fa-paperclip"></i> Evidence</span>' : ''}
              </div>
              <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.4rem;">
                <span style="background: var(--tertiary-bg); padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.78rem;">${escapeHtml(report.category || 'other')}</span>
                <span style="margin-left: 0.5rem; color: var(--text-muted);">reported by ${escapeHtml(report.reporterEmail || 'Anonymous')}</span>
              </div>
              <p style="font-size: 0.88rem; color: var(--text-secondary); margin: 0.4rem 0; line-height: 1.4;">${escapeHtml((report.description || '').substring(0, 200))}${(report.description || '').length > 200 ? '...' : ''}</p>
              <div style="display: flex; gap: 0.75rem; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.4rem; flex-wrap: wrap;">
                <span><i class="fas fa-clock"></i> ${timeAgo}</span>
                ${report.matchId ? `<span><i class="fas fa-gamepad"></i> Match: ${escapeHtml(report.matchId.substring(0, 12))}...</span>` : ''}
                ${report.reviewedAt ? `<span><i class="fas fa-gavel"></i> Resolved ${formatAdminTimeAgo(report.reviewedAt)}</span>` : ''}
                ${report.actionTaken ? `<span><i class="fas fa-bolt"></i> ${escapeHtml(report.actionTaken)}</span>` : ''}
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.4rem; flex-shrink: 0;">
              <button class="btn btn-info btn-sm" onclick="viewUserReport('${report.id}')" style="font-size: 0.8rem;">
                <i class="fas fa-eye"></i> Details
              </button>
              ${report.status === 'pending' ? `
                <button class="btn btn-success btn-sm" onclick="markUserReportResolved('${report.id}')" style="font-size: 0.8rem;">
                  <i class="fas fa-gavel"></i> Resolve
                </button>
                <button class="btn btn-secondary btn-sm" onclick="dismissUserReport('${report.id}')" style="font-size: 0.78rem; background: transparent; border: 1px solid var(--border-color);">
                  <i class="fas fa-times"></i> Dismiss
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (error) {
    console.error('Error loading user reports:', error);
    listDiv.innerHTML = `<div class="alert alert-error"><i class="fas fa-exclamation-triangle"></i> Error loading reports: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Format time ago for admin pages
 */
function formatAdminTimeAgo(dateStr) {
  if (!dateStr) return 'Unknown';
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return date.toLocaleDateString();
}

/**
 * Add account to security whitelist
 */
async function addToWhitelist() {
  const input = document.getElementById('whitelistUserInput');
  const userId = input.value.trim();

  if (!userId) {
    Swal.fire('Error', 'Please enter a user ID or email', 'warning');
    return;
  }

  try {
    const response = await apiService.whitelistSecurityReports(userId);

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Added to Whitelist',
        text: 'This account will not receive automated security reports.',
        timer: 2000,
        showConfirmButton: false
      });

      input.value = '';
      loadSecurityWhitelist();
    }
  } catch (error) {
    Swal.fire('Error', error.message || 'Failed to whitelist account', 'error');
  }
}

/**
 * Load security whitelist
 */
async function loadSecurityWhitelist() {
  const listDiv = document.getElementById('securityWhitelistList');
  if (!listDiv) return;
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.getSecurityWhitelist();
    const whitelisted = response.whitelisted || [];

    if (whitelisted.length === 0) {
      listDiv.innerHTML = '<p class="text-muted">No whitelisted accounts</p>';
      return;
    }

    listDiv.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem;">
        ${whitelisted.map(account => `
          <div style="background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.75rem; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${account.email || account.uid}">${escapeHtml(account.email || account.uid)}</span>
            <button class="btn btn-sm" onclick="removeFromSecurityWhitelist('${account.id}')" style="background: #ef4444; color: white; border: none; padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer;">×</button>
          </div>
        `).join('')}
      </div>
    `;
  } catch (error) {
    console.error('Error loading whitelist:', error);
    listDiv.innerHTML = '<p class="text-muted">Could not load whitelist</p>';
  }
}

/**
 * Load Message Reports
 */
async function loadMessageReports() {
  const listDiv = document.getElementById('messageReportsList');
  if (!listDiv) return;
  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const playerFilter = document.getElementById('messageReportsPlayerFilter')?.value?.trim() || '';
    const statusFilter = document.getElementById('messageReportsStatusFilter')?.value || '';

    const response = await apiService.getMessageReports(playerFilter, statusFilter);
    const reports = response?.reports || [];

    if (reports.length === 0) {
      listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No message reports</p></div>';
      return;
    }

    listDiv.innerHTML = reports.map(report => {
      const msg = report.messageReport?.reportedMessage || {};
      const status = report.status || 'pending';
      const statusBadge = status === 'pending' ? 'warning' : status === 'resolved' ? 'success' : 'secondary';
      return `
        <div class="card mb-3">
          <div class="card-body">
            <div class="row">
              <div class="col-md-8">
                <h5>Message report against ${escapeHtml(report.reportedPlayer || msg.username || 'Unknown')}</h5>
                <p class="text-muted"><small>By: ${escapeHtml(report.reporterEmail || 'Anonymous')}</small></p>
                <p><strong>Status:</strong> <span class="badge badge-${statusBadge}">${escapeHtml(status)}</span></p>
                <p><strong>Message:</strong> ${escapeHtml((msg.text || '').slice(0, 180))}${(msg.text || '').length > 180 ? '...' : ''}</p>
                <p><strong>Match:</strong> ${escapeHtml(report.matchId || 'N/A')}</p>
                <p class="text-muted">Submitted: ${new Date(report.createdAt || Date.now()).toLocaleString()}</p>
              </div>
              <div class="col-md-4">
                <div class="d-flex flex-column gap-2">
                  <button class="btn btn-info btn-sm" onclick="viewUserReport('${report.id}')">
                    <i class="fas fa-eye"></i> View Details
                  </button>
                  <button class="btn btn-success btn-sm" onclick="markUserReportResolved('${report.id}')">
                    <i class="fas fa-check"></i> Mark Resolved
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Error loading message reports:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading reports: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Remove account from security whitelist
 */
async function removeFromSecurityWhitelist(accountId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Remove from Whitelist?',
    text: 'This account will start receiving automated security reports again.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Remove',
    confirmButtonColor: '#ef4444',
    cancelButtonText: 'Cancel'
  });

  if (!result.isConfirmed) return;

  try {
    const response = await apiService.removeSecurityWhitelist(accountId);

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Removed from Whitelist',
        timer: 1500,
        showConfirmButton: false
      });

      loadSecurityWhitelist();
    }
  } catch (error) {
    Swal.fire('Error', error.message || 'Failed to remove from whitelist', 'error');
  }
}

/**
 * Resolve no-show report
 */
async function resolveNoshowReport(reportId) {
  const result = await Swal.fire({
    icon: 'question',
    title: 'Resolve No-Show Report?',
    input: 'textarea',
    inputLabel: 'Resolution notes (optional)',
    inputPlaceholder: 'Enter resolution notes...',
    showCancelButton: true,
    confirmButtonText: 'Resolve',
    cancelButtonText: 'Cancel'
  });

  if (!result.isConfirmed) return;

  try {
    const response = await apiService.resolveNoshowReport(reportId, result.value);

    if (response.success) {
      Swal.fire('Success', 'No-Show report resolved', 'success');
      loadNoshowReports();
    }
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  }
}

/**
 * View user report details
 */
async function viewUserReport(reportId) {
  try {
    const response = await apiService.getUserReportDetails(reportId);
    const report = response.report;
    const evidenceLinks = Array.isArray(report.evidenceLinks) ? report.evidenceLinks : [];
    const messageReport = report.messageReport || null;
    const conversation = Array.isArray(messageReport?.conversationSnapshot) ? messageReport.conversationSnapshot : [];
    const messageDetail = messageReport?.reportedMessage || null;

    const statusColor = report.status === 'pending' ? '#f59e0b' : report.status === 'resolved' ? '#10b981' : '#8b949e';
    const statusLabel = (report.status || 'pending').toUpperCase();

    const swalResult = await Swal.fire({
      title: `Report: ${escapeHtml(report.reportedPlayer || 'Unknown')}`,
      width: '640px',
      html: `
        <div style="text-align: left; font-size: 0.9rem; line-height: 1.6;">
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
            <span style="background: rgba(${report.status === 'pending' ? '245,158,11' : report.status === 'resolved' ? '16,185,129' : '139,148,158'}, 0.15); color: ${statusColor}; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;">${statusLabel}</span>
            <span style="background: var(--tertiary-bg, #24292e); padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem;">${escapeHtml(report.category || 'other')}</span>
            ${report.hasEvidence || evidenceLinks.length > 0 ? '<span style="background: rgba(59,130,246,0.12); color: #3b82f6; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;"><i class="fas fa-paperclip"></i> Has Evidence</span>' : ''}
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; margin-bottom: 1rem; padding: 0.75rem; background: var(--tertiary-bg, #24292e); border-radius: 8px; font-size: 0.85rem;">
            <div><strong>Reported Player:</strong> ${escapeHtml(report.reportedPlayer || 'Unknown')}</div>
            <div><strong>Reporter:</strong> ${escapeHtml(report.reporterEmail || 'Anonymous')}</div>
            ${report.reportedUUID ? `<div><strong>UUID:</strong> <code style="font-size: 0.78rem;">${escapeHtml(report.reportedUUID)}</code></div>` : ''}
            ${report.matchId ? `<div><strong>Match ID:</strong> <code style="font-size: 0.78rem;">${escapeHtml(report.matchId)}</code></div>` : ''}
            <div><strong>Submitted:</strong> ${new Date(report.createdAt).toLocaleString()}</div>
            ${report.reviewedAt ? `<div><strong>Resolved:</strong> ${new Date(report.reviewedAt).toLocaleString()}</div>` : ''}
          </div>

          <div style="margin-bottom: 1rem;">
            <strong>Description:</strong>
            <div style="background: var(--tertiary-bg, #24292e); padding: 0.75rem; border-radius: 8px; margin-top: 0.35rem; white-space: pre-wrap; max-height: 200px; overflow-y: auto;">${escapeHtml(report.description || 'No description provided')}</div>
          </div>

          ${evidenceLinks.length > 0 ? `
            <div style="margin-bottom: 1rem;">
              <strong>Evidence Links:</strong>
              <div style="margin-top: 0.35rem;">
                ${evidenceLinks.map(link => `<div style="padding: 0.25rem 0;"><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="color: #3b82f6; word-break: break-all;"><i class="fas fa-external-link-alt" style="font-size: 0.75rem;"></i> ${escapeHtml(link)}</a></div>`).join('')}
              </div>
            </div>
          ` : ''}

          ${messageDetail ? `
            <div style="margin-bottom: 1rem;">
              <strong>Reported Message:</strong>
              <div style="background: var(--tertiary-bg, #24292e); padding: 0.75rem; border-radius: 8px; margin-top: 0.35rem; border-left: 3px solid #ef4444;">
                <strong>${escapeHtml(messageDetail.username || 'Unknown')}:</strong> ${escapeHtml(messageDetail.text || '')}
                <div style="font-size: 0.78rem; color: var(--text-muted, #8b949e); margin-top: 0.25rem;">${new Date(messageDetail.timestamp || Date.now()).toLocaleString()}</div>
              </div>
            </div>
          ` : ''}

          ${conversation.length > 0 ? `
            <div style="margin-bottom: 1rem;">
              <strong>Conversation Snapshot (${conversation.length} messages):</strong>
              <div style="max-height: 180px; overflow-y: auto; background: var(--tertiary-bg, #24292e); padding: 0.75rem; border-radius: 8px; margin-top: 0.35rem;">
                ${conversation.map(msg => `
                  <div style="padding: 0.3rem 0; border-bottom: 1px solid rgba(255,255,255,0.06);">
                    <strong>${escapeHtml(msg.username || 'Unknown')}:</strong> ${escapeHtml(msg.text || '')}
                    <div style="font-size: 0.7rem; color: var(--text-muted, #8b949e);">${new Date(msg.timestamp || Date.now()).toLocaleString()}</div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${report.reviewNotes ? `
            <div style="margin-bottom: 0.75rem; padding: 0.75rem; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px;">
              <strong><i class="fas fa-gavel"></i> Resolution Notes:</strong> ${escapeHtml(report.reviewNotes)}
              ${report.actionTaken ? `<div style="margin-top: 0.35rem;"><strong>Action:</strong> ${escapeHtml(report.actionTaken)}</div>` : ''}
            </div>
          ` : ''}
        </div>
      `,
      showConfirmButton: true,
      confirmButtonText: report.status === 'pending' ? '<i class="fas fa-gavel"></i> Resolve This Report' : 'Close',
      confirmButtonColor: report.status === 'pending' ? '#10b981' : '#6b7280',
      showCancelButton: report.status === 'pending',
      cancelButtonText: 'Close'
    });

    // If admin clicked resolve on a pending report
    if (report.status === 'pending' && swalResult?.isConfirmed) {
      markUserReportResolved(reportId);
    }
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  }
}

/**
 * Mark user report as resolved
 */
async function markUserReportResolved(reportId) {
  const result = await Swal.fire({
    icon: 'question',
    title: 'Resolve Report',
    html: `
      <div style="text-align: left; font-size: 0.9rem;">
        <label style="font-weight: 600; display: block; margin-bottom: 0.35rem;">Action Taken</label>
        <select id="swal-resolve-action" class="swal2-select" style="width: 100%; padding: 0.5rem; border-radius: 6px; border: 1px solid var(--border-color, #ccc); background: var(--tertiary-bg, #24292e); color: var(--text-primary, #f3f4f6); margin-bottom: 0.75rem;">
          <option value="reviewed">Reviewed (no action)</option>
          <option value="warned">Warning Issued</option>
          <option value="blacklisted">Player Blacklisted</option>
          <option value="dismissed">Dismissed (not valid)</option>
        </select>
        <label style="font-weight: 600; display: block; margin-bottom: 0.35rem;">Resolution Notes</label>
        <textarea id="swal-resolve-notes" class="swal2-textarea" placeholder="Describe what was found and what action was taken..." style="width: 100%; min-height: 80px; border-radius: 6px; border: 1px solid var(--border-color, #ccc); background: var(--tertiary-bg, #24292e); color: var(--text-primary, #f3f4f6); padding: 0.5rem; resize: vertical;"></textarea>
        <p style="font-size: 0.78rem; color: var(--text-muted, #8b949e); margin-top: 0.35rem;">
          <i class="fas fa-info-circle"></i> Both the reporter and reported player will receive an inbox notification about this resolution.
        </p>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: '<i class="fas fa-gavel"></i> Resolve',
    cancelButtonText: 'Cancel',
    confirmButtonColor: '#10b981',
    preConfirm: () => {
      const action = document.getElementById('swal-resolve-action')?.value || 'reviewed';
      const notes = document.getElementById('swal-resolve-notes')?.value || '';
      if (!notes.trim()) {
        Swal.showValidationMessage('Please provide resolution notes');
        return false;
      }
      return { action, notes };
    }
  });

  if (!result.isConfirmed || !result.value) return;

  try {
    const response = await apiService.resolveUserReport(reportId, result.value.notes, result.value.action);

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Report Resolved',
        text: `Report resolved with action: ${result.value.action}. Both players have been notified.`,
        timer: 3000,
        showConfirmButton: false
      });
      loadUserReports();
    }
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  }
}

/**
 * Dismiss a user report (mark as resolved with dismissed action)
 */
async function dismissUserReport(reportId) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Dismiss Report?',
    input: 'textarea',
    inputLabel: 'Reason for dismissal',
    inputPlaceholder: 'Why is this report being dismissed?',
    inputValidator: (value) => {
      if (!value || !value.trim()) return 'Please provide a reason for dismissal';
    },
    showCancelButton: true,
    confirmButtonText: '<i class="fas fa-times"></i> Dismiss',
    cancelButtonText: 'Cancel',
    confirmButtonColor: '#6b7280'
  });

  if (!result.isConfirmed) return;

  try {
    const response = await apiService.resolveUserReport(reportId, result.value, 'dismissed');

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: 'Report Dismissed',
        text: 'The reporter has been notified.',
        timer: 2000,
        showConfirmButton: false
      });
      loadUserReports();
    }
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  }
}

let currentSupportTicketId = null;

function supportStatusBadge(status) {
  const safe = escapeHtml(status || 'unknown');
  if (status === 'open') return '<span class="badge badge-primary">Open</span>';
  if (status === 'awaiting_admin') return '<span class="badge badge-warning">Awaiting Admin</span>';
  if (status === 'awaiting_user') return '<span class="badge badge-info">Awaiting User</span>';
  if (status === 'resolved') return '<span class="badge badge-success">Resolved</span>';
  if (status === 'closed') return '<span class="badge badge-secondary">Closed</span>';
  return `<span class="badge badge-secondary">${safe}</span>`;
}

function formatSupportCategory(category) {
  const labels = {
    player_report: 'Player report',
    website_issue: 'Website issue',
    tiering_system_issue: 'Tiering system issue',
    leaderboard_problem: 'Leaderboard problem',
    account_issue: 'Account issue',
    bug_report: 'Report a bug',
    other: 'Other'
  };
  return labels[category] || escapeHtml((category || 'other').replace(/_/g, ' '));
}

function supportUrgencyBadge(urgency) {
  if (urgency === 'high') return '<span class="badge badge-danger">High</span>';
  if (urgency === 'medium') return '<span class="badge badge-warning">Medium</span>';
  if (urgency === 'low') return '<span class="badge badge-secondary">Low</span>';
  return '<span class="badge badge-secondary">Unknown</span>';
}

function renderSupportEvidenceLinks(links = []) {
  if (!Array.isArray(links) || links.length === 0) {
    return '<p class="text-muted">No evidence links included.</p>';
  }

  return `
    <div style="display:grid; gap:0.45rem;">
      ${links.map((link) => `
        <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a>
      `).join('')}
    </div>
  `;
}

// ===== Punish Tab =====

function initPunishTab() {
  renderPunishUsernames();
  updatePunishPreview();
}

function addPunishUsername() {
  const input = document.getElementById('punishUsernameInput');
  const raw = (input.value || '').trim();
  if (!raw) return;

  // Allow both Minecraft usernames (3-16 chars) and Firebase UIDs
  const isMcUsername = /^[a-zA-Z0-9_]{1,16}$/.test(raw);
  const isFirebaseUid = /^[a-zA-Z0-9]{20,}$/.test(raw) || raw.includes('@');
  
  if (!isMcUsername && !isFirebaseUid) {
    Swal.fire({ icon: 'warning', title: 'Invalid Input', text: 'Enter a valid Minecraft username (1-16 chars) or Firebase UID/email.' });
    return;
  }

  const normalized = raw.toLowerCase();
  if (punishUsernames.some(u => u.toLowerCase() === normalized)) {
    Swal.fire({ icon: 'info', title: 'Duplicate', text: 'This username/UID is already in the list.' });
    return;
  }

  punishUsernames.push(raw);
  input.value = '';
  input.focus();
  renderPunishUsernames();
  updatePunishPreview();
}

function removePunishUsername(index) {
  punishUsernames.splice(index, 1);
  renderPunishUsernames();
  updatePunishPreview();
}

function renderPunishUsernames() {
  const container = document.getElementById('punishUsernameList');
  if (!container) return;

  if (punishUsernames.length === 0) {
    container.innerHTML = '<span class="text-muted" style="padding:0.5rem;">No usernames/UIDs added yet</span>';
  } else {
    container.innerHTML = punishUsernames.map((name, i) =>
      `<span class="punish-username-chip">
        <i class="fas fa-user"></i> ${escapeHtml(name)}
        <button type="button" onclick="removePunishUsername(${i})" title="Remove">&times;</button>
      </span>`
    ).join('');
  }
}

function updatePunishPreview() {
  const preview = document.getElementById('punishPreview');
  const content = document.getElementById('punishPreviewContent');
  const executeBtn = document.getElementById('punishExecuteBtn');
  const reason = (document.getElementById('punishReason')?.value || '').trim();
  const banFirebase = document.getElementById('punishBanFirebase')?.checked;
  const blacklistUsernames = document.getElementById('punishBlacklistUsernames')?.checked;
  const revertMatches = document.getElementById('punishRevertMatches')?.checked;
  const notifyOpponents = document.getElementById('punishNotifyOpponents')?.checked;
  const duration = document.getElementById('punishDuration')?.value;

  if (punishUsernames.length === 0) {
    preview.style.display = 'none';
    executeBtn.disabled = true;
    return;
  }

  executeBtn.disabled = false;
  preview.style.display = 'block';

  const durText = duration === 'permanent' ? 'Permanent' : `${Math.round(Number(duration) / 24)} days`;

  content.innerHTML = `
    <ul style="margin:0; padding-left:1.25rem; color:var(--text-color);">
      <li><strong>${punishUsernames.length}</strong> account(s) targeted</li>
      ${banFirebase ? `<li>Firebase accounts will be <strong>banned permanently</strong></li>` : '<li>Firebase accounts will <strong>NOT</strong> be banned</li>'}
      ${blacklistUsernames ? `<li>Minecraft usernames will be <strong>blacklisted (${escapeHtml(durText)})</strong></li>` : ''}
      ${revertMatches ? `<li>All finalized matches will be <strong>reverted</strong></li>` : ''}
      ${notifyOpponents ? `<li>Affected opponents will receive <strong>inbox messages</strong></li>` : ''}
      ${reason ? `<li>Reason: <em>${escapeHtml(reason)}</em></li>` : '<li class="text-muted">No reason provided</li>'}
    </ul>
  `;
}

async function executePunishment() {
  const reason = (document.getElementById('punishReason')?.value || '').trim();
  const banFirebase = document.getElementById('punishBanFirebase')?.checked;
  const blacklistUsernames = document.getElementById('punishBlacklistUsernames')?.checked;
  const revertMatches = document.getElementById('punishRevertMatches')?.checked;
  const notifyOpponents = document.getElementById('punishNotifyOpponents')?.checked;
  const duration = document.getElementById('punishDuration')?.value;

  if (punishUsernames.length === 0) {
    Swal.fire({ icon: 'warning', title: 'No Usernames', text: 'Add at least one username/UID to punish.' });
    return;
  }

  if (!reason) {
    Swal.fire({ icon: 'warning', title: 'Reason Required', text: 'Please provide a reason for the punishment.' });
    return;
  }

  if (!banFirebase && !blacklistUsernames && !revertMatches) {
    Swal.fire({ icon: 'warning', title: 'No Actions Selected', text: 'Select at least one action to execute.' });
    return;
  }

  const durText = duration === 'permanent' ? 'permanently' : `for ${Math.round(Number(duration) / 24)} days`;
  const confirm = await Swal.fire({
    icon: 'warning',
    title: 'Confirm Punishment',
    html: `<p><strong>This will execute the following actions on ${punishUsernames.length} account(s):</strong></p>
      <ul style="text-align:left;">
        ${banFirebase ? `<li>Ban Firebase accounts (permanent)</li>` : ''}
        ${blacklistUsernames ? `<li>Blacklist usernames ${durText}</li>` : ''}
        ${revertMatches ? `<li>Revert all finalized matches</li>` : ''}
        ${notifyOpponents ? `<li>Send inbox notifications to affected opponents</li>` : ''}
      </ul>
      <p><strong style="color:#ef4444;">This action cannot be undone.</strong></p>`,
    showCancelButton: true,
    confirmButtonText: 'Execute',
    confirmButtonColor: '#dc3545',
    cancelButtonText: 'Cancel'
  });

  if (!confirm.isConfirmed) return;

  const executeBtn = document.getElementById('punishExecuteBtn');
  const resultsDiv = document.getElementById('punishResults');
  const resultsContent = document.getElementById('punishResultsContent');

  executeBtn.disabled = true;
  executeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executing...';
  resultsDiv.style.display = 'block';
  resultsContent.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.post('/admin/bulk-punish', {
      usernames: punishUsernames,
      reason,
      banFirebase: banFirebase,
      blacklistUsernames: blacklistUsernames,
      revertMatches: revertMatches,
      notifyOpponents: notifyOpponents,
      durationHours: duration === 'permanent' ? 0 : Number(duration)
    });

    if (response.success) {
      const r = response.results || {};
      let html = `<div class="alert alert-success"><i class="fas fa-check-circle"></i> Punishment executed successfully.</div>`;
      html += `<ul style="color:var(--text-color);">`;
      if (banFirebase) html += `<li><strong>${r.accountsBanned || 0}</strong> Firebase account(s) banned</li>`;
      if (blacklistUsernames) html += `<li><strong>${r.accountsBlacklisted || 0}</strong> username(s) blacklisted</li>`;
      if (revertMatches) html += `<li><strong>${r.matchesReverted || 0}</strong> match(es) reverted</li>`;
      if (notifyOpponents) html += `<li><strong>${r.messagesSent || 0}</strong> notification(s) sent</li>`;
      if (r.errors && r.errors.length > 0) {
        html += `<li class="text-danger"><strong>${r.errors.length}</strong> error(s):</li>`;
        r.errors.forEach(e => { html += `<li class="text-muted" style="margin-left:1rem;">${escapeHtml(e)}</li>`; });
      }
      html += `</ul>`;
      resultsContent.innerHTML = html;

      // Clear the form
      punishUsernames.length = 0;
      document.getElementById('punishReason').value = '';
      renderPunishUsernames();
      updatePunishPreview();
    } else {
      throw new Error(response.message || 'Unknown error');
    }
  } catch (error) {
    resultsContent.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(error.message)}</div>`;
  } finally {
    executeBtn.disabled = false;
    executeBtn.innerHTML = '<i class="fas fa-gavel"></i> Execute Punishment';
  }
}

// Wire up preview updates on input changes
document.addEventListener('DOMContentLoaded', () => {
  const reasonInput = document.getElementById('punishReason');
  const banCheckbox = document.getElementById('punishBanFirebase');
  const blacklistCheckbox = document.getElementById('punishBlacklistUsernames');
  const revertCheckbox = document.getElementById('punishRevertMatches');
  const notifyCheckbox = document.getElementById('punishNotifyOpponents');
  const durationSelect = document.getElementById('punishDuration');
  const usernameInput = document.getElementById('punishUsernameInput');

  if (reasonInput) reasonInput.addEventListener('input', updatePunishPreview);
  if (banCheckbox) banCheckbox.addEventListener('change', updatePunishPreview);
  if (blacklistCheckbox) blacklistCheckbox.addEventListener('change', updatePunishPreview);
  if (revertCheckbox) revertCheckbox.addEventListener('change', updatePunishPreview);
  if (notifyCheckbox) notifyCheckbox.addEventListener('change', updatePunishPreview);
  if (durationSelect) durationSelect.addEventListener('change', updatePunishPreview);
  if (usernameInput) {
    usernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addPunishUsername(); }
    });
  }
});

async function loadSupportTicketsLegacy() {
  const listEl = document.getElementById('supportTicketsList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="spinner"></div>';
  const status = document.getElementById('supportStatusFilter')?.value || 'active';

  try {
    const response = await apiService.adminGetSupportTickets(status, 150);
    const tickets = response.tickets || [];
    if (tickets.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p class="text-muted">No support tickets found.</p></div>';
      const detail = document.getElementById('supportTicketDetail');
      if (detail) detail.innerHTML = '<div class="empty-state"><p class="text-muted">Select a support ticket to view and reply.</p></div>';
      currentSupportTicketId = null;
      return;
    }

    listEl.innerHTML = tickets.map(ticket => `
      <button class="btn btn-secondary" style="width: 100%; text-align: left; margin-bottom: 0.5rem;"
              onclick="openSupportTicket('${ticket.id}')">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <strong>#${escapeHtml(ticket.id)}</strong>
          ${supportStatusBadge(ticket.status)}
        </div>
        <div style="font-size: 0.85rem; margin-top: 0.35rem;">${escapeHtml(ticket.subject || '(No subject)')}</div>
        <div class="text-muted" style="font-size: 0.75rem; margin-top: 0.35rem;">
          ${escapeHtml(ticket.minecraftUsername || ticket.email || ticket.userId || 'Unknown user')} •
          ${new Date(ticket.updatedAt || ticket.createdAt).toLocaleString()}
        </div>
      </button>
    `).join('');

    if (!currentSupportTicketId && tickets[0]?.id) {
      await openSupportTicket(tickets[0].id);
    }
  } catch (error) {
    listEl.innerHTML = `<div class="alert alert-error">Failed to load tickets: ${escapeHtml(error.message)}</div>`;
  }
}

async function openSupportTicketLegacy(ticketId) {
  const detailEl = document.getElementById('supportTicketDetail');
  if (!detailEl) return;

  currentSupportTicketId = ticketId;
  detailEl.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.adminGetSupportTicket(ticketId);
    const ticket = response.ticket;
    const messages = response.messages || [];

    const isClosed = ticket.status === 'resolved' || ticket.status === 'closed';
    detailEl.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
            <h4 style="margin: 0;">#${escapeHtml(ticket.id)} - ${escapeHtml(ticket.subject || '(No subject)')}</h4>
            ${supportStatusBadge(ticket.status)}
          </div>
          <div class="text-muted" style="font-size: 0.85rem; margin-bottom: 1rem;">
            User: ${escapeHtml(ticket.minecraftUsername || ticket.email || ticket.userId)} •
            Category: ${escapeHtml(ticket.category || 'other')}
          </div>

          <div style="max-height: 300px; overflow-y: auto; display: grid; gap: 0.5rem; margin-bottom: 1rem;">
            ${messages.map(msg => `
              <div style="padding: 0.75rem; border-radius: 8px; background: ${msg.senderType === 'admin' ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.04)'};">
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.25rem;">
                  ${msg.senderType === 'admin' ? 'Admin' : 'User'} • ${new Date(msg.createdAt).toLocaleString()}
                </div>
                <div style="white-space: pre-wrap;">${escapeHtml(msg.message || '')}</div>
              </div>
            `).join('')}
          </div>

          <form onsubmit="replySupportTicket(event)">
            <div class="form-group">
              <textarea id="supportReplyMessage" class="form-input" rows="3" maxlength="2000" placeholder="Reply to this ticket..." ${isClosed ? 'disabled' : ''}></textarea>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button id="supportReplyBtn" class="btn btn-primary" type="submit" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-reply"></i> Send Reply
              </button>
              <button class="btn btn-success" type="button" onclick="updateSupportTicketStatus('resolved')" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-check"></i> Resolve
              </button>
              <button class="btn btn-secondary" type="button" onclick="updateSupportTicketStatus('closed')" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-times"></i> Close
              </button>
              <button class="btn btn-warning" type="button" onclick="updateSupportTicketStatus('open')">
                <i class="fas fa-redo"></i> Reopen
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  } catch (error) {
    detailEl.innerHTML = `<div class="alert alert-error">Failed to load ticket: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadSupportTickets() {
  const listEl = document.getElementById('supportTicketsList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="spinner"></div>';
  const status = document.getElementById('supportStatusFilter')?.value || 'active';

  try {
    const response = await apiService.adminGetSupportTickets(status, 150);
    const tickets = response.tickets || [];
    if (tickets.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p class="text-muted">No support tickets found.</p></div>';
      const detail = document.getElementById('supportTicketDetail');
      if (detail) detail.innerHTML = '<div class="empty-state"><p class="text-muted">Select a support ticket to view and reply.</p></div>';
      currentSupportTicketId = null;
      return;
    }

    const visibleTicketIds = new Set(tickets.map((ticket) => String(ticket.id || '')));
    const hasCurrentTicket = currentSupportTicketId && visibleTicketIds.has(String(currentSupportTicketId));
    if (!hasCurrentTicket) {
      currentSupportTicketId = null;
    }

    listEl.innerHTML = tickets.map((ticket) => `
      <button class="btn ${String(currentSupportTicketId) === String(ticket.id) ? 'btn-primary' : 'btn-secondary'}" style="width: 100%; text-align: left; margin-bottom: 0.5rem;"
              onclick="openSupportTicket('${ticket.id}')">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
          <strong>#${escapeHtml(ticket.id)}</strong>
          <div style="display:flex; gap:0.35rem; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            ${supportUrgencyBadge(ticket.urgency)}
            ${supportStatusBadge(ticket.status)}
          </div>
        </div>
        <div style="font-size: 0.85rem; margin-top: 0.35rem;">${escapeHtml(ticket.subject || '(No subject)')}</div>
        <div class="text-muted" style="font-size: 0.75rem; margin-top: 0.35rem;">
          ${escapeHtml(ticket.minecraftUsername || ticket.email || ticket.userId || 'Unknown user')}
        </div>
        <div class="text-muted" style="font-size: 0.75rem; margin-top: 0.25rem;">
          ${escapeHtml(formatSupportCategory(ticket.category))}
          <span aria-hidden="true"> - </span>
          ${new Date(ticket.updatedAt || ticket.createdAt).toLocaleString()}
        </div>
      </button>
    `).join('');

    if (!currentSupportTicketId && tickets[0]?.id) {
      await openSupportTicket(tickets[0].id);
    } else if (currentSupportTicketId) {
      const detailEl = document.getElementById('supportTicketDetail');
      const currentTitle = detailEl?.querySelector('h4')?.textContent || '';
      if (!currentTitle.includes(`#${currentSupportTicketId}`)) {
        await openSupportTicket(currentSupportTicketId);
      }
    }
  } catch (error) {
    listEl.innerHTML = `<div class="alert alert-error">Failed to load tickets: ${escapeHtml(error.message)}</div>`;
  }
}

async function openSupportTicket(ticketId) {
  const detailEl = document.getElementById('supportTicketDetail');
  if (!detailEl) return;

  currentSupportTicketId = ticketId;
  detailEl.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.adminGetSupportTicket(ticketId);
    const ticket = response.ticket;
    if (!ticket) {
      throw new Error('Ticket not found');
    }
    const messages = response.messages || [];
    const requestor = escapeHtml(ticket.minecraftUsername || ticket.email || ticket.userId || 'Unknown user');
    const submittedEmail = ticket.email ? escapeHtml(ticket.email) : '<span class="text-muted">Not provided</span>';
    const submittedMinecraftUsername = ticket.minecraftUsername ? escapeHtml(ticket.minecraftUsername) : '<span class="text-muted">Not provided</span>';
    const submittedAnythingElse = ticket.anythingElse
      ? `<div style="white-space: pre-wrap;">${escapeHtml(ticket.anythingElse)}</div>`
      : '<p class="text-muted">Nothing else included.</p>';
    const sourceLabel = ticket.source === 'guest_form'
      ? 'Guest support form'
      : ticket.source === 'authenticated_form'
        ? 'Signed-in support form'
        : escapeHtml(ticket.source || 'Unknown');

    const isClosed = ticket.status === 'resolved' || ticket.status === 'closed';
    detailEl.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
            <h4 style="margin: 0;">#${escapeHtml(ticket.id)} - ${escapeHtml(ticket.subject || '(No subject)')}</h4>
            <div style="display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
              ${supportUrgencyBadge(ticket.urgency)}
              ${supportStatusBadge(ticket.status)}
            </div>
          </div>

          <div class="text-muted" style="font-size: 0.85rem; margin-bottom: 1rem;">
            Requestor: ${requestor}
          </div>

          <div class="row" style="margin-bottom: 1rem;">
            <div class="col-12 col-md-6">
              <div class="card" style="height: 100%;">
                <div class="card-body">
                  <h5 style="margin-top: 0; margin-bottom: 0.75rem;">Submitted Details</h5>
                  <div style="display:grid; gap:0.5rem; font-size:0.95rem;">
                    <div><strong>Category:</strong> ${escapeHtml(formatSupportCategory(ticket.category))}</div>
                    <div><strong>Urgency:</strong> ${ticket.urgency ? supportUrgencyBadge(ticket.urgency) : '<span class="text-muted">Unknown</span>'}</div>
                    <div><strong>Source:</strong> ${sourceLabel}</div>
                    <div><strong>Email:</strong> ${submittedEmail}</div>
                    <div><strong>Minecraft Username:</strong> ${submittedMinecraftUsername}</div>
                    <div><strong>Rules Confirmed:</strong> ${ticket.rulesConfirmed ? 'Yes' : 'No'}</div>
                    <div><strong>Created:</strong> ${new Date(ticket.createdAt).toLocaleString()}</div>
                    <div><strong>Updated:</strong> ${new Date(ticket.updatedAt || ticket.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="col-12 col-md-6">
              <div class="card" style="height: 100%;">
                <div class="card-body">
                  <h5 style="margin-top: 0; margin-bottom: 0.75rem;">Description</h5>
                  <div style="white-space: pre-wrap;">${escapeHtml(ticket.description || ticket.message || '')}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="row" style="margin-bottom: 1rem;">
            <div class="col-12 col-md-6">
              <div class="card" style="height: 100%;">
                <div class="card-body">
                  <h5 style="margin-top: 0; margin-bottom: 0.75rem;">Evidence Links</h5>
                  ${renderSupportEvidenceLinks(ticket.evidenceLinks)}
                </div>
              </div>
            </div>
            <div class="col-12 col-md-6">
              <div class="card" style="height: 100%;">
                <div class="card-body">
                  <h5 style="margin-top: 0; margin-bottom: 0.75rem;">Anything Else</h5>
                  ${submittedAnythingElse}
                </div>
              </div>
            </div>
          </div>

          <div style="max-height: 300px; overflow-y: auto; display: grid; gap: 0.5rem; margin-bottom: 1rem;">
            ${messages.length > 0 ? messages.map((msg) => `
              <div style="padding: 0.75rem; border-radius: 8px; background: ${msg.senderType === 'admin' ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.04)'};">
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.25rem;">
                  ${msg.senderType === 'admin' ? 'Admin' : 'User'} - ${new Date(msg.createdAt).toLocaleString()}
                </div>
                <div style="white-space: pre-wrap;">${escapeHtml(msg.message || '')}</div>
              </div>
            `).join('') : '<div class="empty-state"><p class="text-muted">No replies yet. The submission details above are the initial request.</p></div>'}
          </div>

          <form onsubmit="replySupportTicket(event)">
            <div class="form-group">
              <textarea id="supportReplyMessage" class="form-input" rows="3" maxlength="2000" placeholder="Reply to this ticket..." ${isClosed ? 'disabled' : ''}></textarea>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
              <button id="supportReplyBtn" class="btn btn-primary" type="submit" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-reply"></i> Send Reply
              </button>
              <button class="btn btn-success" type="button" onclick="updateSupportTicketStatus('resolved')" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-check"></i> Resolve
              </button>
              <button class="btn btn-secondary" type="button" onclick="updateSupportTicketStatus('closed')" ${isClosed ? 'disabled' : ''}>
                <i class="fas fa-times"></i> Close
              </button>
              <button class="btn btn-warning" type="button" onclick="updateSupportTicketStatus('open')">
                <i class="fas fa-redo"></i> Reopen
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  } catch (error) {
    detailEl.innerHTML = `<div class="alert alert-error">Failed to load ticket: ${escapeHtml(error.message)}</div>`;
  }
}

async function replySupportTicket(event) {
  event.preventDefault();
  if (!currentSupportTicketId) return;
  const input = document.getElementById('supportReplyMessage');
  const btn = document.getElementById('supportReplyBtn');
  const message = (input?.value || '').trim();
  if (!message) return;

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }
    await apiService.adminReplySupportTicket(currentSupportTicketId, message);
    await openSupportTicket(currentSupportTicketId);
    await loadSupportTickets();
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-reply"></i> Send Reply';
    }
  }
}

async function updateSupportTicketStatus(status) {
  if (!currentSupportTicketId) return;
  try {
    await apiService.adminUpdateSupportTicketStatus(currentSupportTicketId, status);
    await openSupportTicket(currentSupportTicketId);
    await loadSupportTickets();
  } catch (error) {
    Swal.fire('Error', error.message, 'error');
  }
}

// ─── Security Scores Tab ────────────────────────────────────────────────────

async function loadModeratorAdminRequests() {
  const list = document.getElementById('moderatorAdminRequestsList');
  if (!list) return;

  const status = document.getElementById('moderatorAdminRequestsStatusFilter')?.value || 'open';
  list.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.adminGetModeratorRequests(status);
    const requests = Array.isArray(response?.requests) ? response.requests : [];
    if (!requests.length) {
      list.innerHTML = '<div class="empty-state"><p class="text-muted">No admin requests found.</p></div>';
      return;
    }

    list.innerHTML = requests.map((request) => `
      <div class="card mb-3">
        <div class="card-body" style="display:grid; gap:0.75rem;">
          <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
            <div>
              <strong>${escapeHtml(request.requesterUsername || request.requesterEmail || request.requesterUserId || 'Unknown staff member')}</strong>
              <div class="text-muted" style="font-size:0.85rem;">${escapeHtml(request.staffRoleName || 'Staff')} - ${request.createdAt ? new Date(request.createdAt).toLocaleString() : 'Unknown date'}</div>
            </div>
            ${supportStatusBadge(request.status || 'open')}
          </div>
          <div style="white-space:pre-wrap; line-height:1.55;">${escapeHtml(request.message || '')}</div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" type="button" onclick="updateModeratorAdminRequestStatus('${escapeHtml(request.id)}', 'reviewed')" ${request.status === 'reviewed' ? 'disabled' : ''}>
              <i class="fas fa-eye"></i> Mark Reviewed
            </button>
            <button class="btn btn-success btn-sm" type="button" onclick="updateModeratorAdminRequestStatus('${escapeHtml(request.id)}', 'closed')" ${request.status === 'closed' ? 'disabled' : ''}>
              <i class="fas fa-check"></i> Close
            </button>
            <button class="btn btn-warning btn-sm" type="button" onclick="updateModeratorAdminRequestStatus('${escapeHtml(request.id)}', 'open')" ${request.status === 'open' ? 'disabled' : ''}>
              <i class="fas fa-redo"></i> Reopen
            </button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    list.innerHTML = `<div class="alert alert-danger">Failed to load admin requests: ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
}

async function updateModeratorAdminRequestStatus(requestId, status) {
  try {
    await apiService.adminUpdateModeratorRequestStatus(requestId, status);
    await loadModeratorAdminRequests();
  } catch (error) {
    Swal.fire('Unable to Update Request', error.message || 'Please try again.', 'error');
  }
}

const RISK_LEVEL_META = {
  critical: { label: 'Critical', cls: 'security-risk-critical', icon: 'fas fa-skull-crossbones' },
  high:     { label: 'High',     cls: 'security-risk-high',     icon: 'fas fa-exclamation-triangle' },
  medium:   { label: 'Medium',   cls: 'security-risk-medium',   icon: 'fas fa-exclamation-circle' },
  low:      { label: 'Low',      cls: 'security-risk-low',      icon: 'fas fa-info-circle' },
  clean:    { label: 'Clean',    cls: 'security-risk-clean',    icon: 'fas fa-check-circle' }
};

function buildRiskBadge(riskLevel) {
  const meta = RISK_LEVEL_META[riskLevel] || RISK_LEVEL_META.clean;
  return `<span class="security-risk-badge ${meta.cls}"><i class="${meta.icon}"></i> ${meta.label}</span>`;
}

function buildScoreBar(score) {
  const capped = Math.min(score, 200);
  const pct = Math.round((capped / 200) * 100);
  const color = score >= 100 ? '#ef4444' : score >= 70 ? '#f97316' : score >= 40 ? '#eab308' : score >= 20 ? '#3b82f6' : '#22c55e';
  return `
    <div class="security-score-bar-wrap" title="Score: ${score}">
      <div class="security-score-bar-fill" style="width:${pct}%; background:${color};"></div>
    </div>`;
}

async function loadSecurityScores() {
  const list = document.getElementById('securityScoresList');
  const topEl = document.getElementById('securityTopScore');
  if (!list) return;

  list.innerHTML = '<div class="spinner"></div>';

  try {
    const riskFilter = document.getElementById('securityRiskFilter')?.value || '';
    const url = `/admin/security-scores?limit=100${riskFilter ? `&riskLevel=${encodeURIComponent(riskFilter)}` : ''}`;
    const data = await apiService.get(url);

    const scores = (data.scores || []).sort((a, b) => (b.score || 0) - (a.score || 0));

    if (scores.length === 0) {
      list.innerHTML = '<div class="text-muted" style="padding:1.5rem;">No security score data available yet. Scores are computed after matches are finalized.</div>';
      if (topEl) topEl.style.display = 'none';
      return;
    }

    // Highlight top scorer
    const topScore = scores[0];
    if (topEl && topScore && topScore.score >= 20) {
      const meta = RISK_LEVEL_META[topScore.riskLevel] || RISK_LEVEL_META.clean;
      topEl.style.display = '';
      topEl.innerHTML = `<div class="security-top-banner"><i class="${meta.icon}"></i> Highest Risk: <strong>${escapeHtml(topScore.username || topScore.userId)}</strong> — Score ${topScore.score} ${buildRiskBadge(topScore.riskLevel)}</div>`;
    } else if (topEl) {
      topEl.style.display = 'none';
    }

    list.innerHTML = `
      <table class="admin-table" style="width:100%;">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Score</th>
            <th>Risk</th>
            <th>Matches</th>
            <th>Flags</th>
            <th>Last Computed</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${scores.map((s, i) => {
            const age = s.lastComputed ? new Date(s.lastComputed).toLocaleString() : 'Never';
            const flagCount = (s.factors || []).length;
            return `
              <tr class="${s.riskLevel === 'critical' ? 'security-row-critical' : s.riskLevel === 'high' ? 'security-row-high' : ''}">
                <td>${i + 1}</td>
                <td>
                  <strong>${escapeHtml(s.username || s.userId)}</strong>
                  ${s.isTester ? '<span class="role-pill-badge role-pill-tester" style="margin-left:4px;">Tester</span>' : ''}
                  ${s.isAdmin ? '<span class="role-pill-badge role-pill-admin" style="margin-left:4px;">Admin</span>' : ''}
                </td>
                <td>
                  <span style="font-weight:700; font-size:1.1rem;">${s.score}</span>
                  ${buildScoreBar(s.score)}
                </td>
                <td>${buildRiskBadge(s.riskLevel)}</td>
                <td>${s.matchCount || 0}</td>
                <td>${flagCount > 0 ? `<span style="color:#f97316; font-weight:700;">${flagCount}</span>` : '<span style="color:#22c55e;">0</span>'}</td>
                <td style="font-size:0.8rem;">${age}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="viewPlayerSecurityDetail('${escapeHtml(s.userId)}', '${escapeHtml(s.username || s.userId)}')">
                    <i class="fas fa-eye"></i> Detail
                  </button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    console.error('Error loading security scores:', err);
    list.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle"></i> ${err.message === 'Firestore not configured' ? 'Firestore is not enabled for this project. Please enable Cloud Firestore in the Firebase Console.' : 'Failed to load security scores: ' + escapeHtml(err.message)}</div>`;
  }
}

async function viewPlayerSecurityDetail(userId, username) {
  try {
    const data = await apiService.get(`/admin/security-scores/${encodeURIComponent(userId)}`);

    const factorRows = (data.factors || []).map(f => {
      const sev = f.severity || 'medium';
      const sevColor = sev === 'critical' ? '#ef4444' : sev === 'high' ? '#f97316' : sev === 'medium' ? '#eab308' : '#3b82f6';
      return `<tr>
        <td style="padding:0.4rem 0.75rem;">${escapeHtml(f.label)}</td>
        <td style="padding:0.4rem 0.75rem; text-align:right;"><span style="color:${sevColor}; font-weight:700;">+${f.points}</span></td>
      </tr>`;
    }).join('');

    Swal.fire({
      title: `Security Detail – ${escapeHtml(username)}`,
      html: `
        <div style="text-align:left;">
          <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1rem;">
            <span style="font-size:2rem; font-weight:800; color:${data.score >= 100 ? '#ef4444' : data.score >= 70 ? '#f97316' : '#eab308'};">${data.score}</span>
            ${buildRiskBadge(data.riskLevel)}
          </div>
          ${factorRows.length > 0 ? `
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:1px solid #333;">
                  <th style="text-align:left; padding:0.35rem 0.75rem;">Factor</th>
                  <th style="text-align:right; padding:0.35rem 0.75rem;">Points</th>
                </tr>
              </thead>
              <tbody>${factorRows}</tbody>
            </table>` : '<p style="color:#aaa;">No risk factors detected.</p>'}
          <p style="margin-top:1rem; color:#aaa; font-size:0.8rem;">Last computed: ${data.lastComputed ? new Date(data.lastComputed).toLocaleString() : 'Unknown'} | ${data.matchCount || 0} matches analysed</p>
        </div>`,
      confirmButtonText: 'Close',
      width: '600px'
    });
  } catch (err) {
    Swal.fire('Error', 'Failed to load security detail: ' + err.message, 'error');
  }
}

// Make functions globally available
window.switchModerationTab = switchModerationTab;
window.loadAdminModeratorChatReports = loadAdminModeratorChatReports;
window.submitAdminModeratorChatRestriction = submitAdminModeratorChatRestriction;
window.clearAdminModeratorChatRestriction = clearAdminModeratorChatRestriction;
window.prefillAdminModeratorChatRestriction = prefillAdminModeratorChatRestriction;
window.loadAdminLeaderboardModerationFilters = loadAdminLeaderboardModerationFilters;
window.submitAdminLeaderboardFilter = submitAdminLeaderboardFilter;
window.removeAdminLeaderboardFilter = removeAdminLeaderboardFilter;
window.switchReportsTab = switchReportsTab;
window.loadNoshowReports = loadNoshowReports;
window.loadUserReports = loadUserReports;
window.loadMessageReports = loadMessageReports;
window.addToWhitelist = addToWhitelist;
window.removeFromWhitelist = removeFromWhitelist;
window.resolveNoshowReport = resolveNoshowReport;
window.viewUserReport = viewUserReport;
window.markUserReportResolved = markUserReportResolved;
window.dismissUserReport = dismissUserReport;
window.loadSecurityWhitelist = loadSecurityWhitelist;
window.loadTierTesterApplications = loadTierTesterApplications;
window.approveTierTesterApplication = approveTierTesterApplication;
window.denyTierTesterApplication = denyTierTesterApplication;
window.blockTierTesterApplication = blockTierTesterApplication;
window.loadWhitelistedServers = loadWhitelistedServers;
window.handleAddServer = handleAddServer;
window.handleDeleteServer = handleDeleteServer;
window.loadMatchTimeline = loadMatchTimeline;
window.runQueueInspector = runQueueInspector;
window.loadAdminDisputes = loadAdminDisputes;
window.updateAdminDisputeStatusPrompt = updateAdminDisputeStatusPrompt;
window.openMatchTimeline = openMatchTimeline;
window.openMatchDisputeBoard = openMatchDisputeBoard;
window.loadSupportTickets = loadSupportTickets;
window.openSupportTicket = openSupportTicket;
window.replySupportTicket = replySupportTicket;
window.updateSupportTicketStatus = updateSupportTicketStatus;
window.loadModeratorAdminRequests = loadModeratorAdminRequests;
window.updateModeratorAdminRequestStatus = updateModeratorAdminRequestStatus;
window.loadSecurityScores = loadSecurityScores;
window.viewPlayerSecurityDetail = viewPlayerSecurityDetail;
window.handleResolveViolation = handleResolveViolation;
window.handleAdminSendMessage = handleAdminSendMessage;
window.applyMessageTemplate = applyMessageTemplate;
window.loadBanWaves = loadBanWaves;
window.addBanWaveAccount = addBanWaveAccount;
window.removeBanWaveAccount = removeBanWaveAccount;
window.handleSaveBanWave = handleSaveBanWave;
window.editBanWave = editBanWave;
window.deleteBanWave = deleteBanWave;
window.executeBanWave = executeBanWave;
window.resetBanWaveForm = resetBanWaveForm;

// ===== Resolve Match Violation =====

async function handleResolveViolation(event) {
  event.preventDefault();
  const username = document.getElementById('resolveUsername')?.value?.trim();
  const matchId = document.getElementById('resolveMatchId')?.value?.trim();
  const reason = document.getElementById('resolveReason')?.value?.trim();
  const blacklistType = document.getElementById('resolveBlacklistType')?.value;

  if (!username || !matchId || !reason) {
    Swal.fire({ icon: 'error', title: 'Missing Fields', text: 'All fields are required.' });
    return;
  }

  const confirmed = await Swal.fire({
    icon: 'warning',
    title: 'Confirm Resolution',
    html: `<p>This will:</p>
      <ul style="text-align:left;font-size:0.9rem;">
        <li>Revert rating changes from match <strong>${escapeHtml(matchId)}</strong></li>
        <li>Blacklist <strong>${escapeHtml(username)}</strong> (${blacklistType === 'permanent' ? 'permanently' : blacklistType + ' hours'})</li>
        <li>Send inbox notices to both players</li>
      </ul>`,
    showCancelButton: true,
    confirmButtonText: 'Resolve',
    cancelButtonText: 'Cancel'
  });

  if (!confirmed.isConfirmed) return;

  const btn = document.getElementById('resolveSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...'; }

  try {
    const durationHours = blacklistType === 'permanent' ? 0 : parseInt(blacklistType) || 0;
    const res = await apiService.resolveMatchViolation({
      username,
      matchId,
      reason,
      blacklistDurationHours: durationHours
    });

    if (res.success) {
      Swal.fire({ icon: 'success', title: 'Resolved', text: res.message || 'Match violation resolved. Both players have been notified.' });
      document.getElementById('resolveForm')?.reset();
    } else {
      Swal.fire({ icon: 'error', title: 'Error', text: res.message || 'Failed to resolve.' });
    }
  } catch (error) {
    console.error('Resolve error:', error);
    Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to resolve match violation.' });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gavel"></i> Resolve & Revert Ratings'; }
  }
}

// ===== Admin Send Message =====

const MESSAGE_TEMPLATES = {
  welcome: {
    title: 'Welcome to MC Leaderboards!',
    body: 'Welcome to MC Leaderboards! We\'re glad to have you. Make sure to check out the rules page and set up your Minecraft account in your profile to start competing.\n\nIf you have questions, visit the support page or reach out to staff.\n\nGood luck on the leaderboards!'
  },
  policy_reminder: {
    title: 'Policy Reminder',
    body: 'This is a friendly reminder about our community policies. Please ensure you are following our rules and terms of service at all times.\n\nRepeated violations may result in warnings or account restrictions.\n\nIf you have any questions, feel free to contact support.'
  },
  account_review: {
    title: 'Account Under Review',
    body: 'Your account has been flagged for review by our moderation team. During this review period, some features may be temporarily limited.\n\nThis is a routine process and does not necessarily indicate a violation. We will notify you once the review is complete.\n\nIf you believe this is in error, please contact support.'
  },
  restriction_lifted: {
    title: 'Account Restriction Lifted',
    body: 'Good news! A previous restriction on your account has been lifted. You now have full access to all platform features.\n\nPlease continue to follow our community guidelines to maintain good standing.\n\nThank you for your patience.'
  },
  rating_restored: {
    title: 'Rating Adjustment Applied',
    body: 'We have applied a rating adjustment to your account. This may be due to a resolved dispute or corrective action taken against another player.\n\nPlease check your profile for updated ratings.'
  },
  thank_report: {
    title: 'Thank You for Your Report',
    body: 'Thank you for submitting a report. Our moderation team has reviewed it and taken appropriate action.\n\nWe appreciate your help in keeping MC Leaderboards fair and competitive.\n\nNote: We cannot share specific details about actions taken against other players for privacy reasons.'
  },
  tester_accepted: {
    title: 'Tier Tester Application Accepted',
    body: 'Congratulations! Your Tier Tester application has been approved. You now have access to tester tools and can begin conducting tier tests.\n\nPlease review the tester guidelines and maintain professional conduct during all tests.\n\nWelcome to the team!'
  },
  tester_denied: {
    title: 'Tier Tester Application Update',
    body: 'Thank you for your interest in becoming a Tier Tester. After careful review, we are unable to approve your application at this time.\n\nYou are welcome to apply again in the future once you feel you meet the requirements.\n\nThank you for your understanding.'
  }
};

function applyMessageTemplate() {
  const templateKey = document.getElementById('msgTemplate')?.value;
  if (!templateKey || !MESSAGE_TEMPLATES[templateKey]) {
    return;
  }
  const template = MESSAGE_TEMPLATES[templateKey];
  const titleEl = document.getElementById('msgTitle');
  const bodyEl = document.getElementById('msgBody');
  if (titleEl) titleEl.value = template.title;
  if (bodyEl) bodyEl.value = template.body;
}

async function handleAdminSendMessage(event) {
  event.preventDefault();
  const userId = document.getElementById('msgTargetUserId')?.value?.trim();
  const title = document.getElementById('msgTitle')?.value?.trim();
  const body = document.getElementById('msgBody')?.value?.trim();
  const type = document.getElementById('msgType')?.value || 'admin_message';

  if (!userId || !title || !body) {
    Swal.fire({ icon: 'error', title: 'Missing Fields', text: 'All fields are required.' });
    return;
  }

  const btn = document.getElementById('sendMsgBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...'; }

  try {
    const res = await apiService.adminSendInboxMessage({
      userId,
      title,
      message: body,
      type
    });

    if (res.success) {
      Swal.fire({ icon: 'success', title: 'Sent', text: 'Message delivered to user\'s inbox.' });
      document.getElementById('sendMessageForm')?.reset();
    } else {
      Swal.fire({ icon: 'error', title: 'Error', text: res.message || 'Failed to send message.' });
    }
  } catch (error) {
    console.error('Send message error:', error);
    Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to send message.' });
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Message'; }
  }
}

// ===== Ban Waves Management =====

async function loadBanWaves() {
  const listDiv = document.getElementById('banWavesList');
  if (!listDiv) return;

  listDiv.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.getBanWaves();
    banWavesCatalog = response.banWaves || [];
    
    // Also populate the execute select
    const executeSelect = document.getElementById('executeBanWaveSelect');
    if (executeSelect) {
      executeSelect.innerHTML = '<option value="">Choose a ban wave...</option>';
      banWavesCatalog.forEach(wave => {
        if (wave.status !== 'completed') {
          const option = document.createElement('option');
          option.value = wave.id;
          option.textContent = `${wave.name} (${(wave.accounts || []).length} accounts, ${wave.status})`;
          executeSelect.appendChild(option);
        }
      });
    }

    renderBanWavesList();
  } catch (error) {
    console.error('Error loading ban waves:', error);
    listDiv.innerHTML = `<div class="alert alert-error">Error loading ban waves: ${escapeHtml(error.message)}</div>`;
  }
}

function renderBanWavesList() {
  const listDiv = document.getElementById('banWavesList');
  if (!listDiv) return;

  if (banWavesCatalog.length === 0) {
    listDiv.innerHTML = '<div class="empty-state"><p class="text-muted">No ban waves created yet.</p></div>';
    return;
  }

  listDiv.innerHTML = banWavesCatalog.map(wave => `
    <div class="card mb-2">
      <div class="card-body" style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; align-items:flex-start;">
        <div style="flex:1; min-width:200px;">
          <h4 style="margin:0 0 0.5rem 0;">${escapeHtml(wave.name)}</h4>
          <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem; flex-wrap:wrap;">
            <span class="badge" style="background:${wave.status === 'completed' ? '#22c55e' : wave.status === 'active' ? '#3b82f6' : '#f59e0b'};">${wave.status}</span>
            <span class="badge badge-secondary">${(wave.accounts || []).length} accounts</span>
          </div>
          ${wave.description ? `<p class="text-muted" style="margin:0.5rem 0 0 0; font-size:0.9rem;">${escapeHtml(wave.description)}</p>` : ''}
          <small class="text-muted">Created: ${new Date(wave.createdAt).toLocaleString()}</small>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" onclick="editBanWave('${escapeHtml(wave.id)}')"><i class="fas fa-pen"></i> Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteBanWave('${escapeHtml(wave.id)}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

function resetBanWaveForm() {
  document.getElementById('banWaveId').value = '';
  document.getElementById('banWaveName').value = '';
  document.getElementById('banWaveDescription').value = '';
  document.getElementById('banWaveStatus').value = 'pending';
  document.getElementById('banWaveDuration').value = 'permanent';
  banWaveAccounts = [];
  renderBanWaveAccounts();
}

function renderBanWaveAccounts() {
  const container = document.getElementById('banWaveAccountsList');
  if (!container) return;

  if (banWaveAccounts.length === 0) {
    container.innerHTML = '<span class="text-muted" style="padding:0.5rem;">No accounts added yet</span>';
  } else {
    container.innerHTML = banWaveAccounts.map((account, i) =>
      `<span class="punish-username-chip">
        <i class="fas fa-shield-alt"></i> ${escapeHtml(account.substring(0, 20))}
        <button type="button" onclick="removeBanWaveAccount(${i})" title="Remove">&times;</button>
      </span>`
    ).join('');
  }
}

function addBanWaveAccount() {
  const input = document.getElementById('banWaveAccountInput');
  const account = (input.value || '').trim();
  if (!account) return;

  if (banWaveAccounts.includes(account)) {
    Swal.fire({ icon: 'info', title: 'Duplicate', text: 'This account is already in the wave.' });
    return;
  }

  banWaveAccounts.push(account);
  input.value = '';
  input.focus();
  renderBanWaveAccounts();
}

function removeBanWaveAccount(index) {
  banWaveAccounts.splice(index, 1);
  renderBanWaveAccounts();
}

async function handleSaveBanWave(event) {
  event.preventDefault();

  const id = document.getElementById('banWaveId').value;
  const name = document.getElementById('banWaveName').value.trim();
  const description = document.getElementById('banWaveDescription').value.trim();
  const status = document.getElementById('banWaveStatus').value;
  const duration = document.getElementById('banWaveDuration').value;

  if (!name) {
    Swal.fire({ icon: 'warning', title: 'Name Required', text: 'Please enter a ban wave name.' });
    return;
  }

  if (banWaveAccounts.length === 0) {
    Swal.fire({ icon: 'warning', title: 'No Accounts', text: 'Add at least one account to the ban wave.' });
    return;
  }

  try {
    let response;
    if (id) {
      response = await apiService.updateBanWave(id, {
        name,
        description,
        status,
        duration,
        accounts: banWaveAccounts
      });
    } else {
      response = await apiService.createBanWave({
        name,
        description,
        status,
        duration,
        accounts: banWaveAccounts
      });
    }

    if (response.success) {
      Swal.fire({
        icon: 'success',
        title: id ? 'Ban Wave Updated' : 'Ban Wave Created',
        text: response.message || 'Ban wave saved successfully'
      });

      resetBanWaveForm();
      loadBanWaves();
    } else {
      throw new Error(response.message || 'Failed to save ban wave');
    }
  } catch (error) {
    console.error('Error saving ban wave:', error);
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: error.message
    });
  }
}

async function editBanWave(id) {
  const wave = banWavesCatalog.find(w => w.id === id);
  if (!wave) {
    Swal.fire({ icon: 'error', title: 'Error', text: 'Ban wave not found.' });
    return;
  }

  document.getElementById('banWaveId').value = id;
  document.getElementById('banWaveName').value = wave.name;
  document.getElementById('banWaveDescription').value = wave.description || '';
  document.getElementById('banWaveStatus').value = wave.status || 'pending';
  document.getElementById('banWaveDuration').value = wave.duration || 'permanent';
  banWaveAccounts = wave.accounts || [];
  renderBanWaveAccounts();

  // Scroll to form
  document.getElementById('banWaveForm')?.scrollIntoView({ behavior: 'smooth' });
}

async function deleteBanWave(id) {
  const result = await Swal.fire({
    icon: 'warning',
    title: 'Delete Ban Wave?',
    text: 'This will remove the ban wave. If it has been executed, banned accounts will remain banned.',
    showCancelButton: true,
    confirmButtonText: 'Delete',
    confirmButtonColor: '#dc3545'
  });

  if (!result.isConfirmed) return;

  try {
    await apiService.deleteBanWave(id);
    Swal.fire({
      icon: 'success',
      title: 'Deleted',
      text: 'Ban wave deleted successfully'
    });
    loadBanWaves();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: error.message
    });
  }
}

async function executeBanWave() {
  const waveId = document.getElementById('executeBanWaveSelect').value;
  if (!waveId) {
    Swal.fire({ icon: 'warning', title: 'Select Ban Wave', text: 'Choose a ban wave to execute.' });
    return;
  }

  const wave = banWavesCatalog.find(w => w.id === waveId);
  if (!wave) {
    Swal.fire({ icon: 'error', title: 'Error', text: 'Ban wave not found.' });
    return;
  }

  const result = await Swal.fire({
    icon: 'warning',
    title: 'Execute Ban Wave?',
    html: `<p>This will permanently ban ${wave.accounts.length} account(s) and blacklist associated usernames.</p>
      <p><strong style="color:#ef4444;">This action cannot be undone.</strong></p>`,
    showCancelButton: true,
    confirmButtonText: 'Execute',
    confirmButtonColor: '#dc3545'
  });

  if (!result.isConfirmed) return;

  const resultsDiv = document.getElementById('executeBanWaveResults');
  const resultsContent = document.getElementById('executeBanWaveResultsContent');
  const btn = document.querySelector('button[onclick="executeBanWave()"]');

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Executing...'; }
  resultsDiv.style.display = 'block';
  resultsContent.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await apiService.executeBanWave(waveId);

    if (response.success) {
      const r = response.results || {};
      let html = `<div class="alert alert-success"><i class="fas fa-check-circle"></i> Ban wave executed successfully!</div>`;
      html += `<ul style="color:var(--text-color);">`;
      html += `<li><strong>${r.accountsBanned || 0}</strong> account(s) banned</li>`;
      html += `<li><strong>${r.usernamesBlacklisted || 0}</strong> username(s) blacklisted</li>`;
      if (r.errors && r.errors.length > 0) {
        html += `<li class="text-danger"><strong>${r.errors.length}</strong> error(s):</li>`;
        r.errors.forEach(e => { html += `<li class="text-muted" style="margin-left:1rem;">${escapeHtml(e)}</li>`; });
      }
      html += `</ul>`;
      resultsContent.innerHTML = html;
      loadBanWaves();
    } else {
      throw new Error(response.message || 'Failed to execute ban wave');
    }
  } catch (error) {
    resultsContent.innerHTML = `<div class="alert alert-danger"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(error.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-gavel"></i> Execute Ban Wave'; }
  }
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}
