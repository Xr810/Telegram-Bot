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
          
          // --- 提取内容 ---
          let userText = "";
          let photoBase64 = null;
          let isImageMessage = false;

          if (update.message.text) {
            userText = update.message.text.trim();
          } else if (update.message.photo) {
            const photoArray = update.message.photo;
            const fileId = photoArray[photoArray.length - 1].file_id;
            userText = update.message.caption || "请分析这张图片";
            isImageMessage = true;
            
            // 先发个提示，避免用户以为挂了
            await sendTelegramMessage(env, chatId, "👀 正在接收图片数据...");
            photoBase64 = await getTelegramPhotoAsBase64(env, fileId);
          } else {
            return new Response('OK'); 
          }

          // --- 鉴权 ---
          const whiteList = (env.CHAT_WHITE_LIST || '').split(',');
          if (whiteList.length > 0 && !whiteList.includes(chatId)) return new Response('Unauthorized');

          // --- 读取 KV 状态 ---
          let session = await env.TG_DB.get(chatId, { type: "json" });
          if (!session) session = { model: "deepseek/deepseek-v3.2", history: [] };

          // --- 🎮 指令控制台 ---
          if (!isImageMessage) {
            // 1. 切换搜索 (清空记忆)
            if (userText === '/s' || userText === '/search') {
              session.model = "perplexity/sonar-deep-research";
              session.history = [];
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "🌐 已切换为 **联网搜索模式**");
              return new Response('OK');
            }
            // 2. 切换进阶 (清空记忆)
            if (userText === '/pro' || userText === '/g') {
              session.model = "google/gemini-3-flash-preview";
              session.history = [];
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "⚡ 已切换为 **进阶模式 (Gemini 3)**");
              return new Response('OK');
            }
            // 3. 重置 (清空记忆)
            if (userText === '/reset') {
              session.model = "deepseek/deepseek-v3.2";
              session.history = [];
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "🦄 已重置为 **DeepSeek (记忆已清空)**");
              return new Response('OK');
            }
            // 4. 【新功能】切回基础模式 (保留记忆)
            if (userText === '/basic') {
              session.model = "deepseek/deepseek-v3.2";
              // 注意：这里不操作 session.history，保留之前的对话
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "🦄 已切回 **DeepSeek** (记忆已保留)");
              return new Response('OK');
            }
          }

          // --- 🧠 模型路由与视觉修复 ---
          let currentModel = session.model;
          let tempSwitchMsg = null;
          
          // 如果发了图，且当前模型不支持视觉，强制用 Gemini 3
          if (isImageMessage && (currentModel.includes("deepseek") || currentModel.includes("perplexity"))) {
            currentModel = "google/gemini-3-flash-preview"; // 统一用这个你验证过好用的
            tempSwitchMsg = "⚠️ DeepSeek 看不见，临时切换 Gemini 3 之眼...";
          }

          // --- ⏳ 发送“思考中”占位符 ---
          // 如果有临时切换提示，就显示提示，否则显示思考中
          const statusText = tempSwitchMsg || `⏳ [${currentModel.split('/')[1]}] 正在思考...`;
          const placeholderMsg = await sendTelegramMessage(env, chatId, statusText);
          const placeholderMsgId = placeholderMsg.result ? placeholderMsg.result.message_id : null;

          // --- 构造 API 请求 ---
          let messages = [];
          // 只有非搜索模型才加 System Prompt
          if (!currentModel.includes('perplexity') && env.SYSTEM_PROMPT) {
            messages.push({ role: "system", content: env.SYSTEM_PROMPT });
          }
          
          messages = messages.concat(session.history);

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

          // --- 调用 AI ---
          const aiResponse = await callOpenRouter(env, messages, currentModel);

          // --- 更新记忆 (KV) ---
          session.history.push({ role: "user", content: isImageMessage ? `[图片]: ${userText}` : userText });
          session.history.push({ role: "assistant", content: aiResponse });
          if (session.history.length > 12) session.history = session.history.slice(session.history.length - 12);
          await env.TG_DB.put(chatId, JSON.stringify(session));

          // --- ✏️ 修改消息 (把“思考中”变成“答案”) ---
          if (placeholderMsgId) {
            await editTelegramMessage(env, chatId, placeholderMsgId, aiResponse);
          } else {
            // 如果占位符发送失败（极少情况），则发一条新的
            await sendTelegramMessage(env, chatId, aiResponse);
          }
        }
      } catch (e) {
        console.error(e);
      }
      return new Response('OK');
    }
    return new Response('Max Bot V5.0 is Ready!');
  }
};

// --- 辅助函数 ---

async function getTelegramPhotoAsBase64(env, fileId) {
  try {
    const fileApi = `https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/getFile?file_id=${fileId}`;
    const fileResp = await fetch(fileApi);
    const fileData = await fileResp.json();
    if (!fileData.ok) return null;
    const filePath = fileData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_AVAILABLE_TOKENS}/${filePath}`;
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

// 发送消息，并返回 API 响应结果（为了拿 message_id）
async function sendTelegramMessage(env, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
  return await resp.json();
}

// 【新】编辑消息
async function editTelegramMessage(env, chatId, messageId, text) {
  // 先尝试用 Markdown 编辑
  let resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      chat_id: chatId, 
      message_id: messageId, 
      text: text, 
      parse_mode: "Markdown" 
    })
  });
  
  // 如果 Markdown 解析失败（比如 AI 返回了不闭合的 *），则降级为纯文本重试
  const data = await resp.json();
  if (!data.ok) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        chat_id: chatId, 
        message_id: messageId, 
        text: text 
        // 不带 parse_mode，纯文本发送
      })
    });
  }
}
