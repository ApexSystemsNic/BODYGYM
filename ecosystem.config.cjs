// PM2 process definition. Usage: pm2 start ecosystem.config.cjs [--env production]
// Environment values are read from .env (see .env.example); do not store secrets here.
module.exports = {
  apps: [
    {
      name: 'bodyfactory-3000',
      cwd: __dirname,
      script: 'server/server.js',
      node_args: '--env-file-if-exists=.env --disable-warning=ExperimentalWarning',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
