const { request, upload } = require('../../utils/request')
const { ICONS } = require('../../utils/icons')

const SEVERITY_TEXT = {
  healthy: '未见异常',
  mild: '轻微',
  moderate: '中等',
  severe: '严重',
  unknown: '待确认'
}

const SEVERITY_ICONS = {
  healthy: ICONS.severityHealthy,
  mild: ICONS.severityMild,
  moderate: ICONS.severityModerate,
  severe: ICONS.severitySevere,
  unknown: ICONS.severityUnknown
}

// 百度“植物识别”是打底用的，置信度太低时结论多半是错的（实测月季叶片被认成金叶女贞），
// 低于这个阈值就不展示“参考识别”，避免和档案里的品种打架。
const REFERENCE_MIN_CONFIDENCE = 0.6

function formatConfidence(value) {
  return typeof value === 'number' && isFinite(value)
    ? (value * 100).toFixed(1) + '%'
    : '未知'
}

function pad(value) {
  return value < 10 ? '0' + value : '' + value
}

function formatDue(value) {
  if (!value) return ''
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes())
}

Page({
  data: {
    icons: ICONS,
    plantId: '',
    plantName: '',
    imageUrl: '',
    loading: false,
    diagnosis: null,
    plantText: '',
    diseaseText: '',
    severityText: '',
    severityIcon: '',
    confidenceText: '未知',
    referenceLabel: '',
    referenceConfidenceText: '',
    createdReminders: [],
    previewDisease: '',
    stepText: '',
    estimateText: '',
    elapsed: 0,
    error: ''
  },

  onLoad(options) {
    this.setData({
      plantId: options.plant_id || '',
      plantName: decodeURIComponent(options.plant_name || '') || '当前植物'
    })
  },

  onUnload() {
    this.stopTimer()
  },

  startTimer(estimateText) {
    this.stopTimer()
    this.setData({
      elapsed: 0,
      estimateText: estimateText || ''
    })
    this.timer = setInterval(() => {
      this.setData({ elapsed: this.data.elapsed + 1 })
    }, 1000)
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  onChooseImage() {
    if (this.data.loading) return

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (filePath) {
          this.uploadAndDiagnose(filePath)
        }
      }
    })
  },

  async uploadAndDiagnose(filePath) {
    this.setData({
      loading: true,
      diagnosis: null,
      plantText: '',
      diseaseText: '',
      severityText: '',
      severityIcon: '',
      confidenceText: '未知',
      referenceLabel: '',
      referenceConfidenceText: '',
      createdReminders: [],
      stepText: '正在上传叶片图片...',
      error: ''
    })
    this.startTimer('预计 5-10 秒')

    try {
      const uploadData = await upload({
        url: '/storage',
        filePath,
        name: 'file',
        formData: {
          category: 'diagnosis'
        }
      })

      this.setData({
        imageUrl: uploadData.url || '',
        stepText: '正在识别植物和叶片病症...',
        estimateText: '预计 5-10 秒'
      })

      const baiduResult = await request({
        url: '/diagnosis/recognize',
        method: 'POST',
        timeout: 90000,
        data: {
          plant_id: this.data.plantId,
          relative_path: uploadData.relative_path
        }
      })

      let diagnosis = baiduResult.diagnosis || {}
      const diseaseConfidence = diagnosis.disease_confidence
      const needsVision = !diagnosis.disease ||
        typeof diseaseConfidence !== 'number' ||
        diseaseConfidence < 0.6

      if (needsVision) {
        this.setData({
          stepText: '正在让 AI 仔细看叶片照片...',
          estimateText: '预计 3-10 秒'
        })

        const visionResult = await request({
          url: '/diagnosis/vision-review',
          method: 'POST',
          timeout: 90000,
          data: {
            plant_id: this.data.plantId,
            relative_path: uploadData.relative_path
          }
        })

        const vision = visionResult.vision || {}
        if (vision.has_disease && vision.disease) {
          diagnosis = {
            ...diagnosis,
            disease: vision.disease,
            disease_confidence: vision.confidence,
            severity: vision.severity || 'unknown',
            evidence: vision.evidence || '',
            is_healthy: false,
            source: 'baidu+kimi_vision'
          }
        }
      }

      this.setData({
        stepText: '正在生成诊断报告（病害介绍和打药方案）...',
        estimateText: '预计 10-40 秒，请保持页面打开',
        previewDisease: diagnosis.disease
          ? diagnosis.disease + '（' + (SEVERITY_TEXT[diagnosis.severity] || '待确认') + '）'
          : ''
      })

      const finalResult = await request({
        url: '/diagnosis/finalize',
        method: 'POST',
        timeout: 300000,
        data: {
          plant_id: this.data.plantId,
          relative_path: uploadData.relative_path,
          diagnosis
        }
      })

      this.stopTimer()

      const result = finalResult.diagnosis || null
      const plant = result && result.plant ? result.plant : {}
      const identification = result && result.identification ? result.identification : {}

      const created = []
      if (result && result.disease) {
        created.push({
          key: 'journal',
          text: '植物养护历程：已写入本次病害记录'
        })
      }
      const treatment = finalResult.treatment_reminder
      if (treatment) {
        created.push({
          key: 'treatment_' + treatment.id,
          text: '每日提醒：' + treatment.title + ' · ' + formatDue(treatment.due_at)
        })
      }
      const feedback = finalResult.feedback_reminder
      if (feedback) {
        created.push({
          key: 'feedback_' + feedback.id,
          text: '每日提醒：' + feedback.title + ' · ' + formatDue(feedback.due_at)
        })
      }

      this.setData({
        diagnosis: result,
        plantText: plant.species
          ? plant.species + (plant.variety ? ' / ' + plant.variety : '')
          : this.data.plantName,
        diseaseText: result && result.disease ? result.disease : '未见明显病虫害',
        severityText: result ? (SEVERITY_TEXT[result.severity] || '待确认') : '',
        severityIcon: result ? (SEVERITY_ICONS[result.severity] || ICONS.severityUnknown) : '',
        confidenceText: formatConfidence(result && result.disease_confidence),
        // 置信度太低就不显示参考识别（identification 可能为空对象）
        referenceLabel: Number(identification.confidence) >= REFERENCE_MIN_CONFIDENCE
          ? (identification.label || '')
          : '',
        referenceConfidenceText: Number(identification.confidence) >= REFERENCE_MIN_CONFIDENCE
          ? formatConfidence(identification.confidence)
          : '',
        createdReminders: created,
        previewDisease: '',
        stepText: '诊断完成',
        estimateText: '',
        loading: false
      })
    } catch (err) {
      this.stopTimer()
      this.setData({
        loading: false,
        stepText: '',
        estimateText: '',
          error: err.detail || err.message || 'AI 诊断失败'
      })
    }
  },

  onRetry() {
    this.stopTimer()
    this.setData({
      diagnosis: null,
      plantText: '',
      diseaseText: '',
      severityText: '',
      severityIcon: '',
      confidenceText: '未知',
      referenceLabel: '',
      referenceConfidenceText: '',
      createdReminders: [],
      previewDisease: '',
      imageUrl: '',
      stepText: '',
      estimateText: '',
      elapsed: 0,
      error: ''
    })
  },

  goBack() {
    wx.navigateBack({
      fail() {
        wx.switchTab({
          url: '/pages/garden/garden'
        })
      }
    })
  }
})
