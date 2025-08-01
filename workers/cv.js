const { Worker } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const fileType = require('file-type');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password')
});

const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier } = job.data;
  try {
    const type = await fileType.fromBuffer(file.buffer);
    if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type?.mime)) {
      throw new Error('Unsupported file type');
    }

    const tempFile = `/tmp/${identifier}_${Date.now()}.${type.ext}`;
    require('fs').writeFileSync(tempFile, file.buffer);

    await execPromise(`clamscan ${tempFile}`);
    let text;
    if (type.mime === 'application/pdf') {
      const data = await pdfParse(file.buffer);
      text = data.text;
    } else {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      text = value;
    }

    require('fs').unlinkSync(tempFile);
    return text;
  } catch (error) {
    logger.error('CV processing error', { identifier, error });
    throw error;
  }
}, { connection: redis });

cvWorker.on('completed', (job) => {
  logger.info('CV processing completed', { jobId: job.id });
});

cvWorker.on('failed', (job, err) => {
  logger.error('CV processing failed', { jobId: job.id, error: err.message });
});