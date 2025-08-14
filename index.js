import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import multer from 'multer';
import fs from 'fs';
import pdf from 'pdf-parse';

// उपयोगकर्ता का सुझाव: ES Modules में path को सही ढंग से हैंडल करने के लिए
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// कॉन्फ़िगरेशन
dotenv.config();
const app = express();
app.use(express.json());

// उपयोगकर्ता का सुझाव: CORS को और सुरक्षित बनाना
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy does not allow access from the specified Origin: ${origin}`));
    }
  }
}));

// उपयोगकर्ता का सुझाव: फाइल साइज़ लिमिट जोड़ना
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB की लिमिट
});

// हेल्थ चेक एंडपॉइंट
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is live!' });
});

// उपयोगकर्ता का सुझाव: सिंक्रोनस की जगह एसिंक्रोनस फाइल रीडिंग
const readFileContent = async (file) => {
  const filePath = file.path;
  const mimeType = file.mimetype;

  try {
    if (mimeType === 'application/pdf') {
      const dataBuffer = await fs.promises.readFile(filePath); // Async fix
      const data = await pdf(dataBuffer);
      return data.text;
    } else if (mimeType.startsWith('text/') || ['application/javascript', 'application/json', 'text/markdown'].includes(mimeType)) {
      return await fs.promises.readFile(filePath, 'utf-8');
    } else {
      console.warn(`Unsupported file type: ${mimeType}`);
      return `[Unsupported File Type: ${mimeType}]`;
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return '[Error reading file content]';
  }
};

// AI चैट का मुख्य एंडपॉइंट
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { prompt } = req.body;
  const file = req.file;

  try {
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    let fileContent = '';
    if (file) {
      fileContent = await readFileContent(file);
    }

    let finalPrompt = prompt;
    if (fileContent) {
      finalPrompt = `Based on the following file content:\n\n---START OF FILE---\n${fileContent}\n---END OF FILE---\n\nNow, answer this question: "${prompt}"`;
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
        },
      }
    );
    
    res.json({ reply: response.data.choices[0].message.content });

  } catch (error) {
    // उपयोगकर्ता का सुझाव: बेहतर एरर हैंडलिंग
    const errorMessage = error.response?.data?.error?.message || error.message;
    console.error('API Error:', errorMessage);
    res.status(500).json({ error: `AI service failed: ${errorMessage}` });
  } finally {
    // उपयोगकर्ता का सुझाव: फाइल डिलीट करने से पहले सुरक्षा जांच
    if (file && fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path);
    }
  }
});

// सर्वर शुरू करें
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
