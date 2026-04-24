// MC Leaderboards - Firebase Service
// Handles Firebase initialization and configuration

// Firebase will be loaded from CDN
// Make sure to include Firebase SDK in HTML before this script

let firebaseApp = null;
let firebaseAuth = null;
let firebaseInitialized = false;
let firebaseInitPromise = null;
let firebaseUnavailable = false;

// Firebase CDN (compat build)
const FIREBASE_SDK_VERSION = '9.22.0';
const FIREBASE_CDN_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const MCLB_FIREBASE_APP_NAME = 'mcleaderboards';

/**
 * Load an external script exactly once.
 */
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    try {
      // If already present in DOM, assume it's either loaded or loading.
      const existing = Array.from(document.scripts || []).find((s) => s && s.src === src);
      if (existing) {
        // If it already finished loading, resolve immediately.
        // Otherwise, wait for load/error on that element.
        if (existing.dataset && existing.dataset.mclbLoaded === 'true') {
          resolve(true);
          return;
        }
        existing.addEventListener('load', () => resolve(true), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = false; // preserve execution order
      script.defer = false;
      script.dataset.mclbFirebase = 'true';
      script.addEventListener(
        'load',
        () => {
          script.dataset.mclbLoaded = 'true';
          resolve(true);
        },
        { once: true }
      );
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      reject(e);
    }
  });
}

function getFirebaseNamespace() {
  // Prefer our captured instance if present.
  if (typeof window !== 'undefined' && window._mclbFirebase) return window._mclbFirebase;
  if (typeof firebase !== 'undefined') return firebase;
  return undefined;
}

function looksLikeFirebaseAppOnly(fb) {
  // "app-only" firebase namespace: has initializeApp/apps but lacks auth service.
  return !!(
    fb &&
    typeof fb.initializeApp === 'function' &&
    Array.isArray(fb.apps) &&
    typeof fb.auth !== 'function'
  );
}

/**
 * If something (like a browser extension/userscript) loads Firebase app-only and overwrites the global,
 * re-load the auth compat bundle and then lock `window.firebase` to the working instance.
 */
async function ensureFirebaseCompatServices() {
  // Wait a moment for firebase global to appear (if scripts are still loading).
  let attempts = 0;
  const maxAttempts = 60; // ~3s
  while (typeof firebase === 'undefined' && attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 50));
    attempts++;
  }

  if (typeof firebase === 'undefined') return false;

  // If firebase is present but missing auth, load compat service bundles.
  if (looksLikeFirebaseAppOnly(firebase)) {
    try {
      // Ensure app compat is present (harmless if already loaded).
      await loadScriptOnce(`${FIREBASE_CDN_BASE}/firebase-app-compat.js`);
      await loadScriptOnce(`${FIREBASE_CDN_BASE}/firebase-auth-compat.js`);
    } catch (e) {
      console.error('Failed to load Firebase compat service scripts:', e);
      return false;
    }
  }

  // Capture the working namespace for the rest of the app (and future overwrites).
  const fb = getFirebaseNamespace();
  if (!fb || typeof fb.initializeApp !== 'function') return false;

  // If auth still isn't available, fail (this indicates a blocked script or severe conflict).
  if (typeof fb.auth !== 'function') {
    return false;
  }

  if (typeof window !== 'undefined') {
    window._mclbFirebase = fb;
  }

  return true;
}

/**
 * Initialize Firebase
 */
