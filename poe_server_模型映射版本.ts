// deno run --allow-net --allow-read openai_proxy.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 适配你要转发到的实际 LLM 接口（可自定义）
const UPSTREAM_API = "https://api.poe.com/v1/chat/completions";

// 读取模型映射配置
let modelMapping: Record<string, string> = {};
let reverseModelMapping: Record<string, string> = {};

async function loadModelMapping() {
  try {
    const modelsText = await Deno.readTextFile("models.json");
    modelMapping = JSON.parse(modelsText);
    
    // 创建反向映射，支持用户使用目标模型名称
    reverseModelMapping = {};
    for (const [key, value] of Object.entries(modelMapping)) {
      reverseModelMapping[value] = key;
    }
    
    console.log(`已加载 ${Object.keys(modelMapping).length} 个模型映射`);
  } catch (error) {
    console.warn("无法加载 models.json，将使用空映射:", error.message);
    modelMapping = {};
    reverseModelMapping = {};
  }
}

// 模型名称映射函数
function mapModelName(inputModel: string): string {
  // 先检查直接映射
  if (modelMapping[inputModel]) {
    return modelMapping[inputModel];
  }
  
  // 再检查反向映射（用户可能直接使用目标模型名）
  if (reverseModelMapping[inputModel]) {
    return inputModel; // 已经是目标模型名，直接返回
  }
  
  // 如果都没找到，返回原始模型名
  return inputModel;
}

// DALL-E-3 请求转换函数
function convertDallE3Request(reqBody: any): any {
  const prompt = reqBody.prompt || "";
  const size = reqBody.size || "1024x1024";
  const quality = reqBody.quality || "standard";
  const style = reqBody.style || "vivid";
  const n = reqBody.n || 1;
  
  // 构造适合 poe 的 chat completions 格式
  const chatRequest = {
    model: mapModelName("dall-e-3"), // 使用映射后的模型名
    messages: [
      {
        role: "user",
        content: `Generate an image with the following specifications:
Prompt: ${prompt}
Size: ${size}
Quality: ${quality}
Style: ${style}
Number of images: ${n}`
      }
    ],
    max_tokens: 1000,
    temperature: 0.7
  };
  
  return chatRequest;
}

