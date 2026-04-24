// MC Leaderboards - Global reCAPTCHA Service
// Uses the existing loading overlay for verification progress and remembers recent successful verification.

// Site key is centralised in js/config.js (CONFIG.RECAPTCHA_SITE_KEY)
function getRecaptchaSiteKey() {
  return (typeof CONFIG !== 'undefined' && CONFIG.RECAPTCHA_SITE_KEY)
    ? CONFIG.RECAPTCHA_SITE_KEY
    : '6LdaSL4sAAAAAKK56-vEq5tTWqpHcoTVBlPMA69p'; // fallback
}
let recaptchaLoaded = false;
let recaptchaLoading = false;
const RECAPTCHA_TRUST_KEY = 'mclb_recaptcha_verified_until';
const RECAPTCHA_TRUST_COOKIE = 'mclb_recaptcha_trust';
const RECAPTCHA_TRUST_WINDOW_MS = 24 * 60 * 60 * 1000;

function getTrustExpiryMs() {
  try {
    const storedValue = Number(window.localStorage.getItem(RECAPTCHA_TRUST_KEY) || 0);
    return Number.isFinite(storedValue) ? storedValue : 0;
  } catch (_error) {
    return 0;
  }
}

function persistTrustExpiry(expiryMs) {
  const safeExpiryMs = Number(expiryMs) || 0;

  try {
    if (safeExpiryMs > 0) {
      window.localStorage.setItem(RECAPTCHA_TRUST_KEY, String(safeExpiryMs));
    } else {
      window.localStorage.removeItem(RECAPTCHA_TRUST_KEY);
    }
  } catch (_error) {}

  if (safeExpiryMs > 0) {
    const maxAge = Math.max(0, Math.floor((safeExpiryMs - Date.now()) / 1000));
    document.cookie = `${RECAPTCHA_TRUST_COOKIE}=1; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  } else {
    document.cookie = `${RECAPTCHA_TRUST_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

function hasRecentVerification() {
  const expiryMs = getTrustExpiryMs();
  if (expiryMs > Date.now()) {
    return true;
  }

  if (expiryMs > 0) {
    persistTrustExpiry(0);
  }
  return false;
}

function markRecentVerification() {
  persistTrustExpiry(Date.now() + RECAPTCHA_TRUST_WINDOW_MS);
}

function clearRecentVerification() {
  persistTrustExpiry(0);
}

function showVerificationOverlay() {
  if (!window.mclbLoadingOverlay) return;
  window.mclbLoadingOverlay.show();
  window.mclbLoadingOverlay.updateStatus('Verifying you are human...', 92);
}

function hideVerificationOverlay() {
  if (!window.mclbLoadingOverlay) return;
  window.mclbLoadingOverlay.hide();
}

/**
 * Initialize reCAPTCHA service
 */
function initRecaptchaService() {
  if (recaptchaLoaded || recaptchaLoading) return;
  
  recaptchaLoading = true;
  
  // Check if grecaptcha is already available
  if (typeof grecaptcha !== 'undefined') {
    recaptchaLoaded = true;
    recaptchaLoading = false;
    return;
  }
  
  // Load reCAPTCHA v3 script if not already loaded
  if (!document.querySelector('script[src*="recaptcha/api.js"]')) {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${getRecaptchaSiteKey()}`;
    script.async = true;
    script.defer = true;
    // Note: Do NOT set crossOrigin on script tags - it causes CORS errors
    
    script.onload = () => {
      // Wait a bit for grecaptcha to be available after script loads
      setTimeout(() => {
        if (typeof grecaptcha !== 'undefined') {
          recaptchaLoaded = true;
          recaptchaLoading = false;
          console.log('reCAPTCHA v3 script loaded successfully');
        } else {
          // Script loaded but grecaptcha not available yet, wait for it
          const checkInterval = setInterval(() => {
            if (typeof grecaptcha !== 'undefined') {
              recaptchaLoaded = true;
              recaptchaLoading = false;
              clearInterval(checkInterval);
              console.log('reCAPTCHA v3 script loaded successfully');
            }
          }, 100);
          
          // Timeout after 5 seconds
          setTimeout(() => {
            if (!recaptchaLoaded) {
              clearInterval(checkInterval);
              recaptchaLoading = false;
              console.warn('reCAPTCHA script loaded but grecaptcha not available');
            }
          }, 5000);
        }
      }, 100);
    };
    
    script.onerror = (error) => {
      recaptchaLoading = false;
      console.error('Failed to load reCAPTCHA script. This may be due to:', {
        reason: 'Network error, ad blocker, or CORS issue',
        error: error,
        suggestion: 'Check browser console for network errors or disable ad blockers'
      });
      
      // Try alternative loading method
      setTimeout(() => {
        if (!recaptchaLoaded && !recaptchaLoading) {
          console.warn('Attempting to reload reCAPTCHA script...');
          // Remove the failed script
          const failedScript = document.querySelector('script[src*="recaptcha/api.js"]');
          if (failedScript) {
            failedScript.remove();
          }
          // Retry initialization after a delay
          setTimeout(() => {
            initRecaptchaService();
          }, 2000);
        }
      }, 1000);
    };
    
    document.head.appendChild(script);
  } else {
    // Script already exists, wait for it to load
    const checkInterval = setInterval(() => {
      if (typeof grecaptcha !== 'undefined') {
        recaptchaLoaded = true;
        recaptchaLoading = false;
        clearInterval(checkInterval);
      }
    }, 100);
    
    // Timeout after 10 seconds
    setTimeout(() => {
      if (!recaptchaLoaded) {
        clearInterval(checkInterval);
        recaptchaLoading = false;
      }
    }, 10000);
  }
}

/**
 * Wait for reCAPTCHA to be ready
 */
function waitForRecaptcha() {
  return new Promise((resolve, reject) => {
    if (typeof grecaptcha !== 'undefined' && grecaptcha.ready) {
      grecaptcha.ready(() => resolve());
      return;
    }
    
    // Try to initialize
    initRecaptchaService();
    
    // Wait for it to load
    const checkInterval = setInterval(() => {
      if (typeof grecaptcha !== 'undefined' && grecaptcha.ready) {
        clearInterval(checkInterval);
        grecaptcha.ready(() => resolve());
      }
    }, 100);
    
    // Timeout after 10 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      reject(new Error('reCAPTCHA failed to load. Please refresh the page.'));
    }, 10000);
  });
}

/**
 * Get reCAPTCHA token using v3 (invisible)
 * This is the main function to use throughout the app
 * @param {string} action - Action name for reCAPTCHA (default: 'submit')
 * @returns {Promise<string>} reCAPTCHA token
 */
async function getRecaptchaToken(action = 'submit') {
  try {
    showVerificationOverlay();
    
    // Wait for reCAPTCHA to be ready (with retry logic)
    let retries = 0;
    const maxRetries = 5;
    let lastError = null;
    
    // First, ensure initialization is attempted
    if (!recaptchaLoaded && !recaptchaLoading) {
      initRecaptchaService();
      // Wait a bit for initialization to start
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    while (retries < maxRetries) {
      try {
        await waitForRecaptcha();
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        retries++;
        if (retries < maxRetries) {
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Reset loading state and try to reinitialize
          recaptchaLoading = false;
          recaptchaLoaded = false;
          initRecaptchaService();
          // Wait for initialization to start
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
    
    if (retries >= maxRetries) {
      const errorMsg = lastError?.message || 'reCAPTCHA failed to load after multiple attempts';
      throw new Error(`${errorMsg}. Please check your internet connection, disable ad blockers, and refresh the page.`);
    }
    
    // Verify grecaptcha is available and has execute method
    if (typeof grecaptcha === 'undefined') {
      // Check if script was blocked
      const scriptTag = document.querySelector('script[src*="recaptcha/api.js"]');
      if (!scriptTag) {
        throw new Error('reCAPTCHA script was not loaded. This may be due to an ad blocker or network issue. Please disable ad blockers and refresh the page.');
      }
      throw new Error('reCAPTCHA script loaded but grecaptcha is not available. Please refresh the page.');
    }
    
    if (typeof grecaptcha.execute !== 'function') {
      throw new Error('reCAPTCHA is not properly initialized. The execute method is not available.');
    }
    
    // Execute reCAPTCHA
    const token = await grecaptcha.execute(getRecaptchaSiteKey(), { action });
    
    // Validate token
    if (!token || typeof token !== 'string' || token.length === 0) {
      throw new Error('Invalid reCAPTCHA token received');
    }
    
    return token;
  } catch (error) {
    // Show user-friendly error
    if (typeof Swal !== 'undefined') {
      try {
        await Swal.fire({
          icon: 'error',
          title: 'Verification Required',
          text: error.message || 'reCAPTCHA verification is required. Please try again.',
          confirmButtonText: 'OK'
        });
      } catch (swalError) {
        console.error('Could not show error message:', swalError);
        // Fallback to console if Swal fails
        console.error('reCAPTCHA Error:', error.message || error);
      }
    } else {
      // No Swal available, log to console
      console.error('reCAPTCHA Error:', error.message || error);
    }
    throw error;
  } finally {
    hideVerificationOverlay();
  }
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRecaptchaService);
} else {
  initRecaptchaService();
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.RecaptchaService = {
    getToken: getRecaptchaToken,
    init: initRecaptchaService,
    hasRecentVerification,
    markVerified: markRecentVerification,
    clearVerified: clearRecentVerification,
    isAvailable: () => {
      return typeof window !== 'undefined' && 
             typeof window.RecaptchaService !== 'undefined' && 
             typeof window.RecaptchaService.getToken === 'function';
    }
  };
  
  // Ensure service is always available, even if script loads late
  // This helps with race conditions where other scripts load before this one
  if (!window.RecaptchaService || typeof window.RecaptchaService.getToken !== 'function') {
    console.warn('RecaptchaService not properly initialized, re-initializing...');
    initRecaptchaService();
  }
}

