// MC Leaderboards - Signup Page

let signupSubmissionInFlight = false;
let googleSignupInFlight = false;
let cachedSignupClientIpPromise = null;

function getSignupAgeValue() {
  return document.getElementById('over13Checkbox')?.checked ? 13 : null;
}

function fetchSignupClientIp() {
  if (!cachedSignupClientIpPromise) {
    // The backend resolves the real client IP from the request.
    cachedSignupClientIpPromise = Promise.resolve(null);
  }
  return cachedSignupClientIpPromise;
}

async function preflightSignup({ age, clientIP = null } = {}) {
  const recaptchaAction = 'post_auth_register_preflight';
  const recaptchaToken = await apiService.getRecaptchaToken(recaptchaAction);
  const response = await fetch('/api/auth/register-preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Recaptcha-Token': recaptchaToken,
      'X-Recaptcha-Action': recaptchaAction
    },
    body: JSON.stringify({
      age,
      ...(clientIP ? { clientIP } : {})
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || 'Registration preflight failed');
    error.response = result;
    error.code = result.code || null;
    throw error;
  }

  return result;
}

function setSignupUiState(isBusy, mode) {
  const signupBtn = document.getElementById('signupBtn');
  const googleBtn = document.getElementById('googleSignupBtn');
  const form = document.getElementById('signupForm');

  if (form) {
    form.setAttribute('aria-busy', String(isBusy));
  }

  AuthUI.setBusy(signupBtn, isBusy && mode === 'email', '<i class="fas fa-user-plus"></i> Create Account', '<i class="fas fa-spinner fa-spin"></i> Creating account...');
  AuthUI.setBusy(googleBtn, isBusy && mode === 'google', '<i class="fab fa-google"></i> Sign up with Google', '<i class="fas fa-spinner fa-spin"></i> Connecting...');

  if (signupBtn) signupBtn.disabled = isBusy;
  if (googleBtn) googleBtn.disabled = isBusy;
}

window.mclbBeforeSwalOpen = function closeSignupOverlayBeforeAlert() {
  if (window.mclbLoadingOverlay && typeof window.mclbLoadingOverlay.hide === 'function') {
    window.mclbLoadingOverlay.hide();
  }
};

async function ensureApiTokenReady(preferredUser = null, maxAttempts = 40) {
  if (window.firebaseAuthService && typeof window.firebaseAuthService.ensureApiTokenReady === 'function') {
    return window.firebaseAuthService.ensureApiTokenReady(preferredUser, {
      maxAttempts,
      forceRefresh: false
    });
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const auth = firebase.auth();
    const currentUser = auth.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken(attempt > 0);
      apiService.setToken(token);
      return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Authentication token was not ready in time. Please try again.');
}

function setProfileBootstrapPending(isPending) {
  if (window.firebaseAuthService && typeof window.firebaseAuthService.setProfileBootstrapPending === 'function') {
    window.firebaseAuthService.setProfileBootstrapPending(isPending);
  }
}

async function finalizeSignupProfile(userId) {
  setProfileBootstrapPending(false);
  apiService.clearCache('/users/me');

  if (userId) {
    await firebaseAuthService.fetchUserProfile(userId);
  }
}

async function completeEmailSignupVerificationFlow(email) {
  try {
    await firebaseAuthService.signOut();
  } catch (error) {
    console.warn('Unable to fully sign out after email signup:', error);
  } finally {
    setProfileBootstrapPending(false);
  }

  await MCLBUI.success(
    'Verify Your Email',
    `We sent a verification link to ${email}. Verify your email before signing in or starting onboarding.`
  );

  navigateToLogin({ replace: true });
}

async function cleanupFailedEmailSignup(user) {
  if (!user) {
    await firebaseAuthService.signOut().catch(() => null);
    return;
  }

  try {
    await user.delete();
  } catch (deleteError) {
    console.warn('Failed to delete Firebase user after signup error:', deleteError);
    await firebaseAuthService.signOut().catch(() => null);
  }
}

function mapSignupError(error) {
  let errorMessage = error.userMessage || error.message || 'Sign up failed';
  let suggestion = error.suggestion || '';
  let action = error.action || '';

  const backendCode = error.code || error.response?.code || '';
  const backendMessage = error.response?.message || error.message || '';
  const backendErrors = {
    MISSING_DATA: {
      message: 'Required information is missing.',
      suggestion: 'Please make sure you filled in all required fields.',
      action: 'check_fields'
    },
    AGE_VERIFICATION_FAILED: {
      message: 'You must be at least 13 years old to create an account.',
      suggestion: 'This is required by our Terms of Service.',
      action: 'contact_support'
    },
    DUPLICATE_IP_DETECTED: {
      message: 'This network already has a registered account.',
      suggestion: 'Multiple accounts per network are not permitted.',
      action: 'contact_support'
    },
    PROFANITY_DETECTED: {
      message: 'Your Minecraft username contains inappropriate language.',
      suggestion: 'Please choose a different username that follows our community guidelines.',
      action: 'change_username'
    },
    FILTER_UNAVAILABLE: {
      message: 'Content verification is temporarily unavailable.',
      suggestion: 'Please try again in a few minutes.',
      action: 'try_later'
    },
    ACCOUNT_BANNED: {
      message: 'This email address is associated with a restricted account.',
      suggestion: 'Please contact support if you believe this is a mistake.',
      action: 'contact_support'
    },
    SERVER_ERROR: {
      message: 'A server error occurred while creating your account.',
      suggestion: 'Please try again in a few moments.',
      action: 'try_later'
    }
  };

  if (backendCode && backendErrors[backendCode]) {
    errorMessage = backendErrors[backendCode].message;
    suggestion = backendErrors[backendCode].suggestion;
    action = backendErrors[backendCode].action;
  } else if (backendMessage && !error.userMessage) {
    errorMessage = backendMessage;
    suggestion = 'If this problem persists, please contact support.';
    action = 'contact_support';
  }

  const enhanced = new Error([errorMessage, suggestion].filter(Boolean).join('\n\n'));
  enhanced.code = backendCode || error.code || null;
  enhanced.userMessage = errorMessage;
  enhanced.suggestion = suggestion;
  enhanced.action = action;
  return enhanced;
}

async function ensureGuestReady() {
  while (typeof requireGuest !== 'function') {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let attempts = 0;
  while ((typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) && attempts < 100) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempts++;
  }

  if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
    throw new Error('Firebase failed to initialize');
  }
}

