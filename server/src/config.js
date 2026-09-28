const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')

function resolveFromRoot(value) {
  if (!value) return value
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value)
}

/**
 * AI 供应商配置。
 * 目前支持 deepseek（默认）与 moonshot 两家，接口都是 OpenAI 兼容的 /chat/completions，
 * 切换只需改 AI_PROVIDER（或直接改 AI_BASE_URL / AI_MODEL / AI_API_KEY）。
 * 保留 moonshot 段落是为了随时回退。
 */
const AI_PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash'
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    visionModel: 'kimi-k2.6'
  }
}

const aiProvider = String(process.env.AI_PROVIDER || 'deepseek').toLowerCase()
const aiDefaults = AI_PROVIDERS[aiProvider] || AI_PROVIDERS.deepseek

const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  dbPath: resolveFromRoot(process.env.DB_PATH || './data/treyni.db'),
  storageRoot: resolveFromRoot(process.env.STORAGE_ROOT || './data/uploads'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  authTokenTtlMs: Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  wechat: {
    appid: process.env.WECHAT_APPID || '',
    secret: process.env.WECHAT_SECRET || '',
    subscribeTemplateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || '',
    miniprogramState: process.env.WECHAT_SUBSCRIBE_MINIPROGRAM_STATE || 'developer'
  },
  moonshot: {
    apiKey: process.env.MOONSHOT_API_KEY || '',
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    model: process.env.MOONSHOT_MODEL || 'kimi-k2.6'
  },
  ai: {
    provider: aiProvider,
    // 没配 AI_API_KEY 时退回对应供应商原来的变量，避免升级后断掉
    apiKey: process.env.AI_API_KEY ||
      (aiProvider === 'moonshot' ? (process.env.MOONSHOT_API_KEY || '') : ''),
    baseUrl: process.env.AI_BASE_URL || aiDefaults.baseUrl,
    model: process.env.AI_MODEL || aiDefaults.model,
    visionModel: process.env.AI_VISION_MODEL || aiDefaults.visionModel || process.env.AI_MODEL || aiDefaults.model,
    // 全局强制思考档位（disabled / low / high / max），留空则按板块策略
    thinkingOverride: process.env.AI_THINKING_OVERRIDE || ''
  },
  baidu: {
    apiKey: process.env.BAIDU_API_KEY || '',
    secretKey: process.env.BAIDU_SECRET_KEY || '',
    plantApiUrl: process.env.BAIDU_PLANT_API_URL || 'https://aip.baidubce.com/rest/2.0/image-classify/v1/plant'
  },
  qweather: {
    apiHost: process.env.QWEATHER_API_HOST || '',
    key: process.env.QWEATHER_KEY || ''
  }
}

module.exports = config
