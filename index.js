import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import PPTX2Json from 'pptx2json';

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

const OPENROUTER_API_URL =
  'https://openrouter.ai/api/v1/chat/completions';

const AI_MODELS = {
  'gpt-oss-120b': {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    name: 'GPT-OSS 120B',
  },

  'qwen3.8-27b': {
    provider: 'groq',
    model: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B',
  },

  'gemma-4-31b': {
    provider: 'openrouter',
    model: 'google/gemma-4-31b-it:free',
    name: 'Gemma 4 31B',
  },

  'nemotron-3-ultra': {
    provider: 'openrouter',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'Nemotron 3 Ultra',
  },
};

async function generateWithGroq(model, messages) {
  const completion =
    await groq.chat.completions.create({
      model: model,
      messages: messages,
      reasoning_effort: 'medium',
    });

  return completion;
}

async function generateWithOpenRouter(model, messages) {
  const response = await fetch(
    OPENROUTER_API_URL,
    {
      method: 'POST',

      headers: {
        'Authorization':
          `Bearer ${process.env.OPENROUTER_API_KEY}`,

        'Content-Type':
          'application/json',

        'HTTP-Referer':
          'https://groq-backend-yzr8.onrender.com',

        'X-Title':
          'EmotiTeach',
      },

      body: JSON.stringify({
        model: model,
        messages: messages,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error(
      'OpenRouter API Error:',
      data
    );

    throw new Error(
      data?.error?.message ||
      'OpenRouter API request failed'
    );
  }

  return data;
}


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
// DOWNLOAD FILE FROM BACKBLAZE B2
// ============================================================

async function downloadFileFromB2(storageKey) {
  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: storageKey,
  });

  const result = await b2.send(command);

  if (!result.Body) {
    throw new Error('ไม่สามารถดาวน์โหลดไฟล์จาก Backblaze B2 ได้');
  }

  const chunks = [];

  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// ============================================================
// EXTRACT TEXT FROM FILE
// ============================================================

async function extractPdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  let text = '';

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);

    const content = await page.getTextContent();

    const pageText = content.items
      .map((item) => item.str)
      .join(' ');

    text += pageText + '\n';
  }

  return text.trim();
}

async function extractTextFromFile(buffer, fileName, contentType) {
  const ext = fileName.split('.').pop()?.toLowerCase();

  if (ext === 'pdf' || contentType === 'application/pdf') {
    const text = await extractPdfText(buffer);

    return {
      text,
      type: 'pdf',
    };
  }

  // DOCX เดิม
  if (
    ext === 'docx' ||
    contentType?.includes(
      'wordprocessingml'
    )
  ) {
    const result = await mammoth.extractRawText({
      buffer,
    });

    return {
      text: result.value ?? '',
      type: 'docx',
    };
  }

  throw new Error(
    `ยังไม่รองรับไฟล์ประเภท ${contentType || ext}`
  );
}

// ============================================================
// CHAT API
// ============================================================

