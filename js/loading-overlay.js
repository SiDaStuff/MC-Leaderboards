// MC Leaderboards - Global Loading Overlay
// Shows an overlay and hides page content until:
// - window load event has fired (all assets loaded)
// - apiService has no pending requests (initial data/API calls complete)
// - a safety timeout occurs (prevents permanent lock)

(function () {
  const OVERLAY_ID = 'mclbLoadingOverlay';
  const HTML_LOADING_CLASS = 'mclb-loading';
  const MAX_WAIT_MS = 20000; // safety: 20s

  // Mark loading immediately (HTML exists before body)
  try {
    document.documentElement.classList.add(HTML_LOADING_CLASS);
  } catch (_) {}

  let manualVisible = false;

  function ensureOverlay() {
    if (!document.body) return null;
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="mclb-loading-overlay__panel">
        <div class="mclb-loading-overlay__eyebrow">MC Leaderboards</div>
        <div class="mclb-loading-overlay__logo">
          <img src="assets/vanilla.svg" alt="MC Leaderboards" class="mclb-loading-overlay__logo-img">
        </div>
        <div class="mclb-loading-overlay__title">Loading workspace</div>
        <div class="mclb-loading-overlay__subtitle">Preparing rankings, account tools, and live updates.</div>
        
        <div class="mclb-loading-overlay__progress-container">
          <div class="mclb-loading-overlay__progress-bar">
            <div class="mclb-loading-overlay__progress-fill" id="mclbProgressFill"></div>
          </div>
          <div class="mclb-loading-overlay__progress-text" id="mclbProgressText">0%</div>
        </div>
        
        <div class="mclb-loading-overlay__status" id="mclbLoadingStatus">Starting up</div>
        
        <div class="mclb-loading-overlay__spinner" aria-hidden="true"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
  }

  function updateLoadingStatus(stage, progress) {
    const statusEl = document.getElementById('mclbLoadingStatus');
    const progressFill = document.getElementById('mclbProgressFill');
    const progressText = document.getElementById('mclbProgressText');
    
    if (statusEl) statusEl.textContent = stage;
    if (progressFill) progressFill.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `${Math.round(progress)}%`;
  }

  function hasPendingRequests() {
    try {
      const svc = window.apiService;
      if (!svc) return false;
      const pending = svc.pendingRequests;
      if (pending && typeof pending.size === 'number') {
        return pending.size > 0;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  let windowLoaded = false;
  let dataLoaded = false;
  
  // Track loading stages
  document.addEventListener('DOMContentLoaded', () => {
    updateLoadingStatus('Preparing layout', 20);
  });
  
  window.addEventListener('load', () => {
    windowLoaded = true;
    updateLoadingStatus('Loading assets', 60);
    tryFinish();
  });

  const startAt = Date.now();
  let finished = false;

  function setOverlayVisible(isVisible) {
    const overlay = ensureOverlay();
    if (!overlay) return;
    overlay.style.display = isVisible ? 'flex' : 'none';
    try {
      document.documentElement.classList.toggle(HTML_LOADING_CLASS, isVisible);
    } catch (_) {}
  }

  function hideOverlay() {
    finished = true;
    if (!manualVisible) {
      setOverlayVisible(false);
    }
  }

  function tryFinish() {
    if (finished) return;
    ensureOverlay();

    const timedOut = (Date.now() - startAt) > MAX_WAIT_MS;
    const pending = hasPendingRequests();

    // Update progress based on loading state
    if (!windowLoaded) {
      updateLoadingStatus('Preparing layout', 20);
    } else if (pending) {
      updateLoadingStatus('Syncing live data', 80);
      dataLoaded = false;
    } else if (!dataLoaded) {
      updateLoadingStatus('Finishing setup', 95);
      dataLoaded = true;
    }

    // Only hide once the full page is loaded and initial API work is done.
    if ((windowLoaded && !pending) || timedOut) {
      updateLoadingStatus('Ready', 100);
      setTimeout(() => hideOverlay(), 180); // Brief delay to show 100%
      return;
    }

    // Poll until ready
    setTimeout(tryFinish, 100);
  }

  // Ensure overlay exists as soon as body is ready, then start polling.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureOverlay();
      tryFinish();
    });
  } else {
    ensureOverlay();
    tryFinish();
  }

  // Expose for manual override (if a page has long-running initializers)
  window.mclbLoadingOverlay = {
    show: () => {
      ensureOverlay();
      manualVisible = true;
      setOverlayVisible(true);
    },
    hide: () => {
      manualVisible = false;
      if (finished) {
        setOverlayVisible(false);
      }
    },
    updateStatus: (stage, progress) => updateLoadingStatus(stage, progress),
    isVisible: () => {
      const overlay = document.getElementById(OVERLAY_ID);
      return Boolean(overlay && overlay.style.display !== 'none');
    }
  };
})();

