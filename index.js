// --- START OF FILE index.js ---

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
        
        // FIX: Simplified and corrected model selection logic
        if (model.startsWith('google/')) {
            responseData = await callGoogleGemini(fullPrompt, model.split('/')[1]);
        } else if (model.startsWith('openai/')) {
            const modelName = model.split('/')[1];
            if (modelName === 'dalle-3') {
                responseData = await callDALLE(prompt);
            } else {
                responseData = await callOpenAIChat(fullPrompt, modelName);
            }
        } else if (model.startsWith('deepseek-ai/')) {
            responseData = await callDeepSeekAPI(fullPrompt, model.split('/')[1]);
        } else if (model.startsWith('together-ai/')) {
             // For non-streaming TogetherAI calls (if any in future)
             // For now, it is handled by streaming endpoint.
             // This is a placeholder. All current together-ai models are streaming.
             // We can use the generic callTogetherAI function.
             responseData = await callTogetherAI(fullPrompt, model.split('/')[1]);
        }
        else { // Default to OpenRouter
            // FIX: Robust handling for different OpenRouter model ID formats
            const openRouterModel = model.replace('openrouter/', ''); // 'openrouter/deepseek/deepseek-r1' -> 'deepseek/deepseek-r1'
            responseData = await callOpenRouter(fullPrompt, openRouterModel);
        }
        
        res.json(responseData);

    } catch (error) {
        console.error('/api/chat error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Generic function to process streaming responses and collect full text
async function processStreamAndCollect(response) {
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
                // Ignore parsing errors for empty/malformed chunks
            }
        }
    }
    return fullResponse;
}

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
            stream: true // Keep stream true for consistency, but collect response here
        })
    });
    if (!response.ok) throw new Error(`OpenAI API Error: ${response.statusText}`);
    const fullResponse = await processStreamAndCollect(response);
    return { response: fullResponse, model: model };
}

// OpenAI DALL-E API
async function callDALLE(prompt) {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: prompt, n: 1, size: "1024x1024" })
    });
    const data = await response.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return { imageUrl: data.data[0].url, model: "dall-e-3" };
}

// OpenRouter API
async function callOpenRouter(prompt, model = 'deepseek/deepseek-chat') {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
            "X-Title": process.env.YOUR_SITE_NAME || "AI Studio"
        },
        body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], stream: true })
    });
    if (!response.ok) throw new Error(`OpenRouter API Error: ${response.statusText}`);
    const fullResponse = await processStreamAndCollect(response);
    return { response: fullResponse, model: model };
}

// DeepSeek API
async function callDeepSeekAPI(prompt, model = "deepseek-coder") {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], stream: true })
    });
    if (!response.ok) throw new Error(`DeepSeek API Error: ${response.statusText}`);
    const fullResponse = await processStreamAndCollect(response);
    return { response: fullResponse, model: model };
}

// Google Gemini API
async function callGoogleGemini(prompt, model = 'gemini-1.5-flash-latest') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    if (!data.candidates || !data.candidates[0].content.parts[0].text) {
         throw new Error('Invalid response structure from Gemini API');
    }
    return { response: data.candidates[0].content.parts[0].text, model: model };
}

// Together AI API
async function callTogetherAI(prompt, model) {
    // FIX: Use the model name passed from the function argument
    const togetherModelId = model === 'deepseek-v2-chat' ? 'deepseek-ai/DeepSeek-V2-Chat' : model;
    
    const response = await fetch("https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: togetherModelId, messages: [{ role: "user", content: prompt }], stream: true })
    });
    if (!response.ok) throw new Error(`TogetherAI API Error: ${response.statusText}`);
    const fullResponse = await processStreamAndCollect(response);
    return { response: fullResponse, model: model };
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
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        
        let apiResponse;
        
        // FIX: Simplified and corrected streaming logic
        if (model.startsWith('openai/')) {
            apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: model.split('/')[1], messages: [{ role: "user", content: prompt }], stream: true })
            });
        } else if (model.startsWith('together-ai/')) {
            const togetherModel = 'deepseek-ai/DeepSeek-V2-Chat'; // Using a known good model
            apiResponse = await fetch("https://api.together.xyz/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: togetherModel, messages: [{ role: "user", content: prompt }], stream: true })
            });
        } else if (model.startsWith('openrouter/')) {
            const openRouterModel = model.replace('openrouter/', '');
            apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
                    "X-Title": process.env.YOUR_SITE_NAME || "AI Studio"
                },
                body: JSON.stringify({ model: openRouterModel, messages: [{ role: "user", content: prompt }], stream: true })
            });
        } else {
             res.write(`data: ${JSON.stringify({ content: "[ERROR] Streaming not supported for this model." })}\n\n`);
             res.write('data: [DONE]\n\n');
             res.end();
             return;
        }

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            throw new Error(`API Error: ${apiResponse.statusText} - ${errorText}`);
        }
        
        const reader = apiResponse.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim().startsWith('data:'));
            
            for (const line of lines) {
                const message = line.replace(/^data: /, '');
                if (message === '[DONE]') {
                    break;
                }
                try {
                    const parsed = JSON.parse(message);
                    const content = parsed.choices[0]?.delta?.content || '';
                    if (content) {
                        res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    }
                } catch (e) {
                   // Ignore parsing errors for now
                }
            }
        }
        
        res.write('data: [DONE]\n\n');
        res.end();
        
    } catch (error) {
        console.error('/api/chat-stream error:', error);
        res.write(`data: ${JSON.stringify({ content: `[SERVER ERROR] ${error.message}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }
});


// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});