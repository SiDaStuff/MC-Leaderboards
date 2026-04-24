// MC Leaderboards - Dashboard Secondary Modules

function getTimeAgo(date) {
  return formatRelativeTime(date, { fallback: 'Unknown' });
}

async function copyMatchId(matchId, buttonEl = null) {
  if (!matchId) return false;

  try {
    await navigator.clipboard.writeText(matchId);
    if (buttonEl) {
      const original = buttonEl.innerHTML;
      buttonEl.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(() => {
        buttonEl.innerHTML = original;
      }, 1200);
    } else {
      Toast?.success?.('Match ID copied');
    }
    return true;
  } catch (error) {
    console.warn('Failed to copy match ID:', error);
    await MCLBUI.warning('Copy Failed', 'Unable to copy the match ID right now.');
    return false;
  }
}

function openMatchWithFallback(matchId, preferNewTab = true) {
  if (!matchId) return false;
  const url = `testing.html?matchId=${encodeURIComponent(matchId)}`;

  if (!preferNewTab) {
    navigateTo(url);
    return true;
  }

  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer');
  } catch (_) {
    opened = null;
  }

  if (!opened || opened.closed || typeof opened.closed === 'undefined') {
    navigateTo(url);
    return false;
  }

  return true;
}

function buildRecentMatchItem(match = {}) {
  const date = match.finalizedAt || match.createdAt;
  const matchIdRaw = match.matchId || match.id || '';
  const roleLabel = match.userRole === 'tester' ? 'Tester' : 'Player';
  const scoreLine = `${match.userScore || 0} - ${match.opponentScore || 0}`;
  const gamemode = String(match.gamemode || '').toUpperCase();
  const gamemodeIcon = CONFIG.GAMEMODES.find((gm) => gm.id === match.gamemode)?.icon || 'assets/vanilla.svg';
  const resultClass = match.userScore > match.opponentScore
    ? 'text-success'
    : (match.userScore < match.opponentScore ? 'text-danger' : 'text-warning');
  const resultText = match.userScore > match.opponentScore
    ? 'Won'
    : (match.userScore < match.opponentScore ? 'Lost' : 'Draw');
  const reasonText = ['forfeit', 'no_show'].includes(match.finalizationData?.type)
    ? ` - ${escapeHtml(match.finalizationData?.reason || '')}`
    : '';

  return `
    <article class="dashboard-match-card">
      <div class="dashboard-match-card__main">
        <img src="${escapeHtml(gamemodeIcon)}" alt="${escapeHtml(match.gamemode || 'match')}" class="dashboard-match-card__icon">
        <div class="dashboard-match-card__content">
          <div class="dashboard-match-card__title-row">
            <strong>vs ${escapeHtml(match.opponentName || 'Unknown')}</strong>
            <span class="badge badge-sm ${match.userRole === 'tester' ? 'badge-primary' : 'badge-secondary'}">${roleLabel}</span>
          </div>
          <div class="dashboard-match-card__meta">
            <span>${gamemode} - ${escapeHtml(getTimeAgo(date))}${reasonText}</span>
            <span>${escapeHtml(formatDateTime(date))}</span>
          </div>
          <div class="dashboard-match-card__actions">
            <code>${escapeHtml(matchIdRaw || 'N/A')}</code>
            ${matchIdRaw ? `<button type="button" class="btn btn-secondary btn-sm" data-match-id="${escapeHtml(matchIdRaw)}" onclick="copyMatchId(this.dataset.matchId, this)" aria-label="Copy match ID"><i class="fas fa-copy"></i></button>` : ''}
            ${matchIdRaw ? `<button type="button" class="btn btn-secondary btn-sm" data-match-id="${escapeHtml(matchIdRaw)}" onclick="openMatchWithFallback(this.dataset.matchId, true)">Open Match</button>` : ''}
          </div>
        </div>
      </div>
      <div class="dashboard-match-card__score">
        <div class="dashboard-match-card__scoreline">${escapeHtml(scoreLine)}</div>
        <div class="${resultClass}">${resultText}</div>
      </div>
    </article>
  `;
}

async function loadRecentMatches() {
  const container = document.getElementById('recentMatchesContainer');
  if (!container) return;

  MCLBUI.setRouteLoading(container, true, { skeletonCount: 3 });

  try {
    const response = await apiService.getRecentMatches(5);
    const matches = Array.isArray(response?.matches) ? response.matches : [];

    if (!matches.length) {
      renderEmptyState(container, {
        icon: 'fa-history',
        title: 'No recent matches yet',
        description: 'Once you complete matches, they will appear here with results and quick actions.'
      });
      hasLoadedRecentMatches = true;
      return;
    }

    container.innerHTML = matches.map(buildRecentMatchItem).join('');
    hasLoadedRecentMatches = true;
  } catch (error) {
    console.error('Error loading recent matches:', error);
    renderEmptyState(container, {
      icon: 'fa-triangle-exclamation',
      title: 'Unable to load recent matches',
      description: 'Try refreshing this section in a moment.'
    });
  }
}