// ============================================================
// CHAT API
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history,
      emotionData,
      subjectCode,
      lessonMaterials,
      model = 'gpt-oss-120b',
    } = req.body;

    // ==========================================================
    // ตรวจสอบว่าเป็น Classroom Chat หรือ General Chat
    // ==========================================================

    const isClassroom =
      subjectCode &&
      String(subjectCode).trim().length > 0;

    // ==========================================================
    // เตรียมข้อมูล Lesson Materials
    // ==========================================================

    let lessonContent = 'ไม่มีเนื้อหาบทเรียน';

    if (
      Array.isArray(lessonMaterials) &&
      lessonMaterials.length > 0
    ) {
      console.log(
        '========== LESSON MATERIAL DEBUG =========='
      );

      console.log(
        'lessonMaterials count:',
        lessonMaterials.length
      );

      lessonMaterials.forEach((material, index) => {
        console.log(
          `File ${index + 1}:`,
          material?.fileName
        );

        console.log(
          `Text length ${index + 1}:`,
          material?.text?.length
        );

        console.log(
          `Text preview ${index + 1}:`,
          material?.text?.substring(0, 300)
        );
      });

      console.log(
        '==========================================='
      );

      const materialsText = lessonMaterials
        .map((material, index) => {
          const fileName =
            material?.fileName ||
            `ไฟล์ที่ ${index + 1}`;

          const text =
            material?.text || '';

          return `
ไฟล์ที่ ${index + 1}
ชื่อไฟล์: ${fileName}

เนื้อหา:
${text}
          `.trim();
        })
        .join('\n\n--------------------------------\n\n');

      lessonContent = materialsText;
    }

    // ==========================================================
    // System Prompt หลัก
    // ==========================================================

    const systemPrompt = `
คุณคือ "EmotiTeach AI"
ผู้ช่วยด้านการเรียนรู้และการจัดการเรียนการสอน
ของแอป EmotiTeach

หน้าที่ของคุณ:
- ตอบคำถามทั่วไปเกี่ยวกับการเรียน
- อธิบายเนื้อหาบทเรียน
- ช่วยอาจารย์วางแผนและปรับวิธีการสอน
- วิเคราะห์ข้อมูลอารมณ์ของนักเรียนเมื่อมีข้อมูล
- วิเคราะห์ความสัมพันธ์ระหว่างเนื้อหาบทเรียนกับอารมณ์ของผู้เรียน
- เสนอแนวทางการจัดการเรียนการสอนที่เหมาะสม
- ให้คำแนะนำที่สามารถนำไปใช้ได้จริง


============================================================
กฎทั่วไป
============================================================

1. ตอบเป็นภาษาไทย

2. ใช้ภาษาสุภาพ เป็นมิตร และเข้าใจง่าย

3. ตอบให้เป็นธรรมชาติไม่พูดเหมือนตำรา

4. ตอบตรงคำถามไม่เกริ่นนำยาว

5. หากเป็นคำถามทั่วไปให้ตอบประมาณ 2-4 ประโยค

6. หากมีหลายข้อให้ใช้ bullet points

7. หลีกเลี่ยงคำตอบที่ซ้ำหรือวกวน

8. ไม่จำเป็นต้องมีข้อมูลอารมณ์เพื่อให้สามารถตอบคำถามทั่วไปได้

9. ข้อมูลอารมณ์เป็นข้อมูลเสริมไม่ใช่เงื่อนไขบังคับในการสนทนา

10. หากไม่มีข้อมูลอารมณ์ ห้ามตอบว่า "ข้อมูลไม่เพียงพอ" เพียงเพราะไม่มีข้อมูลอารมณ์


============================================================
การสนทนาทั่วไป
============================================================

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


============================================================
การใช้เนื้อหาบทเรียน
============================================================

หากมีข้อมูลเนื้อหาบทเรียนจากระบบ:

- สามารถใช้เนื้อหานั้นประกอบการตอบคำถาม
- หากผู้ใช้ถามเกี่ยวกับเนื้อหาที่อยู่ในไฟล์ให้ยึดข้อมูลจากเนื้อหาที่ระบบส่งมาเป็นหลัก
- ห้ามอ้างว่าไฟล์มีข้อมูลที่ไม่มีอยู่จริง
- หากเนื้อหาในไฟล์ไม่เกี่ยวข้องกับคำถามสามารถใช้ความรู้ทั่วไปช่วยตอบได้
- หากข้อมูลในไฟล์ไม่เพียงพอให้บอกตามความจริง
- ห้ามสร้างข้อความหรือข้อมูลจากไฟล์ขึ้นมาเอง


============================================================
การวิเคราะห์เนื้อหาบทเรียน + Emotion
============================================================

หากผู้ใช้ถามเกี่ยวกับการปรับการสอนและระบบมีทั้ง:

1. เนื้อหาบทเรียน
2. ข้อมูลอารมณ์ของนักเรียน

ให้วิเคราะห์ข้อมูลทั้งสองส่วนร่วมกัน

ตัวอย่าง:

เนื้อหาบทเรียน:
- เป็นหัวข้อที่มีความซับซ้อน
- มีแนวคิดเชิงนามธรรม
- ต้องใช้การคำนวณหรือการวิเคราะห์

ข้อมูลอารมณ์:
- นักศึกษามีความกังวลสูง
- นักศึกษามีความเครียดเพิ่มขึ้นหลังเรียน

ให้พิจารณาว่า
ลักษณะของเนื้อหาอาจสัมพันธ์กับ
ความยากหรือภาระในการเรียนรู้หรือไม่

จากนั้นเสนอแนวทางการสอน
ที่เหมาะสมกับสถานการณ์


============================================================
กฎเกี่ยวกับ Emotion
============================================================

หากผู้ใช้ถามเกี่ยวกับการวิเคราะห์อารมณ์:

- ใช้ข้อมูลอารมณ์ที่ระบบให้มาเท่านั้น
- ห้ามสร้างข้อมูลขึ้นมาเอง
- ห้ามสร้างตัวเลขหรือจำนวนขึ้นมาเอง
- ต้องวิเคราะห์ข้อมูลก่อนให้คำแนะนำ
- คำแนะนำต้องสัมพันธ์กับข้อมูลจริง

หากมีข้อมูลอารมณ์:

ให้:
1. วิเคราะห์ภาพรวม
2. ระบุอารมณ์ที่เด่น
3. หากมีข้อมูลก่อนและหลังเรียน
   ให้เปรียบเทียบอย่างระมัดระวัง
4. เสนอแนวทางการสอน 2-3 แนวทาง
5. อธิบายเหตุผลสั้น ๆ


============================================================
หากไม่มี Emotion
============================================================

หากไม่มีข้อมูลอารมณ์:

ไม่สามารถวิเคราะห์อารมณ์เฉพาะของชั้นเรียนได้

แต่ยังสามารถ:

- อธิบายบทเรียน
- วิเคราะห์เนื้อหาบทเรียน
- ช่วยวางแผนการสอน
- ให้คำแนะนำด้านการสอนทั่วไปได้ตามปกติ

============================================================
การจัดการเรื่องความเครียด
============================================================

หากผู้ใช้ถามเกี่ยวกับความเครียด:

- ให้คำแนะนำเบื้องต้นที่เหมาะสม
- แนะนำวิธีผ่อนคลาย
- แนะนำวิธีจัดการภาระการเรียน
- ให้คำแนะนำที่สามารถนำไปปฏิบัติได้จริง
- ห้ามวินิจฉัยโรคทางจิตเวช

หากผู้ใช้กล่าวถึงอาการรุนแรง
หรือปัญหาที่ส่งผลต่อชีวิตประจำวันอย่างมาก
ให้แนะนำให้พูดคุยกับผู้เชี่ยวชาญ
หรือคนที่ไว้ใจได้อย่างเหมาะสม


============================================================
ข้อห้ามเกี่ยวกับข้อมูล
============================================================

- ห้ามสร้างข้อมูลอารมณ์ขึ้นมาเอง
- ห้ามสร้างจำนวนนักเรียนขึ้นมาเอง
- ห้ามอ้างว่ามีข้อมูลที่ระบบไม่ได้ส่งมา
- หากไม่มีข้อมูล ให้บอกตามความจริง
- ห้ามวินิจฉัยโรคทางจิตเวช


============================================================
บุคลิก
============================================================

- สุภาพ
- เป็นมิตร
- ให้กำลังใจ
- เป็นธรรมชาติ
- ไม่พูดเหมือนตำรา
- ไม่ตอบยาวเกินความจำเป็น


============================================================
ข้อมูลรายวิชา
============================================================

Subject Code:
${subjectCode || 'ไม่มีข้อมูลรายวิชา'}


============================================================
เนื้อหาบทเรียนจากระบบ
============================================================

${lessonContent}


============================================================
ข้อมูลอารมณ์จากระบบ
============================================================

${emotionData
        ? JSON.stringify(emotionData)
        : 'ไม่มีข้อมูลอารมณ์'
      }


============================================================
ประเภทการสนทนา
============================================================

${isClassroom
        ? 'Classroom Chat — กำลังสนทนาเกี่ยวกับรายวิชา'
        : 'General Chat — การสนทนาทั่วไป'
      }


============================================================
`;

    // ==========================================================
    // Messages
    // ==========================================================

    const messages = [
      {
        role: 'system',
        content: systemPrompt,
      },

      ...(Array.isArray(history)
        ? history
        : []),

      {
        role: 'user',
        content: message,
      },
    ];

    // ==========================================================
    // SELECT AI MODEL
    // ==========================================================

    const selectedModel =
      AI_MODELS[model];

    if (!selectedModel) {
      throw new Error(
        `ไม่รองรับ AI Model: ${model}`
      );
    }

    console.log(
      'AI Model:',
      selectedModel.name
    );

    console.log(
      'Provider:',
      selectedModel.provider
    );

    console.log(
      'Model ID:',
      selectedModel.model
    );


    // ==========================================================
    // GENERATE RESPONSE
    // ==========================================================

    let chatCompletion;

    if (
      selectedModel.provider === 'groq'
    ) {
      chatCompletion =
        await generateWithGroq(
          selectedModel.model,
          messages
        );
    }

    else if (
      selectedModel.provider === 'openrouter'
    ) {
      chatCompletion =
        await generateWithOpenRouter(
          selectedModel.model,
          messages
        );
    }

    else {
      throw new Error(
        `ไม่รองรับ Provider: ${selectedModel.provider}`
      );
    }

    // ==========================================================
    // ดึงคำตอบ
    // ==========================================================

    const reply =
      chatCompletion?.choices?.[0]?.message?.content ||
      'ไม่สามารถประมวลผลคำตอบได้';

    // ==========================================================
    // Response
    // ==========================================================

    res.json({
      success: true,
      reply: reply,
    });

  } catch (error) {
    console.error(
      'Groq Error:',
      error
    );

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
// BACKBLAZE B2 - CREATE PRESIGNED DOWNLOAD URL
// ============================================================

app.post('/api/materials/download-url', async (req, res) => {
  try {
    const {
      storageKey,
      fileName,
    } = req.body;

    // --------------------------------------------------------
    // ตรวจสอบข้อมูล
    // --------------------------------------------------------

    if (!storageKey) {
      return res.status(400).json({
        success: false,
        message: 'storageKey is required',
      });
    }

    // --------------------------------------------------------
    // สร้างคำสั่ง Download
    // --------------------------------------------------------

    const command = new GetObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: storageKey,

      ...(fileName && {
        ResponseContentDisposition:
          `attachment; filename="${encodeURIComponent(fileName)}"`,
      }),
    });

    // --------------------------------------------------------
    // สร้าง Presigned Download URL
    // URL มีอายุ 10 นาที
    // --------------------------------------------------------

    const downloadUrl = await getSignedUrl(
      b2,
      command,
      {
        expiresIn: 600,
      },
    );

    // --------------------------------------------------------
    // ส่ง URL กลับไปให้ Flutter
    // --------------------------------------------------------

    return res.json({
      success: true,
      downloadUrl: downloadUrl,
      storageKey: storageKey,
      fileName: fileName || null,
      expiresIn: 600,
    });

  } catch (error) {
    console.error(
      'B2 Presigned Download URL Error:',
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        'ไม่สามารถสร้าง Presigned Download URL ได้',
      error: error.message,
    });
  }
});

