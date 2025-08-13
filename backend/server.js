// जरूरी पैकेजेस इम्पोर्ट करें
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // .env फाइल से वेरिएबल्स लोड करने के लिए

// ऐप और पोर्ट सेटअप
const app = express();
const PORT = 3000;

// मिडलवेयर (Middleware)
app.use(cors()); // CORS को इनेबल करें
app.use(express.json()); // JSON रिक्वेस्ट को समझने के लिए

// API रूट बनाएँ
app.post('/api/chat', async (req, res) => {
    try {
        const userPrompt = req.body.prompt; // फ्रंटएंड से आया हुआ सवाल

        if (!userPrompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // OpenRouter API को कॉल करें
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'mistralai/mistral-7b-instruct:free', // आप कोई भी मॉडल चुन सकते हैं, यह एक फ्री मॉडल है
                messages: [
                    { role: 'user', content: userPrompt },
                ],
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        // AI का जवाब निकालें और फ्रंटएंड को भेजें
        const aiReply = response.data.choices[0].message.content;
        res.json({ reply: aiReply });

    } catch (error) {
        console.error('Error calling OpenRouter API:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to get response from AI' });
    }
});

// सर्वर को स्टार्ट करें
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});