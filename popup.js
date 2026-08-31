const button = document.querySelector('#probe');
const status = document.querySelector('#status');
const autoCapture = document.querySelector('#autoCapture');
const apiKeyInput = document.querySelector('#apiKey');
const saveApiKey = document.querySelector('#saveApiKey');
const clearApiKey = document.querySelector('#clearApiKey');
const apiStatus = document.querySelector('#apiStatus');

chrome.runtime.sendMessage({ type: 'DENTAL_QC_CONFIG_GET' }).then((response) => {
  if (response?.configured) {
    apiKeyInput.placeholder = '已保存（输入新Key可替换）';
    apiStatus.textContent = 'API Key已保存在当前浏览器中。';
  }
}).catch(() => {});

saveApiKey.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  apiStatus.classList.remove('error');
  if (!apiKey) {
    apiStatus.classList.add('error'); apiStatus.textContent = '请输入API Key。'; return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_CONFIG_SAVE', apiKey });
  apiKeyInput.value = '';
  if (!response?.ok) {
    apiStatus.classList.add('error'); apiStatus.textContent = response?.error || '保存失败。'; return;
  }
  apiKeyInput.placeholder = '已保存（输入新Key可替换）';
  apiStatus.textContent = '保存成功，综合风险分析将自动使用该Key。';
});

clearApiKey.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_CONFIG_CLEAR' });
  if (!response?.ok) {
    apiStatus.classList.add('error'); apiStatus.textContent = response?.error || '清除失败。'; return;
  }
  apiKeyInput.value = ''; apiKeyInput.placeholder = 'sk-…';
  apiStatus.classList.remove('error'); apiStatus.textContent = 'API Key已从当前浏览器中清除。';
});

autoCapture.addEventListener('click', async () => {
  const health = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_HEALTH' }).catch(() => null);
  if (!health?.ok) {
    status.classList.add('error');
    status.textContent = '本机AI服务未启动。请先填写AI配置.txt，再双击“启动AI服务.command”。';
    return;
  }
  if (!health.configured) {
    status.classList.add('error');
    status.textContent = '尚未配置API Key，请先填写AI配置.txt。';
    return;
  }
  const approved = window.confirm(
    '综合风险分析将采集当前患者的电子病历、患者信息、就诊、收费、影像、处置和文档信息，脱敏后经本机服务发送给 DeepSeek API。\n\n' +
    '仅用于风险提示，不修改 e看牙 数据。是否继续？'
  );
  if (!approved) return;
  autoCapture.disabled = true;
  status.classList.remove('error');
  status.textContent = '综合风险分析正在采集七个模块，请勿操作页面…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const patientKey = (tab?.url || '').match(/\/patient\/(?:[^/]+\/)?(\d{4,})/)?.[1];
    if (!tab?.id || !patientKey || !/linkedcare\.cn/.test(tab.url || '')) {
      throw new Error('请先打开该患者的 e看牙 页面。');
    }
    const response = await chrome.runtime.sendMessage({ type: 'DENTAL_QC_AUTO_CAPTURE', tabId: tab.id, patientKey, originalUrl: tab.url });
    if (!response?.ok) throw new Error(response?.error || '自动采集启动失败');
    status.textContent = '综合分析已开始，完成后将返回电子病历并自动显示报告。';
  } catch (error) {
    status.classList.add('error'); status.textContent = error?.message || '自动采集启动失败。';
  } finally { autoCapture.disabled = false; }
});

button.addEventListener('click', async () => {
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = '正在进行病历质检…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      throw new Error('请先打开 e看牙 网页端病例页面。');
    }

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['panel.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const expand = [...document.querySelectorAll('a,button,span')]
          .find((node) => node.textContent?.trim() === '展开详情' && node.getClientRects().length);
        expand?.click();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    status.textContent = '病历质检面板已显示在页面右侧。';
  } catch (error) {
    status.classList.add('error');
    status.textContent = error?.message || '页面探测启动失败。';
  } finally {
    button.disabled = false;
  }
});
