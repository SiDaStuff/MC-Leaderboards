// MC Leaderboards - Dev Mode Toggle
// Key sequence: Right Shift + "butter" + Enter

(function() {
  let keySequence = [];
  let rightShiftPressed = false;
  const targetSequence = ['b', 'u', 't', 't', 'e', 'r'];
  let sequenceTimeout = null;

  // Check if dev mode is enabled
  function isDevMode() {
    return localStorage.getItem('mclb_dev_mode') === 'true';
  }

  // Set dev mode
  function setDevMode(enabled) {
    localStorage.setItem('mclb_dev_mode', enabled ? 'true' : 'false');
    console.log(`[Dev Mode] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  // Get API URL based on mode
  function getApiUrl() {
    if (isDevMode()) {
      return 'http://localhost:3000/api';
    }
    return 'https://mcleaderboards.com/api';
  }

  // Show dev mode toggle modal
  function showDevModeModal() {
    // Remove existing modal if any
    const existingModal = document.getElementById('devModeModal');
    if (existingModal) {
      existingModal.remove();
    }

    const currentMode = isDevMode();
    
    const modal = document.createElement('div');
    modal.id = 'devModeModal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      animation: fadeIn 0.2s ease-out;
    `;

    modal.innerHTML = `
      <style>
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      </style>
      <div style="
        background: var(--secondary-bg, #1e2328);
        border: 2px solid var(--border-color, #3a4149);
        border-radius: 12px;
        padding: 2rem;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        animation: slideIn 0.3s ease-out;
      ">
        <h2 style="
          margin: 0 0 1rem 0;
          color: var(--text-color, #ffffff);
          display: flex;
          align-items: center;
          gap: 0.5rem;
        ">
          <i class="fas fa-code"></i>
          Developer Mode
        </h2>
        
        <p style="
          color: var(--text-muted, #aab0b7);
          margin-bottom: 1.5rem;
          font-size: 0.9rem;
        ">
          Toggle between production and development API endpoints
        </p>

        <div style="
          background: var(--tertiary-bg, #2a3038);
          border-radius: 8px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        ">
          <div style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1rem;
          ">
            <div>
              <div style="
                font-weight: 600;
                color: var(--text-color, #ffffff);
                margin-bottom: 0.25rem;
              ">
                Current Mode
              </div>
              <div style="
                font-size: 0.85rem;
                color: var(--text-muted, #aab0b7);
              ">
                ${currentMode ? 'Development (localhost:3000)' : 'Production (mcleaderboards.com)'}
              </div>
            </div>
            <div style="
              padding: 0.5rem 1rem;
              background: ${currentMode ? 'rgba(255, 152, 0, 0.2)' : 'rgba(52, 211, 153, 0.2)'};
              border: 1px solid ${currentMode ? 'rgba(255, 152, 0, 0.4)' : 'rgba(52, 211, 153, 0.4)'};
              border-radius: 6px;
              color: ${currentMode ? '#ff9800' : '#34d399'};
              font-weight: 600;
              font-size: 0.85rem;
            ">
              ${currentMode ? 'DEV' : 'PROD'}
            </div>
          </div>

          <div style="
            display: flex;
            gap: 0.5rem;
          ">
            <button id="devModeBtn" style="
              flex: 1;
              padding: 0.75rem;
              background: ${currentMode ? 'var(--tertiary-bg, #2a3038)' : 'linear-gradient(135deg, #ff9800, #f57c00)'};
              border: 2px solid ${currentMode ? 'var(--border-color, #3a4149)' : '#ff9800'};
              color: ${currentMode ? 'var(--text-color, #ffffff)' : '#ffffff'};
              border-radius: 6px;
              cursor: pointer;
              font-weight: 600;
              transition: all 0.2s;
            " onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
              <i class="fas fa-laptop-code"></i> Development
            </button>
            <button id="prodModeBtn" style="
              flex: 1;
              padding: 0.75rem;
              background: ${!currentMode ? 'var(--tertiary-bg, #2a3038)' : 'linear-gradient(135deg, #34d399, #10b981)'};
              border: 2px solid ${!currentMode ? 'var(--border-color, #3a4149)' : '#34d399'};
              color: ${!currentMode ? 'var(--text-color, #ffffff)' : '#ffffff'};
              border-radius: 6px;
              cursor: pointer;
              font-weight: 600;
              transition: all 0.2s;
            " onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
              <i class="fas fa-globe"></i> Production
            </button>
          </div>
        </div>

        <div style="
          background: rgba(52, 152, 219, 0.1);
          border: 1px solid rgba(52, 152, 219, 0.3);
          border-radius: 6px;
          padding: 1rem;
          margin-bottom: 1.5rem;
        ">
          <div style="
            display: flex;
            align-items: start;
            gap: 0.5rem;
          ">
            <i class="fas fa-info-circle" style="color: #3498db; margin-top: 2px;"></i>
            <div style="
              font-size: 0.85rem;
              color: var(--text-muted, #aab0b7);
              line-height: 1.5;
            ">
              <strong style="color: var(--text-color, #ffffff);">Note:</strong> 
              Changing modes will reload the page to apply changes. Make sure your local development server is running on port 3000.
            </div>
          </div>
        </div>

        <div style="
          display: flex;
          gap: 0.5rem;
        ">
          <button id="closeDevModal" style="
            flex: 1;
            padding: 0.75rem;
            background: var(--tertiary-bg, #2a3038);
            border: 2px solid var(--border-color, #3a4149);
            color: var(--text-color, #ffffff);
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.2s;
          " onmouseover="this.style.borderColor='var(--accent-color, #3498db)'" onmouseout="this.style.borderColor='var(--border-color, #3a4149)'">
            <i class="fas fa-times"></i> Close
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Add event listeners
    document.getElementById('devModeBtn').addEventListener('click', () => {
      setDevMode(true);
      setTimeout(() => window.location.reload(), 500);
    });

    document.getElementById('prodModeBtn').addEventListener('click', () => {
      setDevMode(false);
      setTimeout(() => window.location.reload(), 500);
    });

    document.getElementById('closeDevModal').addEventListener('click', () => {
      modal.remove();
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

    // Close on Escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
  }

  // Listen for key sequence
  document.addEventListener('keydown', (e) => {
    // Check for Right Shift
    if (e.key === 'Shift' && e.location === 2) { // location 2 = right
      rightShiftPressed = true;
      keySequence = [];
      
      // Reset after 5 seconds
      clearTimeout(sequenceTimeout);
      sequenceTimeout = setTimeout(() => {
        rightShiftPressed = false;
        keySequence = [];
      }, 5000);
      return;
    }

    // If right shift was pressed, start collecting sequence
    if (rightShiftPressed) {
      if (e.key === 'Enter') {
        // Check if sequence matches
        if (keySequence.join('') === targetSequence.join('')) {
          e.preventDefault();
          showDevModeModal();
          rightShiftPressed = false;
          keySequence = [];
          clearTimeout(sequenceTimeout);
        }
      } else if (e.key.length === 1 && e.key.match(/[a-z]/i)) {
        // Add letter to sequence
        keySequence.push(e.key.toLowerCase());
        
        // Check if sequence is still valid
        const currentSequence = keySequence.join('');
        const targetStart = targetSequence.slice(0, keySequence.length).join('');
        
        if (currentSequence !== targetStart) {
          // Invalid sequence, reset
          rightShiftPressed = false;
          keySequence = [];
          clearTimeout(sequenceTimeout);
        }
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && e.location === 2) {
      // Don't reset immediately on shift release, wait for sequence completion
    }
  });

  // Log current mode on page load
  console.log(`[Dev Mode] Current mode: ${isDevMode() ? 'Development' : 'Production'}`);
  console.log(`[Dev Mode] API URL: ${getApiUrl()}`);
  console.log(`[Dev Mode] Trigger: Right Shift + "butter" + Enter`);

  // Export functions for use in other scripts
  window.mclbDevMode = {
    isEnabled: isDevMode,
    getApiUrl: getApiUrl,
    toggle: showDevModeModal
  };
})();
