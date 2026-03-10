/**
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export async function CopilotAuthPlugin() {
  const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm";
  const API_VERSION = "2025-05-01";
  const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
  const OAUTH_SCOPES = "read:user read:org repo gist";
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

  function normalizeDomain(url) {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  function getUrls(domain) {
    const apiDomain = domain === "github.com" ? "api.github.com" : `api.${domain}`;
    return {
      DEVICE_CODE_URL: `https://${domain}/login/device/code`,
      ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
      COPILOT_ENTITLEMENT_URL: `https://${apiDomain}/copilot_internal/user`,
    };
  }

  async function fetchEntitlement(info) {
    const domain = info.enterpriseUrl ? normalizeDomain(info.enterpriseUrl) : "github.com";
    const urls = getUrls(domain);

    const response = await fetch(urls.COPILOT_ENTITLEMENT_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${info.refresh}`,
        "User-Agent": "GithubCopilot/1.155.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Entitlement fetch failed: ${response.status}`);
    }

    return response.json();
  }

  async function fetchModels(info, baseURL) {
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${info.refresh}`,
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Openai-Intent": "model-access",
        "User-Agent": "opencode-copilot-cli-auth/0.0.15",
        "X-GitHub-Api-Version": API_VERSION,
        "X-Interaction-Type": "model-access",
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

    const liveById = new Map(liveModels.map((model) => [model.id, model]));
    const opus4_6 = provider.models["claude-opus-4.6"];
    const opus4_6_1m = liveById.get("claude-opus-4.6-1m");

    if (opus4_6 && opus4_6_1m && !provider.models["claude-opus-4.6-1m"]) {
      const limits = opus4_6_1m.capabilities?.limits ?? {};
      const supports = opus4_6_1m.capabilities?.supports ?? {};
      const vision = !!supports.vision || !!limits.vision;

      provider.models["claude-opus-4.6-1m"] = {
        ...structuredClone(opus4_6),
        id: "claude-opus-4.6-1m",
        api: {
          ...opus4_6.api,
          id: "claude-opus-4.6-1m",
        },
        name: "Claude Opus 4.6 (1M context)",
        family: opus4_6_1m.capabilities?.family ?? opus4_6.family,
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context:
            limits.max_context_window_tokens
            ?? opus4_6.limit.context,
          input:
            limits.max_prompt_tokens
            ?? opus4_6.limit.input
            ?? limits.max_context_window_tokens,
          output:
            limits.max_output_tokens
            ?? limits.max_non_streaming_output_tokens
            ?? opus4_6.limit.output,
        },
        capabilities: {
          ...structuredClone(opus4_6.capabilities),
          reasoning:
            opus4_6.capabilities.reasoning
            || !!supports.adaptive_thinking
            || typeof supports.max_thinking_budget === "number"
            || Array.isArray(supports.reasoning_effort),
          attachment: opus4_6.capabilities.attachment || vision,
          toolcall:
            opus4_6.capabilities.toolcall || !!supports.tool_calls,
          input: {
            ...structuredClone(opus4_6.capabilities.input),
            image: opus4_6.capabilities.input.image || vision,
          },
        },
      };
    }

    for (const model of Object.values(provider.models)) {
      model.cost = {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      };
      model.api.npm = "@ai-sdk/github-copilot";

      const live = liveById.get(model.id);
      if (!live) continue;

      const limits = live.capabilities?.limits ?? {};
      const supports = live.capabilities?.supports ?? {};
      const vision = !!supports.vision || !!limits.vision;

      model.limit.context =
        limits.max_context_window_tokens
        ?? model.limit.context;
      model.limit.input =
        limits.max_prompt_tokens
        ?? model.limit.input
        ?? limits.max_context_window_tokens;
      model.limit.output =
        limits.max_output_tokens
        ?? limits.max_non_streaming_output_tokens
        ?? model.limit.output;

      model.capabilities.reasoning =
        model.capabilities.reasoning
        || !!supports.adaptive_thinking
        || typeof supports.max_thinking_budget === "number"
        || Array.isArray(supports.reasoning_effort);
      model.capabilities.attachment = model.capabilities.attachment || vision;
      model.capabilities.toolcall =
        model.capabilities.toolcall || !!supports.tool_calls;

      if (vision) {
        model.capabilities.input.image = true;
      }

    }
  }

  function getConversationMetadata(init) {
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;

      if (body?.messages) {
        const lastMessage = body.messages[body.messages.length - 1];
        return {
          isVision: body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image_url"),
          ),
          isAgent:
            lastMessage?.role &&
            ["tool", "assistant"].includes(lastMessage.role),
        };
      }

      if (body?.input) {
        const lastInput = body.input[body.input.length - 1];
        const isAssistant = lastInput?.role === "assistant";
        const hasAgentType = lastInput?.type
          ? RESPONSES_API_ALTERNATE_INPUT_TYPES.includes(lastInput.type)
          : false;

        return {
          isVision:
            Array.isArray(lastInput?.content) &&
            lastInput.content.some((part) => part.type === "input_image"),
          isAgent: isAssistant || hasAgentType,
        };
      }
    } catch {}

    return {
      isVision: false,
      isAgent: false,
    };
  }

  function buildHeaders(init, info, isVision, isAgent) {
    const headers = {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${info.refresh}`,
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Openai-Intent": "conversation-agent",
      "User-Agent": "opencode-copilot-cli-auth/0.0.15",
      "X-GitHub-Api-Version": API_VERSION,
      "X-Initiator": isAgent ? "agent" : "user",
      "X-Interaction-Id": crypto.randomUUID(),
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": crypto.randomUUID(),
    };

    if (isVision) {
      headers["Copilot-Vision-Request"] = "true";
    }

    delete headers["x-api-key"];
    delete headers["authorization"];

    return headers;
  }

  function resolveClaudeThinkingBudget(model, variant) {
    if (!model?.id?.includes("claude")) return undefined;
    return variant === "thinking" ? 16000 : undefined;
  }

  return {
    auth: {
      provider: "github-copilot",
      loader: async (getAuth, provider) => {
        const info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        let baseURL = info.baseUrl;
        if (!baseURL) {
          const entitlement = await fetchEntitlement(info);
          baseURL = entitlement?.endpoints?.api;
        }

        if (baseURL) {
          try {
            const liveModels = await fetchModels(info, baseURL);
            patchProviderModels(provider, liveModels);
          } catch {}
        } else {
          patchProviderModels(provider, []);
        }

        return {
          ...(baseURL && { baseURL }),
          apiKey: "",
          async fetch(input, init) {
            const auth = await getAuth();
            if (!auth || auth.type !== "oauth") {
              return fetch(input, init);
            }

            const { isVision, isAgent } = getConversationMetadata(init);
            const headers = buildHeaders(init, auth, isVision, isAgent);

            return fetch(input, {
              ...init,
              headers,
            });
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot CLI",
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
                  if (!url.hostname) {
                    return "Please enter a valid URL or domain";
                  }
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
              domain = normalizeDomain(inputs.enterpriseUrl);
              actualProvider = "github-copilot-enterprise";
            }

            const urls = getUrls(domain);

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": "opencode-copilot-cli-auth/0.0.15",
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: OAUTH_SCOPES,
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
                      "User-Agent": "opencode-copilot-cli-auth/0.0.15",
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
                    const entitlement = await fetchEntitlement({
                      refresh: data.access_token,
                      enterpriseUrl:
                        actualProvider === "github-copilot-enterprise"
                          ? domain
                          : undefined,
                    });

                    const result = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      baseUrl: entitlement?.endpoints?.api,
                    };

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise";
                      result.enterpriseUrl = domain;
                    }

                    return result;
                  }

                  if (data.error === "authorization_pending") {
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        deviceData.interval * 1000
                          + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error === "slow_down") {
                    const nextInterval =
                      (typeof data.interval === "number" && data.interval > 0 ?
                        data.interval
                      : deviceData.interval + 5) * 1000;
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        nextInterval + OAUTH_POLLING_SAFETY_MARGIN_MS,
                      ),
                    );
                    continue;
                  }

                  if (data.error) return { type: "failed" };

                  await new Promise((resolve) =>
                    setTimeout(
                      resolve,
                      deviceData.interval * 1000
                        + OAUTH_POLLING_SAFETY_MARGIN_MS,
                    ),
                  );
                }
              },
            };
          },
        },
      ],
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
