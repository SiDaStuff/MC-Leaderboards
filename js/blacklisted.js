function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function formatRelativeTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, 'minute');
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) {
    return rtf.format(diffHours, 'hour');
  }

  const diffDays = Math.round(diffHours / 24);
  return rtf.format(diffDays, 'day');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Permanent';

  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);

  return parts.join(' ') || 'Under 1m';
}

function getLengthLabel(entry) {
  if (!entry.temporary || !entry.addedAt || !entry.expiresAt) {
    return 'Permanent';
  }

  const durationMs = new Date(entry.expiresAt).getTime() - new Date(entry.addedAt).getTime();
  return formatDuration(durationMs);
}

function getStatusLabel(entry) {
  if (!entry.temporary || !entry.expiresAt) {
    return 'No expiry';
  }

  return `${formatDateTime(entry.expiresAt)} (${formatRelativeTime(entry.expiresAt)})`;
}

const blacklistFeedState = {
  entries: []
};

function renderBlacklistEntries(entries) {
  const feedState = document.getElementById('blacklistFeedState');
  const feedList = document.getElementById('blacklistFeedList');
  const feedSummary = document.getElementById('blacklistFeedSummary');
  if (!feedState || !feedList || !feedSummary) return;

  if (!Array.isArray(entries) || entries.length === 0) {
    feedSummary.textContent = '0 entries';
    feedState.textContent = 'No blacklist entries to show.';
    feedState.style.display = 'block';
    feedList.style.display = 'none';
    return;
  }

  feedSummary.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
  feedState.style.display = 'none';
  feedList.style.display = 'block';
  feedList.innerHTML = entries.map((entry) => {
    const username = escapeHtml(entry.username || 'Unknown username');
    const reason = escapeHtml(entry.reason || 'No reason provided');
    const statusClass = entry.expired ? 'is-expired' : (entry.temporary ? 'is-temporary' : 'is-permanent');
    const statusLabel = entry.expired
      ? 'Expired'
      : (entry.temporary ? 'Temporary' : 'Permanent');
    const metaParts = [
      `Reason: ${reason}`,
      `Added: ${escapeHtml(formatDateTime(entry.addedAt))}`,
      `Length: ${escapeHtml(getLengthLabel(entry))}`,
      `Ends: ${escapeHtml(getStatusLabel(entry))}`
    ];

    return `
      <li class="blacklist-simple-item">
        <div class="blacklist-simple-row">
          <span class="blacklist-simple-name">${username}</span>
          <span class="blacklist-simple-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="blacklist-simple-reason">${reason}</div>
        <div class="blacklist-simple-meta">${metaParts.join(' • ')}</div>
      </li>
    `;
  }).join('');
}

async function loadBlacklistFeed() {
  const feedState = document.getElementById('blacklistFeedState');
  const feedSummary = document.getElementById('blacklistFeedSummary');

  try {
    const response = await fetch('/api/public/blacklist?limit=100&includeExpired=true', {
      headers: {
        Accept: 'application/json'
      }
    });

    const payload = await response.json();
    if (!response.ok || payload?.error) {
      throw new Error(payload?.message || 'Unable to load blacklist feed');
    }

    blacklistFeedState.entries = Array.isArray(payload.entries) ? payload.entries : [];
    renderBlacklistEntries(blacklistFeedState.entries);
  } catch (error) {
    if (feedSummary) {
      feedSummary.textContent = 'Feed unavailable';
    }
    if (feedState) {
      feedState.textContent = error.message || 'Unable to load blacklist feed right now.';
      feedState.style.display = 'block';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadBlacklistFeed();
});