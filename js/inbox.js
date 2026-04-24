// MC Leaderboards - Inbox Page Logic

let inboxMessages = [];
let currentDetailMessage = null;
let activeFilter = 'all';

function hasDangerousUrlScheme(value) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001F\u007F\s]+/g, '')
    .toLowerCase();

  return normalized.startsWith('javascript:')
    || normalized.startsWith('data:')
    || normalized.startsWith('vbscript:');
}

// Sanitize HTML from server to prevent XSS - allow only safe tags/attributes
function sanitizeInboxHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  // Remove all script tags and event handlers
  div.querySelectorAll('script, iframe, object, embed, form, input, textarea, select, button').forEach(el => el.remove());
  div.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const attrName = attr.name.toLowerCase();
      const isDangerousUrlAttr = ['href', 'src', 'xlink:href'].includes(attrName) && hasDangerousUrlScheme(attr.value);
      if (attrName.startsWith('on') || attrName === 'srcdoc' || isDangerousUrlAttr) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
  const checkAuth = setInterval(() => {
    if (typeof AppState !== 'undefined' && typeof apiService !== 'undefined') {
      clearInterval(checkAuth);
      initInbox();
    }
  }, 100);
});

async function initInbox() {
  const user = AppState.currentUser;
  if (!user) {
    document.getElementById('authGate')?.classList.remove('d-none');
    return;
  }
  document.getElementById('inboxContent')?.classList.remove('d-none');
  await loadInbox();
}

if (typeof AppState !== 'undefined') {
  AppState.addListener('user', (user) => {
    if (user) {
      document.getElementById('authGate')?.classList.add('d-none');
      document.getElementById('inboxContent')?.classList.remove('d-none');
      loadInbox();
    } else {
      document.getElementById('authGate')?.classList.remove('d-none');
      document.getElementById('inboxContent')?.classList.add('d-none');
    }
  });
}

async function loadInbox() {
  try {
    const res = await apiService.getInboxMessages();
    inboxMessages = (res?.messages || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    console.error('Error loading inbox:', error);
    inboxMessages = [];
  }
  updateFilterCounts();
  renderInbox();
  updateNavBadge();
}

async function refreshInbox() {
  const list = document.getElementById('inboxList');
  if (list) list.innerHTML = '<div class="spinner"></div>';
  await loadInbox();
}

function getFilteredMessages() {
  if (activeFilter === 'all') return inboxMessages;
  if (activeFilter === 'unread') return inboxMessages.filter(m => !m.read);
  const types = activeFilter.split(',');
  return inboxMessages.filter(m => types.includes(m.type));
}

function filterInbox(filter) {
  activeFilter = filter;
  // Update active tab
  document.querySelectorAll('.inbox-filter-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.filter === filter);
  });
  renderInbox();
}

function updateFilterCounts() {
  const allCount = document.getElementById('filterCountAll');
  const unreadCount = document.getElementById('filterCountUnread');
  if (allCount) allCount.textContent = inboxMessages.length;
  if (unreadCount) unreadCount.textContent = inboxMessages.filter(m => !m.read).length;
}

