// MC Leaderboards - UI Enhancements
// Toast notifications, back-to-top button, keyboard shortcuts, character counters, confirmation dialogs

// ===== 1. Toast Notification System =====
const Toast = (() => {
  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function show(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
      success: 'fa-circle-check',
      error: 'fa-circle-xmark',
      warning: 'fa-triangle-exclamation',
      info: 'fa-circle-info'
    };

    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info} toast-icon"></i>
      <span class="toast-message">${message}</span>
      <button class="toast-close" onclick="this.parentElement.remove()"><i class="fas fa-xmark"></i></button>
    `;

    getContainer().appendChild(toast);

    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    if (duration > 0) {
      setTimeout(() => {
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', () => toast.remove());
      }, duration);
    }

    return toast;
  }

  return {
    success: (msg, dur) => show(msg, 'success', dur),
    error: (msg, dur) => show(msg, 'error', dur),
    warning: (msg, dur) => show(msg, 'warning', dur),
    info: (msg, dur) => show(msg, 'info', dur)
  };
})();

const MCLBUI = (() => {
  const SESSION_BANNER_ID = 'mclbSessionBanner';
  let swalPatched = false;

  function themedSwalConfig(config = {}) {
    return {
      background: 'var(--secondary-bg, #1a1d20)',
      color: 'var(--text-primary, #f3f4f6)',
      confirmButtonColor: 'var(--accent-color, #1eb681)',
      cancelButtonColor: 'var(--tertiary-bg, #24292e)',
      customClass: {
        popup: 'mclb-swal-popup',
        title: 'mclb-swal-title',
        htmlContainer: 'mclb-swal-content',
        footer: 'mclb-swal-footer',
        confirmButton: 'btn btn-primary mclb-swal-confirm',
        cancelButton: 'btn btn-secondary mclb-swal-cancel',
        actions: 'mclb-swal-actions',
        ...(config.customClass || {})
      },
      buttonsStyling: false,
      reverseButtons: true,
      ...config
    };
  }

  function patchSwal() {
    if (swalPatched || typeof Swal === 'undefined' || typeof Swal.fire !== 'function') {
      return;
    }

    const originalFire = Swal.fire.bind(Swal);
    Swal.fire = function patchedSwalFire(...args) {
      if (args.length === 1 && typeof args[0] === 'object') {
        return originalFire(themedSwalConfig(args[0]));
      }
      if (args.length >= 2) {
        const [title, text, icon] = args;
        return originalFire(themedSwalConfig({ title, text, icon }));
      }
      return originalFire(...args);
    };

    swalPatched = true;
  }

  function alert(config = {}) {
    patchSwal();
    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
      return Swal.fire(themedSwalConfig(config));
    }

    window.alert(config.text || config.title || 'Action completed.');
    return Promise.resolve({ isConfirmed: true });
  }

  function success(title, text, extra = {}) {
    return alert({ icon: 'success', title, text, ...extra });
  }

  function error(title, text, extra = {}) {
    return alert({ icon: 'error', title, text, ...extra });
  }

  function info(title, text, extra = {}) {
    return alert({ icon: 'info', title, text, ...extra });
  }

  function warning(title, text, extra = {}) {
    return alert({ icon: 'warning', title, text, ...extra });
  }

  function confirm(title, text, extra = {}) {
    return alert({
      icon: extra.icon || 'warning',
      title,
      text,
      showCancelButton: true,
      confirmButtonText: extra.confirmButtonText || 'Confirm',
      cancelButtonText: extra.cancelButtonText || 'Cancel',
      ...extra
    });
  }

  function setButtonBusy(button, busy, idleLabel = null, busyLabel = null) {
    if (!button) return;
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = idleLabel || button.innerHTML;
    }
    button.disabled = busy === true;
    button.classList.toggle('is-busy', busy === true);
    button.innerHTML = busy === true
      ? (busyLabel || '<i class="fas fa-spinner fa-spin"></i> Working...')
      : button.dataset.idleLabel;
  }

  function showSessionBanner(message = 'Your session expired. Please sign in again.') {
    let banner = document.getElementById(SESSION_BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = SESSION_BANNER_ID;
      banner.className = 'session-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      document.body.prepend(banner);
    }

    banner.innerHTML = `
      <div class="session-banner__content">
        <i class="fas fa-clock session-banner__icon" aria-hidden="true"></i>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
    banner.classList.add('is-visible');
  }

  function hideSessionBanner() {
    document.getElementById(SESSION_BANNER_ID)?.classList.remove('is-visible');
  }

  function setRouteLoading(target, loading, { skeletonCount = 3 } = {}) {
    if (!target) return;
    target.classList.toggle('is-route-loading', loading === true);

    if (loading === true) {
      target.dataset.routeLoading = 'true';
      target.innerHTML = Array.from({ length: skeletonCount }).map(() => `
        <div class="mclb-skeleton-card" aria-hidden="true">
          <div class="mclb-skeleton-line lg"></div>
          <div class="mclb-skeleton-line"></div>
          <div class="mclb-skeleton-line sm"></div>
        </div>
      `).join('');
      return;
    }

    delete target.dataset.routeLoading;
  }

  return {
    patchSwal,
    alert,
    success,
    error,
    info,
    warning,
    confirm,
    setButtonBusy,
    showSessionBanner,
    hideSessionBanner,
    setRouteLoading
  };
})();