// DALL-E-3 响应转换函数 - 根据实际响应格式修改
function convertDallE3Response(chatResponse: any): any {
  const content = chatResponse.choices?.[0]?.message?.content || "";
  
  // 从响应中提取图片URL，支持多种格式
  let imageUrl = "";
  
  // 方法1：提取纯URL（以https开头的完整URL）
  const urlMatches = content.match(/https:\/\/[^\s\)]+/g);
  if (urlMatches && urlMatches.length > 0) {
    // 取最后一个URL（通常是纯URL格式）
    imageUrl = urlMatches[urlMatches.length - 1];
  }
  
  // 方法2：如果没找到，尝试从Markdown格式中提取
  if (!imageUrl) {
    const markdownMatch = content.match(/!\[.*?\]\((https:\/\/[^\)]+)\)/);
    if (markdownMatch) {
      imageUrl = markdownMatch[1];
    }
  }
  
  // 提取revised_prompt（如果有的话）
  let revisedPrompt = "";
  
  // 从Markdown alt文本中提取
  const altTextMatch = content.match(/!\[([^\]]+)\]/);
  if (altTextMatch) {
    revisedPrompt = altTextMatch[1];
  }
  
  // 如果没有alt文本，使用原始内容的前100个字符作为描述
  if (!revisedPrompt) {
    revisedPrompt = content.replace(/https:\/\/[^\s]+/g, '').trim().substring(0, 100);
  }
  
  console.log(`提取的图片URL: ${imageUrl}`);
  console.log(`提取的描述: ${revisedPrompt}`);
  
  // 构造符合 OpenAI images API 格式的响应
  return {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        url: imageUrl,
        revised_prompt: revisedPrompt || "Generated image"
      }
    ]
  };
}

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // 处理 DALL-E-3 图片生成请求
  if (req.method === "POST" && pathname === "/v1/images/generations") {
    // 1. 解析 Authorization Header
    const auth = req.headers.get("authorization");
    let token = "";
    if (auth && auth.startsWith("Bearer ")) {
      token = auth.slice(7).trim();
    } else {
      return new Response(
        JSON.stringify({ error: { message: "Missing Bearer token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    // 2. 读取请求参数
    const reqBody = await req.json();
    
    // 3. 检查是否是 DALL-E-3 模型
    if (reqBody.model === "dall-e-3" || mapModelName("dall-e-3") === reqBody.model) {
      console.log("检测到 DALL-E-3 请求，进行格式转换");
      console.log("原始请求:", JSON.stringify(reqBody, null, 2));
      
      // 4. 转换请求格式
      const chatRequest = convertDallE3Request(reqBody);
      console.log("转换后的请求:", JSON.stringify(chatRequest, null, 2));
      
      // 5. 构造请求头
      const headers = new Headers({
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "host": new URL(UPSTREAM_API).host,
      });

      // 6. 发送转换后的请求到 poe
      const upstreamResp = await fetch(UPSTREAM_API, {
        method: "POST",
        headers,
        body: JSON.stringify(chatRequest),
      });

      if (!upstreamResp.ok) {
        const errorText = await upstreamResp.text();
        console.error("上游API错误:", errorText);
        return new Response(errorText, {
          status: upstreamResp.status,
          headers: { "content-type": "application/json" }
        });
      }

      // 7. 转换响应格式
      const chatResponse = await upstreamResp.json();
      console.log("上游API响应:", JSON.stringify(chatResponse, null, 2));
      
      const imageResponse = convertDallE3Response(chatResponse);
      console.log("转换后的响应:", JSON.stringify(imageResponse, null, 2));
      
      return new Response(JSON.stringify(imageResponse), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
    
    // 如果不是 DALL-E-3，返回错误
    return new Response(
      JSON.stringify({ 
        error: { 
          message: "Only dall-e-3 model is supported for image generation" 
        } 
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // 原有的 chat completions 处理逻辑
  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    // 1. 解析 Authorization Header（和 OpenAI 保持一致）
    const auth = req.headers.get("authorization");
    let token = "";
    if (auth && auth.startsWith("Bearer ")) {
      token = auth.slice(7).trim();
    } else {
      return new Response(
        JSON.stringify({ error: { message: "Missing Bearer token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    // 2. 读取所有请求参数
    const reqBody = await req.json();
    
    // 3. 模型名称映射
    if (reqBody.model) {
      const originalModel = reqBody.model;
      const mappedModel = mapModelName(originalModel);
      reqBody.model = mappedModel;
      
      console.log(`模型映射: ${originalModel} -> ${mappedModel}`);
    }

    // 4. 构造目标请求（token 放 header）
    const headers = new Headers({
      ...req.headers,
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "host": new URL(UPSTREAM_API).host,
    });

    // 5. 处理流式（stream）与非流式
    const stream = reqBody.stream === true;

    // 6. 转发请求到目标大模型API
    const upstreamResp = await fetch(UPSTREAM_API, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
    });

    // 流式
    if (stream) {
      // 保证 header 兼容 SSE
      const r = new ReadableStream({
        async start(controller) {
          const reader = upstreamResp.body!.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        },
      });
      return new Response(r, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    } else {
      // 非流式直接原样返回
      const text = await upstreamResp.text();
      return new Response(text, {
        status: upstreamResp.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
  }

  // 添加模型列表接口
  if (req.method === "GET" && pathname === "/v1/models") {
    const models = Object.keys(modelMapping).concat(Object.keys(reverseModelMapping));
    const uniqueModels = [...new Set(models)];
    
    const modelList = {
      object: "list",
      data: uniqueModels.map(model => ({
        id: model,
        object: "model",
        created: Date.now(),
        owned_by: "proxy"
      }))
    };
    
    return new Response(JSON.stringify(modelList), {
      status: 200,
      headers: { 
        "content-type": "application/json",
        "access-control-allow-origin": "*"
      }
    });
  }

  // 健康检查 or 404
  return new Response(
    JSON.stringify({ 
      message: "OK, POST /v1/chat/completions, POST /v1/images/generations", 
      models_loaded: Object.keys(modelMapping).length 
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// 启动服务前先加载模型映射
await loadModelMapping();

// 启动服务
serve(handle, { port: 8000 });
console.log("OpenAI兼容服务已启动: http://localhost:8000/v1/chat/completions");
console.log("图片生成接口: http://localhost:8000/v1/images/generations");
console.log("模型列表接口: http://localhost:8000/v1/models");
