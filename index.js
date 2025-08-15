import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { Readable } from 'stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB file size limit
});

// PDF पार्सिंग के लिए नया तरीका
const pdfParse = async (buffer) => {
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    return pdf(buffer);
};

// फाइल से टेक्स्ट निकालने का फंक्शन
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
                    try {
                        const fileContent = await zip.files[filename].async('string');
                        content += `--- फाइल: ${filename} ---\n${fileContent}\n\n`;
                    } catch (e) {
                        content += `--- फाइल: ${filename} (बाइनरी फाइल, टेक्स्ट नहीं दिखाया जा सकता) ---\n\n`;
                    }
                }
            }
            return content;
        } else if (file.mimetype.startsWith('text/') || 
                   file.mimetype === 'application/json' || 
                   file.mimetype === 'application/javascript' ||
                   file.mimetype === 'application/xml') {
            return file.buffer.toString('utf-8');
        } else if (file.mimetype.startsWith('image/')) {
            return `[छवि फाइल: ${file.originalname}]`;
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
                responseData = await callDeepSeekAPI(fullPrompt);
                break;
            
            case 'openai/gpt-4o':
                responseData = await callOpenAIChat(fullPrompt, 'gpt-4o');
                break;
            
            case 'openai/dalle-3':
                responseData = await callDALLE(prompt);
                break;
            
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

// OpenAI चैट API को कॉल करें
async function callOpenAIChat(prompt, model = 'gpt-4o') {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
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
    return { 
        response: data.choices[0].message.content,
        model: model
    };
}

// OpenAI DALL-E API को कॉल करें
async function callDALLE(prompt) {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024"
        })
    });
    
    const data = await response.json();
    if (data.error) {
        throw new Error(JSON.stringify(data.error));
    }
    return { 
        imageUrl: data.data[0].url,
        model: "dall-e-3"
    };
}

// OpenRouter API को कॉल करें
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
    return { 
        response: data.choices[0].message.content,
        model: model
    };
}

// DeepSeek API को सीधे कॉल करें
async function callDeepSeekAPI(prompt) {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "deepseek-coder",
            messages: [{ role: "user", content: prompt }]
        })
    });
    
    const data = await response.json();
    if (data.error) {
        throw new Error(JSON.stringify(data.error));
    }
    return { 
        response: data.choices[0].message.content,
        model: "deepseek-coder"
    };
}

// Google Gemini API को कॉल करें
async function callGoogleGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
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
    return { 
        response: data.candidates[0].content.parts[0].text,
        model: "gemini-1.5-flash"
    };
}

// स्ट्रीमिंग रिस्पॉन्स के लिए एंडपॉइंट
app.post('/api/chat-stream', upload.single('file'), async (req, res) => {
    const { prompt, model } = req.body;
    const file = req.file;

    if (!prompt) {
        return res.status(400).json({ error: 'प्रॉम्प्ट आवश्यक है' });
    }

    try {
        let fileContent = await extractTextFromFile(file);
        const fullPrompt = fileContent ? `${prompt}\n\nफाइल सामग्री:\n${fileContent}` : prompt;
        
        // स्ट्रीमिंग रिस्पॉन्स सेटअप
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        
        // स्ट्रीमिंग के लिए फंक्शन कॉल
        switch (model) {
            case 'openai/gpt-4o':
                await streamOpenAIResponse(fullPrompt, 'gpt-4o', res);
                break;
            default:
                res.write(`data: [त्रुटि] इस मॉडल के लिए स्ट्रीमिंग सपोर्ट नहीं है\n\n`);
                res.end();
        }
        
    } catch (error) {
        console.error('/api/chat-stream में त्रुटि:', error);
        res.write(`data: [त्रुटि] ${error.message}\n\n`);
        res.end();
    }
});

// OpenAI के लिए स्ट्रीमिंग रिस्पॉन्स
async function streamOpenAIResponse(prompt, model, res) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            stream: true
        })
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            res.write('data: [DONE]\n\n');
            res.end();
            break;
        }
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            const message = line.replace(/^data: /, '');
            if (message === '[DONE]') {
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            
            try {
                const parsed = JSON.parse(message);
                const content = parsed.choices[0]?.delta?.content || '';
                if (content) {
                    accumulatedText += content;
                    // संदेश को छोटे भागों में भेजें
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    res.flush();
                }
            } catch (e) {
                console.error('स्ट्रीम डेटा पार्स करने में त्रुटि:', e);
            }
        }
    }
}

// सर्वर शुरू करें
app.listen(PORT, () => {
    console.log(`सर्वर पोर्ट ${PORT} पर चल रहा है`);
});
