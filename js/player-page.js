const PLAYER_MATCHES_PER_PAGE = 8;

const playerPageState = {
  playerId: '',
  username: '',
  profile: null,
  matchesPage: 1,
  totalMatchPages: 1
};

function playerPageEscapeHtml(value) {
  if (typeof escapeHtml === 'function') {
    return escapeHtml(value);
  }

  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

function getPlayerPageCombatTitle(rating) {
  if (typeof utils !== 'undefined' && typeof utils.getCombatTitle === 'function') {
    return utils.getCombatTitle(rating);
  }

  for (const title of CONFIG.COMBAT_TITLES || []) {
    if (Number(rating) >= Number(title.minRating || 0)) {
      return title;
    }
  }

  return (CONFIG.COMBAT_TITLES || [])[CONFIG.COMBAT_TITLES.length - 1] || {
    title: 'Rookie',
    icon: 'assets/badgeicons/rookie.svg'
  };
}

function getGamemodeMeta(gamemodeId) {
  return (CONFIG.GAMEMODES || []).find((gamemode) => gamemode.id === gamemodeId) || null;
}

function getPlayerPageRoleBadges(player) {
  return typeof renderRoleBadges === 'function'
    ? renderRoleBadges(player)
    : '';
}

function formatPlayerMatchDate(dateValue) {
  if (!dateValue) return 'Unknown date';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString();
}

function getResultText(match) {
  if (match.result === 'win') return 'Won';
  if (match.result === 'loss') return 'Lost';
  return 'Draw';
}

function getResultClass(match) {
  if (match.result === 'win') return 'is-win';
  if (match.result === 'loss') return 'is-loss';
  return 'is-draw';
}

function getPlayerAvatar(username) {
  return `https://render.crafty.gg/3d/bust/${encodeURIComponent(String(username || 'Steve'))}`;
}

function normalizePlayerPageUsername(value) {
  return String(value || '').trim().toLowerCase();
}

async function resolveLegacyPlayerId(username) {
  const normalizedUsername = normalizePlayerPageUsername(username);
  if (!normalizedUsername) return null;

  const response = await apiService.getPlayerSuggestions(username, 25);
  const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
  return suggestions.find((suggestion) => normalizePlayerPageUsername(suggestion?.username) === normalizedUsername) || null;
}

function syncPlayerPageUrl() {
  const params = new URLSearchParams(window.location.search);
  if (playerPageState.playerId) {
    params.set('id', playerPageState.playerId);
  }
  if (playerPageState.username) {
    params.set('username', playerPageState.username);
  }

  const nextQuery = params.toString();
  const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
  window.history.replaceState({}, '', nextUrl);
}

function openNameMcProfileFromPlayerPage() {
  const profile = playerPageState.profile;
  if (!profile) return;

  const rawUuid = String(profile.uuid || profile.minecraftUUID || '').trim().replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(rawUuid)) {
    window.open(`https://namemc.com/profile/${rawUuid}`, '_blank', 'noopener,noreferrer');
    return;
  }

  const username = String(profile.username || '').trim();
  if (username) {
    window.open(`https://namemc.com/profile/${encodeURIComponent(`${username}.1`)}`, '_blank', 'noopener,noreferrer');
  }
}

function openPlayerReportPage() {
  const profile = playerPageState.profile;
  if (!profile?.username) return;
  window.location.href = `support.html?category=player_report&player=${encodeURIComponent(profile.username)}`;
}

function jumpToLeaderboardWithFilters({ region = null, gamemode = null } = {}) {
  const params = new URLSearchParams();
  if (region) params.set('region', region);
  if (gamemode) params.set('gamemode', gamemode);
  window.location.href = `index.html${params.toString() ? `?${params.toString()}` : ''}`;
}

