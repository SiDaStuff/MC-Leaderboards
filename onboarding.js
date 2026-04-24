// MC Leaderboards - Onboarding Logic

let currentStep = 1;
let selectedGamemodes = [];
let gamemodeSkillLevels = {}; // Store individual skill levels per gamemode
let verificationCheckInterval = null;
let initRetries = 0;
let isLinkInProgress = false;
let isSaveInProgress = false;
const MAX_INIT_RETRIES = 40;
const VERIFY_POLL_INTERVAL_MS = 5000;
const DASHBOARD_REDIRECT_DELAY_MS = 3000;
const VALID_USERNAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;

function setButtonState(button, { disabled, html }) {
  if (!button) return;
  if (typeof disabled === 'boolean') button.disabled = disabled;
  if (typeof html === 'string') button.innerHTML = html;
}

function normalizeRegionInput(region) {
  return String(region || '').trim().toUpperCase();
}

function showWarning(title, text) {
  Swal.fire({ icon: 'warning', title, text });
}

function showErrorModal(title, text) {
  Swal.fire({ icon: 'error', title, text });
}

/**
 * Validate if the current user can access a specific step
 */
async function canAccessStep(stepNumber) {
  try {
    const profile = AppState.getProfile();

    switch (stepNumber) {
      case 1:
        // Anyone can access step 1
        return true;

      case 2:
        // Must have completed step 1 (username, region, active verification code)
        if (!profile || !profile.minecraftUsername || !profile.region) {
          return false;
        }
        const verificationResponse = await apiService.get('/auth/verification-code');
        return verificationResponse.success && verificationResponse.verificationCode;

      case 3:
        // Must be fully verified
        return profile && profile.minecraftVerified;

      default:
        return false;
    }
  } catch (error) {
    console.error('Error validating step access:', error);
    return false;
  }
}

/**
 * Check for ban status before redirecting to dashboard
 * If banned, logout and show message instead of redirecting
 */
async function checkBanBeforeRedirect() {
  try {
    const profile = await apiService.getProfile();

    if (profile.banned) {
      // User is banned - check if ban has expired
      let isStillBanned = true;
      if (profile.banExpires && profile.banExpires !== 'permanent') {
        const banExpires = new Date(profile.banExpires);
        const now = new Date();
        if (banExpires <= now) {
          isStillBanned = false;
        }
      }

      if (isStillBanned) {
        // User is still banned - logout and show message
        await firebaseAuthService.signOut();

        // Close any existing success dialogs
        Swal.close();

        const banMessage = profile.banReason || 'Your account has been banned';
        const expiryInfo = profile.banExpires && profile.banExpires !== 'permanent'
          ? `\n\nBan expires: ${new Date(profile.banExpires).toLocaleString()}`
          : '\n\nThis ban is permanent.';

        Swal.fire({
          icon: 'error',
          title: 'Account Banned',
          text: banMessage + expiryInfo,
          confirmButtonText: 'OK',
          allowOutsideClick: false,
          allowEscapeKey: false
        });

        return false; // Don't proceed with redirect
      }
    }

    return true; // Safe to redirect
  } catch (error) {
    console.error('Error checking ban status:', error);
    // If we can't check ban status, assume it's safe to redirect
    return true;
  }
}

/**
 * Initialize onboarding
 */
