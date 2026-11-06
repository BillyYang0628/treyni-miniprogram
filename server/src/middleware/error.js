function notFound(req, res) {
  res.status(404).json({
    error: '接口不存在',
    code: 'NOT_FOUND'
  })
}

function errorHandler(err, req, res, next) {
  console.error('[error]', err)

  // 显式标注过状态的错误（aiAdapter 的 502/503、路由里的 400/404 等）文案是给用户看的，照原样返回；
  // 没标注状态的多半是 TypeError 之类的**意外内部错误**，只进日志、不甩给用户
  // （2026-10-12 线上就把 `Cannot read properties of null (reading 'w')` 显示到了提醒详情页）。
  const explicit = Number(err.status || err.statusCode || 0)
  const status = explicit || 500
  const unexpected = explicit === 0

  res.status(status).json({
    error: unexpected ? '服务器出了点问题，请稍后再试' : (err.message || '请求失败'),
    code: err.code || (unexpected ? 'INTERNAL_ERROR' : 'ERROR')
  })
}

module.exports = {
  notFound,
  errorHandler
}
