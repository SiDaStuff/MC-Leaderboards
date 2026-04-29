// MC Leaderboards - Login Page

const LOGIN_NOTICE_STORAGE_KEY = 'mclb_login_notice';

function setLoginAuthOverlay(visible, {
  title = 'Securing your sign-in',
  detail = 'Please wait while we verify your credentials and finish signing you in.'
} = {}) {
  const overlay = document.getElementById('loginAuthOverlay');
  const titleEl = document.getElementById('loginAuthOverlayTitle');
  const detailEl = document.getElementById('loginAuthOverlayDetail');
  if (!overlay) return;

  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;

  overlay.classList.toggle('is-visible', visible === true);
  overlay.setAttribute('aria-hidden', visible === true ? 'false' : 'true');
  document.body.style.overflow = visible === true ? 'hidden' : '';
}

function resetLoginBusyState(button = null) {
  setLoginAuthOverlay(false);
  if (button) {
    AuthUI.setBusy(button, false);
  }
}

window.mclbBeforeSwalOpen = function closeLoginOverlayBeforeAlert() {
  setLoginAuthOverlay(false);
  if (window.mclbLoadingOverlay && typeof window.mclbLoadingOverlay.hide === 'function') {
    window.mclbLoadingOverlay.hide();
  }
};

async function showQueuedLoginNotice() {
  let rawNotice = null;
  try {
    rawNotice = window.sessionStorage.getItem(LOGIN_NOTICE_STORAGE_KEY);
    if (rawNotice) {
      window.sessionStorage.removeItem(LOGIN_NOTICE_STORAGE_KEY);
    }
  } catch (_) {
    rawNotice = null;
  }

  if (!rawNotice) return;

  try {
    const notice = JSON.parse(rawNotice);
    await MCLBUI.alert({
      icon: notice.icon || 'error',
      title: notice.title || 'Session Ended',
      text: notice.text || 'Your session has ended. Please sign in again.',
      confirmButtonText: 'OK'
    });
  } catch (error) {
    console.warn('Failed to show queued login notice:', error);
  }
}

async function showLoginQueryNotice() {
  try {
    const params = new URLSearchParams(window.location.search);
    const email = params.get('email');
    const emailVerified = params.get('emailVerified');

    if (email) {
      const emailInput = document.getElementById('email');
      if (emailInput && !emailInput.value) {
        emailInput.value = email;
      }
    }

    if (emailVerified === '1') {
      const cleanUrl = `${window.location.pathname}${email ? `?email=${encodeURIComponent(email)}` : ''}`;
      window.history.replaceState({}, document.title, cleanUrl);
      await MCLBUI.success('Email Verified', 'Your email address has been verified. You can sign in now.');
    }
  } catch (error) {
    console.warn('Failed to show login query notice:', error);
  }
}

async function fetchLoginClientIp() {
  return null;
}

async function showLoginError(error, fallbackTitle = 'Login Failed') {
  const errorMessage = error?.userMessage || error?.message || 'Login failed';
  const suggestion = error?.suggestion || '';
  const action = error?.action || '';

  let message = errorMessage;
  if (suggestion) {
    message += `\n\n${suggestion}`;
  }

  let footer = '';
  if (action === 'reset_password') {
    footer = '<a href="#" onclick="handlePasswordReset(event)" class="auth-link-inline">Reset password</a>';
  } else if (action === 'check_email_or_signup') {
    footer = '<a href="signup.html" class="auth-link-inline">Create new account</a>';
  } else if (action === 'contact_support') {
    footer = '<a href="support.html" class="auth-link-inline">Contact support</a>';
  } else if (action === 'verify_email') {
    footer = '<a href="#" onclick="handleBlockedEmailVerification(); return false;" class="auth-link-inline">Resend verification email</a>';
  }

  await MCLBUI.alert({
    icon: 'error',
    title: fallbackTitle,
    html: escapeHtml(message).replace(/\n/g, '<br>'),
    footer: footer ? `<div style="margin-top: 0.75rem; text-align: center;">${footer}</div>` : undefined,
    confirmButtonText: 'OK'
  });
}

