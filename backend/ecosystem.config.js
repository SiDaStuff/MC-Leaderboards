// PM2 Ecosystem Configuration for MC Leaderboards

module.exports = {
  apps: [
    {
      name: 'mc-leaderboards-api',
      script: './server.js',
      instances: 1,
      exec_mode: 'fork',
      cwd: __dirname,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        FIREBASE_SERVICE_ACCOUNT_PATH: './key.json'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        FIREBASE_SERVICE_ACCOUNT_PATH: './key.json'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000
    },
    {
      name: 'mc-leaderboards-cleanup',
      script: './scripts/cleanup-matches.js',
      instances: 1,
      exec_mode: 'fork',
      cwd: __dirname,
      env: {
        NODE_ENV: 'development',
        FIREBASE_SERVICE_ACCOUNT_PATH: './key.json'
      },
      env_production: {
        NODE_ENV: 'production',
        FIREBASE_SERVICE_ACCOUNT_PATH: './key.json'
      },
      error_file: './logs/cleanup-err.log',
      out_file: './logs/cleanup-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      min_uptime: '10s',
      max_restarts: 5,
      restart_delay: 10000
    }
  ]
};
