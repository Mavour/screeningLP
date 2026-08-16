module.exports = {
  apps: [
    {
      name: "lp-scanner",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: "10s",
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
