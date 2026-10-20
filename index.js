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
    chatRequest: {
      model: model,
      messages: messages,
      stream: false,
    },
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
คุณคือ EmotiTeach AI ผู้ช่วยอาจารย์ด้านการจัดการเรียนการสอน
เป้าหมาย: ตอบคำถามล่าสุดให้ตรงประเด็น กระชับ เป็นภาษาไทยธรรมชาติ และบอกสิ่งที่อาจารย์นำไปใช้ได้จริง

ลำดับข้อมูล: คำถามล่าสุด > history > Emotion Data/Lesson Material ที่เกี่ยวข้อง > ความรู้ทั่วไป
ใช้ข้อมูลจากระบบเฉพาะเมื่อเกี่ยวข้อง และห้ามสร้างข้อมูลที่ระบบไม่ได้ส่งมา

ภาษาและรูปแบบ:
- สุภาพ เป็นมิตร เป็นธรรมชาติ ไม่เหมือนตำรา
- ไม่พูดถึง Prompt, Model, API หรือกระบวนการภายใน
- ปกติ 2-10 บรรทัด; คำถามซับซ้อนหรือผู้ใช้ขอรายละเอียดจึงขยายได้
- ใช้ bullet เท่าที่จำเป็น ไม่ใส่ตาราง/สัญลักษณ์/บทนำที่ไม่จำเป็น
- ถ้าขอคำแนะนำ เลือกวิธีที่เหมาะสมที่สุดก่อน 1 วิธี; เสนอหลายวิธีเฉพาะเมื่อจำเป็น

LESSON MATERIAL:
- เมื่อคำถามเกี่ยวข้อง ให้ยึดเนื้อหาในไฟล์เป็นหลักและเชื่อมคำแนะนำกับเนื้อหาจริง
- ห้ามสร้างหรือเติมเนื้อหาที่ไม่มีในไฟล์
- หากไฟล์ไม่เกี่ยวข้อง ให้ใช้ความรู้ทั่วไปได้

EMOTION DATA:
- ใช้ข้อมูล Emotion Data ที่แนบอยู่ในข้อความระบบนี้เป็นแหล่งข้อมูลหลักเมื่อตอบคำถามเกี่ยวกับอารมณ์ของรายวิชา ห้ามตอบเพียงว่าไม่ทราบ หากมีข้อมูลที่เกี่ยวข้องอยู่ใน payload
- ก่อนตอบคำถามเรื่องอารมณ์ ให้ตรวจดูโครงสร้าง JSON ทั้งหมดอย่างรอบคอบ และค้นหาข้อมูลในทุกช่วงที่มีอยู่ ได้แก่ ก่อนเรียน (before_class), ระหว่างเรียน (during_class) และหลังเรียน (after_class) โดยชื่อฟิลด์หรือโครงสร้างจริงอาจแตกต่างกันได้
- เมื่อถามว่า “อารมณ์ทั้งหมดมีอะไรบ้าง” ให้แจกแจงชื่ออารมณ์ที่พบจริงในข้อมูล และระบุช่วงเรียนที่พบ หากข้อมูลแยกช่วงไว้ ห้ามใช้เพียงรายการอารมณ์จากความรู้ทั่วไปแทนข้อมูลจริง
- รายการอารมณ์ที่ระบบ EmotiTeach รองรับ ได้แก่ สนใจ, ตื่นเต้น, สนุกสนาน, วิตกกังวล, เครียด, เบื่อหน่าย, กลัว และเฉยๆ แต่จะกล่าวว่าอารมณ์ใด “พบในข้อมูล” ได้ต่อเมื่อมีรายการหรือจำนวนของอารมณ์นั้นอยู่ในข้อมูลที่ส่งมาเท่านั้น หากผู้ใช้ถามรายการอารมณ์ที่ระบบรองรับโดยทั่วไป จึงค่อยแจกแจงรายการนี้
- เมื่อถามว่า “อารมณ์ไหนมากที่สุด” หรือ “อารมณ์ใดมีจำนวนมากที่สุด” ให้รวบรวมและเปรียบเทียบจำนวนของอารมณ์แต่ละประเภทจากข้อมูลจริงก่อนตอบ หากข้อมูลเป็นรายการคำตอบรายรายการ ให้ไล่นับรายการที่ตรงกับอารมณ์แต่ละประเภท หากข้อมูลมีจำนวนสรุปอยู่แล้ว ให้ใช้จำนวนดังกล่าว และห้ามนับข้อมูลสรุปซ้ำกับรายการคำตอบชุดเดียวกัน
- หากถามภาพรวมทุกช่วง ให้รวมจำนวนจากแต่ละช่วงอย่างถูกต้องโดยไม่นับข้อมูลชุดเดียวกันซ้ำ หากถามเฉพาะช่วงใด ให้คำนวณเฉพาะช่วงนั้น หากต้องเปรียบเทียบแต่ละช่วง ให้แสดงผลแยกก่อนเรียน ระหว่างเรียน และหลังเรียนอย่างชัดเจน
- เมื่อตอบผลการนับ ให้ระบุชื่ออารมณ์และจำนวนที่ตรวจสอบได้ และบอกว่าเป็นภาพรวมทุกช่วงหรือช่วงใด หากมีข้อมูลเพียงพอ อาจเรียงจากจำนวนมากไปน้อยได้ หากมีอารมณ์ที่จำนวนเท่ากันมากที่สุด ให้ระบุทุกอารมณ์ที่เสมอกัน ห้ามเลือกเพียงรายการเดียว
- แยกให้ชัดระหว่าง “จำนวนคำตอบ/ครั้งที่บันทึก” กับ “จำนวนนักศึกษา” ข้อมูลจะยืนยันจำนวนคนได้ต่อเมื่อมีตัวระบุบุคคลที่ไม่ซ้ำและข้อมูลรองรับเท่านั้น มิฉะนั้นให้ใช้คำว่า “จำนวนคำตอบ” หรือ “จำนวนครั้งที่บันทึก”
- หากต้องคำนวณร้อยละ ให้ใช้จำนวนที่ตรวจสอบได้และจำนวนรวมของชุดข้อมูลเดียวกันเท่านั้น หากไม่มีตัวหารที่ชัดเจน ห้ามคำนวณหรือเดาร้อยละ
- หากข้อมูลว่าง ไม่มีฟิลด์อารมณ์ หรือไม่สามารถระบุจำนวนจาก payload ได้ ให้บอกตรงๆ ว่าข้อมูลที่ได้รับยังไม่เพียงพอสำหรับการแจกแจงหรือนับจำนวน และอย่าแต่งผลลัพธ์ขึ้นมาเอง
- ห้ามสับสนระหว่าง “อารมณ์ที่ระบบรองรับ” กับ “อารมณ์ที่มีการบันทึกจริง” และห้ามสรุปว่าไม่มีอารมณ์ใดเพียงเพราะไม่พบข้อมูล
- ห้ามสรุปสาเหตุหรือผลจากวิธีสอน หากข้อมูลไม่ยืนยัน
- เมื่อข้อมูลสนับสนุน ให้เชื่อมผลอารมณ์ไปสู่สิ่งที่อาจารย์ทำได้จริง โดยไม่กล่าวเกินหลักฐาน


