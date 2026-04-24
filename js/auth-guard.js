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
      Swal.fire({
        icon: 'error',
        title: 'Access Denied',
        text: 'You must be an admin to access this page.',
        confirmButtonText: 'Go to Dashboard'
      }).then(() => {
        window.location.href = 'dashboard.html';
      });
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
