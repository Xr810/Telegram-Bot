export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // === 1. Webhook 注册接口 (保持不变) ===
    if (url.pathname === '/registerWebhook') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.TELEGRAM_AVAILABLE_TOKENS) {
        return new Response('Token Error', { status: 403 });
      }
      const webhookUrl = `${url.protocol}//${url.hostname}/`;
      const tgApi = `https://api.telegram.org/bot${secret}/setWebhook?url=${webhookUrl}`;
      const resp = await fetch(tgApi);
      return new Response(JSON.stringify(await resp.json(), null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // === 2. 消息处理主逻辑 ===
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const rawText = update.message.text.trim();

          // --- 鉴权 ---
          const whiteList = (env.CHAT_WHITE_LIST || '').split(',');
          if (whiteList.length > 0 && !whiteList.includes(chatId.toString())) {
             return new Response('Unauthorized');
          }

          // --- 🚀 核心：模型路由逻辑 ---
          let targetModel = "deepseek/deepseek-v3.2"; // 【默认】基础模型
          let prompt = rawText;
          let statusEmoji = "🦄"; // 默认 DeepSeek 的图标
          
          // 逻辑 A: 联网搜索 (/s 或 /search) -> Sonar Deep Research
          if (rawText.startsWith("/s ") || rawText.startsWith("搜索 ")) {
            targetModel = "perplexity/sonar-deep-research"; 
            prompt = rawText.replace(/^(\/s|搜索)\s+/, "");
            statusEmoji = "🌐"; // 搜索图标
          }
          // 逻辑 B: 进阶模型 (/pro 或 /g) -> Gemini 3 Flash
          else if (rawText.startsWith("/pro ") || rawText.startsWith("/g ")) {
            targetModel = "google/gemini-3-flash-preview";
            prompt = rawText.replace(/^(\/pro|\/g)\s+/, "");
            statusEmoji = "⚡"; // Gemini 的闪电图标
          }

          // --- 发送“思考中”状态 ---
          // 提示：为了让体验更好，我会把模型名字也发给你，让你知道现在用的是谁
          const statusMsg = `${statusEmoji} 正在调用 ${targetModel.split('/')[1]}...`;
          await sendTelegramMessage(env, chatId, statusMsg);

          // --- 调用 OpenRouter ---
          const aiResponse = await callOpenRouter(env, prompt, targetModel);

          // --- 返回结果 ---
          await sendTelegramMessage(env, chatId, aiResponse);
        }
      } catch (e) {
        console.error(e);
      }
      return new Response('OK');
    }

    return new Response('Max AI Bot V3.0 is Running!', { status: 200 });
  }
};

// === 3. OpenRouter 调用函数 (支持自定义模型) ===
async function callOpenRouter(env, prompt, modelId) {
  try {
    const messages = [];
    
    // 只有非搜索模型才注入人设 (Deep Research 通常不需要人设，让它专注于找资料)
    if (!modelId.includes('perplexity') && env.SYSTEM_PROMPT) {
      messages.push({ role: "system", content: env.SYSTEM_PROMPT });
    }
    
    messages.push({ role: "user", content: prompt });

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://max.hku.hk", // 随便填个 Referer 满足 OpenRouter 规范
        "X-Title": "Max-Telegram-Bot"
      },
      body: JSON.stringify({
        model: modelId,
        messages: messages,
        // 如果是 Deep Research，可能需要更长的 timeout，但 CF Worker 有执行时间限制
        // 这里不设 stream，简单处理
      })
    });

    const data = await resp.json();
    
    // 错误处理：如果 OpenRouter 返回 404 或 400，说明 ID 写错了
    if (data.error) {
      return `❌ API Error: ${data.error.message}\n(模型 ID: ${modelId})`;
    }
    
    if (!data.choices || data.choices.length === 0) {
      return `⚠️ 未知错误，无返回内容。`;
    }

    return data.choices[0].message.content;
  } catch (e) {
    return `❌ Request Fault: ${e.message}`;
  }
}

// === 4. Telegram 发信函数 ===
async function sendTelegramMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown" // 简单的 Markdown
    })
  });
}
