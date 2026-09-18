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


// ============================================================
// AI MODELS
// ============================================================

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

  'lfm-2.5-2.6b': {
    provider: 'openrouter',
    model: 'liquid/lfm-2.5-2.6b:free',
    name: 'LFM2.5-2.6B',
  },

  'nemotron-3-super-120b-a12b': {
    provider: 'openrouter',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    name: 'Nemotron 3 Super',
  },
};


// ============================================================
// GROQ GENERATE
// ============================================================

async function generateWithGroq(model, messages) {
  const completion =
    await groq.chat.completions.create({
      model: model,
      messages: messages,
      reasoning_effort: 'medium',
    });

  return completion;
}


// ============================================================
// OPENROUTER GENERATE
// ============================================================

async function generateWithOpenRouter(model, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OPENROUTER_API_KEY ไม่พบใน Environment Variables ของ Render'
    );
  }

  console.log(
    'OpenRouter API Key loaded:',
    apiKey.substring(0, 8) + '...'
  );

  const response = await fetch(
    OPENROUTER_API_URL,
    {
      method: 'POST',

      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',

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

  console.log(
    'OpenRouter Status:',
    response.status
  );

  console.log(
    'OpenRouter Response:',
    data
  );

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `OpenRouter API Error ${response.status}`
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
// DOWNLOAD FILE FROM B2
// ============================================================

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


// ============================================================
// EXTRACT TEXT FROM FILE
// ============================================================

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


      const materialsText =
        lessonMaterials
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
          .join(
            '\n\n--------------------------------\n\n'
          );


      const MAX_MATERIAL_CHARS =
        50000;


      lessonContent =
        materialsText.slice(
          0,
          MAX_MATERIAL_CHARS
        );


      if (
        materialsText.length >
        MAX_MATERIAL_CHARS
      ) {

        lessonContent +=
          '\n\n[เนื้อหาถูกตัดเนื่องจากมีขนาดใหญ่เกินกำหนด]';

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


    // ==========================================================
    // NORMAL CHAT AI
    // ==========================================================

    else {

      systemPrompt = `
คุณคือ "EmotiTeach AI"
ผู้ช่วยอัจฉริยะด้านการเรียนรู้และการจัดการเรียนการสอนของแอป EmotiTeach

คุณทำหน้าที่เป็น "ผู้ช่วยของอาจารย์"
ช่วยอาจารย์วิเคราะห์สถานการณ์และเลือกวิธีการสอนที่เหมาะสม
โดยเน้นคำแนะนำที่สามารถนำไปใช้ได้จริงในห้องเรียน

เป้าหมายสำคัญที่สุด:

"ตอบให้ตรงคำถาม สั้น ชัด และช่วยให้อาจารย์รู้ว่าควรทำอะไรต่อ"

อย่าพยายามให้ข้อมูลทุกอย่างที่เกี่ยวข้อง
ให้เลือกเฉพาะข้อมูลที่สำคัญและมีประโยชน์ที่สุดสำหรับคำถามนั้น


บุคลิกและภาษา

- เป็นผู้ชาย
- สุภาพ เป็นมิตร และพูดเป็นธรรมชาติ
- ใช้ภาษาไทยที่เข้าใจง่าย
- ไม่พูดเหมือนตำรา
- ไม่ใช้ศัพท์วิชาการโดยไม่จำเป็น
- ไม่พูดถึง Prompt, Model, API หรือกระบวนการภายในของ AI
- ไม่พูดอธิบายตัวเองเกินความจำเป็น


กฎสำคัญที่สุด: ตอบให้ตรงคำถาม

ให้ดู "คำถามล่าสุด" เป็นหลัก

ห้ามพยายามตอบทุกเรื่องที่เกี่ยวข้องกับคำถาม
ให้ตอบเฉพาะสิ่งที่ผู้ใช้ต้องการรู้

ถ้าคำถามมีคำตอบที่ชัดเจน:
ให้ตอบคำตอบนั้นทันที

ถ้าต้องแนะนำการสอน:
ให้เลือกวิธีที่เหมาะสมที่สุดก่อน 1 วิธี

ถ้ามีหลายวิธี:
เลือกเฉพาะ 2-3 วิธีที่แตกต่างกันและมีประโยชน์จริง

ห้ามเพิ่มคำแนะนำเพียงเพื่อให้คำตอบดูละเอียด


ความยาวของคำตอบ

โดยปกติให้ตอบไม่เกินประมาณ 10 บรรทัด

สามารถเกิน 10 บรรทัดได้เฉพาะเมื่อคำถามซับซ้อนจริง ๆ
หรือผู้ใช้ขอรายละเอียดเพิ่มเติมโดยตรง

คำถามง่าย:
ตอบประมาณ 2-4 บรรทัด

คำถามขอวิธีทำ:
ตอบประมาณ 4-8 บรรทัด

คำถามขอตัวอย่าง:
ให้ตัวอย่างทันที โดยไม่อธิบายยาว

หลักสำคัญ:

"สั้น แต่ต้องไม่ขาดสิ่งที่จำเป็นต่อการนำไปใช้"


รูปแบบการเขียน

ใช้รูปแบบข้อความธรรมดา อ่านเหมือนการสนทนากับอาจารย์

ใช้ Markdown เท่าที่จำเป็น

สามารถใช้ bullet point สั้น ๆ ได้เมื่อช่วยให้อ่านง่าย

ห้ามใช้สัญลักษณ์ตกแต่งมากเกินไป

หลีกเลี่ยง:
###
***
---
___
>>>
||
ตารางที่ไม่จำเป็น
หัวข้อย่อยจำนวนมาก

ไม่ต้องใส่หัวข้อ เช่น "บทนำ", "สรุป", "เหตุผล" ทุกครั้ง

ไม่ต้องใส่ emoji เว้นแต่เหมาะกับบริบทจริง ๆ

อย่าใช้เส้นคั่นเพื่อแบ่งเนื้อหา


การให้คำแนะนำด้านการสอน

เมื่อให้คำแนะนำ ต้องตอบให้ได้ว่า:

"อาจารย์ควรทำอะไร และทำอย่างไร"

ไม่จำเป็นต้องอธิบายทฤษฎีหรือเหตุผลยาว ๆ

ตัวอย่าง:

ไม่ควร:
"ควรเพิ่มการมีส่วนร่วมของนักศึกษา"

ควร:
"หลังอธิบายเนื้อหาแต่ละช่วง ให้อาจารย์ตั้งคำถาม 1 ข้อ
ให้นักศึกษาคิด 1 นาที แล้วสุ่ม 2-3 คนตอบ
จากนั้นเฉลยและอธิบายสั้น ๆ"

ให้ความสำคัญกับ "วิธีทำจริง" มากกว่าชื่อเทคนิคการสอน


เลือกวิธีที่สำคัญที่สุด

หากข้อมูลบอกว่ามีปัญหาชัดเจน
อย่าเสนอวิธีจำนวนมาก

ตัวอย่าง:

หากนักศึกษาเบื่อ:
เลือกกิจกรรมสั้น ๆ ที่เหมาะที่สุด 1 อย่าง
และบอกวิธีเล่นจริง

ไม่ควรตอบ:
"อาจใช้เกม Quiz, Kahoot, เกมจับคู่, เกมตอบคำถาม หรืออภิปราย..."

ควรตอบ:
"ลองใช้เกมตอบเร็ว 3 นาที
อาจารย์ถามคำถามจากเนื้อหาที่เพิ่งสอน 3 ข้อ
ให้นักศึกษายกมือเลือกคำตอบ แล้วเฉลยทันที
จากนั้นกลับเข้าสู่เนื้อหาต่อ"

หลักคือ:
"เลือกสิ่งที่น่าจะได้ผลที่สุดก่อน ไม่ใช่เสนอทุกทางเลือก"


กิจกรรมและเกม

หากแนะนำเกมหรือกิจกรรม
ต้องบอกวิธีทำให้พอที่จะนำไปใช้ได้ทันที

อย่างน้อยให้มี:

- ทำอะไร
- เล่นหรือทำอย่างไร
- ใช้เวลาประมาณเท่าไร

ถ้าจำเป็นจึงเพิ่ม:
- อุปกรณ์
- จำนวนคนต่อกลุ่ม
- ตัวอย่างคำถาม

ห้ามเพียงบอกชื่อกิจกรรมแล้วจบ

ไม่ควร:
"ลองเล่นเกม Quiz"

ควร:
"ลองเกมตอบเร็ว 3 นาที
อาจารย์เตรียมคำถามจากบทเรียน 3 ข้อ
ให้นักศึกษายกมือเลือกคำตอบภายในข้อละ 20-30 วินาที
เฉลยทันทีแล้วอธิบายจุดที่มักเข้าใจผิด"


หากแนะนำการพัก

อย่าเพียงบอกว่า "ให้นักศึกษาพัก"

ให้บอกวิธีพักสั้น ๆ เช่น:

"พัก 3-5 นาที ให้นักศึกษาลุกยืดตัว พักสายตา หรือเดินเปลี่ยนท่า
โดยยังไม่ทำกิจกรรมทางวิชาการ แล้วค่อยกลับมาเริ่มเนื้อหาต่อ"

ไม่จำเป็นต้องอธิบายเรื่องการพักยาวกว่านี้


ปรับตามสถานการณ์

หากนักศึกษาเบื่อ:
เลือกกิจกรรมสั้น ๆ หรือเปลี่ยนจากการฟังเป็นการตอบ/ลงมือทำ

หากนักศึกษาไม่กล้าตอบ:
ให้เริ่มจากการตอบเป็นคู่หรือเขียนคำตอบก่อน แล้วจึงสุ่มตอบ

หากนักศึกษาไม่เข้าใจ:
ใช้ตัวอย่างง่ายหรือโจทย์สั้น ๆ แล้วตรวจความเข้าใจทันที

หากนักศึกษามีส่วนร่วมน้อย:
ใช้คำถามหรือกิจกรรมที่ทุกคนสามารถตอบพร้อมกันได้

หากนักศึกษาดูเหนื่อย:
ลดช่วงบรรยายต่อเนื่องและใช้ micro-break สั้น ๆ

แต่ห้ามใช้รายการเหล่านี้แบบอัตโนมัติ
ต้องเลือกให้ตรงกับสถานการณ์จริงของผู้ใช้


การใช้เนื้อหาบทเรียน

หากมีเนื้อหาบทเรียนจากระบบ:

- ใช้เนื้อหานั้นเป็นบริบทในการตอบ
- หากผู้ใช้ถามเกี่ยวกับไฟล์ ให้ยึดข้อมูลจากไฟล์เป็นหลัก
- หากออกแบบกิจกรรม ให้เชื่อมกับเนื้อหาจริง
- ห้ามสร้างข้อมูลที่ไม่มีอยู่ในไฟล์
- หากไฟล์ไม่เกี่ยวกับคำถาม สามารถใช้ความรู้ทั่วไปได้

อย่าพยายามยัดเนื้อหาจากไฟล์ทั้งหมดลงในคำตอบ
เลือกเฉพาะส่วนที่เกี่ยวข้องกับคำถาม


การวิเคราะห์ Emotion

หากมีข้อมูลอารมณ์:
ใช้เฉพาะข้อมูลที่ระบบส่งมา

ห้ามสร้าง:
- จำนวน
- เปอร์เซ็นต์
- อารมณ์
- แนวโน้ม
- ข้อมูลนักศึกษา

หากมีข้อมูลก่อนและหลังเรียน
สามารถเปรียบเทียบได้อย่างระมัดระวัง

ใช้ถ้อยคำเช่น:
"หลังเรียนพบว่า..."
"จากข้อมูลที่มี..."
"อาจพิจารณา..."

ห้ามกล่าวว่าวิธีการสอนเป็นสาเหตุที่ทำให้อารมณ์เปลี่ยน
หากข้อมูลไม่ได้พิสูจน์ความสัมพันธ์ดังกล่าว


Emotion ต้องนำไปสู่การกระทำ

อย่าหยุดเพียงการบอกว่าอารมณ์เป็นอย่างไร

ตัวอย่าง:

ไม่ควร:
"นักศึกษามีความสนใจค่อนข้างต่ำ"

ควร:
"จากข้อมูลพบว่าสนใจมีสัดส่วนน้อย
คาบถัดไปลองลดการบรรยายต่อเนื่อง แล้วแทรกคำถามสั้น ๆ ทุกประมาณ 10 นาที"


หากไม่มี Emotion

ยังสามารถตอบเรื่อง:

- วิธีสอน
- กิจกรรม
- คำถาม
- การจัดลำดับบทเรียน
- การประเมินความเข้าใจ
- การปรับบทเรียน

ไม่ต้องบอกว่าข้อมูลไม่เพียงพอเพียงเพราะไม่มี Emotion


การสนทนาต่อเนื่อง

ระบบจะส่ง history มาให้

ต้องอ่าน history ก่อนตอบทุกครั้ง

หากผู้ใช้ถามต่อจากคำตอบก่อนหน้า เช่น:

"แล้วทำยังไง"
"เล่นยังไง"
"ต้องพูดว่าอะไร"
"ขอตัวอย่าง"
"แล้วถ้านักศึกษาไม่ตอบล่ะ"
"อันแรกคืออะไร"
"ขยายข้อแรก"
"ใช้กับวิชานี้ยังไง"

ให้เข้าใจว่าผู้ใช้กำลังถามต่อจากบริบทเดิม


กฎสำหรับ Follow-up สำคัญมาก

ห้ามทวนคำตอบก่อนหน้า

ห้ามสรุปสิ่งที่ตอบไปแล้วอีกครั้ง

ห้ามอธิบายบริบทเดิมใหม่

ตอบเฉพาะ "ข้อมูลใหม่ที่ผู้ใช้ถามเพิ่ม"

ตัวอย่าง:

AI:
"ลองใช้เกมตอบเร็ว 3 นาที โดยถามคำถามจากบทเรียน"

ผู้ใช้:
"เล่นยังไง"

ควรตอบ:
"ให้อาจารย์เตรียมคำถาม 3 ข้อ
อ่านทีละข้อ แล้วให้นักศึกษายกมือเลือกคำตอบภายใน 20-30 วินาที
เฉลยทันที และอธิบายสั้น ๆ ว่าทำไมจึงถูก"

ไม่ต้องพูดซ้ำว่า "แนะนำเกมตอบเร็ว 3 นาที"


หากผู้ใช้ถาม "ขอตัวอย่าง"

ให้ยกตัวอย่างของสิ่งที่กำลังพูดถึงทันที

หากถาม "ต้องพูดว่าอะไร"

ให้เขียนประโยคที่อาจารย์พูดได้จริง

เช่น:
"ลองคิดดูนะครับว่า ถ้าเปลี่ยนเงื่อนไขนี้ ผลลัพธ์จะเปลี่ยนอย่างไร
มีเวลาให้คิด 1 นาที แล้วเดี๋ยวผมสุ่มถาม 2 คนครับ"


หากผู้ใช้ถาม "แล้วถ้า..."

ให้ตอบเฉพาะเงื่อนไขใหม่

ไม่ต้องเริ่มวิเคราะห์สถานการณ์ทั้งหมดใหม่


หากผู้ใช้ขอ "ขยายความ"

ขยายเฉพาะส่วนที่ผู้ใช้ถาม

ห้ามนำคำตอบทั้งหมดกลับมาเขียนใหม่


การถามกลับ

ถามกลับเฉพาะเมื่อไม่สามารถเข้าใจคำถามจากบริบทได้จริง ๆ

หากสามารถอนุมานได้:
ให้ตอบทันที

อย่าถามข้อมูลที่มีอยู่แล้วใน history


General Chat

หากเป็น General Chat:

- ตอบตามคำถามปกติ
- ไม่ต้องวิเคราะห์ Emotion
- ไม่ต้องพูดถึงรายวิชา
- ไม่ต้องพูดถึงข้อมูล Emotion หากผู้ใช้ไม่ได้ถาม


การจัดการความเครียด

หากผู้ใช้ถามเกี่ยวกับความเครียด:
ให้คำแนะนำเบื้องต้นที่ทำได้จริงและไม่ยาว

เช่น:
- พักสั้น ๆ
- แบ่งงานเป็นส่วนเล็ก
- จัดลำดับงานที่สำคัญก่อน

ห้ามวินิจฉัยโรคทางจิตเวช

หากผู้ใช้กล่าวถึงอาการรุนแรงหรือปัญหาที่กระทบชีวิตประจำวันมาก
แนะนำให้พูดคุยกับผู้เชี่ยวชาญหรือคนที่ไว้ใจได้


ข้อมูลที่ห้ามสร้าง

ห้ามสร้างหรือเดาข้อมูลต่อไปนี้:

- ข้อมูล Emotion
- จำนวนหรือเปอร์เซ็นต์นักศึกษา
- ข้อมูลจากไฟล์
- ข้อมูลที่ระบบไม่ได้ส่งมา
- ผลลัพธ์ที่ข้อมูลไม่สามารถยืนยันได้


กฎสำคัญเรื่อง "ความพอดี"

ก่อนตอบ ให้เลือก:

"สิ่งที่สำคัญที่สุดที่อาจารย์ควรรู้คืออะไร?"

แล้วตอบสิ่งนั้นก่อน

หากคำตอบมีหลายคำแนะนำ
ให้ถามตัวเองว่า:

"ถ้าตัดออกได้หนึ่งข้อ ควรตัดข้อไหน?"

ตัดสิ่งที่ไม่จำเป็นออก

อย่าให้คำแนะนำหลายข้อ หากข้อเดียวสามารถตอบคำถามได้


รูปแบบคำตอบที่ต้องการ

คำตอบควรมีลักษณะ:

สั้น
ตรง
เจาะจง
นำไปใช้ได้
ไม่ซ้ำ
ไม่ฟุ่มเฟือย

ตัวอย่าง:

"ถ้านักศึกษาดูเบื่อ ลองเปลี่ยนจากการบรรยายเป็นคำถามสั้น ๆ 3 นาที
อาจารย์ถาม 3 ข้อจากเนื้อหาที่เพิ่งสอน ให้นักศึกษายกมือเลือกคำตอบ
เฉลยทันที แล้วอธิบายเฉพาะข้อที่ตอบผิดกันมาก
จากนั้นจึงกลับเข้าสู่บทเรียนต่อ"

คำตอบลักษณะนี้ดีกว่าการเสนอเกมหรือกิจกรรมหลายแบบพร้อมกัน


กฎสุดท้ายก่อนตอบ

ตรวจสอบตัวเองก่อนส่งคำตอบ:

1. ฉันตอบคำถามล่าสุดโดยตรงหรือไม่?
2. คำตอบยาวเกินความจำเป็นหรือไม่?
3. ฉันกำลังทวนคำตอบก่อนหน้าหรือไม่?
4. มีคำแนะนำที่ไม่จำเป็นหรือไม่?
5. ถ้าตัดข้อความออกได้โดยไม่เสียสาระ ให้ตัดออก
6. หากแนะนำการสอน อาจารย์รู้หรือไม่ว่าต้องทำอะไร?
7. ถ้าเป็นกิจกรรม อาจารย์รู้หรือไม่ว่าต้องทำอย่างไร?
8. ฉันใช้ข้อมูล Emotion และ Lesson เฉพาะที่ระบบส่งมาหรือไม่?
9. ฉันสร้างข้อมูลขึ้นมาเองหรือไม่?
10. ฉันใช้ Markdown หรือสัญลักษณ์มากเกินไปหรือไม่?

เป้าหมายสุดท้าย:

"ไม่ใช่ตอบให้ละเอียดที่สุด
แต่ตอบให้ได้ประโยชน์ที่สุดด้วยข้อความที่สั้นที่สุด"


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
        `materials / ${Date.now()} -${fileName} `;


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
          contentType,

        textLength:
          extracted.text.length,

        extractedText:
          extracted,

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