async function initOnboarding() {
  // Wait for DOM to be ready
  if (!document.getElementById('step1') || !document.getElementById('step2') ||
      !document.getElementById('step1Card') || !document.getElementById('step2Card')) {
    if (initRetries < MAX_INIT_RETRIES) {
      initRetries += 1;
      setTimeout(initOnboarding, 100);
    } else {
      console.error('Onboarding initialization timed out waiting for DOM.');
      showError('Failed to initialize onboarding. Please refresh the page.');
    }
    return;
  }
  initRetries = 0;

  // Check current onboarding status
  try {
    const profile = await apiService.getProfile();
    AppState.setProfile(profile);

    // Check if onboarding is already completed
    if (profile.onboardingCompleted) {
      // Even if onboarding is completed, check if user has unverified Minecraft account
      // If so, force them back to onboarding to complete verification
      if (profile.minecraftUsername && profile.minecraftVerified === false) {
        console.log('User has unverified Minecraft account, redirecting to onboarding for verification');
        // Don't redirect to dashboard, continue with onboarding flow
        // Reset to step 2 for verification
        currentStep = 2;
        await showStep2();
        return;
      } else {
        // Check for ban before redirecting
        const canRedirect = await checkBanBeforeRedirect();
        if (canRedirect) {
          window.location.href = 'dashboard.html';
        }
        return;
      }
    }

    // Determine which step to show based on completion status
    if (profile.minecraftVerified && profile.minecraftUsername && profile.region) {
      // Fully verified, can proceed to gamemode selection
      console.log('Onboarding: User fully verified, showing step 3');
      currentStep = 3;
      await showStep3();
    } else if (profile.minecraftUsername && profile.region) {
      console.log('Onboarding: User has Minecraft data, checking verification status');
      // Has username/region, check if there's an active verification code
      try {
        const verificationResponse = await apiService.get('/auth/verification-code');
        if (verificationResponse.success && verificationResponse.verificationCode) {
          // Has active verification code, show step 2
          console.log('Onboarding: Active verification code found, showing step 2');
          currentStep = 2;
          await showStep2();
        } else {
          // No active verification code - clean up and restart
          console.log('Onboarding: No active verification code found, cleaning up and showing step 1');
          await cleanUpMinecraftData();
          currentStep = 1;
          showStep1();
        }
      } catch (error) {
        // Error checking verification code - clean up and restart
        console.log('Onboarding: Error checking verification code, cleaning up and showing step 1:', error.message);
        await cleanUpMinecraftData();
        currentStep = 1;
        showStep1();
      }
    } else {
      // Has not completed step 1, show step 1
      console.log('Onboarding: No Minecraft data found, showing step 1');
      currentStep = 1;
      showStep1();
    }

    // Show skip option for all users
    document.getElementById('skipSection').style.display = 'block';

    // Set up event listeners for buttons
    // The save preferences button handles completion
    // No additional setup needed - handleSavePreferences handles everything

    const backToGamemodeSelectionBtn = document.getElementById('backToGamemodeSelectionBtn');
    if (backToGamemodeSelectionBtn) {
      backToGamemodeSelectionBtn.addEventListener('click', handleBackToGamemodeSelection);
    }

  } catch (error) {
    console.error('Error initializing onboarding:', error);
    showError('Failed to load profile. Please try again.');
  }
}

/**
 * Show step 1
 */
function showStep1() {
  stopVerificationCheck();
  // Check if required elements exist
  const step1Card = document.getElementById('step1Card');
  const step2Card = document.getElementById('step2Card');

  if (!step1Card || !step2Card) {
    console.error('Required DOM elements not found for showStep1');
    return;
  }

  step1Card.style.display = 'block';
  step2Card.style.display = 'none';
  updateProgressIndicator();

  // Auto-fill form with existing data
  autoFillStep1();
}

/**
 * Auto-fill step 1 form with existing data
 */
