export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // === 路由1: 注册 Webhook (你现在卡住的地方) ===
    if (url.pathname === '/registerWebhook') {
      const secret = url.searchParams.get('secret');
      // 检查 Token 是否匹配
      if (secret !== env.TELEGRAM_AVAILABLE_TOKENS) {
        return new Response('Token 不匹配，请检查 URL 里的 secret', { status: 403 });
      }
      // 告诉 Telegram：把消息发到我这里
      const webhookUrl = `${url.protocol}//${url.hostname}/`; // 默认发到根路径
      const tgApi = `https://api.telegram.org/bot${secret}/setWebhook?url=${webhookUrl}`;
      
      const resp = await fetch(tgApi);
      const data = await resp.json();
      return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // === 路由2: 处理 Telegram 消息 (核心逻辑) ===
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        // 如果是文本消息
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const userText = update.message.text;

          // 1. 鉴权 (白名单)
          const whiteList = (env.CHAT_WHITE_LIST || '').split(',');
          if (whiteList.length > 0 && !whiteList.includes(chatId.toString())) {
             await sendTelegramMessage(env, chatId, "🚫 你没有权限使用此 Bot。");
             return new Response('Unauthorized');
          }

          // 2. 调用 OpenRouter AI
          await sendTelegramMessage(env, chatId, "🤔 思考中..."); // 先发个状态
          const aiResponse = await callOpenRouter(env, userText);
          
          // 3. 发回结果
          await sendTelegramMessage(env, chatId, aiResponse);
        }
      } catch (e) {
        console.error(e);
      }
      return new Response('OK');
    }

    return new Response('Max AI Bot is Running! (访问 /registerWebhook 来激活)', { status: 200 });
  }
};

// 辅助函数：调用 OpenRouter
async function callOpenRouter(env, prompt) {
  try {
    // === 修改开始：构建带有“人设”的消息列表 ===
    const messages = [];

    // 1. 如果你在后台设置了 SYSTEM_PROMPT，就把它作为第一条规则加进去
    if (env.SYSTEM_PROMPT) {
      messages.push({ role: "system", content: env.SYSTEM_PROMPT });
    }

    // 2. 加入用户刚才发送的消息
    messages.push({ role: "user", content: prompt });
    // === 修改结束 ===

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cloudflare.com",
        "X-Title": "Max-TG-Bot"
      },
      body: JSON.stringify({
        model: env.CHAT_MODEL || "deepseek/deepseek-chat",
        messages: messages // 注意这里变成了我们构建好的列表
      })
    });
    
    const data = await resp.json();
    if (!data.choices || data.choices.length === 0) {
      return `API Error: ${JSON.stringify(data)}`;
    }
    return data.choices[0].message.content;
  } catch (e) {
    return `Request Error: ${e.message}`;
  }
}

// 辅助函数：发消息给 Telegram
async function sendTelegramMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_AVAILABLE_TOKENS}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown" // 支持简单的 Markdown
    })
  });
}
