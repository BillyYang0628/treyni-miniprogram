function notFound(req, res) {
  res.status(404).json({
    error: '接口不存在',
    code: 'NOT_FOUND'
  })
}

function errorHandler(err, req, res, next) {
  console.error('[error]', err)

  const status = Number(err.status || err.statusCode || 500)
  res.status(status).json({
    error: err.message || '服务器内部错误',
    code: err.code || 'INTERNAL_ERROR'
  })
}

module.exports = {
  notFound,
  errorHandler
}
