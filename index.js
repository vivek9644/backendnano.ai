import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import mammoth from 'mammoth';
import JSZip from 'jszip';

// PDF पार्सिंग के लिए नया तरीका (बिना टेस्ट फाइल की जरूरत के)
const pdfParse = async (buffer) => {
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    return pdf(buffer);
};

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// मिडलवेयर सेटअप
app.use(cors());
app.use(express.json());

// फाइल अपलोड के लिए मल्टर कॉन्फिगरेशन
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// फाइल से टेक्स्ट निकालने का फंक्शन (अपडेटेड)
const extractTextFromFile = async (file) => {
    if (!file) return '';

    try {
        if (file.mimetype === 'application/pdf') {
            const data = await pdfParse(file.buffer);
            return data.text;
        } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const { value } = await mammoth.extractRawText({ buffer: file.buffer });
            return value;
        } else if (file.mimetype === 'application/zip') {
            const zip = await JSZip.loadAsync(file.buffer);
            let content = `ZIP फाइल की सामग्री '${file.originalname}':\n\n`;
            for (const filename in zip.files) {
                if (!zip.files[filename].dir) {
                    const fileContent = await zip.files[filename].async('string');
                    content += `--- फाइल: ${filename} ---\n${fileContent}\n\n`;
                }
            }
            return content;
        } else if (file.mimetype.startsWith('text/')) {
            return file.buffer.toString('utf-8');
        } else {
            return `[असमर्थित फाइल प्रकार: ${file.mimetype}. फाइल नाम: ${file.originalname}]`;
        }
    } catch (error) {
        console.error('फाइल से टेक्स्ट निकालने में त्रुटि:', error);
        return `[फाइल प्रोसेसिंग में त्रुटि: ${file.originalname}]`;
    }
};

// मुख्य चैट API एंडपॉइंट
app.post('/api/chat', upload.single('file'), async (req, res) => {
    const { prompt, model } = req.body;
    const file = req.file;

    if (!prompt) {
        return res.status(400).json({ error: 'प्रॉम्प्ट आवश्यक है' });
    }

    try {
        let fileContent = await extractTextFromFile(file);
        const fullPrompt = fileContent ? `${prompt}\n\nफाइल सामग्री:\n${fileContent}` : prompt;
        
        let responseData;
        
        // AI मॉडल चुनने का लॉजिक
        switch (model) {
            case 'google/gemini-1.5-flash':
                responseData = await callGoogleGemini(fullPrompt);
                break;
            case 'deepseek/deepseek-coder':
            case 'openrouter/deepseek/deepseek-chat':
            default:
                const openRouterModel = model.startsWith('openrouter/') ? model.split('/')[2] : 'deepseek/deepseek-chat';
                responseData = await callOpenRouter(fullPrompt, openRouterModel);
                break;
        }
        
        res.json(responseData);

    } catch (error) {
        console.error('/api/chat में त्रुटि:', error);
        res.status(500).json({ error: 'सर्वर में त्रुटि हुई' });
    }
});

// OpenRouter API को कॉल करने का फंक्शन
async function callOpenRouter(prompt, model = 'deepseek/deepseek-chat') {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost",
            "X-Title": process.env.YOUR_SITE_NAME || "NanoAI"
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }]
        })
    });
    const data = await response.json();
    if (data.error) {
       throw new Error(JSON.stringify(data.error));
    }
    return { response: data.choices[0].message.content };
}

// Google Gemini API को कॉल करने का फंक्शन
async function callGoogleGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });
    const data = await response.json();
    if (data.error) {
        throw new Error(JSON.stringify(data.error));
    }
    return { response: data.candidates[0].content.parts[0].text };
}

// सर्वर शुरू करें
app.listen(PORT, () => {
    console.log(`सर्वर पोर्ट ${PORT} पर चल रहा है`);
});
