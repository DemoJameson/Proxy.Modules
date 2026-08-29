function getKvConfig() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

  if (!url || !token) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

function sendKvNotConfigured(res) {
  res.status(500).json({
    error:
      "KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
  });
}

async function kvRequest(config, path, init) {
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ? init.headers : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`KV HTTP ${response.status}`);
  }

  return response.json();
}

function parseRedisJsonValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.length > 0 ? parsed[0] : null;
  }

  return parsed && typeof parsed === "object" ? parsed : null;
}

async function jsonGetManyKv(config, keys) {
  if (!config || keys.length === 0) {
    return [];
  }

  const [result] = await pipelineKv(config, [["JSON.MGET", ...keys, "$"]]);
  return Array.isArray(result) ? result : [];
}

async function jsonGetPairKv(config, keys) {
  if (!config || keys.length === 0) {
    return [];
  }

  return pipelineKv(
    config,
    keys.map((key) => ["JSON.GET", key, "$"]),
  );
}

async function pttlManyKv(config, keys) {
  if (!config || keys.length === 0) {
    return [];
  }

  return pipelineKv(
    config,
    keys.map((key) => ["PTTL", key]),
  );
}

async function pipelineKv(config, commands) {
  if (!config || commands.length === 0) {
    return [];
  }

  const payload = await kvRequest(config, "/pipeline", {
    method: "POST",
    body: JSON.stringify(commands),
  });
  if (!Array.isArray(payload)) {
    throw new Error("KV pipeline returned non-array response");
  }

  return payload.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("KV pipeline returned invalid command response");
    }
    if ("error" in item) {
      throw new Error(`KV pipeline command failed: ${item.error}`);
    }
    if (!("result" in item)) {
      throw new Error("KV pipeline command response is missing result");
    }
    return item.result;
  });
}

async function scanManyKvKeys(config, requests) {
  if (!config || requests.length === 0) {
    return [];
  }

  const results = await pipelineKv(
    config,
    requests.map((request) => [
      "SCAN",
      request.cursor,
      "MATCH",
      request.pattern,
      "COUNT",
      request.count,
    ]),
  );
  return results.map((result) => parseScanResult(result));
}

function parseScanResult(result) {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] || "0"),
      keys: Array.isArray(result[1]) ? result[1] : [],
    };
  }

  if (result && typeof result === "object") {
    return {
      cursor: String(result.cursor || result.nextCursor || "0"),
      keys: Array.isArray(result.keys) ? result.keys : [],
    };
  }

  return {
    cursor: "0",
    keys: [],
  };
}

module.exports = {
  getKvConfig,
  sendKvNotConfigured,
  kvRequest,
  parseRedisJsonValue,
  jsonGetManyKv,
  jsonGetPairKv,
  pttlManyKv,
  pipelineKv,
  scanManyKvKeys,
  parseScanResult,
};
