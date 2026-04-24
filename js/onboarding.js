// MC Leaderboards - Onboarding Logic

let selectedGamemodes = [];
let gamemodeSkillLevels = {}; // Store individual skill levels per gamemode
let verificationCheckInterval = null;
let verificationCheckAttempts = 0;
let verificationCheckDelay = 3000; // Start with 3 seconds
let currentDisplayedStep = 1; // Only for UI state, not persistent
let verificationCodeCache = null; // Cache verification code result
let verificationCodeCacheTime = 0; // Cache timestamp
let onboardingRealtimeConnection = null;
let onboardingRealtimeRetryTimeout = null;

async function applyRealtimeOnboardingProfile(profile) {
  if (!profile) return;

  AppState.setProfile(profile);

  if (profile.onboardingCompleted === true) {
    showThemedPopup('Onboarding Complete!', 'You have completed onboarding. Redirecting to dashboard...');
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 2000);
    return;
  }

  if (profile.minecraftVerified && profile.minecraftUsername && profile.region) {
    if (currentDisplayedStep !== 3) {
      currentDisplayedStep = 3;
      await showStep3();
    }
    return;
  }

  if (profile.minecraftUsername && profile.region) {
    if (currentDisplayedStep !== 2) {
      currentDisplayedStep = 2;
      showStep2();
    }
    await loadVerificationCode().catch(() => null);
    return;
  }

  if (currentDisplayedStep !== 1) {
    currentDisplayedStep = 1;
    showStep1();
  }
}

// Real-time SSE connection for onboarding
function startOnboardingSSE() {
  if (onboardingRealtimeConnection) return;
  const userId = AppState.getUserId?.() || AppState.currentUser?.uid || AppState.getProfile?.()?.uid;
  if (!userId) {
    if (!onboardingRealtimeRetryTimeout) {
      onboardingRealtimeRetryTimeout = setTimeout(() => {
        onboardingRealtimeRetryTimeout = null;
        startOnboardingSSE();
      }, 500);
    }
    return;
  }
  const sseUrl = `/api/user/${userId}/stream`;

  const handleEvent = (eventName, data) => {
    if (eventName === 'onboarding') {
      if (data.completed) {
        showThemedPopup('Onboarding Complete!', 'You have completed onboarding. Redirecting to dashboard...');
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 2000);
      }
      return;
    }

    if (eventName === 'profile') {
      if (data.profile) {
        applyRealtimeOnboardingProfile(data.profile).catch((error) => {
          console.warn('Failed applying realtime onboarding profile:', error);
        });
      }
      return;
    }

    if (eventName === 'notifications' && data.notifications) {
      handleRealtimeNotifications(data.notifications);
    }
  };

  if (window.MCLBRealtimeStream?.connect) {
    const connection = window.MCLBRealtimeStream.connect({
      url: sseUrl,
      onOpen: () => {
        console.log('Onboarding SSE connected');
      },
      onEvent: (eventName, data) => {
        if (eventName === 'ping') return;
        handleEvent(eventName, data || {});
      },
      onError: (error) => {
        console.warn('Onboarding SSE error', error);
      }
    });

    onboardingRealtimeConnection = {
      close: () => connection.close()
    };
    return;
  }

  const evtSource = new EventSource(sseUrl, { withCredentials: true });
  onboardingRealtimeConnection = evtSource;

  evtSource.onopen = () => {
    console.log('Onboarding SSE connected');
  };
  evtSource.onerror = (e) => {
    console.warn('Onboarding SSE error', e);
  };

  ['onboarding', 'profile', 'notifications', 'ping'].forEach((eventName) => {
    evtSource.addEventListener(eventName, (event) => {
      if (eventName === 'ping') return;
      const data = event?.data ? JSON.parse(event.data) : {};
      handleEvent(eventName, data);
    });
  });
}

function handleRealtimeNotifications(notifications) {
  Object.values(notifications).forEach((n) => {
    if (!n || !n.id) return;
    showThemedPopup(n.title || 'Notification', n.message || 'You have a new update.');
  });
}

