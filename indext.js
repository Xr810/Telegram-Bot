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

          // ==========================================
          // 🎮 指令控制台
          // ==========================================
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
            
            // 3. 【Reset】重置为 DeepSeek 并清空记忆
            if (userText === '/reset') {
              session.model = "deepseek/deepseek-v3.2";
              session.history = []; // 👈 关键：清空历史
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "🦄 已重置为 **DeepSeek** (记忆已清空)");
              return new Response('OK');
            }
            
            // 4. 切回基础模式 (保留记忆)
            if (userText === '/basic') {
              session.model = "deepseek/deepseek-v3.2";
              await env.TG_DB.put(chatId, JSON.stringify(session));
              await sendTelegramMessage(env, chatId, "🦄 已切回 **DeepSeek** (记忆已保留)");
              return new Response('OK');
            }

            // 5. 【Retry】重试生成
            if (userText === '/retry') {
              if (session.history.length === 0) {
                 await sendTelegramMessage(env, chatId, "⚠️ 没有历史记录，无法重试。");
                 return new Response('OK');
              }

              // 移除最后一条由 Assistant 发送的消息 (即上一次不满意的回答)
              // 如果最后一条是 User (比如上次请求失败了)，则不删，直接重发
              const lastMsg = session.history[session.history.length - 1];
              if (lastMsg.role === 'assistant') {
                session.history.pop(); 
              }

              // 发送重试占位符
              const retryMsg = await sendTelegramMessage(env, chatId, `🔄 [${session.model.split('/')[1]}] 正在重试...`);
              const retryMsgId = retryMsg.result ? retryMsg.result.message_id : null;

              // 重新调用 AI (使用修剪后的历史)
              // 注意：这里需要重新构建 messages 数组
              let retryMessages = [];
              if (!session.model.includes('perplexity') && env.SYSTEM_PROMPT) {
                retryMessages.push({ role: "system", content: env.SYSTEM_PROMPT });
              }
              retryMessages = retryMessages.concat(session.history);

              const newResponse = await callOpenRouter(env, retryMessages, session.model);

              // 将新回答加入历史
              session.history.push({ role: "assistant", content: newResponse });
              await env.TG_DB.put(chatId, JSON.stringify(session));

              // 编辑消息
              if (retryMsgId) {
                await editTelegramMessage(env, chatId, retryMsgId, newResponse);
              } else {
                await sendTelegramMessage(env, chatId, newResponse);
              }
              return new Response('OK'); // 结束，不执行下面的普通逻辑
            }
          }

          // ==========================================
          // 🧠 普通消息处理 (路由 + 视觉)
          // ==========================================
          
          let currentModel = session.model;
          let tempSwitchMsg = null;
          
          // 视觉回退逻辑
          if (isImageMessage && (currentModel.includes("deepseek") || currentModel.includes("perplexity"))) {
            currentModel = "google/gemini-3-flash-preview"; 
            tempSwitchMsg = "⚠️ DeepSeek 看不见，临时切换 Gemini 3 之眼...";
          }

          // 发送“思考中”
          const statusText = tempSwitchMsg || `⏳ [${currentModel.split('/')[1]}] 正在思考...`;
          const placeholderMsg = await sendTelegramMessage(env, chatId, statusText);
          const placeholderMsgId = placeholderMsg.result ? placeholderMsg.result.message_id : null;

          // 构造 API 请求
          let messages = [];
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

          // 调用 AI
          const aiResponse = await callOpenRouter(env, messages, currentModel);

          // 更新记忆
          session.history.push({ role: "user", content: isImageMessage ? `[图片]: ${userText}` : userText });
          session.history.push({ role: "assistant", content: aiResponse });
          if (session.history.length > 12) session.history = session.history.slice(session.history.length - 12);
          await env.TG_DB.put(chatId, JSON.stringify(session));

          // 编辑消息回传
          if (placeholderMsgId) {
            await editTelegramMessage(env, chatId, placeholderMsgId, aiResponse);
          } else {
            await sendTelegramMessage(env, chatId, aiResponse);
          }
        }
      } catch (e) {
        console.error(e);
      }
      return new Response('OK');
    }
    return new Response('Max Bot V6.0 (Retry Edition) is Ready!');
  }
};

// --- 辅助函数 (保持不变) ---

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
    body: JSON.stringify({ 
      chat_id: chatId, 
      message_id: messageId, 
      text: text, 
      parse_mode: "Markdown" 
    })
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
