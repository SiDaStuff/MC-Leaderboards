// MC Leaderboards - Dashboard Page Shell

function calculateTesterTenure(approvedAtDate) {
  if (!approvedAtDate) return 'Calculating...';

  const approvedAt = new Date(approvedAtDate);
  const diffDays = Math.floor((Date.now() - approvedAt.getTime()) / (1000 * 60 * 60 * 24));
  const diffMonths = Math.floor(diffDays / 30);
  const residualDays = diffDays % 30;

  if (diffMonths === 0) {
    return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
  }

  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} and ${residualDays} day${residualDays !== 1 ? 's' : ''}`;
}

function getPlusExpiryStatus(expiresAtDate) {
  if (!expiresAtDate) {
    return {
      daysRemaining: 0,
      isExpired: true,
      isCritical: false,
      formattedDate: 'N/A'
    };
  }

  const expiresAt = new Date(expiresAtDate);
  const diffDays = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  return {
    daysRemaining: diffDays,
    isExpired: diffDays <= 0,
    isCritical: diffDays <= 7 && diffDays > 0,
    formattedDate: formatDate(expiresAt, { format: { year: 'numeric', month: 'long', day: 'numeric' } })
  };
}

function renderStatusCards() {
  const profile = AppState.userProfile || AppState.getProfile?.();
  if (!profile) return;

  const userStatusValue = document.getElementById('userStatusValue');
  const userStatusSubtitle = document.getElementById('userStatusSubtitle');
  if (userStatusValue && userStatusSubtitle) {
    userStatusValue.textContent = profile.minecraftUsername || profile.email || 'Player';
    userStatusSubtitle.textContent = profile.createdAt
      ? `Joined ${formatDate(profile.createdAt, { format: { year: 'numeric', month: 'short' } })}`
      : 'Active';
  }

  const testerCardContent = document.getElementById('testerCardContent');
  if (testerCardContent) {
    if (profile.tester && profile.testerApprovedAt) {
      document.getElementById('testerCardTitle').textContent = 'Tier Tester - Active';
      testerCardContent.innerHTML = `
        <div class="status-badge badge-active dashboard-inline-badge">Approved</div>
        <div class="dashboard-inline-copy">Tenure: <strong>${calculateTesterTenure(profile.testerApprovedAt)}</strong></div>
        <button type="button" onclick="scrollToTesterDashboard()" class="btn btn-primary btn-block btn-sm">
          <i class="fas fa-play-circle"></i> Open Shared Queue
        </button>
      `;
    } else if (profile.pendingTesterApplication === true) {
      document.getElementById('testerCardTitle').textContent = 'Tier Tester - Pending';
      testerCardContent.innerHTML = `
        <div class="status-badge badge-warning dashboard-inline-badge">Pending Review</div>
        <div class="dashboard-inline-copy">Your application is under review by admins. This typically takes 3-7 days.</div>
        <div class="dashboard-inline-meta">Submitted: ${formatDate(profile.lastApplicationSubmitted, { fallback: '-' })}</div>
      `;
    } else if (profile.testerApplicationDenied === true) {
      document.getElementById('testerCardTitle').textContent = 'Tier Tester - Denied';
      testerCardContent.innerHTML = `
        <div class="status-badge badge-critical dashboard-inline-badge">Denied</div>
        <div class="dashboard-inline-copy">${escapeHtml(profile.testerDenialReason || 'Application did not meet requirements.')}</div>
        <a href="tier-tester-application.html" class="btn btn-secondary btn-block btn-sm">
          <i class="fas fa-rotate-right"></i> Apply Again
        </a>
      `;
    } else {
      document.getElementById('testerCardTitle').textContent = 'Become a Tier Tester';
      testerCardContent.innerHTML = `
        <div class="dashboard-inline-copy">Help evaluate players and earn exclusive perks.</div>
        <a href="tier-tester-application.html" class="btn btn-success btn-block btn-sm">
          <i class="fas fa-clipboard-check"></i> Apply Now
        </a>
      `;
    }
  }

  const plusCardContent = document.getElementById('plusCardContent');
  const plus = profile.plus || {};
  if (!plusCardContent) return;

  if (plus.active && plus.expiresAt) {
    const expiryStatus = getPlusExpiryStatus(plus.expiresAt);
    const badgeClass = expiryStatus.isCritical ? 'badge-critical' : 'badge-active';
    const statusText = expiryStatus.isCritical ? 'Expiring Soon' : 'Active';
    document.getElementById('plusCardTitle').textContent = 'Plus - Active';
    plusCardContent.innerHTML = `
      <div class="status-badge ${badgeClass} dashboard-inline-badge">${statusText}</div>
      <div class="dashboard-inline-copy">
        Expires ${expiryStatus.formattedDate}<br>
        <strong>${expiryStatus.daysRemaining} days remaining</strong>
      </div>
      <a href="dashboard.html" class="btn btn-primary btn-block btn-sm">
        <i class="fas fa-star"></i> Enjoy Plus
      </a>
    `;
    return;
  }

  if (plus.blocked) {
    document.getElementById('plusCardTitle').textContent = 'Plus - Blocked';
    plusCardContent.innerHTML = '<div class="dashboard-inline-copy text-danger">Plus is blocked for your account. Contact support for details.</div>';
    return;
  }

  document.getElementById('plusCardTitle').textContent = 'Upgrade to Plus';
  plusCardContent.innerHTML = `
    <div class="dashboard-inline-copy">Get priority queue, custom badges, and exclusive features.</div>
    <a href="plus.html" class="btn btn-primary btn-block btn-sm">
      <i class="fas fa-star"></i> View Plus
    </a>
  `;
}

document.addEventListener('DOMContentLoaded', async () => {
  const waitForFirebase = () => new Promise((resolve) => {
    if (typeof waitForFirebaseInit === 'function') {
      waitForFirebaseInit().then(resolve);
      return;
    }

    const checkInterval = setInterval(() => {
      if (typeof waitForFirebaseInit === 'function') {
        clearInterval(checkInterval);
        waitForFirebaseInit().then(resolve);
      }
    }, 50);
  });

  const waitForAuth = () => new Promise((resolve) => {
    if (typeof requireAuth === 'function') {
      resolve();
      return;
    }

    const checkInterval = setInterval(() => {
      if (typeof requireAuth === 'function') {
        clearInterval(checkInterval);
        resolve();
      }
    }, 50);
  });

  await waitForFirebase();
  await waitForAuth();

  const authenticated = await requireAuth();
  if (!authenticated) return;

  const originalSetProfile = typeof AppState.setUserProfile === 'function'
    ? AppState.setUserProfile
    : AppState.setProfile;
  if (typeof originalSetProfile === 'function') {
    AppState.setUserProfile = function patchedSetUserProfile(profile) {
      originalSetProfile.call(this, profile);
      renderStatusCards();
    };
  }

  if (typeof initDashboard === 'function') {
    initDashboard();
    setTimeout(() => {
      renderStatusCards();
    }, 500);
  }
});
