/**
 * 真微信小程序 CDP 客户端。
 *
 * 背景：`工具/wmpf-debugger`（WMPFDebugger）用 frida 挂进微信 PC 的小程序运行时
 * WeChatAppEx.exe，把微信私有的 LanDebug 协议转成标准 CDP，监听在
 * ws://127.0.0.1:62000。于是「已上线、跑在真微信里」的小程序也能被脚本读和点——
 * 开发者工具那套 miniprogram-automator 只能驱动开发者工具本身，够不到真微信。
 *
 * 用法（前提：wmpf-debugger 服务在跑、目标小程序已在微信里打开）：
 *   node wmpf-cdp.js info                  视口 / 地址 / 界面文字（一眼看状态）
 *   node wmpf-cdp.js text [--limit=2000]    只打印界面可见文字
 *   node wmpf-cdp.js html [--limit=4000]    打印渲染层 DOM
 *   node wmpf-cdp.js shot <输出路径>         截小程序画面（不依赖系统截屏）
 *   node wmpf-cdp.js tap "<文字>"            按文字找元素并点击
 *   node wmpf-cdp.js tapxy <x> <y>            按**页面坐标**点击（文字定位不准时的兜底）
 *   node wmpf-cdp.js inputs                 列出输入框（序号 / 类型 / 位置）
 *   node wmpf-cdp.js fill <序号> "<文字>"     给第 N 个输入框填内容
 *   node wmpf-cdp.js insert "<文字>"          往「当前已聚焦」的输入框写内容（先用 UIA 点一下输入框）
 *   node wmpf-cdp.js focus                   看当前聚焦的是哪个元素
 *   node wmpf-cdp.js scroll <像素>            页面滚动（正数向下），长表单要滚动后 UIA 才看得见
 *   node wmpf-cdp.js login <账号>            从 工具/gen/accounts.tsv 读口令并登录（口令不出现在命令行）
 *   node wmpf-cdp.js eval "<表达式>"         在渲染层求值
 *   node wmpf-cdp.js targets                列出 CDP 里的 target（排查用）
 *
 * 关键事实（实测出来的，别想当然）：
 *   - 默认 CDP 会话落在"当前连接的那个小程序"的 page-frame 上，
 *     location.href 形如 https://servicewechat.com/<appid>/<n>/page-frame.html。
 *   - **小程序的界面 DOM 在子框架里**（`iframe[name=page-frame_101]` 之类），
 *     顶层 document 只有标题栏那点字。所以 text/html/eval/tap 默认自动挑
 *     "内容最多的那个框架"，加 `--top` 才用顶层 document。
 *   - 但 **tabBar 和 showModal 弹窗在顶层 document 里**（宿主层）。所以：
 *     `text` 会同时打印「宿主层」那段；`tap` 会跨所有文档找文字，
 *     找不到就报错而不是静默失败——否则会出现"点了没反应"的误判。
 *   - 渲染层有 document、没有 wx；逻辑层（worker target）拿不到：
 *     `Target.attachToTarget` 能返回 sessionId，但带 sessionId 的
 *     Runtime.evaluate 会超时（代理不支持 flat session）。所以断言只能靠
 *     界面文字 / DOM / 截图，拿不到 wx.getAccountInfoSync() 这类逻辑层 API。
 *   - 端口可用环境变量 WMPF_CDP_PORT 覆盖（默认 62000）。
 */
const fs = require('fs')
const path = require('path')
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'))

