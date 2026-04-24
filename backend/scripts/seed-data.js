// MC Leaderboards - Seed Data Script
// Run this script to populate the database with example data for testing

const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('../config');

const { serviceAccount, config } = loadRuntimeConfig();

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: config.databaseURL
});

const db = admin.database();

/**
 * Seed example players
 */
async function seedPlayers() {
  console.log('Seeding players...');
  
  const players = [
    {
      username: 'ProPlayer1',
      gamemodeRatings: {
        pot: 1800,
        vanilla: 1400,
        uhc: 1600
      },
      overallRating: 1600,
      lastTested: {
        pot: new Date().toISOString(),
        vanilla: new Date().toISOString(),
        uhc: new Date().toISOString()
      }
    },
    {
      username: 'SkilledGamer',
      gamemodeRatings: {
        pot: 1400,
        sword: 1300
      },
      totalPoints: 55,
      lastTested: {
        pot: new Date().toISOString(),
        sword: new Date().toISOString()
      }
    },
    {
      username: 'RookiePlayer',
      gamemodeRatings: {
        pot: 400
      },
      overallRating: 400,
      lastTested: {
        pot: new Date().toISOString()
      }
    }
  ];
  
  const playersRef = db.ref('players');
  for (const player of players) {
    const newPlayerRef = playersRef.push();
    await newPlayerRef.set(player);
    console.log(`  ✓ Created player: ${player.username}`);
  }
}

/**
 * Seed example blacklist entries
 */
async function seedBlacklist() {
  console.log('Seeding blacklist...');
  
  const blacklist = [
    {
      username: 'Cheater123',
      reason: 'Using hacks',
      addedAt: new Date().toISOString(),
      addedBy: 'admin'
    }
  ];
  
  const blacklistRef = db.ref('blacklist');
  for (const entry of blacklist) {
    const newEntryRef = blacklistRef.push();
    await newEntryRef.set(entry);
    console.log(`  ✓ Added to blacklist: ${entry.username}`);
  }
}

/**
 * Main seed function
 */
async function seed() {
  try {
    console.log('Starting seed process...\n');
    
    await seedPlayers();
    console.log('');
    await seedBlacklist();
    
    console.log('\n✓ Seed process completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding data:', error);
    process.exit(1);
  }
}

// Run seed
seed();

