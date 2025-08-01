// workers/openai.js

const { Worker } = require('bullmq');
const axios = require('axios');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

const connection = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password')
});

async function mistralChat(messages) {
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: 'mistral-8b-2410',
      messages: messages
    },
    {
      headers: {
        'Authorization': `Bearer ${config.get('openai.key')}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const result = response.data;
  return result.choices[0].message.content;
}

// ✅ Safe JSON.parse helper
function tryParseJSON(raw, fallback = {}) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error('❌ Failed to parse JSON:', { raw, error: err.message });
    return fallback;
  }
}

const worker = new Worker(
  'openai-tasks',
  async (job) => {
    logger.info(`👷 Running job ${job.name} [${job.id}]`);

    if (job.name === 'parse-query') {
      const prompt = [
        { role: 'system', content: 'You are a job search assistant. Understand the user’s message and extract action & info.' },
        { role: 'user', content: job.data.message }
      ];
      const output = await mistralChat(prompt);
      return tryParseJSON(output, {
        action: 'unknown',
        response: 'Sorry, I could not understand your query.'
      });

    } else if (job.name === 'analyze-cv') {
      const prompt = [
        { role: 'system', content: 'Analyze this CV. Return JSON with skills, experience, education, summary.' },
        { role: 'user', content: job.data.cvText }
      ];
      const output = await mistralChat(prompt);
      return tryParseJSON(output, {
        skills: 0,
        experience: 0,
        education: 0,
        summary: 'Failed to analyze CV due to bad output.'
      });

    } else if (job.name === 'generate-cover-letter') {
      const prompt = [
        { role: 'system', content: 'Write a professional cover letter from this CV.' },
        { role: 'user', content: job.data.cvText }
      ];
      return await mistralChat(prompt);

    } else {
      throw new Error(`Unknown job type: ${job.name}`);
    }
  },
  { connection }
);

worker.on('completed', (job) => logger.info(`✅ Job ${job.name} [${job.id}] completed.`));
worker.on('failed', (job, err) => logger.error(`❌ Job ${job?.name} [${job?.id}] failed: ${err.message}`));
