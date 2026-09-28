// 实操模拟测试：已提交的反馈不再重复询问；待反馈的正常显示按钮
//
// 2026-09-21 改成自己造数据：原来写死 COMPLETED_FEEDBACK_ID = 79 /
// PENDING_FEEDBACK_ID = 86，库清过一次之后就没有这两条了。
// 现在临时起一盆植物 → 造两组"用药 + 效果询问"，其中一组当场提交掉，
// 跑完把整盆植物删掉，不碰你自己的数据。
const path = require('node:path')
const fs = require('node:fs')
const automator = require('miniprogram-automator')
const { getToken, api, openDb, createTempPlant, deletePlant, seedTreatmentPair } = require('./lib')

const SHOT_DIR = path.resolve(__dirname, 'shots')

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const token = getToken()
  const db = openDb()
  const plantId = await createTempPlant(token, '反馈走查', '月季')

  // 第一组：提交掉 → 变成"已提交的反馈"
  const first = seedTreatmentPair(db, plantId, 1, 1, 'ui-check-a', '黑斑病')
  await api('/reminders/' + first.feedbackId + '/treatment-feedback',
    { method: 'POST', body: { effective: true } }, token)
  // 第二组：保持待反馈
  const second = seedTreatmentPair(db, plantId, 1, 1, 'ui-check-b', '白粉病')

  const COMPLETED_FEEDBACK_ID = first.feedbackId
  const PENDING_FEEDBACK_ID = second.feedbackId
  console.log('临时植物 id=' + plantId + '｜已提交反馈=' + COMPLETED_FEEDBACK_ID +
    '｜待反馈=' + PENDING_FEEDBACK_ID)

  let failures = 0

  await miniProgram.reLaunch('/pages/garden/garden')

  // 已提交过的反馈
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + COMPLETED_FEEDBACK_ID)
  let page = await miniProgram.currentPage()
  await page.waitFor(2500)
  const done = await page.data()
  const doneYes = await page.$('.feedback-yes')
  console.log('已提交的反馈：' + done.resultTitle + '，stage=' + done.stage)
  if (!(done.resultTitle === '这条反馈已经提交过了' ? true : false)) failures++
  console.log((done.resultTitle === '这条反馈已经提交过了' ? 'PASS' : 'FAIL') + ' | 已提交反馈不重复询问')
  console.log((!doneYes ? 'PASS' : 'FAIL') + ' | 已提交反馈不显示有效按钮')
  if (doneYes) failures++

  await miniProgram.navigateBack()
  await page.waitFor(1200)

  // 待反馈的提醒
  await miniProgram.navigateTo('/pages/reminder-detail/reminder-detail?id=' + PENDING_FEEDBACK_ID)
  page = await miniProgram.currentPage()
  await page.waitFor(2500)
  const pending = await page.data()
  const yesBtn = await page.$('.feedback-yes')
  const noBtn = await page.$('.feedback-no')
  console.log('待反馈提醒：stage=' + pending.stage + '，轮次=' + pending.feedbackRound)
  console.log((pending.stage === 'ask' ? 'PASS' : 'FAIL') + ' | 待反馈提醒显示询问界面')
  if (pending.stage !== 'ask') failures++
  if (!yesBtn || !noBtn) failures++
  console.log((yesBtn && noBtn ? 'PASS' : 'FAIL') + ' | 两个反馈按钮都在')

  const shot = path.join(SHOT_DIR, 'feedback-ask.png')
  await miniProgram.screenshot({ path: shot })
  console.log('screenshot -> ' + shot)

  console.log(failures === 0 ? '\n全部检查通过' : '\n' + failures + ' 项检查未通过')
  await deletePlant(token, plantId).catch(() => {})
  db.close()
  await miniProgram.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FAILED:', err && err.message)
  process.exit(1)
})
