import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist';
import fetch from 'node-fetch';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// -- CORS Allowed Origins --
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// -- CORS Strictness for Production --
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  throw new Error("Production में ALLOWED_ORIGINS सेट करना अनिवार्य है!");
}
if (allowedOrigins.length === 0) {
  console.warn("WARNING: ALLOWED_ORIGINS is not set. Allowing all origins for development.");
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS policy'));
    }
  }
}));

// -- Multer File Upload Settings (10MB limit) --
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// -- PDF Text Extraction --
const extractPDFText = async (buffer) => {
  try {
    const pdfDoc = await pdfjs.getDocument({ data: buffer }).promise;
    let text = '';
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      text += textContent.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  } catch (error) {
    console.error('PDF पढ़ने में त्रुटि:', error);
    return '[System: PDF पार्स करने में समस्या हुई]';
  }
};

// -- File Content Reader --
const readFileContent = async (file) => {
  if (!file || !file.buffer) return '';
  try {
    // Extension-based type check (optional, for extra safety)
    // const ext = path.extname(file.originalname).toLowerCase();

    if (file.mimetype === 'application/pdf') {
      return await extractPDFText(file.buffer);
    } else if (
      file.mimetype.startsWith('text/') ||
      file.mimetype === 'application/json' ||
      file.mimetype === 'application/javascript'
    ) {
      return file.buffer.toString('utf-8');
    } else {
      return '[System: यह फाइल प्रकार समर्थित नहीं है]';
    }
  } catch (error) {
    console.error('फाइल पढ़ने में त्रुटि:', error);
    return '[System: फाइल पढ़ने में समस्या हुई]';
  }
};

// -- Health Endpoint --
app.get('/api/health', (req, res) => {
  res.json({
    status: 'स्वस्थ',
    message: 'बैकएंड कार्यरत है!',
    timestamp: new Date().toISOString(),
    version: process.env.BACKEND_VERSION || '1.0.1'
  });
});

// -- Main Chat Endpoint with File Upload --
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  if (!prompt) {
    return res.status(400).json({ error: 'प्रॉम्प्ट आवश्यक है' });
  }

  // Check for API key (fail-safe)
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'AI API key not configured' });
  }

  try {
    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    const finalPrompt = fileContent
      ? `फाइल कंटेंट:\n${fileContent}\n\nसवाल: ${prompt}`
      : prompt;

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true
      })
    });

    if (!aiResponse.ok || !aiResponse.body) {
      res.status(502).json({ error: 'AI API response failed' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    aiResponse.body.pipe(res);
    aiResponse.body.on('end', () => {
      res.end();
    });
    aiResponse.body.on('error', (err) => {
      console.error('AI stream error:', err);
      res.end(); // सिर्फ end करें, headersSent error से बचने के लिए
    });

  } catch (error) {
    console.error('त्रुटि:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'आंतरिक सर्वर त्रुटि' });
    } else {
      res.end();
    }
  }
});

// -- Start Server --
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`सर्वर पोर्ट ${PORT} पर चल रहा है (0.0.0.0)`);
  console.log(`अनुमत मूल स्रोत: ${allowedOrigins.join(', ') || 'सभी'}`);
});

// -- Keep-Alive/Timeout Settings --
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;
