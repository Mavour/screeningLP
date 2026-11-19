module.exports = {
  apps: [{
    name: 'whale-radar',
    script: 'src/public-monitor.js',
    args: '--web',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    min_uptime: '10s',
    max_restarts: 10,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 12000,
    time: true,
    env: { NODE_ENV: 'production' },
  }],
};
