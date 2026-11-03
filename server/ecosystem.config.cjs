// PM2 process definition for the pipelinepulse-server.
//
// Run with:
//   pm2 start ecosystem.config.cjs
//   pm2 save                     # persist across reboots (after pm2 startup)
//
// Logs are managed by the pm2-logrotate module installed at server-provision
// time (see server/README.md). Defaults: 10 MB cap per file, 14 daily rotations
// retained, gzip-compressed.

module.exports = {
  apps: [
    {
      name: 'pipelinepulse-server',
      // node src/index.js, matching the npm start script. Calling node
      // directly (instead of `npm start`) gives PM2 a clean PID to restart
      // and avoids the npm wrapper's signal-forwarding quirks.
      script: 'src/index.js',
      cwd: __dirname,
      // One process. The cron-based orphan sweep is single-writer by design;
      // running multiple cluster instances would fire the sweep N times.
      instances: 1,
      exec_mode: 'fork',
      // Restart the process if RSS exceeds this — guards against any future
      // memory leak in the writer. 512 MB is comfortable for a single Node
      // process handling GHL webhook throughput.
      max_memory_restart: '512M',
      // Restart on crash with exponential backoff, but cap retries so a
      // misconfigured .env doesn't burn CPU in a tight loop.
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,
      // Inherit env from the .env file (loaded by dotenv inside the app);
      // PM2 only needs to know we're in production mode.
      env: {
        NODE_ENV: 'production'
      },
      env_production: {
        NODE_ENV: 'production'
      },
      // Where to write stdout/stderr. The pm2-logrotate module rotates these.
      out_file: '/var/log/pipelinepulse/out.log',
      error_file: '/var/log/pipelinepulse/err.log',
      // Avoid PM2's own timestamping — pino already emits structured logs
      // with timestamps. Double-stamping makes the lines harder to grep.
      time: false
    }
  ]
};
