// MC Leaderboards - Handle Match Inactivity Script
// Automatically finalizes matches where players/testers don't join within timeout

const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('../config');

const { serviceAccount, config } = loadRuntimeConfig();

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: config.databaseURL
});

const db = admin.database();

// Glicko-2 constants (copied from server.js)
const GLICKO2_SCALE = 173.7178;
const GLICKO2_CONVERGENCE_TOLERANCE = 0.000001;
const GLICKO2_DEFAULT_RD = 350;
const GLICKO2_MIN_RD = 100; // Minimum RD to prevent rating stagnation
const GLICKO2_DEFAULT_VOLATILITY = 0.06;
const GLICKO2_TAU = 0.5; // System constant for volatility

// Convert rating from Glicko-2 scale to display scale (1500 Glicko-2 = 1000 display)
function glicko2ToDisplay(rating) {
  return rating * GLICKO2_SCALE + 1000;
}

// Convert rating from display scale to Glicko-2 scale (1000 display = 0 Glicko-2)
function displayToGlicko2(rating) {
  return (rating - 1000) / GLICKO2_SCALE;
}

// Calculate rating changes using a hybrid Elo/Glicko-2 system
function calculateGlicko2Change(player, opponent, score) {
  const rating1 = player.rating;
  const rating2 = opponent.rating;
  const rd1 = Math.max(player.rd || GLICKO2_DEFAULT_RD, 50); // Minimum RD of 50
  const rd2 = Math.max(opponent.rd || GLICKO2_DEFAULT_RD, 50); // Minimum RD of 50

  // Calculate expected score using standard Elo formula
  const expectedScore1 = 1 / (1 + Math.pow(10, (rating2 - rating1) / 400));
  const expectedScore2 = 1 - expectedScore1;

  // Use RD to modify K-factor: lower RD = more stable rating = lower K-factor
  const kFactor1 = Math.max(8, 32 * (rd1 / GLICKO2_DEFAULT_RD)); // K-factor between 8-32
  const kFactor2 = Math.max(8, 32 * (rd2 / GLICKO2_DEFAULT_RD)); // K-factor between 8-32

  // Calculate rating changes
  const actualScore1 = score; // 1 for win, 0 for loss, 0.5 for draw
  const actualScore2 = 1 - score;

  const ratingChange1 = Math.round(kFactor1 * (actualScore1 - expectedScore1));
  const ratingChange2 = Math.round(kFactor2 * (actualScore2 - expectedScore2));

  // Update RD: increases after each match (becomes more uncertain)
  const newRD1 = Math.min(GLICKO2_DEFAULT_RD, rd1 + 50); // RD increases by 50, max at default
  const newRD2 = Math.min(GLICKO2_DEFAULT_RD, rd2 + 50); // RD increases by 50, max at default

  // Simple volatility calculation
  const newVolatility1 = player.volatility || GLICKO2_DEFAULT_VOLATILITY;
  const newVolatility2 = opponent.volatility || GLICKO2_DEFAULT_VOLATILITY;

  return {
    ratingChange: ratingChange1,
    newRating: rating1 + ratingChange1,
    newRD: newRD1,
    newVolatility: newVolatility1
  };
}

// Centralized rating update function
async function updatePlayerRating(userId, gamemode, ratingChange, newRating, newRD, newVolatility) {
  try {
    // Update player record
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    const players = playerSnapshot.val() || {};
    const playerId = Object.keys(players).find(key => players[key].userId === userId);

    if (playerId) {
      const playerRef = playersRef.child(playerId);
      const player = players[playerId];

      // Update gamemode rating
      const gamemodeRatings = player.gamemodeRatings || {};
      gamemodeRatings[gamemode] = newRating;

      // Update peak ratings
      const peakRatings = player.peakRatings || {};
      if (!peakRatings[gamemode] || newRating > peakRatings[gamemode]) {
        peakRatings[gamemode] = newRating;
      }

      // Update Glicko-2 parameters
      const glicko2Params = player.glicko2Params || {};
      glicko2Params[gamemode] = {
        rd: newRD,
        volatility: newVolatility
      };

      // Recalculate overall rating
      const overallRating = calculateOverallRating(gamemodeRatings);

      // Increment match count
      const gamemodeMatchCount = player.gamemodeMatchCount || {};
      gamemodeMatchCount[gamemode] = (gamemodeMatchCount[gamemode] || 0) + 1;

      await playerRef.update({
        gamemodeRatings,
        peakRatings,
        glicko2Params,
        overallRating,
        gamemodeMatchCount,
        [`lastTested/${gamemode}`]: new Date().toISOString()
      });
    }

    // Ratings are now stored only in player records, not user profiles

  } catch (error) {
    console.error('Error updating player rating:', error);
    throw error;
  }
}

// Calculate overall rating from gamemode ratings
function calculateOverallRating(gamemodeRatings) {
  const ratings = Object.values(gamemodeRatings || {});
  if (ratings.length === 0) return 1000;

  const sum = ratings.reduce((acc, rating) => acc + rating, 0);
  return Math.round(sum / ratings.length);
}