function formatTimeLeft(timeLeftMs) {
  const hours = Math.floor(timeLeftMs / (1000 * 60 * 60));
  const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((timeLeftMs % (1000 * 60)) / 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

async function checkQueueCooldown(gamemode) {
  try {
    const profile = await getCachedProfile();
    const now = Date.now();
    const cooldownMs = 30 * 60 * 1000;

    const lastTestCompletion = profile.lastTestCompletions?.[gamemode];
    if (lastTestCompletion) {
      const elapsed = now - new Date(lastTestCompletion).getTime();
      if (elapsed < cooldownMs) {
        return {
          allowed: false,
          timeLeft: cooldownMs - elapsed,
          reason: 'You were recently tested in this gamemode. Please wait before queuing again.'
        };
      }
    }

    const lastQueueJoin = profile.lastQueueJoins?.[gamemode];
    if (!lastQueueJoin) {
      return { allowed: true };
    }

    const elapsed = now - new Date(lastQueueJoin).getTime();
    if (elapsed >= cooldownMs) {
      return { allowed: true };
    }

    return {
      allowed: false,
      timeLeft: cooldownMs - elapsed,
      reason: 'You recently joined a match in this gamemode.'
    };
  } catch (error) {
    console.error('Error checking queue cooldown:', error);
    return { allowed: true };
  }
}

function buildCooldownMarkup(cooldown = {}) {
  const accent = cooldown.type === 'testing' ? '#ff9800' : 'var(--accent-color)';
  return `
    <div class="dashboard-cooldown-card">
      <div class="dashboard-cooldown-card__head">
        <span>${escapeHtml(cooldown.name)}</span>
        <span class="cooldown-timer" data-gamemode="${escapeHtml(cooldown.gamemode)}" data-timeleft="${cooldown.timeLeft}" style="color:${accent}">
          ${formatTimeLeft(cooldown.timeLeft)}
        </span>
      </div>
      <div class="dashboard-cooldown-card__meta">
        <i class="fas fa-${cooldown.type === 'testing' ? 'user-check' : 'clock'}"></i>
        <span>${escapeHtml(cooldown.reason || 'Cooldown active')}</span>
      </div>
    </div>
  `;
}

async function loadQueueCooldowns() {
  const cooldownsContainer = document.getElementById('queueCooldowns');
  if (!cooldownsContainer) return;

  try {
    const profile = await getCachedProfile();
    const lastQueueJoins = profile.lastQueueJoins || {};
    const lastTestCompletions = profile.lastTestCompletions || {};
    const now = Date.now();
    const cooldownMs = 30 * 60 * 1000;

    const activeCooldowns = CONFIG.GAMEMODES
      .filter((gamemode) => gamemode.id !== 'overall')
      .reduce((items, gamemode) => {
        const testingStartedAt = lastTestCompletions[gamemode.id];
        if (testingStartedAt) {
          const elapsed = now - new Date(testingStartedAt).getTime();
          if (elapsed < cooldownMs) {
            items.push({
              gamemode: gamemode.id,
              name: gamemode.name,
              timeLeft: cooldownMs - elapsed,
              type: 'testing',
              reason: 'Recently tested'
            });
            return items;
          }
        }

        const queueStartedAt = lastQueueJoins[gamemode.id];
        if (queueStartedAt) {
          const elapsed = now - new Date(queueStartedAt).getTime();
          if (elapsed < cooldownMs) {
            items.push({
              gamemode: gamemode.id,
              name: gamemode.name,
              timeLeft: cooldownMs - elapsed,
              type: 'queue',
              reason: 'Recent match'
            });
          }
        }

        return items;
      }, []);

    if (!activeCooldowns.length) {
      cooldownsContainer.innerHTML = '';
      return;
    }

    cooldownsContainer.innerHTML = `
      <div class="alert alert-info">
        <h6 class="dashboard-section-subtitle"><i class="fas fa-clock"></i> Queue Cooldowns</h6>
        <div id="cooldownTimers">${activeCooldowns.map(buildCooldownMarkup).join('')}</div>
      </div>
    `;

    updateCooldownTimers();
    hasLoadedQueueCooldowns = true;
  } catch (error) {
    console.error('Error loading queue cooldowns:', error);
  }
}

function updateCooldownTimers() {
  const timers = document.querySelectorAll('.cooldown-timer');
  if (!timers.length) return;

  const interval = setInterval(() => {
    let allExpired = true;

    timers.forEach((timer) => {
      const current = parseInt(timer.dataset.timeleft || '0', 10);
      const next = current - 1000;

      if (next > 0) {
        timer.textContent = formatTimeLeft(next);
        timer.dataset.timeleft = String(next);
        allExpired = false;
        return;
      }

      timer.textContent = '00:00:00';
      timer.style.color = 'var(--success-color)';
    });

    if (allExpired) {
      clearInterval(interval);
      setTimeout(() => loadQueueCooldowns(), 1200);
    }
  }, 1000);
}

async function handleSetUnavailable() {
  try {
    await apiService.setTesterAvailability(false, [], []);
    await MCLBUI.success('Removed from Queue', 'Your queue availability has been cleared.', {
      timer: 1500,
      showConfirmButton: false
    });
    await checkQueueStatus({ inQueue: false });
  } catch (error) {
    await MCLBUI.error('Unable to Update Availability', error.message || 'Please try again.');
  }
}

async function checkUserWarnings() {
  try {
    const profile = AppState.getProfile();
    if (!profile || !Array.isArray(profile.warnings)) return;

    const unacknowledgedWarnings = profile.warnings.filter((warning) => !warning.acknowledged);
    if (unacknowledgedWarnings.length > 0) {
      showWarningBanner(unacknowledgedWarnings);
    }
  } catch (error) {
    console.error('Error checking user warnings:', error);
  }
}

function showWarningBanner(warnings) {
  const warning = warnings[0];
  if (!warning) return;

  let banner = document.getElementById('warningBanner');
  if (!banner) {
    banner = document.createElement('section');
    banner.id = 'warningBanner';
    banner.className = 'dashboard-warning-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-live', 'polite');
    document.body.prepend(banner);
  }

  document.body.classList.add('has-dashboard-warning');
  banner.innerHTML = `
    <div class="dashboard-warning-banner__content">
      <div class="dashboard-warning-banner__body">
        <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
        <div>
          <strong>Warning</strong>
          <p>${escapeHtml(warning.reason || 'A moderation warning requires your attention.')}</p>
          <small>Issued ${escapeHtml(formatDate(warning.warnedAt))}</small>
        </div>
      </div>
      <button type="button" class="btn btn-secondary" onclick="acknowledgeWarning('${escapeHtml(warning.id || '')}')">
        <i class="fas fa-check"></i> I Understand
      </button>
    </div>
  `;
}

async function acknowledgeWarning(warningId) {
  try {
    await apiService.acknowledgeWarning(warningId);

    const banner = document.getElementById('warningBanner');
    banner?.remove();
    document.body.classList.remove('has-dashboard-warning');

    const profile = AppState.getProfile();
    if (profile && Array.isArray(profile.warnings)) {
      profile.warnings = profile.warnings.map((warning) => (
        warning.id === warningId
          ? { ...warning, acknowledged: true, acknowledgedAt: new Date().toISOString() }
          : warning
      ));
      AppState.setProfile(profile);

      const remaining = profile.warnings.filter((warning) => !warning.acknowledged);
      if (remaining.length > 0) {
        showWarningBanner(remaining);
      }
    }
  } catch (error) {
    console.error('Error acknowledging warning:', error);
    await MCLBUI.error('Unable to Acknowledge Warning', 'Please try again.');
  }
}

async function showTierTesterBanner() {
  const profile = AppState.getProfile();
  if (!profile) return;

  const plusBanner = document.getElementById('plusBanner');
  const tierBanner = document.getElementById('tierTesterBanner');
  if (plusBanner) plusBanner.style.display = 'block';
  if (tierBanner) tierBanner.style.display = 'block';

  const plus = profile.plus || {};
  const hasPlus = plus.active === true && plus.blocked !== true;
  const plusTitle = document.getElementById('plusBannerTitle');
  const plusText = document.getElementById('plusBannerText');
  const plusButton = document.getElementById('plusBannerButton');

  if (plusTitle && plusText && plusButton) {
    if (hasPlus) {
      plusTitle.innerHTML = '<i class="fas fa-crown"></i><span>Thank You for Supporting Plus</span>';
      plusText.textContent = `Your Plus membership is active until ${formatDate(plus.endDate, { fallback: 'an upcoming renewal date' })}.`;
      plusButton.innerHTML = '<a href="account.html" class="btn btn-warning"><i class="fas fa-cog"></i> Manage in Settings</a>';
    } else {
      plusTitle.innerHTML = '<i class="fas fa-crown"></i><span>Upgrade to Plus</span>';
      plusText.textContent = 'Get priority queue access, exclusive features, and support the platform.';
      plusButton.innerHTML = '<a href="plus.html" class="btn btn-warning"><i class="fas fa-star"></i> Learn More</a>';
    }
  }

  const tierTitle = document.getElementById('tierTesterBannerTitle');
  const tierText = document.getElementById('tierTesterBannerText');
  const tierButton = document.getElementById('tierTesterBannerButton');
  const isTierTester = profile.tester === true;
  const isBlacklisted = ModerationState.resolve(profile).blacklisted;

  if (isTierTester && tierTitle && tierText && tierButton) {
    const testerSince = profile.testerSince ? new Date(profile.testerSince) : new Date();
    const daysSince = Math.floor((Date.now() - testerSince.getTime()) / (1000 * 60 * 60 * 24));
    tierTitle.innerHTML = '<i class="fas fa-user-shield"></i><span>Thank You for Being a Tier Tester</span>';
    tierText.textContent = `You have been helping evaluate players for ${daysSince < 30 ? `${daysSince} days` : `${Math.floor(daysSince / 30)} months`}.`;
    tierButton.innerHTML = '<button class="btn btn-success" onclick="scrollToTesterDashboard()"><i class="fas fa-arrow-down"></i> Go to Tier Tester Section</button>';
    return;
  }

  if (isBlacklisted && tierBanner) {
    tierBanner.style.display = 'none';
    return;
  }

  if (!tierTitle || !tierText || !tierButton) return;

  try {
    const response = await apiService.getTierTesterApplicationsOpen();
    if (response?.open === true) {
      tierTitle.innerHTML = '<i class="fas fa-user-shield"></i><span>Think You Have What It Takes?</span>';
      tierText.textContent = 'Help evaluate players and earn exclusive perks as an official tier tester.';
      tierButton.innerHTML = '<a href="tier-tester-application.html" class="btn btn-success"><i class="fas fa-clipboard-check"></i> Apply Now</a>';
      return;
    }
  } catch (error) {
    console.error('Error checking tier tester applications:', error);
  }

  tierTitle.innerHTML = '<i class="fas fa-user-shield"></i><span>Tier Tester Applications</span>';
  tierText.textContent = 'Applications are currently closed. Check back later for new openings.';
  tierButton.innerHTML = '<button class="btn btn-secondary" disabled><i class="fas fa-lock"></i> Applications Closed</button>';
}

function buildServerSelectionMarkup(servers = [], targetInputId) {
  return servers.map((server) => `
    <button
      type="button"
      class="dashboard-server-option"
      onclick="selectServer('${escapeHtml(server.ip)}', '${escapeHtml(targetInputId)}')"
      aria-label="Select server ${escapeHtml(server.name)}"
    >
      <div>
        <strong>${escapeHtml(server.name)}</strong>
        <div><code>${escapeHtml(server.ip)}</code></div>
      </div>
      <i class="fas fa-chevron-right" aria-hidden="true"></i>
    </button>
  `).join('');
}

async function showServerSelectionPopup(targetInputId = 'serverIP') {
  try {
    const response = await apiService.getWhitelistedServers();
    const servers = Array.isArray(response?.servers) ? response.servers : [];

    if (!response?.success || servers.length === 0) {
      await MCLBUI.info('No Servers Available', 'No whitelisted servers are currently available. Please enter a server IP manually.');
      return;
    }

    await MCLBUI.alert({
      title: 'Select a Server',
      html: `
        <div class="dashboard-server-option-list" role="listbox" aria-label="Whitelisted servers">
          ${buildServerSelectionMarkup(servers, targetInputId)}
        </div>
      `,
      showCancelButton: true,
      showConfirmButton: false,
      cancelButtonText: 'Close',
      width: '600px'
    });
  } catch (error) {
    console.error('Error loading servers:', error);
    await MCLBUI.error('Unable to Load Servers', 'Failed to load whitelisted servers. Please try again.');
  }
}

function selectServer(serverIp, targetInputId = 'serverIP') {
  const input = document.getElementById(targetInputId);
  if (input) {
    input.value = serverIp;
  }
  Swal.close();
}

if (typeof window !== 'undefined') {
  window.getTimeAgo = getTimeAgo;
  window.copyMatchId = copyMatchId;
  window.openMatchWithFallback = openMatchWithFallback;
  window.loadRecentMatches = loadRecentMatches;
  window.loadQueueCooldowns = loadQueueCooldowns;
  window.updateCooldownTimers = updateCooldownTimers;
  window.handleSetUnavailable = handleSetUnavailable;
  window.checkQueueCooldown = checkQueueCooldown;
  window.formatTimeLeft = formatTimeLeft;
  window.checkUserWarnings = checkUserWarnings;
  window.showWarningBanner = showWarningBanner;
  window.acknowledgeWarning = acknowledgeWarning;
  window.showTierTesterBanner = showTierTesterBanner;
  window.showServerSelectionPopup = showServerSelectionPopup;
  window.selectServer = selectServer;
}