async function handleBlockedEmailVerification({ email, password } = {}) {
  const auth = typeof getAuth === 'function' ? getAuth() : firebase.auth();
  const resolvedEmail = email || document.getElementById('email')?.value?.trim() || 'your email address';
  const resolvedPassword = password || document.getElementById('password')?.value || '';

  setLoginAuthOverlay(false);
  await firebaseAuthService.signOut().catch(() => null);

  try {
    const result = await MCLBUI.alert({
      icon: 'warning',
      title: 'Verify Your Email First',
      text: `We sent a verification link to ${resolvedEmail}. Verify your email before signing in. You can resend the verification email now.`,
      confirmButtonText: 'Resend Verification Email',
      showCancelButton: true,
      cancelButtonText: 'Back to Login'
    });

    if (result.isConfirmed) {
      if (!resolvedEmail || !resolvedPassword) {
        throw new Error('Please enter your email and password again so we can resend the verification email.');
      }

      const userCredential = await auth.signInWithEmailAndPassword(resolvedEmail, resolvedPassword);
      const resendUser = userCredential?.user;
      if (!resendUser) {
        throw new Error('Unable to restore your session to resend the verification email.');
      }

      await firebaseAuthService.sendEmailVerification({ user: resendUser, mode: 'signin' });
      await MCLBUI.success('Verification Sent', `A new verification email was sent to ${resolvedEmail}.`);
    }
  } catch (error) {
    await MCLBUI.error(
      'Unable to Resend Verification Email',
      error.userMessage || error.message || 'Please try again in a moment.'
    );
  } finally {
    await firebaseAuthService.signOut().catch(() => null);
  }
}

async function handleBannedSignInError(error) {
  if (error?.alreadyPresented === true) {
    await firebaseAuthService.signOut().catch(() => null);
    return true;
  }

  if (error?.code !== 'ACCOUNT_BANNED') {
    return false;
  }

  await firebaseAuthService.showBanPopup({
    banReason: error?.data?.message || error?.data?.reason || error?.userMessage || 'This account has been banned.',
    bannedAt: error?.data?.bannedAt || null,
    banDuration: error?.data?.timeRemainingText || null,
    timeRemaining: error?.data?.timeRemaining || null,
    isPermanent: error?.data?.isPermanent === true,
    type: 'Banned'
  });
  await firebaseAuthService.signOut().catch(() => null);
  return true;
}

window.handleLogin = async function handleLogin(event) {
  event.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const loginBtn = document.getElementById('loginBtn');

  const validationError = Validator.combine(
    Validator.email(email),
    Validator.required(password, 'Please enter your password.')
  );
  if (validationError) {
    await MCLBUI.warning('Missing Information', validationError);
    return;
  }

  AuthUI.setBusy(loginBtn, true, null, '<i class="fas fa-spinner fa-spin"></i> Signing in...');
  setLoginAuthOverlay(true, {
    title: 'Signing you in',
    detail: 'We are checking your credentials, securing your session, and validating account access.'
  });

  try {
    const clientIP = await fetchLoginClientIp();
    const user = await firebaseAuthService.signIn(email, password);
    const session = await firebaseAuthService.completeLoginSession({ user, clientIP });
    navigateTo(session.redirectTo || 'dashboard.html');
  } catch (error) {
    console.error('Login error:', error);
    resetLoginBusyState(loginBtn);

    if (await handleBannedSignInError(error)) {
      return;
    }

    if (error.message && error.message.includes('banned')) {
      return;
    }

    if (error?.action === 'verify_email') {
      await firebaseAuthService.signOut().catch(() => null);
      await handleBlockedEmailVerification({ email, password });
      return;
    }

    await showLoginError(error, 'Login Failed');
  } finally {
    resetLoginBusyState(loginBtn);
  }
};

window.handleGoogleLogin = async function handleGoogleLogin(event) {
  event.preventDefault();

  const googleBtn = document.getElementById('googleLoginBtn');
  AuthUI.setBusy(googleBtn, true, null, '<i class="fas fa-spinner fa-spin"></i> Connecting...');
  setLoginAuthOverlay(true, {
    title: 'Connecting to Google',
    detail: 'We are authenticating with Google and locking down your session before access is granted.'
  });

  try {
    const clientIP = await fetchLoginClientIp();
    const session = await firebaseAuthService.signInWithGoogle({ clientIP });
    navigateTo(session.redirectTo || 'dashboard.html');
  } catch (error) {
    console.error('Google login error:', error);
    resetLoginBusyState(googleBtn);

    if (await handleBannedSignInError(error)) {
      return;
    }

    await showLoginError(error, 'Google Sign-in Failed');
  } finally {
    resetLoginBusyState(googleBtn);
  }
};

window.handlePasswordReset = async function handlePasswordReset(event) {
  if (event) event.preventDefault();
  try {
    await AuthUI.runPasswordResetFlow(document.getElementById('email')?.value?.trim() || '');
  } catch (error) {
    await showLoginError(error, 'Password Reset Failed');
  }
};

window.handleBlockedEmailVerification = handleBlockedEmailVerification;

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof showQueuedNavigationNotice === 'function') {
    await showQueuedNavigationNotice();
  }
  await showQueuedLoginNotice();
  await showLoginQueryNotice();

  while (typeof requireGuest !== 'function') {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let attempts = 0;
  while ((typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) && attempts < 100) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempts++;
  }

  if (typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) {
    console.error('Firebase failed to initialize');
    return;
  }

  const isGuest = await requireGuest();
  if (!isGuest) return;
});
