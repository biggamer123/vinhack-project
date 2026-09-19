// Runtime configuration, read once at boot from the environment.
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function loadConfig() {
  return {
    port: envNumber('PORT', 3000),
    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/inkwell',
    sessionTtlHours: envNumber('SESSION_TTL_HOURS', 72),
    rateLimitPerMinute: envNumber('RATE_LIMIT_PER_MINUTE', 120),
    telemetry: envFlag('TELEMETRY', true),
  };
}

module.exports = { loadConfig, requireEnv, envFlag, envNumber };
