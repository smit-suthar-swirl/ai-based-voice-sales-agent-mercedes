import rateLimit from "express-rate-limit";

export const httpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Simple in-memory token bucket for Socket.io
const buckets = new Map();
// e.g. 60 messages per minute
const SOCKET_MAX_TOKENS = 60;
const REFILL_INTERVAL_MS = 60 * 1000;

export function socketRateLimiter(socket, next) {
  const id = socket.id;
  const now = Date.now();

  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { tokens: SOCKET_MAX_TOKENS, lastRefill: now };
    buckets.set(id, bucket);
  }

  // Refill tokens
  const elapsed = now - bucket.lastRefill;
  if (elapsed > REFILL_INTERVAL_MS) {
    bucket.tokens = SOCKET_MAX_TOKENS;
    bucket.lastRefill = now;
  }

  // Attach a helper to socket
  socket.checkRateLimit = () => {
    if (bucket.tokens <= 0) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  };

  next();
}