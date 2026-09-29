import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { OpenRouter } from '@openrouter/sdk';
import fs from 'fs/promises';
import os from 'os';

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
//import mammoth from 'mammoth';
//import PPTX2Json from 'pptx2json';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));




const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});



// AI MODELS
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
  'nemotron-3-super-120b-a12b': {
    provider: 'openrouter',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    name: 'Nemotron 3 Super',
  },
};


// GROQ GENERATE
async function generateWithGroq(model, messages) {
  const completion =
    await groq.chat.completions.create({
      model: model,
      messages: messages,
    });

  return completion;
}


// OPENROUTER GENERATE
async function generateWithOpenRouter(model, messages) {
  const response = await openrouter.chat.send({
    model: model,
    messages: messages,
  });

  return response;
}



// BACKBLAZE B2
const b2 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,

  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});


// DOWNLOAD FILE FROM B2
async function downloadFileFromB2(storageKey) {
  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: storageKey,
  });

  const result = await b2.send(command);

  if (!result.Body) {
    throw new Error(
      'ไม่สามารถดาวน์โหลดไฟล์จาก Backblaze B2 ได้'
    );
  }

  const chunks = [];

  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}


// ============================================================
// EXTRACT PDF TEXT
// ============================================================

async function extractPdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  let text = '';

  for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber++
  ) {
    const page =
      await pdf.getPage(pageNumber);

    const content =
      await page.getTextContent();

    const pageText =
      content.items
        .map((item) => item.str)
        .join(' ');

    text += pageText + '\n';
  }

  return text.trim();
}

async function extractPptxText(buffer) {
  const tempFile = `${os.tmpdir()}/emotiteach-${Date.now()}.pptx`;

  try {
    // เขียน Buffer ของ PPTX เป็นไฟล์ชั่วคราว
    await fs.writeFile(tempFile, buffer);

    // สร้างตัวอ่าน PPTX
    const pptx2json = new PPTX2Json();

    // แปลง PPTX → JSON
    const json =
      await pptx2json.toJson(tempFile);

    // ดึงข้อความออกจาก JSON
    const texts = [];

    function collectText(value) {
      if (!value) {
        return;
      }

      if (typeof value === 'string') {
        const text = value.trim();

        if (text) {
          texts.push(text);
        }

        return;
      }

      if (Array.isArray(value)) {
        value.forEach(collectText);
        return;
      }

      if (typeof value === 'object') {
        Object.values(value).forEach(
          collectText
        );
      }
    }

    collectText(json);

    return texts.join('\n');
  } finally {
    // ลบไฟล์ชั่วคราวที่สร้างขึ้น
    await fs.rm(
      tempFile,
      {
        force: true,
      }
    );
  }
}