function renderInbox() {
  const list = document.getElementById('inboxList');
  if (!list) return;

  const filtered = getFilteredMessages();

  if (filtered.length === 0) {
    const emptyMsg = activeFilter === 'unread' ? 'All caught up!' : 'No messages';
    const emptyDesc = activeFilter === 'unread' ? 'You have no unread messages.' : activeFilter === 'all' ? 'Your inbox is empty.' : 'No messages of this type.';
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-inbox"></i></div>
        <div class="empty-state-title">${emptyMsg}</div>
        <div class="empty-state-desc">${emptyDesc}</div>
      </div>`;
    return;
  }

  list.innerHTML = filtered.map(msg => {
    const iconClass = getIconClass(msg.type);
    const iconName = getIconName(msg.type);
    const timeAgo = formatTimeAgo(msg.createdAt);
    const unreadClass = !msg.read ? 'unread' : '';

    return `
      <div class="inbox-item ${unreadClass}" onclick="openMessage('${msg.id}')">
        <div class="inbox-item-icon ${iconClass}">
          <i class="fas ${iconName}"></i>
        </div>
        <div class="inbox-item-body">
          <div class="inbox-item-header">
            <span class="inbox-item-title">${escapeHtml(msg.title || 'Message')}</span>
            <span class="inbox-item-time">${timeAgo}</span>
          </div>
          <div class="inbox-item-preview">${escapeHtml(msg.preview || msg.message || '')}</div>
        </div>
        <button class="inbox-item-delete" onclick="event.stopPropagation(); deleteMessage('${msg.id}')" title="Delete"><i class="fas fa-trash-can"></i></button>
      </div>`;
  }).join('');

  // Stagger animation for list items
  if (typeof animateListItems === 'function') {
    requestAnimationFrame(() => animateListItems('#inboxList'));
  }
}

function getIconClass(type) {
  switch (type) {
    case 'warning': return 'warning';
    case 'blacklist': return 'danger';
    case 'rating_adjustment':
    case 'report_resolved': return 'success';
    case 'admin_message':
    case 'admin_notice': return 'admin';
    default: return 'system';
  }
}

function getIconName(type) {
  switch (type) {
    case 'warning': return 'fa-triangle-exclamation';
    case 'blacklist': return 'fa-ban';
    case 'rating_adjustment': return 'fa-scale-balanced';
    case 'report_resolved': return 'fa-circle-check';
    case 'admin_message': return 'fa-envelope';
    case 'admin_notice': return 'fa-bullhorn';
    case 'match_finalized': return 'fa-flag-checkered';
    default: return 'fa-bell';
  }
}

async function openMessage(messageId) {
  const msg = inboxMessages.find(m => m.id === messageId);
  if (!msg) return;

  currentDetailMessage = msg;

  if (!msg.read) {
    await markRead(messageId);
  }

  document.getElementById('detailTitle').textContent = msg.title || 'Message';
  document.getElementById('detailFrom').innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(msg.from || 'System')}`;
  document.getElementById('detailDate').innerHTML = `<i class="fas fa-clock"></i> ${new Date(msg.createdAt).toLocaleString()}`;

  let bodyHtml = msg.htmlBody ? sanitizeInboxHtml(msg.htmlBody) : `<p>${escapeHtml(msg.message || '').replace(/\n/g, '<br>')}</p>`;

  if (msg.ratingAdjustments?.length) {
    bodyHtml += '<div class="rating-adjustment">';
    for (const adj of msg.ratingAdjustments) {
      bodyHtml += `<div class="line"><span>${escapeHtml(adj.gamemode)}</span><span>${adj.before} <span class="restored">+${adj.restored}</span> → <strong>${adj.after}</strong></span></div>`;
    }
    bodyHtml += '</div>';
  }

  if (msg.reason) {
    bodyHtml += `<p style="margin-top:0.75rem;"><strong>Reason:</strong> ${escapeHtml(msg.reason)}</p>`;
  }

  document.getElementById('detailBody').innerHTML = bodyHtml;
  document.getElementById('inboxListView').classList.add('d-none');
  document.getElementById('inboxDetailView').classList.remove('d-none');
}

function closeMessageDetail() {
  currentDetailMessage = null;
  document.getElementById('inboxDetailView').classList.add('d-none');
  document.getElementById('inboxListView').classList.remove('d-none');
}

async function markRead(messageId) {
  try {
    await apiService.markInboxRead(messageId);
    const msg = inboxMessages.find(m => m.id === messageId);
    if (msg) msg.read = true;
    renderInbox();
    updateNavBadge();
  } catch (error) {
    console.error('Error marking message as read:', error);
  }
}

async function markAllRead() {
  try {
    await apiService.markAllInboxRead();
    inboxMessages.forEach(m => m.read = true);
    updateFilterCounts();
    renderInbox();
    updateNavBadge();
    if (typeof Toast !== 'undefined') Toast.success('All messages marked as read');
  } catch (error) {
    console.error('Error marking all as read:', error);
    if (typeof Toast !== 'undefined') Toast.error('Failed to mark messages as read');
  }
}

async function deleteMessage(messageId) {
  try {
    await apiService.deleteInboxMessage(messageId);
    inboxMessages = inboxMessages.filter(m => m.id !== messageId);
    if (currentDetailMessage?.id === messageId) {
      closeMessageDetail();
    }
    updateFilterCounts();
    renderInbox();
    updateNavBadge();
    if (typeof Toast !== 'undefined') Toast.success('Message deleted');
  } catch (error) {
    console.error('Error deleting message:', error);
    if (typeof Toast !== 'undefined') Toast.error('Failed to delete message');
  }
}

async function deleteAllRead() {
  const readMessages = inboxMessages.filter(m => m.read);
  if (readMessages.length === 0) {
    if (typeof Toast !== 'undefined') Toast.info('No read messages to clear');
    return;
  }

  const proceed = typeof confirmAction === 'function'
    ? await confirmAction('Clear Read Messages', `Delete ${readMessages.length} read message${readMessages.length > 1 ? 's' : ''}?`, 'Delete', 'warning')
    : window.confirm(`Delete ${readMessages.length} read messages?`);

  if (!proceed) return;

  let deleted = 0;
  for (const msg of readMessages) {
    try {
      await apiService.deleteInboxMessage(msg.id);
      inboxMessages = inboxMessages.filter(m => m.id !== msg.id);
      deleted++;
    } catch (e) {
      console.error('Error deleting message:', msg.id, e);
    }
  }
  if (currentDetailMessage && !inboxMessages.find(m => m.id === currentDetailMessage.id)) {
    closeMessageDetail();
  }
  updateFilterCounts();
  renderInbox();
  updateNavBadge();
  if (typeof Toast !== 'undefined') Toast.success(`Cleared ${deleted} message${deleted !== 1 ? 's' : ''}`);
}

function updateNavBadge() {
  if (typeof updateInboxBadge === 'function') {
    updateInboxBadge();
  } else {
    const unread = inboxMessages.filter(m => !m.read).length;
    const badge = document.getElementById('navInboxBadge');
    if (badge) {
      if (unread > 0) {
        badge.textContent = unread > 99 ? '99+' : unread;
        badge.classList.remove('d-none');
      } else {
        badge.classList.add('d-none');
      }
    }
  }
}

function formatTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