const PORT = Number(process.env.WMPF_CDP_PORT || 62000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 挑出"当前真正在显示"的那个文档。
 *
 * 小程序把页面栈做成一串 iframe（page-frame_101/102/103…）叠在同一个位置上：
 * **DOM 里越靠后的越在上面**，被压住的老页面 CSS 上仍是 visible、尺寸也非零，
 * 所以"文字最多"或"第一个匹配"都会挑到旧页（实测：完成面板的「完成」点到了植物详情页的「完成」）。
 * 规则因此定成：排除 hidden/零尺寸，取**最后一个可见且有内容**的 page-frame。
 */
const PICK_DOC = `(() => {
  const visible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 50 && r.height > 50
  }
  const live = [...document.querySelectorAll('iframe')]
    .filter((f) => /page-frame/.test(f.name || '') && visible(f))
    .map((f) => f.contentDocument)
    .filter((doc) => doc && doc.body && doc.body.innerText.trim().length > 0)
  const all = live.length ? live : [document]
  return all[all.length - 1]
})()`

/** 跨文档找元素：返回该元素中心的「顶层文档坐标」+ 命中所在文档，供 Input.* 使用 */
const FIND_IN_ALL_DOCS = (label) => `(() => {
  const raw = ${JSON.stringify(label)}
  // 以 ~ 开头表示"包含匹配"（页面里很多按钮文字是「展开 ▾」「修改 ›」这种拼在一起的）
  const loose = raw.charAt(0) === '~'
  const want = loose ? raw.slice(1) : raw
  // 旧的页面 frame 会留在 DOM 里（visibility:hidden 但尺寸非零），必须排除，
  // 否则会点到上一个页面里同名的按钮——这个坑实测踩过：完成面板的「完成」点到了植物详情页的「完成」。
  const visibleFrame = (f) => {
    const cs = getComputedStyle(f)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    const r = f.getBoundingClientRect()
    return r.width > 50 && r.height > 50
  }
  // 查找顺序：宿主层（showModal 之类）→ 当前页面 frame → 更老的页面 frame
  const pages = [...document.querySelectorAll('iframe')]
    .filter((f) => /page-frame/.test(f.name || '') && visibleFrame(f))
    .map((f) => f.contentDocument)
    .filter(Boolean)
  const docs = [document, ...pages.reverse()]
  for (let index = 0; index < docs.length; index++) {
    const doc = docs[index]
    let hits = []
    try {
      hits = [...doc.querySelectorAll('*')].filter((el) => {
        const t = (el.innerText || '').trim()
        if (loose) return t.indexOf(want) >= 0
        return t === want || (el.textContent || '').trim() === want
      })
    } catch (err) { continue }
    const found = hits
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((item) => item.r.width > 0 && item.r.height > 0)
      .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0]
    if (!found) continue
    const view = doc.defaultView
    const frameEl = view && view.frameElement ? view.frameElement : null
    const off = frameEl ? frameEl.getBoundingClientRect() : { left: 0, top: 0 }
    const cx = off.left + found.r.left + found.r.width / 2
    const cy = off.top + found.r.top + found.r.height / 2
    // 顶层文档坐标必须落在可视区内，否则点了也没用（长表单/长页要先 scroll）
    if (cy < 0 || cy > (document.documentElement.clientHeight || 780)) continue
    return JSON.stringify({
      docIndex: index,
      docName: frameEl ? (frameEl.name || '(iframe)') : '(top)',
      x: cx,
      y: cy,
      w: Math.round(found.r.width),
      h: Math.round(found.r.height),
      tag: found.el.tagName
    })
  }
  return JSON.stringify(null)
})()`

function connect() {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
  let seq = 0
  const pending = new Map()

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  function send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('timeout: ' + method))
        }
      }, timeoutMs || 12000)
    })
  }

  return { ready, send, close: () => ws.close() }
}

