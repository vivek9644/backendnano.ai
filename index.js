import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { Readable } from 'stream';
import Together from 'together-ai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });

// Middleware
app.use(cors());
app.use(express.json());

// Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB file size limit
});

// PDF parsing function
const pdfParse = async (buffer) => {
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    return pdf(buffer);
};

// File text extraction
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
            let content = `ZIP file content '${file.originalname}':\n\n`;
            
            for (const filename in zip.files) {
                if (!zip.files[filename].dir) {
                    try {
                        const fileContent = await zip.files[filename].async('string');
                        content += `--- File: ${filename} ---\n${fileContent}\n\n`;
                    } catch (e) {
                        content += `--- File: ${filename} (binary file, content not shown) ---\n\n`;
                    }
                }
            }
            return content;
        } else if (file.mimetype.startsWith('text/') || 
                   file.mimetype === 'application/json' || 
                   file.mimetype === 'application/javascript' ||
                   file.mimetype === 'application/xml' ||
                   file.mimetype === 'text/html' ||
                   file.mimetype === 'text/css' ||
                   file.mimetype === 'text/java') {
            return file.buffer.toString('utf-8');
        } else if (file.mimetype.startsWith('image/')) {
            return `[Image file: ${file.originalname}]`;
        } else {
            return `[Unsupported file type: ${file.mimetype}. File name: ${file.originalname}]`;
        }
    } catch (error) {
        console.error('File processing error:', error);
        return `[File processing error: ${file.originalname}]`;
    }
};

// Main chat API endpoint
app.post('/api/chat', upload.single('file'), async (req, res) => {
    const { prompt, model } = req.body;
    const file = req.file;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        let fileContent = await extractTextFromFile(file);
        const fullPrompt = fileContent ? `${prompt}\n\nFile content:\n${fileContent}` : prompt;
        
        let responseData;
        
        // Model selection logic
        switch (model) {
            case 'google/gemini-1.5-flash':
                responseData = await callGoogleGemini(fullPrompt);
                break;
            
            case 'deepseek-ai/deepseek-coder':
                responseData = await callDeepSeekAPI(fullPrompt);
                break;
            
            case 'openai/gpt-4o':
                responseData = await callOpenAIChat(fullPrompt, 'gpt-4o');
                break;
            
            case 'openai/dalle-3':
                responseData = await callDALLE(prompt);
                break;
            
            case 'deepseek-ai/deepseek-r1':
                responseData = await callDeepSeekR1(fullPrompt);
                break;
            
            case 'together-ai/deepseek-r1':
                responseData = await callTogetherAI(fullPrompt);
                break;
            
            default:
                const openRouterModel = model.startsWith('openrouter/') ? model.split('/')[2] : 'deepseek/deepseek-chat';
                responseData = await callOpenRouter(fullPrompt, openRouterModel);
                break;
        }
        
        res.json(responseData);

    } catch (error) {
        console.error('/api/chat error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// OpenAI Chat API
async function callOpenAIChat(prompt, model = 'gpt-4o') {
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
    
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            const message = line.replace(/^data: /, '');
            if (message === '[DONE]') break;
            
            try {
                const parsed = JSON.parse(message);
                const content = parsed.choices[0]?.delta?.content || '';
                fullResponse += content;
            } catch (e) {
                console.error('Stream parsing error:', e);
            }
        }
    }
    
    return { 
        response: fullResponse,
        model: model
    };
}

// OpenAI DALL-E API
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

// OpenRouter API
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
            messages: [{ role: "user", content: prompt }],
            stream: true
        })
    });
    
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            const message = line.replace(/^data: /, '');
            if (message === '[DONE]') break;
            
            try {
                const parsed = JSON.parse(message);
                const content = parsed.choices[0]?.delta?.content || '';
                fullResponse += content;
            } catch (e) {
                console.error('Stream parsing error:', e);
            }
        }
    }
    
    return { 
        response: fullResponse,
        model: model
    };
}

// DeepSeek API
async function callDeepSeekAPI(prompt) {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "deepseek-coder",
            messages: [{ role: "user", content: prompt }],
            stream: true
        })
    });
    
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            const message = line.replace(/^data: /, '');
            if (message === '[DONE]') break;
            
            try {
                const parsed = JSON.parse(message);
                const content = parsed.choices[0]?.delta?.content || '';
                fullResponse += content;
            } catch (e) {
                console.error('Stream parsing error:', e);
            }
        }
    }
    
    return { 
        response: fullResponse,
        model: "deepseek-coder"
    };
}

// Google Gemini API
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

// DeepSeek R1 via Together AI
async function callTogetherAI(prompt) {
    const completion = await together.chat.completions.create({
        model: 'deepseek-ai/DeepSeek-R1',
        messages: [{ role: 'user', content: prompt }],
        stream: true
    });

    let fullResponse = '';
    for await (const chunk of completion) {
        fullResponse += chunk.choices[0]?.delta?.content || '';
    }
    
    return { 
        response: fullResponse,
        model: "deepseek-ai/DeepSeek-R1"
    };
}

// DeepSeek R1 via OpenRouter
async function callDeepSeekR1(prompt) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost",
            "X-Title": process.env.YOUR_SITE_NAME || "NanoAI"
        },
        body: JSON.stringify({
            model: "deepseek/deepseek-r1-0528:free",
            messages: [{ role: "user", content: prompt }],
            stream: true
        })
    });
    
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
            const message = line.replace(/^data: /, '');
            if (message === '[DONE]') break;
            
            try {
                const parsed = JSON.parse(message);
                const content = parsed.choices[0]?.delta?.content || '';
                fullResponse += content;
            } catch (e) {
                console.error('Stream parsing error:', e);
            }
        }
    }
    
    return { 
        response: fullResponse,
        model: "deepseek/deepseek-r1"
    };
}

// Auto-streaming endpoint
app.post('/api/chat-stream', upload.single('file'), async (req, res) => {
    const { prompt, model } = req.body;
    const file = req.file;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        let fileContent = await extractTextFromFile(file);
        const fullPrompt = fileContent ? `${prompt}\n\nFile content:\n${fileContent}` : prompt;
        
        // Setup streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        
        // Auto streaming based on model
        switch (model) {
            case 'openai/gpt-4o':
                await streamOpenAIResponse(fullPrompt, 'gpt-4o', res);
                break;
            case 'together-ai/deepseek-r1':
                await streamTogetherAIResponse(fullPrompt, res);
                break;
            case 'openrouter/deepseek/deepseek-r1':
                await streamOpenRouterResponse(fullPrompt, 'deepseek/deepseek-r1', res);
                break;
            default:
                res.write(`data: [ERROR] Streaming not supported for this model\n\n`);
                res.end();
        }
        
    } catch (error) {
        console.error('/api/chat-stream error:', error);
        res.write(`data: [ERROR] ${error.message}\n\n`);
        res.end();
    }
});

// Streaming response handlers
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
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    res.flush();
                }
            } catch (e) {
                console.error('Stream data parsing error:', e);
            }
        }
    }
}

async function streamTogetherAIResponse(prompt, res) {
    const completion = await together.chat.completions.create({
        model: 'deepseek-ai/DeepSeek-R1',
        messages: [{ role: 'user', content: prompt }],
        stream: true
    });

    for await (const chunk of completion) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
            res.flush();
        }
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
}

async function streamOpenRouterResponse(prompt, model, res) {
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
            messages: [{ role: "user", content: prompt }],
            stream: true
        })
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
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
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    res.flush();
                }
            } catch (e) {
                console.error('Stream data parsing error:', e);
            }
        }
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});