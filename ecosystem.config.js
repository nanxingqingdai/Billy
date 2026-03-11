require('dotenv').config(); // load .env before PM2 reads env block

module.exports = {
  apps: [
    {
      name: 'billycode',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '-r ts-node/register',
      cwd: __dirname,

      // Single instance — trading bot must not run in parallel
      instances: 1,
      exec_mode: 'fork',

      // Auto-restart on crash, but not on intentional stop
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // Restart delay to avoid rapid crash loops
      restart_delay: 5000,
      max_restarts: 10,

      // Log configuration
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Environment — PM2 inherits from process.env (populated by dotenv above),
      // so all .env vars are available. Additional static overrides go here.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
