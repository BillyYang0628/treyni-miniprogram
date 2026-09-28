/**
 * 撤销仓：完成提醒之后 5 秒内可以整行回滚。
 *
 * 为什么用「整行快照」而不是逐字段回滚：
 * 完成一个提醒会连带改动好几处（提醒状态、新生成的下一轮、养护历程、
 * 浇水基准、可能还有浇水事件）。逐字段写回漏一个就出错，而且以后加字段一定会漏。
 * 所以这里把 plant_reminders 那一行原样存下来，撤销时整行写回。
 *
 * 存在内存里：撤销窗口只有 5 秒，重启丢了大不了不能撤销，不值得落库。
 */
const TTL_MS = 5 * 60 * 1000 // 服务端留 5 分钟余量，客户端的 5 秒是体验层的事

const store = new Map()

function put(token, snapshot) {
  store.set(token, { snapshot, expiresAt: Date.now() + TTL_MS })
  return token
}

function take(token) {
  const entry = store.get(token)
  if (!entry) return null
  store.delete(token) // 一次性，撤销过一次就不能再撤
  if (entry.expiresAt < Date.now()) return null
  return entry.snapshot
}

// 顺手清理过期条目，避免长时间运行后内存里堆一堆没人取的快照
function sweep() {
  const now = Date.now()
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token)
  }
}

module.exports = { put, take, sweep, TTL_MS }
