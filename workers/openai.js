const { Worker } = require('bullmq');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

const redis = new Redis({
  host: config.get('redis.host'),
  port: config.get('redis.port'),
  password: config.get('redis.password'),
  maxRetriesPerRequest: null  // ✅ ENSURE THIS IS HERE
});

const cvWorker = new Worker('cv-processing', async (job) => {
  const { file, identifier } = job.data;
  let tempFile;
  
  try {
    // Validate input
    if (!file || !file.buffer || !identifier) {
      throw new Error('Invalid job data: missing file or identifier');
    }

    // Check file size
    if (file.buffer.length > 5 * 1024 * 1024) {
      throw new Error('File too large: exceeds 5MB limit');
    }

    // Get file type
    const fileType = await import('file-type');
    const type = await fileType.fileTypeFromBuffer(file.buffer);
    
    if (!type) {
      throw new Error('Could not determine file type');
    }

    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    if (!allowedTypes.includes(type.mime)) {
      throw new Error(`Unsupported file type: ${type.mime}. Only PDF and DOCX files are allowed.`);
    }

    // Create temp file
    const tempDir = os.tmpdir();
    const sanitizedIdentifier = identifier.toString().replace(/[^a-zA-Z0-9]/g, '_');
    tempFile = path.join(tempDir, `cv_${sanitizedIdentifier}_${Date.now()}.${type.ext}`);
    
    fs.writeFileSync(tempFile, file.buffer);
    
    logger.info('Processing CV file', { identifier, fileType: type.mime, fileSize: file.buffer.length });

    // Optional virus scan
    try {
      await execPromise('which clamscan');
      await execPromise(`clamscan --no-summary "${tempFile}"`);
      logger.info('Virus scan completed', { identifier });
    } catch (scanError) {
      logger.warn('ClamAV not available, skipping virus scan', { identifier });
    }

    // Extract text
    let text;
    if (type.mime === 'application/pdf') {
      const data = await pdfParse(file.buffer);
      text = data.text;
    } else {
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      text = value;
    }

    if (!text || text.trim().length === 0) {
      throw new Error('No text could be extracted from the file');
    }

    text = text.trim().replace(/\s+/g, ' ');
    
    logger.info('CV text extraction successful', { identifier, textLength: text.length });
    return text;

  } catch (error) {
    logger.error('CV processing error', { identifier, error: error.message });
    throw error;
    
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
        logger.debug('Temp file cleaned up', { identifier, tempFile });
      } catch (cleanupError) {
        logger.warn('Failed to clean up temp file', { identifier, error: cleanupError.message });
      }
    }
  }
}, { connection: redis });

cvWorker.on('completed', (job) => {
  logger.info('CV processing completed', { jobId: job.id, identifier: job.data.identifier });
});

cvWorker.on('failed', (job, err) => {
  logger.error('CV processing failed', { jobId: job?.id, error: err.message });
});

module.exports = cvWorker;