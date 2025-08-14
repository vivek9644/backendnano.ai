// =================================================================
//          AI Backend Server with OpenRouter (Final Optimized)
// =================================================================
// Features:
// - Enhanced streaming with proper cleanup
// - Client disconnect handling
// - Improved error logging
// - File type validation
// - Environment variable validation
// - Async file operations
// =================================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs/promises';
import pdf from 'pdf-parse';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

// --- Configuration ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate environment variables
if (!process.env.OPENROUTER_API_KEY) {
  console.error("FATAL ERROR: OPENROUTER_API_KEY is not defined");
  process.exit(1);
}

const app = express();
app.use(express.json());

// --- Security: CORS ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn("WARNING: ALLOWED_ORIGINS is not set. Allowing all origins");
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked: ${origin}`);
      callback(new Error(`CORS policy blocked request from: ${origin}`));
    }
  }
}));

// --- Security: File Upload ---
const upload = multer({
  dest: 'uploads/',
  limits: { 
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/json',
      'application/javascript',
      'text/html'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  }
});

// --- Helper Functions ---
const readFileContent = async (file) => {
  const filePath = file.path;
  
  try {
    if (file.mimetype === 'application/pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return data.text;
    } else {
      return await fs.readFile(filePath, 'utf-8');
    }
  } catch (error) {
    console.error(`File read error: ${file.originalname}`, error);
    return `[System Error: Could not read file - ${error.message}]`;
  }
};

const deleteTempFile = async (file) => {
  if (file && file.path) {
    try {
      await fs.access(file.path);
      await fs.unlink(file.path);
      console.log(`Deleted temp file: ${file.originalname}`);
    } catch (error) {
      console.error(`Failed to delete temp file: ${file.originalname}`, error);
    }
  }
};

// --- API Endpoints ---

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Main AI chat endpoint with streaming
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  // Validate input
  if (!prompt || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'Prompt must be at least 3 characters' });
  }

  try {
    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    let finalPrompt = prompt;
    if (fileContent) {
      finalPrompt = `File content:\n${fileContent}\n\nQuestion: ${prompt}`;
    }

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.YOUR_SITE_URL || 'https://ai-agent.com',
        'X-Title': process.env.YOUR_SITE_NAME || 'AI Agent',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      const errorBody = await aiResponse.text();
      throw new Error(`OpenRouter API error: ${aiResponse.status} - ${errorBody}`);
    }

    // Setup streaming headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Handle client disconnect
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
      aiResponse.body.destroy();
      console.log('Client disconnected during streaming');
    });

    // Pipe AI stream to client
    aiResponse.body.on('data', (chunk) => {
      if (!clientDisconnected) {
        res.write(chunk);
      }
    });

    aiResponse.body.on('end', () => {
      if (!clientDisconnected) {
        res.end();
      }
      deleteTempFile(file);
    });

    aiResponse.body.on('error', (error) => {
      console.error('Streaming error:', error);
      if (!clientDisconnected) {
        res.status(500).end();
      }
      deleteTempFile(file);
    });

  } catch (error) {
    console.error('API processing error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'AI processing failed',
        details: error.message
      });
    }
    
    await deleteTempFile(file);
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ') || 'ALL'}`);
  console.log(`OpenRouter model: mistralai/mistral-7b-instruct:free`);
});
