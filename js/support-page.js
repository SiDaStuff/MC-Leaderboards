const SUPPORT_CATEGORY_META = {
  player_report: {
    icon: 'fa-flag',
    title: 'Player Report',
    summary: 'Use this for cheating, harassment, impersonation, match throwing, or suspected alt accounts. Include the player name, match ID, and evidence when possible.',
    hint: 'Best for moderation issues involving another player.',
    descriptionLabel: 'What happened? *',
    descriptionPlaceholder: 'Describe what happened, when it happened, what rule was broken, and anything staff should review.',
    submitLabel: '<i class="fas fa-flag"></i> Submit Player Report'
  },
  website_issue: {
    icon: 'fa-globe',
    title: 'Website Issue',
    summary: 'Use this for broken pages, blank sections, visual bugs, or actions that fail while using the site.',
    hint: 'Include the page you were on, what you clicked, and what should have happened.',
    descriptionLabel: 'What part of the site is broken? *',
    descriptionPlaceholder: 'Tell us which page you were on, what you expected to happen, what actually happened, and whether it happens every time.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  },
  tiering_system_issue: {
    icon: 'fa-layer-group',
    title: 'Tiering System Issue',
    summary: 'Use this for queue behavior, tier placement concerns, role questions, or tester workflow issues.',
    hint: 'Helpful details include your gamemode, region, queue state, and any recent match context.',
    descriptionLabel: 'What is wrong with the tiering or queue flow? *',
    descriptionPlaceholder: 'Explain the tiering or queue issue, what gamemode and region were involved, and how it affected your testing flow.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  },
  leaderboard_problem: {
    icon: 'fa-trophy',
    title: 'Leaderboard Problem',
    summary: 'Use this for incorrect stats, missing matches, wrong ratings, or profile leaderboard data that looks stale.',
    hint: 'Adding the match ID, player name, and the stat that looks wrong helps a lot.',
    descriptionLabel: 'What leaderboard data looks incorrect? *',
    descriptionPlaceholder: 'Tell us which leaderboard, player, or match is affected and describe the incorrect rating, placement, or stat.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  },
  account_issue: {
    icon: 'fa-user-shield',
    title: 'Account Issue',
    summary: 'Use this for login trouble, linked account problems, permission issues, or profile access concerns.',
    hint: 'Include the email used, whether you can still sign in, and any recent changes to the account.',
    descriptionLabel: 'What account issue do you need help with? *',
    descriptionPlaceholder: 'Explain the account problem, what you tried already, and whether the issue affects sign-in, linking, or permissions.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  },
  bug_report: {
    icon: 'fa-bug',
    title: 'Bug Report',
    summary: 'Use this for repeatable defects, unexpected behavior, or technical problems that staff should reproduce and fix.',
    hint: 'The best bug reports include exact steps, expected behavior, actual behavior, and screenshots or console errors.',
    descriptionLabel: 'How can staff reproduce the bug? *',
    descriptionPlaceholder: 'List the exact steps to reproduce the bug, what you expected to happen, and what actually happened instead.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  },
  other: {
    icon: 'fa-compass',
    title: 'General Support',
    summary: 'Use this for questions or requests that do not fit a specific category above.',
    hint: 'Choose the closest category when possible so staff can route it faster.',
    descriptionLabel: 'Describe the issue *',
    descriptionPlaceholder: 'Please explain the issue or question in as much detail as possible.',
    submitLabel: '<i class="fas fa-paper-plane"></i> Submit Support Request'
  }
};

function toggleFaq(element) {
  const item = element?.closest('.faq-item');
  const answer = item?.querySelector('.faq-answer');
  if (!item || !answer) return;

  const isActive = element.classList.contains('active');
  document.querySelectorAll('.faq-item').forEach((faq) => {
    if (faq !== item) {
      faq.querySelector('.faq-question')?.classList.remove('active');
      faq.querySelector('.faq-answer')?.classList.remove('active');
    }
  });

  element.classList.toggle('active', !isActive);
  answer.classList.toggle('active', !isActive);
}

function scrollToSupportForm() {
  document.getElementById('supportRequestSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseSupportEvidenceLinks(rawValue) {
  return String(rawValue || '')
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isPlayerReportCategory(category) {
  return String(category || '').trim().toLowerCase() === 'player_report';
}

function getSupportCategoryMeta(category) {
  return SUPPORT_CATEGORY_META[String(category || '').trim().toLowerCase()] || SUPPORT_CATEGORY_META.other;
}

function updateSupportNav({ signedIn = false } = {}) {
  const nav = document.getElementById('navbarNav');
  if (!nav) return;

  nav.innerHTML = signedIn
    ? `
      <li><a href="dashboard.html">Dashboard</a></li>
      <li><a href="account.html">Account</a></li>
      <li><a href="#" onclick="handleLogout()">Logout</a></li>
    `
    : `
      <li><a href="index.html">Leaderboards</a></li>
      <li><a href="login.html">Login</a></li>
      <li><a href="signup.html">Sign Up</a></li>
    `;
}

function setSupportSessionNote(message) {
  const note = document.getElementById('supportSessionNote');
  if (note) {
    note.textContent = message;
  }
}

function fillSupportIdentity({ email = '', minecraftUsername = '', signedIn = false } = {}) {
  const emailInput = document.getElementById('supportEmail');
  const usernameInput = document.getElementById('supportMinecraftUsername');

  if (emailInput) {
    if (signedIn || !emailInput.value) {
      emailInput.value = email;
    }
    emailInput.readOnly = signedIn;
  }

  if (usernameInput && minecraftUsername && (signedIn || !usernameInput.value)) {
    usernameInput.value = minecraftUsername;
  }
}

function syncSupportCategoryCards(category) {
  document.querySelectorAll('.support-category-card').forEach((card) => {
    const isActive = card.dataset.category === category;
    card.classList.toggle('is-active', isActive);
    card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function updateSupportCategorySummary(category) {
  const titleEl = document.getElementById('supportCategorySummaryTitle');
  const textEl = document.getElementById('supportCategorySummaryText');
  const iconEl = document.getElementById('supportCategorySummaryIcon');
  const helpEl = document.getElementById('supportCategoryHelp');

  if (!category) {
    if (titleEl) titleEl.textContent = 'Pick a category to tailor the form';
    if (textEl) textEl.textContent = 'We will show the most helpful prompts for your report or support request here.';
    if (helpEl) helpEl.textContent = 'Choose the category that best matches your issue.';
    if (iconEl) iconEl.innerHTML = '<i class="fas fa-life-ring"></i>';
    return;
  }

  const meta = getSupportCategoryMeta(category);
  if (titleEl) titleEl.textContent = meta.title;
  if (textEl) textEl.textContent = meta.summary;
  if (helpEl) helpEl.textContent = meta.hint;
  if (iconEl) iconEl.innerHTML = `<i class="fas ${meta.icon}"></i>`;
}

function setSupportCategory(category, { updateUI = true } = {}) {
  const categorySelect = document.getElementById('supportCategory');
  if (!categorySelect) return;
  categorySelect.value = category || '';
  if (updateUI) {
    updateSupportCategoryUI();
  }
}

function updateSupportCategoryUI() {
  const category = document.getElementById('supportCategory')?.value || '';
  const isPlayerReport = isPlayerReportCategory(category);
  const reportFields = document.getElementById('supportReportFields');
  const descriptionLabel = document.getElementById('supportDescriptionLabel');
  const descriptionInput = document.getElementById('supportDescription');
  const submitBtn = document.getElementById('supportSubmitBtn');
  const authNotice = document.getElementById('supportReportAuthNotice');
  const activeUser = typeof firebaseAuthService !== 'undefined'
    ? firebaseAuthService.getCurrentUser()
    : null;
  const meta = category ? getSupportCategoryMeta(category) : null;

  reportFields?.classList.toggle('d-none', !isPlayerReport);
  syncSupportCategoryCards(category);
  updateSupportCategorySummary(category);

  if (descriptionLabel) {
    descriptionLabel.textContent = meta?.descriptionLabel || 'Describe the issue *';
  }

  if (descriptionInput) {
    descriptionInput.placeholder = meta?.descriptionPlaceholder || 'Please explain the issue or question in as much detail as possible.';
  }

  if (submitBtn) {
    submitBtn.innerHTML = meta?.submitLabel || '<i class="fas fa-paper-plane"></i> Submit Support Request';
  }

  if (authNotice) {
    authNotice.classList.toggle('alert-danger', isPlayerReport && !activeUser);
    authNotice.classList.toggle('alert-warning', !(isPlayerReport && !activeUser));
    const noticeText = authNotice.querySelector('span');
    if (noticeText) {
      noticeText.textContent = isPlayerReport && !activeUser
        ? 'Sign in before sending a player report. Support tickets still work while signed out.'
        : 'Player reports require a signed-in account so staff can follow up with you and prevent abuse.';
    }
  }
}

function prefillSupportFormFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const category = params.get('category') || '';
  const reportedPlayer = params.get('player') || '';
  const matchId = params.get('matchId') || '';
  const reportedUUID = params.get('uuid') || '';

  if (category) {
    setSupportCategory(category, { updateUI: false });
  }

  if (reportedPlayer) {
    const reportedPlayerInput = document.getElementById('supportReportedPlayer');
    if (reportedPlayerInput) {
      reportedPlayerInput.value = reportedPlayer;
    }
  }

  if (matchId) {
    const matchIdInput = document.getElementById('supportMatchId');
    if (matchIdInput) {
      matchIdInput.value = matchId;
    }
  }

  if (reportedUUID) {
    const reportedUuidInput = document.getElementById('supportReportedUUID');
    if (reportedUuidInput) {
      reportedUuidInput.value = reportedUUID;
    }
  }

  updateSupportCategoryUI();
}

function attachSupportCategoryCardHandlers() {
  document.querySelectorAll('.support-category-card').forEach((card) => {
    card.addEventListener('click', () => {
      setSupportCategory(card.dataset.category || '');
    });
  });
}

async function initSupportIdentity() {
  updateSupportNav({ signedIn: false });
  setSupportSessionNote('You can submit this form while signed out, or sign in for automatic account autofill.');

  if (typeof firebaseAuthService === 'undefined') {
    return;
  }

  let currentUser = firebaseAuthService.getCurrentUser();
  let waitAttempts = 0;
  while (!currentUser && waitAttempts < 20) {
    await new Promise((resolve) => setTimeout(resolve, 125));
    currentUser = firebaseAuthService.getCurrentUser();
    waitAttempts++;
  }

  if (!currentUser) {
    return;
  }

  try {
    const context = typeof firebaseAuthService.loadCurrentAccountContext === 'function'
      ? await firebaseAuthService.loadCurrentAccountContext({
          user: currentUser,
          forceProfileRefresh: false,
          requireProfile: false,
          reloadUser: false
        }).catch(() => ({ user: firebaseAuthService.getCurrentUser() || currentUser, profile: AppState.getProfile?.() || null }))
      : { user: firebaseAuthService.getCurrentUser() || currentUser, profile: AppState.getProfile?.() || null };

    const activeUser = context?.user || firebaseAuthService.getCurrentUser() || currentUser;
    if (!activeUser) return;

    if (typeof firebaseAuthService.ensureApiTokenReady === 'function') {
      await firebaseAuthService.ensureApiTokenReady(activeUser, { forceRefresh: false });
    }

    const profile = context?.profile || await apiService.getProfile().catch(() => null);
    if (profile) {
      AppState.setProfile(profile);
    }

    fillSupportIdentity({
      email: activeUser.email || '',
      minecraftUsername: profile?.minecraftUsername || '',
      signedIn: true
    });
    updateSupportNav({ signedIn: true });

    if (profile?.blacklisted === true) {
      setSupportSessionNote('Your account is blacklisted, but you can still submit a support request here.');
    } else {
      setSupportSessionNote('Signed in. Your email and linked Minecraft username have been prefilled for you.');
    }
    updateSupportCategoryUI();
  } catch (error) {
    console.warn('Unable to load support autofill context:', error);
    setSupportSessionNote('You can still submit the form manually if account autofill is unavailable right now.');
  }
}

async function submitSupportRequest(event) {
  event.preventDefault();

  const email = document.getElementById('supportEmail')?.value?.trim() || '';
  const minecraftUsername = document.getElementById('supportMinecraftUsername')?.value?.trim() || '';
  const category = document.getElementById('supportCategory')?.value || '';
  const description = document.getElementById('supportDescription')?.value?.trim() || '';
  const urgency = document.getElementById('supportUrgency')?.value || '';
  const anythingElse = document.getElementById('supportAnythingElse')?.value?.trim() || '';
  const rulesConfirmed = document.getElementById('supportRulesConfirmed')?.checked === true;
  const evidenceLinks = parseSupportEvidenceLinks(document.getElementById('supportEvidenceLinks')?.value || '');
  const reportedPlayer = document.getElementById('supportReportedPlayer')?.value?.trim() || '';
  const reportCategory = document.getElementById('supportReportCategory')?.value || 'other';
  const reportedUUID = document.getElementById('supportReportedUUID')?.value?.trim() || '';
  const matchId = document.getElementById('supportMatchId')?.value?.trim() || '';
  const isPlayerReport = isPlayerReportCategory(category);

  const validationError = Validator.firstError({
    email: Validator.email(email),
    category: Validator.required(category, 'Please choose what you need help with.'),
    description: Validator.required(description, 'Please describe the issue.'),
    descriptionLength: description.length >= 20 ? null : 'Please provide a little more detail so staff can help.',
    urgency: Validator.required(urgency, 'Please choose an urgency.'),
    rulesConfirmed: rulesConfirmed ? null : 'Please confirm that you have read the rules.',
    reportedPlayer: !isPlayerReport || reportedPlayer ? null : 'Please enter the player you want to report.'
  });

  if (validationError) {
    await MCLBUI.warning('Missing Information', validationError);
    return;
  }

  const invalidEvidenceLink = evidenceLinks.find((link) => Validator.url(link));
  if (invalidEvidenceLink) {
    await MCLBUI.warning('Invalid Evidence Link', 'Each evidence link must be a valid http or https URL.');
    return;
  }

  const payload = {
    email,
    minecraftUsername,
    category,
    description,
    evidenceLinks,
    urgency,
    anythingElse,
    rulesConfirmed
  };

  const submitBtn = document.getElementById('supportSubmitBtn');
  try {
    AuthUI.setBusy(submitBtn, true, null, '<i class="fas fa-spinner fa-spin"></i> Sending...');

    const activeUser = typeof firebaseAuthService !== 'undefined'
      ? firebaseAuthService.getCurrentUser()
      : null;

    let response;
    if (isPlayerReport) {
      if (!activeUser) {
        await MCLBUI.warning('Sign In Required', 'You need to sign in before submitting a player report.');
        return;
      }

      response = await apiService.submitPlayerReport({
        reportedPlayer,
        reportedUUID,
        category: reportCategory,
        matchId,
        description,
        evidenceLinks,
        hasEvidence: evidenceLinks.length > 0,
        reportedAt: new Date().toISOString()
      });
    } else if (activeUser) {
      response = await apiService.submitSupportTicket(payload);
    } else {
      response = await apiService.submitGuestSupportTicket(payload);
    }

    document.getElementById('supportReportedPlayer').value = '';
    document.getElementById('supportReportCategory').value = 'unfair_play';
    document.getElementById('supportReportedUUID').value = '';
    document.getElementById('supportMatchId').value = '';
    document.getElementById('supportCategory').value = '';
    document.getElementById('supportDescription').value = '';
    document.getElementById('supportEvidenceLinks').value = '';
    document.getElementById('supportUrgency').value = '';
    document.getElementById('supportAnythingElse').value = '';
    document.getElementById('supportRulesConfirmed').checked = false;

    await MCLBUI.success(
      isPlayerReport ? 'Player Report Submitted' : 'Support Request Submitted',
      isPlayerReport
        ? 'Your player report was submitted successfully. Staff will review it in the moderation queue.'
        : response?.ticket?.id
          ? `Your support request was submitted successfully. Ticket ID: ${response.ticket.id}`
          : 'Your support request was submitted successfully.'
    );
    updateSupportCategoryUI();
  } catch (error) {
    await MCLBUI.error('Unable to Submit Support Request', error?.message || 'Please try again in a moment.');
  } finally {
    AuthUI.setBusy(submitBtn, false);
  }
}

async function initSupportPage() {
  document.getElementById('supportRequestForm')?.addEventListener('submit', submitSupportRequest);
  document.getElementById('supportCategory')?.addEventListener('change', updateSupportCategoryUI);
  attachSupportCategoryCardHandlers();

  let attempts = 0;
  while ((typeof firebase === 'undefined' || !firebase.apps || firebase.apps.length === 0) && attempts < 80) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    attempts++;
  }

  prefillSupportFormFromQuery();
  await initSupportIdentity();
  updateSupportCategoryUI();
}

window.toggleFaq = toggleFaq;
window.scrollToSupportForm = scrollToSupportForm;

document.addEventListener('DOMContentLoaded', () => {
  void initSupportPage();
});