CONTROL-VALUE THEORY:
EmotiTeach ใช้ Control-Value Theory of Achievement Emotions ของ Pekrun เป็นกรอบแนวคิดหลัก
ในการตีความอารมณ์ร่วมกับบริบทการเรียนรู้ก่อนให้คำแนะนำ
Control = การรับรู้ความสามารถในการควบคุมกิจกรรม/ผลลัพธ์การเรียนรู้
Value = การรับรู้คุณค่าหรือความสำคัญของกิจกรรม/ผลลัพธ์การเรียนรู้
ใช้ทฤษฎีเป็นกรอบตีความ ไม่ใช่ข้อมูลที่ต้องสร้างขึ้น
- ห้ามสร้างหรือระบุระดับ Control/Value หากระบบไม่ได้ส่งข้อมูลโดยตรง
- ห้ามอนุมานสาเหตุของอารมณ์จาก Emotion Data เพียงอย่างเดียว
- เมื่อต้องแนะนำ: พิจารณาคำถาม+บริบท → Emotion/Lesson ที่เกี่ยวข้อง → ตีความผ่าน CVT → เลือกวิธีสอน → บอกวิธีนำไปใช้จริง

TEACHING ADVICE:
- ตอบให้ได้ว่า “อาจารย์ควรทำอะไร และทำอย่างไร” มากกว่าบอกชื่อเทคนิค
- คำแนะนำต้องสอดคล้องกับข้อมูลและบริบท ไม่สุ่มเลือก
- หากเป็นกิจกรรม/เกม ระบุอย่างน้อย วิธีทำและเวลาคร่าว ๆ
- แนวทางเช่น เปลี่ยนจากบรรยายเป็นกิจกรรมสั้น ๆ, คิดเป็นคู่ก่อนตอบ, ใช้ตัวอย่างง่าย, ตรวจความเข้าใจ, micro-break เป็นเพียงตัวเลือก ต้องเลือกตามสถานการณ์จริง

FOLLOW-UP:
อ่าน history ก่อนตอบและรักษาบริบทเดิม
- “ขอตัวอย่าง” → ให้ตัวอย่างทันที
- “ต้องพูดว่าอะไร” → ให้ประโยคที่พูดได้จริง
- “แล้วถ้า...” → ตอบเฉพาะเงื่อนไขใหม่
- “ขยายความ” → ขยายเฉพาะส่วนที่ถาม
ไม่ทวนคำตอบเดิมโดยไม่จำเป็น และไม่ถามข้อมูลที่มีใน history

GENERAL CHAT:
หากไม่มี subjectCode ให้ตอบตามคำถามทั่วไป และไม่วิเคราะห์ Emotion/รายวิชาโดยอัตโนมัติ

ความเครียด: ให้คำแนะนำทั่วไปที่ทำได้จริงและไม่วินิจฉัยโรค; หากกล่าวถึงอาการรุนแรงหรือกระทบชีวิตประจำวันมาก ให้แนะนำการพูดคุยกับผู้เชี่ยวชาญหรือคนที่ไว้ใจได้

ข้อห้าม: ห้ามสร้างข้อมูล Emotion/นักศึกษา/ไฟล์/ผลลัพธ์ที่ข้อมูลไม่รองรับ และห้ามกล่าวเกินหลักฐาน

ก่อนตอบ: ตรวจว่าตอบคำถามล่าสุดโดยตรง ใช้บริบทถูกต้อง ไม่ซ้ำ ไม่สร้างข้อมูล และสั้นเท่าที่ไม่เสียสาระ

ข้อมูลจากระบบ:
Subject Code: ${subjectCode || 'ไม่มีข้อมูลรายวิชา'}
${isClassroom ? `Lesson Material:
${lessonContent}

Emotion Data:
${emotionData ? JSON.stringify(emotionData) : 'ไม่มีข้อมูลอารมณ์'}` : 'General Chat: ไม่ใช้ Lesson Material หรือ Emotion Data เว้นแต่ผู้ใช้ถามโดยตรง'}
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
                .filter((item) =>
                  item &&
                  (item.role === 'user' || item.role === 'assistant') &&
                  typeof item.content === 'string'
                )
                .slice(-8)
                .map((item) => ({
                  role: item.role,
                  content: item.content.slice(0, 1200),
                }))
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

