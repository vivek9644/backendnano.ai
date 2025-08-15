import path from 'path'; // यहाँ जोड़ा गया
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist';

// कॉन्फ़िगरेशन
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// CORS सेटअप
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn("WARNING: ALLOWED_ORIGINS is not set. Allowing all origins for development.");
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      callback(new Error('CORS नियमों द्वारा अनुमति नहीं है'));
    }
  }
}));

// फाइल अपलोड सेटअप (मेमोरी में)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB सीमा
});

// PDF पार्सिंग फंक्शन
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

// फाइल कंटेंट पढ़ने का फंक्शन
const readFileContent = async (file) => {
  if (!file || !file.buffer) return '';

  try {
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

// हेल्थ चेक एंडपॉइंट
app.get('/api/health', (req, res) => {
  res.json({
    status: 'स्वस्थ',
    message: 'बैकएंड कार्यरत है!',
    timestamp: new Date().toISOString(),
    version: '1.0.1'
  });
});

// मुख्य चैट एंडपॉइंट (स्ट्रीमिंग के साथ)
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  if (!prompt) {
    return res.status(400).json({ error: 'प्रॉम्प्ट आवश्यक है' });
  }

  try {
    // फाइल कंटेंट पढ़ें (अगर अपलोड की गई है)
    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    // फाइल कंटेंट को प्रॉम्प्ट में जोड़ें
    const finalPrompt = fileContent 
      ? `फाइल कंटेंट:\n${fileContent}\n\nसवाल: ${prompt}`
      : prompt;

    // OpenRouter API को कॉल करें
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true
      })
    });

    // स्ट्रीमिंग रिस्पॉन्स के लिए हेडर सेट करें
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // स्ट्रीम को सीधे क्लाइंट को भेजें
    aiResponse.body.pipe(res);

  } catch (error) {
    console.error('त्रुटि:', error);
    res.status(500).json({ error: 'आंतरिक सर्वर त्रुटि' });
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`सर्वर पोर्ट ${PORT} पर चल रहा है (0.0.0.0)`);
  console.log(`अनुमत मूल स्रोत: ${allowedOrigins.join(', ') || 'सभी'}`);
});

// टाइमआउट बढ़ाएँ (Render की सिफारिश)
server.keepAliveTimeout = 120 * 1000; // 120 सेकंड
server.headersTimeout = 120 * 1000; // 120 सेकंड
