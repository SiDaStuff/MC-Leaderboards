// MC Leaderboards - Navigation Management

const NAVIGATION_NOTICE_STORAGE_KEY = 'mclb_navigation_notice';
const STATIC_PAGE_NAMES = new Set([
  '404',
  'account',
  'admin',
  'blacklisted',
  'dashboard',
  'easteregg',
  'error',
  'inbox',
  'index',
  'login',
  'moderation',
  'news',
  'onboarding',
  'player',
  'plus',
  'privacy-policy',
  'report',
  'rules',
  'signup',
  'support',
  'terms-of-service',
  'testing',
  'tier-tester-application'
]);
let linkRewriteObserverStarted = false;

function isFileProtocol() {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

function isSkippableHref(path) {
  return !path ||
    path.startsWith('#') ||
    path.startsWith('mailto:') ||
    path.startsWith('tel:') ||
    path.startsWith('javascript:');
}

function stripHtmlExtension(pathname) {
  if (!pathname) return '/';

  const normalizedPath = pathname.replace(/\/{2,}/g, '/');
  const collapsedIndex = normalizedPath.replace(/\/index(?:\.html)?$/i, '/');
  const trimmedPath = collapsedIndex.length > 1
    ? collapsedIndex.replace(/\/+$/g, '')
    : collapsedIndex;

  if (trimmedPath === '/' || trimmedPath === '') {
    return '/';
  }

  const htmlMatch = trimmedPath.match(/^\/([^/]+)\.html$/i);
  if (htmlMatch && STATIC_PAGE_NAMES.has(htmlMatch[1])) {
    return htmlMatch[1] === 'index' ? '/' : `/${htmlMatch[1]}`;
  }

  const cleanMatch = trimmedPath.match(/^\/([^/.]+)$/);
  if (cleanMatch && STATIC_PAGE_NAMES.has(cleanMatch[1])) {
    return cleanMatch[1] === 'index' ? '/' : trimmedPath;
  }

  return trimmedPath;
}

function routePath(path) {
  if (typeof path !== 'string' || isSkippableHref(path) || isFileProtocol()) {
    return path;
  }

  if (/^(?:[a-z][a-z\d+\-.]*:)?\/\//i.test(path) && !path.startsWith(window.location.origin)) {
    return path;
  }

  try {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) {
      return url.toString();
    }

    return `${stripHtmlExtension(url.pathname)}${url.search}${url.hash}`;
  } catch (_) {
    return path;
  }
}

function getCurrentPageName() {
  const cleanPath = stripHtmlExtension(window.location.pathname || '/');
  if (cleanPath === '/') {
    return 'index.html';
  }

  const pageName = cleanPath.split('/').filter(Boolean).pop() || 'index';
  return `${pageName}.html`;
}

function rewriteInternalLinks(scope = document) {
  if (isFileProtocol() || !scope || typeof scope.querySelectorAll !== 'function') {
    return;
  }

  scope.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    const cleanHref = routePath(href);
    if (cleanHref && cleanHref !== href) {
      link.setAttribute('href', cleanHref);
    }
  });
}

function canonicalizeCurrentLocation() {
  if (isFileProtocol()) return;

  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const cleanUrl = routePath(currentUrl);
  if (cleanUrl && cleanUrl !== currentUrl) {
    window.history.replaceState(window.history.state, '', cleanUrl);
  }
}

