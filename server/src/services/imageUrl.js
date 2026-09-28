const config = require('../config')

const UPLOAD_PREFIX = '/uploads/'

function trimBase(baseUrl) {
  return String(baseUrl || config.publicBaseUrl || '').replace(/\/+$/, '')
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''))
}

/**
 * 返回给客户端时使用：把库里保存的相对路径拼成当前请求可访问的完整地址。
 * 历史数据里可能存过带域名的地址，这里会统一改写成当前请求的域名，
 * 避免开发者工具（127.0.0.1）和真机（局域网 IP）互相看不到图片。
 */
function toPublicUrl(value, baseUrl) {
  if (!value) return ''

  const raw = String(value).trim()
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw

  const uploadIndex = raw.indexOf(UPLOAD_PREFIX)
  if (uploadIndex !== -1) {
    const relativePath = raw.slice(uploadIndex + UPLOAD_PREFIX.length).replace(/\\/g, '/')
    return `${trimBase(baseUrl)}${UPLOAD_PREFIX}${relativePath}`
  }

  // 外部绝对地址（例如微信头像）保持原样
  if (isAbsoluteUrl(raw)) return raw

  return `${trimBase(baseUrl)}${UPLOAD_PREFIX}${raw.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

/**
 * 写入数据库前使用：统一只保存相对路径，避免把域名固化进数据。
 * 外部绝对地址（例如微信头像）保持原样。
 */
function toStoredPath(value) {
  if (!value) return ''

  const raw = String(value).trim()
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw

  const uploadIndex = raw.indexOf(UPLOAD_PREFIX)
  if (uploadIndex !== -1) {
    return raw.slice(uploadIndex + UPLOAD_PREFIX.length).replace(/\\/g, '/')
  }

  if (isAbsoluteUrl(raw)) return raw

  return raw.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * 当前请求对应的服务地址。
 * 开发者工具请求 127.0.0.1 就返回 127.0.0.1，真机请求局域网 IP 就返回局域网 IP，
 * 这样上传后的图片地址在两端都能直接访问。
 */
function getRequestBaseUrl(req) {
  const host = req && req.headers && req.headers.host
  if (host) {
    const forwarded = req.headers['x-forwarded-proto']
    const proto = forwarded
      ? String(forwarded).split(',')[0].trim()
      : (req.protocol || 'http')
    return `${proto}://${host}`
  }

  return trimBase(config.publicBaseUrl)
}

module.exports = {
  UPLOAD_PREFIX,
  getRequestBaseUrl,
  toPublicUrl,
  toStoredPath
}
