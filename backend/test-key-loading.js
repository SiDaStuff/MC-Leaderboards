#!/usr/bin/env node

const { loadRuntimeConfig } = require('./config');
const logger = require('./logger');

logger.info('Testing plugin API key loading');

try {
  const { config, credentialsSource } = loadRuntimeConfig();
  if (!config.pluginApiKey) {
    throw new Error('PLUGIN_API_KEY is not configured');
  }

  logger.info('Plugin API key loaded', {
    source: credentialsSource,
    preview: `${config.pluginApiKey.substring(0, 6)}...`
  });
} catch (error) {
  logger.error('Failed to load plugin API key', { error });
  process.exit(1);
}

logger.info('Plugin API key loading test passed');
