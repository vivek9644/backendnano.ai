// =================================================================
//          AI Backend Server with OpenRouter (Final Version)
// =================================================================
// Features:
// - Secure CORS setup
// - Asynchronous file reading for performance
// - Robust error handling
// - File size limit for security
// - Streaming support for faster user experience
// - Uses a fast and free default model
// =================================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import pdf from 'pdf-parse';
import path from 'path';
import { fileURLToPath } from 'url';

// Node-fetch का उपयोग स्ट्रीमिंग के लिए आवश्यक है
import fetch from 'node-fetch';

// --- कॉन्फ़िगरेशन ---
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// --- सुरक्षा: CORS ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn("WARNING: ALLOWED_ORIGINS is not set. Allowing all origins for development.");
}

app.use(cors({
  origin: function (origin, callback) {
    // अगर कोई ऑरिजिन नहीं है (जैसे सर्वर-से-सर्वर रिक्वेस्ट) या ऑरिजिन हमारी लिस्ट में है, तो अनुमति दें
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy does not allow access from the specified Origin: ${origin}`));
    }
  }
}));


// --- सुरक्षा: फाइल अपलोड ---
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB की फाइल साइज़ लिमिट
});


// --- हेल्पर फंक्शन: फाइल का कंटेंट पढ़ना ---
const readFileContent = async (file) => {
  const filePath = file.path;
  const mimeType = file.mimetype;

  try {
    if (mimeType === 'application/pdf') {
      const dataBuffer = await fs.promises.readFile(filePath);
      const data = await pdf(dataBuffer);
      return data.text;
    } else if (
        mimeType.startsWith('text/') ||
        ['application/javascript', 'application/json', 'text/markdown'].includes(mimeType)
    ) {
      return await fs.promises.readFile(filePath, 'utf-8');
    } else {
      console.warn(`Unsupported file type attempted to be read: ${mimeType}`);
      return `[System Note: Unsupported file type '${mimeType}' was uploaded and could not be read.]`;
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return '[System Note: There was an error reading the uploaded file.]';
  }
};


// --- API एंडपॉइंट्स ---

// 1. हेल्थ चेक एंडपॉइंट
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is live and healthy!' });
});

// 2. मुख्य AI चैट एंडपॉइंट (स्ट्रीमिंग के साथ)
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    let finalPrompt = prompt;
    if (fileContent) {
      finalPrompt = `Based on the following file content:\n\n---START OF FILE---\n${fileContent}\n---END OF FILE---\n\nNow, answer this question: "${prompt}"`;
    }

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        // Optional headers for better tracking on OpenRouter
        'HTTP-Referer': process.env.YOUR_SITE_URL || '', 
        'X-Title': process.env.YOUR_SITE_NAME || 'AI Agent',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free', // तेज और फ्री मॉडल
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true, // <<< स्ट्रीमिंग को इनेबल करता है
      }),
    });

    if (!aiResponse.ok) {
        // अगर API से कोई एरर आता है (जैसे गलत API की), तो उसे हैंडल करें
        const errorBody = await aiResponse.json();
        throw new Error(errorBody.error.message || `API request failed with status ${aiResponse.status}`);
    }

    // ब्राउज़र को बताएं कि हम एक इवेंट स्ट्रीम भेज रहे हैं
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // AI से आने वाली स्ट्रीम को सीधे क्लाइंट को भेजें
    aiResponse.body.pipe(res);

  } catch (error) {
    console.error('Full API Error:', error);
    // यह एरर तब चलेगा जब fetch रिक्वेस्ट में ही कोई समस्या हो (जैसे नेटवर्क एरर)
    res.status(500).json({ error: error.message });
  } finally {
    // अस्थायी फाइल को हमेशा डिलीट करें
    if (file && fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path).catch(err => console.error("Failed to delete temp file:", err));
    }
  }
});


// --- सर्वर को शुरू करें ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ') || 'ALL'}`);
});
