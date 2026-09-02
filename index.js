import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());


// ============================================================
// GROQ
// ============================================================

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});


// ============================================================
// BACKBLAZE B2
// ============================================================

const b2 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,

  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});


// ============================================================
// CHAT API
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history,
      emotionData,
    } = req.body;

    // ========================================================
    // System Prompt หลัก
    // ========================================================

    const systemPrompt = `
คุณคือ "EmotiTeach AI" ผู้ช่วยด้านการเรียนรู้และการเรียนการสอนของแอป EmotiTeach

หน้าที่ของคุณ:
- ตอบคำถามทั่วไปเกี่ยวกับการเรียน
- ให้คำแนะนำเกี่ยวกับการเรียนและการจัดการความเครียด
- ช่วยอาจารย์วางแผนและปรับวิธีการสอน
- วิเคราะห์ข้อมูลอารมณ์ของนักเรียนเมื่อผู้ใช้ต้องการวิเคราะห์
- ให้คำแนะนำที่สามารถนำไปใช้ได้จริง

========================================
กฎทั่วไป
========================================

1. ตอบเป็นภาษาไทย
2. ใช้ภาษาสุภาพ เป็นมิตร และเข้าใจง่าย
3. ตอบให้เป็นธรรมชาติ ไม่พูดเหมือนตำรา
4. ตอบตรงคำถาม ไม่เกริ่นนำยาว
5. หากเป็นคำถามทั่วไป ให้ตอบประมาณ 2-4 ประโยค
6. หากมีหลายข้อ ให้ใช้ bullet points
7. หลีกเลี่ยงคำตอบที่ซ้ำหรือวกวน
8. ไม่จำเป็นต้องมีข้อมูลอารมณ์เพื่อให้สามารถตอบคำถามทั่วไปได้
9. ข้อมูลอารมณ์เป็นข้อมูลเสริม ไม่ใช่เงื่อนไขบังคับในการสนทนา
10. หากไม่มีข้อมูลอารมณ์ ห้ามตอบว่า "ข้อมูลไม่เพียงพอ" เพียงเพราะไม่มีข้อมูลอารมณ์

========================================
การสนทนาทั่วไป
========================================

หากผู้ใช้ถามคำถามทั่วไป เช่น

- วิธีอ่านหนังสือ
- วิธีเตรียมสอบ
- การเรียน
- เทคโนโลยี
- การจัดการเวลา
- ความเครียด
- การใช้ชีวิตในมหาวิทยาลัย
- คำถามทั่วไปอื่น ๆ

ให้ตอบคำถามตามปกติ

ไม่ต้องวิเคราะห์ข้อมูลอารมณ์
ไม่ต้องถามหาข้อมูลอารมณ์
ไม่ต้องแจ้งว่าข้อมูลอารมณ์ไม่เพียงพอ

========================================
การจัดการเรื่องความเครียด
========================================

หากผู้ใช้ถามเกี่ยวกับความเครียด:

- ให้คำแนะนำเบื้องต้นที่เหมาะสม
- แนะนำวิธีผ่อนคลาย
- แนะนำการจัดการภาระการเรียน
- ให้คำแนะนำที่สามารถนำไปปฏิบัติได้จริง
- ห้ามวินิจฉัยโรคทางจิตเวช

หากผู้ใช้กล่าวถึงอาการรุนแรง
หรือปัญหาที่ส่งผลต่อชีวิตประจำวันอย่างมาก
ให้แนะนำให้พูดคุยกับผู้เชี่ยวชาญ
หรือคนที่ไว้ใจได้อย่างเหมาะสม

========================================
การวิเคราะห์ข้อมูลอารมณ์
========================================

หากผู้ใช้ถามเกี่ยวกับการวิเคราะห์อารมณ์ของนักเรียน
หรือขอคำแนะนำด้านการสอนโดยอ้างอิงจากข้อมูลอารมณ์:

- ใช้ข้อมูลอารมณ์ที่ระบบให้มาเท่านั้น
- ห้ามสร้างข้อมูล ตัวเลข หรือจำนวนขึ้นมาเอง
- ต้องวิเคราะห์ข้อมูลก่อนให้คำแนะนำ
- คำแนะนำต้องสัมพันธ์กับข้อมูลอารมณ์ที่พบจริง

หากมีข้อมูลอารมณ์:
ให้วิเคราะห์ภาพรวมของอารมณ์
ระบุอารมณ์ที่พบมากหรือน่าสนใจ
จากนั้นเสนอแนวทางการสอนที่เหมาะสม 2-3 แนวทาง
พร้อมอธิบายเหตุผลสั้น ๆ

หากไม่มีข้อมูลอารมณ์:
ไม่สามารถวิเคราะห์อารมณ์เฉพาะของชั้นเรียนได้
แต่สามารถให้คำแนะนำด้านการสอนทั่วไปแทนได้

========================================
ข้อห้ามเกี่ยวกับข้อมูล
========================================

- ห้ามสร้างข้อมูลอารมณ์ขึ้นมาเอง
- ห้ามสร้างจำนวนนักเรียนขึ้นมาเอง
- ห้ามอ้างว่ามีข้อมูลที่ระบบไม่ได้ส่งมา
- หากไม่มีข้อมูล ให้บอกตามความจริง
- ห้ามวินิจฉัยโรคทางจิตเวช

========================================
บุคลิก
========================================

- สุภาพ
- เป็นมิตร
- ให้กำลังใจ
- เป็นธรรมชาติ
- ไม่พูดเหมือนตำรา
- ไม่ตอบยาวเกินความจำเป็น

========================================
ข้อมูลอารมณ์จากระบบ
========================================

${emotionData ? JSON.stringify(emotionData) : 'ไม่มีข้อมูลอารมณ์'}

========================================
`;

    const messages = [
      {
        role: 'system',
        content: systemPrompt,
      },

      ...(history || []),

      {
        role: 'user',
        content: message,
      },
    ];

    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: 'openai/gpt-oss-20b',
      temperature: 0.7,
    });

    const reply =
      chatCompletion.choices[0]?.message?.content ||
      'ไม่สามารถประมวลผลคำตอบได้';

    res.json({
      success: true,
      reply: reply,
    });

  } catch (error) {
    console.error('Groq Error:', error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// ============================================================
// GROQ MODELS API
// ============================================================

app.get('/api/models', async (req, res) => {
  try {
    const list = await groq.models.list();

    const modelIds = list.data.map((m) => m.id);

    res.json({
      success: true,
      models: modelIds,
    });

  } catch (error) {
    console.error('Groq Models Error:', error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// ============================================================
// BACKBLAZE B2 CONNECTION TEST
// ============================================================

app.get('/api/b2-test', async (req, res) => {
  try {
    await b2.send(
      new HeadBucketCommand({
        Bucket: process.env.B2_BUCKET_NAME,
      })
    );

    res.json({
      success: true,
      message: 'Backblaze B2 connected successfully',
      bucket: process.env.B2_BUCKET_NAME,
    });

  } catch (error) {
    console.error('B2 Error:', error);

    res.status(500).json({
      success: false,
      message: 'Backblaze B2 connection failed',
      error: error.message,
    });
  }
});


// ============================================================
// BACKBLAZE B2 - CREATE PRESIGNED UPLOAD URL
// ============================================================

app.post('/api/materials/upload-url', async (req, res) => {
  try {
    const {
      fileName,
      contentType,
    } = req.body;


    // --------------------------------------------------------
    // ตรวจสอบข้อมูล
    // --------------------------------------------------------

    if (!fileName) {
      return res.status(400).json({
        success: false,
        message: 'fileName is required',
      });
    }

    if (!contentType) {
      return res.status(400).json({
        success: false,
        message: 'contentType is required',
      });
    }


    // --------------------------------------------------------
    // สร้างชื่อไฟล์สำหรับเก็บใน B2
    // --------------------------------------------------------

    const storageKey =
      `materials/${Date.now()}-${fileName}`;


    // --------------------------------------------------------
    // สร้างคำสั่ง Upload
    // --------------------------------------------------------

    const command = new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: storageKey,
      ContentType: contentType,
    });


    // --------------------------------------------------------
    // สร้าง Presigned URL
    // URL มีอายุ 10 นาที
    // --------------------------------------------------------

    const uploadUrl = await getSignedUrl(
      b2,
      command,
      {
        expiresIn: 600,
      }
    );


    // --------------------------------------------------------
    // ส่ง URL กลับไปให้ Flutter
    // --------------------------------------------------------

    return res.json({
      success: true,
      uploadUrl: uploadUrl,
      storageKey: storageKey,
      fileName: fileName,
      contentType: contentType,
      expiresIn: 600,
    });

  } catch (error) {
    console.error(
      'B2 Presigned URL Error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'ไม่สามารถสร้าง Presigned Upload URL ได้',
      error: error.message,
    });
  }
});


// ============================================================
// BACKBLAZE B2 - SET CORS
// ============================================================

app.put('/api/b2-cors-set', async (req, res) => {
  try {
    await b2.send(
      new PutBucketCorsCommand({
        Bucket: process.env.B2_BUCKET_NAME,

        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'HEAD', 'PUT'],
              AllowedHeaders: ['*'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );

    res.json({
      success: true,
      message: 'B2 CORS updated successfully',
    });

  } catch (error) {
    console.error(
      'B2 CORS Set Error:',
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// ============================================================
// BACKBLAZE B2 - CHECK CORS
// ============================================================

app.get('/api/b2-cors-test', async (req, res) => {
  try {
    const result = await b2.send(
      new GetBucketCorsCommand({
        Bucket: process.env.B2_BUCKET_NAME,
      })
    );

    res.json({
      success: true,
      cors: result.CORSRules,
    });

  } catch (error) {
    console.error(
      'B2 CORS Check Error:',
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});



// START SERVER


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Backend Server running on port ${PORT}`
  );
});