function renderPlayerHero() {
  const profile = playerPageState.profile;
  if (!profile) return;

  const overallRating = Number(profile.overallRating || profile.overall || 0) || 0;
  const combatTitle = getPlayerPageCombatTitle(overallRating);
  const roleBadges = getPlayerPageRoleBadges(profile);
  const ratings = profile.rankings || {};
  const totalMatches = Object.values(ratings).reduce((sum, rating) => sum + (Number(rating?.games_played) || 0), 0);

  document.title = `${profile.username} - MC Leaderboards`;

  const hero = document.getElementById('playerHero');
  hero.innerHTML = `
    <section class="player-hero-card">
      <div class="player-hero-card__identity">
        <div class="player-hero-card__avatar-shell">
          <img src="${getPlayerAvatar(profile.username)}"
               alt="${playerPageEscapeHtml(profile.username)}"
               class="player-hero-card__avatar"
               onerror="this.src='https://render.crafty.gg/3d/bust/Steve'">
        </div>
        <div class="player-hero-card__copy">
          <div class="player-hero-card__eyebrow">Verified leaderboard profile</div>
          <h1>${playerPageEscapeHtml(profile.username)}</h1>
          <div class="player-hero-card__meta">
            <span class="player-hero-card__meta-item">
              <img src="${playerPageEscapeHtml(combatTitle.icon)}" alt="${playerPageEscapeHtml(combatTitle.title)}" class="badge-icon">
              ${playerPageEscapeHtml(combatTitle.title)}
            </span>
            <button type="button" class="lb-region-tag lb-region-tag--button" onclick="jumpToLeaderboardWithFilters({ region: '${playerPageEscapeHtml(profile.region || 'Unknown')}' })">
              ${playerPageEscapeHtml(profile.region || 'Unknown')}
            </button>
            <span class="player-hero-card__meta-item">Overall Elo ${playerPageEscapeHtml(String(overallRating))}</span>
          </div>
          <div class="player-hero-card__badges">
            ${profile.blacklisted ? '<span class="badge badge-danger">Blacklisted</span>' : ''}
            ${roleBadges}
          </div>
        </div>
      </div>

      <div class="player-hero-card__stats">
        <div class="player-hero-stat">
          <span class="player-hero-stat__label">Overall Elo</span>
          <strong>${playerPageEscapeHtml(String(overallRating))}</strong>
        </div>
        <div class="player-hero-stat">
          <span class="player-hero-stat__label">Global Rank</span>
          <strong>#${playerPageEscapeHtml(String(profile.globalRank || 'N/A'))}</strong>
        </div>
        <div class="player-hero-stat">
          <span class="player-hero-stat__label">Total Matches</span>
          <strong>${playerPageEscapeHtml(String(totalMatches))}</strong>
        </div>
      </div>

      <div class="player-hero-card__actions">
        <button type="button" class="btn btn-secondary" onclick="openNameMcProfileFromPlayerPage()">
          <i class="fas fa-id-card"></i> NameMC
        </button>
        <button type="button" class="btn btn-danger" onclick="openPlayerReportPage()">
          <i class="fas fa-flag"></i> Report
        </button>
      </div>
    </section>
  `;
}

function renderPlayerSummary() {
  const profile = playerPageState.profile;
  if (!profile) return;

  const ratings = profile.rankings || {};
  const retiredGamemodes = profile.retiredGamemodes || {};
  const ratedEntries = Object.entries(ratings)
    .filter(([, rating]) => Number(rating?.rating) > 0)
    .sort((left, right) => Number(right[1]?.rating || 0) - Number(left[1]?.rating || 0));
  const retiredModeCount = (CONFIG.GAMEMODES || [])
    .filter((gamemode) => gamemode.id !== 'overall' && retiredGamemodes[gamemode.id] === true)
    .length;
  const highestMode = ratedEntries[0] || null;
  const placingModes = Object.values(ratings)
    .filter((rating) => Number(rating?.games_played || 0) > 0 && Number(rating?.rating || 0) <= 0)
    .length;
  const strongestModeName = highestMode ? getGamemodeMeta(highestMode[0])?.name || highestMode[0] : 'Unrated';
  const strongestModeElo = highestMode ? Number(highestMode[1]?.rating || 0) : 0;

  const summary = document.getElementById('playerSummaryPanel');
  summary.innerHTML = `
    <div class="player-summary-stack">
      <div class="player-summary-card">
        <span class="player-summary-card__label">Best Queue</span>
        <strong class="player-summary-card__value">${playerPageEscapeHtml(strongestModeName)}</strong>
        <p class="text-muted" style="margin: 0.35rem 0 0;">${highestMode ? `${playerPageEscapeHtml(String(strongestModeElo))} Elo in their strongest rated mode.` : 'No rated queues yet.'}</p>
      </div>
      <div class="player-summary-card">
        <span class="player-summary-card__label">Rated Queues</span>
        <strong class="player-summary-card__value">${playerPageEscapeHtml(String(ratedEntries.length))}</strong>
      </div>
      <div class="player-summary-card">
        <span class="player-summary-card__label">Placement Queues</span>
        <strong class="player-summary-card__value">${playerPageEscapeHtml(String(placingModes))}</strong>
      </div>
      <div class="player-summary-card ${retiredModeCount ? 'player-summary-card--retired' : ''}">
        <span class="player-summary-card__label">Retired Queues</span>
        <strong class="player-summary-card__value">${playerPageEscapeHtml(String(retiredModeCount))}</strong>
      </div>
      <div class="player-summary-card player-summary-card--info">
        <span class="player-summary-card__label">Overall vs individual Elo</span>
        <p>Overall Elo is broad performance across modes. Individual mode Elo is what matters for that specific queue.</p>
      </div>
    </div>
  `;
}