// Handle manual finalization for inactivity
async function handleManualFinalization(match, result) {
  const playerScore = result.playerScore;
  const testerScore = result.testerScore;
  const playerWon = playerScore > testerScore;

  // Convert scores to Glicko-2 compatible scores (0, 0.5, or 1)
  let playerGlicko2Score;
  if (playerScore > testerScore) {
    playerGlicko2Score = 1; // Win
  } else if (playerScore < testerScore) {
    playerGlicko2Score = 0; // Loss
  } else {
    playerGlicko2Score = 0.5; // Draw
  }

  // Get current player data
  const playersRef = db.ref('players');
  const playerSnapshot = await playersRef.orderByChild('userId').equalTo(match.playerId).once('value');
  const testerSnapshot = await playersRef.orderByChild('userId').equalTo(match.testerId).once('value');

  const players = playerSnapshot.val() || {};
  const testers = testerSnapshot.val() || {};

  const playerData = Object.values(players).find(p => p.userId === match.playerId) || {
    gamemodeRatings: {},
    glicko2Params: {}
  };
  const testerData = Object.values(testers).find(p => p.userId === match.testerId) || {
    gamemodeRatings: {},
    glicko2Params: {}
  };

  // Get current ratings and Glicko-2 data
  const playerRating = playerData.gamemodeRatings?.[match.gamemode] || 1000;
  const testerRating = testerData.gamemodeRatings?.[match.gamemode] || 1000;

  const playerRD = playerData.glicko2Params?.[match.gamemode]?.rd || GLICKO2_DEFAULT_RD;
  const testerRD = testerData.glicko2Params?.[match.gamemode]?.rd || GLICKO2_DEFAULT_RD;

  const playerVolatility = playerData.glicko2Params?.[match.gamemode]?.volatility || GLICKO2_DEFAULT_VOLATILITY;
  const testerVolatility = testerData.glicko2Params?.[match.gamemode]?.volatility || GLICKO2_DEFAULT_VOLATILITY;

  // Create player and opponent objects for Glicko-2 calculation
  const playerObj = { rating: playerRating, rd: playerRD, volatility: playerVolatility };
  const testerObj = { rating: testerRating, rd: testerRD, volatility: testerVolatility };

  // Calculate Glicko-2 rating changes
  const playerResult = calculateGlicko2Change(playerObj, testerObj, playerGlicko2Score);
  const testerResult = calculateGlicko2Change(testerObj, playerObj, 1 - playerGlicko2Score);

  // Update ratings using centralized function
  await updatePlayerRating(match.playerId, match.gamemode, playerResult.ratingChange, playerResult.newRating, playerResult.newRD, playerResult.newVolatility);
  await updatePlayerRating(match.testerId, match.gamemode, testerResult.ratingChange, testerResult.newRating, testerResult.newRD, testerResult.newVolatility);

  return {
    playerRatingChange: playerResult.ratingChange,
    testerRatingChange: testerResult.ratingChange,
    playerNewRating: playerResult.newRating,
    testerNewRating: testerResult.newRating
  };
}

/**
 * Handle inactivity timeouts for active matches
 */
async function handleInactivityTimeouts() {
  console.log('Checking for inactive matches...');

  try {
    const matchesRef = db.ref('matches');
    const snapshot = await matchesRef.once('value');
    const matches = snapshot.val() || {};

    const now = Date.now();
    const timeoutMs = 3 * 60 * 1000; // 3 minutes
    let handled = 0;

    for (const matchId in matches) {
      const match = matches[matchId];

      if (match.status === 'active' && !match.finalized) {
        const createdAt = new Date(match.createdAt).getTime();
        const timeSinceCreation = now - createdAt;

        if (timeSinceCreation > timeoutMs) {
          console.log(`  Processing inactive match: ${matchId}`);

          const matchRef = matchesRef.child(matchId);

          const testerJoined = match.pagestats?.testerJoined || false;

          if (!testerJoined) {
            // Tester did not join within 3 minutes, player wins 3-0
            console.log(`    Tester did not join within 3 minutes, player wins 3-0`);
            await handleManualFinalization(match, { playerScore: 3, testerScore: 0 });
            await matchRef.update({
              status: 'ended',
              finalized: true,
              finalizedAt: new Date().toISOString(),
              result: { playerScore: 3, testerScore: 0 },
              reason: 'Tester did not join within 3 minutes'
            });
          } else {
            // This shouldn't happen since we're checking for inactive matches, but just in case
            console.log(`    Both players have joined, no action needed`);
          }

          handled++;
        }
      }
    }

    console.log(`\n✓ Inactivity check completed! Handled ${handled} inactive matches.`);
    process.exit(0);
  } catch (error) {
    console.error('Error handling inactivity timeouts:', error);
    process.exit(1);
  }
}

// Run inactivity check
handleInactivityTimeouts();