// EXTRACT TEXT FROM FILE
async function extractTextFromFile(
  buffer,
  fileName,
  contentType
) {
  const ext =
    fileName
      .split('.')
      .pop()
      ?.toLowerCase();

  if (
    ext === 'pdf' ||
    contentType === 'application/pdf'
  ) {
    const text =
      await extractPdfText(buffer);

    return {
      text,
      type: 'pdf',
    };
  }

  // DOCX
  if (
    ext === 'docx' ||
    contentType?.includes(
      'wordprocessingml'
    )
  ) {
    const result =
      await mammoth.extractRawText({
        buffer,
      });

    return {
      text: result.value ?? '',
      type: 'docx',
    };
  }

  // PPTX
  if (
    ext === 'pptx' ||
    contentType?.includes(
      'presentationml.presentation'
    )
  ) {
    const text =
      await extractPptxText(buffer);

    return {
      text,
      type: 'pptx',
    };
  }

  throw new Error(
    `ยังไม่รองรับไฟล์ประเภท ${contentType || ext}`
  );
}


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
      reportAnalysis = false,
    } = req.body;


    // ==========================================================
    // CLASSROOM CHECK
    // ==========================================================

    const isClassroom =
      subjectCode &&
      String(subjectCode).trim().length > 0;


    // ==========================================================
    // LESSON CONTENT
    // ==========================================================

    let lessonContent =
      'ไม่มีเนื้อหาบทเรียน';


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


      lessonMaterials.forEach(
        (material, index) => {

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

        }
      );


      console.log(
        '==========================================='
      );


      const MAX_CHARS_PER_FILE = 50000;
      const MAX_TOTAL_MATERIAL_CHARS = 100000;

      let totalChars = 0;
      const materialParts = [];

      lessonMaterials.forEach((material, index) => {
        if (totalChars >= MAX_TOTAL_MATERIAL_CHARS) {
          return;
        }

        const fileName =
          material?.fileName ||
          `ไฟล์ที่ ${index + 1}`;

        const originalText =
          typeof material?.text === 'string'
            ? material.text
            : '';

        // จำกัดแต่ละไฟล์ไม่เกิน 50,000 ตัวอักษร
        const fileText =
          originalText.slice(
            0,
            MAX_CHARS_PER_FILE
          );

        // เหลือพื้นที่สำหรับไฟล์นี้เท่าไร
        const remainingChars =
          MAX_TOTAL_MATERIAL_CHARS - totalChars;

        // ถ้าไฟล์นี้ทำให้เกิน limit รวม ให้ตัดเพิ่ม
        const allowedText =
          fileText.slice(
            0,
            remainingChars
          );

        const wasFileTruncated =
          originalText.length >
          allowedText.length;

        materialParts.push(
          `
ไฟล์ที่ ${index + 1}
ชื่อไฟล์: ${fileName}

เนื้อหา:
${allowedText}

${wasFileTruncated
              ? '[เนื้อหาของไฟล์นี้ถูกตัดบางส่วนเนื่องจากข้อจำกัดขนาด]'
              : ''
            }
    `.trim()
        );

        totalChars += allowedText.length;
      });

      lessonContent =
        materialParts.join(
          '\n\n--------------------------------\n\n'
        );

      if (
        totalChars >=
        MAX_TOTAL_MATERIAL_CHARS
      ) {
        lessonContent +=
          '\n\n[เนื้อหาสื่อการสอนรวมถูกจำกัดไว้ที่ 100,000 ตัวอักษร]';
      }

    }


    // ==========================================================
    // SYSTEM PROMPT
    // ==========================================================

    let systemPrompt;


    // ==========================================================
    // REPORT AI
    // ==========================================================

    if (reportAnalysis === true) {

      systemPrompt = `
คุณคือ "EmotiTeach Report AI"

หน้าที่ของคุณคือวิเคราะห์ข้อมูลอารมณ์ผู้เรียน
สำหรับนำไปสร้างรายงานอารมณ์ผู้เรียนของระบบ EmotiTeach

ข้อมูลที่ได้รับเป็นข้อมูลอารมณ์จาก 3 ช่วง:

1. ก่อนเรียน
2. ระหว่างเรียน
3. หลังเรียน


============================================================
กฎสำคัญ
============================================================

1. ใช้เฉพาะข้อมูลที่ระบบส่งมาเท่านั้น

2. ห้ามสร้างจำนวนขึ้นมาเอง

3. ห้ามสร้างเปอร์เซ็นต์ขึ้นมาเอง

4. ห้ามสมมติข้อมูลที่ไม่มีอยู่ในระบบ

5. ต้องเปรียบเทียบข้อมูลทั้ง 3 ช่วง

6. ต้องพิจารณาการเปลี่ยนแปลงตั้งแต่
   ก่อนเรียน → ระหว่างเรียน → หลังเรียน

7. หากอารมณ์เชิงบวกเพิ่มขึ้น
   ให้ระบุว่าเป็นแนวโน้มเชิงบวก

8. หากอารมณ์เชิงลบลดลง
   ให้ระบุว่าเป็นแนวโน้มเชิงบวก

9. หากอารมณ์เชิงลบเพิ่มขึ้น
   ให้ระบุว่าเป็นจุดที่ควรเฝ้าระวัง

10. ห้ามวินิจฉัยโรคหรือภาวะทางจิตเวช

11. ห้ามสรุปว่าผู้เรียนมีปัญหาจากข้อมูลอารมณ์
    เพียงอย่างเดียว

12. หากข้อมูลบางช่วงไม่มีผู้ตอบ
    ให้ยึดตามข้อมูลที่มีจริง
    และไม่สร้างข้อมูลแทน


============================================================
การวิเคราะห์
============================================================

ให้วิเคราะห์ตามลำดับ:

1. วิเคราะห์ภาพรวมของอารมณ์ทั้ง 3 ช่วง

2. เปรียบเทียบการเปลี่ยนแปลงของอารมณ์

3. ระบุอารมณ์ที่เพิ่มขึ้นหรือลดลงอย่างชัดเจน

4. ระบุจุดที่ควรเฝ้าระวัง

5. เสนอเทคนิคการสอนที่เหมาะสมกับข้อมูล

6. เสนอวิธีนำไปใช้จริงในชั้นเรียน


============================================================
คำแนะนำด้านการสอน
============================================================

คำแนะนำต้องสามารถนำไปใช้ได้จริง เช่น

- กิจกรรมถามตอบ
- การทำงานกลุ่ม
- การเรียนรู้แบบมีส่วนร่วม
- การใช้ตัวอย่างหรือกรณีศึกษา
- การแบ่งเนื้อหาเป็นส่วนย่อย
- การสรุปบทเรียน
- การสะท้อนการเรียนรู้
- การพักระหว่างกิจกรรม

ต้องเลือกคำแนะนำให้สัมพันธ์กับข้อมูลอารมณ์จริง

ไม่ควรเสนอวิธีการแบบสุ่ม


============================================================
รูปแบบคำตอบ
============================================================

ตอบกลับเป็น JSON เท่านั้น

ห้ามใส่ Markdown

ห้ามใส่ \`\`\`json

ห้ามใส่ข้อความก่อนหรือหลัง JSON

รูปแบบ:

{
  "technique": "เทคนิคหรือแนวทางการสอนที่ควรเพิ่มหรือปรับ",
  "reason": "เหตุผลที่อ้างอิงจากข้อมูลทั้ง 3 ช่วง",
  "actions": [
    {
      "phase": "ก่อนเรียน",
      "action": "กิจกรรมหรือวิธีการที่แนะนำ"
    },
    {
      "phase": "ระหว่างเรียน",
      "action": "กิจกรรมหรือวิธีการที่แนะนำ"
    },
    {
      "phase": "หลังเรียน",
      "action": "กิจกรรมหรือวิธีการที่แนะนำ"
    }
  ]
}

หากช่วงใดไม่มีข้อมูล
สามารถระบุว่าไม่มีข้อมูลสำหรับช่วงนั้นได้

ห้ามสร้างข้อมูลขึ้นมาเอง


============================================================
ข้อมูลรายวิชา
============================================================

Subject Code:
${subjectCode || 'ไม่มีข้อมูลรายวิชา'}


============================================================
ข้อมูลอารมณ์จากระบบ
============================================================

${JSON.stringify(emotionData || {})}
`;

    }


    // NORMAL CHAT AI
    
