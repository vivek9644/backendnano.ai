import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { Readable } from 'stream';

const pdfParse = async (buffer) => {
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    return pdf(buffer);
};

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Multer for file uploads (stores file in memory)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper function to extract text from different file types
const extractTextFromFile = async (file) => {
    if (!file) return '';

    try {
        if (file.mimetype === 'application/pdf') {
            const data = await pdf(file.buffer);
            return data.text;
        } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const { value } = await mammoth.extractRawText({ buffer: file.buffer });
            return value;
        } else if (file.mimetype === 'application/zip') {
            const zip = await JSZip.loadAsync(file.buffer);
            let content = `Contents of ZIP file '${file.originalname}':\n\n`;
            for (const filename in zip.files) {
                if (!zip.files[filename].dir) {
                    const fileContent = await zip.files[filename].async('string');
                    content += `--- File: ${filename} ---\n${fileContent}\n\n`;
                }
            }
            return content;
        } else if (file.mimetype.startsWith('text/')) {
            return file.buffer.toString('utf-8');
        } else {
            return `[Unsupported file type: ${file.mimetype}. File name: ${file.originalname}]`;
        }
    } catch (error) {
        console.error('Error extracting text from file:', error);
        return `[Error processing file ${file.originalname}]`;
    }
};


// Main Chat API Endpoint
app.post('/api/chat', upload.single('file'), async (req, res) => {
    const { prompt, model } = req.body;
    const file = req.file;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        let fileContent = await extractTextFromFile(file);
        const fullPrompt = fileContent ? `${prompt}\n\nFile Content:\n${fileContent}` : prompt;
        
        let responseData;
        
        // --- AI Model Routing ---
        switch (model) {
            case 'google/gemini-1.5-flash':
                responseData = await callGoogleGemini(fullPrompt);
                break;
            
            case 'deepseek/deepseek-coder':
                 // NOTE: Using OpenRouter to call Deepseek as it's easier
            case 'openrouter/deepseek/deepseek-chat':
            default: // Default to an OpenRouter model
                const openRouterModel = model.startsWith('openrouter/') ? model.split('/')[2] : 'deepseek/deepseek-chat';
                responseData = await callOpenRouter(fullPrompt, openRouterModel);
                break;
        }
        
        res.json(responseData);

    } catch (error) {
        console.error('Error in /api/chat:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// Function to call OpenRouter API
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

// Function to call Google Gemini API
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


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
