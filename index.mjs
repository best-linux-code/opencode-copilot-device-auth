/**
 * OpenCode Copilot Auth Plugin
 *
 * Based on: https://github.com/anomalyco/opencode-copilot-auth
 * Enhanced with: fetchModels, limit patching, Claude thinking variants,
 *                claude-opus-4.6-1m registration, file logging.
 *
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function CopilotAuthPlugin({ client }) {
  const CLIENT_ID = "Iv1.b507a08c87ecfe98";
  const HEADERS = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
  };
  const RESPONSES_API_ALTERNATE_INPUT_TYPES = [
    "file_search_call",
    "computer_call",
    "computer_call_output",
    "web_search_call",
    "function_call",
    "function_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "mcp_call",
    "reasoning",
  ];

  // ── File logging (OpenCode doesn't capture plugin console output) ──
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const LOG_FILE = "/tmp/copilot-device-auth.log";
  const log = (msg) => {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };
  const MODEL_LIMITS = new Map(); // model_id -> { input, context, output }

  // ── Cleanup stale config when no auth ──
  // Must run at plugin init (top-level), NOT inside loader,
  // because provider.ts skips loader entirely when auth is absent.
  try {
    const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    let hasAuth = false;
    try {
      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      hasAuth = !!(authData["github-copilot"]?.type === "oauth" && authData["github-copilot"]?.refresh);
    } catch {}  // auth.json missing = no auth
    if (!hasAuth) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.provider?.["github-copilot"]) {
        delete config.provider["github-copilot"];
        if (config.provider && Object.keys(config.provider).length === 0) delete config.provider;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        log("Removed github-copilot config (no auth)");
      }
    }
  } catch (e) {
    log(`Config cleanup error: ${e.message}`);
  }

  // ── Helpers ──

  function normalizeDomain(url) {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  function getUrls(domain) {
    return {
      DEVICE_CODE_URL: `https://${domain}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
      TOKEN_URL_V2: `https://api.${domain}/copilot_internal/v2/token`,
      TOKEN_URL_V1: `https://api.${domain}/copilot_internal/user`,
    };
  }

  // Fetch baseURL (endpoints.api) from entitlement API
  // Try /v2/token first (also returns short-lived token), fallback to /copilot_internal/user
  async function fetchBaseURL(refreshToken, domain) {
    const urls = getUrls(domain);
    const authHeaders = {
      Accept: "application/json",
      ...HEADERS,
    };

    // Try /v2/token — returns token + endpoints
    try {
      const res = await fetch(urls.TOKEN_URL_V2, {
        headers: { ...authHeaders, Authorization: `Bearer ${refreshToken}` },
      });
      if (res.ok) {
        const d = await res.json();
        if (d.endpoints?.api) {
          log(`/v2/token OK, baseURL=${d.endpoints.api}${d.token ? ', has token' : ''}`);
          return {
            baseURL: d.endpoints.api,
            token: d.token || null,
            expires: d.expires_at ? d.expires_at * 1000 - 5 * 60 * 1000 : 0,
          };
        }
      }
    } catch (e) {
      log(`/v2/token failed: ${e.message}`);
    }

    // Fallback: /copilot_internal/user — returns endpoints (may not have token)
    try {
      const res = await fetch(urls.TOKEN_URL_V1, {
        headers: { ...authHeaders, Authorization: `token ${refreshToken}` },
      });
      if (res.ok) {
        const d = await res.json();
        if (d.endpoints?.api) {
          log(`/user OK, baseURL=${d.endpoints.api}${d.token ? ', has token' : ''}`);
          return {
            baseURL: d.endpoints.api,
            token: d.token || null,
            expires: d.expires_at ? d.expires_at * 1000 - 5 * 60 * 1000 : 0,
          };
        }
      }
    } catch (e) {
      log(`/user fallback failed: ${e.message}`);
    }

    throw new Error("All token endpoints failed");
  }

  // ── Model fetching & patching ──

  async function fetchModels(token, baseURL) {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...HEADERS,
        "Openai-Intent": "conversation-panel",
        "X-GitHub-Api-Version": "2025-04-01",
        "X-Request-Id": crypto.randomUUID(),
      },
    });

    if (!response.ok) {
      throw new Error(`Model fetch failed: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
  }

  function patchProviderModels(provider, liveModels) {
    if (!provider?.models) return;

    const liveById = new Map(liveModels.map((m) => [m.id, m]));

    // Register claude-opus-4.6-1m if API reports it but provider doesn't have it
    const opus4_6 = provider.models["claude-opus-4.6"];
    const opus4_6_1m = liveById.get("claude-opus-4.6-1m");
    if (opus4_6 && opus4_6_1m && !provider.models["claude-opus-4.6-1m"]) {
      const limits = opus4_6_1m.capabilities?.limits ?? {};
      const supports = opus4_6_1m.capabilities?.supports ?? {};
      const vision = !!supports.vision || !!limits.vision;
      provider.models["claude-opus-4.6-1m"] = {
        ...structuredClone(opus4_6),
        id: "claude-opus-4.6-1m",
        api: { ...opus4_6.api, id: "claude-opus-4.6-1m" },
        name: "Claude Opus 4.6 (1M context)",
        family: opus4_6_1m.capabilities?.family ?? opus4_6.family,
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: {
          context: limits.max_context_window_tokens ?? opus4_6.limit.context,
          input: limits.max_prompt_tokens ?? opus4_6.limit.input ?? limits.max_context_window_tokens ?? opus4_6.limit.context,
          output: limits.max_output_tokens ?? limits.max_non_streaming_output_tokens ?? opus4_6.limit.output ?? 32000,
        },
        capabilities: {
          ...structuredClone(opus4_6.capabilities),
          reasoning:
            opus4_6.capabilities.reasoning ||
            !!supports.adaptive_thinking ||
            typeof supports.max_thinking_budget === "number" ||
            Array.isArray(supports.reasoning_effort),
          attachment: opus4_6.capabilities.attachment || vision,
          toolcall: opus4_6.capabilities.toolcall || !!supports.tool_calls,
          input: {
            ...structuredClone(opus4_6.capabilities.input),
            image: opus4_6.capabilities.input.image || vision,
          },
        },
      };
    }

    // Patch all models: zero cost + live limits + capabilities
    for (const model of Object.values(provider.models)) {
      model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
      model.api.npm = "@ai-sdk/github-copilot";

      const live = liveById.get(model.id);
      if (!live) continue;

      const limits = live.capabilities?.limits ?? {};
      const supports = live.capabilities?.supports ?? {};
      const vision = !!supports.vision || !!limits.vision;

      model.limit.context = limits.max_context_window_tokens ?? model.limit.context;
      model.limit.output = limits.max_output_tokens ?? limits.max_non_streaming_output_tokens ?? model.limit.output ?? 32000;
      // input must use max_prompt_tokens (server-enforced), NOT max_context_window_tokens
      // fallback: context - output (safe estimate when max_prompt_tokens is missing)
      model.limit.input = limits.max_prompt_tokens ?? model.limit.input ?? (model.limit.context - model.limit.output);
      MODEL_LIMITS.set(model.id, { input: model.limit.input, context: model.limit.context, output: model.limit.output });

      model.capabilities.reasoning =
        model.capabilities.reasoning ||
        !!supports.adaptive_thinking ||
        typeof supports.max_thinking_budget === "number" ||
        Array.isArray(supports.reasoning_effort);
      model.capabilities.attachment = model.capabilities.attachment || vision;
      model.capabilities.toolcall = model.capabilities.toolcall || !!supports.tool_calls;
      if (vision) {
        model.capabilities.input.image = true;
      }
    }
  }

  // Write variant configs to opencode.json for Claude and Gemini models only.
  // Other models (GPT-5.x etc.) already get correct variants from transform.ts.
  function writeVariantConfigs(provider, liveModels) {
    const os = require("node:os");
    const path = require("node:path");
    const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const liveById = new Map(liveModels.map((m) => [m.id, m]));
    const variantUpdates = {};

    for (const model of Object.values(provider.models)) {
      const live = liveById.get(model.id);
      const supports = live?.capabilities?.supports;
      if (!supports) continue;

      const efforts = supports.reasoning_effort;
      if (!Array.isArray(efforts) || efforts.length === 0) continue;

      const isClaude = model.id.includes("claude");
      const isGemini = model.id.includes("gemini");
      if (!isClaude && !isGemini) continue;

      const minBudget = supports.min_thinking_budget;
      const maxBudget = supports.max_thinking_budget;

      if (isClaude && typeof minBudget === "number" && typeof maxBudget === "number") {
        const variants = { thinking: { disabled: true } };
        for (let i = 0; i < efforts.length; i++) {
          const ratio = efforts.length > 1 ? i / (efforts.length - 1) : 1;
          const budget = Math.round(minBudget + ratio * (maxBudget - minBudget));
          variants[efforts[i]] = { thinking_budget: budget };
        }
        variantUpdates[model.id] = variants;
      } else if (isGemini) {
        const variants = {};
        for (const effort of efforts) {
          variants[effort] = { reasoningEffort: effort };
        }
        variantUpdates[model.id] = variants;
      }
    }

    if (Object.keys(variantUpdates).length === 0) return;

    if (!config.provider) config.provider = {};
    if (!config.provider["github-copilot"]) config.provider["github-copilot"] = {};
    if (!config.provider["github-copilot"].models) config.provider["github-copilot"].models = {};
    const cfgModels = config.provider["github-copilot"].models;

    // Remove stale entries not in this update
    for (const mid of Object.keys(cfgModels)) {
      if (cfgModels[mid].variants && !variantUpdates[mid]) delete cfgModels[mid];
    }
    for (const [id, variants] of Object.entries(variantUpdates)) {
      if (!cfgModels[id]) cfgModels[id] = {};
      cfgModels[id].variants = variants;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log(`Wrote variant configs: ${Object.keys(variantUpdates).join(", ")}`);
  }

  function resolveClaudeThinkingBudget(model, variant) {
    if (!model?.id?.includes("claude")) return undefined;
    return model.variants?.[variant]?.thinking_budget;
  }

  // ── Plugin return ──

  return {
    auth: {
      provider: "github-copilot",
      loader: async (getAuth, provider) => {
        let info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        if (provider) {
          patchProviderModels(provider, []);
        }

        // Dynamically fetch baseURL from entitlement API (endpoints.api)
        const domain = info.enterpriseUrl
          ? normalizeDomain(info.enterpriseUrl)
          : "github.com";
        let baseURL;
        try {
          const result = await fetchBaseURL(info.refresh, domain);
          baseURL = result.baseURL;

          // If /v2/token returned a short-lived token, save it
          if (result.token) {
            const saveProviderID = info.enterpriseUrl
              ? "github-copilot-enterprise"
              : "github-copilot";
            await client.auth.set({
              path: { id: saveProviderID },
              body: {
                type: "oauth",
                refresh: info.refresh,
                access: result.token,
                expires: result.expires,
                ...(info.enterpriseUrl && { enterpriseUrl: info.enterpriseUrl }),
              },
            });
            info.access = result.token;
            info.expires = result.expires;
          }
        } catch (e) {
          log(`fetchBaseURL failed: ${e.message}, using hardcoded baseURL`);
          baseURL = info.enterpriseUrl
            ? `https://copilot-api.${normalizeDomain(info.enterpriseUrl)}`
            : "https://api.githubcopilot.com";
        }

        // Fetch live models and patch provider
        if (provider) {
          try {
            const liveModels = await fetchModels(info.access || info.refresh, baseURL);
            log(`Live models: ${liveModels.length} total`);
            patchProviderModels(provider, liveModels);

            // Log each model's limits and reasoning_effort
            const liveById = new Map(liveModels.map((m) => [m.id, m]));
            for (const model of Object.values(provider.models)) {
              const live = liveById.get(model.id);
              const supports = live?.capabilities?.supports;
              const efforts = supports?.reasoning_effort;
              log(
                `  ${model.id}: context=${model.limit.context}, input=${model.limit.input}, output=${model.limit.output}` +
                (efforts ? `, reasoning_effort=[${efforts}]` : "")
              );
            }

            try {
              writeVariantConfigs(provider, liveModels);
            } catch (e) {
              log(`Failed to write variant config: ${e.message}`);
            }
          } catch (e) {
            log(`fetchModels failed: ${e.message}`);
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(input, init) {
            let info = await getAuth();
            if (info.type !== "oauth") return {};

            // Token refresh: only when we have a real short-lived token with expiry
            // (OAuth gho_* tokens don't expire, so expires=0 means skip refresh)
            if (info.expires > 0 && info.expires < Date.now()) {
              const domain = info.enterpriseUrl
                ? normalizeDomain(info.enterpriseUrl)
                : "github.com";
              try {
                const result = await fetchBaseURL(info.refresh, domain);
                if (result.token) {
                  const saveProviderID = info.enterpriseUrl
                    ? "github-copilot-enterprise"
                    : "github-copilot";
                  await client.auth.set({
                    path: { id: saveProviderID },
                    body: {
                      type: "oauth",
                      refresh: info.refresh,
                      access: result.token,
                      expires: result.expires,
                      ...(info.enterpriseUrl && { enterpriseUrl: info.enterpriseUrl }),
                    },
                  });
                  info.access = result.token;
                }
              } catch (e) {
                log(`Token refresh error: ${e.message}`);
              }
            }

            // Detect conversation metadata for headers
            let isAgentCall = false;
            let isVisionRequest = false;
            let bodyModel = "unknown";
            try {
              const body =
                typeof init.body === "string"
                  ? JSON.parse(init.body)
                  : init.body;

              if (body?.messages) {
                if (body.messages.length > 0) {
                  const lastMessage = body.messages[body.messages.length - 1];
                  isAgentCall =
                    lastMessage.role &&
                    ["tool", "assistant"].includes(lastMessage.role);
                }
                isVisionRequest = body.messages.some(
                  (msg) =>
                    Array.isArray(msg.content) &&
                    msg.content.some((part) => part.type === "image_url"),
                );
              }

              if (body?.input) {
                const lastInput = body.input[body.input.length - 1];
                const isAssistant = lastInput?.role === "assistant";
                const hasAgentType = lastInput?.type
                  ? RESPONSES_API_ALTERNATE_INPUT_TYPES.includes(lastInput.type)
                  : false;
                isAgentCall = isAssistant || hasAgentType;
                isVisionRequest =
                  Array.isArray(lastInput?.content) &&
                  lastInput.content.some((part) => part.type === "input_image");
              }

              bodyModel = body?.model ?? "unknown";
            } catch (e) {
              log(`Body parse error: ${e.message}`);
            }

            // Extract session ID from OpenCode headers
            const rawHdrs = init?.headers;
            const sessionId = (rawHdrs?.get ? rawHdrs.get("x-opencode-session") : rawHdrs?.["x-opencode-session"]) || "";
            const sid = sessionId ? sessionId.slice(0, 16) : "none";

            const headers = {
              ...init.headers,
              ...HEADERS,
              Authorization: `Bearer ${info.access || info.refresh}`,
              "Openai-Intent": "conversation-edits",
              "x-initiator": isAgentCall ? "agent" : "user",
            };
            if (isVisionRequest) {
              headers["Copilot-Vision-Request"] = "true";
            }

            delete headers["x-api-key"];
            delete headers["authorization"];

            const url = typeof input === "string" ? input : input?.url ?? String(input);
            log(`fetch → ${url.replace(/\/\/[^/]+/, "//***")} model=${bodyModel}`);

            const resp = await fetch(input, {
              ...init,
              headers,
            });
            if (!resp.ok) {
              const cloned = resp.clone();
              try {
                const errBody = await cloned.text();
                log(`fetch ← ${resp.status} ${resp.statusText} session=${sid} model=${bodyModel} ${url.replace(/\/\/[^/]+/, "//***")} body=${errBody.slice(0, 300)}`);
              } catch (_) {}
            } else {
              // Log model usage from non-streaming responses
              const contentType = resp.headers.get("content-type") || "";
              if (contentType.includes("application/json") && !contentType.includes("stream")) {
                try {
                  const cloned = resp.clone();
                  const data = await cloned.json();
                  const u = data.usage;
                  if (u) {
                    const cd = u.prompt_tokens_details || {};
                    const lim = MODEL_LIMITS.get(data.model || bodyModel);
                    const rate = lim ? ` usage_rate=${Math.round((u.total_tokens / lim.context) * 100)}%` : "";
                    log(`usage session=${sid} model=${data.model || bodyModel} total=${u.total_tokens} input=${u.prompt_tokens} output=${u.completion_tokens} cache_read=${cd.cached_tokens ?? 0} cache_write=${u.prompt_tokens - (cd.cached_tokens ?? 0)}${rate}`);
                  } else {
                    log(`fetch ← ${resp.status} session=${sid} model=${bodyModel} ${url.replace(/\/\/[^/]+/, "//***")}`);
                  }
                } catch (_) {
                  log(`fetch ← ${resp.status} session=${sid} model=${bodyModel} ${url.replace(/\/\/[^/]+/, "//***")}`);
                }
              } else if (contentType.includes("text/event-stream")) {
                // Streaming response: wrap body to capture final usage chunk
                const origBody = resp.body;
                const { readable, writable } = new TransformStream({
                  transform(chunk, controller) {
                    controller.enqueue(chunk);
                  },
                  flush() {}
                });
                const reader = origBody.getReader();
                const writer = writable.getWriter();
                const decoder = new TextDecoder();
                let usageLogged = false;
                (async () => {
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) { await writer.close(); break; }
                      await writer.write(value);
                      const text = decoder.decode(value, { stream: true });
                      if (!usageLogged && text.includes('"usage"')) {
                        const lines = text.split('\n');
                        for (const line of lines) {
                          if (!line.startsWith('data: ')) continue;
                          const payload = line.slice(6).trim();
                          if (payload === '[DONE]') continue;
                          try {
                            const parsed = JSON.parse(payload);
                            if (parsed.usage) {
                              const u = parsed.usage;
                              const cd = u.prompt_tokens_details || {};
                              const lim = MODEL_LIMITS.get(parsed.model || bodyModel);
                              const rate = lim ? ` usage_rate=${Math.round((u.total_tokens / lim.context) * 100)}%` : "";
                              log(`usage session=${sid} model=${parsed.model || bodyModel} total=${u.total_tokens} input=${u.prompt_tokens} output=${u.completion_tokens} cache_read=${cd.cached_tokens ?? 0} cache_write=${u.prompt_tokens - (cd.cached_tokens ?? 0)}${rate}`);
                              usageLogged = true;
                            }
                          } catch (_) {}
                        }
                      }
                    }
                  } catch (e) { try { await writer.abort(e); } catch(_){} }
                })();
                return new Response(readable, {
                  status: resp.status,
                  statusText: resp.statusText,
                  headers: resp.headers,
                });
              } else {
                log(`fetch ← ${resp.status} session=${sid} model=${bodyModel} ${url.replace(/\/\/[^/]+/, "//***")}`);
              }
            }
            return resp;
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required";
                try {
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname)
                    return "Please enter a valid URL or domain";
                  return undefined;
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com";

            let domain = "github.com";
            let actualProvider = "github-copilot";

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl;
              domain = normalizeDomain(enterpriseUrl);
              actualProvider = "github-copilot-enterprise";
            }

            const urls = getUrls(domain);

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...HEADERS,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user",
              }),
            });

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization");
            }

            const deviceData = await deviceResponse.json();

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              callback: async () => {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      ...HEADERS,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type:
                        "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  });

                  if (!response.ok) return { type: "failed" };

                  const data = await response.json();

                  if (data.access_token) {
                    // Immediately fetch baseURL and save with real access token
                    let baseUrl;
                    try {
                      const result = await fetchBaseURL(data.access_token, domain);
                      baseUrl = result.baseURL;
                      // If /v2/token returned a short-lived token, use it as access
                      if (result.token) {
                        const tokenResult = {
                          type: "success",
                          refresh: data.access_token,
                          access: result.token,
                          expires: result.expires,
                          baseUrl,
                        };
                        if (actualProvider === "github-copilot-enterprise") {
                          tokenResult.provider = "github-copilot-enterprise";
                          tokenResult.enterpriseUrl = domain;
                        }
                        return tokenResult;
                      }
                    } catch (e) {
                      log(`Post-login fetchBaseURL failed: ${e.message}`);
                    }

                    // Fallback: save access_token as both refresh and access
                    const result = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      ...(baseUrl && { baseUrl }),
                    };

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise";
                      result.enterpriseUrl = domain;
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(resolve, deviceData.interval * 1000),
                    );
                    continue;
                  }

                  // Handle slow_down: GitHub asks us to increase polling interval
                  if (data.error === "slow_down") {
                    deviceData.interval = (deviceData.interval || 5) + 5;
                    log(`OAuth polling slow_down, interval now ${deviceData.interval}s`);
                    await new Promise((resolve) =>
                      setTimeout(resolve, deviceData.interval * 1000),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(resolve, deviceData.interval * 1000),
                  );
                  continue;
                }
              },
            };
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "github-copilot") return;
      if (input.sessionID) {
        output.headers["x-opencode-session"] = input.sessionID;
      }
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "github-copilot") return;
      if (input.model.api?.npm !== "@ai-sdk/github-copilot") return;
      if (!input.model.id.includes("claude")) return;

      const thinkingBudget = resolveClaudeThinkingBudget(input.model, input.message.variant);
      if (thinkingBudget === undefined) return;

      output.options.thinking_budget = thinkingBudget;
    },
  };
}
