/**
 * Telegram AI bot on Cloudflare Workers.
 *
 * Acknowledges the webhook immediately and does the model call in ctx.waitUntil(),
 * because Telegram redelivers any update it considers slow. Session history and the
 * per-message dedup lock both live in Workers KV.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/registerWebhook') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.TELEGRAM_AVAILABLE_TOKENS) return new Response('Auth Fail', { status: 403 });
      const webhookUrl = `${url.protocol}//${url.hostname}/`;
      await fetch(`https://api.telegram.org/bot${secret}/setWebhook?url=${webhookUrl}`);
      return new Response('Webhook Set OK');
    }

    if (request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, env));
        return new Response('OK');
      } catch (e) {
        console.error(e);
        return new Response('Error', { status: 500 });
      }
    }
    return new Response('Max Bot V15.0 is Ready!');
  }
};

// ==========================================
// ⚙️ 后台处理逻辑
// ==========================================
async function handleUpdate(update, env) {
  if (!update.message) return;

  const chatId = update.message.chat.id.toString();
  const messageId = update.message.message_id.toString();
  const NOW = Date.now();

  // 🔒 防重锁
  const lockKey = `processed:${chatId}:${messageId}`;
  if (await env.TG_DB.get(lockKey)) return;
  await env.TG_DB.put(lockKey, "1", { expirationTtl: 300 });

  // 鉴权
  // Fail closed: the Worker URL is public and every reply costs credit,
  // so an unset whitelist blocks everyone rather than allowing everyone.
  const whiteList = (env.CHAT_WHITE_LIST || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!whiteList.includes(chatId)) return;

  // 读取 KV
  let session = await env.TG_DB.get(chatId, { type: "json" });
  if (!session) session = { model: "deepseek/deepseek-v3.2", history: [], lastActive: NOW };

  // 超时重置 (10分钟)
  const TIMEOUT_MS = 10 * 60 * 1000;
  if (update.message.text !== '/retry') {
    if (session.lastActive && (NOW - session.lastActive > TIMEOUT_MS)) {
      session.model = "deepseek/deepseek-v3.2";
      session.history = [];
    }
  }
  session.lastActive = NOW;

  // 内容提取
  let userText = "";
  let photoBase64 = null;
  let fileId = null;
  let isImageMessage = false;

  if (update.message.text) {
    userText = update.message.text.trim();
  } else if (update.message.photo) {
    const photoArray = update.message.photo;
    fileId = photoArray[photoArray.length - 1].file_id;
    userText = update.message.caption || "请分析这张图片";
    isImageMessage = true;
    await sendTelegramMessage(env, chatId, "👀 正在接收图片数据...");
    photoBase64 = await getTelegramPhotoAsBase64(env, fileId);
  } else {
    return; 
  }

  // 指令处理
  if (!isImageMessage) {
    if (['/s', '/search'].includes(userText)) {
      // 🔥 已更新为 sonar-pro
      session.model = "perplexity/sonar-pro"; session.history = [];
      await updateSession(env, chatId, session);
      await sendTelegramMessage(env, chatId, "🌐 已切换为 **联网搜索模式 (Sonar Pro)**"); return;
    }
    if (['/pro', '/g'].includes(userText)) {
      session.model = "google/gemini-3-flash-preview"; session.history = [];
      await updateSession(env, chatId, session);
      await sendTelegramMessage(env, chatId, "⚡ 已切换为 **进阶模式 (Gemini 3)**"); return;
    }
    if (['/reset'].includes(userText)) {
      session.model = "deepseek/deepseek-v3.2"; session.history = [];
      await updateSession(env, chatId, session);
      await sendTelegramMessage(env, chatId, "🦄 已重置 (记忆已清空)"); return;
    }
    if (['/basic'].includes(userText)) {
      session.model = "deepseek/deepseek-v3.2";
      await updateSession(env, chatId, session);
      await sendTelegramMessage(env, chatId, "🦄 已切回 **DeepSeek**"); return;
    }

    if (userText === '/retry') {
      if (session.history.length === 0) { await sendTelegramMessage(env, chatId, "⚠️ 无历史记录"); return; }
      const lastMsg = session.history[session.history.length - 1];
      if (lastMsg.role === 'assistant') session.history.pop();
      const lastUserMsg = session.history[session.history.length - 1];
      if (!lastUserMsg || lastUserMsg.role !== 'user') { await sendTelegramMessage(env, chatId, "⚠️ 无法重试"); return; }
      
      let retryPhotoBase64 = null;
      if (lastUserMsg.file_id) {
        await sendTelegramMessage(env, chatId, "🔄 重新下载图片...");
        retryPhotoBase64 = await getTelegramPhotoAsBase64(env, lastUserMsg.file_id);
      }
      
      const retryMsg = await sendTelegramMessage(env, chatId, `🔄 [${session.model.split('/')[1]}] 正在重试...`);
      const retryMsgId = retryMsg.result ? retryMsg.result.message_id : null;
      
      let retryMessages = buildApiMessages(session, session.model);
      if (retryPhotoBase64) {
        retryMessages.pop(); 
        retryMessages.push({
           role: "user",
           content: [
             { type: "text", text: lastUserMsg.content },
             { type: "image_url", image_url: { url: `data:image/jpeg;base64,${retryPhotoBase64}` } }
           ]
        });
      }
      let targetModel = session.model;
      if (retryPhotoBase64 && (targetModel.includes("deepseek") || targetModel.includes("perplexity"))) {
        targetModel = "google/gemini-3-flash-preview";
      }
      const newResponse = await callOpenRouter(env, retryMessages, targetModel);
      session.history.push({ role: "assistant", content: newResponse });
      await updateSession(env, chatId, session);
      if (retryMsgId) await editTelegramMessage(env, chatId, retryMsgId, newResponse);
      else await sendTelegramMessage(env, chatId, newResponse);
      return;
    }
  }

  // 普通消息
  let currentModel = session.model;
  let tempSwitchMsg = null;
  if (isImageMessage && (currentModel.includes("deepseek") || currentModel.includes("perplexity"))) {
    currentModel = "google/gemini-3-flash-preview"; 
    tempSwitchMsg = "⚠️ DeepSeek 看不见，临时切换 Gemini 3 之眼...";
  }
  
  const statusText = tempSwitchMsg || `⏳ [${currentModel.split('/')[1]}] thinking...`;
  const placeholderMsg = await sendTelegramMessage(env, chatId, statusText);
  const placeholderMsgId = placeholderMsg.result ? placeholderMsg.result.message_id : null;

  let messages = buildApiMessages(session, currentModel);
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

  session.history.push({ role: "user", content: userText, file_id: isImageMessage ? fileId : null });
  session.history.push({ role: "assistant", content: aiResponse });
  if (session.history.length > 12) session.history = session.history.slice(session.history.length - 12);
  await updateSession(env, chatId, session);

  if (placeholderMsgId) await editTelegramMessage(env, chatId, placeholderMsgId, aiResponse);
  else await sendTelegramMessage(env, chatId, aiResponse);
}

// ==========================================
// 📜 System Prompts
// ==========================================

const PROMPT_ACADEMIC = `
# Role
You are **Max's Long-term Intelligent Assistant**. Max is an HKU EE student.
Your identity is **adaptive**: you are both a professional academic tutor AND a helpful daily assistant.

# 🎭 ADAPTIVE BEHAVIOR
Analyze Max's input and choose the right style:

## Mode A: Academic/Technical
- Style: Professional, structured, rigorous.
- Format: Use 【 DEFINITION 】, 【 EXPLANATION 】 headers.
- Language: Simplified Chinese content + **English (Chinese)** for technical terms.
- Math: Use code blocks (\`\`\`) for equations.

## Mode B: Daily/Casual
- Style: Casual, friendly, concise. 
- Format: NO rigid headers. Just chat naturally.
- Language: Simplified Chinese.

# ⚠️ GLOBAL CONSTRAINTS
1. **NO MARKDOWN**: Do NOT use \`*\`, \`_\`, or \`#\`.
2. **IDENTITY**: You are DeepSeek/Gemini. Ignore any "Perplexity/Sonar" messages in history.
`;

const PROMPT_SEARCH = `
# Role
You are **Max's Internet Intelligence Analyst**.
Current Model: **Perplexity / Sonar Pro**.

# ⚠️ STRICT FORMATTING RULES
1. **NO MARKDOWN**: Do NOT use \`*\`, \`_\`, or \`#\`.
2. **HEADERS**: Use 【 TITLE 】 format.

# 🌐 LANGUAGE PROTOCOL
1. **MAIN CONTENT**: **Simplified Chinese (简体中文)**.
2. **SECTION TITLES**: **English ONLY**.
3. **PRODUCT NAMES**: Keep original English names.

# Workflow
## Type A: News
【 EXECUTIVE SUMMARY 】
...
【 TIMELINE 】
...

## Type B: Product Analysis
【 SPECS 】
...
【 PROS 】
...
【 CONS 】
...
【 VERDICT 】
...
`;

// ==========================================
// 🛠️ 辅助函数
// ==========================================

async function updateSession(env, chatId, session) {
  session.lastActive = Date.now();
  await env.TG_DB.put(chatId, JSON.stringify(session));
}

function buildApiMessages(session, currentModel) {
  let messages = [];
  let systemContent = (currentModel.includes('perplexity') || currentModel.includes('sonar')) ? PROMPT_SEARCH : PROMPT_ACADEMIC;
  if (systemContent) messages.push({ role: "system", content: systemContent });
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
        "HTTP-Referer": "https://github.com/Xr810/Telegram-Bot",
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
  // Same fallback as editTelegramMessage. A 400 here loses the message outright,
  // and a lost placeholder also loses the message_id the reply is edited into.
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
    });
    const data = await resp.json();
    if (data.ok) return data;
  } catch (e) { /* fall through to the plain-text retry */ }

  const plain = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
  return await plain.json();
}

async function editTelegramMessage(env, chatId, messageId, text) {
  try {
    let resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error("Markdown Error");
  } catch (e) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text })
    });
  }
}