function autoFillStep1() {
  try {
    const profile = AppState.getProfile();
    if (!profile) return;

    // Auto-fill username if it exists
    const usernameInput = document.getElementById('minecraftUsername');
    if (usernameInput && profile.minecraftUsername) {
      usernameInput.value = profile.minecraftUsername;
    }

    // Auto-fill region if it exists
    const regionSelect = document.getElementById('region');
    if (regionSelect && profile.region) {
      regionSelect.value = normalizeRegionInput(profile.region);
    }

    // If both username and region are filled, check verification status
    if (profile.minecraftUsername && profile.region) {
      const linkBtn = document.getElementById('linkAccountBtn');
      if (linkBtn) {
        if (profile.minecraftVerified) {
          // Already verified, can proceed to gamemode selection
          linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to Gamemode Selection';
          linkBtn.onclick = async () => {
            currentStep = 3;
            await showStep3();
          };
        } else {
          // Check if there's an active verification code
          apiService.get('/auth/verification-code')
            .then(response => {
              if (response.success && response.verificationCode) {
                // Has active verification code, can proceed to verification
                linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to Verification';
                linkBtn.onclick = () => {
                  currentStep = 2;
                  showStep2();
                };
              } else {
                // No active verification code - this shouldn't happen due to cleanup, but handle it
                console.log('User has Minecraft data but no active verification code - allowing re-link');
                linkBtn.innerHTML = '<i class="fas fa-link"></i> Link Account';
                linkBtn.onclick = (event) => {
                  event.preventDefault();
                  handleLinkAccount(event);
                };
              }
            })
            .catch(error => {
              // Error checking - allow re-linking
              console.log('Error checking verification code:', error.message);
              linkBtn.innerHTML = '<i class="fas fa-link"></i> Link Account';
              linkBtn.onclick = (event) => {
                event.preventDefault();
                handleLinkAccount(event);
              };
            });
        }
      }
    }
  } catch (error) {
    console.error('Error auto-filling step 1:', error);
  }
}

/**
 * Show step 2 - Verify Minecraft Account
 */
async function showStep2() {
  // Check if user can access step 2
  if (!(await canAccessStep(2))) {
    console.error('Access denied to step 2, redirecting to appropriate step');
    // The validation logic will handle redirection
    await initOnboarding();
    return;
  }

  // STRICT VALIDATION: Ensure step 1 is actually complete before showing step 2
  try {
    const profile = AppState.getProfile();

    // Must have username and region from step 1
    if (!profile || !profile.minecraftUsername || !profile.region) {
      console.error('Step 1 not complete - missing username or region, redirecting to step 1');
      currentStep = 1;
      showStep1();
      return;
    }

    // Must have an active verification code (step 1 successfully completed linking)
    const verificationResponse = await apiService.get('/auth/verification-code');
    if (!verificationResponse.success || !verificationResponse.verificationCode) {
      console.error('Step 1 not complete - no active verification code, cleaning up and redirecting to step 1');
      await cleanUpMinecraftData();
      currentStep = 1;
      showStep1();
      return;
    }

    // Step 1 is confirmed complete, show step 2
    console.log('Step 1 confirmed complete, showing step 2');

  } catch (error) {
    console.error('Error validating step 1 completion:', error);
    // On error, assume step 1 is not complete and clean up
    await cleanUpMinecraftData();
    currentStep = 1;
    showStep1();
    return;
  }

  // Check if required elements exist
  const step1Card = document.getElementById('step1Card');
  const step2Card = document.getElementById('step2Card');
  const step3Card = document.getElementById('step3Card');

  if (!step1Card || !step2Card || !step3Card) {
    console.error('Required DOM elements not found for showStep2');
    return;
  }

  step1Card.style.display = 'none';
  step2Card.style.display = 'block';
  step3Card.style.display = 'none';
  updateProgressIndicator();

  // Load and display verification code
  loadVerificationCode();

  // Start checking for verification completion
  startVerificationCheck();
}

/**
 * Show step 3 - Select Gamemodes
 */
