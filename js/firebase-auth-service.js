// MC Leaderboards - Firebase Authentication Service

function formatAuthRateLimitRetryText(retryAtMs) {
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

function parseAuthRateLimitRetryAt(resp, data = {}) {
  if (data.resetAt) {
    const resetDate = new Date(data.resetAt);
    if (!Number.isNaN(resetDate.getTime())) {
      return resetDate.getTime();
    }
  }

  const rateLimitReset = resp.headers.get('RateLimit-Reset');
  if (rateLimitReset) {
    const resetSeconds = Number(rateLimitReset);
    if (!Number.isNaN(resetSeconds) && resetSeconds > 0) {
      return resetSeconds * 1000;
    }
  }

  const retryAfterHeader = resp.headers.get('Retry-After');
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Date.now() + retryAfterSeconds * 1000;
    }
  }

  return null;
}

const firebaseAuthService = {
  banStatusPollInterval: null,
  banStatusVisibilityHandler: null,
  banStatusEventSource: null,
		  _googleProvider: null,
		  _banStatusReconnectTimeout: null,
		  _backendSessionSync: null,
		  _backendSessionClear: null,
		  _backendSessionActive: false,
		  _handledSignedOutState: false,
		  _profileFetchPromise: null,
		  _profileFetchUserId: null,
		  _loginNoticeStorageKey: 'mclb_login_notice',

  setProfileBootstrapPending(isPending) {
    if (typeof window !== 'undefined') {
      window.__mclbProfileBootstrapPending = isPending === true;
    }
  },

  isProfileBootstrapPending() {
    return typeof window !== 'undefined' && window.__mclbProfileBootstrapPending === true;
  },

  shouldInvalidateClientSession(error) {
    const code = String(error?.code || '');
    return error?.status === 401
      || error?.status === 403
      || ['EMAIL_VERIFICATION_REQUIRED_FOR_LOGIN', 'ACCOUNT_BANNED', 'AUTH_INVALID'].includes(code);
  },

  /**
   * Initialize auth state listener
   */
  async init() {
    // Wait for Firebase to be ready using the firebase-service
    if (typeof waitForFirebaseInit !== 'undefined') {
      const initialized = await waitForFirebaseInit();
      if (!initialized) {
        console.warn('Firebase auth init skipped because Firebase SDK is unavailable.');
        return;
      }
    } else {
      // Fallback: Wait for Firebase to be ready
    if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
      console.log('Firebase not initialized, retrying in 100ms...');
      setTimeout(() => this.init(), 100);
      return;
      }
    }

    const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();

    // Listen for ID token changes (including refreshes)
    // This fires when tokens are available/updated
			    auth.onIdTokenChanged(async (user) => {
				      if (user) {
				        this._handledSignedOutState = false;
				        try {
				          const token = await user.getIdToken(false);
				          apiService.setToken(token);
			          this.syncBackendSession(token).catch((sessionError) => {
			            console.warn('Backend session sync failed during auth change:', sessionError);
			          });

		          const shouldFetchProfile = !AppState.currentUser
		            || AppState.currentUser.uid !== user.uid
		            || !AppState.getProfile();
	          AppState.setUser(user);

	          // Signup registration may still be writing the backend profile.
	          if (this.isProfileBootstrapPending()) {
	            return;
	          }

		          if (shouldFetchProfile) {
		            await this.fetchUserProfile(user.uid, { forceProfileRefresh: false });
		          }
		        } catch (error) {
		          console.error('Error getting ID token:', error);
              if (this.shouldInvalidateClientSession(error)) {
                await this.forceLogout({
                  redirectTo: '/login.html',
                  notice: {
                    icon: 'error',
                    title: 'Session Ended',
                    text: 'We could not load your account access. Please sign in again.'
                  }
                });
                return;
              }
		          apiService.setToken(null);
		        }
	      } else {
	        await this.handleSignedOutState();
	      }
	    });

	    // Listen for auth state changes (for logout handling)
	    auth.onAuthStateChanged(async (user) => {
	      if (!user) {
	        await this.handleSignedOutState();
	      }
	      // Profile fetching moved to onIdTokenChanged to ensure token is available
	    });
	  },

	  async handleSignedOutState({ forceSessionClear = false } = {}) {
	    AppState.setUser(null);
	    AppState.setProfile(null);
	    apiService.setToken(null);

	    if (!forceSessionClear && this._handledSignedOutState) {
	      this.stopBanStatusPolling();
	      return;
	    }

	    this._handledSignedOutState = true;
	    await this.clearBackendSession({ force: forceSessionClear });
	    this.stopBanStatusPolling();
	  },

  /**
   * Fetch user profile from database
   */
  async fetchUserProfile(userId, options = {}) {
    const context = await this.loadCurrentAccountContext({
      user: userId ? { uid: userId } : null,
      forceProfileRefresh: options.forceProfileRefresh !== false,
      requireProfile: options.requireProfile !== false,
      reloadUser: options.reloadUser === true
    });

    return context.profile;
  },

  async loadCurrentAccountContext({
    user = null,
    forceProfileRefresh = false,
    requireProfile = true,
    reloadUser = false
  } = {}) {
    const auth = this.getAuthInstance();
    let activeUser = user;
    const liveUser = auth.currentUser || AppState.currentUser || null;

    if (liveUser && (!activeUser || !activeUser.uid || activeUser.uid === liveUser.uid)) {
      activeUser = liveUser;
    }

    if (!activeUser || !activeUser.uid) {
      activeUser = liveUser;
    }

    if (!activeUser || !activeUser.uid) {
      throw new Error('Not signed in');
    }

    if (reloadUser && typeof activeUser.reload === 'function') {
      await activeUser.reload();
      activeUser = auth.currentUser || activeUser;
    }

    AppState.setUser(activeUser);

    const canReuseProfile = !forceProfileRefresh
      && AppState.currentUser?.uid === activeUser.uid
      && AppState.getProfile();
    if (canReuseProfile) {
      return { user: activeUser, profile: AppState.getProfile() };
    }

    if (!forceProfileRefresh && this._profileFetchPromise && this._profileFetchUserId === activeUser.uid) {
      const profile = await this._profileFetchPromise;
      return { user: activeUser, profile };
    }

    const profilePromise = (async () => {
      try {
        AppState.setLoading('profile', true);
        await this.ensureApiTokenReady(activeUser, { forceRefresh: false });
        const profile = await apiService.getProfile();

        AppState.setProfile(profile);
        this.startBanStatusPolling(activeUser.uid);

        return profile;
      } catch (error) {
        console.error('Error fetching profile:', error);
        if (!requireProfile && (error?.status === 404 || String(error?.message || '').toLowerCase().includes('not found'))) {
          return null;
        }
        if (requireProfile && this.shouldInvalidateClientSession(error)) {
          try {
            await this.signOut();
          } catch (signOutError) {
            console.warn('Failed to clear invalid client session after profile fetch error:', signOutError);
          }
        }
        throw error;
      } finally {
        AppState.setLoading('profile', false);
      }
    })();

    this._profileFetchPromise = profilePromise;
    this._profileFetchUserId = activeUser.uid;

    try {
      const profile = await profilePromise;
      return { user: activeUser, profile };
    } finally {
      if (this._profileFetchPromise === profilePromise) {
        this._profileFetchPromise = null;
        this._profileFetchUserId = null;
      }
    }
  },

  /**
   * Create user profile
   */
  async createUserProfile(userId) {
    try {
      const user = this.getCurrentUser();
      if (!user || user.uid !== userId) {
        throw new Error('No matching signed-in user for profile creation');
      }

      await this.ensureApiTokenReady(user, { forceRefresh: false });
      await apiService.updateProfile({
        onboardingCompleted: false,
        stayInQueueAfterMatch: false,
        securitySettings: {
          requireVerifiedEmailForSensitiveActions: false,
          requireVerifiedEmailForLogin: false
        }
      });

      const profile = await apiService.getProfileQuick();
      AppState.setProfile(profile);
      this.startBanStatusPolling(userId);
    } catch (error) {
      console.error('Error creating profile:', error);
      throw error;
    }
  },

  getPostAuthRedirect(profile = null) {
    const resolvedProfile = profile || AppState.getProfile() || null;
    return resolvedProfile?.onboardingCompleted === true
      ? 'dashboard.html'
      : 'onboarding.html';
  },

  async completeLoginSession({
    user = null,
    clientIP = null,
    requireProfile = false
  } = {}) {
    const activeUser = user || this.getCurrentUser();
    if (!activeUser) {
      throw new Error('Not signed in');
    }

    AppState.setUser(activeUser);
    await this.ensureApiTokenReady(activeUser, { forceRefresh: false });

    const payload = {};
    if (clientIP) {
      payload.clientIP = clientIP;
    }

    let result;
    try {
      result = await apiService.post('/auth/login', payload);
    } catch (error) {
      const shouldRollbackAuth = this.shouldInvalidateClientSession(error);

      if (shouldRollbackAuth) {
        try {
          await this.signOut();
        } catch (signOutError) {
          console.warn('Failed to roll back partial login state:', signOutError);
        }
      } else {
        AppState.setProfile(null);
      }

      throw this.handleAuthError(error);
    }

    this.startBanStatusPolling(activeUser.uid);
    apiService.clearCache('/users/me');

    let mergedProfile = AppState.getProfile();
    if (result?.account && typeof result.account === 'object') {
      mergedProfile = {
        ...(mergedProfile || {}),
        ...result.account
      };
      AppState.setProfile(mergedProfile);
    }

    if (requireProfile) {
      const context = await this.loadCurrentAccountContext({
        user: activeUser,
        forceProfileRefresh: true,
        requireProfile: true
      });
      mergedProfile = context.profile;
    }

    return {
      ...result,
      profile: mergedProfile || null,
      redirectTo: result?.redirectTo || this.getPostAuthRedirect(mergedProfile)
    };
  },

  /**
   * Sign up with email and password
   */
  async signUp(email, password) {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase not initialized');
      }
      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const userCredential = await auth.createUserWithEmailAndPassword(email, password);

      if (!userCredential || !userCredential.user) {
        throw new Error('Firebase signup failed: invalid response');
      }

      if (!userCredential.user.uid) {
        throw new Error('Firebase signup failed: no UID returned');
      }

      await this.sendEmailVerification({ user: userCredential.user, mode: 'signup' });

      return userCredential.user;
    } catch (error) {
      console.error('Sign up error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Sign in with email and password
   */
  async signIn(email, password) {
    try {
      // First check if email is banned before attempting Firebase auth
      const banCheck = await apiService.checkBanStatus(email);

      if (banCheck.banned) {
        await this.showBanPopup({
          banReason: banCheck.reason,
          bannedAt: banCheck.bannedAt || null,
          banDuration: banCheck.timeRemainingText || (banCheck.isPermanent ? 'Permanent' : 'Unknown'),
          timeRemaining: banCheck.timeRemaining,
          isPermanent: banCheck.isPermanent,
          type: 'Banned'
        });
        const bannedError = new Error('Account is banned');
        bannedError.code = 'ACCOUNT_BANNED';
        bannedError.data = banCheck;
        bannedError.alreadyPresented = true;
        throw bannedError;
      }

      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const userCredential = await auth.signInWithEmailAndPassword(email, password);
      return userCredential.user;
    } catch (error) {
      console.error('Sign in error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Get (singleton) Google Auth provider
   */
  getGoogleProvider() {
    if (this._googleProvider) return this._googleProvider;
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase not initialized');
    }
    this._googleProvider = new firebase.auth.GoogleAuthProvider();
    // Keep it minimal to avoid extra consent prompts.
    this._googleProvider.setCustomParameters({ prompt: 'select_account' });
    return this._googleProvider;
  },

  /**
   * Ensure apiService has a current Firebase ID token (forces refresh optionally)
   */
  async ensureFreshIdToken(forceRefresh = false) {
    const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
    const user = auth.currentUser;
    if (!user) {
      throw new Error('Not signed in');
    }
    const token = await user.getIdToken(forceRefresh === true);
    apiService.setToken(token);
    return token;
  },

	  getEmailActionSettings(mode = 'default') {
	    const origin = window.location.origin;
	    const url = mode === 'signin'
	      ? `${origin}/login.html?emailVerified=1`
	      : `${origin}/account.html?emailVerified=1`;

	    return {
	      url,
	      handleCodeInApp: false
	    };
	  },

  getPasswordResetActionSettings(email = '') {
    const origin = window.location.origin;
    const encodedEmail = email ? `?email=${encodeURIComponent(email)}` : '';

    return {
      url: `${origin}/login.html${encodedEmail}`,
      handleCodeInApp: false
    };
  },

  getAuthInstance() {
    if (typeof getAuth === 'function') {
      return getAuth();
    }

    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
      return firebase.auth();
    }

    throw new Error('Firebase auth is not initialized');
  },

  getCurrentUser() {
    try {
      return this.getAuthInstance().currentUser || null;
    } catch (_) {
      return null;
    }
  },

  async ensureApiTokenReady(preferredUser = null, {
    forceRefresh = false,
    maxAttempts = 20,
    intervalMs = 75
  } = {}) {
    if (preferredUser && typeof preferredUser.getIdToken === 'function') {
      const token = await preferredUser.getIdToken(forceRefresh === true);
      apiService.setToken(token);
      return token;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const currentUser = this.getCurrentUser();
      if (currentUser && typeof currentUser.getIdToken === 'function') {
        const token = await currentUser.getIdToken(forceRefresh === true && attempt > 0);
        apiService.setToken(token);
        return token;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Authentication token was not ready in time. Please try again.');
  },

  async syncBackendSession(idToken = null) {
    try {
      const token = idToken || apiService.getToken() || await this.ensureFreshIdToken(false);
      if (!token) return;

      if (!this._backendSessionSync) {
        this._backendSessionSync = fetch('/api/auth/session', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          },
          credentials: 'same-origin'
        });
      }

      const response = await this._backendSessionSync;
      if (!response?.ok) {
        this._backendSessionActive = false;
        console.warn('Backend session sync returned non-OK status:', response.status);
        return;
      }

      this._backendSessionActive = true;
    } catch (error) {
      this._backendSessionActive = false;
      console.warn('Backend session sync failed:', error);
    } finally {
      this._backendSessionSync = null;
    }
  },

  async clearBackendSession({ force = false } = {}) {
    try {
      if (!force && !this._backendSessionActive) {
        return;
      }

      if (!this._backendSessionClear) {
        this._backendSessionClear = fetch('/api/auth/session', {
          method: 'DELETE',
          credentials: 'same-origin'
        }).finally(() => {
          this._backendSessionClear = null;
        });
      }

      await this._backendSessionClear;
      this._backendSessionActive = false;
    } catch (error) {
      console.warn('Backend session clear failed:', error);
      this._backendSessionClear = null;
    }
  },

  async reloadCurrentUser({ forceTokenRefresh = true, syncSession = true } = {}) {
    const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
    const user = auth.currentUser;
    if (!user) return null;

    await user.reload();
    if (forceTokenRefresh) {
      await this.ensureFreshIdToken(true);
    } else {
      await this.ensureApiTokenReady(auth.currentUser || user, { forceRefresh: false });
    }
    if (syncSession) {
      await this.syncBackendSession(apiService.getToken());
    }
    AppState.setUser(auth.currentUser || user);
    return auth.currentUser || user;
  },

  async sendEmailVerification({ user = null, mode = 'default' } = {}) {
    try {
      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const targetUser = user || auth.currentUser;
      if (!targetUser) {
        throw new Error('No signed-in user to verify.');
      }

      await targetUser.sendEmailVerification(this.getEmailActionSettings(mode));
      return true;
    } catch (error) {
      console.error('Send email verification error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Sign in with Google (for existing accounts)
   * - Blocks if the email already belongs to a password account that is not linked to Google.
   * - Ensures backend login tracking runs (alt detection, IP tracking, ban checks).
   */
  async signInWithGoogle({ clientIP = null } = {}) {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase not initialized');
      }

      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const provider = this.getGoogleProvider();

      const userCredential = await auth.signInWithPopup(provider);
      const user = userCredential?.user;
      if (!user) throw new Error('Google sign-in failed');

      // Prime the API layer immediately instead of waiting for auth listeners.
      await this.ensureApiTokenReady(user, { forceRefresh: false });

      // Complete the backend session after Firebase auth succeeds.
      return await this.completeLoginSession({ user, clientIP });

    } catch (error) {
      console.error('Google sign-in error:', error);
      if (error?.status === 404 && (error.code === 'USER_NOT_FOUND' || error.code === 'NOT_FOUND')) {
        try {
          await this.signOut();
        } catch (_) {}

        const missingAccountError = new Error('No account found for this Google email.');
        missingAccountError.code = 'mclb/google-user-not-registered';
        missingAccountError.userMessage = 'No account found for this Google email.';
        missingAccountError.suggestion = 'Please use "Sign up with Google" to create your account first.';
        missingAccountError.action = 'go_to_google_signup';
        throw this.handleAuthError(missingAccountError);
      }
      throw this.handleAuthError(error);
    }
  },

  /**
   * Sign up with Google (new accounts) - requires age verification BEFORE registration.
   * This mirrors the email signup behavior by calling /api/auth/register with age.
   */
  async signUpWithGoogle({ age, clientIP = null } = {}) {
    try {
      if (!age || typeof age !== 'number' || age < 13) {
        const err = new Error('You must be at least 13 years old to create an account.');
        err.code = 'AGE_VERIFICATION_FAILED';
        throw err;
      }
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase not initialized');
      }

      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const provider = this.getGoogleProvider();

      const userCredential = await auth.signInWithPopup(provider);
      const user = userCredential?.user;
      if (!user) throw new Error('Google sign-up failed');

      await this.ensureApiTokenReady(user, { forceRefresh: false });

      const token = apiService.getToken();
      const email = user.email || '';
      const firebaseUid = user.uid;
      const recaptchaAction = 'post_auth_register';
      const recaptchaToken = await apiService.getRecaptchaToken(recaptchaAction);

      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Recaptcha-Token': recaptchaToken,
          'X-Recaptcha-Action': recaptchaAction
        },
        body: JSON.stringify({
          email,
          firebaseUid,
          minecraftUsername: null,
          ...(clientIP ? { clientIP } : {}),
          age
        })
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // If registration fails, try to remove the Firebase user to avoid orphaned accounts
        try {
          if (auth.currentUser && auth.currentUser.uid === firebaseUid) {
            await auth.currentUser.delete();
          }
        } catch (deleteErr) {
          console.warn('Failed to delete Firebase user after failed Google registration:', deleteErr);
        }

        const backendError = new Error(data.message || 'Registration failed');
        backendError.code = data.code || 'SERVER_ERROR';
        backendError.response = data;
        throw backendError;
      }

      return user;
    } catch (error) {
      console.error('Google sign-up error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Link Google provider to the currently signed-in account.
   * Used from account settings.
   */
  async linkGoogleAccount() {
    try {
      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');
      const provider = this.getGoogleProvider();
      const result = await user.linkWithPopup(provider);
      await this.ensureFreshIdToken(true);
      return result;
    } catch (error) {
      console.error('Link Google account error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Start secure backend polling for ban status changes.
   */
  /**
   * Connect to real-time ban/blacklist status stream using Server-Sent Events
   */
  startBanStatusPolling(userId) {
    if (!userId) {
      return;
    }

    this.stopBanStatusPolling();

    const fallbackToPolling = () => {
      if (this.banStatusPollInterval) {
        return;
      }

      this.banStatusPollInterval = setInterval(async () => {
        if (document.visibilityState !== 'visible') return;

        const activeUserId = AppState.getUserId();
        if (!activeUserId || activeUserId !== userId) {
          this.stopBanStatusPolling();
          return;
        }

        try {
          const profile = await apiService.getProfileQuick();
          if (profile?.banned) {
            if (profile.banExpires && profile.banExpires !== 'permanent') {
              const banExpires = new Date(profile.banExpires);
              if (banExpires <= new Date()) return;
            }
            await this.handleBanDetected(profile.banReason, profile.banExpires, 'ban');
            return;
          }

          if (profile?.blacklisted) {
            this.applyRealtimeBlacklistStatus(profile.blacklistReason, profile.blacklistExpires, profile);
          }
        } catch (error) {
          console.warn('Error in ban status fallback check:', error);
        }
      }, 30000);
    };

    try {
      if (window.MCLBRealtimeStream?.connect) {
        const connection = window.MCLBRealtimeStream.connect({
          url: '/api/admin/ban-status-stream',
          onOpen: () => {
            console.log('Connected to real-time ban/blacklist monitoring stream');
          },
          onMessage: (data) => {
            if (!data || data.connected || !data.timestamp) return;
            if (data.userId && data.userId !== userId) return;

            if (data.isBanned) {
              console.log('Ban detected via real-time stream, logging out user');
              this.handleBanDetected(data.banReason, data.banExpires, 'ban');
              return;
            }

            if (data.isBlacklisted) {
              console.log('Blacklist detected via real-time stream, keeping session active');
              this.applyRealtimeBlacklistStatus(data.blacklistReason, data.blacklistExpires);
            }
          },
          onError: (error) => {
            console.error('Ban status stream error:', error);
            fallbackToPolling();
          }
        });

        this.banStatusEventSource = {
          close: () => connection.close()
        };
        return;
      }

      this.banStatusEventSource = new EventSource(`/api/admin/ban-status-stream`, { withCredentials: true });

      this.banStatusEventSource.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.connected || !data.timestamp) return;
          if (data.userId && data.userId !== userId) return;

          if (data.isBanned) {
            console.log('Ban detected via real-time stream, logging out user');
            this.handleBanDetected(data.banReason, data.banExpires, 'ban');
            return;
          }

          if (data.isBlacklisted) {
            console.log('Blacklist detected via real-time stream, keeping session active');
            this.applyRealtimeBlacklistStatus(data.blacklistReason, data.blacklistExpires);
          }
        } catch (err) {
          console.error('Error parsing ban status update:', err);
        }
      });

      this.banStatusEventSource.addEventListener('error', (event) => {
        console.error('Ban status stream error:', event);
        fallbackToPolling();
      });

      console.log('Connected to real-time ban/blacklist monitoring stream');
    } catch (err) {
      console.error('Error connecting to ban status stream:', err);
      fallbackToPolling();
    }
  },

  stopBanStatusPolling() {
    if (this.banStatusPollInterval) {
      clearInterval(this.banStatusPollInterval);
      this.banStatusPollInterval = null;
    }

    if (this.banStatusEventSource) {
      this.banStatusEventSource.close();
      this.banStatusEventSource = null;
    }

    if (this._banStatusReconnectTimeout) {
      clearTimeout(this._banStatusReconnectTimeout);
      this._banStatusReconnectTimeout = null;
    }

    if (this.banStatusVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.banStatusVisibilityHandler);
      this.banStatusVisibilityHandler = null;
    }
  },

  applyRealtimeBlacklistStatus(reason = '', expires = null, incomingProfile = null) {
    try {
      const currentProfile = AppState.getProfile?.() || {};
      const nextProfile = incomingProfile
        ? {
            ...currentProfile,
            ...incomingProfile,
            blacklisted: true
          }
        : {
            ...currentProfile,
            blacklisted: true,
            blacklistReason: reason || currentProfile.blacklistReason || '',
            blacklistExpires: expires || currentProfile.blacklistExpires || null,
            moderation: {
              ...(currentProfile.moderation || {}),
              blacklisted: true,
              blacklistEntry: {
                ...((currentProfile.moderation || {}).blacklistEntry || {}),
                reason: reason || currentProfile.blacklistReason || 'Restricted account',
                expiresAt: expires || currentProfile.blacklistExpires || null
              }
            }
          };
      AppState.setProfile(nextProfile);
    } catch (error) {
      console.warn('Unable to apply realtime blacklist status:', error);
    }
  },

  /**
   * Handle when a ban is detected - logout user and show message
   */
		  async handleBanDetected(reason, expires, type = 'ban') {
		    try {
		      if (type === 'ban') {
	        await this.forceLogout({
	          redirectTo: '/login.html',
	          notice: {
	            icon: 'error',
	            title: 'Access Restricted',
	            text: 'This account is not permitted to stay signed in.'
	          }
	        });
	        return;
	      }

	      let banReason = reason || 'Violation of terms of service';
	      const bannedAt = new Date().toLocaleDateString();
	      let banDuration = 'Permanent';
	      let timeRemaining = null;
	      const displayType = 'Banned';

      if (expires && expires !== 'permanent') {
        const expiryDate = new Date(expires);
        const now = new Date();
        if (expiryDate > now) {
          const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
          banDuration = `${daysLeft} days remaining (expires ${expiryDate.toLocaleDateString()})`;
          timeRemaining = expiryDate - now;
        } else {
          banDuration = 'Expired (please contact support)';
          timeRemaining = 0;
        }
      }

      // Show custom popup
      this.showBanPopup({
        banReason: banReason,
        bannedAt: bannedAt,
        banDuration: banDuration,
        timeRemaining: timeRemaining,
        isPermanent: expires === 'permanent',
        type: displayType
      });

    } catch (error) {
      console.error('Error handling ban/blacklist detection:', error);
      // Force redirect even if logout fails
      window.location.href = '/login.html';
    }
	  },

      async forceLogout({ redirectTo = '/login.html', notice = null } = {}) {
        this.stopBanStatusPolling();

        if (notice) {
          try {
            window.sessionStorage.setItem(this._loginNoticeStorageKey, JSON.stringify(notice));
          } catch (_) {}
        }

        let auth = null;
        try {
          if (typeof getAuth === 'function') {
            auth = getAuth();
          } else if (typeof firebase !== 'undefined' && firebase && typeof firebase.auth === 'function') {
            auth = firebase.auth();
          }
        } catch (_) {
          auth = null;
        }

        try {
          if (auth && typeof auth.signOut === 'function') {
            await auth.signOut();
          }
        } catch (signOutError) {
          console.warn('Forced sign out failed:', signOutError);
        }

	        try {
	          await this.clearBackendSession({ force: true });
	        } catch (sessionError) {
	          console.warn('Forced backend session clear failed:', sessionError);
	        }

        try {
          AppState.reset();
        } catch (_) {}

        try {
          apiService.setToken(null);
          if (typeof apiService.clearCache === 'function') {
            apiService.clearCache();
          }
        } catch (_) {}

        if (typeof window !== 'undefined') {
          window.location.replace(redirectTo);
        }
      },

  /**
   * Sign out
   */
  async signOut() {
    try {
      this.stopBanStatusPolling();

      // If Firebase SDK isn't available for any reason, still allow a local "logout"
      // so pages like Support don't hard-crash.
      let auth = null;
      try {
        if (typeof getAuth === 'function') {
          auth = getAuth();
        } else if (typeof firebase !== 'undefined' && firebase && typeof firebase.auth === 'function') {
          auth = firebase.auth();
        }
      } catch (_) {
        auth = null;
      }

	      if (auth && typeof auth.signOut === 'function') {
	        await auth.signOut();
	      }
	      await this.clearBackendSession({ force: true });
	      AppState.reset();
	      apiService.setToken(null);
    } catch (error) {
      console.error('Sign out error:', error);
      throw error;
    }
  },

  /**
   * Show themed ban popup
   */
  async showBanPopup(banData = {}) {
    let timeRemainingText = banData.banDuration;
    if (banData.timeRemaining && !banData.isPermanent) {
      const days = Math.floor(banData.timeRemaining / (1000 * 60 * 60 * 24));
      const hours = Math.floor((banData.timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((banData.timeRemaining % (1000 * 60 * 60)) / (1000 * 60));

      if (days > 0) {
        timeRemainingText = `${days} day${days > 1 ? 's' : ''}, ${hours} hour${hours > 1 ? 's' : ''}`;
      } else if (hours > 0) {
        timeRemainingText = `${hours} hour${hours > 1 ? 's' : ''}, ${minutes} minute${minutes > 1 ? 's' : ''}`;
      } else {
        timeRemainingText = `${minutes} minute${minutes > 1 ? 's' : ''}`;
      }
    }

    const bannedAt = banData.bannedAt
      ? formatDateTime(banData.bannedAt)
      : 'Not available';
    const typeLabel = banData.type || 'Banned';
    const reason = banData.banReason || 'Your account has been restricted.';

    const html = `
      <div class="auth-modal-footer" style="display:block; text-align:left;">
        <p><strong>Reason:</strong><br>${escapeHtml(reason)}</p>
        <p><strong>Date:</strong><br>${escapeHtml(bannedAt)}</p>
        <p><strong>Duration:</strong><br>${escapeHtml(timeRemainingText || (banData.isPermanent ? 'Permanent' : 'Unknown'))}</p>
        ${banData.isPermanent ? '<p><strong>This restriction is permanent.</strong></p>' : ''}
        <p>If you believe this was issued in error, contact support with your account details.</p>
      </div>
    `;

    if (typeof MCLBUI !== 'undefined') {
      return MCLBUI.alert({
        icon: 'error',
        title: `Account ${typeLabel}`,
        html,
        confirmButtonText: 'Back to Login'
      });
    }

    window.alert(`Account ${typeLabel}\n\nReason: ${reason}\nDate: ${bannedAt}\nDuration: ${timeRemainingText || 'Unknown'}`);
    return Promise.resolve({ isConfirmed: true });
  },

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email) {
    try {
      const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      await auth.sendPasswordResetEmail(email, this.getPasswordResetActionSettings(email));
    } catch (error) {
      console.error('Password reset error:', error);
      throw this.handleAuthError(error);
    }
  },

  /**
   * Handle authentication errors with user-friendly messages and suggestions
   */
  handleAuthError(error) {
    if (error.code === 'RATE_LIMITED') {
      const message = error.userMessage || 'Too many login attempts right now.';
      const suggestion = error.suggestion
        || (error.retryAt
          ? `Please try again ${formatAuthRateLimitRetryText(error.retryAt)}.`
          : 'Please wait a minute and try again.');
      const enhancedError = new Error(`${message}\n\n${suggestion}`);
      enhancedError.code = error.code;
      enhancedError.userMessage = message;
      enhancedError.suggestion = suggestion;
      enhancedError.action = 'wait';
      enhancedError.retryAt = error.retryAt || null;
      return enhancedError;
    }

    const errorInfo = {
      'auth/email-already-in-use': {
        message: 'This email is already registered.',
        suggestion: 'Try signing in instead, or use a different email address to create a new account.',
        action: 'signin'
      },
      'auth/account-exists-with-different-credential': {
        message: 'An account already exists for this email.',
        suggestion: 'Please sign in with email and password. Then go to the Account page and add your Google account.',
        action: 'signin_email_then_link_google'
      },
      'auth/popup-closed-by-user': {
        message: 'Google sign-in was cancelled.',
        suggestion: 'Please try again and complete the Google popup.',
        action: 'retry'
      },
      'auth/cancelled-popup-request': {
        message: 'Google sign-in was cancelled.',
        suggestion: 'Please try again.',
        action: 'retry'
      },
      'auth/popup-blocked': {
        message: 'Popup was blocked by your browser.',
        suggestion: 'Please allow popups for this site, then try again.',
        action: 'allow_popups'
      },
      'mclb/google-user-not-registered': {
        message: 'No account found for this Google email.',
        suggestion: 'Please use “Sign up with Google” to create your account (age verification is required).',
        action: 'go_to_google_signup'
      },
      'DUPLICATE_IP_DETECTED': {
        message: 'This network already has a registered account.',
        suggestion: 'Multiple accounts per network are not permitted. If you believe this is an error, please contact support.',
        action: 'contact_support'
      },
      'RATE_LIMITED': {
        message: 'Too many login attempts right now.',
        suggestion: 'Please wait a minute and try Google sign-in again.',
        action: 'wait'
      },
      'AGE_VERIFICATION_FAILED': {
        message: 'You must be at least 13 years old to create an account.',
        suggestion: 'Please enter a valid age (13+).',
        action: 'check_age'
      },
      'auth/invalid-email': {
        message: 'The email address you entered is not valid.',
        suggestion: 'Please check for typos and make sure you\'re using a valid email format (e.g., name@example.com).',
        action: 'check_email'
      },
      'auth/operation-not-allowed': {
        message: 'This sign-in method is not enabled.',
        suggestion: 'Please contact support if you believe this is an error.',
        action: 'contact_support'
      },
      'auth/weak-password': {
        message: 'Your password is too weak.',
        suggestion: 'Please use a password that is at least 6 characters long. For better security, use a mix of letters, numbers, and special characters.',
        action: 'strengthen_password'
      },
      'auth/user-disabled': {
        message: 'This account has been disabled.',
        suggestion: 'Your account may have been suspended or banned. Please contact support for assistance.',
        action: 'contact_support'
      },
      'auth/user-not-found': {
        message: 'No account found with this email address.',
        suggestion: 'Double-check your email for typos, or sign up for a new account if you don\'t have one yet.',
        action: 'check_email_or_signup'
      },
      'auth/wrong-password': {
        message: 'The password you entered is incorrect.',
        suggestion: 'Make sure Caps Lock is off and check for typos. If you\'ve forgotten your password, use the "Forgot password?" link to reset it.',
        action: 'reset_password'
      },
      'auth/invalid-credential': {
        message: 'The email or password you entered is incorrect.',
        suggestion: 'Please check both your email and password. Make sure Caps Lock is off. If you\'ve forgotten your password, use the "Forgot password?" link.',
        action: 'check_credentials'
      },
      'auth/invalid-verification-code': {
        message: 'The verification code is invalid or has expired.',
        suggestion: 'Please request a new verification code and try again.',
        action: 'request_new_code'
      },
      'auth/invalid-verification-id': {
        message: 'The verification link is invalid or has expired.',
        suggestion: 'Please request a new verification email and try again.',
        action: 'request_new_email'
      },
      'auth/too-many-requests': {
        message: 'Too many failed login attempts.',
        suggestion: 'For security, your account has been temporarily locked. Please wait a few minutes before trying again, or reset your password.',
        action: 'wait_or_reset'
      },
      'auth/network-request-failed': {
        message: 'Network connection error.',
        suggestion: 'Please check your internet connection and try again. If the problem persists, your firewall or network settings may be blocking the connection.',
        action: 'check_connection'
      },
      'auth/requires-recent-login': {
        message: 'For security, please sign in again.',
        suggestion: 'This action requires recent authentication. Please sign out and sign back in, then try again.',
        action: 're_signin'
      },
      'auth/quota-exceeded': {
        message: 'Service temporarily unavailable.',
        suggestion: 'The authentication service is experiencing high traffic. Please try again in a few minutes.',
        action: 'try_later'
      },
      'auth/unavailable': {
        message: 'Service temporarily unavailable.',
        suggestion: 'The authentication service is currently unavailable. Please try again in a few minutes.',
        action: 'try_later'
      },
      'auth/email-already-exists': {
        message: 'This email is already registered.',
        suggestion: 'Try signing in instead, or use a different email address to create a new account.',
        action: 'signin'
      },
      'auth/credential-already-in-use': {
        message: 'This account is already linked to another user.',
        suggestion: 'This email or account is already associated with a different account. Please sign in with your existing account.',
        action: 'signin'
      },
      'auth/invalid-action-code': {
        message: 'The verification link is invalid or has expired.',
        suggestion: 'Please request a new verification email and try again.',
        action: 'request_new_email'
      },
      'auth/expired-action-code': {
        message: 'The verification link has expired.',
        suggestion: 'Please request a new verification email and try again.',
        action: 'request_new_email'
      },
      'EMAIL_VERIFICATION_REQUIRED_FOR_LOGIN': {
        message: 'This account requires a verified email address before sign-in can finish.',
        suggestion: 'Verify your email first, then try signing in again.',
        action: 'verify_email'
      },
      'ACCOUNT_BANNED': {
        message: error?.data?.message || error?.message || 'This account has been banned.',
        suggestion: 'If you believe this was issued in error, contact support.',
        action: 'contact_support'
      }
    };

    const errorCode = error.code || '';
    const info = errorInfo[errorCode];

    if (info) {
      const fullMessage = `${info.message}\n\n${info.suggestion}`;
      const enhancedError = new Error(fullMessage);
      enhancedError.code = errorCode;
      enhancedError.userMessage = info.message;
      enhancedError.suggestion = info.suggestion;
      enhancedError.action = info.action;
      enhancedError.data = error.data || null;
      enhancedError.status = error.status || null;
      enhancedError.alreadyPresented = error.alreadyPresented === true;
      return enhancedError;
    }

    // Fallback for unknown errors
    const fallbackMessage = error.message || 'An unexpected error occurred.';
    const enhancedError = new Error(`${fallbackMessage}\n\nIf this problem persists, please contact support.`);
    enhancedError.code = errorCode;
    enhancedError.userMessage = fallbackMessage;
    enhancedError.suggestion = 'If this problem persists, please contact support.';
    enhancedError.action = 'contact_support';
    enhancedError.data = error.data || null;
    enhancedError.status = error.status || null;
    enhancedError.alreadyPresented = error.alreadyPresented === true;
    return enhancedError;
  }
};

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    firebaseAuthService.init();
  });
} else {
  firebaseAuthService.init();
}

if (typeof window !== 'undefined') {
  window.firebaseAuthService = firebaseAuthService;
}