window.handleSignup = async function handleSignup(event) {
  event.preventDefault();

  if (signupSubmissionInFlight || googleSignupInFlight) {
    return;
  }

  if (typeof firebase === 'undefined' || !firebase.auth) {
    await AuthUI.showError('Service Unavailable', 'Authentication service is not ready. Please refresh the page.');
    return;
  }

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  const age = getSignupAgeValue();

  const validationError = Validator.firstError({
    email: Validator.email(email),
    password: Validator.minLength(password, 6, 'Password must be at least 6 characters long.'),
    confirmPassword: Validator.match(confirmPassword, password, 'Passwords do not match.'),
    age: age ? null : 'You must confirm that you are over 13 to create an account.'
  });

  if (validationError) {
    await AuthUI.showError('Check Your Details', validationError);
    return;
  }

  signupSubmissionInFlight = true;
  setSignupUiState(true, 'email');
  setProfileBootstrapPending(true);
  let createdUser = null;

  try {
    if (window.mclbLoadingOverlay) {
      window.mclbLoadingOverlay.updateStatus('Creating your account...', 88);
    }

    const clientIP = await fetchSignupClientIp();
    await preflightSignup({ age, clientIP });

    createdUser = await firebaseAuthService.signUp(email, password);
    await ensureApiTokenReady(createdUser);
    const recaptchaAction = 'post_auth_register';
    const recaptchaToken = await apiService.getRecaptchaToken(recaptchaAction);

    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiService.getToken()}`,
        'X-Recaptcha-Token': recaptchaToken,
        'X-Recaptcha-Action': recaptchaAction
      },
      body: JSON.stringify({
        email,
        firebaseUid: createdUser.uid,
        minecraftUsername: null,
        ...(clientIP ? { clientIP } : {}),
        age
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const backendError = new Error(result.message || 'Registration failed');
      backendError.response = result;
      backendError.code = result.code || null;
      throw backendError;
    }

    await completeEmailSignupVerificationFlow(email);
  } catch (error) {
    if (createdUser) {
      await cleanupFailedEmailSignup(createdUser);
    }
    await AuthUI.showActionError(mapSignupError(error), { fallbackTitle: 'Sign Up Failed' });
  } finally {
    setProfileBootstrapPending(false);
    signupSubmissionInFlight = false;
    setSignupUiState(false, 'email');
  }
};

window.handleGoogleSignup = async function handleGoogleSignup(event) {
  event.preventDefault();

  if (signupSubmissionInFlight || googleSignupInFlight) {
    return;
  }

  if (typeof firebase === 'undefined' || !firebase.auth) {
    await AuthUI.showError('Service Unavailable', 'Authentication service is not ready. Please refresh the page.');
    return;
  }

  const age = getSignupAgeValue();
  const ageError = age ? null : 'Please confirm that you are over 13 before signing up with Google.';
  if (ageError) {
    await AuthUI.showError('Age Required', ageError);
    return;
  }

  googleSignupInFlight = true;
  setSignupUiState(true, 'google');
  setProfileBootstrapPending(true);

  try {
    if (window.mclbLoadingOverlay) {
      window.mclbLoadingOverlay.updateStatus('Connecting to Google...', 88);
    }

    const clientIP = await fetchSignupClientIp();
    await preflightSignup({ age, clientIP });
    const user = await firebaseAuthService.signUpWithGoogle({ age, clientIP });
    await finalizeSignupProfile(user?.uid || null);

    await MCLBUI.success('Account Created', 'Redirecting you to onboarding...', {
      timer: 1500,
      showConfirmButton: false
    });
    navigateTo('onboarding.html', { replace: true });
  } catch (error) {
    await AuthUI.showActionError(mapSignupError(error), { fallbackTitle: 'Google Sign-up Failed' });
  } finally {
    setProfileBootstrapPending(false);
    googleSignupInFlight = false;
    setSignupUiState(false, 'google');
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof showQueuedNavigationNotice === 'function') {
    await showQueuedNavigationNotice();
  }

  try {
    await ensureGuestReady();
  } catch (error) {
    console.error(error.message || error);
    return;
  }

  const isGuest = await requireGuest();
  if (!isGuest) return;
});
