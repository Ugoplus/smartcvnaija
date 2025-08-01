require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { Pool } = require('pg'); 
const Redis = require('ioredis'); 
const config = require('./config');
const logger = require('./utils/logger');
const { statsd, trackMetric } = require('./utils/metrics');
const bot = require('./services/bot');
const openaiWorker = require('./workers/openai');
const cvWorker = require('./workers/cv'); 
const app = express();


// Add database and redis connections
const pool = new Pool({
  host: config.get('database.host'),
  port: config.get('database.port'),
  database: config.get('database.name'),
  user: config.get('database.user'),
  password: config.get('database.password')
});

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password')
});

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  req.logger = logger.child({ requestId: req.id });
  next();
});

app.use(cors({ origin: config.get('baseUrl'), methods: ['POST'] }));
app.use(express.json());

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { messages } = req.body;
    if (messages && messages.length > 0) {
      for (const message of messages) {
        if (message.type === 'text') {
          await bot.handleWhatsAppMessage(message.from, message.body);
        } else if (message.type === 'document') {
          if (!message.document?.data || !message.document?.filename) {
            await bot.sendWhatsAppMessage(message.from, 'Invalid document. Please send a valid PDF or DOCX file.');
            continue;
          }
          await bot.handleWhatsAppMessage(message.from, null, {
            buffer: Buffer.from(message.document.data, 'base64'),
            originalname: message.document.filename,
            email: message.from_email || null,
            phone: message.from
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    req.logger.error('WhatsApp webhook error', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

app.post('/webhook/paystack', (req, res) => {
  const hash = crypto
    .createHmac('sha512', config.get('paystack.secret'))
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    req.logger.warn('Invalid Paystack webhook signature', { signature: req.headers['x-paystack-signature'] });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const { event, data } = req.body;
  req.logger.info('Paystack webhook received', { event, reference: data.reference });
  if (event === 'charge.success') {
    bot.processPayment(data.reference)
      .then(() => {
        req.logger.info('Paystack webhook processed successfully', { reference: data.reference });
        res.sendStatus(200);
      })
      .catch((error) => {
        req.logger.error('Paystack webhook processing error', { reference: data.reference, error });
        res.status(500).json({ error: 'Webhook processing failed' });
      });
  } else {
    req.logger.info('Ignored Paystack webhook event', { event });
    res.sendStatus(200);
  }
});

let telegramBot;
if (config.get('telegram.token')) {
  telegramBot = new TelegramBot(config.get('telegram.token'), { webhook: { url: `${config.get('baseUrl')}/webhook/telegram` } });
  app.post('/webhook/telegram', async (req, res) => {
    await telegramBot.processUpdate(req.body);
    res.sendStatus(200);
  });
  telegramBot.on('message', async (msg) => {
    try {
      if (msg.document) {
        const file = await telegramBot.downloadFile(msg.document.file_id, './Uploads');
        const fileData = require('fs').readFileSync(file);
        if (fileData.length > 5 * 1024 * 1024) {
          await bot.sendTelegramMessage(msg.chat.id, 'File is too large. Please upload a CV smaller than 5MB.');
          return;
        }
        await bot.handleTelegramMessage(msg.chat.id, null, {
          buffer: fileData,
          originalname: msg.document.file_name,
          email: msg.from.email || null,
          chatId: msg.chat.id
        });
      } else {
        await bot.handleTelegramMessage(msg.chat.id, msg.text);
      }
    } catch (error) {
      logger.error('Telegram message error', { chatId: msg.chat.id, error });
      await bot.sendTelegramMessage(msg.chat.id, 'An error occurred. Please try again.');
    }
  });
}

app.use((err, req, res, next) => {
  req.logger.error('Error', { error: err.message, stack: err.stack });
  trackMetric('http.error', 1, [`status:500`]);
  res.status(500).json({ error: 'An error occurred' });
});

const server = app.listen(config.get('port'), () => {
  logger.info(`Server started on port ${config.get('port')}`);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await new Promise(resolve => server.close(resolve)); // Wait for server to close
  await openaiWorker.close();
  await cvWorker.close();
  await pool.end();
  await redis.quit();
  statsd.close();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
  process.exit(1);
});