async function showStep3() {
  // Check if user can access step 3
  if (!(await canAccessStep(3))) {
    console.error('Access denied to step 3, redirecting to appropriate step');
    await initOnboarding();
    return;
  }

  // STRICT VALIDATION: Ensure step 2 is complete (user is verified) before showing step 3
  try {
    const profile = AppState.getProfile();

    // Must be verified (step 2 complete)
    if (!profile || !profile.minecraftVerified) {
      console.error('Step 2 not complete - user not verified, redirecting to appropriate step');

      // Determine which step to go back to
      if (profile && profile.minecraftUsername && profile.region) {
        // Has step 1 data, check for verification code
        try {
          const verificationResponse = await apiService.get('/auth/verification-code');
          if (verificationResponse.success && verificationResponse.verificationCode) {
            currentStep = 2;
            showStep2();
          } else {
            await cleanUpMinecraftData();
            currentStep = 1;
            showStep1();
          }
        } catch (error) {
          await cleanUpMinecraftData();
          currentStep = 1;
          showStep1();
        }
      } else {
        // No step 1 data, go to step 1
        currentStep = 1;
        showStep1();
      }
      return;
    }

    console.log('Step 2 confirmed complete, showing step 3');

  } catch (error) {
    console.error('Error validating step 2 completion:', error);
    currentStep = 1;
    showStep1();
    return;
  }

  // Check if required elements exist
  const step1Card = document.getElementById('step1Card');
  const step2Card = document.getElementById('step2Card');
  const step3Card = document.getElementById('step3Card');
  const skillLevelSection = document.getElementById('skillLevelSection');

  if (!step1Card || !step2Card || !step3Card || !skillLevelSection) {
    console.error('Required DOM elements not found for showStep3');
    return;
  }

  step1Card.style.display = 'none';
  step2Card.style.display = 'none';
  step3Card.style.display = 'block';
  skillLevelSection.style.display = 'none';
  populateGamemodeSelection();
  updateProgressIndicator();

  // Auto-fill existing selections
  autoFillStep3();
}

/**
 * Clean up Minecraft-related data when linking is incomplete (secure backend call)
 */
async function cleanUpMinecraftData() {
  try {
    // Call secure backend endpoint to clean up data
    await apiService.post('/auth/cleanup-minecraft', {});

    // Update local profile after backend cleanup
    const updatedProfile = await apiService.getProfile();
    AppState.setProfile(updatedProfile);

    console.log('Securely cleaned up incomplete Minecraft linking data via backend');
  } catch (error) {
    console.error('Error cleaning up Minecraft data via backend:', error);
    // Even if cleanup fails, continue with onboarding to avoid blocking users
  }
}

/**
 * Auto-fill step 3 with existing gamemode and skill level selections
 */
function autoFillStep3() {
  try {
    const profile = AppState.getProfile();
    if (!profile || !profile.gamemodePreferences) return;

    // Auto-select previously chosen gamemodes
    if (profile.gamemodePreferences.selectedGamemodes) {
      profile.gamemodePreferences.selectedGamemodes.forEach(gamemodeId => {
        toggleGamemodeSelection(gamemodeId);
      });
    }

    // Auto-fill skill levels if they exist
    if (profile.gamemodePreferences.skillLevels) {
      Object.entries(profile.gamemodePreferences.skillLevels).forEach(([gamemodeId, skillLevel]) => {
        gamemodeSkillLevels[gamemodeId] = skillLevel;
      });
    }

    // Update UI based on current selections
    updateGamemodeSelectionUI();
    updateSaveButtonState();
  } catch (error) {
    console.error('Error auto-filling step 3:', error);
  }
}

/**
 * Update progress indicator
 */
function updateProgressIndicator() {
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');

  if (step1) step1.classList.toggle('active', currentStep >= 1);
  if (step2) step2.classList.toggle('active', currentStep >= 2);
  if (step3) step3.classList.toggle('active', currentStep >= 3);
}

/**
 * Load and display verification code
 */
