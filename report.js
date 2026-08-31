(() => {
  const ROOT_ID = 'dental-qc-probe-root';
  document.getElementById(ROOT_ID)?.remove();
  const patientKey = (location.hash || '').match(/\/patient\/(?:[^/]+\/)?(\d{4,})/)?.[1] || 'current';

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const root = element('aside'); root.id = ROOT_ID;
  const header = element('div', 'dqp-head');
  const heading = element('div');
  heading.append(element('div', 'dqp-title', '综合风险分析'), element('div', 'dqp-subtitle', '七模块 · AI交叉复核 · 只读'));
  const close = element('button', 'dqp-close', '×'); close.type = 'button'; close.addEventListener('click', () => root.remove());
  header.append(heading, close);
  const body = element('div', 'dqp-body');
  body.append(element('p', 'dqp-notice', '结果仅用于记录与流程风险提示，不能替代医生判断，也不能直接认定误诊、违规收费或未履行告知。'));
  const loading = element('p', 'dqp-summary', '正在读取综合分析报告…'); body.append(loading);
  root.append(header, body); document.documentElement.appendChild(root);

  chrome.runtime.sendMessage({ type: 'DENTAL_QC_GET_REPORT', patientKey }).then((response) => {
    loading.remove();
    if (!response?.ok || !response.report) throw new Error(response?.error || '尚未生成综合分析报告');
    const report = response.report;
    if (report.failed) {
      body.append(element('div', 'dqp-ai-error', `综合分析失败：${report.error || '未知错误'}`));
      body.append(element('p', 'dqp-summary', '请根据上方原因检查本机AI服务或当前页面，然后重新从扩展入口运行。'));
      return;
    }
    body.append(element('p', 'dqp-summary', report.summary || '综合分析已完成。'));

    const levelRank = { '严重': 0, '一般': 1, '提示': 2 };
    const certaintyRank = { '明确矛盾': 0, '疑似风险': 1, '数据不足': 2 };
    const categoryRank = { '医疗安全与连续性': 0, '收费及执行一致性': 1, '投诉与合规风险': 2, '病历质量': 3 };
    const issues = (Array.isArray(report.issues) ? [...report.issues] : [])
      .sort((left, right) =>
        (levelRank[left?.level] ?? 9) - (levelRank[right?.level] ?? 9) ||
        (certaintyRank[left?.certainty] ?? 9) - (certaintyRank[right?.certainty] ?? 9) ||
        (categoryRank[left?.category] ?? 9) - (categoryRank[right?.category] ?? 9)
      );
    const counts = element('div', 'dqp-counts');
    ['严重', '一般', '提示'].forEach((level) => {
      const count = element('span', 'dqp-count', `${level} ${issues.filter((issue) => issue.level === level).length}`);
      count.dataset.level = level;
      counts.append(count);
    });
    body.append(counts);

    if (!issues.length) body.append(element('div', 'dqp-pass', '本次分析未发现明显跨模块风险，仍请结合原始记录人工复核。'));
    issues.forEach((issue) => {
      const card = element('div', 'dqp-issue'); card.dataset.level = issue.level || '提示';
      const meta = element('div', 'dqp-risk-meta');
      meta.append(
        element('span', 'dqp-risk-badge dqp-risk-category', issue.category || '综合风险'),
        element('span', 'dqp-risk-badge dqp-risk-certainty', issue.certainty || '疑似风险'),
        element('span', 'dqp-risk-badge dqp-risk-level', issue.level || '提示')
      );
      card.append(meta, element('div', 'dqp-risk-title', issue.title || '建议复核'));
      const addSection = (label, value, className = '') => {
        if (!value) return;
        const section = element('div', `dqp-risk-section ${className}`.trim());
        section.append(element('div', 'dqp-risk-section-label', label), element('div', 'dqp-risk-section-text', value));
        card.append(section);
      };
      addSection('证据来源', issue.evidenceSources?.join('、'), 'dqp-risk-evidence');
      addSection('风险依据', issue.reason);
      addSection('处理建议', issue.suggestion);
      addSection('建议写法', issue.rewriteTemplate);
      addSection('需要确认', issue.needConfirm?.join('；'), 'dqp-risk-confirm');
      body.append(card);
    });
  }).catch((error) => {
    loading.remove(); body.append(element('div', 'dqp-ai-error', error?.message || '报告读取失败'));
  });
})();
