const fs = require('fs');
const path = require('path');

const backendDir = __dirname;
let envLoaded = false;

function stripWrappingQuotes(value) {
  if (typeof value !== 'string' || value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvValue(rawValue) {
  const value = stripWrappingQuotes(rawValue.trim());
  return value.replace(/\\n/g, '\n');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1);
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    process.env[key] = parseEnvValue(rawValue);
  }
}

function loadDotEnv() {
  if (envLoaded) {
    return;
  }

  loadEnvFile(path.join(backendDir, '.env'));
  loadEnvFile(path.join(backendDir, '.env.local'));
  envLoaded = true;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveServiceAccountPath() {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(backendDir, configuredPath);
  }

  return path.join(backendDir, 'key.json');
}

function buildServiceAccountFromEnv() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    type: process.env.FIREBASE_TYPE || 'service_account',
    project_id: projectId,
    private_key: privateKey.replace(/\\n/g, '\n'),
    client_email: clientEmail,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
    token_uri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
  };
}

function deriveDatabaseUrl(serviceAccount) {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (serviceAccount?.databaseURL) {
    return serviceAccount.databaseURL;
  }

  if (serviceAccount?.project_id) {
    return `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;
  }

  return null;
}

function extractProjectIdFromDatabaseUrl(databaseURL) {
  if (!databaseURL || typeof databaseURL !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(databaseURL);
    const host = parsed.hostname.toLowerCase();
    const firstLabel = host.split('.')[0] || '';

    // Common forms:
    // - <project-id>-default-rtdb.firebaseio.com
    // - <project-id>-default-rtdb.<region>.firebasedatabase.app
    // - <project-id>.firebaseio.com
    if (firstLabel.endsWith('-default-rtdb')) {
      return firstLabel.slice(0, -'-default-rtdb'.length) || null;
    }

    return firstLabel || null;
  } catch (_) {
    return null;
  }
}

function loadRuntimeConfig() {
  loadDotEnv();

  const serviceAccountPath = resolveServiceAccountPath();
  const fileServiceAccount = readJsonIfExists(serviceAccountPath);
  const envServiceAccount = buildServiceAccountFromEnv();
  const serviceAccount = fileServiceAccount || envServiceAccount;

  if (!serviceAccount) {
    throw new Error(
      'Firebase credentials are not configured. Provide backend/key.json, set FIREBASE_SERVICE_ACCOUNT_PATH, or configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'
    );
  }

  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  const databaseURL = deriveDatabaseUrl(serviceAccount);
  if (!databaseURL) {
    throw new Error('Firebase database URL could not be determined. Set DATABASE_URL or add databaseURL to the service account config.');
  }

  const serviceProjectId = String(serviceAccount.project_id || '').trim();
  const databaseProjectId = extractProjectIdFromDatabaseUrl(databaseURL);
  if (serviceProjectId && databaseProjectId && serviceProjectId !== databaseProjectId) {
    throw new Error(
      `Firebase project mismatch: service account project_id "${serviceProjectId}" does not match DATABASE_URL project "${databaseProjectId}" (${databaseURL}).`
    );
  }

  return {
    serviceAccount,
    credentialsSource: fileServiceAccount ? serviceAccountPath : 'environment',
    config: {
      port: Number(process.env.PORT || serviceAccount.port || 3000),
      nodeEnv: process.env.NODE_ENV || serviceAccount.nodeEnv || 'development',
      databaseURL,
      jwtSecret: process.env.JWT_SECRET || serviceAccount.jwtSecret || null,
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || serviceAccount.jwtExpiresIn || '1h',
      pluginApiKey: process.env.PLUGIN_API_KEY || serviceAccount.plugin_api_key || serviceAccount.pluginApiKey || null,
      adminBypassEmail: process.env.ADMIN_BYPASS_EMAIL || serviceAccount.admin_bypass_email || serviceAccount.adminBypassEmail || null,
      recaptchaSecretKey: process.env.CAPTCHA_SECRET || process.env.RECAPTCHA_SECRET_KEY || serviceAccount.recaptcha_secret_key || null
    }
  };
}

module.exports = {
  loadDotEnv,
  loadRuntimeConfig
};