function renderPlayerRatings() {
  const profile = playerPageState.profile;
  if (!profile) return;

  const ratingsGrid = document.getElementById('playerRatingsGrid');
  const ratings = profile.rankings || {};
  const retiredGamemodes = profile.retiredGamemodes || {};

  ratingsGrid.innerHTML = (CONFIG.GAMEMODES || [])
    .filter((gamemode) => gamemode.id !== 'overall')
    .map((gamemode) => {
      const rating = ratings[gamemode.id];
      const elo = Number(rating?.rating || 0);
      const peak = Number(rating?.peak_rating || 0);
      const matches = Number(rating?.games_played || 0);
      const isRated = elo > 0;
      const isRetired = retiredGamemodes[gamemode.id] === true;

      return `
        <button type="button" class="player-rating-card ${isRated ? '' : 'is-unrated'} ${isRetired ? 'is-retired' : ''}" onclick="jumpToLeaderboardWithFilters({ gamemode: '${gamemode.id}' })">
          <div class="player-rating-card__top">
            <span class="player-rating-card__mode">
              <img src="${playerPageEscapeHtml(gamemode.icon)}" alt="${playerPageEscapeHtml(gamemode.name)}" class="player-rating-card__icon">
              ${playerPageEscapeHtml(gamemode.name)}
            </span>
            <span class="player-rating-card__status ${isRetired ? 'is-retired' : ''}">
              ${isRetired ? '<i class="fas fa-lock"></i> Retired' : '<i class="fas fa-arrow-up-right-from-square"></i> Open'}
            </span>
          </div>
          <div class="player-rating-card__elo">${isRated ? `${playerPageEscapeHtml(String(elo))} Elo` : 'Unrated'}</div>
          <div class="player-rating-card__meta">
            <span>${matches} match${matches === 1 ? '' : 'es'}</span>
            <span>${peak > elo ? `Peak ${peak}` : 'Current peak'}</span>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderPlayerMatches(matchesResponse) {
  const list = document.getElementById('playerMatchesList');
  const prevBtn = document.getElementById('playerMatchesPrevBtn');
  const nextBtn = document.getElementById('playerMatchesNextBtn');
  const pageLabel = document.getElementById('playerMatchesPageLabel');

  const matches = Array.isArray(matchesResponse?.matches) ? matchesResponse.matches : [];
  playerPageState.totalMatchPages = Math.max(1, Number(matchesResponse?.totalPages || 1));

  pageLabel.textContent = `Page ${playerPageState.matchesPage} of ${playerPageState.totalMatchPages}`;
  prevBtn.disabled = playerPageState.matchesPage <= 1;
  nextBtn.disabled = playerPageState.matchesPage >= playerPageState.totalMatchPages;

  if (!matches.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding: 2rem 0;">
        <div class="empty-state-icon"><i class="fas fa-clock-rotate-left"></i></div>
        <h3>No public matches yet</h3>
        <p class="text-muted">Completed matches will show up here once they are finalized.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = matches.map((match) => {
    const gamemode = getGamemodeMeta(match.gamemode);
    const scoreline = `${Number(match.userScore || 0)} - ${Number(match.opponentScore || 0)}`;
    return `
      <article class="player-match-card ${getResultClass(match)}">
        <div class="player-match-card__identity">
          <img src="${playerPageEscapeHtml(gamemode?.icon || 'assets/vanilla.svg')}" alt="${playerPageEscapeHtml(gamemode?.name || 'Match')}" class="player-match-card__icon">
          <div>
            <div class="player-match-card__headline">
              <strong>vs ${playerPageEscapeHtml(match.opponentName || 'Unknown')}</strong>
              <span class="player-match-card__result">${getResultText(match)}</span>
            </div>
            <div class="player-match-card__meta">
              <span>${playerPageEscapeHtml(gamemode?.name || match.gamemode || 'Unknown')}</span>
              <span>${playerPageEscapeHtml(formatPlayerMatchDate(match.finalizedAt || match.createdAt))}</span>
              <span>${playerPageEscapeHtml(String(match.userRole || 'player')).toUpperCase()}</span>
            </div>
          </div>
        </div>
        <div class="player-match-card__score">
          <strong>${playerPageEscapeHtml(scoreline)}</strong>
        </div>
      </article>
    `;
  }).join('');
}

async function loadPlayerMatches() {
  if (!playerPageState.playerId) return;

  const list = document.getElementById('playerMatchesList');
  list.innerHTML = '<div class="spinner"></div>';

  try {
    const response = await fetchPublicPlayerMatchesById(
      playerPageState.playerId,
      playerPageState.matchesPage,
      PLAYER_MATCHES_PER_PAGE
    );
    renderPlayerMatches(response);
  } catch (error) {
    console.error('Failed to load player matches:', error);
    list.innerHTML = `
      <div class="empty-state" style="padding: 2rem 0;">
        <div class="empty-state-icon"><i class="fas fa-triangle-exclamation"></i></div>
        <h3>Could not load match history</h3>
        <p class="text-muted">Please try again in a moment.</p>
      </div>
    `;
  }
}

async function fetchPublicPlayerProfile(playerId) {
  if (typeof apiService?.getPublicPlayerProfile === 'function') {
    return apiService.getPublicPlayerProfile(playerId);
  }

  return apiService.get(`/players/${encodeURIComponent(playerId)}/public-profile`);
}

async function fetchPublicPlayerMatchesById(playerId, page = 1, limit = 10) {
  if (typeof apiService?.getPublicPlayerMatchesById === 'function') {
    return apiService.getPublicPlayerMatchesById(playerId, page, limit);
  }

  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit)
  });
  return apiService.get(`/players/${encodeURIComponent(playerId)}/matches?${params.toString()}`);
}

async function loadPlayerPage() {
  const loading = document.getElementById('playerPageLoading');
  const error = document.getElementById('playerPageError');
  const page = document.getElementById('playerProfilePage');

  const params = new URLSearchParams(window.location.search);
  const requestedPlayerId = String(params.get('id') || '').trim();
  const requestedUsername = String(params.get('username') || '').trim();
  playerPageState.playerId = requestedPlayerId;
  playerPageState.username = requestedUsername;

  if (!requestedPlayerId && !requestedUsername) {
    loading.classList.add('d-none');
    error.classList.remove('d-none');
    return;
  }

  try {
    let resolvedPlayerId = requestedPlayerId;
    if (!resolvedPlayerId && requestedUsername) {
      const legacyMatch = await resolveLegacyPlayerId(requestedUsername);
      resolvedPlayerId = String(legacyMatch?.id || '').trim();
    }

    if (!resolvedPlayerId) {
      throw new Error('Player not found');
    }

    const profile = await fetchPublicPlayerProfile(resolvedPlayerId);
    playerPageState.playerId = String(profile?.id || resolvedPlayerId).trim();
    playerPageState.username = String(profile?.username || requestedUsername || '').trim();
    playerPageState.profile = profile;
    syncPlayerPageUrl();

    renderPlayerHero();
    renderPlayerSummary();
    renderPlayerRatings();

    error.classList.add('d-none');
    loading.classList.add('d-none');
    page.classList.remove('d-none');

    await loadPlayerMatches();
  } catch (loadError) {
    console.error('Failed to load player page:', loadError);
    page.classList.add('d-none');
    loading.classList.add('d-none');
    error.classList.remove('d-none');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('playerMatchesPrevBtn')?.addEventListener('click', async () => {
    if (playerPageState.matchesPage <= 1) return;
    playerPageState.matchesPage -= 1;
    await loadPlayerMatches();
  });

  document.getElementById('playerMatchesNextBtn')?.addEventListener('click', async () => {
    if (playerPageState.matchesPage >= playerPageState.totalMatchPages) return;
    playerPageState.matchesPage += 1;
    await loadPlayerMatches();
  });

  loadPlayerPage();
});

window.jumpToLeaderboardWithFilters = jumpToLeaderboardWithFilters;
window.openNameMcProfileFromPlayerPage = openNameMcProfileFromPlayerPage;
window.openPlayerReportPage = openPlayerReportPage;
