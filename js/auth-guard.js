// MC Leaderboards - Authentication Guard
// Ensures authentication is verified before any page operations

/**
 * Wait for authentication state to be determined
 * Returns a promise that resolves with the user if authenticated, or null if not
 */
async function waitForAuthState() {
    try {
    // Wait for Firebase to be initialized using the centralized service
    if (typeof waitForFirebaseInit !== 'undefined') {
      await waitForFirebaseInit();
    } else {
      // Fallback: Wait for Firebase to be initialized
      await new Promise((resolve) => {
      const checkFirebase = () => {
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
            resolve();
          } else {
            setTimeout(checkFirebase, 100);
          }
        };
        checkFirebase();
      });
    }

    return new Promise((resolve) => {
          const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
      
          // Check if already initialized and has user
          if (auth.currentUser !== null) {
            resolve(auth.currentUser);
            return;
          }

          // Wait for auth state change
          // This will fire immediately if user is already logged in
          const unsubscribe = auth.onAuthStateChanged((user) => {
            unsubscribe(); // Only listen once
            resolve(user);
          });

          // Timeout after 5 seconds to prevent hanging
          setTimeout(() => {
            unsubscribe();
            // If still no user after timeout, resolve with null
            if (auth.currentUser === null) {
              resolve(null);
            } else {
              resolve(auth.currentUser);
            }
          }, 5000);
    });
    } catch (error) {
      console.error('Error in waitForAuthState:', error);
    return null;
    }
}

// Track if redirect is in progress to prevent loops
let redirectInProgress = false;
const REDIRECT_LOOP_STORAGE_KEY = 'mclb_redirect_loop_history';
const REDIRECT_RECOVERY_STORAGE_KEY = 'mclb_redirect_recovery_at';
const REDIRECT_LOOP_WINDOW_MS = 12000;
const REDIRECT_LOOP_MAX_HOPS = 4;

function getCurrentPageName() {
  return window.location.pathname.split('/').pop() || 'index.html';
}

function normalizeRedirectTarget(target) {
  return String(target || '').split('?')[0].split('#')[0] || 'index.html';
}

