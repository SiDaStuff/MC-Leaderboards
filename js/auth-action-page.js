// MC Leaderboards - Email verification and password reset action pages

(function () {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('mode') || '';
  const pageMode = document.body?.dataset?.authActionPage || '';

  const elements = {
    kicker: document.getElementById('authActionKicker'),
    heroIcon: document.getElementById('authActionHeroIcon'),
    title: document.getElementById('authActionTitle'),
    detail: document.getElementById('authActionDetail'),
    spinner: document.getElementById('authActionSpinner'),
    status: document.getElementById('authActionStatus'),
    note: document.getElementById('authActionNote'),
    meta: document.getElementById('authActionMeta'),
    form: document.getElementById('authActionForm'),
    actions: document.getElementById('authActionActions')
  };

  function resolveMode() {
    if (pageMode && pageMode !== 'auto') {
      return pageMode;
    }
    if (requestedMode === 'verifyEmail') {
      return 'verifyEmail';
    }
    if (requestedMode === 'resetPassword') {
      return 'resetPassword';
    }
    return 'unknown';
  }

  function configurePageChrome(mode) {
    if (!elements.kicker || !elements.heroIcon) return;

    if (mode === 'verifyEmail') {
      elements.kicker.textContent = 'Email Verification';
      elements.heroIcon.className = 'fas fa-envelope-circle-check';
      return;
    }

    if (mode === 'resetPassword') {
      elements.kicker.textContent = 'Password Reset';
      elements.heroIcon.className = 'fas fa-key';
      return;
    }

    elements.kicker.textContent = 'Account Action';
    elements.heroIcon.className = 'fas fa-shield-halved';
  }

  function getAuthInstanceSafe() {
    if (typeof getAuth === 'function') {
      return getAuth();
    }
    if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
      return firebase.auth();
    }
    throw new Error('Firebase auth is not initialized.');
  }

  function setSpinnerVisible(visible) {
    if (elements.spinner) {
      elements.spinner.style.display = visible ? 'block' : 'none';
    }
  }

  function setText(target, value) {
    if (target) {
      target.textContent = value || '';
    }
  }

  function setNote(text = '', tone = '') {
    if (!elements.note) return;
    if (!text) {
      elements.note.style.display = 'none';
      elements.note.className = 'auth-action-note';
      elements.note.textContent = '';
      return;
    }
    elements.note.style.display = 'block';
    elements.note.className = `auth-action-note${tone ? ` is-${tone}` : ''}`;
    elements.note.textContent = text;
  }

  function setMeta(text = '') {
    if (!elements.meta) return;
    elements.meta.style.display = text ? 'block' : 'none';
    elements.meta.textContent = text;
  }

  function clearForm() {
    if (!elements.form) return;
    elements.form.innerHTML = '';
    elements.form.style.display = 'none';
  }

  function setActions(actions = [], inline = false) {
    if (!elements.actions) return;
    if (!actions.length) {
      elements.actions.innerHTML = '';
      elements.actions.style.display = 'none';
      elements.actions.className = 'auth-action-actions';
      return;
    }

    elements.actions.className = `auth-action-actions${inline ? ' is-inline' : ''}`;
    elements.actions.innerHTML = actions.map((action) => {
      const href = action.href ? ` href="${escapeHtml(action.href)}"` : '';
      const id = action.id ? ` id="${escapeHtml(action.id)}"` : '';
      const type = action.href ? 'a' : 'button';
      const extra = action.href ? '' : ' type="button"';
      return `<${type}${href}${id}${extra} class="btn ${action.variant || 'btn-secondary'} btn-block">${action.label}</${type}>`;
    }).join('');
    elements.actions.style.display = 'grid';

    actions.forEach((action) => {
      if (action.id && typeof action.onClick === 'function') {
        const el = document.getElementById(action.id);
        if (el) el.addEventListener('click', action.onClick);
      }
    });
  }

  function setLoadingState({
    title,
    detail,
    status
  }) {
    setText(elements.title, title);
    setText(elements.detail, detail);
    setText(elements.status, status || '');
    setSpinnerVisible(true);
    setNote('');
    setMeta('');
    clearForm();
    setActions([]);
  }

  function buildContinueTarget() {
    const continueUrl = params.get('continueUrl');
    if (!continueUrl) {
      return 'login.html';
    }

    try {
      const decoded = new URL(continueUrl, window.location.origin);
      if (decoded.origin !== window.location.origin) {
        return 'login.html';
      }
      return `${decoded.pathname}${decoded.search}${decoded.hash}` || 'login.html';
    } catch (_) {
      return 'login.html';
    }
  }

  function setButtonBusy(button, busy, idleLabel, busyLabel) {
    if (!button) return;
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = idleLabel || button.innerHTML;
    }
    button.disabled = busy === true;
    button.innerHTML = busy === true
      ? busyLabel
      : (idleLabel || button.dataset.idleLabel);
  }

  async function handleVerifyEmailPage() {
    const oobCode = params.get('oobCode');
    const incomingMode = params.get('mode');
    const continueTarget = buildContinueTarget();

    if (!oobCode || (incomingMode && incomingMode !== 'verifyEmail')) {
      setSpinnerVisible(false);
      setText(elements.title, 'Open your verification email');
      setText(elements.detail, 'Use the verification link from your inbox to finish confirming your email address.');
      setText(elements.status, '');
      setNote('If your verification link expired, return to the login page and request a new verification email.');
      setActions([
        { href: 'login.html', label: 'Back to Login', variant: 'btn-primary' },
        { href: 'signup.html', label: 'Create Account', variant: 'btn-secondary' }
      ], true);
      return;
    }

    setLoadingState({
      title: 'Verifying your email',
      detail: 'Please wait while we confirm your email address and unlock sign-in.',
      status: 'Applying verification code...'
    });

    try {
      const auth = getAuthInstanceSafe();
      await auth.applyActionCode(oobCode);

      if (auth.currentUser && typeof auth.currentUser.reload === 'function') {
        await auth.currentUser.reload().catch(() => null);
      }

      setSpinnerVisible(false);
      setText(elements.title, 'Email verified');
      setText(elements.detail, 'Your account email is now confirmed. You can continue back into MC Leaderboards.');
      setText(elements.status, 'Verification completed successfully.');
      setNote('You can now sign in normally. If this tab was opened from your account page, you can also return there directly.', 'success');
      setActions([
        { href: continueTarget, label: 'Continue', variant: 'btn-primary' },
        { href: 'login.html', label: 'Go to Login', variant: 'btn-secondary' }
      ], true);
    } catch (error) {
      const normalizedError = typeof firebaseAuthService?.handleAuthError === 'function'
        ? firebaseAuthService.handleAuthError(error)
        : error;
      setSpinnerVisible(false);
      setText(elements.title, 'Verification link unavailable');
      setText(elements.detail, 'This verification link is invalid or has expired.');
      setText(elements.status, '');
      setNote(normalizedError?.userMessage || normalizedError?.message || 'Please request a new verification email and try again.', 'error');
      setActions([
        { href: 'login.html', label: 'Back to Login', variant: 'btn-primary' },
        { href: 'signup.html', label: 'Need an account?', variant: 'btn-secondary' }
      ], true);
    }
  }

  function renderRequestResetForm(prefillEmail = '') {
    clearForm();
    if (!elements.form) return;

    setSpinnerVisible(false);
    setText(elements.title, 'Reset your password');
    setText(elements.detail, 'Enter your account email and we will send you a fresh password reset link.');
    setText(elements.status, '');
    setMeta('');
    setActions([
      { href: 'login.html', label: 'Back to Login', variant: 'btn-secondary' }
    ]);

    elements.form.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="resetEmail">Email</label>
        <input type="email" class="form-input" id="resetEmail" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(prefillEmail)}" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block" id="requestResetBtn">Send Reset Email</button>
    `;
    elements.form.style.display = 'grid';
    elements.form.onsubmit = async (event) => {
      event.preventDefault();
      const email = document.getElementById('resetEmail')?.value?.trim() || '';
      const validationError = Validator.email(email);
      if (validationError) {
        setNote(validationError, 'error');
        return;
      }

      const submitBtn = document.getElementById('requestResetBtn');
      setNote('');
      setButtonBusy(
        submitBtn,
        true,
        'Send Reset Email',
        '<img src="assets/spinner.png" alt="" class="inline-spinner-icon" aria-hidden="true">Sending reset email...'
      );

      try {
        await firebaseAuthService.sendPasswordResetEmail(email);
        clearForm();
        setText(elements.title, 'Reset email sent');
        setText(elements.detail, 'Check your inbox for a secure password reset link.');
        setText(elements.status, 'Email delivery requested successfully.');
        setNote(`We sent password reset instructions to ${email}.`, 'success');
        setActions([
          { href: 'login.html', label: 'Back to Login', variant: 'btn-primary' },
          { id: 'sendAnotherResetBtn', label: 'Send Another Email', variant: 'btn-secondary', onClick: () => renderRequestResetForm(email) }
        ], true);
      } catch (error) {
        const normalizedError = typeof firebaseAuthService?.handleAuthError === 'function'
          ? firebaseAuthService.handleAuthError(error)
          : error;
        setNote(normalizedError?.userMessage || normalizedError?.message || 'Unable to send reset email right now.', 'error');
      } finally {
        setButtonBusy(submitBtn, false, 'Send Reset Email');
      }
    };
  }

  function renderConfirmResetForm(email, oobCode) {
    clearForm();
    if (!elements.form) return;

    setSpinnerVisible(false);
    setText(elements.title, 'Choose a new password');
    setText(elements.detail, 'Set a new password for your account and then sign back in.');
    setText(elements.status, '');
    setMeta(`Resetting password for ${email}`);
    setActions([
      { href: 'login.html', label: 'Back to Login', variant: 'btn-secondary' }
    ]);

    elements.form.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="newPassword">New password</label>
        <input type="password" class="form-input" id="newPassword" autocomplete="new-password" placeholder="At least 6 characters" required>
      </div>
      <div class="form-group">
        <label class="form-label" for="confirmPassword">Confirm new password</label>
        <input type="password" class="form-input" id="confirmPassword" autocomplete="new-password" placeholder="Repeat your new password" required>
      </div>
      <button type="submit" class="btn btn-primary btn-block" id="confirmResetBtn">Save New Password</button>
    `;
    elements.form.style.display = 'grid';
    elements.form.onsubmit = async (event) => {
      event.preventDefault();
      const password = document.getElementById('newPassword')?.value || '';
      const confirmPassword = document.getElementById('confirmPassword')?.value || '';

      const validationError = Validator.combine(
        Validator.required(password, 'Please enter a new password.'),
        password.length < 6 ? 'Your new password must be at least 6 characters long.' : '',
        password !== confirmPassword ? 'Your passwords do not match.' : ''
      );

      if (validationError) {
        setNote(validationError, 'error');
        return;
      }

      const submitBtn = document.getElementById('confirmResetBtn');
      setNote('');
      setSpinnerVisible(true);
      setText(elements.status, 'Saving your new password...');
      setButtonBusy(
        submitBtn,
        true,
        'Save New Password',
        '<img src="assets/spinner.png" alt="" class="inline-spinner-icon" aria-hidden="true">Saving password...'
      );

      try {
        const auth = getAuthInstanceSafe();
        await auth.confirmPasswordReset(oobCode, password);
        clearForm();
        setSpinnerVisible(false);
        setText(elements.title, 'Password updated');
        setText(elements.detail, 'Your password has been reset successfully. You can sign in with the new password now.');
        setText(elements.status, 'Password reset complete.');
        setNote('Use your new password the next time you sign in.', 'success');
        setActions([
          { href: `login.html?email=${encodeURIComponent(email)}`, label: 'Sign In', variant: 'btn-primary' },
          { id: 'newResetLinkBtn', label: 'Need Another Reset Link?', variant: 'btn-secondary', onClick: () => renderRequestResetForm(email) }
        ], true);
      } catch (error) {
        const normalizedError = typeof firebaseAuthService?.handleAuthError === 'function'
          ? firebaseAuthService.handleAuthError(error)
          : error;
        setSpinnerVisible(false);
        setText(elements.status, '');
        setNote(normalizedError?.userMessage || normalizedError?.message || 'Unable to reset password with this link.', 'error');
      } finally {
        setButtonBusy(submitBtn, false, 'Save New Password');
      }
    };
  }

  async function handleResetPasswordPage() {
    const oobCode = params.get('oobCode');
    const incomingMode = params.get('mode');
    const prefillEmail = params.get('email') || '';

    if (!oobCode || (incomingMode && incomingMode !== 'resetPassword')) {
      renderRequestResetForm(prefillEmail);
      return;
    }

    setLoadingState({
      title: 'Checking reset link',
      detail: 'Please wait while we verify that your password reset link is still valid.',
      status: 'Verifying reset code...'
    });

    try {
      const auth = getAuthInstanceSafe();
      const email = await auth.verifyPasswordResetCode(oobCode);
      renderConfirmResetForm(email, oobCode);
    } catch (error) {
      const normalizedError = typeof firebaseAuthService?.handleAuthError === 'function'
        ? firebaseAuthService.handleAuthError(error)
        : error;
      renderRequestResetForm(prefillEmail);
      setNote(normalizedError?.userMessage || normalizedError?.message || 'This reset link is invalid or has expired.', 'error');
    }
  }

  async function init() {
    try {
      if (typeof waitForFirebaseInit !== 'undefined') {
        await waitForFirebaseInit();
      }

      const mode = resolveMode();
      configurePageChrome(mode);

      if (mode === 'verifyEmail') {
        await handleVerifyEmailPage();
        return;
      }

      if (mode === 'resetPassword') {
        await handleResetPasswordPage();
        return;
      }

      setSpinnerVisible(false);
      setText(elements.title, 'Unsupported account action');
      setText(elements.detail, 'This secure link does not include a supported Firebase action mode.');
      setText(elements.status, '');
      setNote('Use the most recent email from MC Leaderboards, or request a fresh verification or password reset email.', 'error');
      setActions([
        { href: 'login.html', label: 'Back to Login', variant: 'btn-primary' }
      ]);
    } catch (error) {
      setSpinnerVisible(false);
      setText(elements.title, 'Unable to load this page');
      setText(elements.detail, 'We could not initialize the secure action handler right now.');
      setText(elements.status, '');
      setNote(error?.message || 'Please try again in a moment.', 'error');
      setActions([
        { href: 'login.html', label: 'Back to Login', variant: 'btn-primary' }
      ]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
