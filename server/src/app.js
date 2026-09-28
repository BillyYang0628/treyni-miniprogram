const express = require('express')
const config = require('./config')
const healthRouter = require('./routes/health')
const authRouter = require('./routes/auth')
const usersRouter = require('./routes/users')
const plantsRouter = require('./routes/plants')
const storageRouter = require('./routes/storage')
const journalsRouter = require('./routes/journals')
const remindersRouter = require('./routes/reminders')
const diagnosisRouter = require('./routes/diagnosis')
const knowledgeRouter = require('./routes/knowledge')
const chatRouter = require('./routes/chat')
const locationRouter = require('./routes/location')
const reportsRouter = require('./routes/reports')
const { notFound, errorHandler } = require('./middleware/error')

const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use('/uploads', express.static(config.storageRoot))

app.get('/', (req, res) => {
  res.json({
    name: '托蕾妮小程序后端',
    docs: '/health'
  })
})

app.use('/health', healthRouter)
app.use('/auth', authRouter)
app.use('/users', usersRouter)
app.use('/plants', plantsRouter)
app.use('/', storageRouter)
app.use('/', journalsRouter)
app.use('/', remindersRouter)
app.use('/diagnosis', diagnosisRouter)
app.use('/knowledge', knowledgeRouter)
app.use('/', chatRouter)
app.use('/', locationRouter)
app.use('/', reportsRouter)

app.use(notFound)
app.use(errorHandler)

module.exports = app
