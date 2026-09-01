const DEFAULT_MODEL = 'gpt-5.5'
const DEFAULT_USAGE_INTERVAL_MINUTES = 30

const USAGE_SCRIPT_SOURCE = String.raw`({
  request: {
    url: "{{baseUrl}}/account/balance",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }
  },
  extractor: function (response) {
    var data = response && response.data && typeof response.data === "object" ? response.data : (response || {});
    var remaining = data.remaining;
    if (typeof remaining === "string") {
      remaining = remaining.trim();
      // Preserve decimal strings from the balance endpoint rather than
      // converting a potentially large CNY balance through Number.
      if (!/^\d+(?:\.\d+)?$/.test(remaining)) remaining = null;
    } else if (typeof remaining !== "number" || !isFinite(remaining)) {
      remaining = null;
    }
    return {
      planName: typeof data.planName === "string" ? data.planName : "Relay 账户余额",
      remaining: remaining,
      unit: typeof data.unit === "string" ? data.unit : "CNY",
      isValid: data.isValid !== false,
      invalidMessage: typeof data.invalidMessage === "string" ? data.invalidMessage : null,
      extra: data.updatedAt ? "更新时间：" + data.updatedAt : null
    };
  }
})`

function text(value: unknown, fallback = ''): string {
  const result = String(value ?? '').trim()
  return result || fallback
}

export function ccswitchModel(models: string[] | string, fallback = DEFAULT_MODEL): string {
  const entries = Array.isArray(models) ? models : String(models || '').split(/[\n,，\s]+/)
  return entries.map((entry) => text(entry)).find((entry) => entry && entry !== '*') || fallback
}

export function buildCcswitchImportLink(input: {
  apiKey: string
  name: string
  endpoint: string
  homepage: string
  model?: string[] | string
}): string {
  const apiKey = text(input.apiKey)
  const endpoint = text(input.endpoint)
  const homepage = text(input.homepage)
  if (!apiKey || !endpoint || !homepage) throw new Error('CC Switch 导入参数不完整')
  const params = new URLSearchParams({
    resource: 'provider',
    app: 'codex',
    name: text(input.name, 'Relay'),
    apiKey,
    endpoint,
    homepage,
    model: ccswitchModel(input.model || DEFAULT_MODEL),
    enabled: 'true',
    usageEnabled: 'true',
    usageScript: Buffer.from(USAGE_SCRIPT_SOURCE, 'utf8').toString('base64'),
    usageBaseUrl: endpoint,
    usageAutoInterval: String(DEFAULT_USAGE_INTERVAL_MINUTES),
  })
  return `ccswitch://v1/import?${params.toString()}`
}
