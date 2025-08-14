import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import pdf from 'pdf-parse';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

// 1. बेसिक कॉन्फ़िगरेशन
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// 2. CORS सेटअप (सुरक्षा के लिए)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS नियमों द्वारा अनुमति नहीं है'));
    }
  }
}));

// 3. फाइल अपलोड सेटअप
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB सीमा
});

// 4. फाइल कंटेंट पढ़ने का फंक्शन
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
      mimeType === 'application/json' ||
      mimeType === 'application/javascript'
    ) {
      return await fs.promises.readFile(filePath, 'utf-8');
    } else {
      return '[System: यह फाइल प्रकार समर्थित नहीं है]';
    }
  } catch (error) {
    console.error('फाइल पढ़ने में त्रुटि:', error);
    return '[System: फाइल पढ़ने में समस्या हुई]';
  }
};

// 5. हेल्थ चेक एंडपॉइंट
app.get('/api/health', (req, res) => {
  res.json({ status: 'स्वस्थ', message: 'बैकएंड कार्यरत है!' });
});

// 6. मुख्य चैट एंडपॉइंट (स्ट्रीमिंग के साथ)
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  if (!prompt) {
    return res.status(400).json({ error: 'प्रॉम्प्ट आवश्यक है' });
  }

  try {
    // 6.1 फाइल कंटेंट पढ़ें (अगर अपलोड की गई है)
    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    // 6.2 फाइल कंटेंट को प्रॉम्प्ट में जोड़ें
    const finalPrompt = fileContent 
      ? `फाइल कंटेंट:\n${fileContent}\n\nसवाल: ${prompt}`
      : prompt;

    // 6.3 OpenRouter API को कॉल करें (स्ट्रीमिंग मोड में)
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true // स्ट्रीमिंग सक्षम करें
      })
    });

    // 6.4 स्ट्रीम को क्लाइंट को भेजें
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    aiResponse.body.pipe(res);

  } catch (error) {
    console.error('त्रुटि:', error);
    res.status(500).json({ error: 'आंतरिक सर्वर त्रुटि' });
  } finally {
    // 6.5 अस्थायी फाइल डिलीट करें
    if (file && fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path);
    }
  }
});

// 7. सर्वर शुरू करें
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`सर्वर पोर्ट ${PORT} पर चल रहा है`);
  console.log(`अनुमत मूल स्रोत: ${allowedOrigins.join(', ') || 'सभी'}`);
});