// ===== 2. Confirmation Dialog =====
function confirmAction(title, message, confirmText = 'Confirm', type = 'warning') {
  if (typeof MCLBUI !== 'undefined') {
    return MCLBUI.confirm(title, message, {
      icon: type,
      confirmButtonText: confirmText
    }).then(result => result.isConfirmed);
  }
  return Promise.resolve(window.confirm(`${title}\n\n${message}`));
}


// ===== 3. Back-to-Top Button =====
function initBackToTop() {
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.className = 'back-to-top';
  btn.innerHTML = '<i class="fas fa-chevron-up"></i>';
  btn.title = 'Back to top';
  btn.setAttribute('aria-label', 'Scroll to top');
  document.body.appendChild(btn);

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        btn.classList.toggle('visible', window.scrollY > 300);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}


// ===== 4. Character Counter for Textareas =====
function initCharCounters() {
  document.querySelectorAll('textarea[maxlength], textarea[data-max-chars]').forEach(textarea => {
    const max = parseInt(textarea.getAttribute('maxlength') || textarea.dataset.maxChars, 10);
    if (!max || textarea.dataset.counterInit) return;
    textarea.dataset.counterInit = 'true';

    const counter = document.createElement('div');
    counter.className = 'char-counter';
    counter.textContent = `0 / ${max}`;
    textarea.parentNode.insertBefore(counter, textarea.nextSibling);

    textarea.addEventListener('input', () => {
      const len = textarea.value.length;
      counter.textContent = `${len} / ${max}`;
      counter.classList.toggle('char-counter-warn', len > max * 0.9);
      counter.classList.toggle('char-counter-full', len >= max);
    });
  });
}


// ===== 5. Keyboard Shortcuts =====
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger when typing in inputs
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;

    // Ctrl/Cmd + K -> Focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.focus();
    }

    // G then H -> Go home (leaderboard)
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      showKeyboardShortcutsHelp();
    }
  });

  // Sequence shortcuts (g+h, g+d, g+i, g+a)
  let lastKey = '';
  let lastKeyTime = 0;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const now = Date.now();
    if (now - lastKeyTime > 1000) lastKey = '';

    if (lastKey === 'g') {
      switch (e.key) {
        case 'h': window.location.href = 'index.html'; break;
        case 'd': window.location.href = 'dashboard.html'; break;
        case 'i': window.location.href = 'inbox.html'; break;
        case 'a': window.location.href = 'account.html'; break;
      }
      lastKey = '';
      return;
    }

    lastKey = e.key;
    lastKeyTime = now;
  });
}

function showKeyboardShortcutsHelp() {
  if (typeof MCLBUI !== 'undefined') {
    MCLBUI.alert({
      title: 'Keyboard Shortcuts',
      html: `
        <div style="text-align:left; font-size:0.9rem; line-height:2;">
          <div><kbd>Ctrl+K</kbd> — Focus search</div>
          <div><kbd>G</kbd> then <kbd>H</kbd> — Go to Leaderboards</div>
          <div><kbd>G</kbd> then <kbd>D</kbd> — Go to Dashboard</div>
          <div><kbd>G</kbd> then <kbd>I</kbd> — Go to Inbox</div>
          <div><kbd>G</kbd> then <kbd>A</kbd> — Go to Account</div>
          <div><kbd>?</kbd> — Show this help</div>
        </div>
      `,
      confirmButtonText: 'Got it'
    });
  }
}


// ===== 6. Staggered List Animations =====
function animateListItems(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  const items = container.children;
  for (let i = 0; i < items.length; i++) {
    items[i].style.opacity = '0';
    items[i].style.animation = `staggerFadeIn 0.3s ease forwards`;
    items[i].style.animationDelay = `${i * 0.04}s`;
  }
}


// ===== Initialize on DOM Load =====
document.addEventListener('DOMContentLoaded', () => {
  if (typeof MCLBUI !== 'undefined') {
    MCLBUI.patchSwal();
  }
  initBackToTop();
  initCharCounters();
  initKeyboardShortcuts();

  // Observe for dynamically added textareas (debounced to avoid CPU thrashing)
  let charCounterDebounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(charCounterDebounce);
    charCounterDebounce = setTimeout(initCharCounters, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

if (typeof window !== 'undefined') {
  window.MCLBUI = MCLBUI;
}
