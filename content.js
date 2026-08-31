(() => {
  const ROOT_ID = 'dental-qc-probe-root';
  const oldRoot = document.getElementById(ROOT_ID);
  if (oldRoot) oldRoot.remove();

  const FIELD_ALIASES = [
    ['病例类型', ['初诊病历', '复诊病历', '急诊病历']],
    ['主诉', ['主诉']],
    ['现病史', ['现病史', '病史']],
    ['既往史', ['既往史']],
    ['过敏史', ['过敏史', '药物过敏']],
    ['口腔检查', ['口腔检查', '专科检查', '检查']],
    ['辅助检查', ['辅助检查', '影像检查']],
    ['诊断', ['诊断', '初步诊断']],
    ['治疗计划', ['治疗计划', '治疗方案', '治疗', '计划']],
    ['处置', ['处置', '治疗记录']],
    ['医嘱', ['医嘱', '术后医嘱']],
    ['标签', ['标签']],
    ['科室', ['科室']],
    ['医生', ['医生']]
  ];

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const normalize = (text) => (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const route = location.hash || '';
  const patientKey = route.match(/\/patient\/(?:[^/]+\/)?(\d{4,})/)?.[1] || 'current';
  const moduleFromRoute = () => {
    if (/\/apptRecord(?:\/|$)/.test(route)) return ['visitRecords', '就诊记录'];
    if (/\/charge\//.test(route)) return ['chargeRecords', '收费记录'];
    if (/\/imaging\//.test(route)) return ['imagingRecords', '影像记录'];
    if (/\/diagnoseRecord(?:\/|$)/.test(route)) return ['procedureRecords', '处置记录'];
    return null;
  };

  const sanitizeModuleText = (value) => normalize(value)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号已脱敏]')
    .replace(/(?:姓名|患者姓名)\s*[：:]\s*[^，。；;\n]{1,20}/g, '姓名：[已脱敏]')
    .replace(/(?:病历号|档案号)\s*[：:]\s*[A-Za-z0-9_-]{4,40}/g, '病历号：[已脱敏]')
    .slice(0, 12000);

  const renderCapturePanel = async ([module, label]) => {
    const root = document.createElement('aside');
    root.id = ROOT_ID;
    const header = document.createElement('div');
    header.className = 'dqp-head';
    header.innerHTML = `<div><div class="dqp-title">口腔病历质检</div><div class="dqp-subtitle">${label} · 只读暂存</div></div>`;
    const close = document.createElement('button');
    close.className = 'dqp-close'; close.type = 'button'; close.textContent = '×';
    close.addEventListener('click', () => root.remove()); header.appendChild(close);
    const body = document.createElement('div'); body.className = 'dqp-body';
    const notice = document.createElement('p'); notice.className = 'dqp-notice';
    notice.textContent = `将当前${label}的可见文字脱敏后暂存在浏览器会话中，关闭浏览器后自动清除。不会修改页面。`;
    const summary = document.createElement('p'); summary.className = 'dqp-summary';
    summary.textContent = `已识别当前页面为“${label}”。请确认页面已加载到需要比对的时间范围。`;
    const button = document.createElement('button'); button.className = 'dqp-button dqp-primary';
    button.type = 'button'; button.textContent = `采集${label}`;
    button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = '采集中…';
      try {
        const clone = document.body.cloneNode(true);
        clone.querySelector(`#${ROOT_ID}`)?.remove();
        clone.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
        const text = sanitizeModuleText(clone.innerText || clone.textContent || '');
        const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_CAPTURE', patientKey, module, text });
        if (!response?.ok) throw new Error(response?.error || '采集失败');
        summary.textContent = `${label}已暂存。当前已采集：${response.modules.map((name) => ({visitRecords:'就诊记录',chargeRecords:'收费记录',imagingRecords:'影像记录',procedureRecords:'处置记录'}[name] || name)).join('、')}。`;
        button.textContent = `重新采集${label}`;
      } catch (error) {
        summary.textContent = error?.message || '采集失败'; button.textContent = `重新采集${label}`;
      } finally { button.disabled = false; }
    });
    body.append(notice, summary, button); root.append(header, body); document.documentElement.appendChild(root);
  };

  const currentModule = moduleFromRoute();
  if (currentModule) {
    renderCapturePanel(currentModule);
    return;
  }

  // e看牙会把病例字段、病例摘要和操作按钮放在相邻区域。这里把这些
  // 界面文字作为字段终止边界，避免被误认为病历正文。
  const UI_BOUNDARIES = [
    '展开详情', '收起详情', '编辑', '删除', '查看操作日志', '打印',
    '打印疾病证明书', '转成正畸初诊病历', '转成初诊病历', '转成复诊病历',
    '新建病历', '新建优秀病例', '打印所有签名文档', '打印所有病历',
    '助理', '护士', '费用', '诊所', '相关标签', '创建人', '初诊医生'
  ];

  const pageText = normalize(document.body.innerText);
  const looksLikeRecordPage = pageText.includes('电子病历') && /主诉|口腔检查|治疗计划|处置/.test(pageText);

  const candidates = [...document.querySelectorAll('div, section, article, li, tr')]
    .filter(isVisible)
    .map((element) => {
      const text = normalize(element.innerText);
      const hits = ['主诉', '口腔检查', '治疗计划', '处置', '医嘱', '诊断']
        .filter((label) => text.includes(label + '：') || text.includes(label + ':')).length;
      return { element, text, hits };
    })
    .filter(({ text, hits }) => hits >= 2 && text.length >= 20 && text.length <= 6000)
    .sort((a, b) => b.hits - a.hits || a.text.length - b.text.length);

  let record = candidates[0] || null;
  let sourceText = record?.text || '';

  // e看牙的展开病例正文有稳定容器。优先把读取范围锁定在该容器内，
  // 防止从同页其他折叠病例、隐藏模板或患者摘要中误取内容。
  const allStructuredBodyElements = [...document.querySelectorAll('.medical-record-text-body')];
  const visibleStructuredBodyElements = allStructuredBodyElements
    .filter((element) => !element.closest('.ng-hide'));
  const structuredBodyElements = visibleStructuredBodyElements.length
    ? visibleStructuredBodyElements
    : allStructuredBodyElements.length === 1 ? allStructuredBodyElements : [];
  const structuredBodies = structuredBodyElements
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      return {
        element,
        text: normalize(element.innerText),
        viewportDistance: rect.height ? Math.abs(center - window.innerHeight / 2) : Number.MAX_SAFE_INTEGER
      };
    })
    .filter(({ text }) => /主诉[：:]|口腔检查[：:]|治疗计划[：:]|处置[：:]/.test(text))
    .sort((a, b) => a.viewportDistance - b.viewportDistance || b.text.length - a.text.length);
  const structuredBody = structuredBodies[0]?.element || null;

  if (structuredBody) {
    // 从当前正文向上寻找最小的完整病例卡，确保病例类型、标签、医生与
    // 正文属于同一份病例，而不是同一页面上的另一份展开病例。
    const ancestors = [];
    let parent = structuredBody.parentElement;
    while (parent && parent !== document.body) {
      const text = normalize(parent.innerText);
      if (/初诊病历|复诊病历|急诊病历/.test(text) && /主诉[：:]/.test(text)) {
        ancestors.push({ element: parent, text });
      }
      parent = parent.parentElement;
    }
    ancestors.sort((a, b) => a.text.length - b.text.length);
    if (ancestors[0]) {
      record = ancestors[0];
      sourceText = ancestors[0].text;
    }
  }

  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const allLabels = [...FIELD_ALIASES.flatMap(([, aliases]) => aliases), ...UI_BOUNDARIES]
    .sort((a, b) => b.length - a.length);

  const trimUiText = (value) => {
    let result = normalize(value);
    for (const boundary of UI_BOUNDARIES) {
      const index = result.search(new RegExp(`(?:^|\\s)${escapeRegex(boundary)}(?:\\s|[：:]|$)`));
      if (index >= 0) result = result.slice(0, index).trim();
    }
    return result.replace(/[|｜]\s*$/, '').trim();
  };

  const extractField = (aliases) => {
    for (const alias of aliases) {
      const nextLabels = allLabels.filter((item) => item !== alias).map(escapeRegex).join('|');
      const pattern = new RegExp(`(?:^|\\n|\\s)${escapeRegex(alias)}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n?\\s*(?:${nextLabels})\\s*[：:]|$)`);
      const match = sourceText.match(pattern);
      if (match?.[1]) return trimUiText(match[1]);
    }
    return '';
  };

  const extractStructured = (selector, label) => {
    if (!structuredBody) return '';
    const container = structuredBody.querySelector(selector);
    if (!container) return '';
    return trimUiText(normalize(container.innerText).replace(new RegExp(`^\\s*${escapeRegex(label)}\\s*`), ''));
  };

  const extractComplaint = () => {
    if (!structuredBody) return '';
    const labels = [...structuredBody.querySelectorAll('span, label, div')];
    const label = labels.find((element) => element.children.length === 0 && /^(主诉)[：:]$/.test(normalize(element.textContent)));
    if (!label) return '';
    const sibling = label.nextElementSibling;
    return sibling ? trimUiText(normalize(sibling.innerText || sibling.textContent)) : '';
  };

  const structuredSelectors = {
    '口腔检查': ['.emr-oral-check-records', '口腔检查：'],
    '辅助检查': ['.emr-assist-check-records, .emr-auxiliary-examinations', '辅助检查：'],
    '诊断': ['.emr-diagnoses, .emr-diagnosis', '诊断：'],
    '治疗计划': ['.emr-treatment-plans', '治疗计划：'],
    '处置': ['.emr-cure-records', '处置：'],
    '医嘱': ['.emr-advice', '医嘱：']
  };

  const fields = FIELD_ALIASES.map(([name, aliases]) => {
    if (name === '病例类型') {
      return { name, value: aliases.find((item) => sourceText.includes(item)) || '' };
    }
    if (structuredBody && name === '主诉') return { name, value: extractComplaint() };
    if (structuredBody && structuredSelectors[name]) {
      const [selector, label] = structuredSelectors[name];
      return { name, value: extractStructured(selector, label) };
    }
    // 诊疗正文字段一旦定位到真实病例容器，就不再回退到整页文字，
    // 以免把其他折叠病例的内容误判为当前病例。
    if (structuredBody && ['现病史', '既往史', '过敏史'].includes(name)) return { name, value: '' };
    return { name, value: extractField(aliases) };
  });

  const foundCount = fields.filter((field) => field.value).length;
  const fieldMap = Object.fromEntries(fields.map(({ name, value }) => [name, value]));

  const issues = [];
  const addIssue = (level, title, message, field) => issues.push({ level, title, message, field });
  const missing = (name) => !fieldMap[name];
  const compactLength = (name) => (fieldMap[name] || '').replace(/\s/g, '').length;

  ['主诉', '口腔检查', '诊断', '治疗计划', '处置'].forEach((name) => {
    if (missing(name)) {
      addIssue('严重', `${name}未识别`, `当前展开病例中没有识别到“${name}”。请确认该项是否未填写，或页面模板未展示。`, name);
    }
  });

  if (!missing('主诉') && compactLength('主诉') < 6) {
    addIssue('一般', '主诉可能过于简略', '建议说明主要问题、部位、持续时间或本次复诊目的。', '主诉');
  }
  if (!missing('口腔检查') && compactLength('口腔检查') < 8) {
    addIssue('一般', '口腔检查可能过于简略', '建议记录与诊断和治疗相关的客观检查表现，不宜只写牙位和结论。', '口腔检查');
  }
  if (!missing('治疗计划') && !missing('处置') && fieldMap['治疗计划'] === fieldMap['处置']) {
    addIssue('一般', '治疗计划与处置内容完全相同', '请复核是否分别记录了拟实施方案和本次实际完成的操作过程。', '处置');
  }
  if (missing('医嘱')) {
    addIssue('一般', '医嘱未识别', '如本次进行了治疗，请确认是否需要记录复诊安排、注意事项或异常情况处理方式。', '医嘱');
  } else if (compactLength('医嘱') < 8) {
    addIssue('提示', '医嘱可能较简略', '可根据本次治疗补充个体化注意事项和明确复诊条件。', '医嘱');
  }

  if (fieldMap['病例类型'] === '初诊病历') {
    ['现病史', '既往史', '过敏史'].forEach((name) => {
      if (missing(name)) addIssue('一般', `初诊病例未识别到${name}`, `请确认${name}是否记录在其他页面，或当前病例中尚未填写。`, name);
    });
  }

  const toothNumbers = (value) => new Set((value.match(/(?:^|\D)([1-8][1-8])(?=\D|$)/g) || [])
    .map((item) => item.match(/[1-8][1-8]/)?.[0]).filter(Boolean));
  const examTeeth = toothNumbers(fieldMap['口腔检查'] || '');
  const planTeeth = toothNumbers(fieldMap['治疗计划'] || '');
  const actionTeeth = toothNumbers(fieldMap['处置'] || '');
  const differentTeeth = (left, right) => left.size && right.size &&
    ([...left].some((item) => !right.has(item)) || [...right].some((item) => !left.has(item)));
  if (differentTeeth(examTeeth, planTeeth) || differentTeeth(planTeeth, actionTeeth)) {
    addIssue('严重', '牙位可能前后不一致', '检查、治疗计划和处置中识别到的牙位不完全一致，请人工复核。', '口腔检查');
  }
  const root = document.createElement('aside');
  root.id = ROOT_ID;

  const header = document.createElement('div');
  header.className = 'dqp-head';
  header.innerHTML = '<div><div class="dqp-title">口腔病历质检</div><div class="dqp-subtitle">只读 · 本地处理 · 不保存</div></div>';
  const close = document.createElement('button');
  close.className = 'dqp-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  close.addEventListener('click', () => root.remove());
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'dqp-body';
  const notice = document.createElement('p');
  notice.className = 'dqp-notice';
  notice.textContent = '结果仅用于病历质量提示，不能替代医生判断。本工具不会修改或上传病例。';
  body.appendChild(notice);

  const summary = document.createElement('p');
  summary.className = 'dqp-summary';
  summary.textContent = record
    ? `${structuredBodies.length > 1 ? `检测到 ${structuredBodies.length} 份展开病例，已选择视口中央附近的一份。` : ''}已识别 ${foundCount}/${fields.length} 个字段，发现 ${issues.length} 项待复核内容。`
    : '暂未发现已展开的病历详情。';
  body.appendChild(summary);

  if (record) {
    const issueTitle = document.createElement('div');
    issueTitle.className = 'dqp-section-title';
    issueTitle.textContent = '质检结果';
    body.appendChild(issueTitle);

    const counts = document.createElement('div');
    counts.className = 'dqp-counts';
    ['严重', '一般', '提示'].forEach((level) => {
      const count = document.createElement('span');
      count.className = 'dqp-count';
      count.dataset.level = level;
      count.textContent = `${level} ${issues.filter((issue) => issue.level === level).length}`;
      counts.appendChild(count);
    });
    body.appendChild(counts);

    if (!issues.length) {
      const pass = document.createElement('div');
      pass.className = 'dqp-pass';
      pass.textContent = '当前本地规则未发现明显问题，仍请医生结合实际情况复核。';
      body.appendChild(pass);
    } else {
      issues.forEach((issue) => {
        const card = document.createElement('div');
        card.className = 'dqp-issue';
        card.dataset.level = issue.level;
        const head = document.createElement('div');
        head.className = 'dqp-issue-head';
        const level = document.createElement('span');
        level.className = 'dqp-level';
        level.textContent = `[${issue.level}]`;
        const title = document.createElement('span');
        title.className = 'dqp-issue-title';
        title.textContent = issue.title;
        const message = document.createElement('div');
        message.className = 'dqp-issue-text';
        message.textContent = issue.message;
        head.append(level, title);
        card.append(head, message);
        body.appendChild(card);
      });
    }

    const details = document.createElement('details');
    const detailsTitle = document.createElement('summary');
    detailsTitle.textContent = `查看识别字段（${foundCount}/${fields.length}）`;
    const fieldList = document.createElement('div');
    fieldList.className = 'dqp-fields';
    fields.forEach(({ name, value }) => {
      const card = document.createElement('div');
      card.className = 'dqp-field';
      const label = document.createElement('div');
      label.className = 'dqp-label';
      label.textContent = name;
      const content = document.createElement('div');
      content.className = `dqp-value${value ? '' : ' dqp-empty'}`;
      content.textContent = value || '未识别';
      card.append(label, content);
      fieldList.appendChild(card);
    });
    details.append(detailsTitle, fieldList);
    body.appendChild(details);

    const aiBox = document.createElement('div');
    aiBox.className = 'dqp-ai-box';
    body.insertBefore(aiBox, details);
  }

  const warning = document.createElement('div');
  warning.className = 'dqp-warning';
  warning.textContent = !looksLikeRecordPage
    ? '当前页面不像电子病历详情页，请进入“电子病历”后重试。'
    : !record
      ? '请点击某份病历的“展开详情”，然后再次运行页面探测。'
      : '质检规则仍处于单机构测试阶段；“未识别”也可能表示字段位于其他页面，请人工确认。';
  body.appendChild(warning);

  const actions = document.createElement('div');
  actions.className = 'dqp-actions';
  if (record) {
    const makeRecordForAi = () => ({
      recordText: trimUiText(normalize(structuredBody?.innerText || '')),
      caseType: fieldMap['病例类型'], complaint: fieldMap['主诉'],
      presentHistory: fieldMap['现病史'], pastHistory: fieldMap['既往史'],
      allergies: fieldMap['过敏史'], oralExam: fieldMap['口腔检查'],
      auxiliaryExam: fieldMap['辅助检查'], diagnosis: fieldMap['诊断'],
      plan: fieldMap['治疗计划'], action: fieldMap['处置'], advice: fieldMap['医嘱']
    });
    const aiButton = document.createElement('button');
    aiButton.className = 'dqp-button dqp-primary';
    aiButton.type = 'button';
    aiButton.textContent = 'AI深度复核';
    aiButton.addEventListener('click', async () => {
      const approved = window.confirm(
        '将把当前病例的脱敏字段发送到本机 127.0.0.1 服务，并由本机服务转发给 DeepSeek API。\n\n' +
        '发送范围：当前展开病例正文，以及病例类型、主诉、病史、过敏史、检查、诊断、治疗计划、处置、医嘱。\n' +
        '不会发送：姓名、电话、身份证号、病历号、医生、诊所、收费信息。\n\n是否继续？'
      );
      if (!approved) return;

      const aiBox = body.querySelector('.dqp-ai-box');
      aiBox.replaceChildren();
      aiButton.disabled = true;
      aiButton.textContent = 'AI复核中…';

      const recordForAi = makeRecordForAi();

      try {
        const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_AI', record: recordForAi });
        if (!response?.ok) throw new Error(response?.error || 'AI复核失败');
        const result = response.data;
        const title = document.createElement('div');
        title.className = 'dqp-section-title';
        title.textContent = 'AI深度复核';
        aiBox.appendChild(title);

        if (result.summary) {
          const summary = document.createElement('p');
          summary.className = 'dqp-summary';
          summary.textContent = result.summary;
          aiBox.appendChild(summary);
        }

        (result.issues || []).forEach((issue) => {
          const card = document.createElement('div');
          card.className = 'dqp-issue';
          card.dataset.level = issue.level;
          const head = document.createElement('div');
          head.className = 'dqp-issue-head';
          const level = document.createElement('span');
          level.className = 'dqp-level';
          level.textContent = `[${issue.category || '病历质量'} · ${issue.certainty || '疑似风险'} · ${issue.level}]`;
          const issueTitle = document.createElement('span');
          issueTitle.className = 'dqp-issue-title';
          issueTitle.textContent = issue.title;
          const message = document.createElement('div');
          message.className = 'dqp-issue-text';
          const parts = [issue.reason];
          if (Array.isArray(issue.evidenceSources) && issue.evidenceSources.length) parts.push(`证据来源：${issue.evidenceSources.join('、')}`);
          if (issue.suggestion) parts.push(`修改建议：${issue.suggestion}`);
          if (issue.rewriteTemplate) parts.push(`建议写法：${issue.rewriteTemplate}`);
          if (Array.isArray(issue.needConfirm) && issue.needConfirm.length) {
            parts.push(`修改前需确认：${issue.needConfirm.join('；')}`);
          }
          message.textContent = parts.filter(Boolean).join('\n');
          head.append(level, issueTitle);
          card.append(head, message);
          aiBox.appendChild(card);
        });

        if (!(result.issues || []).length) {
          const pass = document.createElement('div');
          pass.className = 'dqp-pass';
          pass.textContent = 'AI未发现额外问题，仍请医生结合实际情况复核。';
          aiBox.appendChild(pass);
        }
      } catch (error) {
        const message = document.createElement('div');
        message.className = 'dqp-ai-error';
        message.textContent = `${error?.message || 'AI复核失败'}。请确认本机服务已启动且API Key有效。`;
        aiBox.appendChild(message);
      } finally {
        aiButton.disabled = false;
        aiButton.textContent = '重新AI复核';
      }
    });
    // AI功能统一放入下方“综合风险分析”，病历质检仅保留本地规则。

    const crossButton = document.createElement('button');
    crossButton.className = 'dqp-button'; crossButton.type = 'button';
    crossButton.textContent = '综合风险分析';
    crossButton.addEventListener('click', async () => {
      const captured = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_GET_CAPTURE', patientKey });
      if (!captured?.ok) return alert(captured?.error || '读取采集数据失败');
      const bundle = captured.bundle || {};
      const names = { electronicMedicalRecord:'电子病历', patientInfo:'患者信息', visitRecords:'就诊记录', chargeRecords:'收费记录', imagingRecords:'影像记录', procedureRecords:'处置记录', documentRecords:'文档与同意书' };
      const present = Object.keys(bundle).filter((key) => names[key]);
      if (!present.length) return alert('尚未采集其他页面。请依次进入就诊记录、收费、影像、处置记录，点击扩展并采集本页。');
      const approved = window.confirm(
        `将把当前脱敏病历与已采集的${present.map((key) => names[key]).join('、')}发送到本机服务，再转发给 DeepSeek 交叉复核。\n\n` +
        '信息仅用于日期、牙位、项目、状态及记录一致性检查；不会修改 e看牙。是否继续？'
      );
      if (!approved) return;
      crossButton.disabled = true; crossButton.textContent = '综合分析中…';
      const aiBox = body.querySelector('.dqp-ai-box'); aiBox.replaceChildren();
      try {
        const payload = makeRecordForAi();
        Object.entries(bundle).forEach(([key, value]) => { if (names[key]) payload[key] = value?.text || ''; });
        const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_AI', record: payload });
        if (!response?.ok) throw new Error(response?.error || '综合复核失败');
        const title = document.createElement('div'); title.className = 'dqp-section-title'; title.textContent = '综合风险分析';
        aiBox.appendChild(title);
        const scope = document.createElement('p'); scope.className = 'dqp-summary';
        scope.textContent = `本次已对比：电子病历、${present.map((key) => names[key]).join('、')}。未采集页面不作缺失判断。`;
        aiBox.appendChild(scope);
        if (response.data?.summary) { const p = document.createElement('p'); p.className = 'dqp-summary'; p.textContent = response.data.summary; aiBox.appendChild(p); }
        (response.data?.issues || []).forEach((issue) => {
          const card = document.createElement('div'); card.className = 'dqp-issue'; card.dataset.level = issue.level;
          const head = document.createElement('div'); head.className = 'dqp-issue-head';
          head.textContent = `[${issue.category || '病历质量'} · ${issue.certainty || '疑似风险'} · ${issue.level}] ${issue.title}`;
          const msg = document.createElement('div'); msg.className = 'dqp-issue-text';
          msg.textContent = [issue.evidenceSources?.length && `证据来源：${issue.evidenceSources.join('、')}`, issue.reason, issue.suggestion && `建议：${issue.suggestion}`, issue.rewriteTemplate && `建议写法：${issue.rewriteTemplate}`, issue.needConfirm?.length && `需确认：${issue.needConfirm.join('；')}`].filter(Boolean).join('\n');
          card.append(head, msg); aiBox.appendChild(card);
        });
      } catch (error) {
        const message = document.createElement('div'); message.className = 'dqp-ai-error'; message.textContent = `${error?.message || '综合复核失败'}。`;
        aiBox.appendChild(message);
      } finally { crossButton.disabled = false; crossButton.textContent = '重新综合分析'; }
    });
    // 综合风险分析统一从扩展弹窗入口启动，此处不再显示重复按钮。
  }
  const refresh = document.createElement('button');
  refresh.className = 'dqp-button';
  refresh.type = 'button';
  refresh.textContent = '重新识别';
  refresh.addEventListener('click', () => {
    root.remove();
    const script = document.createElement('script');
    script.textContent = '';
    document.documentElement.appendChild(script);
    script.remove();
    alert('请再次点击浏览器工具栏中的扩展按钮运行探测。');
  });
  actions.appendChild(refresh);
  body.appendChild(actions);

  root.append(header, body);
  document.documentElement.appendChild(root);
})();
