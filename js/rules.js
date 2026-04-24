// Rules page: tabbed overall + per-gamemode sections loaded from rules.txt.

let currentRulesTab = 'overall';
let rulesSections = {};

function normalizeSectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '');
}

function parseRulesSections(rawText) {
  const sections = {};
  const lines = String(rawText || '').split(/\r?\n/);
  let activeKeys = ['overall'];
  let buffer = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (!text) {
      buffer = [];
      return;
    }
    activeKeys.forEach((key) => {
      sections[key] = sections[key] ? `${sections[key]}\n\n${text}` : text;
    });
    buffer = [];
  };

  lines.forEach((line) => {
    const markerMatch = line.match(/^###\s*(.+)$/i);
    if (markerMatch) {
      flush();
      const rawKeys = markerMatch[1]
        .split(',')
        .map(part => normalizeSectionKey(part))
        .filter(Boolean);
      activeKeys = rawKeys.length > 0 ? rawKeys : ['overall'];
      return;
    }
    buffer.push(line);
  });

  flush();

  if (!sections.overall) {
    const allText = String(rawText || '').trim();
    if (allText) sections.overall = allText;
  }

  return sections;
}

function getRulesTabConfig() {
  const gamemodeTabs = (CONFIG?.GAMEMODES || [])
    .filter(gm => gm.id !== 'overall')
    .map(gm => ({ id: gm.id, name: gm.name, icon: gm.icon }));

  return [
    { id: 'overall', name: 'Overall', icon: 'assets/overall.svg' },
    ...gamemodeTabs
  ];
}

function getRulesTextForTab(tabId) {
  return rulesSections[tabId] || rulesSections.overall || 'No rules configured for this section yet.';
}

function renderRulesTabs() {
  const tabsEl = document.getElementById('rulesTabs');
  if (!tabsEl) return;

  const tabs = getRulesTabConfig();
  tabsEl.innerHTML = tabs.map(tab => {
    const activeClass = currentRulesTab === tab.id ? 'btn-primary' : 'btn-secondary';
    return `
      <button class="gamemode-tab-btn ${activeClass}" onclick="switchRulesTab('${tab.id}')" id="rules-tab-${tab.id}">
        <img src="${tab.icon}" alt="${tab.name}" class="gamemode-tab-icon">
        <span class="gamemode-tab-text">${tab.name}</span>
      </button>
    `;
  }).join('');
}

function renderRulesContent() {
  const titleEl = document.getElementById('rulesTitle');
  const contentEl = document.getElementById('rulesContent');
  if (!titleEl || !contentEl) return;

  const tab = getRulesTabConfig().find(t => t.id === currentRulesTab) || { id: 'overall', name: 'Overall' };
  titleEl.innerHTML = `<i class="fas fa-book" style="color: var(--accent-color);"></i> ${tab.name} Rules`;
  contentEl.textContent = getRulesTextForTab(currentRulesTab);
}

window.switchRulesTab = function switchRulesTab(tabId) {
  currentRulesTab = tabId;
  renderRulesTabs();
  renderRulesContent();
};

async function initRulesPage() {
  try {
    const response = await fetch(`rules.txt?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load rules.txt (${response.status})`);
    }

    const rawText = await response.text();
    rulesSections = parseRulesSections(rawText);

    renderRulesTabs();
    renderRulesContent();

    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
      const user = await window.waitForAuthState();
      if (user && typeof initNavigation === 'function') {
        initNavigation();
      }
    }
  } catch (error) {
    const contentEl = document.getElementById('rulesContent');
    if (contentEl) {
      contentEl.textContent = `Unable to load rules. ${error.message}`;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRulesPage);
} else {
  initRulesPage();
}
