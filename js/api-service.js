// MC Leaderboards - API Service
// Handles all API communication with the backend

class ApiService {
  constructor() {
    this.baseURL = CONFIG.API_BASE_URL;
    this.token = localStorage.getItem('mc_leaderboards_token');
    
    // Performance optimizations
    this.cache = new Map(); // Response cache
    this.pendingRequests = new Map(); // Request deduplication
    this.cacheTimeout = 30000; // 30 seconds cache timeout
    this.maxCacheSize = 100; // Maximum cached responses
    this._refreshingToken = null; // Mutex for token refresh
    this._recaptchaScriptLoad = null;
    this.cacheInvalidationMap = new Map([
      ['/users/me', ['/users/me', '/users/me/standing', '/users/me/recent-matches', '/dashboard/stats']],
      ['/queue/join', ['/queue/status', '/queue/stats', '/dashboard/stats']],
      ['/queue/leave', ['/queue/status', '/queue/stats', '/dashboard/stats']],
      ['/match/active', ['/dashboard/stats']],
      ['/support/tickets', ['/support/tickets/me']],
      ['/submit-player-report', ['/reports/my']]
    ]);
  }

  shouldAttachRecaptcha(endpoint, method) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') {
      return false;
    }

    const normalizedEndpoint = String(endpoint || '');
    if (!normalizedEndpoint.startsWith('/')) {
      return false;
    }

    return normalizedMethod === 'POST' || normalizedMethod === 'PUT' || normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE';
  }

  getRecaptchaAction(endpoint, method) {
    const normalizedMethod = String(method || 'GET').toLowerCase();
    const normalizedEndpoint = String(endpoint || '')
      .replace(/^\/+/, '')
      .replace(/\?.*$/, '')
      .replace(/\/+/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^api_?/, '');

    const rawAction = `${normalizedMethod}_${normalizedEndpoint || 'request'}`
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();

    return rawAction.slice(0, 100) || 'submit';
  }

  async ensureRecaptchaServiceLoaded() {
    if (typeof window === 'undefined') {
      return null;
    }

    if (window.RecaptchaService && typeof window.RecaptchaService.getToken === 'function') {
      return window.RecaptchaService;
    }

    if (!this._recaptchaScriptLoad) {
      this._recaptchaScriptLoad = new Promise((resolve, reject) => {
        const existingScript = document.querySelector('script[src*="js/recaptcha-service.js"]');
        if (existingScript) {
          const startedAt = Date.now();
          const interval = setInterval(() => {
            if (window.RecaptchaService && typeof window.RecaptchaService.getToken === 'function') {
              clearInterval(interval);
              resolve(window.RecaptchaService);
              return;
            }

            if (Date.now() - startedAt > 10000) {
              clearInterval(interval);
              reject(new Error('reCAPTCHA service did not become available in time.'));
            }
          }, 100);
          return;
        }

        const script = document.createElement('script');
        script.src = '/js/recaptcha-service.js';
        script.async = true;
        script.onload = () => {
          if (window.RecaptchaService && typeof window.RecaptchaService.getToken === 'function') {
            resolve(window.RecaptchaService);
            return;
          }

          const startedAt = Date.now();
          const interval = setInterval(() => {
            if (window.RecaptchaService && typeof window.RecaptchaService.getToken === 'function') {
              clearInterval(interval);
              resolve(window.RecaptchaService);
              return;
            }

            if (Date.now() - startedAt > 10000) {
              clearInterval(interval);
              reject(new Error('reCAPTCHA service did not initialize in time.'));
            }
          }, 100);
        };
        script.onerror = () => reject(new Error('Failed to load reCAPTCHA service script.'));
        document.head.appendChild(script);
      }).finally(() => {
        this._recaptchaScriptLoad = null;
      });
    }

    return this._recaptchaScriptLoad;
  }

  async getRecaptchaToken(action = 'submit') {
    const recaptchaService = await this.ensureRecaptchaServiceLoaded();
    if (!recaptchaService || typeof recaptchaService.getToken !== 'function') {
      throw new Error('reCAPTCHA service is unavailable right now.');
    }

    return recaptchaService.getToken(action);
  }

  hasRecentRecaptchaVerification() {
    return Boolean(
      typeof window !== 'undefined'
      && window.RecaptchaService
      && typeof window.RecaptchaService.hasRecentVerification === 'function'
      && window.RecaptchaService.hasRecentVerification()
    );
  }

  markRecentRecaptchaVerification() {
    if (
      typeof window !== 'undefined'
      && window.RecaptchaService
      && typeof window.RecaptchaService.markVerified === 'function'
    ) {
      window.RecaptchaService.markVerified();
    }
  }

  formatRateLimitRetryText(retryAtMs) {
    if (!retryAtMs || Number.isNaN(retryAtMs)) {
      return null;
    }

    const remainingMs = Math.max(0, retryAtMs - Date.now());
    if (remainingMs <= 0) {
      return 'in a moment';
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    if (totalSeconds < 60) {
      return `in ${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
    }

    const totalMinutes = Math.ceil(totalSeconds / 60);
    if (totalMinutes < 60) {
      return `in ${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
    }

    const totalHours = Math.ceil(totalMinutes / 60);
    return `in ${totalHours} hour${totalHours === 1 ? '' : 's'}`;
  }

  buildRateLimitMessage(baseMessage, retryAtMs) {
    const normalizedBaseMessage = String(baseMessage || 'Too many requests right now.').trim();
    const retryText = this.formatRateLimitRetryText(retryAtMs);

    if (retryText) {
      return `${normalizedBaseMessage} Please try again ${retryText}.`;
    }

    return `${normalizedBaseMessage} Please wait a bit and try again.`;
  }

  /**
   * Set authentication token
   */
  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem('mc_leaderboards_token', token);
    } else {
      localStorage.removeItem('mc_leaderboards_token');
    }
  }

  /**
   * Get authentication token
   */
  getToken() {
    return this.token || localStorage.getItem('mc_leaderboards_token');
  }

  /**
   * Clear cache for specific endpoint or all
   */
  clearCache(endpoint = null) {
    if (endpoint) {
      const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      for (const key of this.cache.keys()) {
        if (key.endsWith(`:${normalizedEndpoint}`) || key.includes(`:${normalizedEndpoint}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  invalidateRelatedCache(endpoint) {
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const relatedEndpoints = this.cacheInvalidationMap.get(normalizedEndpoint) || [];
    this.clearCache(normalizedEndpoint);
    relatedEndpoints.forEach((relatedEndpoint) => this.clearCache(relatedEndpoint));
  }

  clearMatchCache(matchId = null) {
    this.clearCache('/match/active');
    this.clearCache('/dashboard/stats');
    if (!matchId) return;
    this.clearCache(`/match/${matchId}`);
    this.clearCache(`/match/${matchId}/messages`);
  }

  /**
   * Make API request with caching and deduplication
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const token = this.getToken();
    const method = (options.method || 'GET').toUpperCase();
    const cacheKey = `${method}:${endpoint}:${options._forceRecaptcha ? 'forced-recaptcha' : 'default'}`;
    const retryCount = Number(options._retryCount || 0);
    
    // Only cache GET requests
    const shouldCache = method === 'GET' && !options.noCache;
    
    // Check cache first for GET requests
    if (shouldCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      } else {
        this.cache.delete(cacheKey);
      }
    }
    
    // Request deduplication - if same request is in flight, wait for it
    if (this.pendingRequests.has(cacheKey)) {
      return await this.pendingRequests.get(cacheKey);
    }

    // Create abort controller for timeout (configurable, default 30s)
    const timeoutMs = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    const requestOptions = { ...options };
    delete requestOptions._retryCount;

    const headers = {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(options.headers || {})
    };

    const hasRequestBody = requestOptions.body !== undefined && requestOptions.body !== null;
    if (hasRequestBody && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    const config = {
      ...requestOptions,
      headers,
      signal: controller.signal
    };

    const shouldProtectWithRecaptcha = this.shouldAttachRecaptcha(endpoint, method);
    let attachedRecaptchaToken = false;

    if (shouldProtectWithRecaptcha && (options._forceRecaptcha || !this.hasRecentRecaptchaVerification())) {
      const recaptchaAction = this.getRecaptchaAction(endpoint, method);
      const recaptchaToken = await this.getRecaptchaToken(recaptchaAction);
      config.headers['X-Recaptcha-Token'] = recaptchaToken;
      config.headers['X-Recaptcha-Action'] = recaptchaAction;
      attachedRecaptchaToken = true;
    }

    // Create request promise
    const requestPromise = (async () => {
      try {
        AppState.setLoading('api', true);
        const response = await fetch(url, config);
        
        // Check if response has content before trying to parse JSON
        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          try {
            const text = await response.text();
            data = text ? JSON.parse(text) : {};
          } catch (parseError) {
            console.error('JSON Parse Error:', parseError);
            data = {};
          }
        } else {
          data = {};
        }

		        if (!response.ok) {
              if (
                shouldProtectWithRecaptcha
                && !attachedRecaptchaToken
                && retryCount < 1
                && ['CAPTCHA_REQUIRED', 'CAPTCHA_FAILED', 'CAPTCHA_ACTION_MISMATCH', 'CAPTCHA_SCORE_TOO_LOW'].includes(String(data.code || ''))
              ) {
                return this.request(endpoint, {
                  ...options,
                  _retryCount: retryCount + 1,
                  _forceRecaptcha: true
                });
              }

		          const errorMessage = data.message || data.error?.message || data.error || `API Error (${response.status})`;
	          const error = new Error(errorMessage);
	          error.status = response.status;
          error.data = data;
          error.code = data.code || data.errorCode || null;
          error.endpoint = endpoint;

          // Attach rate limit metadata for 429 responses
          if (response.status === 429) {
            error.isRateLimit = true;
            try {
              const rateLimitReset = response.headers.get('RateLimit-Reset');
              const retryAfterHeader = response.headers.get('Retry-After');
              let retryAtMs = null;

              if (data.resetAt) {
                const resetDate = new Date(data.resetAt);
                if (!Number.isNaN(resetDate.getTime())) {
                  retryAtMs = resetDate.getTime();
	        }

          if (attachedRecaptchaToken && response.ok) {
            this.markRecentRecaptchaVerification();
          }
              } else if (rateLimitReset) {
                const resetSeconds = Number(rateLimitReset);
                if (!Number.isNaN(resetSeconds) && resetSeconds > 0) {
                  retryAtMs = resetSeconds * 1000;
                }
              } else if (retryAfterHeader) {
                const retryAfterSeconds = Number(retryAfterHeader);
                if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
                  retryAtMs = Date.now() + retryAfterSeconds * 1000;
                }
              }

              error.retryAt = retryAtMs || null;
              const limit = Number(response.headers.get('RateLimit-Limit'));
              const remaining = Number(response.headers.get('RateLimit-Remaining'));
              error.rateLimitInfo = {
                limit: Number.isNaN(limit) ? null : limit,
                remaining: Number.isNaN(remaining) ? null : remaining,
                resetAt: error.retryAt
              };
              error.userMessage = 'Too many requests right now.';
              error.suggestion = error.retryAt
                ? `Please try again ${this.formatRateLimitRetryText(error.retryAt)}.`
                : 'Please wait a bit and try again.';
              error.message = this.buildRateLimitMessage(errorMessage, error.retryAt);
            } catch (metaError) {
              console.warn('Error parsing rate limit metadata:', metaError);
              error.userMessage = 'Too many requests right now.';
              error.suggestion = 'Please wait a bit and try again.';
              error.message = this.buildRateLimitMessage(errorMessage, null);
            }
          }

          // Mark fatal backend errors (5xx) so pages can redirect to error screen.
	          if (response.status >= 500) {
	            error.isBackendError = true;
	            error.isFatalBackendError = true;
	          }

              if (response.status === 403 && data.code === 'ACCOUNT_BANNED' && endpoint !== '/auth/login') {
                error.userMessage = 'This account is not permitted to stay signed in.';
                if (
                  typeof window !== 'undefined'
                  && window.firebaseAuthService
                  && typeof window.firebaseAuthService.forceLogout === 'function'
                ) {
                  await window.firebaseAuthService.forceLogout({
                    redirectTo: '/login.html',
                    notice: {
                      icon: 'error',
                      title: 'Access Restricted',
                      text: 'This account is not permitted to stay signed in.'
                    }
                  });
                }
              }
	          
	          // Handle authentication errors
	          if (response.status === 401) {
            // Token might be expired, try to refresh it
            if (data.code === 'AUTH_INVALID' || data.code === 'auth/id-token-expired') {
              console.log('Token expired, attempting refresh...');
              try {
                const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
                const currentUser = auth.currentUser;
                if (currentUser && retryCount < 1) {
                  // Use mutex to prevent concurrent token refreshes
                  if (!this._refreshingToken) {
                    this._refreshingToken = currentUser.getIdToken(true).finally(() => {
                      this._refreshingToken = null;
                    });
                  }
                  const newToken = await this._refreshingToken;
                  this.setToken(newToken);
                  console.log('Token refreshed successfully');
                  // Retry the request once with the new token
                  return this.request(endpoint, {
                    ...options,
                    _retryCount: retryCount + 1
                  });
                }
              } catch (refreshError) {
                console.error('Failed to refresh token:', refreshError);
                this._refreshingToken = null;
                if (typeof window !== 'undefined') {
                  if (typeof MCLBUI !== 'undefined') {
                    MCLBUI.showSessionBanner('Your session expired. Please sign in again.');
                  }
                  if (typeof navigateTo === 'function') {
                    navigateTo('login.html', { replace: true });
                  } else {
                    window.location.replace('login.html');
                  }
                }
              }
            }
          }

          throw error;
        }

        clearTimeout(timeoutId);
        
        // Cache successful GET responses
        if (shouldCache && response.ok) {
          // Evict oldest entries if cache is full
          if (this.cache.size >= this.maxCacheSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
          }
          this.cache.set(cacheKey, {
            data: data,
            timestamp: Date.now()
          });
        }
        
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        console.error('API Request Error:', error);
        
        // Handle timeout/abort errors
        if (error.name === 'AbortError' || (typeof error.message === 'string' && error.message.includes('aborted'))) {
          const timeoutError = new Error('Request timed out. Please try again.');
          timeoutError.isBackendError = true;
          timeoutError.isFatalBackendError = true;
          timeoutError.endpoint = endpoint;
          throw timeoutError;
        }
        
        // Handle network errors
        if (typeof error.message === 'string' && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))) {
          const netError = new Error('Network error. Please check your connection.');
          netError.isBackendError = true;
          netError.isFatalBackendError = true;
          netError.endpoint = endpoint;
          throw netError;
        }
        
        // Re-throw to allow caller to handle
        throw error;
      } finally {
        // Always clear loading state, even on error
        AppState.setLoading('api', false);
        // Remove from pending requests
        this.pendingRequests.delete(cacheKey);
      }
    })();
    
    // Store pending request for deduplication
    this.pendingRequests.set(cacheKey, requestPromise);
    
    return requestPromise;
  }

  /**
   * GET request
   */
  async get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  }

  /**
   * POST request
   */
  async post(endpoint, data) {
    const response = await this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    this.invalidateRelatedCache(endpoint);
    return response;
  }

  /**
   * PUT request
   */
  async put(endpoint, data) {
    const response = await this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    this.invalidateRelatedCache(endpoint);
    return response;
  }

  /**
   * DELETE request
   */
  async delete(endpoint) {
    const response = await this.request(endpoint, { method: 'DELETE' });
    this.invalidateRelatedCache(endpoint);
    return response;
  }

  // ===== Authentication Endpoints =====

  /**
   * Get current user profile
   */
  async getProfile() {
    return this.get('/users/me');
  }

  /**
   * Get profile with short timeout (for polling/verification checks)
   */
  async getProfileQuick() {
    return this.request('/users/me', { 
      method: 'GET',
      timeout: 5000, // 5 second timeout
      noCache: true // Don't use stale cache for verification checks
    });
  }

  /**
   * Get detailed moderation standing for current user
   */
  async getMyStanding() {
    return this.get('/users/me/standing');
  }

  /**
   * Update user profile
   */
  async updateProfile(data) {
    return this.put('/users/me', data);
  }

  /**
   * Link Minecraft username
   */
  async linkMinecraftUsername(username, region) {
    return this.post('/users/me/minecraft', { username, region });
  }

  /**
   * Get current user profile
   */
  async getUserProfile() {
    return this.get('/users/me');
  }

  /**
   * Get retirement status for a user by userId
   */
  async getUserRetirementStatus(userId) {
    return this.get(`/users/${userId}/retirement-status`);
  }

  /**
   * Get recent matches for current user
   */
  async getRecentMatches(limit = 5) {
    return this.get(`/users/me/recent-matches?limit=${limit}`);
  }


  // ===== Player Endpoints =====

  /**
   * Get all players
   */
  async getPlayers(gamemode = null, offset = 0, limit = 25) {
    let endpoint = '/players?';
    const params = [];
    
    if (gamemode && gamemode !== 'overall') {
      params.push(`gamemode=${gamemode}`);
    }
    // Always send explicit offset for stable pagination/caching behavior
    params.push(`offset=${Math.max(0, parseInt(offset, 10) || 0)}`);
    if (limit) {
      params.push(`limit=${limit}`);
    }

    // Pass showProvisional setting to backend
    try {
      const stored = localStorage.getItem('mclb_leaderboard_settings');
      if (stored) {
        const settings = JSON.parse(stored);
        if (settings.showProvisional) {
          params.push('showProvisional=true');
        }
      }
    } catch (e) { /* ignore */ }
    
    endpoint += params.join('&');
    return this.get(endpoint);
  }

    /**
     * Get players with advanced filters
     */
    async getPlayersFiltered(options = {}) {
      const {
        gamemode = null,
        offset = 0,
        limit = 25,
        ratingMin = null,
        ratingMax = null,
        region = null,
        createdAfter = null,
        createdBefore = null,
        search = null
      } = options;
    
      let endpoint = '/players?';
      const params = [];
    
      if (gamemode && gamemode !== 'overall') {
        params.push(`gamemode=${encodeURIComponent(gamemode)}`);
      }
      params.push(`offset=${Math.max(0, parseInt(offset, 10) || 0)}`);
      if (limit) {
        params.push(`limit=${limit}`);
      }
      if (ratingMin !== null) {
        params.push(`ratingMin=${ratingMin}`);
      }
      if (ratingMax !== null) {
        params.push(`ratingMax=${ratingMax}`);
      }
      if (region) {
        params.push(`region=${encodeURIComponent(region)}`);
      }
      if (createdAfter) {
        params.push(`createdAfter=${encodeURIComponent(createdAfter)}`);
      }
      if (createdBefore) {
        params.push(`createdBefore=${encodeURIComponent(createdBefore)}`);
      }
      if (search) {
        params.push(`search=${encodeURIComponent(search)}`);
      }
    
      endpoint += params.join('&');
      return this.get(endpoint);
    }

    /**
     * Get player search autocomplete suggestions
     */
  async getPlayerSuggestions(query, limit = 10, options = {}) {
    if (!query || query.trim().length < 1) {
      return { suggestions: [], query };
    }

    const params = new URLSearchParams({
      q: query,
      limit: String(limit)
    });

    if (options.region) {
      params.set('region', options.region);
    }
    if (options.gamemode) {
      params.set('gamemode', options.gamemode);
    }

    const endpoint = `/players/search/autocomplete?${params.toString()}`;
    return this.get(endpoint);
  }

  async getPublicPlayerProfile(playerId) {
    if (!playerId) {
      throw new Error('Player ID is required');
    }

    return this.get(`/players/${encodeURIComponent(playerId)}/public-profile`);
  }

  async getPublicPlayerMatchesById(playerId, page = 1, limit = 10) {
    if (!playerId) {
      throw new Error('Player ID is required');
    }

    const params = new URLSearchParams({
      page: String(Math.max(1, parseInt(page, 10) || 1)),
      limit: String(Math.max(1, parseInt(limit, 10) || 10))
    });

    return this.get(`/players/${encodeURIComponent(playerId)}/matches?${params.toString()}`);
  }

  /**
   * Get player by ID
   */
  async getPlayer(playerId) {
    return this.get(`/players/${playerId}`);
  }

  /**
   * Create a new player
   */
  async createPlayer(username, region = null) {
    return this.post('/players', { username, region });
  }

  /**
   * Add player (alias for createPlayer)
   */
  async addPlayer(username, region = null) {
    return this.createPlayer(username, region);
  }

  // ===== Queue Endpoints =====

  /**
   * Join queue
   */
  async joinQueue(gamemodeOrGamemodes, regionOrRegions, serverIP) {
    const gamemodes = Array.isArray(gamemodeOrGamemodes)
      ? gamemodeOrGamemodes
      : (gamemodeOrGamemodes ? [gamemodeOrGamemodes] : []);
    const regions = Array.isArray(regionOrRegions)
      ? regionOrRegions
      : (regionOrRegions ? [regionOrRegions] : []);

    return this.post('/queue/join', {
      gamemode: gamemodes[0] || null,
      region: regions[0] || null,
      gamemodes,
      regions,
      serverIP
    });
  }

  /**
   * Leave queue
   */
  async leaveQueue() {
    return this.post('/queue/leave', {});
  }

  /**
   * Get queue status
   */
  async getQueueStatus() {
    return this.get('/queue/status');
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    return this.get('/queue/stats');
  }

  // ===== Tier Tester Endpoints =====

  /**
   * Set tester availability
   */
  async setTesterAvailability(available, gamemodeOrGamemodes, regionOrRegions = null, serverIP = null) {
    const gamemodes = Array.isArray(gamemodeOrGamemodes)
      ? gamemodeOrGamemodes
      : (gamemodeOrGamemodes ? [gamemodeOrGamemodes] : []);
    const regions = Array.isArray(regionOrRegions)
      ? regionOrRegions
      : (regionOrRegions ? [regionOrRegions] : []);

    return this.post('/tester/availability', {
      available,
      gamemode: gamemodes[0] || null,
      region: regions[0] || null,
      gamemodes,
      regions,
      serverIP: serverIP || null
    });
  }

  /**
   * Get tester availability
   */
  async getTesterAvailability() {
    return this.get('/tester/availability');
  }

  /**
   * Get tester reputation metrics
   */
  async getTesterReputation() {
    return this.get('/tester/reputation');
  }

  // ===== Match Endpoints =====

  /**
   * Get active match for current user
   */
  async getActiveMatch() {
    return this.request('/match/active', { method: 'GET', noCache: true });
  }

  /**
   * Get match by ID
   */
  async getMatch(matchId) {
    return this.request(`/match/${matchId}`, { method: 'GET', noCache: true });
  }

  /**
   * Join match
   */
  async joinMatch(matchId) {
    const response = await this.post(`/match/${matchId}/join`);
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Update presence
   */
  async updatePresence(matchId, onPage) {
    const response = await this.post(`/match/${matchId}/presence`, { onPage });
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Update page stats
   */
  async updatePageStats(matchId, isPlayer) {
    const response = await this.post(`/match/${matchId}/pagestats`, { isPlayer });
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Send chat message
   */
  async sendChatMessage(matchId, message) {
    const response = await this.post(`/match/${matchId}/message`, { text: message });
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Get chat messages
   */
  async getChatMessages(matchId) {
    return this.request(`/match/${matchId}/messages`, { method: 'GET', noCache: true });
  }

  /**
   * Delete chat message
   */
  async deleteChatMessage(matchId, messageId) {
    const response = await this.delete(`/match/${matchId}/message/${messageId}`);
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Report a specific chat message
   */
  async reportChatMessage(matchId, messageId, payload = {}) {
    const response = await this.post(`/match/${matchId}/message/${messageId}/report`, {
      reason: payload.reason || 'chat_abuse',
      description: payload.description || '',
      evidenceLinks: Array.isArray(payload.evidenceLinks) ? payload.evidenceLinks : [],
      hasEvidence: payload.hasEvidence === true
    });
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Create a dispute for a match
   */
  async createMatchDispute(matchId, payload = {}) {
    return this.post(`/match/${matchId}/disputes`, {
      category: payload.category || 'general',
      summary: payload.summary || '',
      evidenceLinks: Array.isArray(payload.evidenceLinks) ? payload.evidenceLinks : []
    });
  }

  /**
   * Get disputes for a match
   */
  async getMatchDisputes(matchId) {
    return this.get(`/match/${matchId}/disputes`);
  }

  /**
   * Finalize match
   */
  async finalizeMatch(matchId, data) {
    const response = await this.post(`/match/${matchId}/finalize`, data);
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Mark match as started
   */
  async markMatchStarted(matchId) {
    const response = await this.post(`/match/${matchId}/started`);
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Abort match
   */
  async abortMatch(matchId) {
    const response = await this.post(`/match/${matchId}/abort`);
    this.clearMatchCache(matchId);
    return response;
  }

  /**
   * Vote to end match as draw (no scoring)
   */
  async voteDraw(matchId, agree = true) {
    const response = await this.post(`/match/${matchId}/draw-vote`, { agree: agree === true });
    this.clearMatchCache(matchId);
    return response;
  }

  // ===== Admin Endpoints =====

  /**
   * Get all applications
   */
  async getApplications() {
    return this.get('/admin/applications');
  }

  /**
   * Approve application
   */
  async approveApplication(applicationId) {
    return this.post(`/admin/applications/${applicationId}/approve`);
  }

  /**
   * Deny application
   */
  async denyApplication(applicationId) {
    return this.post(`/admin/applications/${applicationId}/deny`);
  }

  /**
   * Submit tier tester application
   */
  async submitTierTesterApplication(applicationData) {
    return this.post('/tier-tester/apply', applicationData);
  }

  /**
   * Public: Check whether Tier Tester applications are currently open
   */
  async getTierTesterApplicationsOpen() {
    return this.get('/tier-tester/applications-open');
  }

  /**
   * Admin: Toggle whether Tier Tester applications are open
   */
  async adminSetTierTesterApplicationsOpen(open) {
    return this.post('/admin/settings/tier-tester-applications', { open: open === true });
  }

  /**
   * Admin: Get current Tier Tester applications-open setting
   */
  async adminGetTierTesterApplicationsOpen() {
    return this.get('/admin/settings/tier-tester-applications');
  }

  /**
   * Get tier tester applications (Admin only)
   */
  async getTierTesterApplications() {
    return this.get('/admin/tier-tester-applications');
  }

  /**
   * Approve tier tester application (Admin only)
   */
  async approveTierTesterApplication(applicationId, reviewNotes) {
    return this.post(`/admin/tier-tester-applications/${applicationId}/approve`, { reviewNotes });
  }

  /**
   * Deny tier tester application (Admin only)
   */
  async denyTierTesterApplication(applicationId, reviewNotes) {
    return this.post(`/admin/tier-tester-applications/${applicationId}/deny`, { reviewNotes });
  }

  /**
   * Block user from tier tester applications (Admin only)
   */
  async blockTierTesterApplication(applicationId, reviewNotes) {
    return this.post(`/admin/tier-tester-applications/${applicationId}/block`, { reviewNotes });
  }

  /**
   * Get pending games
   */
  async getPendingGames() {
    return this.get('/admin/pending-games');
  }

  /**
   * Bulk action on pending games
   */
  async bulkActionPendingGames(action, gameIds) {
    return this.post('/admin/pending-games/bulk-action', {
      action,
      gameIds
    });
  }

  /**
   * Get blacklist
   */
  async getBlacklist(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
    });
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.get(`/admin/blacklist${suffix}`);
  }

  /**
   * Add to blacklist
   */
  async addToBlacklist(data) {
    return this.post('/admin/blacklist', data);
  }

  /**
   * Remove from blacklist
   */
  async removeFromBlacklist(blacklistId) {
    return this.delete(`/admin/blacklist/${blacklistId}`);
  }

  /**
   * Get all users
   */
  async getUsers(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
    });
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.get(`/admin/users${suffix}`);
  }

  /**
   * Set tier tester status
   */
  async setTesterStatus(userId, status) {
    return this.post(`/admin/users/${userId}/tester`, { status });
  }

  /**
   * Set admin status
   */
  async setAdminStatus(userId, status) {
    return this.post(`/admin/users/${userId}/admin`, { status });
  }

  /**
   * Admin: list staff roles
   */
  async getStaffRoles() {
    return this.get('/admin/staff-roles');
  }

  /**
   * Admin: create staff role
   */
  async createStaffRole(roleData) {
    return this.post('/admin/staff-roles', roleData || {});
  }

  /**
   * Admin: update staff role
   */
  async updateStaffRole(roleId, roleData) {
    return this.put(`/admin/staff-roles/${encodeURIComponent(roleId)}`, roleData || {});
  }

  /**
   * Admin: remove staff role
   */
  async deleteStaffRole(roleId) {
    return this.delete(`/admin/staff-roles/${encodeURIComponent(roleId)}`);
  }

  /**
   * Admin: assign or clear staff role for a user
   */
  async setUserStaffRole(userId, roleId = null) {
    return this.post(`/admin/users/${encodeURIComponent(userId)}/staff-role`, { roleId });
  }

  /**
   * Admin: assign built-in moderator roles for a user
   */
  async setUserBuiltinStaffRoles(userId, roleIds = []) {
    return this.post(`/admin/users/${encodeURIComponent(userId)}/builtin-staff-roles`, {
      roleIds: Array.isArray(roleIds) ? roleIds : []
    });
  }

  /**
   * Force set rating for a player
   */
  async setPlayerRating(playerId, gamemode, rating) {
    return this.post(`/admin/players/${playerId}/rating`, { gamemode, rating });
  }

  /**
   * Admin: manage player (bulk actions)
   */
  async adminManagePlayer(playerId, action, payload = {}) {
    return this.post(`/admin/players/${playerId}/manage`, { action, payload });
  }

  /**
   * Admin: Manage user actions
   */
  async adminManageUser(userId, action, payload = {}) {
    return this.post(`/admin/users/${userId}/manage`, { action, ...payload });
  }

  /**
   * Admin: set per-user feature restrictions
   */
  async adminSetUserRestrictions(userId, restrictions = {}, durationHours = 0, reason = '') {
    return this.post(`/admin/users/${userId}/restrictions`, { restrictions, durationHours, reason });
  }

  /**
   * Admin: get warnings/blacklist/restrictions/audit history for one user
   */
  async adminGetUserModerationHistory(userId) {
    return this.get(`/admin/users/${userId}/moderation-history`);
  }

  /**
   * Verify Minecraft username via Mojang API
   */
  async verifyMinecraftUsername(username) {
    return this.post('/auth/verify-minecraft-username', { username });
  }

  /**
   * Admin: unlink minecraft username from account and optionally wipe player data
   */
  async adminUnlinkMinecraft(userId, wipePlayer = true) {
    return this.post(`/admin/users/${userId}/unlink-minecraft`, { wipePlayer: wipePlayer === true });
  }

  /**
   * Force link username to account (admin only)
   */
  async forceAuth(userId, username) {
    return this.post('/admin/players/force-auth', { userId, username });
  }

  /**
   * Force unlink username but keep ratings (admin only)
   */
  async forceAuthUnlink(userId) {
    return this.post('/admin/players/force-auth-unlink', { userId });
  }

  /**
   * Force create match between tester and player (admin only)
   */
  async forceTest(testerUserId, playerUserId, gamemode, region = 'NA', serverIP = '') {
    return this.post('/admin/players/force-test', { testerUserId, playerUserId, gamemode, region, serverIP });
  }

  /**
   * Transfer ratings from one player to another (admin only)
   */
  async ratingTransfer(fromPlayerId, toPlayerId) {
    return this.post('/admin/players/rating-transfer', { fromPlayerId, toPlayerId });
  }

  /**
   * Wipe all ratings from a player (admin only)
   */
  async ratingWipe(playerId) {
    return this.post('/admin/players/rating-wipe', { playerId });
  }

  /**
   * Reset cooldown for a player (admin only)
   */
  async resetCooldown(username, gamemode = null) {
    return this.post('/admin/reset-cooldown', { username, gamemode });
  }

  // ===== Onboarding Endpoints =====


  /**
   * Save onboarding preferences (gamemodes and skill level)
   */
  async saveOnboardingPreferences(selectedGamemodes, gamemodeSkillLevels) {
    return this.post('/onboarding/save-preferences', { selectedGamemodes, gamemodeSkillLevels });
  }

  /**
   * Update skill levels (with locking protection)
   */
  async updateSkillLevels(gamemodeRatings) {
    return this.post('/account/update-skill-levels', { gamemodeRatings });
  }

  /**
   * Get onboarding status
   */
  async getOnboardingStatus() {
    return this.get('/onboarding/status');
  }

  /**
   * Update player region
   */
  async updatePlayerRegion(username, region) {
    return this.post('/players/update-region', { username, region });
  }

  /**
   * Complete onboarding
   */
  async completeOnboarding() {
    return this.post('/onboarding/complete');
  }

  // ===== Account Management Endpoints =====

  /**
   * Reload account badges
   */
  async reloadAccountBadges() {
    return this.post('/account/reload-badges', {});
  }

  /**
   * Reload account tiers
   */
  async reloadAccountTiers() {
    return this.post('/account/reload-tiers', {});
  }

  // ===== Plus Membership Endpoints =====

  /**
   * Create a Plus purchase/gift request (admin will approve)
   */
  async createPlusRequest({ giftUsername = null, years = 1 } = {}) {
    return this.post('/plus/requests', { giftUsername, years });
  }

  /**
   * Save Plus preferences (show badge + gradient settings)
   */
  async savePlusPreferences(preferences = {}) {
    return this.post('/plus/preferences', preferences);
  }

  /**
   * Sync Plus perks to player record (badge/gradient visible on leaderboard & popup)
   */
  async syncPlusToPlayer() {
    return this.post('/plus/sync', {});
  }

  /**
   * Redeem a 6-digit Plus purchase code
   */
  async redeemPlusCode(code) {
    return this.post('/plus/redeem-code', { code });
  }

  /**
   * Easter Egg: get current progression
   */
  async getEasterEggState() {
    return this.get('/easter-egg/state');
  }

  /**
   * Easter Egg: submit answer for the active step
   */
  async solveEasterEggStep(stepId, answer) {
    return this.post('/easter-egg/solve', { stepId, answer });
  }

  /**
   * Easter Egg: claim final reward code
   */
  async claimEasterEggReward() {
    return this.post('/easter-egg/claim-reward', {});
  }

  /**
   * Admin: grant Plus to a userId
   */
  async adminGrantPlus(userId, years = 1) {
    return this.post('/admin/plus/grant', { userId, years });
  }

  /**
   * Admin: cancel Plus for a userId
   */
  async adminCancelPlus(userId) {
    return this.post('/admin/plus/cancel', { userId });
  }

  /**
   * Admin: block/unblock Plus for a userId
   */
  async adminSetPlusBlocked(userId, blocked, reason = '') {
    return this.post('/admin/plus/block', { userId, blocked: blocked === true, reason });
  }

  /**
   * Admin: list Plus purchase codes
   */
  async adminListPlusCodes(includeRemoved = false) {
    const suffix = includeRemoved ? '?includeRemoved=true' : '';
    return this.get(`/admin/plus/codes${suffix}`);
  }

  /**
   * Admin: create Plus purchase code
   */
  async adminCreatePlusCode({ code = null, years = 1, assignedUserId = null, note = '' } = {}) {
    return this.post('/admin/plus/codes', { code, years, assignedUserId, note });
  }

  /**
   * Admin: remove Plus purchase code
   */
  async adminRemovePlusCode(code) {
    const safeCode = encodeURIComponent(String(code || '').trim());
    return this.request(`/admin/plus/codes/${safeCode}`, { method: 'DELETE' });
  }

  /**
   * Set gamemode retirement status
   */
  async setGamemodeRetirement(gamemode, retired) {
    return this.post('/account/set-gamemode-retirement', { gamemode, retired });
  }

  /**
   * Create support ticket (one active ticket allowed per user)
   */
  async submitSupportTicket(data) {
    return this.post('/support/tickets', data);
  }

  /**
   * Submit signed-out support request
   */
  async submitGuestSupportTicket(data) {
    return this.post('/support/guest-ticket', data);
  }

  /**
   * Get current user's active support ticket and recent history
   */
  async getMySupportTicket() {
    return this.get('/support/tickets/me');
  }

  /**
   * Reply to own support ticket
   */
  async replySupportTicket(ticketId, message) {
    return this.post(`/support/tickets/${ticketId}/messages`, { message });
  }

  /**
   * Close own support ticket
   */
  async closeSupportTicket(ticketId) {
    return this.post(`/support/tickets/${ticketId}/close`, {});
  }

  async getModeratorChatReports(playerFilter = '', statusFilter = '') {
    return this.get(`/moderation/chat-reports?player=${encodeURIComponent(playerFilter || '')}&status=${encodeURIComponent(statusFilter || '')}`);
  }

  async setModeratorChatRestriction({ targetUserId = '', targetUsername = '', active = true, durationHours = 24, reason = '' } = {}) {
    return this.post('/moderation/chat-restrictions', {
      targetUserId,
      targetUsername,
      active: active === true,
      durationHours,
      reason
    });
  }

  async getLeaderboardFilters() {
    return this.get('/moderation/leaderboard-filters');
  }

  async saveLeaderboardFilter({ targetUserId = '', targetUsername = '', globalHidden = false, gamemodes = [], reason = '' } = {}) {
    return this.post('/moderation/leaderboard-filters', {
      targetUserId,
      targetUsername,
      globalHidden: globalHidden === true,
      gamemodes: Array.isArray(gamemodes) ? gamemodes : [],
      reason
    });
  }

  async removeLeaderboardFilter(userId) {
    return this.request(`/moderation/leaderboard-filters/${encodeURIComponent(String(userId || '').trim())}`, {
      method: 'DELETE'
    });
  }

  async contactAdmins(message) {
    return this.post('/moderation/admin-contact', { message });
  }

  async adminGetModeratorRequests(status = 'open') {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    return this.get(`/admin/moderator-requests?${params.toString()}`);
  }

  async adminUpdateModeratorRequestStatus(requestId, status) {
    return this.post(`/admin/moderator-requests/${encodeURIComponent(String(requestId || '').trim())}/status`, { status });
  }

  /**
   * Admin: list support tickets
   */
  async adminGetSupportTickets(status = 'active', limit = 100) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    return this.get(`/admin/support/tickets?${params.toString()}`);
  }

  /**
   * Admin: get support ticket details
   */
  async adminGetSupportTicket(ticketId) {
    return this.get(`/admin/support/tickets/${ticketId}`);
  }

  /**
   * Admin: send support ticket reply
   */
  async adminReplySupportTicket(ticketId, message) {
    return this.post(`/admin/support/tickets/${ticketId}/messages`, { message });
  }

  /**
   * Admin: update support ticket status
   */
  async adminUpdateSupportTicketStatus(ticketId, status) {
    return this.post(`/admin/support/tickets/${ticketId}/status`, { status });
  }

  /**
   * Update player roles (admin only)
   */
  async updatePlayerRoles(playerId, admin, tester) {
    return this.post(`/admin/players/${playerId}/roles`, { admin, tester });
  }

  /**
   * Ban account
   */
  async banAccount(identifier, duration, reason) {
    return this.post('/admin/ban', { identifier, duration, reason });
  }

  /**
   * Unban account
   */
  async unbanAccount(firebaseUid) {
    return this.post(`/admin/unban/${firebaseUid}`);
  }

  /**
   * Get all banned accounts
   */
  async getBannedAccounts() {
    return this.get('/admin/banned');
  }

  /**
   * Search banned accounts
   */
  async searchBannedAccounts(searchTerm) {
    return this.get(`/admin/banned/search?q=${encodeURIComponent(searchTerm)}`);
  }

  /**
   * Search blacklist
   */
  async searchBlacklist(searchTerm, params = {}) {
    const query = new URLSearchParams({ q: searchTerm });
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
    });
    return this.get(`/admin/blacklist/search?${query.toString()}`);
  }

  /**
   * Search users
   */
  async searchUsers(searchTerm, params = {}) {
    const query = new URLSearchParams({ q: searchTerm });
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
    });
    return this.get(`/admin/users/search?${query.toString()}`);
  }

  /**
   * Search players
   */
  async searchPlayers(searchTerm, params = {}) {
    const query = new URLSearchParams({ q: searchTerm });
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
    });
    return this.get(`/admin/players/search?${query.toString()}`);
  }

  // ===== User Cooldowns =====

  /**
   * Get user's active cooldowns
   */
  async getUserCooldowns() {
    return this.get('/user/cooldowns');
  }

  // ===== Ban & Warning System =====

  /**
   * Check if an email is banned before login
   */
  async checkBanStatus(email) {
    return this.post('/auth/check-ban', { email });
  }

  /**
   * Acknowledge a warning
   */
  async acknowledgeWarning(warningId) {
    return this.post('/auth/acknowledge-warning', { warningId });
  }

  /**
   * Issue a warning to a user (admin only)
   */
  async warnUser(userId, reason) {
    return this.post('/admin/warn', { userId, reason });
  }

  /**
   * Get admin audit log (admin only)
   */
  async getAuditLog(params = {}) {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value) queryParams.append(key, value);
    });
    return this.get(`/admin/audit-log?${queryParams}`);
  }

  /**
   * Get per-gamemode dashboard stats (authenticated, cached server-side)
   */
  async getDashboardGamemodeStats(region = '') {
    const params = region ? `?region=${encodeURIComponent(region)}` : '';
    return this.get(`/dashboard/gamemode-stats${params}`);
  }

  /**
   * Check ban status for email before login
   */
  async checkBanStatus(email) {
    return this.post('/auth/check-ban', { email });
  }

  /**
   * Acknowledge a warning
   */
  async acknowledgeWarning(warningId) {
    return this.post('/auth/acknowledge-warning', { warningId });
  }

  /**
   * Get reported accounts
   */
  async getReportedAccounts() {
    return this.get('/admin/alt-reports');
  }

  /**
   * Search reported accounts
   */
  async searchReportedAccounts(searchTerm) {
    return this.get(`/admin/alt-reports/search?q=${encodeURIComponent(searchTerm)}`);
  }

  /**
   * Get security logs
   */
  async getSecurityLogs(limit = 100, severity = null, type = null, userId = null) {
    let url = `/admin/security-logs?limit=${limit}`;
    if (severity) url += `&severity=${encodeURIComponent(severity)}`;
    if (type) url += `&type=${encodeURIComponent(type)}`;
    if (userId) url += `&userId=${encodeURIComponent(userId)}`;
    return this.get(url);
  }

  /**
   * Move report to judgment day
   */
  async moveToJudgmentDay(reportId) {
    return this.post(`/admin/alt-reports/${reportId}/judgment-day`);
  }

  /**
   * Remove alt report
   */
  async removeAltReport(reportId) {
    return this.delete(`/admin/alt-reports/${reportId}`);
  }

  /**
   * Get judgment day accounts
   */
  async getJudgmentDayAccounts() {
    return this.get('/admin/judgment-day');
  }

  /**
   * Execute judgment day
   */
  async executeJudgmentDay() {
    return this.post('/admin/judgment-day/execute');
  }

  /**
   * Get Ban Waves
   */
  async getBanWaves() {
    return this.get('/admin/ban-waves');
  }

  /**
   * Create Ban Wave
   */
  async createBanWave(data) {
    return this.post('/admin/ban-waves', data);
  }

  /**
   * Update Ban Wave
   */
  async updateBanWave(waveId, data) {
    return this.put(`/admin/ban-waves/${waveId}`, data);
  }

  /**
   * Delete Ban Wave
   */
  async deleteBanWave(waveId) {
    return this.delete(`/admin/ban-waves/${waveId}`);
  }

  /**
   * Execute Ban Wave
   */
  async executeBanWave(waveId) {
    return this.post(`/admin/ban-waves/${waveId}/execute`);
  }

  /**
   * Add to alt whitelist
   */
  async addToAltWhitelist(identifier, type = null) {
    return this.post('/admin/alt-whitelist', { identifier, type });
  }

  /**
   * Remove from alt whitelist
   */
  async removeFromAltWhitelist(firebaseUid) {
    return this.delete(`/admin/alt-whitelist/${firebaseUid}`);
  }

  /**
   * Get alt whitelist
   */
  async getAltWhitelist() {
    return this.get('/admin/alt-whitelist');
  }

  /**
   * Remove security log
   */
  async removeSecurityLog(logId) {
    return this.delete(`/admin/security-logs/${logId}`);
  }

  /**
   * Get admin matches with filters
   */
  async getAdminMatches(status = null, gamemode = null, search = null, limit = 100) {
    let url = `/admin/matches?limit=${limit}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    if (gamemode) url += `&gamemode=${encodeURIComponent(gamemode)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    return this.get(url);
  }

  /**
   * Get admin match timeline
   */
  async getAdminMatchTimeline(matchId) {
    return this.get(`/admin/matches/${encodeURIComponent(matchId)}/timeline`);
  }

  /**
   * Inspect two queued users for compatibility
   */
  async inspectQueuePair(leftUserId, rightUserId) {
    return this.get(`/admin/queue-inspector?leftUserId=${encodeURIComponent(leftUserId)}&rightUserId=${encodeURIComponent(rightUserId)}`);
  }

  /**
   * Get admin disputes with optional filters
   */
  async getAdminDisputes(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.matchId) params.append('matchId', filters.matchId);
    if (filters.userId) params.append('userId', filters.userId);
    const query = params.toString();
    return this.get(`/admin/disputes${query ? `?${query}` : ''}`);
  }

  /**
   * Update admin dispute status
   */
  async updateAdminDisputeStatus(disputeId, status, note = '') {
    return this.post(`/admin/disputes/${encodeURIComponent(disputeId)}/status`, { status, note });
  }

  /**
   * Delete admin match
   */
  async deleteAdminMatch(matchId) {
    return this.delete(`/admin/matches/${matchId}`);
  }

  /**
   * Admin finalize match
   */
  async adminFinalizeMatch(matchId, playerScore, testerScore) {
    return this.post(`/admin/matches/${matchId}/finalize`, { playerScore, testerScore });
  }

  /**
   * Admin revert match rating changes
   */
  async revertAdminMatch(matchId) {
    return this.post(`/admin/matches/${matchId}/revert`, {});
  }

  /**
   * Send test notification
   */
  async sendTestNotification(type, message) {
    return this.post('/notifications/test', { type, message });
  }

  /**
   * Get recent notifications for current user
   */
  async getNotifications(limit = 20, unreadOnly = true) {
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 50));
    try {
      return await this.get(`/notifications?limit=${safeLimit}&unreadOnly=${unreadOnly ? 'true' : 'false'}`);
    } catch (error) {
      if (error?.status === 404 || error?.code === 'NOT_FOUND') {
        return { success: true, notifications: [], total: 0, unavailable: true };
      }
      throw error;
    }
  }

  /**
   * Mark notification as read
   */
  async markNotificationRead(notificationId) {
    return this.post(`/notifications/${encodeURIComponent(notificationId)}/read`, {});
  }

  /**
   * Delete delivered notification
   */
  async deleteNotification(notificationId) {
    return this.delete(`/notifications/${encodeURIComponent(notificationId)}`);
  }

  /**
   * Get dashboard statistics
   */
  async getDashboardStats() {
    return this.get('/dashboard/stats');
  }

  // ===== Whitelisted Servers Endpoints =====

  /**
   * Get all whitelisted servers (public)
   */
  async getWhitelistedServers() {
    return this.get('/whitelisted-servers');
  }

  /**
   * Add a whitelisted server (admin only)
   */
  async addWhitelistedServer(name, ip) {
    return this.post('/admin/whitelisted-servers', { name, ip });
  }

  /**
   * Remove a whitelisted server (admin only)
   */
  async deleteWhitelistedServer(serverId) {
    return this.delete(`/admin/whitelisted-servers/${serverId}`);
  }

  /**
   * Submit a player report
   */
  async submitPlayerReport(reportData) {
    return this.post('/submit-player-report', {
      reportedPlayer: reportData.reportedPlayer,
      reportedUUID: reportData.reportedUUID || '',
      category: reportData.category,
      matchId: reportData.matchId || '',
      description: reportData.description,
      evidenceLinks: Array.isArray(reportData.evidenceLinks) ? reportData.evidenceLinks : [],
      hasEvidence: reportData.hasEvidence === true,
      reportedAt: reportData.reportedAt
    });
  }

  /**
   * Get recent reports submitted by current user
   */
  async getMyPlayerReports(limit = 5, options = {}) {
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 5, 500));
    const status = options?.status ? String(options.status).toLowerCase() : 'all';
    const includeConversation = options?.includeConversation === true;
    return this.get(`/reports/my?limit=${safeLimit}&status=${encodeURIComponent(status)}&includeConversation=${includeConversation ? 'true' : 'false'}`);
  }

  /**
   * Admin: Get no-show reports
   */
  async getNoshowReports(playerFilter, statusFilter) {
    return this.get(`/admin/reports/noshow?player=${encodeURIComponent(playerFilter || '')}&status=${statusFilter || ''}`);
  }

  /**
   * Admin: Get user reports
   */
  async getUserReports(playerFilter, categoryFilter, statusFilter) {
    return this.get(`/admin/reports/user?player=${encodeURIComponent(playerFilter || '')}&category=${categoryFilter || ''}&status=${statusFilter || ''}`);
  }

  /**
   * Admin: Get chat message reports
   */
  async getMessageReports(playerFilter, statusFilter) {
    return this.get(`/admin/reports/messages?player=${encodeURIComponent(playerFilter || '')}&status=${statusFilter || ''}`);
  }

  /**
   * Admin: Get user report details
   */
  async getUserReportDetails(reportId) {
    return this.get(`/admin/reports/user/${reportId}`);
  }

  /**
   * Admin: Resolve no-show report
   */
  async resolveNoshowReport(reportId, notes) {
    return this.post(`/admin/reports/noshow/${reportId}/resolve`, { notes });
  }

  /**
   * Admin: Resolve user report
   */
  async resolveUserReport(reportId, notes, action) {
    return this.post(`/admin/reports/user/${reportId}/resolve`, { notes, action });
  }

  /**
   * Admin: Whitelist account from security reports
   */
  async whitelistSecurityReports(userId) {
    return this.post('/admin/security/whitelist', { userId });
  }

  /**
   * Admin: Get security whitelist
   */
  async getSecurityWhitelist() {
    return this.get('/admin/security/whitelist');
  }

  /**
   * Admin: Remove from security whitelist
   */
  async removeSecurityWhitelist(accountId) {
    return this.delete(`/admin/security/whitelist/${accountId}`);
  }

  // ===== Inbox System =====

  /**
   * Get inbox messages for current user
   */
  async getInboxMessages() {
    return this.get('/inbox/messages');
  }

  /**
   * Get unread inbox message count
   */
  async getInboxUnreadCount() {
    return this.get('/inbox/unread-count');
  }

  /**
   * Mark an inbox message as read
   */
  async markInboxRead(messageId) {
    return this.post(`/inbox/messages/${messageId}/read`);
  }

  /**
   * Mark all inbox messages as read
   */
  async markAllInboxRead() {
    return this.post('/inbox/messages/read-all');
  }

  /**
   * Delete an inbox message
   */
  async deleteInboxMessage(messageId) {
    return this.delete(`/inbox/messages/${messageId}`);
  }

  // ===== Admin Inbox & Resolve =====

  /**
   * Admin: Send message to a user's inbox
   */
  async adminSendInboxMessage(data) {
    return this.post('/admin/inbox/send', data);
  }

  /**
   * Admin: Resolve match violation (revert ratings + blacklist + notify)
   */
  async resolveMatchViolation(data) {
    return this.post('/admin/resolve-violation', data);
  }

}

// Create singleton instance
const apiService = new ApiService();

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.apiService = apiService;
}