async function loadVerificationCode() {
  try {
    const codeDisplay = document.getElementById('verificationCodeDisplay');
    const commandDisplay = document.getElementById('linkCommandDisplay');
    const codeDisplayDiv = document.getElementById('codeDisplay');
    const spinner = document.getElementById('verificationSpinner');
    const statusText = document.getElementById('verificationStatus');

    if (!codeDisplay || !commandDisplay || !codeDisplayDiv || !spinner || !statusText) {
      console.error('Required DOM elements not found for verification code display');
      return;
    }

    // Show loading state
    spinner.style.display = 'block';
    statusText.style.display = 'block';
    statusText.textContent = 'Loading verification code...';
    codeDisplayDiv.style.display = 'none';

    // Fetch verification code from backend
    const response = await apiService.get('/auth/verification-code');

    if (response.success && response.verificationCode) {
      // Hide spinner and show code
      spinner.style.display = 'none';
      statusText.style.display = 'none';
      codeDisplayDiv.style.display = 'block';

      codeDisplay.textContent = response.verificationCode;
      commandDisplay.textContent = `/link ${response.verificationCode}`;

      console.log('Verification code loaded from backend:', response.verificationCode);
    } else {
      // No verification code found
      spinner.style.display = 'none';
      statusText.textContent = 'No active verification code found. Please link your account first.';
      codeDisplayDiv.style.display = 'none';
      console.log('No verification code found in backend');
    }
  } catch (error) {
    console.error('Error loading verification code:', error);

    // Show error state
    const statusText = document.getElementById('verificationStatus');
    const spinner = document.getElementById('verificationSpinner');
    const codeDisplayDivError = document.getElementById('codeDisplay');
    if (statusText && spinner && codeDisplayDivError) {
      if (error.message && error.message.includes('No active verification code found')) {
        statusText.textContent = 'Please complete Step 1 first to generate a verification code.';
      } else {
        statusText.textContent = 'Error loading verification code. Please try refreshing the page.';
      }
      spinner.style.display = 'none';
      codeDisplayDivError.style.display = 'none';
    }
  }
}

/**
 * Start checking for verification completion
 */
function startVerificationCheck() {
  // Clear any existing interval
  if (verificationCheckInterval) {
    clearInterval(verificationCheckInterval);
  }

  // Check immediately
  checkVerificationStatus();

  // Then check every 5 seconds
  verificationCheckInterval = setInterval(checkVerificationStatus, VERIFY_POLL_INTERVAL_MS);
}

/**
 * Stop verification checking
 */
function stopVerificationCheck() {
  if (verificationCheckInterval) {
    clearInterval(verificationCheckInterval);
    verificationCheckInterval = null;
  }
}

/**
 * Check if verification is complete
 */
async function checkVerificationStatus() {
  try {
    const profile = await apiService.getProfile();

    if (profile.minecraftVerified) {
      // Verification complete!
      stopVerificationCheck();

      // Show success message and continue button
      const continueBtn = document.getElementById('continueToGamemodeBtn');
      const statusText = document.getElementById('verificationStatus');
      const spinner = document.getElementById('verificationSpinner');

      if (continueBtn && statusText && spinner) {
        spinner.style.display = 'none';
        statusText.textContent = 'Account successfully verified!';
        statusText.style.color = 'var(--success-color)';
        continueBtn.style.display = 'inline-block';
        continueBtn.onclick = async () => {
          currentStep = 3;
          await showStep3();
        };
      }
    }
  } catch (error) {
    // Keep polling even if a single request fails.
    console.warn('Verification status check failed:', error?.message || error);
  }
}

/**
 * Handle link account
 */