function showThemedPopup(title, message) {
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: `<span style=\"color:var(--primary-color)\">${title}</span>`,
      html: `<div style=\"color:var(--text-color)\">${message}</div>`,
      background: 'var(--background-color, #181a1b)',
      color: 'var(--text-color, #e0e0e0)',
      showConfirmButton: false,
      timer: 4000,
      toast: true,
      position: 'top-end',
      customClass: {
        popup: 'mclb-themed-popup',
        title: 'mclb-themed-popup-title',
        content: 'mclb-themed-popup-content'
      }
    });
  } else {
    alert(title + '\n' + message);
  }
}

/**
 * Generate new verification code
 */
window.generateNewCode = async function() {
  try {
    const generateBtn = document.querySelector('.generate-code-btn');
    const originalText = generateBtn.innerHTML;
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';

    // Get current profile data first
    const profile = AppState.getProfile();
    if (!profile || !profile.minecraftUsername || !profile.region) {
      throw new Error('Please complete step 1 first.');
    }

    // Clean up any existing verification data before generating new code
    await cleanUpMinecraftData();

    // Generate new verification code
    const data = await apiService.linkMinecraftUsername(profile.minecraftUsername, profile.region);

    // Clear cache to ensure fresh data
    apiService.clearCache('/users/me');
    apiService.clearCache('/auth/verification-code');
    
    // Update local profile with fresh data
    const updatedProfile = await apiService.getProfileQuick();
    AppState.setProfile(updatedProfile);

    // Reload verification code display
    await loadVerificationCode();

    Swal.fire({
      icon: 'success',
      title: 'New Code Generated!',
      text: 'A new verification code has been generated. Use it within 15 minutes.',
      timer: 3000,
      showConfirmButton: false
    });

  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Generate New Code',
      text: error.message
    });
  } finally {
    const generateBtn = document.querySelector('.generate-code-btn');
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Generate New Code';
    }
  }
};

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
        // Use noCache option to get fresh verification code status
        const verificationResponse = await apiService.request('/auth/verification-code', { 
          method: 'GET',
          noCache: true,
          timeout: 5000
        });
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
    console.log('DOM not ready, retrying initOnboarding...');
    setTimeout(initOnboarding, 100);
    return;
  }

  // Start real-time onboarding SSE
  startOnboardingSSE();

  // Check current onboarding status
  try {
    const profile = await apiService.getProfile();
    AppState.setProfile(profile);

    // Check if onboarding is already completed
    if (profile.onboardingCompleted === true) {
      console.log('Onboarding already completed, redirecting to dashboard');
      
      // Show a brief message
      Swal.fire({
        icon: 'info',
        title: 'Already Completed',
        text: 'You have already completed onboarding. Redirecting to dashboard...',
        timer: 2000,
        showConfirmButton: false
      });

        // Check for ban before redirecting
      setTimeout(async () => {
        const canRedirect = await checkBanBeforeRedirect();
        if (canRedirect) {
          window.location.href = 'dashboard.html';
        }
      }, 2000);
      
        return;
    }

    // Determine which step to show based on completion status
    if (profile.minecraftVerified && profile.minecraftUsername && profile.region) {
      // Fully verified, can proceed to gamemode selection
      console.log('Onboarding: User fully verified, showing step 3');
      currentDisplayedStep = 3;
      await showStep3();
    } else if (profile.minecraftVerified && profile.minecraftUsername && !profile.region) {
      // Force-linked: username verified but no region selected yet — skip to step 1 with username locked
      console.log('Onboarding: Force-linked user detected (verified but no region), showing step 1 with username locked');
      currentDisplayedStep = 1;
      showStep1();
      // Lock the username field and update the form for region-only selection
      const usernameInput = document.getElementById('minecraftUsername');
      if (usernameInput) {
        usernameInput.value = profile.minecraftUsername;
        usernameInput.disabled = true;
        usernameInput.style.opacity = '0.7';
      }
      const linkBtn = document.getElementById('linkAccountBtn');
      if (linkBtn) {
        linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue';
        linkBtn.onclick = async (event) => {
          event.preventDefault();
          const regionSelect = document.getElementById('region');
          const region = regionSelect ? regionSelect.value : '';
          if (!region) {
            Swal.fire({ icon: 'warning', title: 'Region Required', text: 'Please select your gaming region to continue.' });
            return;
          }
          linkBtn.disabled = true;
          linkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
          try {
            await apiService.put('/users/me', { region });
            apiService.clearCache('/users/me');
            const updatedProfile = await apiService.getProfileQuick();
            AppState.setProfile(updatedProfile);
            currentDisplayedStep = 3;
            await showStep3();
          } catch (error) {
            console.error('Error saving region:', error);
            Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to save region. Please try again.' });
            linkBtn.disabled = false;
            linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue';
          }
        };
      }
    } else if (profile.minecraftUsername && profile.region) {
      console.log('Onboarding: User has Minecraft data, checking verification status');
      // Has username/region, check if there's an active verification code
      try {
        const verificationResponse = await apiService.get('/auth/verification-code');

        if (verificationResponse.success && verificationResponse.verificationCode) {
          // Has active verification code, show step 2
          console.log('Onboarding: Active verification code found, showing step 2');
          currentDisplayedStep = 2;
          await showStep2();
        } else {
          // No active verification code - clean up and restart
          console.log('Onboarding: No active verification code found, cleaning up and showing step 1');
          await cleanUpMinecraftData();
          currentDisplayedStep = 1;
          showStep1();
        }
      } catch (error) {
        // Error checking verification code - clean up and restart
        console.log('Onboarding: Error checking verification code, cleaning up and showing step 1:', error.message);
        await cleanUpMinecraftData();
        currentDisplayedStep = 1;
        showStep1();
      }
    } else {
      // Has not completed step 1, show step 1
      console.log('Onboarding: No Minecraft data found, showing step 1');
      currentDisplayedStep = 1;
      showStep1();
    }

    // Show skip option for all users (skip section removed for simplicity)

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
      regionSelect.value = profile.region;
    }

    // If both username and region are filled, check verification status
    if (profile.minecraftUsername && profile.region) {
      const linkBtn = document.getElementById('linkAccountBtn');
      if (linkBtn) {
        if (profile.minecraftVerified) {
          // Already verified, can proceed to gamemode selection
          linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to Gamemode Selection';
          linkBtn.onclick = async () => {
            currentDisplayedStep = 3;
            await showStep3();
          };
        } else {
          // Check if there's an active verification code from backend
          apiService.get('/auth/verification-code')
            .then(response => {
              if (response.success && response.verificationCode) {
                // Has active verification code, can proceed to verification
                linkBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to Verification';
                linkBtn.onclick = () => {
                  currentDisplayedStep = 2;
                  showStep2();
                };
              } else {
                // No active verification code - allow re-linking
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
 * Check verification status via server polling
 */
async function checkVerificationStatusOnce() {
  try {
    // Use quick profile check with short timeout
    const profile = await apiService.getProfileQuick();
    
    if (profile.minecraftVerified) {
      console.log('Server poll: User verification completed!');
      stopVerificationCheck();
      showVerificationSuccess();
      return true; // Verification completed
    }
    return false; // Still waiting
  } catch (error) {
    // Only log error in debug mode to avoid console spam
    if (CONFIG.DEBUG_MODE) {
      console.warn('Verification check failed (will retry):', error.message);
    }
    return false;
  }
}

/**
 * Show verification success
 */
function showVerificationSuccess() {
  const continueBtn = document.getElementById('continueToGamemodeBtn');
  const statusText = document.getElementById('verificationStatus');
  const spinner = document.getElementById('verificationSpinner');

  if (continueBtn && statusText && spinner) {
    spinner.style.display = 'none';
    statusText.textContent = 'Account successfully verified!';
    statusText.style.color = 'var(--success-color)';
    continueBtn.style.display = 'inline-block';
    continueBtn.onclick = async () => {
      currentDisplayedStep = 3;
      await showStep3();
    };
  }

  // Trigger confetti celebration
  if (typeof confetti === 'function') {
    // Fire confetti from both sides
    const duration = 3 * 1000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 10000 };

    function randomInRange(min, max) {
      return Math.random() * (max - min) + min;
    }

    const interval = setInterval(function() {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);

      // Left side
      confetti(Object.assign({}, defaults, {
        particleCount,
        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }
      }));
      
      // Right side
      confetti(Object.assign({}, defaults, {
        particleCount,
        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }
      }));
    }, 250);
  }

  // Show popup asking to continue
  Swal.fire({
    icon: 'success',
    title: 'Verification Complete! 🎉',
    html: '<p>Your Minecraft account has been successfully verified!</p><p class="text-muted">You can now continue to the next step.</p>',
    confirmButtonText: 'Continue to Gamemode Selection',
    confirmButtonColor: '#3498db',
    allowOutsideClick: false,
    allowEscapeKey: false
  }).then((result) => {
    if (result.isConfirmed) {
      currentDisplayedStep = 3;
      showStep3();
    }
  });
}

/**
 * Show step 2 - Verify Minecraft Account
 */
async function showStep2() {
  // Validation already done in initOnboarding, just show the step
  console.log('Showing step 2 - verification');

  // Start server polling for verification status
  startVerificationPolling();

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
  // Validation already done in initOnboarding, just show the step
  console.log('Showing step 3 - gamemode selection');

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

    // Clear any caches
    verificationCodeCache = null;
    verificationCodeCacheTime = 0;

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

  if (step1) step1.classList.toggle('active', currentDisplayedStep >= 1);
  if (step2) step2.classList.toggle('active', currentDisplayedStep >= 2);
  if (step3) step3.classList.toggle('active', currentDisplayedStep >= 3);
}

/**
 * Display verification code result
 */
function displayVerificationCode(response) {
  const codeDisplay = document.getElementById('verificationCodeDisplay');
  const commandDisplay = document.getElementById('linkCommandDisplay');
  const codeDisplayDiv = document.getElementById('codeDisplay');
  const spinner = document.getElementById('verificationSpinner');
  const statusText = document.getElementById('verificationStatus');

  if (!codeDisplay || !commandDisplay || !codeDisplayDiv || !spinner || !statusText) {
    console.error('Required DOM elements not found for verification code display');
    return;
  }

  if (response.success && response.verificationCode) {
    // Hide spinner and show code
    spinner.style.display = 'none';
    statusText.style.display = 'none';
    codeDisplayDiv.style.display = 'block';

    codeDisplay.textContent = response.verificationCode;
    commandDisplay.textContent = `/link ${response.verificationCode}`;

    console.log('Verification code displayed:', response.verificationCode);
  } else {
    // No verification code found
    spinner.style.display = 'none';
    statusText.textContent = 'No active verification code found. Please link your account first.';
    codeDisplayDiv.style.display = 'none';
    console.log('No verification code found');
  }
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

    // Fetch verification code from backend (bypass cache)
    const response = await apiService.request('/auth/verification-code', {
      method: 'GET',
      noCache: true, // Always get fresh verification code
      timeout: 5000
    });

    displayVerificationCode(response);
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
 * Start checking for verification completion (legacy function - now using startVerificationPolling)
 */
function startVerificationCheck() {
  // This function is now replaced by startVerificationPolling
  // Keeping for backward compatibility
  startVerificationPolling();
}

/**
 * Start server polling for verification status with exponential backoff
 */
function startVerificationPolling() {
  // Clear any existing interval
  if (verificationCheckInterval) {
    clearInterval(verificationCheckInterval);
  }

  // Reset tracking variables
  verificationCheckAttempts = 0;
  verificationCheckDelay = 3000;

  // Check immediately
  checkVerificationStatusWithBackoff();
}

/**
 * Check verification with exponential backoff
 */
async function checkVerificationStatusWithBackoff() {
  const isVerified = await checkVerificationStatusOnce();
  
  if (isVerified) {
    return; // Verification complete, stop checking
  }

  verificationCheckAttempts++;
  
  // Exponential backoff: 3s, 3s, 5s, 5s, 10s, 10s, 15s (max)
  if (verificationCheckAttempts > 2 && verificationCheckAttempts <= 4) {
    verificationCheckDelay = 5000; // 5 seconds after 2 attempts
  } else if (verificationCheckAttempts > 4 && verificationCheckAttempts <= 6) {
    verificationCheckDelay = 10000; // 10 seconds after 4 attempts
  } else if (verificationCheckAttempts > 6) {
    verificationCheckDelay = 15000; // 15 seconds max
  }

  // Schedule next check
  verificationCheckInterval = setTimeout(checkVerificationStatusWithBackoff, verificationCheckDelay);
}

/**
 * Stop verification checking
 */
function stopVerificationCheck() {
  if (verificationCheckInterval) {
    clearTimeout(verificationCheckInterval); // Handle both setTimeout and clearInterval
    clearInterval(verificationCheckInterval);
    verificationCheckInterval = null;
  }
  verificationCheckAttempts = 0;
  verificationCheckDelay = 3000;
}

/**
 * Check if verification is complete (legacy function - now using checkVerificationStatusOnce)
 */
async function checkVerificationStatus() {
  // This function is now replaced by checkVerificationStatusOnce
  // Keeping for backward compatibility
  return await checkVerificationStatusOnce();
}

/**
 * Handle link account
 */
// Make function globally available
window.handleLinkAccount = async function(event) {
  event.preventDefault();

  const username = document.getElementById('minecraftUsername').value.trim();
  const region = document.getElementById('region').value;
  const linkBtn = document.getElementById('linkAccountBtn');

  if (!username) {
    Swal.fire({
      icon: 'warning',
      title: 'Username Required',
      text: 'Please enter your Minecraft username.'
    });
    return;
  }

  // Only block dangerous special characters for security, allow everything else (Mojang API will validate)
  const dangerousChars = /[<>'"`;\\\/\[\]{}()=+*&^%$#@!|~`]/;
  if (dangerousChars.test(username)) {
    Swal.fire({
      icon: 'warning',
      title: 'Invalid Characters',
      text: 'Username contains potentially dangerous characters. Please remove special characters.'
    });
    return;
  }

  if (!region) {
    Swal.fire({
      icon: 'warning',
      title: 'Region Required',
      text: 'Please select your gaming region.'
    });
    return;
  }

  linkBtn.disabled = true;
  linkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying username...';

  try {
    // First, verify the username with Mojang API
    const verificationResult = await apiService.verifyMinecraftUsername(username);
    
    if (!verificationResult.valid) {
      Swal.fire({
        icon: 'error',
        title: 'Invalid Minecraft Username',
        text: verificationResult.message || 'This Minecraft username does not exist. Please check your spelling and try again.'
      });
      linkBtn.disabled = false;
      linkBtn.innerHTML = '<i class="fas fa-link"></i> Link Account';
      return;
    }

    // Use the correctly cased username from Mojang
    const correctUsername = verificationResult.username || username;
    
    // Update the input field with the correct casing
    document.getElementById('minecraftUsername').value = correctUsername;

    linkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Linking account...';

    const profile = AppState.getProfile();

    // Always attempt to link the account - the API will handle duplicates/re-linking
    // The cleanup function ensures we start with a clean state

    // Account not linked yet, proceed with linking
    const data = await apiService.linkMinecraftUsername(correctUsername, region);

    // Clear cache to ensure fresh data
    apiService.clearCache('/users/me');
    
    // Update local profile with fresh data
    const updatedProfile = await apiService.getProfileQuick(); // Use quick method to bypass cache
    AppState.setProfile(updatedProfile);

    // Move to step 2 (verification) - validation happens inside showStep2()
    // No popup needed - the verification code will be displayed directly on the page
    currentDisplayedStep = 2;
    await showStep2();
  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Link Account',
      text: error.message
    });
  } finally {
    linkBtn.disabled = false;
    linkBtn.innerHTML = '<i class="fas fa-link"></i> Link Account';
  }
}

/**
 * Go back to step 1 from step 2
 */
window.goBackToStep1 = async function() {
  try {
    // Confirm action
    const result = await Swal.fire({
      icon: 'question',
      title: 'Go Back to Step 1?',
      text: 'This will clear your current linking progress. You can re-enter your username and region.',
      showCancelButton: true,
      confirmButtonText: 'Yes, go back',
      cancelButtonText: 'Cancel'
    });

    if (!result.isConfirmed) {
      return;
    }

    // Stop verification polling
    stopVerificationCheck();

    // Clean up Minecraft data
    await cleanUpMinecraftData();

    // Go back to step 1
    currentDisplayedStep = 1;
    showStep1();

    Swal.fire({
      icon: 'info',
      title: 'Returned to Step 1',
      text: 'You can now re-enter your Minecraft username and region.',
      timer: 2000,
      showConfirmButton: false
    });
  } catch (error) {
    console.error('Error going back to step 1:', error);
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: 'Failed to go back to step 1. Please try again.'
    });
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
    gamemodeCard.onclick = () => toggleGamemodeSelection(gamemode.id);

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
  const skillLevel = parseInt(optionElement.dataset.elo);

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

  const allSelected = selectedGamemodes.every(gamemodeId => gamemodeSkillLevels[gamemodeId] !== undefined);
  saveBtn.disabled = !allSelected;
}

/**
 * Toggle gamemode selection
 */
function toggleGamemodeSelection(gamemodeId) {
  const card = document.querySelector(`[data-gamemode="${gamemodeId}"]`);
  const isSelected = card.classList.contains('selected');

  if (isSelected) {
    card.classList.remove('selected');
    selectedGamemodes = selectedGamemodes.filter(id => id !== gamemodeId);
  } else {
    card.classList.add('selected');
    selectedGamemodes.push(gamemodeId);
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

  document.getElementById('gamemodeSelection').style.display = 'none';
  document.getElementById('skillLevelSection').style.display = 'block';

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
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Setting up...';

    // Save gamemode preferences and individual skill levels
    await apiService.saveOnboardingPreferences(selectedGamemodes, gamemodeSkillLevels);

    // Double-check that onboarding isn't already completed
    const currentProfile = await apiService.getProfile();
    if (currentProfile.onboardingCompleted === true) {
      // Already completed, just redirect
      setTimeout(async () => {
        const canRedirect = await checkBanBeforeRedirect();
        if (canRedirect) {
          window.location.href = 'dashboard.html';
        }
      }, 1000);
      return;
    }

    const refreshedUser = await firebaseAuthService.reloadCurrentUser().catch(() => AppState.currentUser);
    const isEmailVerified = refreshedUser?.emailVerified === true || currentProfile.emailVerified === true;
    if (!isEmailVerified) {
      const result = await Swal.fire({
        icon: 'warning',
        title: 'Verify Your Email First',
        text: 'You need a verified email address before onboarding can be completed.',
        showCancelButton: true,
        confirmButtonText: 'Send Verification Email',
        cancelButtonText: 'Not Yet'
      });

      if (result.isConfirmed) {
        await firebaseAuthService.sendEmailVerification({ mode: 'account' });
        Swal.fire({
          icon: 'success',
          title: 'Verification Sent',
          text: 'Check your inbox, then come back and press complete setup again.'
        });
      }

      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Preferences & Complete Setup';
      return;
    }

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
      // Clear API cache to ensure fresh data on dashboard
      apiService.clearCache();
      
      const canRedirect = await checkBanBeforeRedirect();
      if (canRedirect) {
        window.location.href = 'dashboard.html';
      }
    }, 3000);

  } catch (error) {
    Swal.fire({
      icon: 'error',
      title: 'Failed to Complete Setup',
      text: error.message
    });

    const saveBtn = document.getElementById('savePreferencesBtn');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Preferences & Complete Setup';
    }
  }
}

/**
 * Handle back to gamemode selection
 */
function handleBackToGamemodeSelection() {
  document.getElementById('skillLevelSection').style.display = 'none';
  document.getElementById('gamemodeSelection').style.display = 'block';
  selectedSkillLevel = null;

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

window.addEventListener('beforeunload', () => {
  if (onboardingRealtimeConnection && typeof onboardingRealtimeConnection.close === 'function') {
    onboardingRealtimeConnection.close();
    onboardingRealtimeConnection = null;
  }
});
