// deno run --allow-net --allow-read openai_proxy.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const UPSTREAM_API = "https://api.poe.com/v1/chat/completions";
let modelMapping: Record<string, string> = {};

// 加载模型映射
async function loadModelMapping() {
  try {
    const modelsText = await Deno.readTextFile("models.json");
    modelMapping = JSON.parse(modelsText);
    console.log(`已加载 ${Object.keys(modelMapping).length} 个模型映射`);
  } catch {
    console.warn("无法加载 models.json，将使用空映射");
  }
}

// 工具函数
const getToken = (req: Request) => req.headers.get("authorization")?.replace("Bearer ", "");
const mapModel = (model: string) => modelMapping[model] || model;
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 
    "content-type": "application/json",
    "access-control-allow-origin": "*" 
  }
});

// OpenAI 标准参数列表
const STANDARD_PARAMS = [
  'model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 
  'stream_options', 'top_p', 'stop', 'temperature', 'n', 
  'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 
  'functions', 'function_call', 'tools', 'tool_choice', 
  'response_format', 'seed', 'prompt', 'size', 'quality', 'style'
];

// 过滤支持的参数并自动转换 extra_body
function filterRequestBody(body: any) {
  const result: any = {
    model: mapModel(body.model),
    messages: body.messages,
  };

  // 处理标准参数
  for (const param of STANDARD_PARAMS) {
    if (param === 'model' || param === 'messages') continue; // 已处理
    
    if (body[param] !== undefined) {
      if (param === 'temperature') {
        result[param] = Math.min(Math.max(body[param], 0), 2);
      } else {
        result[param] = body[param];
      }
    }
  }
  
  // 收集非标准参数到 extra_body
  const extraBody: any = {};
  for (const key in body) {
    if (!STANDARD_PARAMS.includes(key) && key !== 'extra_body') {
      extraBody[key] = body[key];
    }
  }
  
  // 如果用户已经提供了 extra_body，需要合并
  if (body.extra_body && typeof body.extra_body === 'object') {
    Object.assign(extraBody, body.extra_body);
  }
  
  // 如果有额外的参数，添加到 extra_body
  if (Object.keys(extraBody).length > 0) {
    result.extra_body = extraBody;
  }
  
  // 过滤 undefined 值
  return Object.fromEntries(Object.entries(result).filter(([_, v]) => v !== undefined));
}

// 处理DALL-E-3图片生成
async function handleImageGeneration(req: Request) {
  console.log("🖼️ [IMAGE GENERATION] 进入图片生成处理函数");
  
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  console.log("🖼️ [IMAGE GENERATION] 请求体:", JSON.stringify(reqBody, null, 2));
  
  // 检查尺寸参数
  if (reqBody.size) {
    // 如果指定了尺寸但不是 1024x1024，返回错误
    if (reqBody.size !== "1024x1024") {
      console.log(`拒绝请求: 尺寸 ${reqBody.size} 不被支持`);
      return jsonResponse({ 
        error: { 
          message: `Invalid size: ${reqBody.size}. Only 1024x1024 is supported.`,
          type: "invalid_request_error",
          param: "size",
          code: "invalid_size"
        } 
      }, 500);
    }
  } else {
    // 如果没有指定尺寸，设置默认值为 1024x1024
    reqBody.size = "1024x1024";
    console.log("未指定尺寸，使用默认值: 1024x1024");
  }
  
  console.log(`🖼️ [IMAGE GENERATION] 处理图片生成请求: 尺寸=${reqBody.size}, prompt="${reqBody.prompt}"`);
  
  // 使用 filterRequestBody 来处理参数转换
  const chatRequest = filterRequestBody({
    model: "dall-e-3",
    messages: [{ role: "user", content: reqBody.prompt }],
    max_tokens: 1000,
    // 将图片特有的参数传递进去，非标准参数会被自动放入 extra_body
    size: reqBody.size,
    aspect_ratio: reqBody.aspect_ratio,
    quality: reqBody.quality,
    style: reqBody.style
  });

  console.log("🖼️ [IMAGE GENERATION] 转换后的请求:", JSON.stringify(chatRequest, null, 2));

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(chatRequest)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return jsonResponse({ 
        error: { 
          message: errorData.error?.message || "Upstream API error",
          type: getErrorType(response.status)
        } 
      }, response.status);
    }

    const chatResponse = await response.json();
    const content = chatResponse.choices?.[0]?.message?.content || "";
    const imageUrl = content.match(/https:\/\/[^\s\)]+/g)?.[0] || "";
    
    console.log("🖼️ [IMAGE GENERATION] 上游响应内容:", content);
    console.log("🖼️ [IMAGE GENERATION] 提取的图片URL:", imageUrl);
    console.log("🖼️ [IMAGE GENERATION] ✅ 准备返回固定的 revised_prompt: '成功生成图片！'");
    
    const result = {
      created: Math.floor(Date.now() / 1000),
      data: [{
        revised_prompt: "成功生成图片！",
        url: imageUrl
      }]
    };
    
    console.log("🖼️ [IMAGE GENERATION] 📤 返回结果:", JSON.stringify(result, null, 2));
    return jsonResponse(result);

  } catch (error) {
    console.error("🖼️ [IMAGE GENERATION] 上游请求失败:", error);
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 处理聊天完成
async function handleChatCompletion(req: Request) {
  console.log("💬 [CHAT COMPLETION] 进入聊天完成处理函数");
  
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  const filteredBody = filterRequestBody(reqBody);

  console.log("💬 [CHAT COMPLETION] 请求模型:", reqBody.model);
  console.log("💬 [CHAT COMPLETION] 转换后的请求:", JSON.stringify(filteredBody, null, 2));

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(filteredBody)
    });

    const headers: Record<string, string> = {
      "access-control-allow-origin": "*"
    };

    if (filteredBody.stream) {
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      headers["connection"] = "keep-alive";
      return new Response(response.body, { status: response.status, headers });
    } else {
      headers["content-type"] = "application/json";
      const responseText = await response.text();
      console.log("💬 [CHAT COMPLETION] 返回原始聊天响应");
      return new Response(responseText, { status: response.status, headers });
    }

  } catch {
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 根据HTTP状态码映射错误类型
function getErrorType(status: number): string {
  const errorMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error", 
    402: "insufficient_credits",
    403: "moderation_error",
    404: "not_found_error",
    408: "timeout_error",
    413: "request_too_large",
    429: "rate_limit_error",
    502: "upstream_error",
    529: "overloaded_error"
  };
  return errorMap[status] || "unknown_error";
}

// 主处理函数
async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  console.log(`📥 收到请求: ${req.method} ${pathname}`);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type"
      }
    });
  }

  if (req.method === "POST") {
    if (pathname === "/v1/images/generations") {
      console.log("🎯 路由匹配: 图片生成端点");
      return handleImageGeneration(req);
    }
    if (pathname === "/v1/chat/completions") {
      console.log("🎯 路由匹配: 聊天完成端点");
      return handleChatCompletion(req);
    }
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const models = [...Object.keys(modelMapping), "dall-e-3"];
    return jsonResponse({
      object: "list",
      data: models.map(model => ({
        id: model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy"
      }))
    });
  }

  console.log("❌ 未匹配到任何路由");
  return jsonResponse({
    message: "OpenAI兼容代理服务",
    endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/models"]
  });
}

await loadModelMapping();
serve(handle, { port: 8000 });
console.log("🚀 服务已启动: http://localhost:8000");
