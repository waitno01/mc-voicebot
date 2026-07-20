module.exports = {
  apps: [{
    name: 'voicebot',
    script: 'voicebot.js',
    autorestart: true,
    max_restarts: 20,
    min_uptime: '30s',
    max_memory_restart: '700M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
