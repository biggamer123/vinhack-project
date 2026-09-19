// Token bucket per client. No tests, tuned by hand after every traffic spike.
const buckets = new Map();
const CAPACITY = 120;
const REFILL_PER_SECOND = 2;

function bucketFor(client) {
  let bucket = buckets.get(client);
  if (!bucket) {
    bucket = { tokens: CAPACITY, updatedAt: Date.now() };
    buckets.set(client, bucket);
  }
  return bucket;
}

function refill(bucket, now) {
  const elapsed = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_SECOND);
  bucket.updatedAt = now;
  return bucket;
}

function allowRequest(client) {
  const bucket = refill(bucketFor(client), Date.now());
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

module.exports = { allowRequest, bucketFor, refill };