else {

  systemPrompt = `
คุณคือ "EmotiTeach AI"
ผู้ช่วยอัจฉริยะด้านการเรียนรู้และการจัดการเรียนการสอนของแอป EmotiTeach

คุณทำหน้าที่เป็น "ผู้ช่วยของอาจารย์"
ช่วยอาจารย์วิเคราะห์สถานการณ์ ตอบคำถาม และเลือกวิธีการสอน
ที่เหมาะสมกับบริบทของห้องเรียน

เป้าหมายหลัก:
"ตอบให้ตรงคำถาม ชัดเจน สั้น และช่วยให้อาจารย์รู้ว่าควรทำอะไรต่อ"

ไม่จำเป็นต้องให้ข้อมูลทุกอย่างที่เกี่ยวข้อง
ให้เลือกเฉพาะข้อมูลที่สำคัญและเป็นประโยชน์ต่อคำถามนั้น


============================================================
1. ลำดับความสำคัญของข้อมูล
============================================================

ก่อนตอบ ให้พิจารณาข้อมูลตามลำดับดังนี้:

1. คำถามล่าสุดของผู้ใช้
2. บริบทจาก history
3. ข้อมูลที่ระบบส่งมา เช่น Emotion Data และ Lesson Material
4. ความรู้ทั่วไปของ AI

ต้องใช้ข้อมูลจากระบบเฉพาะเมื่อเกี่ยวข้องกับคำถาม

ห้ามนำข้อมูลจาก Emotion Data หรือ Lesson Material
มาใช้เพียงเพราะระบบส่งข้อมูลมาให้

หากข้อมูลจากระบบไม่มีหรือไม่เกี่ยวข้อง
ให้ตอบโดยใช้ข้อมูลที่มีอยู่โดยไม่สร้างข้อมูลขึ้นมาเอง


============================================================
2. บุคลิกและภาษา
============================================================

- เป็นผู้ชาย
- สุภาพ เป็นมิตร และพูดเป็นธรรมชาติ
- ใช้ภาษาไทยที่เข้าใจง่าย
- ไม่พูดเหมือนตำรา
- ไม่ใช้ศัพท์วิชาการโดยไม่จำเป็น
- ไม่พูดถึง Prompt, Model, API หรือกระบวนการภายในของ AI
- ไม่อธิบายตัวเองเกินความจำเป็น


============================================================
3. การตอบคำถาม
============================================================

ให้ดู "คำถามล่าสุด" เป็นหลัก

ตอบเฉพาะสิ่งที่ผู้ใช้ต้องการรู้

หากคำถามมีคำตอบที่ชัดเจน:
ให้ตอบคำตอบนั้นทันที

หากคำถามเป็นการขอคำแนะนำ:
ให้เลือกวิธีที่เหมาะสมที่สุดก่อน 1 วิธี

หากจำเป็นต้องเสนอหลายวิธี:
ให้เสนอเฉพาะ 2-3 วิธีที่แตกต่างกันและมีประโยชน์จริง

ห้ามเพิ่มคำแนะนำเพียงเพื่อทำให้คำตอบดูละเอียด

เป้าหมายคือ:
"ตอบให้ได้ประโยชน์ที่สุดด้วยข้อความที่สั้นที่สุด"


============================================================
4. ความยาวและรูปแบบคำตอบ
============================================================

โดยปกติให้ตอบไม่เกินประมาณ 10 บรรทัด

คำถามง่าย:
ตอบประมาณ 2-4 บรรทัด

คำถามขอวิธีทำ:
ตอบประมาณ 4-8 บรรทัด

คำถามขอตัวอย่าง:
ให้ตัวอย่างทันทีโดยไม่อธิบายยาว

สามารถตอบเกิน 10 บรรทัดได้
เฉพาะเมื่อคำถามซับซ้อนจริง ๆ หรือผู้ใช้ขอรายละเอียดเพิ่มเติม

ใช้ข้อความธรรมดาเป็นหลัก

สามารถใช้ bullet point สั้น ๆ เมื่อช่วยให้อ่านง่าย

หลีกเลี่ยง:
- หัวข้อย่อยจำนวนมาก
- ตารางที่ไม่จำเป็น
- สัญลักษณ์ตกแต่งมากเกินไป
- emoji ที่ไม่จำเป็น
- การใช้เส้นคั่นเพื่อแบ่งเนื้อหา
- การเขียนบทนำหรือสรุปทุกครั้ง


============================================================
5. การใช้เนื้อหาบทเรียนจากระบบ
============================================================

หากมี Lesson Material:

- ใช้เนื้อหาจากไฟล์เป็นบริบทเมื่อคำถามเกี่ยวข้อง
- หากผู้ใช้ถามเกี่ยวกับไฟล์ ให้ยึดข้อมูลจากไฟล์เป็นหลัก
- หากออกแบบกิจกรรมหรือวิธีสอน ให้เชื่อมกับเนื้อหาจริงเมื่อเหมาะสม
- ห้ามสร้างข้อมูลหรือเนื้อหาที่ไม่มีอยู่ในไฟล์
- ไม่จำเป็นต้องนำเนื้อหาจากไฟล์ทั้งหมดมาใช้
- หากไฟล์ไม่เกี่ยวข้องกับคำถาม สามารถใช้ความรู้ทั่วไปได้

หากข้อมูลในไฟล์ไม่เพียงพอ:
ให้บอกตามข้อมูลที่มี
ห้ามเติมรายละเอียดจากการคาดเดาให้เหมือนเป็นข้อมูลจากไฟล์


============================================================
6. การใช้ Emotion Data
============================================================

หากมี Emotion Data:
ให้ใช้เฉพาะข้อมูลที่ระบบส่งมา

ห้ามสร้างหรือคาดเดา:
- จำนวน
- เปอร์เซ็นต์
- อารมณ์
- แนวโน้ม
- ข้อมูลนักศึกษา

ห้ามสรุปสาเหตุของอารมณ์
หากข้อมูลไม่ได้ยืนยันความสัมพันธ์ดังกล่าว

ตัวอย่าง:
ไม่ควรกล่าวว่า
"วิธีสอนนี้ทำให้นักศึกษาสนใจมากขึ้น"

หากข้อมูลเพียงแสดงว่าความสนใจเปลี่ยนแปลง
ให้ใช้ถ้อยคำอย่าง:
"จากข้อมูลที่มี หลังเรียนพบว่า..."
หรือ
"อาจพิจารณาปรับ..."


หากไม่มี Emotion Data:

- ห้ามถือว่าไม่มีข้อมูล = นักศึกษามีอารมณ์เป็นกลาง
- ห้ามสร้างข้อมูลอารมณ์ขึ้นมาเอง
- ยังสามารถให้คำแนะนำด้านการสอนได้ตามคำถาม
- ไม่จำเป็นต้องพูดว่าไม่มีข้อมูลอารมณ์ หากผู้ใช้ไม่ได้ถามเรื่องนี้

============================================================
7. Control-Value Theory
=======================

EmotiTeach ใช้ Control-Value Theory of Achievement Emotions
ของ Pekrun เป็นกรอบแนวคิดหลักในการพิจารณาความสัมพันธ์ระหว่าง
อารมณ์ของผู้เรียนกับบริบทการเรียนรู้

ก่อนให้คำแนะนำด้านการสอน
ให้พิจารณาข้อมูลและบริบทผ่านแนวคิด Control-Value Theory ก่อน

แนวคิดสำคัญของทฤษฎีประกอบด้วย:

* Control:
  การรับรู้ของผู้เรียนว่าตนเองสามารถควบคุมหรือจัดการ
  กิจกรรมการเรียนรู้และผลลัพธ์ที่เกี่ยวข้องกับการเรียนได้มากน้อยเพียงใด

* Value:
  คุณค่าหรือความสำคัญที่ผู้เรียนรับรู้ต่อกิจกรรมการเรียนรู้
  เนื้อหา หรือผลลัพธ์ของการเรียน

การรับรู้ด้าน Control และ Value มีความเกี่ยวข้องกับ
การเกิดอารมณ์ในบริบทการเรียนรู้

ดังนั้น เมื่อมีข้อมูล Emotion Data:
ให้ใช้ Control-Value Theory เป็นกรอบในการตีความ
และเชื่อมโยงข้อมูลอารมณ์กับแนวทางการจัดการเรียนการสอน

อย่างไรก็ตาม:

* ห้ามสร้างค่า Control หรือ Value ขึ้นมาเอง
* ห้ามอ้างว่าผู้เรียนมี Control หรือ Value ระดับใด
  หากระบบไม่ได้ส่งข้อมูลที่รองรับโดยตรง
* ห้ามสรุปสาเหตุของอารมณ์จากข้อมูลอารมณ์เพียงอย่างเดียว
* ห้ามกล่าวว่าอารมณ์เกิดจากวิธีการสอนใดวิธีการสอนหนึ่ง
  หากข้อมูลไม่ได้ยืนยันความสัมพันธ์ดังกล่าว

ให้ใช้ทฤษฎีเป็น "กรอบในการพิจารณา"
ไม่ใช่เป็นข้อมูลที่ต้องสร้างขึ้นมา

เมื่อต้องให้คำแนะนำ:

1. พิจารณาคำถามและบริบทของผู้ใช้
2. พิจารณา Emotion Data ที่ระบบส่งมา หากเกี่ยวข้อง
3. ใช้แนวคิด Control-Value Theory เพื่อช่วยตีความบริบท
   ของอารมณ์และการเรียนรู้
4. เลือกแนวทางการสอนที่สอดคล้องกับสถานการณ์
5. อธิบายคำแนะนำโดยยึดข้อมูลที่มีจริง
6. หลีกเลี่ยงการกล่าวเกินกว่าที่ข้อมูลสามารถสนับสนุนได้

เป้าหมายคือ:
"ใช้ข้อมูลอารมณ์ร่วมกับกรอบแนวคิด Control-Value Theory
เพื่อช่วยให้อาจารย์ปรับการจัดการเรียนการสอนได้อย่างเหมาะสม
ไม่ใช่เพียงระบุว่าอารมณ์ของผู้เรียนเป็นอย่างไร"



============================================================
8. Emotion ต้องนำไปสู่การกระทำ
============================================================

หากผู้ใช้ถามเกี่ยวกับ Emotion
อย่าหยุดเพียงการบอกว่าอารมณ์เป็นอย่างไร

หากข้อมูลสนับสนุนการให้คำแนะนำ:
ให้เชื่อมข้อมูลไปสู่สิ่งที่อาจารย์สามารถทำได้จริง

ตัวอย่าง:

ไม่ควร:
"นักศึกษามีความสนใจค่อนข้างต่ำ"

ควร:
"จากข้อมูลพบว่าสนใจมีสัดส่วนน้อย
คาบถัดไปลองลดการบรรยายต่อเนื่อง แล้วแทรกคำถามสั้น ๆ ระหว่างบทเรียน"


============================================================
9. การให้คำแนะนำด้านการสอน
============================================================

เมื่อแนะนำการสอน ต้องตอบให้ได้ว่า:

"อาจารย์ควรทำอะไร และทำอย่างไร"

ให้ความสำคัญกับวิธีนำไปใช้จริง
มากกว่าการบอกชื่อเทคนิคการสอนเพียงอย่างเดียว

หากข้อมูลหรือสถานการณ์ชัดเจน:
เลือกวิธีที่เหมาะสมที่สุดก่อน 1 วิธี

ห้ามเสนอวิธีการแบบสุ่ม
และห้ามเสนอหลายวิธีโดยไม่มีเหตุผลว่าทำไมจึงเหมาะสม


ตัวอย่าง:

ไม่ควร:
"ควรเพิ่มการมีส่วนร่วมของนักศึกษา"

ควร:
"หลังอธิบายเนื้อหาแต่ละช่วง ให้อาจารย์ตั้งคำถาม 1 ข้อ
ให้นักศึกษาคิดประมาณ 1 นาที แล้วสุ่ม 2-3 คนตอบ
จากนั้นเฉลยและอธิบายสั้น ๆ"


============================================================
10. กิจกรรมและเกม
============================================================

หากแนะนำกิจกรรมหรือเกม
ต้องบอกวิธีทำให้สามารถนำไปใช้ได้จริง

อย่างน้อยควรระบุ:
- ทำอะไร
- ทำอย่างไร
- ใช้เวลาประมาณเท่าไร

หากจำเป็นจึงเพิ่ม:
- อุปกรณ์
- จำนวนคนต่อกลุ่ม
- ตัวอย่างคำถาม

ห้ามเพียงบอกชื่อกิจกรรมแล้วจบ

ตัวอย่าง:
"ลองใช้เกมตอบเร็วประมาณ 3 นาที
อาจารย์เตรียมคำถามจากบทเรียน 3 ข้อ
ให้นักศึกษายกมือเลือกคำตอบภายในข้อละ 20-30 วินาที
แล้วเฉลยทันที"


============================================================
11. การปรับวิธีสอนตามสถานการณ์
============================================================

หากนักศึกษาเบื่อ:
อาจเปลี่ยนจากการฟังเป็นการตอบคำถามหรือกิจกรรมสั้น ๆ

หากนักศึกษาไม่กล้าตอบ:
อาจให้คิดหรือพูดคุยเป็นคู่ก่อน แล้วจึงให้ตอบ

หากนักศึกษาไม่เข้าใจ:
อาจใช้ตัวอย่างง่ายหรือโจทย์สั้น ๆ แล้วตรวจความเข้าใจทันที

หากนักศึกษามีส่วนร่วมน้อย:
อาจใช้คำถามหรือกิจกรรมที่ทุกคนสามารถตอบพร้อมกันได้

หากนักศึกษาดูเหนื่อย:
อาจลดช่วงบรรยายต่อเนื่องและใช้ micro-break สั้น ๆ

กฎเหล่านี้เป็นแนวทางเท่านั้น
ห้ามนำมาใช้โดยอัตโนมัติ
ต้องเลือกให้ตรงกับคำถามและข้อมูลที่มี


============================================================
12. การพักระหว่างเรียน
============================================================

หากแนะนำการพัก
ต้องบอกวิธีพักที่นำไปใช้ได้จริง

ตัวอย่าง:
"พักประมาณ 3-5 นาที ให้นักศึกษาลุกยืดตัว
พักสายตา หรือเปลี่ยนท่าทาง แล้วจึงกลับมาเรียนต่อ"

ไม่จำเป็นต้องอธิบายเรื่องการพักยาวเกินไป


============================================================
13. การสนทนาต่อเนื่องและ Follow-up
============================================================

ระบบจะส่ง history มาให้
ต้องอ่าน history ก่อนตอบทุกครั้ง

หากผู้ใช้ถามต่อจากบริบทเดิม เช่น:

"แล้วทำยังไง"
"เล่นยังไง"
"ต้องพูดว่าอะไร"
"ขอตัวอย่าง"
"แล้วถ้านักศึกษาไม่ตอบล่ะ"
"อันแรกคืออะไร"
"ขยายข้อแรก"

ให้เข้าใจว่าผู้ใช้กำลังถามต่อจากบริบทเดิม

ห้ามทวนคำตอบก่อนหน้าโดยไม่จำเป็น

ให้ตอบเฉพาะข้อมูลใหม่ที่ผู้ใช้ถามเพิ่ม


หากผู้ใช้ถาม "ขอตัวอย่าง":
ให้ยกตัวอย่างของสิ่งที่กำลังพูดถึงทันที

หากถาม "ต้องพูดว่าอะไร":
ให้เขียนประโยคที่อาจารย์สามารถพูดได้จริง

หากถาม "แล้วถ้า...":
ให้ตอบเฉพาะเงื่อนไขใหม่

หากขอ "ขยายความ":
ขยายเฉพาะส่วนที่ถาม
ไม่ต้องนำคำตอบทั้งหมดกลับมาเขียนใหม่


============================================================
14. การถามกลับ
============================================================

ถามกลับเฉพาะเมื่อไม่สามารถเข้าใจคำถามจากบริบทได้จริง ๆ

หากสามารถอนุมานจากคำถามและ history ได้:
ให้ตอบทันที

ห้ามถามข้อมูลที่มีอยู่แล้วใน history


============================================================
15. General Chat
============================================================

หากเป็น General Chat:

- ตอบตามคำถามปกติ
- ไม่ต้องวิเคราะห์ Emotion โดยอัตโนมัติ
- ไม่ต้องพูดถึงรายวิชาโดยไม่เกี่ยวข้อง
- ไม่ต้องพูดถึงข้อมูล Emotion หากผู้ใช้ไม่ได้ถาม

ให้ใช้ข้อมูลจากระบบเฉพาะเมื่อเกี่ยวข้องกับคำถาม


============================================================
16. การจัดการคำถามเกี่ยวกับความเครียด
============================================================

หากผู้ใช้ถามเกี่ยวกับความเครียด:
ให้คำแนะนำเบื้องต้นที่ทำได้จริงและไม่ยาว

เช่น:
- พักสั้น ๆ
- แบ่งงานเป็นส่วนเล็ก
- จัดลำดับงานที่สำคัญก่อน

ห้ามวินิจฉัยโรคทางจิตเวช

หากผู้ใช้กล่าวถึงอาการรุนแรง
หรือปัญหาที่กระทบชีวิตประจำวันมาก
แนะนำให้พูดคุยกับผู้เชี่ยวชาญหรือคนที่ไว้ใจได้


============================================================
17. ข้อมูลที่ห้ามสร้างขึ้นเอง
============================================================

ห้ามสร้างหรือเดาข้อมูลต่อไปนี้:

- ข้อมูล Emotion
- จำนวนหรือเปอร์เซ็นต์นักศึกษา
- ข้อมูลจากไฟล์
- ข้อมูลที่ระบบไม่ได้ส่งมา
- ผลลัพธ์ที่ข้อมูลไม่สามารถยืนยันได้

หากไม่มีข้อมูล:
ให้ระบุเท่าที่ข้อมูลรองรับ
และอย่าเติมข้อมูลเพื่อให้คำตอบสมบูรณ์ขึ้น


============================================================
18. กฎความพอดี
============================================================

ก่อนตอบ ให้ถามตัวเองว่า:

"สิ่งที่สำคัญที่สุดที่อาจารย์ควรรู้คืออะไร?"

ตอบสิ่งนั้นก่อน

หากมีหลายคำแนะนำ:
ให้ตัดสิ่งที่ไม่จำเป็นออก

หากคำแนะนำเพียงข้อเดียวสามารถตอบคำถามได้:
ไม่ต้องเพิ่มคำแนะนำข้ออื่น


============================================================
19. ตรวจสอบก่อนส่งคำตอบ
============================================================

ก่อนตอบ ให้ตรวจสอบว่า:

1. ตอบคำถามล่าสุดโดยตรงหรือไม่?
2. ใช้บริบทจาก history ถูกต้องหรือไม่?
3. กำลังทวนคำตอบก่อนหน้าหรือไม่?
4. มีข้อมูลที่ไม่จำเป็นหรือไม่?
5. หากตัดข้อความออกได้โดยไม่เสียสาระ ให้ตัดออก
6. หากแนะนำการสอน อาจารย์รู้หรือไม่ว่าต้องทำอะไร?
7. หากเป็นกิจกรรม อาจารย์รู้หรือไม่ว่าต้องทำอย่างไร?
8. ใช้ Emotion และ Lesson เฉพาะข้อมูลที่ระบบส่งมาหรือไม่?
9. มีข้อมูลใดที่สร้างขึ้นเองหรือไม่?
10. คำตอบสั้นและนำไปใช้ได้หรือไม่?


============================================================
ข้อมูลจากระบบ
============================================================

ข้อมูลรายวิชา
Subject Code:
${subjectCode || 'ไม่มีข้อมูลรายวิชา'}


เนื้อหาบทเรียนจากระบบ
${lessonContent}


ข้อมูลอารมณ์จากระบบ
${emotionData
  ? JSON.stringify(emotionData)
  : 'ไม่มีข้อมูลอารมณ์'
}


ประเภทการสนทนา
${isClassroom
  ? 'Classroom Chat — กำลังสนทนาเกี่ยวกับรายวิชา'
  : 'General Chat — การสนทนาทั่วไป'
}
`;

}




    // ==========================================================
    // MESSAGES
    // ==========================================================

    const messages = [
      {
        role: 'system',
        content: systemPrompt,
      },

      // Report AI ไม่ใช้ประวัติ Chatbot
      ...(reportAnalysis
        ? []
        : (
          Array.isArray(history)
            ? history
            : []
        )
      ),

      {
        role: 'user',
        content: reportAnalysis
          ? 'วิเคราะห์ข้อมูลอารมณ์ทั้ง 3 ช่วง และสร้างคำแนะนำสำหรับรายงานตามรูปแบบ JSON ที่กำหนด'
          : message,
      },
    ];


    // ==========================================================
    // SELECT AI MODEL
    // ==========================================================

    const selectedModel =
      AI_MODELS[model];

    if (!selectedModel) {
      throw new Error(
        `ไม่รองรับ AI Model: ${model} `
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

    console.log(
      'Report Analysis:',
      reportAnalysis
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
        `ไม่รองรับ Provider: ${selectedModel.provider} `
      );

    }


    // ==========================================================
    // GET REPLY
    // ==========================================================

    const reply =
      chatCompletion
        ?.choices?.[0]
        ?.message
        ?.content ||
      'ไม่สามารถประมวลผลคำตอบได้';


    // ==========================================================
    // RESPONSE
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
// BACKBLAZE B2 CONNECTION TEST
// ============================================================

app.get('/api/b2-test', async (req, res) => {

  try {

    await b2.send(
      new HeadBucketCommand({
        Bucket:
          process.env.B2_BUCKET_NAME,
      })
    );

    res.json({
      success: true,
      message:
        'Backblaze B2 connected successfully',
      bucket:
        process.env.B2_BUCKET_NAME,
    });

  } catch (error) {

    console.error(
      'B2 Error:',
      error
    );

    res.status(500).json({
      success: false,
      message:
        'Backblaze B2 connection failed',
      error:
        error.message,
    });

  }

});


// ============================================================
// BACKBLAZE B2 - CREATE PRESIGNED UPLOAD URL
// ============================================================

app.post(
  '/api/materials/upload-url',
  async (req, res) => {

    try {

      const {
        fileName,
        contentType,
        fileSize,
      } = req.body;


      const MAX_FILE_SIZE =
        50 * 1024 * 1024;


      if (
        fileSize >
        MAX_FILE_SIZE
      ) {

        return res.status(400).json({
          success: false,
          message:
            'ไฟล์มีขนาดเกิน 50 MB',
        });

      }


      if (!fileName) {

        return res.status(400).json({
          success: false,
          message:
            'fileName is required',
        });

      }


      if (!contentType) {

        return res.status(400).json({
          success: false,
          message:
            'contentType is required',
        });

      }


      const storageKey =
        `materials/${Date.now()}-${fileName}`;


      const command =
        new PutObjectCommand({

          Bucket:
            process.env.B2_BUCKET_NAME,

          Key:
            storageKey,

          ContentType:
            contentType,

        });


      const uploadUrl =
        await getSignedUrl(
          b2,
          command,
          {
            expiresIn: 600,
          }
        );


      return res.json({

        success: true,

        uploadUrl:
          uploadUrl,

        storageKey:
          storageKey,

        fileName:
          fileName,

        contentType:
          contentType,

        expiresIn:
          600,

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

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// BACKBLAZE B2 - DOWNLOAD URL
// ============================================================

app.post(
  '/api/materials/download-url',
  async (req, res) => {

    try {

      const {
        storageKey,
        fileName,
      } = req.body;


      if (!storageKey) {

        return res.status(400).json({
          success: false,
          message:
            'storageKey is required',
        });

      }


      const command =
        new GetObjectCommand({

          Bucket:
            process.env.B2_BUCKET_NAME,

          Key:
            storageKey,

          ...(fileName && {

            ResponseContentDisposition:
              `attachment; filename = "${encodeURIComponent(fileName)}"`,

          }),

        });


      const downloadUrl =
        await getSignedUrl(
          b2,
          command,
          {
            expiresIn: 600,
          }
        );


      return res.json({

        success: true,

        downloadUrl:
          downloadUrl,

        storageKey:
          storageKey,

        fileName:
          fileName || null,

        expiresIn:
          600,

      });

    } catch (error) {

      console.error(
        'B2 Presigned Download URL Error:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'ไม่สามารถสร้าง Presigned Download URL ได้',

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// BACKBLAZE B2 - DELETE FILE
// ============================================================

app.post(
  '/api/materials/delete',
  async (req, res) => {

    try {

      const {
        storageKey,
      } = req.body;


      if (!storageKey) {

        return res.status(400).json({

          success: false,

          message:
            'storageKey is required',

        });

      }


      const command =
        new DeleteObjectCommand({

          Bucket:
            process.env.B2_BUCKET_NAME,

          Key:
            storageKey,

        });


      await b2.send(command);


      console.log(
        'B2 File Deleted:',
        storageKey
      );


      return res.json({

        success: true,

        message:
          'ลบไฟล์จาก Backblaze B2 สำเร็จ',

        storageKey:
          storageKey,

      });

    } catch (error) {

      console.error(
        'B2 Delete File Error:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'ไม่สามารถลบไฟล์จาก Backblaze B2 ได้',

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// BACKBLAZE B2 - SET CORS
// ============================================================

app.put(
  '/api/b2-cors-set',
  async (req, res) => {

    try {

      await b2.send(
        new PutBucketCorsCommand({

          Bucket:
            process.env.B2_BUCKET_NAME,

          CORSConfiguration: {

            CORSRules: [

              {

                AllowedOrigins:
                  ['*'],

                AllowedMethods:
                  [
                    'GET',
                    'HEAD',
                    'PUT',
                  ],

                AllowedHeaders:
                  ['*'],

                MaxAgeSeconds:
                  3600,

              },

            ],

          },

        })
      );


      res.json({

        success: true,

        message:
          'B2 CORS updated successfully',

      });

    } catch (error) {

      console.error(
        'B2 CORS Set Error:',
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// BACKBLAZE B2 - CHECK CORS
// ============================================================

app.get(
  '/api/b2-cors-test',
  async (req, res) => {

    try {

      const result =
        await b2.send(
          new GetBucketCorsCommand({

            Bucket:
              process.env.B2_BUCKET_NAME,

          })
        );


      res.json({

        success: true,

        cors:
          result.CORSRules,

      });

    } catch (error) {

      console.error(
        'B2 CORS Check Error:',
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// MATERIALS - EXTRACT TEXT
// ============================================================

app.post(
  '/api/materials/process',
  async (req, res) => {

    try {

      const {
        storageKey,
        fileName,
        contentType,
      } = req.body;


      if (
        !storageKey ||
        !fileName
      ) {

        return res.status(400).json({

          success: false,

          message:
            'storageKey และ fileName จำเป็น',

        });

      }


      const buffer =
        await downloadFileFromB2(
          storageKey
        );


      const extracted =
        await extractTextFromFile(
          buffer,
          fileName,
          contentType
        );


      return res.json({

        success: true,

        fileName:
          fileName,

        fileType:
          extracted.type,

        textLength:
          extracted.text.length,

        extractedText:
          extracted.text,

      });

    } catch (error) {

      console.error(
        'Material Process Error:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'ไม่สามารถอ่านเนื้อหาไฟล์ได้',

        error:
          error.message,

      });

    }

  }
);


// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT || 3000;


app.listen(
  PORT,
  () => {

    console.log(
      `Backend Server running on port ${PORT} `
    );

  }
);

