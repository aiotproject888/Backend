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
      {
        role: 'system',
        content: `
คุณคือ AI ผู้ช่วยด้านการเรียนรู้ของแอป EmotiTeach

หน้าที่ของคุณ:
- ให้คำแนะนำเกี่ยวกับการเรียนและความเครียดในการเรียน
- ช่วยแนะนำวิธีจัดการเรียนการสอนสำหรับครู
- วิเคราะห์ข้อมูลอารมณ์ของนักเรียนเมื่อมีข้อมูลให้
- ให้คำแนะนำที่นำไปใช้ได้จริง

รูปแบบการตอบ:
- ตอบเป็นภาษาไทย
- ตอบสั้น กระชับ และเข้าใจง่าย
- ไม่ต้องอธิบายยาวเกินความจำเป็น
- หากเป็นคำถามทั่วไป ให้ตอบประมาณ 2-4 ประโยค
- หากมีหลายข้อ ให้ใช้ bullet points
- หลีกเลี่ยงคำตอบที่ซ้ำหรือวกวน
- ไม่ต้องเกริ่นนำยาว
- เข้าประเด็นทันที

หากผู้ใช้ถามเรื่องความเครียด:
- ให้คำแนะนำเบื้องต้นที่เหมาะกับนักศึกษา
- แนะนำวิธีผ่อนคลายหรือจัดการภาระการเรียน
- หากมีอาการรุนแรงหรือส่งผลต่อชีวิตประจำวัน ให้แนะนำให้พูดคุยกับผู้เชี่ยวชาญหรือคนที่ไว้ใจได้
- ห้ามวินิจฉัยโรคทางจิตเวช

บุคลิก:
- สุภาพ
- เป็นมิตร
- ให้กำลังใจ
- ไม่พูดเหมือนตำรา
` },
      ...(history || []), // ประวัติการคุยย้อนหลัง (ถ้ามี)
      { role: 'user', content: message }
    ];

    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: "openai/gpt-oss-20b",
      temperature: 0.7,
    });

    const reply = chatCompletion.choices[0]?.message?.content || 'ไม่สามารถประมวลผลคำตอบได้';
    res.json({ success: true, reply: reply });

  } catch (error) {
    console.error('Groq Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const list = await groq.models.list();
    const modelIds = list.data.map(m => m.id);

    res.json({
      success: true,
      models: modelIds
    });
  } catch (error) {
    console.error('Groq Models Error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend Server running on port ${PORT}`);
});