// Make function globally available
window.handleLinkAccount = async function(event) {
  event.preventDefault();

  if (isLinkInProgress) {
    return;
  }

  const usernameInput = document.getElementById('minecraftUsername');
  const regionSelect = document.getElementById('region');
  const linkBtn = document.getElementById('linkAccountBtn');
  const username = usernameInput ? usernameInput.value.trim() : '';
  const region = normalizeRegionInput(regionSelect ? regionSelect.value : '');

  if (!linkBtn) {
    showErrorModal('Page Error', 'Link button was not found. Please refresh and try again.');
    return;
  }

  if (!username) {
    showWarning('Username Required', 'Please enter your Minecraft username.');
    return;
  }
  if (!VALID_USERNAME_REGEX.test(username)) {
    showWarning('Invalid Username', 'Use 3-16 characters: letters, numbers, or underscore.');
    return;
  }

  if (!region) {
    showWarning('Region Required', 'Please select your gaming region.');
    return;
  }

  isLinkInProgress = true;
  setButtonState(linkBtn, { disabled: true, html: '<i class="fas fa-spinner fa-spin"></i> Linking...' });

  try {
    // Account not linked yet, proceed with linking
    const data = await apiService.linkMinecraftUsername(username, region);

    // Update local profile
    const updatedProfile = await apiService.getProfile();
    AppState.setProfile(updatedProfile);

    // Show verification code
    Swal.fire({
      icon: 'success',
      title: 'Linking Initiated!',
      html: `
        <p>Successfully initiated linking for <strong>${username}</strong>.</p>
        <p>Your verification code is:</p>
        <h2 style="color: #007bff; font-size: 2rem; margin: 1rem 0;">${data.verificationCode || 'Loading...'}</h2>
        <p>Join <strong>mc.sidastuff.com</strong> or <strong>spectorsmp.sidastuff.com</strong> and run:</p>
        <code style="background: #f8f9fa; padding: 0.5rem; border-radius: 4px; display: block; margin: 1rem 0;">/link ${data.verificationCode || 'CODE'}</code>
      `,
      confirmButtonText: 'Got it!',
      allowOutsideClick: false
    });

    // Move to step 2 (verification) - validation happens inside showStep2()
    currentStep = 2;
    await showStep2();
  } catch (error) {
    showErrorModal('Failed to Link Account', error.message || 'Please try again.');
  } finally {
    isLinkInProgress = false;
    setButtonState(linkBtn, { disabled: false, html: '<i class="fas fa-link"></i> Link Account' });
  }
}

/**
 * Populate gamemode selection
 */
function populateGamemodeSelection() {
  const container = document.getElementById('gamemodeSelection');
  if (!container) {
    console.error('gamemodeSelection container not found');
    return;
  }
  container.innerHTML = '';

  CONFIG.GAMEMODES.forEach(gamemode => {
    if (gamemode.id === 'overall') return;

    const gamemodeCard = document.createElement('div');
    gamemodeCard.className = 'gamemode-selection-card';
    gamemodeCard.dataset.gamemode = gamemode.id;
    gamemodeCard.setAttribute('role', 'button');
    gamemodeCard.setAttribute('tabindex', '0');
    gamemodeCard.setAttribute('aria-label', `Select ${gamemode.name}`);
    gamemodeCard.onclick = () => toggleGamemodeSelection(gamemode.id);
    gamemodeCard.onkeydown = (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggleGamemodeSelection(gamemode.id);
      }
    };

    gamemodeCard.innerHTML = `
      <img src="${gamemode.icon}" alt="${gamemode.name}" class="gamemode-selection-icon">
      <div class="gamemode-selection-name">${gamemode.name}</div>
      <div class="gamemode-selection-check">
        <i class="fas fa-check"></i>
      </div>
    `;

    container.appendChild(gamemodeCard);
  });
}

/**
 * Populate skill level selection for each selected gamemode
 */
function populateGamemodeSkillLevels() {
  const container = document.getElementById('gamemodeSkillLevels');
  if (!container) {
    console.error('gamemodeSkillLevels container not found');
    return;
  }

  // Get the skill level template
  const templateContainer = document.querySelector('.skill-level-templates');
  if (!templateContainer) {
    console.error('Skill level template not found');
    return;
  }

  // Get the skill level template options
  const skillLevelOptions = templateContainer.querySelector('.skill-level-options');
  if (!skillLevelOptions) {
    console.error('Skill level options template not found');
    return;
  }
  container.innerHTML = '';

  // Create skill level selection for each selected gamemode
  selectedGamemodes.forEach(gamemodeId => {
    const gamemode = CONFIG.GAMEMODES.find(g => g.id === gamemodeId);
    if (!gamemode) return;

    const gamemodeSkillCard = document.createElement('div');
    gamemodeSkillCard.className = 'gamemode-skill-card mb-4';
    gamemodeSkillCard.dataset.gamemode = gamemodeId;

    gamemodeSkillCard.innerHTML = `
      <div class="gamemode-skill-header mb-3">
        <img src="${gamemode.icon}" alt="${gamemode.name}" class="gamemode-skill-icon">
        <h6 class="gamemode-skill-title">${gamemode.name}</h6>
      </div>
      <div class="gamemode-skill-options">
        ${skillLevelOptions.innerHTML}
      </div>
    `;

    // Add event listeners to skill level options
    gamemodeSkillCard.querySelectorAll('.skill-level-option').forEach(option => {
      option.addEventListener('click', () => selectGamemodeSkillLevel(gamemodeId, option));
    });

    container.appendChild(gamemodeSkillCard);
  });
}

