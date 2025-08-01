require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const Redis = require('ioredis');
const config = require('./config');
const logger = require('./utils/logger');
const { statsd, trackMetric } = require('./utils/metrics');
const bot = require('./services/bot');
const openaiWorker = require('./workers/openai');
const cvWorker = require('./workers/cv');

const app = express();

// Database connection
const pool = new Pool({
  host: config.get('database.host'),
  port: config.get('database.port'),
  database: config.get('database.name'),
  user: config.get('database.user'),
  password: config.get('database.password')
});

// Redis connection
const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null
});

// Create Uploads directory if it doesn't exist
if (!fs.existsSync('./Uploads')) {
  fs.mkdirSync('./Uploads');
}

// Middleware
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);
  req.logger = logger.child({ requestId: req.id });
  next();
});

app.use(cors({ 
  origin: config.get('baseUrl'), 
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      database: 'connected',
      redis: 'connected',
      workers: 'running'
    }
  });
});

// WhatsApp webhook
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    for (const message of messages) {
      try {
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
        } else {
          // Handle other message types gracefully
          await bot.sendWhatsAppMessage(message.from, 'I can only process text messages and document files (PDF/DOCX).');
        }
      } catch (messageError) {
        req.logger.error('Error processing individual WhatsApp message', {
          messageType: message.type,
          from: message.from,
          error: messageError.message
        });
        
        // Send error message to user
        try {
          await bot.sendWhatsAppMessage(message.from, 'Sorry, I encountered an error processing your message. Please try again.');
        } catch (sendError) {
          req.logger.error('Failed to send error message to user', { sendError: sendError.message });
        }
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    req.logger.error('WhatsApp webhook error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Paystack webhook
app.post('/webhook/paystack', (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', config.get('paystack.secret'))
      .update(JSON.stringify(req.body))
      .digest('hex');
      
    if (hash !== req.headers['x-paystack-signature']) {
      req.logger.warn('Invalid Paystack webhook signature', { 
        signature: req.headers['x-paystack-signature'],
        expected: hash
      });
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { event, data } = req.body;
    req.logger.info('Paystack webhook received', { event, reference: data?.reference });
    
    if (event === 'charge.success') {
      bot.processPayment(data.reference)
        .then(() => {
          req.logger.info('Paystack webhook processed successfully', { reference: data.reference });
          res.sendStatus(200);
        })
        .catch((error) => {
          req.logger.error('Paystack webhook processing error', { 
            reference: data.reference, 
            error: error.message 
          });
          res.status(500).json({ error: 'Webhook processing failed' });
        });
    } else {
      req.logger.info('Ignored Paystack webhook event', { event });
      res.sendStatus(200);
    }
  } catch (error) {
    req.logger.error('Paystack webhook error', { error: error.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Telegram setup - only if valid token exists
let telegramBot = null;
const telegramToken = config.get('telegram.token');

if (telegramToken && 
    telegramToken.trim() !== '' && 
    telegramToken !== 'your-telegram-token') {
  
  try {
    telegramBot = new TelegramBot(telegramToken, { 
      webhook: { url: `${config.get('baseUrl')}/webhook/telegram` }
    });
    
    logger.info('Telegram bot initialized successfully');
    
    // Telegram webhook endpoint
    app.post('/webhook/telegram', async (req, res) => {
      try {
        await telegramBot.processUpdate(req.body);
        res.sendStatus(200);
      } catch (error) {
        req.logger.error('Telegram webhook processing error', { 
          error: error.message,
          update: req.body
        });
        res.status(500).json({ error: 'Telegram webhook failed' });
      }
    });
    
    // Telegram message handlers
    telegramBot.on('message', async (msg) => {
      try {
        if (msg.document) {
          // Handle document upload
          const file = await telegramBot.downloadFile(msg.document.file_id, './Uploads');
          const fileData = fs.readFileSync(file);
          
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
        } else if (msg.text) {
          // Handle text message
          await bot.handleTelegramMessage(msg.chat.id, msg.text);
        } else {
          // Handle other message types
          await bot.sendTelegramMessage(msg.chat.id, 'I can only process text messages and document files (PDF/DOCX).');
        }
      } catch (error) {
        logger.error('Telegram message processing error', { 
          chatId: msg.chat.id, 
          error: error.message,
          messageType: msg.document ? 'document' : 'text'
        });
        
        try {
          await bot.sendTelegramMessage(msg.chat.id, 'An error occurred while processing your message. Please try again.');
        } catch (sendError) {
          logger.error('Failed to send Telegram error message', { sendError: sendError.message });
        }
      }
    });
    
    // Telegram error handler
    telegramBot.on('error', (error) => {
      logger.error('Telegram bot error', { error: error.message });
    });
    
  } catch (telegramError) {
    logger.error('Failed to initialize Telegram bot', { error: telegramError.message });
  }
} else {
  logger.info('Telegram bot not initialized - no valid token provided');
}

// Error handling middleware
app.use((err, req, res, next) => {
  req.logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    url: req.url,
    method: req.method
  });
  
  trackMetric('http.error', 1, [`status:500`, `method:${req.method}`]);
  res.status(500).json({ error: 'An internal server error occurred' });
});

// 404 handler
app.use((req, res) => {
  req.logger.warn('Route not found', { 
    url: req.url, 
    method: req.method 
  });
  
  trackMetric('http.not_found', 1, [`method:${req.method}`]);
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const server = app.listen(config.get('port'), () => {
  logger.info(`SmartCVNaija server started successfully`, {
    port: config.get('port'),
    environment: config.get('env'),
    baseUrl: config.get('baseUrl'),
    telegramEnabled: !!telegramBot,
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);
  
  try {
    // Close server
    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error('Error closing server', { error: err.message });
        } else {
          logger.info('Server closed successfully');
        }
        resolve();
      });
    });
    
    // Close workers
    if (openaiWorker && typeof openaiWorker.close === 'function') {
      await openaiWorker.close();
      logger.info('OpenAI worker closed');
    }
    
    if (cvWorker && typeof cvWorker.close === 'function') {
      await cvWorker.close();
      logger.info('CV worker closed');
    }
    
    // Close database connection
    await pool.end();
    logger.info('Database connection closed');
    
    // Close Redis connection
    await redis.quit();
    logger.info('Redis connection closed');
    
    // Close StatsD connection
    if (statsd && typeof statsd.close === 'function') {
      statsd.close();
      logger.info('StatsD connection closed');
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { 
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise.toString()
  });
  
  // Don't exit immediately, let the app handle it gracefully
  setTimeout(() => {
    logger.error('Exiting due to unhandled rejection');
    process.exit(1);
  }, 1000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { 
    error: error.message, 
    stack: error.stack 
  });
  
  // Exit immediately for uncaught exceptions
  process.exit(1);
});

module.exports = server;