function initializeFirebase() {
  try {
    const fb = getFirebaseNamespace();
    if (!fb) {
      firebaseUnavailable = true;
      if (typeof window !== 'undefined') {
        window._mclbFirebaseUnavailable = true;
      }
      console.warn('Firebase SDK is unavailable. Continuing with API-only mode where possible.');
      return false;
    }

    // Always use our own named app instance.
    // This prevents conflicts when other scripts/extensions initialize a default app
    // with a different API key/project (which can cause auth/configuration-not-found).
    const hasApps = Array.isArray(fb.apps) && fb.apps.length > 0;
    const existingDefaultApp = hasApps ? fb.apps.find((a) => a && a.name === '[DEFAULT]') : null;
    const existingNamedApp = hasApps ? fb.apps.find((a) => a && a.name === MCLB_FIREBASE_APP_NAME) : null;

    // Keep a default app available for legacy compat code paths that still call firebase.auth()
    // without an explicit app instance.
    if (!existingDefaultApp) {
      try {
        fb.initializeApp(CONFIG.FIREBASE_CONFIG);
      } catch (_) {
        // Ignore races where another script initializes default app first.
      }
    }

    if (existingNamedApp) {
      firebaseApp = fb.app(MCLB_FIREBASE_APP_NAME);
    } else {
      firebaseApp = fb.initializeApp(CONFIG.FIREBASE_CONFIG, MCLB_FIREBASE_APP_NAME);
    }

    // Initialize Firebase Auth using our app.
    if (typeof fb.auth !== 'function') {
      console.error('Firebase Auth SDK not loaded. Ensure firebase-auth-compat.js is included.');
      firebaseUnavailable = true;
      if (typeof window !== 'undefined') window._mclbFirebaseUnavailable = true;
      return false;
    }
    firebaseAuth = fb.auth(firebaseApp);

    firebaseInitialized = true;
    if (typeof window !== 'undefined') {
      window._mclbFirebaseInitDone = true;
    }
    console.log('Firebase initialized successfully');

    return true;
  } catch (error) {
    console.error('Error initializing Firebase:', error);
    return false;
  }
}

/**
 * Check if Firebase SDK is available (non-blocking).
 * Returns true only if the namespace is already present – never spins.
 */
function waitForFirebaseSync(maxWaitMs = 2000) {
  return !!getFirebaseNamespace();
}

/**
 * Get Firebase Auth instance
 */
function getAuth() {
  if (!firebaseAuth) {
    // Try immediate init if SDK is already loaded
    if (getFirebaseNamespace() && !firebaseAuth) {
      initializeFirebase();
    }
  }
  return firebaseAuth;
}

/**
 * Realtime Database is intentionally disabled in the browser.
 */
function getDatabase() {
  if (typeof console !== 'undefined') {
    console.warn('Firebase Realtime Database is disabled on the client. Use backend API routes instead.');
  }
  return null;
}

/**
 * Get Firebase App instance
 */
function getApp() {
  if (!firebaseApp) {
    if (getFirebaseNamespace() && !firebaseApp) {
      initializeFirebase();
    }
  }
  return firebaseApp;
}

/**
 * Wait for Firebase SDK to load, then initialize
 */
async function waitForFirebaseAndInitialize() {
  // Return existing promise if already initializing
  if (firebaseInitPromise) {
    return firebaseInitPromise;
  }

  // Create initialization promise
  firebaseInitPromise = (async () => {
  let attempts = 0;
  const maxAttempts = 100; // 5 seconds max wait (50ms * 100)
  
  while (!getFirebaseNamespace() && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 50));
    attempts++;
  }
  
  if (!getFirebaseNamespace()) {
    firebaseUnavailable = true;
    if (typeof window !== 'undefined') {
      window._mclbFirebaseUnavailable = true;
    }
    console.warn('Firebase SDK did not load in time. Continuing with API-only mode where possible.');
    return false;
  }

  // If firebase exists but is missing auth/database (common if another script loaded app-only),
  // try to recover by loading the compat service bundles and locking the global.
  await ensureFirebaseCompatServices();
  
  return initializeFirebase();
  })();

  return firebaseInitPromise;
}

/**
 * Check if Firebase is initialized
 */
function isFirebaseInitialized() {
  return firebaseInitialized;
}

/**
 * Wait for Firebase to be initialized
 */
async function waitForFirebaseInit() {
  if (firebaseInitialized) {
    return true;
  }
  if (firebaseInitPromise) {
    return await firebaseInitPromise;
  }
  return await waitForFirebaseAndInitialize();
}

// Initialize on load - wait for Firebase SDK to be available
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    waitForFirebaseAndInitialize();
  });
} else {
  waitForFirebaseAndInitialize();
}
