// MC Leaderboards - Health Check Script
// Checks if all services are running correctly

const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('./config');
const logger = require('./logger');

const { serviceAccount, config } = loadRuntimeConfig();

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.databaseURL
  });
} catch (error) {
  logger.error('Failed to initialize Firebase Admin for health check', { error });
  process.exit(1);
}

const db = admin.database();

/**
 * Check database connection
 */
async function checkDatabase() {
  try {
    const testRef = db.ref('health-check');
    await testRef.set({ timestamp: new Date().toISOString() });
    await testRef.remove();
    return { status: 'ok', message: 'Database connection successful' };
  } catch (error) {
    return { status: 'error', message: `Database error: ${error.message}` };
  }
}

/**
 * Check authentication
 */
async function checkAuth() {
  try {
    await admin.auth().listUsers(1);
    return { status: 'ok', message: 'Authentication service working' };
  } catch (error) {
    return { status: 'error', message: `Auth error: ${error.message}` };
  }
}

/**
 * Run all health checks
 */
async function runHealthChecks() {
  logger.info('Running backend health checks');
  
  const results = {
    database: await checkDatabase(),
    auth: await checkAuth()
  };
  
  let allOk = true;
  
  for (const [service, result] of Object.entries(results)) {
    logger.info('Health check result', { service, status: result.status, detail: result.message });
    if (result.status !== 'ok') allOk = false;
  }

  if (allOk) {
    logger.info('All health checks passed');
    process.exit(0);
  } else {
    logger.error('One or more health checks failed');
    process.exit(1);
  }
}

// Run checks
runHealthChecks();

