const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.DENTAL_QC_PORT || 8787);
const HOST = '127.0.0.1';
const ALLOWED_FIELDS = [
  'recordText', 'caseType', 'complaint', 'presentHistory', 'pastHistory', 'allergies',
  'oralExam', 'auxiliaryExam', 'diagnosis', 'plan', 'action', 'advice',
  'visitRecords', 'chargeRecords', 'imagingRecords', 'procedureRecords', 'patientInfo', 'documentRecords',
  'electronicMedicalRecord'
];
const FIELD_NAMES = {
  recordText: '病例正文', caseType: '病例类型', complaint: '主诉', presentHistory: '现病史',
  pastHistory: '既往史', allergies: '过敏史', oralExam: '口腔检查',
  auxiliaryExam: '辅助检查', diagnosis: '诊断', plan: '治疗计划',
  action: '处置', advice: '医嘱', visitRecords: '就诊记录', chargeRecords: '收费记录',
  imagingRecords: '影像记录', procedureRecords: '处置记录', patientInfo: '患者信息', documentRecords: '文档与同意书',
  electronicMedicalRecord: '电子病历'
};

function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, 'AI配置.txt')
  ];
  const envPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!envPath) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

loadDotEnv();

function sanitizeText(value) {
  return String(value || '')
    .slice(0, 4000)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号已脱敏]')
    .replace(/(?:姓名|患者姓名)\s*[：:]\s*[^，。；;\n]{1,20}/g, '姓名：[已脱敏]')
    .replace(/(?:病历号|档案号)\s*[：:]\s*[A-Za-z0-9_-]{4,40}/g, '病历号：[已脱敏]')
    .trim();
}

function sanitizeRecord(input) {
  const output = {};
  for (const key of ALLOWED_FIELDS) output[key] = sanitizeText(input?.[key]);
  const total = Object.values(output).join('').length;
  if (!total) throw new Error('没有可发送的病历字段');
  if (total > 40000) throw new Error('交叉质检内容过长，请缩小页面时间范围后重新采集');
  return output;
}

function validateAiResult(value) {
  const source = value && typeof value === 'object' ? value : {};
  const allowedLevels = new Set(['严重', '一般', '提示']);
  const allowedCategories = new Set(['病历质量', '医疗安全与连续性', '收费及执行一致性', '投诉与合规风险']);
  const allowedCertainty = new Set(['明确矛盾', '疑似风险', '数据不足']);
  const allowedNames = new Set(Object.values(FIELD_NAMES));
  const issues = Array.isArray(source.issues) ? source.issues.slice(0, 12) : [];

  return {
    summary: sanitizeText(source.summary).slice(0, 300),
    issues: issues.map((item) => ({
      category: allowedCategories.has(item?.category) ? item.category : '病历质量',
      certainty: allowedCertainty.has(item?.certainty) ? item.certainty : '疑似风险',
      level: allowedLevels.has(item?.level) ? item.level : '提示',
      field: allowedNames.has(item?.field) ? item.field : '综合',
      title: sanitizeText(item?.title).slice(0, 80) || '建议复核',
      reason: sanitizeText(item?.reason).slice(0, 300) || 'AI未提供明确原因',
      suggestion: sanitizeText(item?.suggestion).slice(0, 400),
      rewriteTemplate: sanitizeText(item?.rewriteTemplate).slice(0, 500),
      evidenceSources: (Array.isArray(item?.evidenceSources) ? item.evidenceSources : [])
        .slice(0, 5).map((text) => sanitizeText(text).slice(0, 40)).filter(Boolean),
      needConfirm: (Array.isArray(item?.needConfirm) ? item.needConfirm : [])
        .slice(0, 5)
        .map((text) => sanitizeText(text).slice(0, 120))
        .filter(Boolean)
    }))
  };
}

function writeJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const SYSTEM_PROMPT = `你是口腔门诊病历质量复核助手，只检查病历记录质量，不进行诊断，不替代医生，不编造患者事实。
必须输出合法 JSON，格式为：
{"summary":"不超过100字的概括","issues":[{"category":"病历质量|医疗安全与连续性|收费及执行一致性|投诉与合规风险","certainty":"明确矛盾|疑似风险|数据不足","level":"严重|一般|提示","field":"主诉|现病史|既往史|过敏史|口腔检查|辅助检查|诊断|治疗计划|处置|医嘱|电子病历|患者信息|就诊记录|收费记录|影像记录|处置记录|文档与同意书|综合","title":"问题标题","evidenceSources":["电子病历"],"reason":"仅基于已提供内容的具体原因","suggestion":"应该如何修改或核对","rewriteTemplate":"需要补充文书时使用带方括号占位符的建议写法","needConfirm":["修改前必须确认的事实"]}]}
规则：
1. 缺少字段可能是页面未展示，只能提示确认，不得直接判定医疗错误。
2. 不得生成患者未提供的症状、检查结果、诊断或治疗事实。
3. 重点检查完整性、前后一致性、牙位一致性、诊断依据、计划与实际处置区别、复诊衔接和医嘱完整性。
4. 最多输出10项，避免重复；证据不足时降低等级或不输出。
5. 严重仅用于明确的关键矛盾或可能影响医疗安全的记录问题。
6. suggestion 必须说明怎样修改，而不只是重复“建议完善”。
7. rewriteTemplate 可以重组原文，但任何原文没有的患者事实必须写成方括号占位符，例如“右下后牙疼痛[持续时间待确认]”，不得自行补造。
8. needConfirm 列出采用建议写法前必须确认的症状、时间、牙位、检查结果或实际操作；没有需要确认的内容时返回空数组。
9. 病例正文可能含页面按钮文字，应忽略编辑、删除、打印、展开详情等界面操作词。
10. 若提供就诊、收费、影像或处置记录，应交叉核对日期、牙位、项目、诊断、计划、实际处置与状态；只把明确矛盾列为问题。
11. “未采集”表示没有证据，不能推断该记录不存在。收费项目不能单独证明实际实施；影像第一版仅核对记录、日期和文字元数据，不分析影像像素。
12. 重点提示：收费与病历/处置缺少对应、计划与实际项目不一致、退款/作废/欠费状态与病历表述矛盾、关键操作缺少影像记录、日期先后异常、重复项目以及牙位不一致。
13. 同时扫描治疗连续性中断、复诊超期、特殊年龄患者文书、解释不充分引发的投诉风险；没有明确记录依据时只能标为疑似风险或数据不足。
14. evidenceSources 只能列出实际提供且支持该提示的模块。明确矛盾必须至少有两个来源形成直接冲突；否则不得标记为明确矛盾。
15. 不得使用“违规收费、误诊、医疗事故”等定性措辞，只能提示记录或流程风险并建议人工核对。
16. 若提供文档信息，应把治疗计划、实际处置和收费项目与同意书名称及日期交叉核对，重点关注拔牙、种植、根管、正畸、手术、麻醉/镇静等项目。
17. 仅看到同意书文件名称不能证明已经签署；只有页面明确显示已签署、签名状态或可靠签署元数据时，才可以表述为“已见签署证据”。否则应提示人工打开文件确认签名、签署人和签署日期。
18. 各项目是否必须签署同意书受机构制度与适用法规影响，不得直接断言违法，只能提示“建议按机构制度核对”。
19. 牙位一致性：交叉核对检查、诊断、计划、处置、收费和影像中的牙位；只有明确提及且冲突时才提示矛盾。
20. 项目与执行：区分“治疗计划、收费、执行、实际完成”。收费不能证明执行；计划也不能证明完成。退费、作废、欠费状态应与病历表述一并核对。
21. 时间逻辑：核对就诊、病历、影像、处置、收费和同意书日期。仅当日期含义明确时判断先后，不得把创建时间等同于签署或治疗时间。
22. 连续性与医嘱：关注明确约定复诊后长期未见对应就诊、阶段治疗中断、治疗后缺少必要注意事项或异常处理方式；未提供完整时间范围时标为数据不足。
23. 投诉与沟通：关注费用、治疗内容、预期、替代方案、复诊安排和风险告知记录不清，但不得推断患者实际未被口头告知。
24. 特殊患者：年龄只能用于提示核对监护人或特殊文书要求，不得仅凭年龄推断疾病、依从性或治疗禁忌。
25. 数据质量：只有页面同时提供两个可核对字段时才判断冲突；缺少出生日期、签名详情或完整历史时不得凭空判定异常。
26. 输出时优先合并同一根因，最多10项；按医疗安全、明确跨模块矛盾、同意书/收费执行、连续性、一般文书问题的顺序排列。`;

async function callDeepSeek(record, requestApiKey) {
  const apiKey = String(requestApiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey || apiKey.includes('请填写')) throw new Error('本机服务尚未配置 DEEPSEEK_API_KEY');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `请对以下脱敏口腔病历字段做质量复核，并输出 JSON：\n${JSON.stringify(record)}` }
      ],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 1800,
      stream: false
    }),
    signal: AbortSignal.timeout(60000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `DeepSeek API 返回 ${response.status}`);
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek API 未返回有效内容');
  return validateAiResult(JSON.parse(content));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return writeJson(response, 200, {
      ok: true,
      configured: Boolean(process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.includes('请填写')),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
    });
  }

  if (request.method !== 'POST' || request.url !== '/api/qc') {
    return writeJson(response, 404, { error: 'Not found' });
  }

  try {
    const body = await readJson(request);
    const record = sanitizeRecord(body.record);
    const requestApiKey = typeof body.apiKey === 'string' ? body.apiKey.slice(0, 300) : '';
    const result = await callDeepSeek(record, requestApiKey);
    return writeJson(response, 200, result);
  } catch (error) {
    const safeMessage = error?.message || 'AI质检失败';
    const status = /配置|可发送|过长|请求内容/.test(safeMessage) ? 400 : 502;
    return writeJson(response, status, { error: safeMessage });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`口腔病历AI质检本机服务：http://${HOST}:${PORT}`);
  console.log(`模型：${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'}`);
  const configured = process.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY.includes('请填写');
  console.log(configured ? 'API Key：已配置' : 'API Key：未配置，请编辑 AI配置.txt');
});
