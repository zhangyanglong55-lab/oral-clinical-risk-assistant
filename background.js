const LOCAL_API = 'http://127.0.0.1:8787';
const API_KEY_STORAGE = 'dentalQcDeepSeekApiKey';

const getStoredApiKey = async () => {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE);
  return String(stored[API_KEY_STORAGE] || '').trim();
};

const waitForTab = (tabId, timeout = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('页面加载超时')); }, timeout);
  const listener = (id, info) => {
    if (id === tabId && info.status === 'complete') {
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
});

async function autoCapture(tabId, patientKey, originalUrl) {
  const base = 'https://bszyk.linkedcare.cn/ares3/#/patient';
  const medicalRecordUrl = `${base}/patientgeneralMedicalRecords/${patientKey}/emr/list`;
  let finalMedicalRecordUrl = medicalRecordUrl;
  const targets = [
    ['electronicMedicalRecord', originalUrl, '电子病历'],
    ['patientInfo', originalUrl, '患者信息'],
    ['documentRecords', originalUrl, '文档'],
    ['visitRecords', `${base}/info/${patientKey}/apptRecord`],
    ['chargeRecords', `${base}/charge/${patientKey}/order-records`],
    ['imagingRecords', `${base}/imaging/${patientKey}/imagingHistory`],
    ['procedureRecords', `${base}/info/${patientKey}/diagnoseRecord`]
  ];
  const key = `dentalQc:${patientKey}`;
  const saved = {};
  let reportReady = false;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const [module, url, menuLabel] = targets[index];
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0aa7c4' });
      await chrome.action.setBadgeText({ tabId, text: `${index + 1}/7` });
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url === url) {
        await chrome.tabs.reload(tabId);
        await new Promise((resolve) => setTimeout(resolve, 2200));
      } else {
        await chrome.tabs.update(tabId, { url });
        // e看牙是 hash 路由单页应用，切换模块时通常不会产生 complete 事件。
        await new Promise((resolve) => setTimeout(resolve, 2200));
      }
      if (menuLabel) {
        await chrome.scripting.executeScript({
          target: { tabId },
          args: [menuLabel],
          func: (label) => {
            const entry = [...document.querySelectorAll('span,li,a')]
              .find((node) => node.textContent?.trim() === label);
            (entry?.closest('li,a') || entry)?.click();
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }
      if (module === 'electronicMedicalRecord') {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const expand = [...document.querySelectorAll('a,button,span')]
              .find((node) => node.textContent?.trim() === '展开详情' && node.getClientRects().length);
            expand?.click();
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        finalMedicalRecordUrl = (await chrome.tabs.get(tabId)).url || medicalRecordUrl;
      }
      const [{ result = '' } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [module],
        func: (currentModule) => {
          if (currentModule === 'electronicMedicalRecord') {
            const bodies = [...document.querySelectorAll('.medical-record-text-body')]
              .filter((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              })
              .sort((left, right) => {
                const a = Math.abs(left.getBoundingClientRect().top + left.getBoundingClientRect().height / 2 - innerHeight / 2);
                const b = Math.abs(right.getBoundingClientRect().top + right.getBoundingClientRect().height / 2 - innerHeight / 2);
                return a - b;
              });
            return String(bodies[0]?.innerText || '').slice(0, 6000);
          }
          if (currentModule === 'patientInfo') {
            const allowed = ['年龄', '性别', '患者类型', '血型', '婚姻', '文化程度'];
            return allowed.map((label) => {
              const node = [...document.querySelectorAll('label,span,div,p')]
                .find((element) => element.children.length === 0 && element.textContent?.trim().replace(/[：:]$/, '') === label);
              const containerText = node?.parentElement?.innerText || '';
              const value = containerText.replace(node?.textContent || '', '').trim().split('\n')[0].slice(0, 30);
              return value ? `${label}：${value}` : '';
            }).filter(Boolean).join('\n');
          }
          if (currentModule === 'documentRecords') {
            const visible = [...document.querySelectorAll('a,li,div,span,p')]
              .filter((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              })
              .filter((element) => element.children.length === 0)
              .map((element) => element.textContent?.trim() || '')
              .filter((text) => text && text.length <= 100 && /(同意书|知情|告知书|签名|签署|已签|未签|拒签|\d{4}-\d{2}-\d{2})/.test(text));
            return [...new Set(visible)].slice(0, 200).join('\n');
          }
          return String(document.body?.innerText || '')
            .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
            .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号已脱敏]')
            .replace(/(?:姓名|患者姓名)\s*[：:]\s*[^，。；;\n]{1,20}/g, '姓名：[已脱敏]')
            .slice(0, 6000);
        }
      });
      saved[module] = { text: result, capturedAt: Date.now() };
      await chrome.storage.session.set({ [key]: { ...(await chrome.storage.session.get(key))[key], ...saved } });
    }
    const record = {
      recordText: saved.electronicMedicalRecord?.text || '',
      electronicMedicalRecord: saved.electronicMedicalRecord?.text || '',
      patientInfo: saved.patientInfo?.text || '',
      visitRecords: saved.visitRecords?.text || '',
      chargeRecords: saved.chargeRecords?.text || '',
      imagingRecords: saved.imagingRecords?.text || '',
      procedureRecords: saved.procedureRecords?.text || '',
      documentRecords: saved.documentRecords?.text || ''
    };
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' });
    await chrome.action.setBadgeText({ tabId, text: 'AI' });
    const apiKey = await getStoredApiKey();
    const aiResponse = await fetch(`${LOCAL_API}/api/qc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record, apiKey })
    });
    const aiResult = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) throw new Error(aiResult.error || `综合分析服务返回 ${aiResponse.status}`);
    await chrome.storage.session.set({ [`${key}:report`]: aiResult });
    reportReady = true;
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
    await chrome.action.setBadgeText({ tabId, text: '完成' });
  } catch (error) {
    const safeError = error?.message || '自动采集或AI分析失败';
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    await chrome.action.setBadgeText({ tabId, text: '失败' });
    await chrome.storage.session.set({
      [`${key}:error`]: safeError,
      [`${key}:report`]: { failed: true, error: safeError }
    });
    reportReady = true;
  } finally {
    try {
      if (reportReady) {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['panel.css'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['report.js'] });
      } else if (originalUrl) {
        await chrome.tabs.update(tabId, { url: originalUrl });
      }
    } catch (_error) {
      if (originalUrl) await chrome.tabs.update(tabId, { url: originalUrl }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'DENTAL_QC_CONFIG_GET') {
    getStoredApiKey().then((apiKey) => sendResponse({ ok: true, configured: Boolean(apiKey) }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '读取配置失败' }));
    return true;
  }
  if (message?.type === 'DENTAL_QC_CONFIG_SAVE') {
    const apiKey = String(message.apiKey || '').trim();
    if (!apiKey || apiKey.length < 12) {
      sendResponse({ ok: false, error: 'API Key格式不正确' });
      return false;
    }
    chrome.storage.local.set({ [API_KEY_STORAGE]: apiKey })
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || '保存失败' }));
    return true;
  }
  if (message?.type === 'DENTAL_QC_CONFIG_CLEAR') {
    chrome.storage.local.remove(API_KEY_STORAGE)
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || '清除失败' }));
    return true;
  }
  if (message?.type === 'DENTAL_QC_HEALTH') {
    Promise.all([fetch(`${LOCAL_API}/health`), getStoredApiKey()])
      .then(async ([response, storedKey]) => {
        const data = await response.json().catch(() => ({}));
        sendResponse({ ok: response.ok, ...data, configured: Boolean(storedKey || data.configured) });
      })
      .catch(() => sendResponse({ ok: false, error: '本机AI服务未启动' }));
    return true;
  }
  if (message?.type === 'DENTAL_QC_AUTO_CAPTURE') {
    autoCapture(message.tabId, message.patientKey, message.originalUrl);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'DENTAL_QC_CAPTURE') {
    const key = `dentalQc:${message.patientKey}`;
    chrome.storage.session.get(key).then((current) => {
      const bundle = current[key] || {};
      bundle[message.module] = { text: message.text, capturedAt: Date.now() };
      return chrome.storage.session.set({ [key]: bundle }).then(() => bundle);
    }).then((bundle) => sendResponse({ ok: true, modules: Object.keys(bundle) }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '暂存失败' }));
    return true;
  }

  if (message?.type === 'DENTAL_QC_GET_CAPTURE') {
    const key = `dentalQc:${message.patientKey}`;
    chrome.storage.session.get(key).then((current) => sendResponse({ ok: true, bundle: current[key] || {} }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '读取暂存失败' }));
    return true;
  }

  if (message?.type === 'DENTAL_QC_GET_REPORT') {
    const key = `dentalQc:${message.patientKey}:report`;
    chrome.storage.session.get(key).then((current) => sendResponse({ ok: true, report: current[key] || null }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '读取报告失败' }));
    return true;
  }

  if (message?.type !== 'DENTAL_QC_AI') return false;

  getStoredApiKey()
    .then((apiKey) => fetch(`${LOCAL_API}/api/qc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: message.record, apiKey })
    }))
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `本机服务返回 ${response.status}`);
      sendResponse({ ok: true, data });
    })
    .catch((error) => sendResponse({
      ok: false,
      error: error?.message || '无法连接本机AI质检服务'
    }));

  return true;
});
