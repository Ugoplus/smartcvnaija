const { Worker } = require('bullmq');
const axios = require('axios');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

const connection = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null
});

async function mistralChat(messages) {
  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model: 'mistral-small-latest',
      messages: messages,
      temperature: 0.1,
      max_tokens: 1000
    },
    {
      headers: {
        'Authorization': `Bearer ${config.get('openai.key')}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

function tryParseJSON(raw, fallback = {}) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to parse JSON:', { raw, error: err.message });
    return fallback;
  }
}

const worker = new Worker(
  'openai-tasks',
  async (job) => {
    logger.info(`Running job ${job.name} [${job.id}]`);

    try {
      if (job.name === 'parse-query') {
        const prompt = [
          { 
            role: 'system', 
            content: `You are a job search assistant. Parse user queries and return JSON in this exact format:
            {
              "action": "search_jobs" | "apply_job" | "unknown",
              "filters": {
                "title": "job title or null",
                "location": "location or null", 
                "company": "company or null",
                "remote": true/false/null
              },
              "applyAll": true/false,
              "jobId": "number or null",
              "response": "helpful response text"
            }
            
            Examples:
            - "find jobs in Lagos" -> action: "search_jobs", filters: {location: "Lagos"}
            - "apply to job 1" -> action: "apply_job", jobId: 1
            - "apply all" -> action: "apply_job", applyAll: true` 
          },
          { role: 'user', content: job.data.message }
        ];
        const output = await mistralChat(prompt);
        return tryParseJSON(output, {
          action: 'unknown',
          response: 'Sorry, I could not understand your query. Try "find jobs in Lagos" or "apply to job 1".'
        });

      } else if (job.name === 'analyze-cv') {
        const prompt = [
          { 
            role: 'system', 
            content: `Analyze this CV and return JSON in this exact format:
            {
              "skills": number (0-100),
              "experience": number (years),
              "education": number (0-100),
              "summary": "brief analysis text"
            }` 
          },
          { role: 'user', content: job.data.cvText }
        ];
        const output = await mistralChat(prompt);
        return tryParseJSON(output, {
          skills: 50,
          experience: 0,
          education: 50,
          summary: 'CV analysis completed with basic scoring.'
        });

      } else if (job.name === 'generate-cover-letter') {
        const prompt = [
          { 
            role: 'system', 
            content: 'Write a professional cover letter based on this CV. Make it concise and compelling.' 
          },
          { role: 'user', content: job.data.cvText }
        ];
        return await mistralChat(prompt);

      } else {
        throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      logger.error(`Job ${job.name} failed:`, error);
      
      // Return fallback responses
      if (job.name === 'parse-query') {
        return { action: 'unknown', response: 'Processing error occurred.' };
      } else if (job.name === 'analyze-cv') {
        return { skills: 0, experience: 0, education: 0, summary: 'Analysis failed.' };
      } else if (job.name === 'generate-cover-letter') {
        return 'Dear Hiring Manager,\n\nI am writing to express my interest in this position. Please find my CV attached.\n\nBest regards,\n[Your Name]';
      }
      throw error;
    }
  },
  { connection }
);

worker.on('completed', (job) => logger.info(`Job ${job.name} [${job.id}] completed.`));
worker.on('failed', (job, err) => logger.error(`Job ${job?.name} [${job?.id}] failed: ${err.message}`));

module.exports = worker;