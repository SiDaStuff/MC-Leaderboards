(function () {
  const REGION_OPTIONS = ['NA', 'EU', 'AS', 'SA', 'AU'];
  const GAMEMODE_ALIASES = {
    overall: 'overall',
    vanilla: 'vanilla',
    uhc: 'uhc',
    pot: 'pot',
    nethop: 'nethop',
    smp: 'smp',
    sword: 'sword',
    axe: 'axe',
    mace: 'mace',
    netheritepothop: 'nethop',
    netherop: 'nethop',
    netop: 'nethop'
  };

  const searchState = {
    dropdown: null,
    results: [],
    filterSuggestions: [],
    activeItems: [],
    highlightedIndex: -1,
    parsedQuery: null,
    debounceTimer: null,
    requestId: 0,
    initialized: false
  };

  function getSearchInput() {
    return document.getElementById('searchInput');
  }

  function escapeHtml(text) {
    if (typeof window.escapeHtml === 'function' && window.escapeHtml !== escapeHtml) {
      return window.escapeHtml(text);
    }

    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
  }

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeGamemode(value) {
    return GAMEMODE_ALIASES[normalizeText(value)] || null;
  }

  function hydrateGamemodeAliases() {
    (CONFIG?.GAMEMODES || []).forEach((gamemode) => {
      const id = normalizeText(gamemode?.id);
      const name = normalizeText(gamemode?.name);
      if (id) {
        GAMEMODE_ALIASES[id] = gamemode.id;
      }
      if (name) {
        GAMEMODE_ALIASES[name.replace(/\s+/g, '')] = gamemode.id;
        GAMEMODE_ALIASES[name] = gamemode.id;
      }
    });
  }

  function getGamemodeMeta(gamemodeId) {
    return (CONFIG?.GAMEMODES || []).find((gamemode) => gamemode.id === gamemodeId) || null;
  }

  function buildAvatarUrl(username) {
    return `https://render.crafty.gg/3d/bust/${encodeURIComponent(String(username || 'Steve'))}`;
  }

  function parseSearchQuery(rawValue) {
    const raw = String(rawValue || '').trim();
    const pieces = raw ? raw.split(/\s+/) : [];
    const filters = [];
    const terms = [];

    pieces.forEach((piece) => {
      const tokenMatch = piece.match(/^([a-z]+):(.*)$/i);
      if (!tokenMatch) {
        terms.push(piece);
        return;
      }

      const key = normalizeText(tokenMatch[1]);
      const value = tokenMatch[2].trim();
      if (!value) {
        terms.push(piece);
        return;
      }

      if (key === 'region' || key === 'in') {
        filters.push({
          key: 'region',
          value: value.toUpperCase(),
          raw: `${key}:${value}`
        });
        return;
      }

      if (key === 'mode' || key === 'gamemode' || key === 'gm') {
        const normalizedGamemode = normalizeGamemode(value);
        if (normalizedGamemode) {
          filters.push({
            key: 'gamemode',
            value: normalizedGamemode,
            raw: `${key}:${value}`
          });
          return;
        }
      }

      terms.push(piece);
    });

    const regionFilter = filters.find((filter) => filter.key === 'region')?.value || null;
    const gamemodeFilter = filters.find((filter) => filter.key === 'gamemode')?.value || null;
    const trailingToken = pieces.length > 0 ? pieces[pieces.length - 1] : '';

    return {
      raw,
      filters,
      searchText: terms.join(' ').trim(),
      region: regionFilter,
      gamemode: gamemodeFilter,
      trailingToken,
      trailingText: trailingToken.includes(':') ? trailingToken.split(':').slice(1).join(':') : trailingToken
    };
  }

  function formatSearchValue(parsed) {
    if (!parsed) return '';

    const parts = [];
    if (parsed.region) {
      parts.push(`region:${parsed.region}`);
    }
    if (parsed.gamemode) {
      parts.push(`mode:${parsed.gamemode}`);
    }
    if (parsed.searchText) {
      parts.push(parsed.searchText);
    }
    return parts.join(' ').trim();
  }

  function updateSearchHint(parsed) {
    const hint = document.querySelector('.search-shortcut-hint');
    if (!hint) return;

    const activeParts = [];
    if (parsed?.region) activeParts.push(`region ${parsed.region}`);
    if (parsed?.gamemode) {
      const gamemode = getGamemodeMeta(parsed.gamemode);
      activeParts.push(`mode ${gamemode?.name || parsed.gamemode}`);
    }

    const guidance = activeParts.length
      ? `Filtering by ${activeParts.join(' and ')}.`
      : 'Type to search players, or add filters like region:NA or mode:sword.';

    hint.innerHTML = `Press <kbd>/</kbd> to focus search. ${escapeHtml(guidance)}`;
  }

  function buildFilterSuggestions(parsed) {
    const suggestions = [];
    const trailingText = normalizeText(parsed?.trailingText);
    const plainTrailing = normalizeText(parsed?.trailingToken);

    if (!parsed?.region) {
      REGION_OPTIONS
        .filter((region) => !trailingText || region.toLowerCase().startsWith(trailingText) || plainTrailing === region.toLowerCase())
        .slice(0, 3)
        .forEach((region) => {
          suggestions.push({
            type: 'filter',
            filterKey: 'region',
            value: region,
            title: `Filter to ${region}`,
            subtitle: 'Show only players from this region'
          });
        });
    }

    if (!parsed?.gamemode) {
      (CONFIG?.GAMEMODES || [])
        .filter((gamemode) => gamemode.id !== 'overall')
        .filter((gamemode) => {
          if (!trailingText && !plainTrailing) return gamemode.id === 'vanilla' || gamemode.id === 'sword';
          const gamemodeName = normalizeText(gamemode.name);
          return gamemodeName.startsWith(trailingText) || gamemode.id.startsWith(trailingText) || gamemodeName.includes(plainTrailing);
        })
        .slice(0, 3)
        .forEach((gamemode) => {
          suggestions.push({
            type: 'filter',
            filterKey: 'gamemode',
            value: gamemode.id,
            title: `Filter to ${gamemode.name}`,
            subtitle: 'Limit results to one gamemode leaderboard'
          });
        });
    }

    return suggestions;
  }

  function closeSearchDropdown() {
    if (!searchState.dropdown) return;
    searchState.dropdown.classList.remove('is-open');
  }

  function setHighlightedIndex(nextIndex) {
    searchState.highlightedIndex = Number.isFinite(nextIndex) ? nextIndex : -1;
    if (!searchState.dropdown) return;

    searchState.dropdown.querySelectorAll('[data-index]').forEach((button) => {
      const buttonIndex = Number(button.dataset.index);
      button.classList.toggle('is-active', buttonIndex === searchState.highlightedIndex);
    });
  }

  function ensureDropdown() {
    const input = getSearchInput();
    if (!input) return null;

    const wrapper = input.closest('.navbar-search') || input.parentElement;
    if (!wrapper) return null;

    wrapper.classList.add('command-search');

    if (!searchState.dropdown) {
      const dropdown = document.createElement('div');
      dropdown.className = 'command-search-dropdown';
      dropdown.id = 'playerSearchDropdown';
      dropdown.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-index]')) {
          event.preventDefault();
        }
      });
      dropdown.addEventListener('click', (event) => {
        const button = event.target.closest('[data-index]');
        if (!button) return;
        const item = searchState.activeItems[Number(button.dataset.index)];
        activateSearchItem(item);
      });
      dropdown.addEventListener('mouseover', (event) => {
        const button = event.target.closest('[data-index]');
        if (!button) return;
        setHighlightedIndex(Number(button.dataset.index));
      });
      wrapper.appendChild(dropdown);
      searchState.dropdown = dropdown;
    }

    return searchState.dropdown;
  }

  function navigateToPlayerProfile(playerOrUsername) {
    const isPlayerObject = typeof playerOrUsername === 'object' && playerOrUsername !== null;
    const safePlayerId = String(isPlayerObject ? (playerOrUsername.id || '') : '').trim();
    const safeUsername = String(isPlayerObject ? (playerOrUsername.username || '') : playerOrUsername || '').trim();
    if (!safePlayerId && !safeUsername) return;

    const params = new URLSearchParams();
    if (safePlayerId) {
      params.set('id', safePlayerId);
    }
    if (safeUsername) {
      params.set('username', safeUsername);
    }

    closeSearchDropdown();
    window.location.href = `player.html?${params.toString()}`;
  }

  function applyFilterSuggestion(filterKey, value, { execute = false } = {}) {
    const input = getSearchInput();
    if (!input) return;

    const parsed = parseSearchQuery(input.value);
    if (filterKey === 'region') {
      parsed.region = String(value || '').toUpperCase();
    } else if (filterKey === 'gamemode') {
      parsed.gamemode = normalizeGamemode(value);
    }

    input.value = formatSearchValue(parsed);
    if (execute) {
      closeSearchDropdown();
      executeSearchCommand(parsed);
      return;
    }

    input.focus();
    refreshSearchSuggestions(true);
  }

  function getHighlightedItem() {
    if (searchState.highlightedIndex < 0) return null;
    return searchState.activeItems[searchState.highlightedIndex] || null;
  }

  function activateSearchItem(item) {
    if (!item) return;

    if (item.type === 'player') {
      navigateToPlayerProfile(item);
      return;
    }

    if (item.type === 'filter') {
      applyFilterSuggestion(item.filterKey, item.value, { execute: true });
    }
  }

  function executeSearchCommand(parsed) {
    const effectiveQuery = parsed || parseSearchQuery(getSearchInput()?.value || '');
    const hasFilters = Boolean(effectiveQuery.region || effectiveQuery.gamemode);
    const firstPlayer = searchState.results[0] || null;

    if (firstPlayer && effectiveQuery.searchText) {
      navigateToPlayerProfile(firstPlayer);
      return;
    }

    if (!hasFilters) {
      return;
    }

    const params = new URLSearchParams();
    if (effectiveQuery.region) {
      params.set('region', effectiveQuery.region);
    }
    if (effectiveQuery.gamemode) {
      params.set('gamemode', effectiveQuery.gamemode);
    }

    const isLeaderboardPage = /(^|\/)index\.html$/.test(window.location.pathname) || window.location.pathname === '/' || window.location.pathname.endsWith('/mcleaderboards-main/');
    if (isLeaderboardPage) {
      if (typeof window.applyLeaderboardFilters === 'function') {
        window.applyLeaderboardFilters({
          gamemode: effectiveQuery.gamemode || 'overall',
          region: effectiveQuery.region || ''
        });
      }
      return;
    }

    window.location.href = `index.html${params.toString() ? `?${params.toString()}` : ''}`;
  }

  function renderSearchDropdown() {
    const dropdown = ensureDropdown();
    if (!dropdown) return;

    const parsed = searchState.parsedQuery || parseSearchQuery('');
    updateSearchHint(parsed);

    const hasAnyItems = searchState.filterSuggestions.length > 0 || searchState.results.length > 0;

    if (!hasAnyItems && !parsed.raw) {
      dropdown.innerHTML = `
        <div class="command-search-empty">
          <div class="command-search-empty__title">Search players or add a filter</div>
          <div class="command-search-empty__text">Try <strong>region:NA</strong> or <strong>mode:sword</strong>.</div>
        </div>
      `;
      dropdown.classList.add('is-open');
      return;
    }

    if (!hasAnyItems) {
      dropdown.innerHTML = `
        <div class="command-search-empty">
          <div class="command-search-empty__title">No matching players yet</div>
          <div class="command-search-empty__text">Keep typing or add a filter to narrow the search.</div>
        </div>
      `;
      dropdown.classList.add('is-open');
      return;
    }

    searchState.activeItems = [...searchState.filterSuggestions, ...searchState.results];

    const filterMarkup = searchState.filterSuggestions.length
      ? `
        <div class="command-search-section">
          <div class="command-search-section__title">Suggested Filters</div>
          ${searchState.filterSuggestions.map((suggestion, index) => `
            <button type="button" class="command-search-item command-search-item--filter ${searchState.highlightedIndex === index ? 'is-active' : ''}" data-index="${index}">
              <span class="command-search-item__title">${escapeHtml(suggestion.title)}</span>
              <span class="command-search-item__subtitle">${escapeHtml(suggestion.subtitle)}</span>
            </button>
          `).join('')}
        </div>
      `
      : '';

    const playerOffset = searchState.filterSuggestions.length;
    const playerMarkup = searchState.results.length
      ? `
        <div class="command-search-section">
          <div class="command-search-section__title">Players</div>
          ${searchState.results.map((player, index) => {
            const itemIndex = playerOffset + index;
            return `
              <button type="button" class="command-search-item ${searchState.highlightedIndex === itemIndex ? 'is-active' : ''}" data-index="${itemIndex}">
                <img src="${buildAvatarUrl(player.username)}"
                     alt="${escapeHtml(player.username)}"
                     class="command-search-item__avatar"
                     onerror="this.src='https://render.crafty.gg/3d/bust/Steve'">
                <span class="command-search-item__body">
                  <span class="command-search-item__title">${escapeHtml(player.username)}</span>
                  <span class="command-search-item__subtitle">${escapeHtml(player.region || 'Unknown')} • ${escapeHtml(String(player.overallRating || 0))} Elo</span>
                </span>
              </button>
            `;
          }).join('')}
        </div>
      `
      : '';

    dropdown.innerHTML = `${filterMarkup}${playerMarkup}`;
    dropdown.classList.add('is-open');
    setHighlightedIndex(searchState.highlightedIndex);
  }

  async function refreshSearchSuggestions(forceOpen = false) {
    const input = getSearchInput();
    if (!input || typeof apiService === 'undefined') return;

    const parsed = parseSearchQuery(input.value);
    searchState.parsedQuery = parsed;
    searchState.filterSuggestions = buildFilterSuggestions(parsed);

    const query = parsed.searchText;
    const requestId = ++searchState.requestId;

    if (!query || query.length < 1) {
      searchState.results = [];
      setHighlightedIndex(searchState.filterSuggestions.length ? 0 : -1);
      if (forceOpen) {
        renderSearchDropdown();
      } else {
        renderSearchDropdown();
      }
      return;
    }

    try {
      const response = await apiService.getPlayerSuggestions(query, 8, {
        region: parsed.region,
        gamemode: parsed.gamemode
      });

      if (requestId !== searchState.requestId) {
        return;
      }

      searchState.results = Array.isArray(response?.suggestions) ? response.suggestions.map((suggestion) => ({
        type: 'player',
        id: suggestion.id || null,
        username: suggestion.username,
        region: suggestion.region,
        overallRating: suggestion.overallRating,
        minecraftUUID: suggestion.minecraftUUID || null
      })) : [];
      setHighlightedIndex((searchState.filterSuggestions.length + searchState.results.length) > 0 ? 0 : -1);
      renderSearchDropdown();
    } catch (error) {
      console.error('Unable to refresh player search suggestions:', error);
      searchState.results = [];
      renderSearchDropdown();
    }
  }

  function scheduleRefresh(forceOpen = false) {
    clearTimeout(searchState.debounceTimer);
    searchState.debounceTimer = setTimeout(() => {
      refreshSearchSuggestions(forceOpen);
    }, 140);
  }

  function ensureSearchHint() {
    const wrapper = document.querySelector('.navbar-search-wrapper');
    if (!wrapper || wrapper.querySelector('.search-shortcut-hint')) return;

    const hint = document.createElement('div');
    hint.className = 'search-shortcut-hint';
    wrapper.appendChild(hint);
  }

  function focusSearchInput() {
    const input = getSearchInput();
    if (!input) return;
    input.focus();
    input.select();
    scheduleRefresh(true);
  }

  function initSearchCommandBar() {
    if (searchState.initialized) return;

    const input = getSearchInput();
    if (!input) return;

    ensureSearchHint();
    ensureDropdown();
    hydrateGamemodeAliases();
    searchState.initialized = true;

    input.setAttribute('placeholder', 'Search players or type region:NA mode:sword');

    input.addEventListener('focus', () => {
      scheduleRefresh(true);
    });

    input.addEventListener('input', () => {
      scheduleRefresh(true);
    });

    input.addEventListener('keydown', (event) => {
      const items = searchState.activeItems;

      if (event.key === 'ArrowDown' && items.length > 0) {
        event.preventDefault();
        searchState.highlightedIndex = (searchState.highlightedIndex + 1 + items.length) % items.length;
        renderSearchDropdown();
        return;
      }

      if (event.key === 'ArrowUp' && items.length > 0) {
        event.preventDefault();
        searchState.highlightedIndex = (searchState.highlightedIndex - 1 + items.length) % items.length;
        renderSearchDropdown();
        return;
      }

      if (event.key === 'Escape') {
        closeSearchDropdown();
        input.blur();
        return;
      }

      if (event.key === 'Enter') {
        const highlightedItem = getHighlightedItem();
        const firstPlayer = searchState.results[0] || null;
        const parsed = parseSearchQuery(input.value);
        event.preventDefault();
        if (highlightedItem || firstPlayer) {
          activateSearchItem(highlightedItem || firstPlayer);
          return;
        }
        executeSearchCommand(parsed);
      }
    });

    document.addEventListener('click', (event) => {
      const inputEl = getSearchInput();
      const dropdown = searchState.dropdown;
      if (!inputEl || !dropdown) return;

      const searchRoot = inputEl.closest('.navbar-search');
      if (searchRoot && !searchRoot.contains(event.target)) {
        closeSearchDropdown();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (
        event.key === '/'
        && !event.ctrlKey
        && !event.metaKey
        && !event.altKey
      ) {
        const activeElement = document.activeElement;
        const tagName = activeElement?.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA') return;
        event.preventDefault();
        focusSearchInput();
      }
    });
  }

  window.MCLBPlayerSearch = {
    parseSearchQuery,
    navigateToPlayerProfile,
    focusSearchInput,
    applyFilterSuggestion,
    refreshSearchSuggestions,
    executeSearchCommand,
    init: initSearchCommandBar
  };

  window.openPlayerModal = function openPlayerModal(player) {
    if (typeof player === 'string') {
      try {
        const parsed = JSON.parse(player);
        navigateToPlayerProfile(parsed);
        return;
      } catch (_) {}
    }

    navigateToPlayerProfile(player);
  };

  window.closePlayerModal = function closePlayerModal() {
    closeSearchDropdown();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearchCommandBar);
  } else {
    initSearchCommandBar();
  }
})();