/**
 * Select skill level for a specific gamemode
 */
function selectGamemodeSkillLevel(gamemodeId, optionElement) {
  const skillLevel = parseInt(optionElement.dataset.elo, 10);
  if (!Number.isFinite(skillLevel)) {
    return;
  }

  // Remove selected class from all options in this gamemode
  const gamemodeCard = document.querySelector(`[data-gamemode="${gamemodeId}"].gamemode-skill-card`);
  if (gamemodeCard) {
    gamemodeCard.querySelectorAll('.skill-level-option').forEach(opt => {
      opt.classList.remove('selected');
    });
  }

  // Add selected class to clicked option
  optionElement.classList.add('selected');

  // Store the skill level for this gamemode
  gamemodeSkillLevels[gamemodeId] = skillLevel;

  // Check if all gamemodes have skill levels selected
  updateSaveButtonState();
}

/**
 * Update save button state based on skill level selections
 */
function updateSaveButtonState() {
  const saveBtn = document.getElementById('savePreferencesBtn');
  if (!saveBtn) return;

  const allSelected = selectedGamemodes.length > 0 &&
    selectedGamemodes.every(gamemodeId => gamemodeSkillLevels[gamemodeId] !== undefined);
  saveBtn.disabled = !allSelected;
}

/**
 * Toggle gamemode selection
 */
function toggleGamemodeSelection(gamemodeId) {
  const card = document.querySelector(`[data-gamemode="${gamemodeId}"]`);
  if (!card) return;
  const isSelected = card.classList.contains('selected');

  if (isSelected) {
    card.classList.remove('selected');
    selectedGamemodes = selectedGamemodes.filter(id => id !== gamemodeId);
  } else {
    card.classList.add('selected');
    if (!selectedGamemodes.includes(gamemodeId)) {
      selectedGamemodes.push(gamemodeId);
    }
  }

  // Enable/disable next button based on selection
  updateGamemodeSelectionUI();
}

/**
 * Update gamemode selection UI
 */
function updateGamemodeSelectionUI() {
  const nextBtn = document.getElementById('nextToSkillLevelBtn');
  if (nextBtn) {
    nextBtn.disabled = selectedGamemodes.length === 0;
  }
}

/**
 * Handle next to skill level selection
 */
// Make function globally available
window.handleNextToSkillLevel = function() {
  if (selectedGamemodes.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'No Gamemodes Selected',
      text: 'Please select at least one gamemode to continue.'
    });
    return;
  }

  const gamemodeSelection = document.getElementById('gamemodeSelection');
  const skillLevelSection = document.getElementById('skillLevelSection');
  if (!gamemodeSelection || !skillLevelSection) return;
  gamemodeSelection.style.display = 'none';
  skillLevelSection.style.display = 'block';

  // Populate individual skill level selection for each gamemode
  populateGamemodeSkillLevels();
}

/**
 * Select skill level
 */
function selectSkillLevel(optionElement) {
  // Remove selected class from all options
  document.querySelectorAll('.skill-level-option').forEach(opt => {
    opt.classList.remove('selected');
  });

  // Add selected class to clicked option
  optionElement.classList.add('selected');

  // Store selected skill level
  selectedSkillLevel = parseInt(optionElement.dataset.elo);
}

