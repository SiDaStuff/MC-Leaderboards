// MC Leaderboards - Shared Auth UX Helpers

const AuthUI = (() => {
  function setBusy(button, busy, idleLabel = null, busyLabel = null) {
    if (typeof MCLBUI !== 'undefined') {
      MCLBUI.setButtonBusy(button, busy, idleLabel, busyLabel);
      return;
    }

    if (!button) return;
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = idleLabel || button.innerHTML;
    }
    button.disabled = busy === true;
    button.innerHTML = busy === true
      ? (busyLabel || '<i class="fas fa-spinner fa-spin"></i> Working...')
      : button.dataset.idleLabel;
  }

  async function showError(title, message, extra = {}) {
    if (typeof MCLBUI !== 'undefined') {
      return MCLBUI.error(title, message, extra);
    }
    return Promise.resolve(window.alert(message || title));
  }

  async function showSuccess(title, message, extra = {}) {
    if (typeof MCLBUI !== 'undefined') {
      return MCLBUI.success(title, message, extra);
    }
    return Promise.resolve(window.alert(message || title));
  }

  async function showMessage({
    icon = 'info',
    title = 'Notice',
    text = '',
    html = '',
    footer = ''
  } = {}) {
    if (typeof MCLBUI !== 'undefined') {
      return MCLBUI.alert({
        icon,
        title,
        text,
        html,
        footer
      });
    }

    return Promise.resolve(window.alert(text || title));
  }

  function buildActionFooter(action = '', actionLinks = {}) {
    const footerByAction = {
      reset_password: '<a href="auth-action.html" class="auth-link-inline">Reset password</a>',
      check_email_or_signup: '<a href="signup.html" class="auth-link-inline">Create new account</a>',
      contact_support: '<a href="support.html" class="auth-link-inline">Contact support</a>',
      signin: '<a href="login.html" class="auth-link-inline">Sign in instead</a>',
      verify_email: `<a href="#" onclick="handleBlockedEmailVerification(); return false;" class="auth-link-inline">Resend verification email</a>`
    };

    return actionLinks[action] || footerByAction[action] || '';
  }

  async function showActionError(error, {
    fallbackTitle = 'Request Failed',
    actionLinks = {}
  } = {}) {
    const message = error?.userMessage || error?.message || 'Something went wrong.';
    const suggestion = error?.suggestion || '';
    const footerLink = buildActionFooter(error?.action || '', actionLinks);

    const html = escapeHtml([message, suggestion].filter(Boolean).join('\n\n')).replace(/\n/g, '<br>');

    return showMessage({
      icon: 'error',
      title: fallbackTitle,
      html,
      footer: footerLink ? `<div class="auth-modal-footer">${footerLink}</div>` : ''
    });
  }

  function getValidationMessage(fieldChecks = {}) {
    return Validator.firstError(fieldChecks);
  }

  async function requireAllowedAction(actionLabel, profile = null) {
    if (typeof ModerationState === 'undefined') {
      return true;
    }

    const moderation = ModerationState.resolve(profile);
    if (!moderation.accountChangesRestricted) {
      return true;
    }

    await showError('Restricted', ModerationState.getBlockingMessage(actionLabel, moderation.profile));
    return false;
  }

  async function promptForEmail({
    title = 'Enter your email',
    label = 'Email address',
    value = '',
    confirmButtonText = 'Continue'
  } = {}) {
    if (typeof MCLBUI === 'undefined') {
      return { value: window.prompt(label, value) || '' };
    }

    return MCLBUI.alert({
      title,
      input: 'email',
      inputLabel: label,
      inputValue: value,
      confirmButtonText,
      showCancelButton: true,
      inputValidator: (inputValue) => Validator.email(inputValue)
    });
  }

  async function runPasswordResetFlow(initialEmail = '') {
    const result = await promptForEmail({
      title: 'Reset Password',
      label: 'Enter your email address',
      value: initialEmail,
      confirmButtonText: 'Send Reset Link'
    });

    const email = result?.value || '';
    if (!email) return false;

    await firebaseAuthService.sendPasswordResetEmail(email);
    await showSuccess('Email Sent', 'Check your inbox for password reset instructions.');
    return true;
  }

  return {
    setBusy,
    showError,
    showSuccess,
    showMessage,
    showActionError,
    getValidationMessage,
    requireAllowedAction,
    promptForEmail,
    runPasswordResetFlow
  };
})();

if (typeof window !== 'undefined') {
  window.AuthUI = AuthUI;
}
