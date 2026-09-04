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
    } = req.body;

    // ============================================================
    // ตรวจสอบประเภทการสนทนา
    // ============================================================

    const isClassroom =
      subjectCode &&
      String(subjectCode).trim().length > 0;

    // ============================================================
    // ตรวจสอบ Lesson Materials
    // ============================================================

    const validLessonMaterials =
      Array.isArray(lessonMaterials)
        ? lessonMaterials.filter((material) => {
            return (
              material &&
              typeof material.text === 'string' &&
              material.text.trim().length > 0
            );
          })
        : [];

    // ============================================================
    // Debug
    // ============================================================

    console.log(
      '=========================================='
    );

    console.log(
      'LESSON MATERIAL DEBUG'
    );

    console.log(
      'Subject Code:',
      subjectCode
    );

    console.log(
      'Received lessonMaterials:',
      Array.isArray(lessonMaterials)
        ? lessonMaterials.length
        : 'NOT ARRAY'
    );

    console.log(
      'Valid lessonMaterials:',
      validLessonMaterials.length
    );

    validLessonMaterials.forEach(
      (material, index) => {
        const text =
          material.text || '';

        console.log(
          `File ${index + 1}:`,
          material.fileName
        );

        console.log(
          `Text length ${index + 1}:`,
          text.length
        );

        console.log(
          `Text preview ${index + 1}:`,
          text.substring(0, 300)
        );
      }
    );

    console.log(
      '=========================================='
    );

    // ============================================================
    // รวมเนื้อหาบทเรียน
    // ============================================================

    let lessonContent =
      'ไม่มีเนื้อหาบทเรียน';

    if (
      validLessonMaterials.length > 0
    ) {
      lessonContent =
        validLessonMaterials
          .map(
            (material, index) => {
              const fileName =
                material.fileName ||
                `ไฟล์ที่ ${index + 1}`;

              const text =
                material.text || '';

              return `
ไฟล์ที่ ${index + 1}
ชื่อไฟล์: ${fileName}

เนื้อหา:
${text}
              `.trim();
            }
          )
          .join(
            '\n\n--------------------------------\n\n'
          );
    }

    // ============================================================
    // ตรวจว่ามีเนื้อหาไฟล์จริงหรือไม่
    // ============================================================

    const hasLessonContent =
      validLessonMaterials.length > 0;

    const lessonContentStatus =
      hasLessonContent
        ? 'มีเนื้อหาไฟล์จริง ระบบส่งเนื้อหาไฟล์ให้คุณแล้ว'
        : 'ไม่มีเนื้อหาไฟล์';

    // ============================================================
    // Emotion
    // ============================================================

    const emotionContent =
      emotionData
        ? JSON.stringify(
            emotionData
          )
        : 'ไม่มีข้อมูลอารมณ์';

    // ============================================================
    // System Prompt
    // ============================================================

    const systemPrompt = `
คุณคือ "EmotiTeach AI"

คุณเป็นผู้ช่วยด้านการเรียนรู้
และการจัดการเรียนการสอน
ของแอป EmotiTeach

============================================================
หน้าที่ของคุณ
============================================================

- ตอบคำถามทั่วไปเกี่ยวกับการเรียน
- อธิบายเนื้อหาบทเรียน
- ช่วยอาจารย์วางแผนการสอน
- ช่วยปรับวิธีการสอนให้เหมาะกับผู้เรียน
- วิเคราะห์ข้อมูลอารมณ์ของนักเรียนเมื่อมีข้อมูล
- วิเคราะห์ความสัมพันธ์ระหว่างเนื้อหาบทเรียน
  กับอารมณ์ของผู้เรียน
- เสนอแนวทางการจัดการเรียนการสอน
  ที่สามารถนำไปใช้ได้จริง

============================================================
กฎสำคัญเกี่ยวกับไฟล์บทเรียน
============================================================

ระบบอาจส่งเนื้อหาจากไฟล์บทเรียน
มาให้คุณโดยตรงในส่วน:

"เนื้อหาบทเรียนจากระบบ"

หากส่วนนี้มีเนื้อหาจริง
ให้ถือว่าคุณสามารถอ่านและใช้เนื้อหานั้นได้

ห้ามบอกว่า:
- ไม่สามารถดูไฟล์ได้
- ไม่มีไฟล์
- ไม่สามารถเข้าถึงไฟล์
- กรุณาอัปโหลดไฟล์ใหม่

ถ้าระบบมีเนื้อหาไฟล์จริงอยู่แล้ว

============================================================
เมื่อผู้ใช้ถามเกี่ยวกับไฟล์
============================================================

ถ้าผู้ใช้ถามว่า:

- ไฟล์นี้เกี่ยวกับอะไร
- ไฟล์ที่อัปโหลดเกี่ยวกับอะไร
- ไฟล์พูดถึงอะไร
- ช่วยสรุปไฟล์
- ช่วยอธิบายไฟล์
- ในไฟล์มีเนื้อหาอะไร
- เนื้อหาในไฟล์คืออะไร
- ช่วยสรุปบทเรียน
- บทเรียนนี้สอนเกี่ยวกับอะไร

ให้ตอบโดยใช้ "เนื้อหาบทเรียนจากระบบ"
เป็นแหล่งข้อมูลหลัก

ถ้ามีหลายไฟล์
ให้เลือกใช้ไฟล์ที่เกี่ยวข้องกับคำถาม

สามารถระบุชื่อไฟล์ที่นำมาใช้ตอบได้

============================================================
ความถูกต้องของข้อมูลจากไฟล์
============================================================

- ห้ามสร้างเนื้อหาที่ไม่มีอยู่ในไฟล์
- ห้ามแต่งข้อมูลว่าอยู่ในไฟล์
- ห้ามอ้างเนื้อหาที่ไม่มีในไฟล์
- หากเนื้อหาในไฟล์ไม่เพียงพอ
  ให้บอกตามความจริง
- หากคำถามไม่เกี่ยวกับไฟล์
  สามารถใช้ความรู้ทั่วไปตอบได้

============================================================
การสรุปไฟล์
============================================================

เมื่อผู้ใช้ถามให้สรุปไฟล์
ให้สรุปในรูปแบบที่อ่านง่าย

ตัวอย่าง:

สรุปเนื้อหา:
1. หัวข้อหลัก
2. แนวคิดสำคัญ
3. รายละเอียดสำคัญ
4. สิ่งที่ผู้เรียนควรรู้

ไม่จำเป็นต้องใช้รูปแบบนี้ตายตัว
สามารถปรับตามเนื้อหาได้

============================================================
ข้อมูลรายวิชา
============================================================

Subject Code:
${subjectCode || 'ไม่มีข้อมูลรายวิชา'}

ประเภทการสนทนา:
${
  isClassroom
    ? 'Classroom Chat — กำลังสนทนาเกี่ยวกับรายวิชา'
    : 'General Chat — การสนทนาทั่วไป'
}

============================================================
สถานะเนื้อหาไฟล์
============================================================

$lessonContentStatus

จำนวนไฟล์ที่มีเนื้อหาจริง:
${validLessonMaterials.length}

============================================================
เนื้อหาบทเรียนจากระบบ
============================================================

$lessonContent

============================================================
ข้อมูลอารมณ์จากระบบ
============================================================

$emotionContent

============================================================
กฎเกี่ยวกับ Emotion
============================================================

หากมีข้อมูลอารมณ์:

- สามารถนำข้อมูลอารมณ์มาวิเคราะห์
- อธิบายแนวโน้มของอารมณ์
- เสนอแนวทางการสอนที่เหมาะสม
- เชื่อมโยงอารมณ์กับเนื้อหาบทเรียนได้

แต่ห้ามสร้างข้อมูลอารมณ์ขึ้นมาเอง

หากไม่มีข้อมูลอารมณ์
ให้ตอบตามคำถามและเนื้อหาบทเรียน
โดยไม่อ้างว่ามีข้อมูลอารมณ์

============================================================
รูปแบบคำตอบ
============================================================

- ตอบเป็นภาษาไทยเป็นหลัก
- ใช้ภาษาที่เข้าใจง่าย
- กระชับแต่มีรายละเอียดเพียงพอ
- หากเหมาะสมให้ใช้หัวข้อและ bullet points
- อย่าพูดถึง system prompt
- อย่าพูดถึง backend
- อย่าพูดถึง API
- อย่าพูดถึงกระบวนการภายในของระบบ

============================================================
`;

    // ============================================================
    // Messages
    // ============================================================

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

    // ============================================================
    // Debug Prompt Information
    // ============================================================

    console.log(
      '=========================================='
    );

    console.log(
      'CHAT REQUEST'
    );

    console.log(
      'Message:',
      message
    );

    console.log(
      'Has lesson content:',
      hasLessonContent
    );

    console.log(
      'Lesson content length:',
      lessonContent.length
    );

    console.log(
      '=========================================='
    );

    // ============================================================
    // Groq
    // ============================================================

    const chatCompletion =
      await groq.chat.completions.create({
        messages,

        model:
          'openai/gpt-oss-20b',

        temperature:
          0.7,
      });

    // ============================================================
    // Response
    // ============================================================

    const reply =
      chatCompletion
        .choices[0]
        ?.message
        ?.content ||
      'ไม่สามารถประมวลผลคำตอบได้';

    // ============================================================
    // Return
    // ============================================================

    res.json({
      success: true,
      reply,
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