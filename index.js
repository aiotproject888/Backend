import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});


app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

   
    const messages = [
      { role: 'system', content: 'คุณคือผู้ช่วย AI แชทบอทที่พูดจาสุภาพ ชัดเจน และเป็นกันเอง' },
      ...(history || []), // ประวัติการคุยย้อนหลัง (ถ้ามี)
      { role: 'user', content: message }
    ];

    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: 'llama-3.3-70b-versatile', 
      temperature: 0.7,
    });

    const reply = chatCompletion.choices[0]?.message?.content || 'ไม่สามารถประมวลผลคำตอบได้';
    res.json({ success: true, reply: reply });

  } catch (error) {
    console.error('Groq Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend Server running on port ${PORT}`);
});