const MEMORY_MAX = 2000;
const CLEANUP_INTERVAL_MS = 10000;

let lastCleanup = 0;
const memory = new Map();

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

const DISTRIBUTED_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const DISTRIBUTED_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.RATE_LIMIT_ADAPTER_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 750;
})();

function safeKey(value) {
  return encodeURIComponent(String(value || '')).replace(/%/g, '_');
}

function getWindowStart(windowMs) {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

function getMemoryKey(scope, key, windowStart) {
  return `${scope}:${safeKey(key)}:${windowStart}`;
}

function cleanupMemory(now) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS && memory.size <= MEMORY_MAX) {
    return;
  }

  lastCleanup = now;

  for (const [key, entry] of memory) {
    if (now - entry.windowStart > entry.windowMs) {
      memory.delete(key);
    }
  }
}

function memoryPeek({ scope, key, windowMs }) {
  const now = Date.now();
  cleanupMemory(now);

  const windowStart = getWindowStart(windowMs);
  const entry = memory.get(getMemoryKey(scope, key, windowStart));

  return {
    count: entry?.count || 0,
    source: 'memory'
  };
}

function memoryIncrement({ scope, key, windowMs, max }) {
  const now = Date.now();
  cleanupMemory(now);

  const windowStart = getWindowStart(windowMs);
  const memKey = getMemoryKey(scope, key, windowStart);

  const entry = memory.get(memKey) || {
    count: 0,
    windowStart,
    windowMs
  };

  entry.count++;
  memory.set(memKey, entry);

  if (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }

  return {
    allowed: entry.count <= max,
    count: entry.count,
    source: 'memory'
  };
}

function memoryReset({ scope, key, windowMs }) {
  const windowStart = getWindowStart(windowMs);
  memory.delete(getMemoryKey(scope, key, windowStart));
}

async function upstashCommand(commands) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISTRIBUTED_TIMEOUT_MS);

  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error('UPSTASH_HTTP_ERROR');
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstResult(json) {
  if (Array.isArray(json)) {
    return json[0]?.result;
  }

  return json?.result;
}

function buildDistributedKey({ scope, key, windowMs }) {
  const windowStart = getWindowStart(windowMs);
  return `rl:${scope}:${safeKey(key)}:${windowStart}`;
}

async function distributedPeek(params) {
  const key = buildDistributedKey(params);

  const json = await upstashCommand([
    ['GET', key]
  ]);

  const raw = extractFirstResult(json);
  const count = parseInt(raw, 10);

  return {
    count: Number.isFinite(count) ? count : 0,
    source: 'upstash'
  };
}

async function distributedIncrement(params) {
  const key = buildDistributedKey(params);
  const ttl = Math.ceil(params.windowMs / 1000) + 5;

  const json = await upstashCommand([
    ['INCR', key],
    ['EXPIRE', key, ttl]
  ]);

  const raw = extractFirstResult(json);
  const count = parseInt(raw, 10);
  const safeCount = Number.isFinite(count) ? count : 1;

  return {
    allowed: safeCount <= params.max,
    count: safeCount,
    source: 'upstash'
  };
}

async function distributedReset(params) {
  const key = buildDistributedKey(params);

  await upstashCommand([
    ['DEL', key]
  ]);
}

async function withFallback(distributedFn, memoryFn) {
  if (!DISTRIBUTED_ENABLED) {
    return memoryFn();
  }

  try {
    return await distributedFn();
  } catch {
    return memoryFn();
  }
}

export default {
  DISTRIBUTED_ENABLED,

  peek(params) {
    return withFallback(
      () => distributedPeek(params),
      () => memoryPeek(params)
    );
  },

  increment(params) {
    return withFallback(
      () => distributedIncrement(params),
      () => memoryIncrement(params)
    );
  },

  reset(params) {
    return withFallback(
      () => distributedReset(params),
      () => memoryReset(params)
    );
  }
};
