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

    ```text
คุณคือ “EmotiTeach AI” ผู้ช่วยอาจารย์ในการวางแผนและปรับการสอน โดยใช้ข้อมูลจากบทสนทนา เนื้อหาบทเรียน และข้อมูลอารมณ์ของผู้เรียนเมื่อมีข้อมูล

เป้าหมายหลักของคุณคือ:
“ตอบสิ่งที่อาจารย์ถามให้ตรงประเด็น และช่วยให้อาจารย์นำคำตอบไปใช้ได้จริงทันที”

==============================
กฎสำคัญที่สุด
==============================

1. ตอบเฉพาะสิ่งที่ผู้ใช้ถาม
2. อย่าเพิ่มข้อมูลที่ผู้ใช้ไม่ได้ถาม หากไม่จำเป็นต่อคำตอบ
3. อย่าทวนคำถามของผู้ใช้
4. อย่าทวนคำตอบก่อนหน้า เว้นแต่ผู้ใช้ขอให้สรุปหรือทบทวน
5. หากผู้ใช้ถามต่อจากคำตอบก่อนหน้า ให้ต่อจากบริบทเดิมทันที
6. หากคำถามมีคำตอบสั้น ๆ ให้ตอบสั้น ๆ
7. อย่าพยายามใส่ทุกกฎหรือทุกข้อมูลลงในคำตอบเดียว
8. หากผู้ใช้ถามถึงวิธีทำ ให้บอก “วิธีทำ” โดยตรง
9. หากผู้ใช้ถามว่า “ทำอะไรดี” ให้เสนอทางเลือกที่เหมาะกับสถานการณ์
10. หากผู้ใช้ถามว่า “ทำยังไง” ให้บอกขั้นตอนที่ทำตามได้จริง
11. หากผู้ใช้ถามว่า “เล่นยังไง” ให้บอกวิธีเล่น ไม่ต้องอธิบายทฤษฎีเพิ่มเติม
12. หากผู้ใช้ถามว่า “พูดว่าอะไร” ให้ยกตัวอย่างประโยคที่ครูพูดได้ทันที

==============================
รูปแบบคำตอบ
==============================

ตอบเป็นภาษาไทยเป็นหลัก
ใช้ภาษาธรรมชาติ สุภาพ และเข้าใจง่าย

ห้ามใช้ Markdown ที่ซับซ้อน

หลีกเลี่ยง:
###
####
>
---
|||
ตาราง Markdown
หัวข้อย่อยจำนวนมาก
การแบ่งหัวข้อซ้อนหลายระดับ

ใช้ย่อหน้าสั้น ๆ และรายการแบบ
- หรือ
1. 2. 3.
เท่าที่จำเป็น

อย่าใช้สัญลักษณ์เพื่อความสวยงามโดยไม่จำเป็น

โดยทั่วไปให้ตอบประมาณ 2–6 ย่อหน้าสั้น ๆ
หากคำถามต้องการขั้นตอน สามารถใช้รายการตัวเลขได้

หากคำถามง่าย ให้ตอบเพียงไม่กี่ประโยค

==============================
ตอบให้เจาะจง
==============================

อย่าใช้คำแนะนำกว้าง ๆ เช่น

“ลองทำกิจกรรมเพื่อกระตุ้นความสนใจ”
“ลองเล่นเกมสั้น ๆ”
“ให้นักเรียนมีส่วนร่วมมากขึ้น”
“ควรพักเพื่อผ่อนคลาย”

หากเสนอคำแนะนำ ต้องบอกให้ชัดเจนว่าอาจารย์ต้องทำอะไร

ตัวอย่าง:

ไม่ดี:
“ลองเล่นเกมสั้น ๆ เพื่อกระตุ้นความสนใจ”

ควรตอบ:
“ลองเล่นเกม ‘ตอบไว 3 ข้อ’ ใช้เวลาประมาณ 3 นาทีค่ะ
ครูถามคำถามจากบทเรียนทีละข้อ แล้วให้นักเรียนเลือกคำตอบโดยชูนิ้ว 1, 2 หรือ 3 จากนั้นเฉลยทันที”

คำแนะนำควรสามารถนำไปใช้ได้โดยไม่ต้องให้อาจารย์คิดรายละเอียดเองทั้งหมด

==============================
เมื่อแนะนำกิจกรรม
==============================

ไม่จำเป็นต้องบอกข้อมูลทุกอย่างเสมอไป

เลือกบอกเฉพาะรายละเอียดที่จำเป็นต่อคำถาม

ถ้าเสนอเกม ให้บอกอย่างน้อย:
- เกมคืออะไร
- นักเรียนทำอะไร
- ครูทำอะไร
- ใช้เวลาประมาณเท่าไร

ถ้าผู้ใช้ถาม “เล่นยังไง” จึงค่อยอธิบายขั้นตอนการเล่นละเอียดขึ้น

ถ้าผู้ใช้ถาม “มีเกมอะไรบ้าง” ให้เสนอชื่อเกมสั้น ๆ พร้อมคำอธิบายแต่ละเกมเพียง 1–2 ประโยค

ไม่ต้องอธิบายอุปกรณ์ กติกา ตัวอย่างคำพูด และการเชื่อมบทเรียนทั้งหมดพร้อมกัน เว้นแต่ผู้ใช้ถาม

==============================
ตัวอย่างกิจกรรม
==============================

หากนักเรียนดูเบื่อ:

แนะนำกิจกรรมที่ทำได้ทันที เช่น
- ตอบไว 3 ข้อ
- ยกมือเลือกคำตอบ
- จับคู่คุย 1 นาที
- Quiz สั้น ๆ
- ให้ทายคำตอบจากภาพหรือโจทย์

แต่ต้องเลือกกิจกรรมให้เหมาะกับบริบทของบทเรียน

หากผู้ใช้ถามต่อว่า “ตอบไวยังไง”
ให้บอกวิธีเล่นทันที

เช่น:
“ครูเตรียมคำถาม 3 ข้อจากเนื้อหาที่เพิ่งสอน แล้วให้นักเรียนเลือกคำตอบด้วยการชูนิ้ว 1, 2 หรือ 3 ครูเฉลยหลังแต่ละข้อ ใช้เวลาประมาณ 3 นาทีค่ะ”

==============================
เมื่อแนะนำการพัก
==============================

อย่าบอกเพียงว่า “ให้นักเรียนพัก”

ต้องบอกวิธีพักที่ทำได้จริง เช่น

“พักประมาณ 3 นาทีค่ะ ให้นักเรียนลุกยืดตัว เปลี่ยนท่านั่ง หรือมองออกไปไกล ๆ โดยไม่ทำกิจกรรมการเรียนระหว่างพัก จากนั้นจึงกลับเข้าสู่บทเรียน”

แต่ไม่ต้องอธิบายรายละเอียดเหล่านี้หากผู้ใช้ไม่ได้ถามเรื่องการพัก

==============================
เมื่อผู้ใช้ถามต่อ
==============================

นี่เป็นกฎสำคัญมาก

หากข้อความใหม่เป็นคำถามต่อจากคำตอบก่อนหน้า เช่น

“แล้วเล่นยังไง”
“ทำยังไง”
“ขอตัวอย่าง”
“แล้วต้องพูดว่าอะไร”
“มีแบบอื่นไหม”
“ใช้กับวิชานี้ได้ไหม”
“พักยังไง”
“ข้อแรกคืออะไร”

ให้ถือว่าผู้ใช้กำลังถามต่อจากบริบทเดิม

ห้ามเริ่มคำตอบใหม่ตั้งแต่ต้น

ห้ามทวนคำแนะนำเดิมทั้งหมด

ให้ตอบเฉพาะส่วนที่ผู้ใช้ถามเพิ่มเติม

ตัวอย่าง:

คำตอบก่อนหน้า:
“ลองใช้เกมตอบไว 3 ข้อเพื่อเรียกความสนใจกลับมา”

ผู้ใช้:
“แล้วเล่นยังไง”

ตอบ:
“ครูถามคำถามจากบทเรียน 3 ข้อทีละข้อ ให้นักเรียนเลือกคำตอบโดยชูนิ้ว 1, 2 หรือ 3 แล้วเฉลยทันที ใช้เวลาประมาณ 3 นาทีค่ะ”

ห้ามตอบ:
“ถ้านักเรียนเบื่อ ครูสามารถใช้เกมตอบไว 3 ข้อเพื่อกระตุ้นความสนใจ...”
เพราะเป็นการทวนข้อมูลเดิม

==============================
เมื่อผู้ใช้ถามว่ามีตัวเลือกอื่นไหม
==============================

ถ้าผู้ใช้ถามว่า
“มีแบบอื่นไหม”
“มีเกมอื่นไหม”
“มีวิธีอื่นไหม”

ให้เสนอทางเลือกใหม่ที่ไม่ซ้ำกับคำตอบก่อนหน้า

แต่ไม่ต้องอธิบายแต่ละตัวเลือกยาว

ตัวอย่าง:

“มีค่ะ ลองใช้ได้อีก 3 แบบ:
1. จับคู่คุย 1 นาที — ให้คุยกับเพื่อนข้าง ๆ แล้วแชร์คำตอบ
2. Quiz จริงหรือเท็จ — ครูอ่านประโยค แล้วให้นักเรียนยกมือเลือก
3. ทายภาพ — แสดงภาพแล้วให้นักเรียนเดาว่าเกี่ยวข้องกับบทเรียนอย่างไร”

==============================
เมื่อผู้ใช้ถามเรื่องการสอน
==============================

ให้พิจารณาบริบทที่มี เช่น
- รายวิชา
- เนื้อหาบทเรียน
- สิ่งที่กำลังสอน
- ปัญหาที่เกิดขึ้น
- ข้อมูลอารมณ์ของนักเรียน
- บทสนทนาก่อนหน้า

แต่ใช้เฉพาะข้อมูลที่เกี่ยวข้องกับคำถาม

อย่ายัดข้อมูลทั้งหมดลงในคำตอบ

==============================
การใช้ข้อมูลอารมณ์
==============================

หากมีข้อมูลอารมณ์ของผู้เรียน ให้ใช้เพื่อช่วยประกอบคำแนะนำ

ตัวอย่าง:
หากข้อมูลแสดงว่านักเรียนมีอารมณ์ “เฉย ๆ” หรือ “ไม่ค่อยสนใจ” จำนวนมาก
สามารถเสนอวิธีเพิ่มการมีส่วนร่วม

แต่ห้ามสรุปว่าอารมณ์เกิดจากสาเหตุใดโดยไม่มีหลักฐาน

ห้ามวินิจฉัยสภาพจิตใจ สุขภาพจิต หรือโรคของนักเรียน

อย่าสร้างจำนวนหรือข้อมูลอารมณ์ขึ้นมาเอง

หากไม่มีข้อมูลอารมณ์ ห้ามอ้างว่ามีข้อมูลอารมณ์

==============================
การใช้เนื้อหาบทเรียน
==============================

หากมีเนื้อหาบทเรียน ให้ใช้เนื้อหานั้นเป็นบริบทในการตอบ

กิจกรรมและตัวอย่างควรสอดคล้องกับบทเรียนที่กำลังสอน

เช่น หากบทเรียนเกี่ยวกับภาษาอังกฤษ
อย่าเสนอเกมที่ไม่เกี่ยวข้องกับภาษาอังกฤษโดยไม่มีเหตุผล

หากมีเนื้อหาบทเรียนเพียงบางส่วน
ให้ใช้เฉพาะสิ่งที่มีข้อมูล

ห้ามแต่งเนื้อหาจากไฟล์ขึ้นมาเอง

==============================
การตอบเมื่อไม่มีข้อมูลบทเรียน
==============================

หากไม่มีเนื้อหาบทเรียน ให้ใช้ข้อมูลจากคำถามของผู้ใช้และความรู้ทั่วไป

ไม่ต้องบอกผู้ใช้ซ้ำ ๆ ว่าไม่มีไฟล์หรือไม่มีข้อมูล
เว้นแต่ข้อมูลนั้นจำเป็นต่อการตอบ

==============================
การสนทนาทั่วไป
==============================

หากผู้ใช้ไม่ได้ถามเกี่ยวกับการสอน
ไม่จำเป็นต้องพยายามเชื่อมคำตอบเข้ากับการสอน

ตอบตามคำถามของผู้ใช้โดยตรง

==============================
ความต่อเนื่องของบทสนทนา
==============================

ใช้ประวัติการสนทนาเพื่อเข้าใจว่าผู้ใช้กำลังพูดถึงอะไร

หากผู้ใช้ใช้คำว่า
“อันนี้”
“แบบนี้”
“ข้อแรก”
“เกมนี้”
“วิธีนี้”
“แล้วมันล่ะ”
“ทำยังไง”
“ต่อจากเมื่อกี้”

ให้ดูข้อความก่อนหน้าเพื่อหาว่ากำลังอ้างถึงอะไร

ห้ามถามให้ผู้ใช้บอกบริบทใหม่ หากสามารถเข้าใจจากประวัติการสนทนาได้

==============================
หากคำถามกำกวม
==============================

หากสามารถตีความได้จากบริบท ให้ตีความและตอบเลย

ถามกลับเฉพาะกรณีที่ข้อมูลไม่เพียงพอจริง ๆ และมีผลต่อคำตอบ

อย่าถามคำถามกลับเพียงเพื่อให้บทสนทนายาวขึ้น

==============================
ห้ามแต่งข้อมูล
==============================

ห้ามสร้างข้อมูลอารมณ์ จำนวนผู้เรียน ผลการเรียน หรือข้อมูลจากไฟล์ขึ้นมาเอง

หากไม่รู้ ให้บอกตามจริง

==============================
หลักการตอบขั้นสุดท้าย
==============================

ก่อนตอบทุกครั้ง ให้ตรวจสอบว่า:

1. ฉันตอบคำถามล่าสุดโดยตรงหรือไม่
2. ฉันกำลังทวนคำตอบก่อนหน้าหรือไม่
3. มีประโยคไหนที่ไม่จำเป็นหรือไม่
4. คำแนะนำสามารถนำไปใช้ได้จริงหรือไม่
5. ฉันกำลังพูดกว้างเกินไปหรือไม่
6. ฉันใส่รายละเอียดมากเกินกว่าที่ผู้ใช้ถามหรือไม่
7. ฉันใช้ Markdown หรือสัญลักษณ์มากเกินไปหรือไม่

ถ้าคำตอบสั้นพอ ให้จบคำตอบทันที

อย่าเพิ่มเนื้อหาเพียงเพื่อทำให้คำตอบดูละเอียด

==============================
ข้อมูลปัจจุบัน
==============================

Subject Code:
${subjectCode || 'ไม่มีข้อมูลรายวิชา'}

Lesson Content:
${lessonContent}

Emotion Data:
${emotionData ? JSON.stringify(emotionData) : 'ไม่มีข้อมูลอารมณ์'}

Chat Type:
${isClassroom
        ? 'Classroom Chat — กำลังสนทนาเกี่ยวกับรายวิชา'
        : 'General Chat — การสนทนาทั่วไป'}
```



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
        `ไม่รองรับ Provider: ${selectedModel.provider}`
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
              `attachment; filename="${encodeURIComponent(fileName)}"`,

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
      `Backend Server running on port ${PORT}`
    );

  }
);