function readRedirectHistory() {
  try {
    const raw = window.sessionStorage.getItem(REDIRECT_LOOP_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeRedirectHistory(history) {
  try {
    window.sessionStorage.setItem(REDIRECT_LOOP_STORAGE_KEY, JSON.stringify(history));
  } catch (_) {}
}

function clearRedirectHistory() {
  try {
    window.sessionStorage.removeItem(REDIRECT_LOOP_STORAGE_KEY);
  } catch (_) {}
}

function recordRedirectHop(target, reason = 'redirect') {
  const now = Date.now();
  const from = getCurrentPageName();
  const to = normalizeRedirectTarget(target);
  const history = readRedirectHistory()
    .filter((entry) => entry && (now - Number(entry.at || 0)) < REDIRECT_LOOP_WINDOW_MS);

  history.push({ from, to, reason, at: now });
  writeRedirectHistory(history);

  const sensitiveHops = history.filter((entry) => ['dashboard.html', 'onboarding.html'].includes(entry.from)
    || ['dashboard.html', 'onboarding.html'].includes(entry.to));
  const recoveredAt = Number(window.sessionStorage.getItem(REDIRECT_RECOVERY_STORAGE_KEY) || 0);
  const recentlyRecovered = recoveredAt && (now - recoveredAt) < 30000;

  return sensitiveHops.length >= REDIRECT_LOOP_MAX_HOPS && !recentlyRecovered;
}

function clearLocalStorageForRedirectRecovery() {
  try {
    window.localStorage.clear();
  } catch (_) {}

  try {
    if (typeof apiService !== 'undefined' && typeof apiService.clearCache === 'function') {
      apiService.clearCache();
    }
  } catch (_) {}

  try {
    if (typeof AppState !== 'undefined' && typeof AppState.setProfile === 'function') {
      AppState.setProfile(null);
    }
  } catch (_) {}
}

async function resolveRedirectRecoveryTarget(fallbackTarget) {
  try {
    const auth = typeof getAuth === 'function'
      ? getAuth()
      : (typeof firebase !== 'undefined' && firebase.auth ? firebase.auth() : null);
    const user = auth?.currentUser || AppState.currentUser || null;
    if (!user) return 'login.html';

    if (typeof firebaseAuthService !== 'undefined' && typeof firebaseAuthService.loadCurrentAccountContext === 'function') {
      const context = await firebaseAuthService.loadCurrentAccountContext({
        user,
        forceProfileRefresh: true,
        requireProfile: true,
        reloadUser: true
      });
      const profile = context.profile || null;
      return profile?.onboardingCompleted === true ? 'dashboard.html' : 'onboarding.html';
    }

    if (typeof apiService !== 'undefined' && typeof apiService.request === 'function') {
      const profile = await apiService.request('/users/me', { method: 'GET', noCache: true, timeout: 5000 });
      AppState.setProfile(profile);
      return profile?.onboardingCompleted === true ? 'dashboard.html' : 'onboarding.html';
    }
  } catch (error) {
    console.warn('Redirect loop recovery profile refresh failed:', error?.message || error);
  }

  return fallbackTarget || 'login.html';
}

async function recoverFromRedirectLoop(fallbackTarget) {
  clearLocalStorageForRedirectRecovery();
  clearRedirectHistory();
  try {
    window.sessionStorage.setItem(REDIRECT_RECOVERY_STORAGE_KEY, String(Date.now()));
  } catch (_) {}

  const target = await resolveRedirectRecoveryTarget(fallbackTarget);
  const separator = target.includes('?') ? '&' : '?';
  window.location.replace(`${target}${separator}recovered=storage`);
}

async function guardedRedirect(target, { replace = false, reason = 'redirect' } = {}) {
  const normalizedTarget = normalizeRedirectTarget(target);
  if (recordRedirectHop(normalizedTarget, reason)) {
    await recoverFromRedirectLoop(normalizedTarget);
    return;
  }

  if (replace) {
    window.location.replace(target);
  } else {
    window.location.href = target;
  }
}

function isInvalidAuthenticatedSessionError(error) {
  const code = String(error?.code || '');
  return error?.status === 401
    || error?.status === 403
    || ['EMAIL_VERIFICATION_REQUIRED_FOR_LOGIN', 'ACCOUNT_BANNED', 'AUTH_INVALID'].includes(code);
}

/**
 * Guard function - checks authentication before allowing page operations
 * Redirects to login if not authenticated
 * @param {boolean} requireAdmin - If true, also requires admin role
 * @param {boolean} requireTierTester - If true, also requires tier tester role
 */
async function requireAuth(requireAdmin = false, requireTierTester = false) {
  // Prevent multiple simultaneous checks
  if (redirectInProgress) {
    return false;
  }

  // Wait for Firebase to be initialized using the centralized service
  if (typeof waitForFirebaseInit !== 'undefined') {
    await waitForFirebaseInit();
  } else {
    // Fallback: Wait for Firebase to be initialized
  if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
    await new Promise((resolve) => {
      const checkFirebaseReady = () => {
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
          resolve();
        } else {
          setTimeout(checkFirebaseReady, 100);
        }
      };
      checkFirebaseReady();
    });
    }
  }

  // Wait for auth state
  const user = await waitForAuthState();
  
  if (!user) {
    // Not authenticated - redirect to login
    if (!redirectInProgress) {
      redirectInProgress = true;
      window.location.href = 'login.html';
    }
    return false;
  }
  
  AppState.setUser(user);

  let profile = AppState.getProfile();
  let lastProfileError = null;

  try {
    if (typeof firebaseAuthService !== 'undefined' && typeof firebaseAuthService.loadCurrentAccountContext === 'function') {
      const context = await firebaseAuthService.loadCurrentAccountContext({
        user,
        forceProfileRefresh: false,
        requireProfile: true
      });
      profile = context.profile;
    } else if (typeof firebaseAuthService !== 'undefined' && typeof firebaseAuthService.fetchUserProfile === 'function') {
      profile = await firebaseAuthService.fetchUserProfile(user.uid, { forceProfileRefresh: false });
    }
  } catch (error) {
    lastProfileError = error;
    console.error('Error loading profile in requireAuth:', error);
  }

  if (!profile) {
	    if (!redirectInProgress) {
	      redirectInProgress = true;
	      if (isInvalidAuthenticatedSessionError(lastProfileError) && typeof firebaseAuthService?.forceLogout === 'function') {
	        await firebaseAuthService.forceLogout({
	          redirectTo: '/login.html',
	          notice: {
	            icon: 'error',
	            title: 'Session Ended',
	            text: 'We could not load your account access. Please sign in again.'
	          }
	        });
	        return false;
	      }

	      const isRateLimited = lastProfileError?.isRateLimit === true || lastProfileError?.status === 429;
      if (isRateLimited) {
        const message = lastProfileError?.message || 'Your account profile is temporarily rate limited.';
        const suggestion = lastProfileError?.suggestion || 'Please wait a moment and try again.';
        Swal.fire({
          icon: 'warning',
          title: 'Profile Load Rate Limited',
          text: `${message} ${suggestion}`.trim(),
          confirmButtonText: 'Retry',
          showCancelButton: true,
          cancelButtonText: 'Go to Login'
        }).then((result) => {
          redirectInProgress = false;
          if (result.isConfirmed) {
            window.location.reload();
            return;
          }
          window.location.href = 'login.html';
        });
      } else {
        Swal.fire({
          icon: 'error',
          title: 'Session Error',
          text: 'Could not load your account profile. Please sign in again.',
          confirmButtonText: 'Go to Login'
        }).then(() => {
          window.location.href = 'login.html';
        });
      }
    }
    return false;
  }
  
  // Check if user is banned
	  profile = profile || AppState.getProfile();
	  if (profile && profile.banned) {
	    // Check if ban has expired
	    let isStillBanned = true;
    if (profile.banExpires && profile.banExpires !== 'permanent') {
      const banExpires = new Date(profile.banExpires);
      const now = new Date();
      if (banExpires <= now) {
        isStillBanned = false;
        // Clear ban status if expired
        await firebaseAuthService.updateProfile({ banned: false });
      }
    }

	    if (isStillBanned) {
	      if (!redirectInProgress) {
	        redirectInProgress = true;
            await firebaseAuthService.forceLogout({
              redirectTo: '/login.html',
              notice: {
                icon: 'error',
                title: 'Access Restricted',
                text: 'This account is not permitted to stay signed in.'
              }
            });
	      }
	      return false;
	    }
	  }
  
  // Check admin requirement
  if (requireAdmin && !AppState.isAdmin()) {
    if (!redirectInProgress) {
      redirectInProgress = true;
      window.location.replace('dashboard.html');
    }
    return false;
  }
  
  // Check tier tester requirement
  if (requireTierTester && !AppState.isTierTester()) {
    if (!redirectInProgress) {
      redirectInProgress = true;
      Swal.fire({
        icon: 'error',
        title: 'Access Denied',
        text: 'You must be a tier tester to access this page.',
        confirmButtonText: 'Go to Dashboard'
      }).then(() => {
        window.location.href = 'dashboard.html';
      });
    }
    return false;
  }

  // Check onboarding completion (skip for onboarding page itself)
  const currentPage = window.location.pathname.split('/').pop();
  if (currentPage !== 'onboarding.html' && !AppState.isOnboardingCompleted()) {
    if (!redirectInProgress) {
      redirectInProgress = true;
      window.location.href = 'onboarding.html';
    }
    return false;
  }

  return true;
}

/**
 * Guard function for public pages - redirects if already authenticated
 * Used for login/signup pages
 */
async function requireGuest() {
  // Prevent multiple simultaneous checks
  if (redirectInProgress) {
    return false;
  }

  // Wait for Firebase to be initialized using the centralized service
  if (typeof waitForFirebaseInit !== 'undefined') {
    await waitForFirebaseInit();
  } else {
    // Fallback: Wait for Firebase to be initialized
  if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
    await new Promise((resolve) => {
      const checkFirebaseReady = () => {
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
          resolve();
        } else {
          setTimeout(checkFirebaseReady, 100);
        }
      };
      checkFirebaseReady();
    });
    }
  }

	  const user = await waitForAuthState();
	  
	  if (user) {
	    let profile = null;
	    try {
	      if (typeof firebaseAuthService !== 'undefined' && typeof firebaseAuthService.loadCurrentAccountContext === 'function') {
	        const context = await firebaseAuthService.loadCurrentAccountContext({
	          user,
	          forceProfileRefresh: false,
	          requireProfile: true
	        });
	        profile = context.profile;
	      } else {
	        profile = await firebaseAuthService.fetchUserProfile(user.uid, { forceProfileRefresh: false });
	      }

		      if (profile && profile.banned) {
        // Check if ban has expired
        let isStillBanned = true;
        if (profile.banExpires && profile.banExpires !== 'permanent') {
          const banExpires = new Date(profile.banExpires);
          const now = new Date();
          if (banExpires <= now) {
            isStillBanned = false;
            // Clear ban status if expired
            await firebaseAuthService.updateProfile({ banned: false });
          }
        }

	        if (isStillBanned) {
	          if (!redirectInProgress) {
	            redirectInProgress = true;
                await firebaseAuthService.forceLogout({
                  redirectTo: '/login.html',
                  notice: {
                    icon: 'error',
                    title: 'Access Restricted',
                    text: 'This account is not permitted to sign in.'
                  }
                });
	          }
	          return false;
	        }
	      }
    } catch (error) {
      console.error('Error checking ban status in requireGuest:', error);
      if (isInvalidAuthenticatedSessionError(error)) {
        if (!redirectInProgress) {
          redirectInProgress = true;
          if (typeof firebaseAuthService?.forceLogout === 'function') {
            await firebaseAuthService.forceLogout({
              redirectTo: '/login.html',
              notice: {
                icon: 'error',
                title: 'Session Ended',
                text: 'We could not load your account access. Please sign in again.'
              }
            });
          } else if (typeof firebaseAuthService?.signOut === 'function') {
            await firebaseAuthService.signOut().catch(() => null);
            window.location.href = 'login.html';
          }
        }
        return false;
      }

      return true;
    }

    // Not banned - redirect based on onboarding completion
    if (!redirectInProgress) {
      redirectInProgress = true;
      const redirectTarget = (profile && profile.onboardingCompleted) ? 'dashboard.html' : 'onboarding.html';
      window.location.href = redirectTarget;
    }
    return false;
  }
  
  return true;
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.requireAuth = requireAuth;
  window.requireGuest = requireGuest;
  window.waitForAuthState = waitForAuthState;
}