/**
 * Handle complete setup
 */
// Make function globally available
window.handleSavePreferences = async function() {
  if (isSaveInProgress) {
    return;
  }

  // Check if all gamemodes have skill levels selected
  const missingSkillLevels = selectedGamemodes.filter(gamemodeId => !gamemodeSkillLevels[gamemodeId]);

  if (missingSkillLevels.length > 0) {
    Swal.fire({
      icon: 'warning',
      title: 'Skill Levels Required',
      text: 'Please select a skill level for all selected gamemodes.'
    });
    return;
  }

  if (selectedGamemodes.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'No Gamemodes Selected',
      text: 'Please go back and select at least one gamemode.'
    });
    return;
  }

  try {
    const saveBtn = document.getElementById('savePreferencesBtn');
    if (!saveBtn) return;
    isSaveInProgress = true;
    setButtonState(saveBtn, { disabled: true, html: '<i class="fas fa-spinner fa-spin"></i> Setting up...' });

    // Save gamemode preferences and individual skill levels
    const orderedGamemodes = (CONFIG.GAMEMODES || [])
      .map(g => g.id)
      .filter(id => id !== 'overall' && selectedGamemodes.includes(id));
    await apiService.saveOnboardingPreferences(orderedGamemodes, gamemodeSkillLevels);

    // Mark onboarding as completed
    await apiService.completeOnboarding();

    Swal.fire({
      icon: 'success',
      title: 'Setup Complete!',
      text: 'Your account has been fully set up. Welcome to MC Leaderboards!',
      timer: 3000,
      showConfirmButton: false
    });

    // Redirect to dashboard after a short delay
    setTimeout(async () => {
      const canRedirect = await checkBanBeforeRedirect();
      if (canRedirect) {
        window.location.href = 'dashboard.html';
      } else {
        const saveBtn = document.getElementById('savePreferencesBtn');
        setButtonState(saveBtn, { disabled: false, html: '<i class="fas fa-check"></i> Complete Setup' });
        isSaveInProgress = false;
      }
    }, DASHBOARD_REDIRECT_DELAY_MS);

  } catch (error) {
    showErrorModal('Failed to Complete Setup', error.message || 'Please try again.');
    const saveBtn = document.getElementById('savePreferencesBtn');
    setButtonState(saveBtn, { disabled: false, html: '<i class="fas fa-check"></i> Complete Setup' });
    isSaveInProgress = false;
  }
}

/**
 * Handle back to gamemode selection
 */
function handleBackToGamemodeSelection() {
  const skillLevelSection = document.getElementById('skillLevelSection');
  const gamemodeSelection = document.getElementById('gamemodeSelection');
  if (!skillLevelSection || !gamemodeSelection) return;
  skillLevelSection.style.display = 'none';
  gamemodeSelection.style.display = 'block';

  // Remove selected class from skill level options
  document.querySelectorAll('.skill-level-option').forEach(opt => {
    opt.classList.remove('selected');
  });
}

/**
 * Handle skip onboarding (admin only)
 */

/**
 * Show error message
 */
function showError(message) {
  const container = document.querySelector('main .container');
  if (container) {
    container.innerHTML = `
      <div class="alert alert-error">
        <i class="fas fa-exclamation-circle"></i> ${escapeHtml(message)}
      </div>
    `;
  }
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.copyVerificationCommand = async function() {
  try {
    const commandEl = document.getElementById('linkCommandDisplay');
    const command = commandEl ? commandEl.textContent.trim() : '';
    if (!command) return;
    await navigator.clipboard.writeText(command);
    Swal.fire({ icon: 'success', title: 'Copied', text: 'Link command copied to clipboard.', timer: 1200, showConfirmButton: false });
  } catch (error) {
    console.warn('Clipboard copy failed:', error);
  }
};

window.addEventListener('beforeunload', () => {
  stopVerificationCheck();
});
