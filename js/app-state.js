// MC Leaderboards - Application State Management

const AppState = {
  // Current user (Firebase user object)
  currentUser: null,

  // User profile (from database)
  userProfile: null,

  // Loading states
  loading: {
    auth: false,
    profile: false,
    players: false,
    match: false,
    api: false
  },

  // Current page context
  currentPage: null,

  // Active match (if any)
  activeMatch: null,

  // Queue status
  queueStatus: null,

  // Listeners for state changes
  listeners: {
    user: [],
    profile: [],
    match: []
  },

  /**
   * Set current user
   */
  setUser(user) {
    this.currentUser = user;
    this.notifyListeners('user', user);
  },

  /**
   * Set user profile
   */
  setProfile(profile) {
    this.userProfile = profile;
    this.notifyListeners('profile', profile);
  },

  /**
   * Set loading state
   */
  setLoading(key, value) {
    if (this.loading.hasOwnProperty(key)) {
      this.loading[key] = value;
    }
  },

  /**
   * Get user profile
   */
  getProfile() {
    return this.userProfile;
  },

  /**
   * Check if user is admin
   */
  isAdmin() {
    return this.userProfile?.admin === true
      || typeof this.userProfile?.adminRole === 'string'
      || typeof this.userProfile?.adminContext?.role === 'string';
  },

  /**
   * Check if user is tier tester
   */
  isTierTester() {
    return this.userProfile?.tester === true;
  },

  /**
   * Check if user has completed onboarding
   */
  isOnboardingCompleted() {
    return this.userProfile?.onboardingCompleted === true;
  },

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return this.currentUser !== null;
  },

  /**
   * Get current user ID
   */
  getUserId() {
    return this.currentUser?.uid || null;
  },

  /**
   * Set active match
   */
  setActiveMatch(match) {
    this.activeMatch = match;
    this.notifyListeners('match', match);
  },

  /**
   * Clear active match
   */
  clearActiveMatch() {
    this.activeMatch = null;
    this.notifyListeners('match', null);
  },

  /**
   * Set queue status
   */
  setQueueStatus(status) {
    this.queueStatus = status;
  },

  /**
   * Add listener for state changes
   */
  addListener(type, callback) {
    if (this.listeners[type]) {
      this.listeners[type].push(callback);
    }
  },

  /**
   * Remove listener
   */
  removeListener(type, callback) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
    }
  },

  /**
   * Notify listeners of state change
   */
  notifyListeners(type, data) {
    if (this.listeners[type]) {
      this.listeners[type].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('Error in state listener:', error);
        }
      });
    }
  },

  /**
   * Reset all state
   */
  reset() {
    this.currentUser = null;
    this.userProfile = null;
    this.activeMatch = null;
    this.queueStatus = null;
    this.loading = {
      auth: false,
      profile: false,
      players: false,
      match: false,
      api: false
    };
  }
};

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.AppState = AppState;
}

