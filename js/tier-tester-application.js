// MC Leaderboards - Tier Tester Application Page

async function initTierTesterApplication() {
  try {
    // If applications are closed, show message and block submission UI
    try {
      const openResp = await apiService.getTierTesterApplicationsOpen();
      if (openResp && openResp.open === false) {
        const stateEl = document.getElementById('tierTesterApplicationState');
        const formEl = document.getElementById('tierTesterApplicationForm');
        if (stateEl) {
          stateEl.innerHTML = `
            <div class="alert alert-warning">
              <i class="fas fa-lock"></i>
              Tier Tester applications are currently <strong>closed</strong>.
            </div>
          `;
        }
        if (formEl) formEl.style.display = 'none';
        return;
      }
    } catch (_) {
      // ignore; backend will still block on submit if closed
    }

    // Load profile (auth-guard already ensures we have a token)
    const profile = await apiService.getProfile();
    AppState.setProfile(profile);

    const stateEl = document.getElementById('tierTesterApplicationState');
    const formEl = document.getElementById('tierTesterApplicationForm');
    const submitBtn = document.getElementById('submitTierTesterBtn');

    // If already a tester
    if (profile?.tester) {
      if (stateEl) {
        stateEl.innerHTML = `
          <div class="alert alert-info">
            <i class="fas fa-info-circle"></i>
            You already have the <strong>Tier Tester</strong> role.
          </div>
        `;
      }
      if (formEl) formEl.style.display = 'none';
      return;
    }

    // Blacklisted users cannot submit applications
    if (profile?.blacklisted === true) {
      if (stateEl) {
        stateEl.innerHTML = `
          <div class="alert alert-danger">
            <i class="fas fa-ban"></i>
            Your account is <strong>blacklisted</strong> and cannot submit applications.
          </div>
        `;
      }
      if (formEl) formEl.style.display = 'none';
      return;
    }

    // If application is pending
    if (profile?.pendingTesterApplication) {
      if (stateEl) {
        stateEl.innerHTML = `
          <div class="alert alert-warning">
            <i class="fas fa-clock"></i>
            Your Tier Tester application is <strong>pending review</strong>. You’ll be notified when it’s reviewed.
          </div>
        `;
      }
      if (submitBtn) submitBtn.disabled = true;
      return;
    }

    // Prefill name
    const nameEl = document.getElementById('applicantName');
    if (nameEl && (profile?.displayName || profile?.email)) {
      nameEl.value = (profile.displayName || profile.email || '').toString();
    }

    if (stateEl) {
      stateEl.innerHTML = `
        <div class="alert alert-info">
          <i class="fas fa-shield-alt"></i>
          Tier Testers help test new features, verify match quality, and provide constructive feedback.
        </div>
      `;
    }

    if (formEl) {
      formEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitTierTesterApplicationPage();
      });
    }
  } catch (error) {
    console.error('Error initializing tier tester application:', error);
    const stateEl = document.getElementById('tierTesterApplicationState');
    if (stateEl) {
      stateEl.innerHTML = `
        <div class="alert alert-danger">
          <i class="fas fa-exclamation-triangle"></i>
          Error loading your profile. Please refresh and try again.
        </div>
      `;
    }
  }
}

async function submitTierTesterApplicationPage() {
  const formEl = document.getElementById('tierTesterApplicationForm');
  const submitBtn = document.getElementById('submitTierTesterBtn');

  if (!formEl) return;
  if (!formEl.checkValidity()) {
    formEl.reportValidity();
    return;
  }


  const applicationData = {
    name: document.getElementById('applicantName').value.trim(),
    age: parseInt(document.getElementById('applicantAge').value, 10),
    minecraftExperience: document.getElementById('minecraftExperience').value,
    favoriteGamemode: document.getElementById('favoriteGamemode').value,
    availability: document.getElementById('availability').value,
    previousTesting: document.getElementById('previousTesting').value.trim(),
    whyTester: document.getElementById('whyTester').value.trim(),
    improvementIdeas: document.getElementById('improvementIdeas').value.trim()
  };

  if (!applicationData.name || !applicationData.age || applicationData.age < 13) {
    Swal.fire('Age Restriction', 'You must be at least 13 years old to apply.', 'warning');
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    }

    const resp = await apiService.submitTierTesterApplication(applicationData);
    
    if (!resp?.success) throw new Error(resp?.message || 'Failed to submit application');

    Swal.fire({
      icon: 'success',
      title: 'Application Submitted!',
      text: 'Your Tier Tester application has been submitted. You will be notified when it is reviewed.',
      confirmButtonText: 'Back to Dashboard'
    }).then(() => {
      window.location.href = 'dashboard.html';
    });
  } catch (error) {
    console.error('Error submitting tier tester application:', error);
    if (error?.data?.code === 'APPLICATIONS_CLOSED' || error?.code === 'APPLICATIONS_CLOSED' || (error?.message || '').includes('APPLICATIONS_CLOSED')) {
      Swal.fire('Applications Closed', 'Tier Tester applications are currently closed.', 'warning');
      return;
    }
    Swal.fire('Error', error.message || 'Failed to submit application. Please try again.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Application';
    }
  }
}

// Expose init for the HTML bootstrapper
window.initTierTesterApplication = initTierTesterApplication;


