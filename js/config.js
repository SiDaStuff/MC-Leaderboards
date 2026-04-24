// MC Leaderboards - Configuration

const CONFIG = {
  // API Configuration
  // In production, Nginx serves frontend and proxies /api to backend
  // Dev mode can be toggled with Right Shift + "butter" + Enter
  API_BASE_URL: (() => {
    // Check if dev mode is enabled via dev-mode-toggle.js
    const devModeEnabled = localStorage.getItem('mclb_dev_mode') === 'true';
    
    if (devModeEnabled) {
      return 'http://localhost:3000/api';
    }

    // Support opening pages directly from the filesystem during local testing.
    if (window.location.protocol === 'file:') {
      return 'http://localhost:3000/api';
    }
    
    // Auto-detect localhost for backwards compatibility
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://localhost:3000/api';
    }
    
    // Production URL
    return window.location.protocol + '//' + window.location.host + '/api';
  })(),

  // reCAPTCHA v3 site key (public/domain-locked — not a backend secret)
  RECAPTCHA_SITE_KEY: '6LdaSL4sAAAAAKK56-vEq5tTWqpHcoTVBlPMA69p',

  // Firebase Configuration
  FIREBASE_CONFIG: {
    apiKey: "AIzaSyDFvvGCKyCt-3r9G7ETWfXkTh4wEak-fL0",
    authDomain: "mcleaderboards-sd.firebaseapp.com",
    databaseURL: "https://mcleaderboards-sd-default-rtdb.firebaseio.com",
    projectId: "mcleaderboards-sd",
    storageBucket: "mcleaderboards-sd.firebasestorage.app",
    messagingSenderId: "57290557650",
    appId: "1:57290557650:web:98fc4f03fe4187d402c50b"
  },

  // Feature Flags
  ENABLE_ANALYTICS: false,
  DEBUG_MODE: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',

  // Application Settings
  MATCHMAKING_INTERVAL: 10000, // 10 seconds
  PRESENCE_UPDATE_INTERVAL: 30000, // 30 seconds
  QUEUE_POLL_INTERVAL: 10000, // 10 seconds
  CHAT_COOLDOWN: 2000, // 2 seconds

  // Gamemodes
  GAMEMODES: [
    { id: 'overall', name: 'Overall', icon: 'assets/overall.svg' },
    { id: 'vanilla', name: 'Vanilla', icon: 'assets/vanilla.svg' },
    { id: 'uhc', name: 'UHC', icon: 'assets/uhc.svg' },
    { id: 'pot', name: 'Pot', icon: 'assets/pot.svg' },
    { id: 'nethop', name: 'NethOP', icon: 'assets/nethop.svg' },
    { id: 'smp', name: 'SMP', icon: 'assets/smp.svg' },
    { id: 'sword', name: 'Sword', icon: 'assets/sword.svg' },
    { id: 'axe', name: 'Axe', icon: 'assets/axe.svg' },
    { id: 'mace', name: 'Mace', icon: 'assets/mace.svg' }
  ],

  FIRST_TO: {
    sword: 6,
    axe: 10,
    nethop: 3,
    pot: 5,
    smp: 2,
    uhc: 4,
    vanilla: 3,
    mace: 3
  },

  // Elo Rating System - Combat Titles
  COMBAT_TITLES: [
    { minRating: 2500, title: 'Combat Grandmaster', icon: 'assets/badgeicons/combat_grandmaster.webp' },
    { minRating: 2000, title: 'Combat Master', icon: 'assets/badgeicons/combat_master.webp' },
    { minRating: 1500, title: 'Combat Ace', icon: 'assets/badgeicons/combat_ace.svg' },
    { minRating: 1000, title: 'Combat Specialist', icon: 'assets/badgeicons/combat_specialist.svg' },
    { minRating: 700, title: 'Combat Cadet', icon: 'assets/badgeicons/combat_cadet.svg' },
    { minRating: 500, title: 'Combat Novice', icon: 'assets/badgeicons/combat_novice.svg' },
    { minRating: 0, title: 'Rookie', icon: 'assets/badgeicons/rookie.svg' }
  ],

  // Promotion Paths
  PROMOTION_PATHS: {
    'LT3': { target: 'HT3', required: ['LT3', 'HT3'] },
    'HT3': { target: 'LT2', required: ['HT3', 'LT2'] },
    'LT2': { target: 'HT2', required: ['LT2', 'HT2'] },
    'HT2': { target: 'LT1', required: ['HT2', 'LT1'] },
    'LT1': { target: 'HT1', required: ['LT1', 'HT1'] }
  }
};

// Debug logging
if (CONFIG.DEBUG_MODE) {
  console.log('MC Leaderboards - Debug Mode Enabled');
  console.log('Config:', CONFIG);
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}

