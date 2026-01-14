
export default {
  async fetch(request, env) {
    // 处理 CORS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 只允许 POST 请求
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      let pathname, url, expired_at;
      try {
        const body = await request.json();
        pathname = body.pathname;
        url = body.url;
        expired_at = body.expired_at;
      } catch (e) {
        return Response.json({ error: "Invalid JSON body" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 1. 验证输入
      if (!pathname || typeof pathname !== "string" || pathname.length < 5 || pathname.length > 10) {
        return Response.json({ error: "Invalid pathname (5-10 chars)" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
      // 简单正则验证 pathname 是否只包含允许字符
      if (!/^[a-zA-Z0-9_-]+$/.test(pathname)) {
        return Response.json({ error: "Invalid characters in pathname" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      if (!url || typeof url !== "string" || url.length > 300) {
        return Response.json({ error: "Invalid URL (max 300 chars)" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
      try {
        const parsedUrl = new URL(url); // 验证 URL 格式
        // 安全检查: 必须是 http 或 https 协议
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return Response.json({ error: "Invalid URL protocol (only http/https allowed)" }, { 
                status: 400,
                headers: { "Access-Control-Allow-Origin": "*" }
            });
        }

        // 检查是否指向自身 (循环重定向保护)
        const baseDomain = env.BASE_DOMAIN || "";
        if (baseDomain) {
            // 忽略大小写比较
            if (parsedUrl.hostname.toLowerCase() === baseDomain.toLowerCase()) {
                return Response.json({ error: "Cannot redirect to the URL shortener itself (Loop protection)" }, { 
                    status: 400,
                    headers: { "Access-Control-Allow-Origin": "*" }
                });
            }
        }
      } catch (e) {
        return Response.json({ error: "Invalid URL format" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 验证 URL 有效性 (200 OK)
      try {
          const urlCheckResp = await fetch(url, {
              method: "HEAD", // 尝试 HEAD 请求以节省带宽
              headers: {
                  "User-Agent": "Mozilla/5.0 (compatible; URLChecker/1.0)"
              }
          });
          
          if (!urlCheckResp.ok) {
              // 如果 HEAD 失败 (如 405 Method Not Allowed)，尝试 GET
              if (urlCheckResp.status === 405 || urlCheckResp.status === 404 || urlCheckResp.status === 403) {
                  // 有些服务器对 HEAD 返回 404/403 但对 GET 正常，或者不支持 HEAD
                  // 但用户要求 "不返回 200 OK 则拒绝"。
                  // 严格来说，301/302 也是有效的重定向，通常我们也应该允许。
                  // 如果 HEAD 失败，我们再试一次 GET，以防万一。
                  const urlCheckRespGet = await fetch(url, {
                      method: "GET",
                      headers: {
                          "User-Agent": "Mozilla/5.0 (compatible; URLChecker/1.0)"
                      }
                  });
                  if (!urlCheckRespGet.ok) {
                      return Response.json({ error: `URL check failed: ${urlCheckRespGet.status} ${urlCheckRespGet.statusText}` }, { 
                          status: 400,
                          headers: { "Access-Control-Allow-Origin": "*" }
                      });
                  }
              } else {
                  return Response.json({ error: `URL check failed: ${urlCheckResp.status} ${urlCheckResp.statusText}` }, { 
                      status: 400,
                      headers: { "Access-Control-Allow-Origin": "*" }
                  });
              }
          }
      } catch (e) {
          console.error("URL Validation Error:", e);
          return Response.json({ error: "URL validation failed: Unable to connect to target URL" }, { 
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" }
          });
      }

      if (!expired_at || typeof expired_at !== "number") {
        return Response.json({ error: "Invalid expiration timestamp" }, { 
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 2. 准备数据
      // 将 Unix 时间戳转换为 ISO 8601 字符串
      const expiredDate = new Date(expired_at * 1000);
      const now = new Date();
      if (isNaN(expiredDate.getTime())) {
         return Response.json({ error: "Invalid timestamp" }, { 
             status: 400,
             headers: { "Access-Control-Allow-Origin": "*" }
         });
      }

      // 检查有效期是否超过 7 天
      const diffTime = expiredDate.getTime() - now.getTime();
      const diffDays = diffTime / (1000 * 3600 * 24);
      if (diffDays > 7) {
          return Response.json({ error: "Expiration date cannot exceed 7 days from now" }, { 
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" }
          });
      }
      // 检查有效期是否在过去
      if (diffTime <= 0) {
          return Response.json({ error: "Expiration date must be in the future" }, { 
              status: 400,
              headers: { "Access-Control-Allow-Origin": "*" }
          });
      }

      const expiredAtISO = expiredDate.toISOString();

      // 3. 获取 GitHub 文件
      const owner = env.GITHUB_OWNER; // 需要在 Worker 环境变量中设置
      const repo = env.GITHUB_REPO;   // 需要在 Worker 环境变量中设置
      const branch = env.GITHUB_BRANCH || "main";
      const filePath = "js/rules_intermediate.js";
      const token = env.GITHUB_TOKEN;

      if (!token || !owner || !repo) {
        return Response.json({ error: "Server configuration error" }, { 
            status: 500,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
      
      const getResp = await fetch(getUrl, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "Cloudflare-Worker",
          "Accept": "application/vnd.github.v3+json"
        }
      });

      if (!getResp.ok) {
        const errText = await getResp.text();
        console.error("GitHub Fetch Error:", errText);
        return Response.json({ error: "Failed to fetch file from GitHub: " + getResp.status }, { 
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      const fileData = await getResp.json();
      const content = atob(fileData.content); // Base64 decode
      const sha = fileData.sha;

      // 4. 解析并更新内容
      // 提取 JSON 部分: window.RULES_INTERMEDIATE = {...};
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      
      if (jsonStart === -1 || jsonEnd === -1) {
        return Response.json({ error: "Failed to parse file content" }, { 
            status: 500,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      const jsonStr = content.substring(jsonStart, jsonEnd + 1);
      let rules;
      try {
        // 使用 Function 而不是 eval 来解析 JS 对象字面量 (如果它是标准 JSON 最好，但如果是 JS 对象可能包含无引号键)
        // 既然我们生成的文件是 JSON.stringify 出来的，它应该是标准 JSON。
        rules = JSON.parse(jsonStr);
      } catch (e) {
        // 如果 JSON.parse 失败，尝试更宽松的解析或报错
        return Response.json({ error: "File content is not valid JSON" }, { 
            status: 500,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 检查是否已存在
      const pathKey = "/" + pathname;
      if (rules[pathKey]) {
        return Response.json({ error: "Pathname already exists" }, { 
            status: 409,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 添加新规则
      rules[pathKey] = {
        url: url,
        expired_at: expiredAtISO
      };

      // 5. 序列化并提交
      const newJsonStr = JSON.stringify(rules, null, 4);
      const newContent = `window.RULES_INTERMEDIATE = ${newJsonStr};\n`;
      
      // 处理 UTF-8 字符的 Base64 编码
      function utf8_to_b64(str) {
        return btoa(unescape(encodeURIComponent(str)));
      }
      const finalBase64 = utf8_to_b64(newContent);

      const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
      const commitMessage = `Add short link: ${pathname}`;

      const putResp = await fetch(putUrl, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "Cloudflare-Worker",
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: commitMessage,
          content: finalBase64,
          sha: sha,
          branch: branch
        })
      });

      if (!putResp.ok) {
        const errText = await putResp.text();
        console.error("GitHub API Error:", errText);
        return Response.json({ error: "Failed to commit to GitHub" }, { 
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      // 构建返回的短链 URL
      const baseDomain = env.BASE_DOMAIN || ""; 
      const shortUrl = baseDomain 
        ? `https://${baseDomain}/${pathname}` 
        : null; // 如果后端没配，前端自己拼

      const putRespData = await putResp.json();

      // 返回 Commit URL 方便前端跳转
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${putRespData.content.sha || "main"}`;

      return Response.json({ 
        success: true, 
        message: "Short link created",
        short_url: shortUrl,
        commit_url: commitUrl
      }, {
        headers: { "Access-Control-Allow-Origin": "*" }
      });

    } catch (err) {
      console.error(err);
      return Response.json({ error: "Internal Server Error: " + err.message }, { 
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
