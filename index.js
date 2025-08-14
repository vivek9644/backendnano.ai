import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import multer from 'multer';
import fs from 'fs';
import pdf from 'pdf-parse';
import path from 'path';

// कॉन्फ़िगरेशन
dotenv.config();
const app = express();
app.use(express.json());

// CORS: सिर्फ आपकी GitHub Pages की वेबसाइट को अनुमति दें
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // अगर कोई ऑरिजिन नहीं है (जैसे Postman) या ऑरिजिन हमारी लिस्ट में है, तो अनुमति दें
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Multer सेटअप: फाइलों को अस्थायी रूप से सेव करने के लिए
const upload = multer({ dest: 'uploads/' });

// हेल्थ चेक एंडपॉइंट
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is live and healthy!' });
});

// फाइल के कंटेंट को पढ़ने के लिए हेल्पर फंक्शन
const readFileContent = async (file) => {
  const filePath = file.path;
  const mimeType = file.mimetype;

  if (mimeType === 'application/pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdf(dataBuffer);
    return data.text;
  } else if (mimeType.startsWith('text/') || mimeType === 'application/javascript' || mimeType === 'application/json') {
    return fs.readFileSync(filePath, 'utf-8');
  } else {
    return 'Unsupported file type. Could not read content.';
  }
};

// AI चैट का मुख्य एंडपॉइंट
app.post('/api/chat', upload.single('file'), async (req, res) => {
  let fileContent = '';
  const userPrompt = req.body.prompt;
  const file = req.file;

  try {
    if (!userPrompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (file) {
      fileContent = await readFileContent(file);
    }

    let finalPrompt = userPrompt;
    if (fileContent) {
      finalPrompt = `Based on the following file content:\n\n---\n${fileContent}\n---\n\nAnswer this question: "${userPrompt}"`;
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'mistralai/mistral-7b-instruct:free',
        messages: [{ role: 'user', content: finalPrompt }],
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    
    res.json({ reply: response.data.choices[0].message.content });

  } catch (error) {
    console.error('API Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to get response from AI' });
  } finally {
    // अस्थायी फाइल को डिलीट कर दें
    if (file) {
      fs.unlinkSync(file.path);
    }
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});