function parseFlag(argv, name, fallback) {
  const hit = argv.find((item) => item.startsWith('--' + name + '='))
  return hit ? Number(hit.split('=')[1]) : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'info'
  const conn = connect()
  await conn.ready
  await conn.send('Runtime.enable').catch(() => {})
  await conn.send('Page.enable').catch(() => {})
  await sleep(600)

  const useTop = argv.includes('--top')
  const pickDoc = useTop ? 'document' : PICK_DOC

  const evaluate = async (expression) => {
    const result = await conn.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception
      throw new Error((detail && detail.description) || result.exceptionDetails.text)
    }
    return result.result ? result.result.value : undefined
  }

  const evaluateInPage = (expression) => evaluate(`(() => { const doc = ${pickDoc}; return ${expression} })()`)

  try {
    if (cmd === 'info') {
      const meta = JSON.parse(await evaluate(
        `JSON.stringify({ href: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, title: document.title })`
      ))
      const appid = (meta.href.match(/servicewechat\.com\/(wx[0-9a-f]+)/) || [])[1] || '(未知)'
      console.log('appid:', appid)
      console.log('viewport:', meta.w + 'x' + meta.h + ' dpr=' + meta.dpr)
      console.log('url:', meta.href)
      console.log('界面文字:', await evaluateInPage(`doc.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 800)`))
      const host = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300)`)
      if (host) console.log('宿主层文字:', host)
      return
    }

    if (cmd === 'text') {
      const limit = parseFlag(argv, 'limit', 3000)
      console.log(await evaluateInPage(`doc.body.innerText.slice(0, ${limit})`))
      const host = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)`)
      if (host) console.log('--- 宿主层（tabBar / 弹窗 / 提示）---\n' + host)
      return
    }

    if (cmd === 'html') {
      const limit = parseFlag(argv, 'limit', 4000)
      console.log(await evaluateInPage(`doc.body.innerHTML.slice(0, ${limit})`))
      return
    }

    if (cmd === 'eval') {
      const expression = argv.slice(1).filter((item) => item !== '--top').join(' ')
      const value = await evaluateInPage(expression)
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      return
    }

    if (cmd === 'targets') {
      const targets = await conn.send('Target.getTargets')
      for (const item of targets.targetInfos || []) {
        console.log([item.type, item.title || '(无标题)', (item.url || '').slice(0, 90)].join(' | '))
      }
      return
    }

    if (cmd === 'inputs') {
      console.log(await evaluateInPage(`JSON.stringify([...doc.querySelectorAll('input,textarea')].map((el, i) => ({
        i, tag: el.tagName, type: el.type, value: el.value,
        rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect())
      })))`))
      return
    }

    if (cmd === 'fill') {
      const index = Number(argv[1])
      const text = argv.slice(2).join(' ')
      const focusResult = await evaluateInPage(
        `(() => { const el = doc.querySelectorAll('input,textarea')[${index}]; if (!el) return 'no-input'; el.focus(); if (el.select) el.select(); return 'focused:' + (el.type || el.tagName) })()`
      )
      if (String(focusResult).startsWith('no-input')) throw new Error('没有第 ' + index + ' 个输入框')
      await conn.send('Input.insertText', { text })
      await sleep(400)
      console.log(focusResult, '→', await evaluateInPage(
        `JSON.stringify([...doc.querySelectorAll('input,textarea')].map((el) => el.value))`
      ))
      return
    }

    if (cmd === 'insert') {
      const text = argv.slice(1).join(' ')
      const before = await evaluate(`(() => {
        const el = document.activeElement
        const deep = (doc) => {
          if (!doc) return null
          const a = doc.activeElement
          if (a && a.tagName === 'INPUT') return a
          return null
        }
        let target = deep(document)
        if (!target) {
          for (const f of [...document.querySelectorAll('iframe')]) {
            if (f.contentDocument) { const t = deep(f.contentDocument); if (t) { target = t; break } }
          }
        }
        return target ? ('type=' + target.type + ' placeholder=' + (target.placeholder || '')) : 'no-focused-input'
      })()`)
      console.log('聚焦情况:', before)
      await conn.send('Input.insertText', { text })
      await sleep(400)
      console.log('写入后输入框值:', await evaluateInPage(`JSON.stringify([...doc.querySelectorAll('input,textarea')].map((el) => el.value))`))
      return
    }

    if (cmd === 'scroll') {
      const dy = Number(argv[1] || 400)
      // 直接改 scrollTop 最稳：mouseWheel 在小程序 page-frame 里时灵时不灵（实测有页面完全不动）
      const result = await evaluateInPage(`JSON.stringify((() => {
        const el = doc.scrollingElement || doc.documentElement
        const before = el.scrollTop
        el.scrollTop = ${dy} >= 0 || before === 0 ? ${dy} : Math.max(0, before + ${dy})
        return { before, after: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }
      })())`)
      console.log('滚动:', result)
      return
    }

    if (cmd === 'login') {
      const username = argv[1]
      if (!username) throw new Error('用法: login <账号>')
      const ledger = path.join(__dirname, '..', 'gen', 'accounts.tsv')
      if (!fs.existsSync(ledger)) throw new Error('找不到账号台账: ' + ledger)
      const row = fs.readFileSync(ledger, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.split('\t'))
        .find((cols) => (cols[1] || '').toLowerCase() === username.toLowerCase())
      if (!row) throw new Error('台账里没有账号 ' + username)
      const password = row[2]

      for (const [index, text] of [[0, row[1]], [1, password]]) {
        await evaluateInPage(`(() => { const el = doc.querySelectorAll('input,textarea')[${index}]; el.focus(); return true })()`)
        await conn.send('Input.insertText', { text })
        await sleep(300)
      }
      console.log('已填入账号与口令（口令来自台账，未回显）:', await evaluateInPage(
        `JSON.stringify([...doc.querySelectorAll('input,textarea')].map((el) => el.type === 'password' ? '<password len=' + el.value.length + '>' : el.value))`
      ))

      const rect = JSON.parse(await evaluate(FIND_IN_ALL_DOCS('登录')))
      if (!rect) throw new Error('找不到「登录」按钮')
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await sleep(40)
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      await sleep(4500)
      console.log('登录后界面文字:', await evaluateInPage(`doc.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 600)`))
      return
    }

    if (cmd === 'shot') {
      const outPath = argv[1] || path.join(__dirname, 'shots-art', 'wmpf-shot.png')
      const shot = await conn.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
      console.log('saved:', outPath)
      return
    }

    if (cmd === 'tap') {
      const label = argv[1]
      if (!label) throw new Error('用法: tap "<文字>"')
      const useTouch = argv.includes('--touch')
      const rect = JSON.parse(await evaluate(FIND_IN_ALL_DOCS(label)))
      if (!rect) throw new Error('界面上找不到文字: ' + label)
      console.log('命中元素:', JSON.stringify(rect), '（doc=' + rect.docName + '）')
      if (useTouch) {
        await conn.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y }] })
        await sleep(60)
        await conn.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else {
        await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        await sleep(40)
        await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
      }
      await sleep(350)
      console.log('点击后 0.35s 界面文字:', await evaluateInPage(`doc.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)`))
      await sleep(1200)
      console.log('点击后 1.6s 界面文字:', await evaluateInPage(`doc.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)`))
      return
    }

    if (cmd === 'tapxy') {
      const x = Number(argv[1])
      const y = Number(argv[2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('用法: tapxy <x> <y>')
      console.log('点击页面坐标 (' + x + ',' + y + ')')
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(40)
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(1200)
      console.log('点击后界面文字:', await evaluateInPage(`doc.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300)`))
      return
    }

    throw new Error('未知命令: ' + cmd)
  } finally {
    conn.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[wmpf-cdp] 失败:', err.message)
    process.exit(1)
  })
