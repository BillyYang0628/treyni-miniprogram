const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const config = require('../config')

class LocalStorageService {
  constructor(rootDir = config.storageRoot) {
    this.rootDir = rootDir
    fs.mkdirSync(this.rootDir, { recursive: true })
  }

  save(fileBuffer, category, originalName = '') {
    const safeCategory = String(category || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = path.extname(originalName || '').toLowerCase() || '.bin'
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`
    const relativePath = path.posix.join(safeCategory, filename)
    const absolutePath = path.join(this.rootDir, relativePath)

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, fileBuffer)

    // 只返回相对路径，完整访问地址由路由层按当前请求域名拼接，
    // 避免把 localhost 或局域网 IP 固化进数据库。
    return {
      relativePath,
      absolutePath
    }
  }

  remove(relativePath) {
    if (!relativePath) return false
    const absolutePath = path.resolve(this.rootDir, relativePath)
    const rootWithSep = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep
    if (!absolutePath.startsWith(rootWithSep)) return false

    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
      return true
    }
    return false
  }
}

module.exports = new LocalStorageService()
