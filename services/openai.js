// filepath: c:\Users\M S I\Desktop\smartcvnaija\workers\cv.js
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
  maxRetriesPerRequest: null
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

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    if (!allowedTypes.includes(type.mime)) {
      throw new Error(`Unsupported file type: ${type.mime}. Only PDF and DOCX files are allowed.`);
    }

    // Create temp file with better path handling
    const tempDir = os.tmpdir();
    const sanitizedIdentifier = identifier.toString().replace(/[^a-zA-Z0-9]/g, '_');
    tempFile = path.join(tempDir, `cv_${sanitizedIdentifier}_${Date.now()}.${type.ext}`);
    
    // Write file to temp location
    fs.writeFileSync(tempFile, file.buffer);
    
    logger.info('Processing CV file', { 
      identifier, 
      fileType: type.mime, 
      fileSize: file.buffer.length,
      tempFile 
    });

    // Optional virus scan
    try {
      await execPromise('which clamscan');
      logger.info('Running virus scan', { identifier, tempFile });
      const { stdout } = await execPromise(`clamscan --no-summary "${tempFile}"`);
      logger.info('Virus scan completed', { identifier, result: stdout.trim() });
    } catch (scanError) {
      logger.warn('ClamAV not available or scan failed, skipping virus scan', { 
        identifier, 
        error: scanError.message 
      });
    }

    // Extract text based on file type
    let text;
    if (type.mime === 'application/pdf') {
      logger.info('Extracting text from PDF', { identifier });
      const data = await pdfParse(file.buffer);
      text = data.text;
      
      // Additional PDF info for debugging
      logger.info('PDF processing complete', { 
        identifier, 
        textLength: text.length,
        pages: data.numpages 
      });
      
    } else if (type.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      logger.info('Extracting text from DOCX', { identifier });
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      text = value;
      
      logger.info('DOCX processing complete', { 
        identifier, 
        textLength: text.length 
      });
    }

    // Validate extracted text
    if (!text || text.trim().length === 0) {
      throw new Error('No text could be extracted from the file');
    }

    // Basic text cleaning
    text = text.trim().replace(/\s+/g, ' ');

    logger.info('CV text extraction successful', { 
      identifier, 
      finalTextLength: text.length,
      preview: text.substring(0, 100) + '...'
    });

    return text;

  } catch (error) {
    logger.error('CV processing error', { 
      identifier, 
      error: error.message,
      stack: error.stack,
      fileSize: file?.buffer?.length,
      tempFile
    });
    throw error;
    
  } finally {
    // Clean up temp file
    if (tempFile) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          logger.debug('Temp file cleaned up', { identifier, tempFile });
        }
      } catch (cleanupError) {
        logger.warn('Failed to clean up temp file', { 
          identifier, 
          tempFile, 
          error: cleanupError.message 
        });
      }
    }
  }
}, { connection: redis });

// Event handlers
cvWorker.on('completed', (job) => {
  logger.info('CV processing completed successfully', { 
    jobId: job.id,
    identifier: job.data.identifier,
    duration: Date.now() - job.processedOn
  });
});

cvWorker.on('failed', (job, err) => {
  logger.error('CV processing failed', {
    jobId: job?.id,
    identifier: job?.data?.identifier,
    error: err.message,
    stack: err.stack,
    attempts: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts
  });
});

cvWorker.on('progress', (job, progress) => {
  logger.info('CV processing progress', {
    jobId: job.id,
    identifier: job.data.identifier,
    progress: `${progress}%`
  });
});

module.exports = cvWorker;