function startLinkRewriteObserver() {
  if (linkRewriteObserverStarted || isFileProtocol() || !document.body || typeof MutationObserver === 'undefined') {
    return;
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

        if (typeof node.matches === 'function' && node.matches('a[href]')) {
          rewriteInternalLinks(node.parentElement || node);
          return;
        }

        rewriteInternalLinks(node);
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  linkRewriteObserverStarted = true;
}

/**
 * Toggle mobile menu
 */
function toggleMobileMenu() {
  const navbarNav = document.getElementById('navbarNav');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  if (!navbarNav) return;

  const isOpen = navbarNav.classList.toggle('active');
  document.body.classList.toggle('mobile-menu-open', isOpen);
  if (hamburgerBtn) {
    hamburgerBtn.setAttribute('aria-expanded', String(isOpen));
  }
}

function closeMobileMenu() {
  const navbarNav = document.getElementById('navbarNav');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  if (!navbarNav) return;

  navbarNav.classList.remove('active');
  document.body.classList.remove('mobile-menu-open');
  if (hamburgerBtn) {
    hamburgerBtn.setAttribute('aria-expanded', 'false');
  }
}

function syncMobileNavOffset() {
  const navbar = document.querySelector('.navbar');
  if (!navbar) return;
  const navHeight = Math.ceil(navbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--mobile-nav-offset', `${navHeight}px`);
}

function queueNavigationNotice(notice) {
  if (!notice || typeof window === 'undefined') return;
  try {
    const payload = typeof notice === 'string'
      ? { title: 'Notice', text: notice, icon: 'info' }
      : notice;
    window.sessionStorage.setItem(NAVIGATION_NOTICE_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function consumeNavigationNotice() {
  if (typeof window === 'undefined') return null;
  try {
    const rawNotice = window.sessionStorage.getItem(NAVIGATION_NOTICE_STORAGE_KEY);
    if (!rawNotice) return null;
    window.sessionStorage.removeItem(NAVIGATION_NOTICE_STORAGE_KEY);
    return JSON.parse(rawNotice);
  } catch (_) {
    return null;
  }
}

async function showQueuedNavigationNotice() {
  const notice = consumeNavigationNotice();
  if (!notice) return null;

  if (typeof MCLBUI !== 'undefined' && typeof MCLBUI.alert === 'function') {
    return MCLBUI.alert({
      icon: notice.icon || 'info',
      title: notice.title || 'Notice',
      text: notice.text || '',
      html: notice.html
    });
  }

  if (notice.text) {
    window.alert(notice.text);
  }
  return null;
}

function navigateTo(path, { replace = false, banner = null, notice = null } = {}) {
  if (notice) {
    queueNavigationNotice(notice);
  } else if (banner) {
    queueNavigationNotice({
      icon: 'warning',
      title: 'Session Ended',
      text: banner
    });
  }

  const targetPath = routePath(path);

  if (replace) {
    window.location.replace(targetPath);
    return;
  }

  window.location.href = targetPath;
}

function navigateToLogin(options = {}) {
  navigateTo('login.html', options);
}

function navigateToDashboard(options = {}) {
  navigateTo('dashboard.html', options);
}

function attachNavigationLinkListeners(navbarNav) {
  if (!navbarNav) return;
  navbarNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => closeMobileMenu());
  });
}

function getLiveNavigationUser() {
  if (typeof AppState !== 'undefined' && AppState.currentUser) {
    return AppState.currentUser;
  }

  if (typeof firebaseAuthService !== 'undefined' && typeof firebaseAuthService.getCurrentUser === 'function') {
    return firebaseAuthService.getCurrentUser();
  }

  try {
    if (typeof getAuth === 'function') {
      return getAuth().currentUser || null;
    }
    if (typeof firebase !== 'undefined' && firebase && typeof firebase.auth === 'function') {
      return firebase.auth().currentUser || null;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function isNavigationAuthenticated() {
  return Boolean(getLiveNavigationUser());
}

function reconcileNavigationAuthState() {
  const liveUser = getLiveNavigationUser();
  if (liveUser && typeof AppState !== 'undefined' && !AppState.currentUser) {
    AppState.setUser(liveUser);
  }
}

/**
 * Rebuild navigation with icons and inbox (Apple-style header)
 * Re-renders when auth state changes so late auth resolution does not strand the UI in guest mode.
 */
function rebuildNavigation({ force = false } = {}) {
  const navbarNav = document.getElementById('navbarNav');
  if (!navbarNav) return;

  // Detect which page is active
  const path = getCurrentPageName();

  const isActive = (page) => path === page ? ' class="active"' : '';

  const authed = isNavigationAuthenticated();
  const nextMode = authed ? 'authenticated' : 'guest';
  if (!force && navbarNav.dataset.rebuilt === nextMode) {
    return;
  }

  if (authed) {
    navbarNav.innerHTML = `
      <li><a href="${routePath('index.html')}"${isActive('index.html')}><i class="fas fa-trophy"></i><span class="nav-label"> Leaderboards</span></a></li>
      <li><a href="${routePath('dashboard.html')}" id="navDashboard"${isActive('dashboard.html')}><i class="fas fa-gamepad"></i><span class="nav-label"> Dashboard</span></a></li>
      <li><a href="${routePath('inbox.html')}" id="navInbox"${isActive('inbox.html')}><i class="fas fa-inbox"></i><span class="nav-label"> Inbox</span><span class="inbox-badge d-none" id="navInboxBadge"></span></a></li>
      <li><a href="${routePath('account.html')}" id="navAccount"${isActive('account.html')}><i class="fas fa-circle-user"></i><span class="nav-label"> Account</span></a></li>
      <li><a href="#" id="navLogout" onclick="handleLogout()"><i class="fas fa-right-from-bracket"></i><span class="nav-label"> Logout</span></a></li>
    `;
  } else {
    navbarNav.innerHTML = `
      <li><a href="${routePath('index.html')}"${isActive('index.html')}><i class="fas fa-trophy"></i><span class="nav-label"> Leaderboards</span></a></li>
      <li><a href="${routePath('login.html')}" id="navLogin"${isActive('login.html')}><i class="fas fa-right-to-bracket"></i><span class="nav-label"> Sign In</span></a></li>
      <li><a href="${routePath('signup.html')}" id="navSignup"${isActive('signup.html')}><i class="fas fa-user-plus"></i><span class="nav-label"> Sign Up</span></a></li>
    `;
  }

  navbarNav.dataset.rebuilt = nextMode;
  rewriteInternalLinks(navbarNav);
  attachNavigationLinkListeners(navbarNav);
}

/**
 * Update navigation based on auth state
 */
function updateNavigation() {
  reconcileNavigationAuthState();
  const isAuthenticated = isNavigationAuthenticated();
  const navbarNav = document.getElementById('navbarNav');
  const expectedMode = isAuthenticated ? 'authenticated' : 'guest';

  if (navbarNav && navbarNav.dataset.rebuilt !== expectedMode) {
    rebuildNavigation({ force: true });
  }

  const navLogin = document.getElementById('navLogin');
  const navSignup = document.getElementById('navSignup');
  const navLogout = document.getElementById('navLogout');
  const navDashboard = document.getElementById('navDashboard');
  const navAccount = document.getElementById('navAccount');
  const navInbox = document.getElementById('navInbox');

  if (isAuthenticated) {
    if (navLogin) navLogin.style.display = 'none';
    if (navSignup) navSignup.style.display = 'none';
    if (navLogout) navLogout.style.display = '';
    if (navDashboard) navDashboard.style.display = '';
    if (navAccount) navAccount.style.display = '';
    if (navInbox) navInbox.style.display = '';

    const isDashboardPage = getCurrentPageName() === 'dashboard.html';
    if (!isDashboardPage) {
      updateInboxBadge();
    }
  } else {
    if (navLogin) navLogin.style.display = '';
    if (navSignup) navSignup.style.display = '';
    if (navLogout) navLogout.style.display = 'none';
    if (navDashboard) navDashboard.style.display = 'none';
    if (navAccount) navAccount.style.display = 'none';
    if (navInbox) navInbox.style.display = 'none';
  }
}

/**
 * Fetch and update the inbox unread badge in the navbar
 */
async function updateInboxBadge() {
  try {
    if (typeof apiService === 'undefined') return;
    const res = await apiService.getInboxUnreadCount();
    const count = res?.unreadCount || 0;
    const badge = document.getElementById('navInboxBadge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('d-none');
      } else {
        badge.classList.add('d-none');
      }
    }
  } catch (e) {
    // Silently fail - badge just won't show
  }
}

/**
 * Handle logout
 */
async function handleLogout() {
  try {
    await firebaseAuthService.signOut();
    AppState.reset();
    updateNavigation();
    navigateTo('index.html');
  } catch (error) {
    console.error('Logout error:', error);
    if (typeof MCLBUI !== 'undefined') {
      MCLBUI.error('Logout Failed', error.message);
    }
  }
}

// Update navigation on state changes
AppState.addListener('user', updateNavigation);
AppState.addListener('profile', updateNavigation);

// Close mobile menu when clicking outside
document.addEventListener('click', (e) => {
  const navbarNav = document.getElementById('navbarNav');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  
  if (navbarNav && hamburgerBtn && 
      !navbarNav.contains(e.target) && 
      !hamburgerBtn.contains(e.target) &&
      navbarNav.classList.contains('active')) {
    closeMobileMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMobileMenu();
  }
});

window.addEventListener('resize', () => {
  syncMobileNavOffset();
  if (window.innerWidth > 768) {
    closeMobileMenu();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  canonicalizeCurrentLocation();
  rewriteInternalLinks();
  startLinkRewriteObserver();
  syncMobileNavOffset();
  reconcileNavigationAuthState();
  rebuildNavigation({ force: true });
  updateNavigation();

  const hamburgerBtn = document.getElementById('hamburgerBtn');
  if (hamburgerBtn) {
    hamburgerBtn.setAttribute('aria-expanded', 'false');
    hamburgerBtn.setAttribute('aria-controls', 'navbarNav');
    hamburgerBtn.setAttribute('aria-label', 'Toggle navigation menu');
  }

  // Add subtle easter egg trigger to every footer that has footer links.
  document.querySelectorAll('.footer-links').forEach((footerLinks) => {
    if (footerLinks.querySelector('[data-easter-trigger="just-dont"]')) {
      return;
    }

    const trigger = document.createElement('a');
    trigger.href = routePath('easteregg.html');
    trigger.textContent = 'just dont';
    trigger.dataset.easterTrigger = 'just-dont';
    trigger.style.opacity = '0.18';
    trigger.style.fontSize = '0.62rem';
    trigger.style.letterSpacing = '0.08em';
    trigger.style.textTransform = 'lowercase';
    footerLinks.appendChild(trigger);
  });
});

window.addEventListener('load', () => {
  rewriteInternalLinks();
});

if (typeof window !== 'undefined') {
  window.navigateTo = navigateTo;
  window.navigateToLogin = navigateToLogin;
  window.navigateToDashboard = navigateToDashboard;
  window.queueNavigationNotice = queueNavigationNotice;
  window.consumeNavigationNotice = consumeNavigationNotice;
  window.showQueuedNavigationNotice = showQueuedNavigationNotice;
  window.routePath = routePath;
  window.rewriteInternalLinks = rewriteInternalLinks;
}