// ============================================================
// BACKBLAZE B2 - DELETE FILE
// ============================================================

app.post('/api/materials/delete', async (req, res) => {
  try {
    const {
      storageKey,
    } = req.body;

    // --------------------------------------------------------
    // ตรวจสอบข้อมูล
    // --------------------------------------------------------

    if (!storageKey) {
      return res.status(400).json({
        success: false,
        message: 'storageKey is required',
      });
    }

    // --------------------------------------------------------
    // ลบไฟล์จาก Backblaze B2
    // --------------------------------------------------------

    const command = new DeleteObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: storageKey,
    });

    await b2.send(command);

    // --------------------------------------------------------
    // สำเร็จ
    // --------------------------------------------------------

    console.log(
      'B2 File Deleted:',
      storageKey
    );

    return res.json({
      success: true,
      message: 'ลบไฟล์จาก Backblaze B2 สำเร็จ',
      storageKey: storageKey,
    });

  } catch (error) {
    console.error(
      'B2 Delete File Error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถลบไฟล์จาก Backblaze B2 ได้',
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

// ============================================================
// MATERIALS - EXTRACT TEXT
// ============================================================

app.post('/api/materials/process', async (req, res) => {
  try {
    const {
      storageKey,
      fileName,
      contentType,
    } = req.body;

    if (!storageKey || !fileName) {
      return res.status(400).json({
        success: false,
        message: 'storageKey และ fileName จำเป็น',
      });
    }

    const buffer = await downloadFileFromB2(storageKey);

    const extracted = await extractTextFromFile(
      buffer,
      fileName,
      contentType
    );

    return res.json({
      success: true,
      fileName,
      fileType: contentType,
      textLength: extracted.text.length,
      extractedText: extracted,
    });

  } catch (error) {
    console.error(
      'Material Process Error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถอ่านเนื้อหาไฟล์ได้',
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

