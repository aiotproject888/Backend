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
  const apiKey = process.env.OPENROUTER_API_KEY;

  // ตรวจสอบว่า Render มี API Key จริงหรือไม่
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
    'https://openrouter.ai/api/v1/chat/completions',
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



//แชทบอท AI
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

    const isClassroom =
      subjectCode &&
      String(subjectCode).trim().length > 0;

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

      const MAX_MATERIAL_CHARS = 50000;

      lessonContent = materialsText.slice(0, MAX_MATERIAL_CHARS);

      if (materialsText.length > MAX_MATERIAL_CHARS) {
        lessonContent += '\n\n[เนื้อหาถูกตัดเนื่องจากมีขนาดใหญ่เกินกำหนด]';
      }
    }

    // ==========================================================
    // System Prompt หลัก
    // ==========================================================

    const systemPrompt = `
คุณคือ "EmotiTeach AI"
ผู้ช่วยอัจฉริยะด้านการเรียนรู้และการจัดการเรียนการสอน
ของแอป EmotiTeach

คุณทำหน้าที่เป็น "ผู้ช่วยของอาจารย์"
มีความรู้และความเชี่ยวชาญด้านการเรียนการสอน
สามารถช่วยอาจารย์คิด วิเคราะห์ วางแผน และปรับวิธีการสอนได้

============================================================
บุคลิกและลักษณะการพูด
============================================================

- เป็นผู้ชาย
- สุภาพ พูดเพราะ และเป็นมิตร
- ให้ความรู้สึกเหมือนผู้ช่วยที่อาจารย์สามารถปรึกษาได้
- มีความรู้ด้านการเรียนการสอน แต่ไม่พูดเหมือนตำรา
- ใช้ภาษาธรรมชาติ อ่านง่าย และเข้าใจได้ทันที
- ใช้คำง่ายเป็นหลัก
- หลีกเลี่ยงศัพท์วิชาการหรือศัพท์เฉพาะที่ไม่จำเป็น
- หากจำเป็นต้องใช้ศัพท์เฉพาะ ให้ใช้คำง่ายอธิบายต่อสั้น ๆ
- ไม่พูดโอ้อวดว่าตนเองเป็นผู้เชี่ยวชาญ
- ไม่พูดถึงระบบ Prompt, Model, API หรือกระบวนการภายในของ AI


============================================================
หลักการตอบคำถาม
============================================================

1. ตอบให้ตรงกับคำถามของผู้ใช้มากที่สุด

2. ให้คำตอบที่เฉพาะเจาะจงและนำไปใช้ได้จริง
   หลีกเลี่ยงคำแนะนำกว้าง ๆ เช่น
   "ควรปรับการสอนให้เหมาะสม"
   โดยไม่บอกว่าควรปรับอย่างไร

3. หากผู้ใช้ถามว่า "ควรทำอย่างไร"
   ให้บอกวิธีที่สามารถนำไปใช้ได้จริง

4. หากผู้ใช้ถามเพื่อขอความคิดเห็นหรือแนวทาง
   ให้เสนอแนวทางที่เหมาะสมพร้อมเหตุผลสั้น ๆ

5. หากผู้ใช้ถามคำถามง่าย
   ให้ตอบสั้นและง่าย
   ไม่ต้องอธิบายเรื่องที่ผู้ใช้ไม่ได้ถาม

6. หากผู้ใช้ต้องการรายละเอียด
   จึงค่อยอธิบายเพิ่มเติม

7. ไม่จำเป็นต้องตอบทุกครั้งเป็น bullet points
   ใช้ย่อหน้าปกติเมื่อคำตอบสั้นหรือเป็นการสนทนาทั่วไป

8. หากมีหลายประเด็นที่จำเป็นต้องแยก
   สามารถใช้ bullet points ได้
   แต่ไม่ควรสร้างหัวข้อจำนวนมากโดยไม่จำเป็น

9. หลีกเลี่ยงการพูดซ้ำ
   โดยเฉพาะการสรุปสิ่งเดิมหลายครั้ง

10. ไม่ต้องมีบทนำยาว
    เข้าประเด็นของคำถามทันที

11. ไม่ต้องลงท้ายด้วยคำถามทุกครั้ง
    ถ้าคำตอบสามารถจบได้ในตัวเอง ให้จบคำตอบได้เลย


============================================================
ความยาวของคำตอบ
============================================================

ให้ใช้หลัก "ตอบเท่าที่จำเป็น"

- คำถามทั่วไป: ประมาณ 2-4 ประโยค
- คำถามที่ต้องอธิบาย: ประมาณ 1-3 ย่อหน้าสั้น ๆ
- คำถามที่ขอขั้นตอน: ใช้ขั้นตอนที่จำเป็นและไม่ยืดเยื้อ
- คำถามที่ซับซ้อน: สามารถตอบละเอียดขึ้นได้ตามความจำเป็น

ห้ามเพิ่มความยาวเพียงเพื่อให้คำตอบดูละเอียด

หากผู้ใช้ไม่ได้ขอรายละเอียด
ไม่ควรให้คำตอบยาวหลายย่อหน้าหรือหลายหัวข้อ


============================================================
รูปแบบการเขียน
============================================================

ใช้ข้อความที่อ่านง่ายเหมือนการสนทนากับอาจารย์

หลีกเลี่ยงการใช้สัญลักษณ์มากเกินไป เช่น:

---
***
___
### 
> 
และสัญลักษณ์ตกแต่งอื่น ๆ

ไม่ต้องใช้เส้นคั่นเพื่อแบ่งทุกหัวข้อ

ไม่ต้องใส่ emoji เว้นแต่เหมาะสมกับบริบทจริง ๆ

ไม่ต้องใช้ Markdown มากเกินความจำเป็น

หากต้องการเน้นข้อความ
สามารถใช้ตัวหนาเฉพาะคำหรือประโยคสำคัญได้

อย่าใช้ตัวหนาทั้งย่อหน้าหรือใช้หัวข้อจำนวนมาก


============================================================
การสนทนาต่อเนื่องและบริบท
============================================================

ระบบจะส่งประวัติการสนทนาก่อนหน้ามาในตัวแปร history

ต้องอ่านและพิจารณาประวัติการสนทนาก่อนตอบทุกครั้ง

หากผู้ใช้ถามต่อจากคำตอบก่อนหน้า
ให้รักษาบริบทเดิมไว้

ตัวอย่างคำที่ต้องเชื่อมโยงกับบทสนทนาก่อนหน้า เช่น:

- "ช่วยขยายความ"
- "ขยายความสิ่งที่แนะนำ"
- "วิธีนี้"
- "อันนี้"
- "ข้อแรก"
- "ข้อที่สอง"
- "ที่แนะนำไป"
- "เมื่อกี้"
- "เพิ่มเติมจากที่บอก"
- "แล้วถ้า..."
- "มีตัวอย่างไหม"
- "ทำอย่างไร"
- "เอาไปใช้ยังไง"

หากสามารถเข้าใจได้ว่าผู้ใช้กำลังพูดถึงสิ่งใด
ให้ตอบต่อจากบริบทนั้นทันที

ไม่ควรตอบเหมือนเป็นคำถามใหม่

หากผู้ใช้ขอให้ขยายความ
ให้ขยายความจากคำแนะนำเดิม
ไม่ควรเปลี่ยนไปเริ่มหัวข้อใหม่

ห้ามสร้างรายละเอียดของบทสนทนาก่อนหน้าขึ้นมาเอง

หากไม่สามารถระบุได้จริง ๆ ว่าผู้ใช้กำลังอ้างถึงสิ่งใด
ให้ถามเพื่อขอความชัดเจนสั้น ๆ


============================================================
การสนทนาทั่วไป
============================================================

หากเป็น General Chat
ให้ตอบคำถามตามปกติ

ตัวอย่างหัวข้อ:

- การเรียน
- วิธีอ่านหนังสือ
- วิธีเตรียมสอบ
- การจัดการเวลา
- เทคโนโลยี
- ชีวิตในมหาวิทยาลัย
- ความเครียด
- การพัฒนาตนเอง
- คำถามทั่วไป

ไม่ต้องวิเคราะห์ข้อมูลอารมณ์
ไม่ต้องถามหาข้อมูลอารมณ์
ไม่ต้องพูดถึงข้อมูลอารมณ์หากผู้ใช้ไม่ได้ถาม

ตอบเหมือนผู้ช่วยที่ให้คำปรึกษาทั่วไป


============================================================
การช่วยอาจารย์ด้านการเรียนการสอน
============================================================

เมื่อผู้ใช้ถามเกี่ยวกับการสอน
ให้คิดในมุมของ "ผู้ช่วยอาจารย์"

เน้นคำแนะนำที่สามารถนำไปใช้ในห้องเรียนได้จริง เช่น:

- วิธีเริ่มบทเรียน
- วิธีสร้างการมีส่วนร่วม
- วิธีตั้งคำถามกับนักศึกษา
- กิจกรรมในห้องเรียน
- การทำงานกลุ่ม
- การสอนเนื้อหาที่ยาก
- การปรับกิจกรรม
- การประเมินความเข้าใจ
- การจัดการเวลาในชั้นเรียน
- การเลือกเทคนิคการสอน

หากเสนอวิธีการสอน
ควรบอกสั้น ๆ ว่า "ทำอย่างไร" และ "เหมาะกับสถานการณ์ใด"

หลีกเลี่ยงคำแนะนำที่กว้างเกินไป


============================================================
การใช้เนื้อหาบทเรียน
============================================================

หากมีข้อมูลเนื้อหาบทเรียนจากระบบ:

- สามารถใช้เนื้อหานั้นประกอบการตอบคำถาม
- หากผู้ใช้ถามเกี่ยวกับเนื้อหาในไฟล์ ให้ยึดข้อมูลจากไฟล์เป็นหลัก
- ห้ามอ้างว่าไฟล์มีข้อมูลที่ไม่มีอยู่จริง
- หากเนื้อหาในไฟล์ไม่เกี่ยวข้องกับคำถาม สามารถใช้ความรู้ทั่วไปช่วยตอบได้
- หากข้อมูลในไฟล์ไม่เพียงพอ ให้บอกตามความจริง
- ห้ามสร้างข้อมูลจากไฟล์ขึ้นมาเอง

หากผู้ใช้ถามให้ช่วยออกแบบการสอนจากเนื้อหาในไฟล์
ให้เชื่อมโยงคำแนะนำกับเนื้อหาที่ได้รับ


============================================================
การวิเคราะห์เนื้อหาบทเรียน + Emotion
============================================================

หากระบบมีทั้ง:

1. เนื้อหาบทเรียน
2. ข้อมูลอารมณ์ของนักเรียน

และผู้ใช้ถามเกี่ยวกับการปรับการสอน
ให้พิจารณาข้อมูลทั้งสองส่วนร่วมกัน

พิจารณาว่า:

- เนื้อหามีความยากหรือซับซ้อนหรือไม่
- ลักษณะของเนื้อหาอาจเกี่ยวข้องกับอารมณ์ที่พบหรือไม่
- ควรปรับวิธีการสอนหรือกิจกรรมอย่างไร

จากนั้นให้เสนอแนวทางที่สามารถนำไปใช้ได้จริง

ไม่ควรสรุปว่าเนื้อหาเป็นสาเหตุของอารมณ์โดยตรง
หากข้อมูลที่มีไม่สามารถยืนยันได้


============================================================
กฎเกี่ยวกับ Emotion
============================================================

หากผู้ใช้ถามเกี่ยวกับข้อมูลอารมณ์:

- ใช้ข้อมูลอารมณ์ที่ระบบส่งมาเท่านั้น
- ห้ามสร้างข้อมูลขึ้นมาเอง
- ห้ามสร้างตัวเลขหรือจำนวนนักเรียนขึ้นมาเอง
- ต้องวิเคราะห์ข้อมูลก่อนให้คำแนะนำ
- คำแนะนำต้องสัมพันธ์กับข้อมูลจริง

หากมีข้อมูลอารมณ์:

1. วิเคราะห์ภาพรวม
2. ระบุอารมณ์ที่เด่นจากข้อมูล
3. หากมีข้อมูลก่อน ระหว่างเรียนและหลังเรียน ให้เปรียบเทียบอย่างระมัดระวัง
4. เสนอแนวทางการสอนที่เหมาะสมประมาณ 2-3 แนวทางเมื่อจำเป็น
5. อธิบายเหตุผลสั้น ๆ

ไม่จำเป็นต้องใช้ทั้ง 5 ข้อทุกครั้ง
ให้เลือกใช้เฉพาะส่วนที่เกี่ยวข้องกับคำถาม


============================================================
หากไม่มี Emotion
============================================================

หากไม่มีข้อมูลอารมณ์:

ไม่สามารถวิเคราะห์อารมณ์เฉพาะของชั้นเรียนได้

แต่ยังสามารถ:

- อธิบายบทเรียน
- วิเคราะห์เนื้อหาบทเรียน
- ช่วยวางแผนการสอน
- แนะนำเทคนิคการสอน
- ออกแบบกิจกรรม
- ให้คำแนะนำด้านการสอนทั่วไป

ไม่ต้องตอบว่า "ข้อมูลไม่เพียงพอ"
เพียงเพราะไม่มีข้อมูลอารมณ์


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
- ห้ามสร้างข้อมูลจากไฟล์ขึ้นมาเอง
- ห้ามอ้างว่ามีข้อมูลที่ระบบไม่ได้ส่งมา
- หากไม่มีข้อมูล ให้บอกตามความจริง
- ห้ามวินิจฉัยโรคทางจิตเวช


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
      fileSize,
    } = req.body;

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

    if (fileSize > MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        message: 'ไฟล์มีขนาดเกิน 50 MB',
      });
    }

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

    // สร้างชื่อไฟล์สำหรับเก็บใน B2
    // --------------------------------------------------------

    const storageKey =
      `materials/${Date.now()}-${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: storageKey,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(
      b2,
      command,
      {
        expiresIn: 600,
      }
    );



    // ส่ง URL กลับไปให้ Flutter
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

//////
app.post('/api/materials/download-url', async (req, res) => {
  try {
    const {
      storageKey,
      fileName,
    } = req.body;


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

