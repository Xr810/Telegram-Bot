export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Webhook 注册
    if (url.pathname === '/registerWebhook') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.TELEGRAM_AVAILABLE_TOKENS) return new Response('Auth Fail', { status: 403 });
      const webhookUrl = `${url.protocol}//${url.hostname}/`;
      await fetch(`https://api.telegram.org/bot${secret}/setWebhook?url=${webhookUrl}`);
      return new Response('Webhook Set OK');
    }

    // 2. 消息处理主逻辑
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        
        if (update.message) {
          const chatId = update.message.chat.id.toString();
          const NOW = Date.now();
          
          // --- 鉴权 ---
          const whiteList = (env.CHAT_WHITE_LIST || '').split(',');
          if (whiteList.length > 0 && !whiteList.includes(chatId)) return new Response('Unauthorized');

          // --- 读取 KV 状态 ---
          let session = await env.TG_DB.get(chatId, { type: "json" });
          // 初始化 session，增加 lastActive 字段
          if (!session) session = { model: "deepseek/deepseek-v3.2", history: [], lastActive: NOW };

          // ==========================================
          // ⏳ 自动超时检测 (10分钟 = 600000ms)
          // ==========================================
          const TIMEOUT_MS = 10 * 60 * 1000;
          // 只有当不是 /retry 指令时才检查超时（否则重试会把自己重置了）
          if (update.message.text !== '/retry') {
            if (session.lastActive && (NOW - session.lastActive > TIMEOUT_MS)) {
              session.model = "deepseek/deepseek-v3.2";
              session.history = [];
              // 发送一条静默提示（或者你可以选择不发）
              await sendTelegramMessage(env, chatId, "💤 会话已闲置超过 10 分钟，记忆已清空，模型归位。");
            }
          }
          // 更新活跃时间
          session.lastActive = NOW;

          // --- 提取内容 ---
          let userText = "";
          let photoBase64 = null;
          let fileId = null; // 新增：保存文件ID用于重试
          let isImageMessage = false;

          if (update.message.text) {
            userText = update.message.text.trim();
          } else if (update.message.photo) {
            const photoArray = update.message.photo;
            fileId = photoArray[photoArray.length - 1].file_id; // 拿最高清的
            userText = update.message.caption || "请分析这张图片";
            isImageMessage = true;
            await sendTelegramMessage(env, chatId, "👀 正在接收图片数据...");
            photoBase64 = await getTelegramPhotoAsBase64(env, fileId);
          } else {
            return new Response('OK'); 
          }

          // ==========================================
          // 🎮 指令控制台
          // ==========================================
          if (!isImageMessage) {
            // 基础指令处理 (省略部分重复代码，逻辑与之前一致)
            if (['/s', '/search'].includes(userText)) {
              session.model = "perplexity/sonar-deep-research"; session.history = [];
              await updateSession(env, chatId, session);
              await sendTelegramMessage(env, chatId, "🌐 已切换为 **联网搜索模式**"); return new Response('OK');
            }
            if (['/pro', '/g'].includes(userText)) {
              session.model = "google/gemini-3-flash-preview"; session.history = [];
              await updateSession(env, chatId, session);
              await sendTelegramMessage(env, chatId, "⚡ 已切换为 **进阶模式 (Gemini 3)**"); return new Response('OK');
            }
            if (['/reset'].includes(userText)) {
              session.model = "deepseek/deepseek-v3.2"; session.history = [];
              await updateSession(env, chatId, session);
              await sendTelegramMessage(env, chatId, "🦄 已重置为 **DeepSeek** (记忆已清空)"); return new Response('OK');
            }
            if (['/basic'].includes(userText)) {
              session.model = "deepseek/deepseek-v3.2";
              await updateSession(env, chatId, session);
              await sendTelegramMessage(env, chatId, "🦄 已切回 **DeepSeek** (记忆已保留)"); return new Response('OK');
            }

            // 🔥【Retry】增强版：支持图片重试
            if (userText === '/retry') {
              if (session.history.length === 0) {
                 await sendTelegramMessage(env, chatId, "⚠️ 无历史记录。"); return new Response('OK');
              }

              // 移除最后一条 AI 回复
              const lastMsg = session.history[session.history.length - 1];
              if (lastMsg.role === 'assistant') session.history.pop();

              // 获取上一条用户消息
              const lastUserMsg = session.history[session.history.length - 1];
              if (!lastUserMsg || lastUserMsg.role !== 'user') {
                await sendTelegramMessage(env, chatId, "⚠️ 找不到上一条用户消息，无法重试。"); return new Response('OK');
              }

              // 检查上一条消息是否包含 file_id (是不是图片)
              let retryPhotoBase64 = null;
              if (lastUserMsg.file_id) {
                await sendTelegramMessage(env, chatId, "🔄 正在重新下载图片...");
                retryPhotoBase64 = await getTelegramPhotoAsBase64(env, lastUserMsg.file_id);
              }

              // 发送重试占位符
              const retryMsg = await sendTelegramMessage(env, chatId, `🔄 [${session.model.split('/')[1]}] 正在重试...`);
              const retryMsgId = retryMsg.result ? retryMsg.result.message_id : null;

              // 重新构造请求
              let retryMessages = buildApiMessages(env, session, session.model);
              // 如果是图片，特殊构造
              if (retryPhotoBase64) {
                // 替换掉 retryMessages 里的最后一条纯文本，改为带图的 payload
                retryMessages.pop(); 
                retryMessages.push({
                   role: "user",
                   content: [
                     { type: "text", text: lastUserMsg.content }, // content 里存的是 caption
                     { type: "image_url", image_url: { url: `data:image/jpeg;base64,${retryPhotoBase64}` } }
                   ]
                });
              }

              // 视觉回退检查
              let targetModel = session.model;
              if (retryPhotoBase64 && (targetModel.includes("deepseek") || targetModel.includes("perplexity"))) {
                targetModel = "google/gemini-3-flash-preview";
              }

              const newResponse = await callOpenRouter(env, retryMessages, targetModel);

              // 存入历史并保存
              session.history.push({ role: "assistant", content: newResponse });
              await updateSession(env, chatId, session);

              if (retryMsgId) await editTelegramMessage(env, chatId, retryMsgId, newResponse);
              else await sendTelegramMessage(env, chatId, newResponse);
              
              return new Response('OK');
            }
          }

          // ==========================================
          // 🧠 普通消息处理
          // ==========================================
          
          let currentModel = session.model;
          let tempSwitchMsg = null;
          
          // 视觉回退
          if (isImageMessage && (currentModel.includes("deepseek") || currentModel.includes("perplexity"))) {
            currentModel = "google/gemini-3-flash-preview"; 
            tempSwitchMsg = "⚠️ DeepSeek 看不见，临时切换 Gemini 3 之眼...";
          }

          const statusText = tempSwitchMsg || `⏳ [${currentModel.split('/')[1]}] 正在思考...`;
          const placeholderMsg = await sendTelegramMessage(env, chatId, statusText);
          const placeholderMsgId = placeholderMsg.result ? placeholderMsg.result.message_id : null;

          // 构造消息
          let messages = buildApiMessages(env, session, currentModel);
          if (isImageMessage && photoBase64) {
             messages.push({
               role: "user",
               content: [
                 { type: "text", text: userText },
                 { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photoBase64}` } }
               ]
             });
          } else {
             messages.push({ role: "user", content: userText });
          }

          const aiResponse = await callOpenRouter(env, messages, currentModel);

          // 更新历史 (关键：存入 file_id)
          session.history.push({ 
            role: "user", 
            content: userText, // 存文本用于显示
            file_id: isImageMessage ? fileId : null // 存 file_id 用于重试
          });
          session.history.push({ role: "assistant", content: aiResponse });
          
          if (session.history.length > 12) session.history = session.history.slice(session.history.length - 12);
          await updateSession(env, chatId, session);

          if (placeholderMsgId) await editTelegramMessage(env, chatId, placeholderMsgId, aiResponse);
          else await sendTelegramMessage(env, chatId, aiResponse);
        }
      } catch (e) {
        console.error(e);
      }
      return new Response('OK');
    }
    return new Response('Max Bot V7.0 (Auto-Reset + Image Retry) is Ready!');
  }
};

// --- 辅助函数 ---

// 统一更新 session 到 KV
async function updateSession(env, chatId, session) {
  // 更新时刷新时间戳
  session.lastActive = Date.now();
  await env.TG_DB.put(chatId, JSON.stringify(session));
}

// 构建发给 OpenRouter 的消息列表 (过滤掉 file_id 等脏数据)
function buildApiMessages(env, session, currentModel) {
  let messages = [];
  if (!currentModel.includes('perplexity') && env.SYSTEM_PROMPT) {
    messages.push({ role: "system", content: env.SYSTEM_PROMPT });
  }
  // 遍历历史，只提取 role 和 content，过滤掉 file_id
  session.history.forEach(msg => {
    messages.push({ role: msg.role, content: msg.content });
  });
  return messages;
}

async function getTelegramPhotoAsBase64(env, fileId) {
  try {
    const fileApi = `https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/getFile?file_id=${fileId}`;
    const fileResp = await fetch(fileApi);
    const fileData = await fileResp.json();
    if (!fileData.ok) return null;
    const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_AVAILABLE_TOKENS}/${fileData.result.file_path}`;
    const imageResp = await fetch(downloadUrl);
    const arrayBuffer = await imageResp.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch (e) { return null; }
}

async function callOpenRouter(env, messages, modelId) {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://max.hku.hk",
        "X-Title": "Max-TG-Bot"
      },
      body: JSON.stringify({ model: modelId, messages: messages })
    });
    const data = await resp.json();
    if (data.error) return `❌ API Error: ${data.error.message}`;
    return data.choices?.[0]?.message?.content || "⚠️ 无内容返回";
  } catch (e) { return `❌ Request Error: ${e.message}`; }
}

async function sendTelegramMessage(env, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
  return await resp.json();
}

async function editTelegramMessage(env, chatId, messageId, text) {
  let resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" })
  });
  const data = await resp.json();
  if (!data.ok) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text })
    });
  }
}
