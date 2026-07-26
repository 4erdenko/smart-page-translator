(function initializeProviderCore(root, factory) {
  const api = factory();
  root.SmartTranslationProviderCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createProviderCore() {
  const PROVIDERS = Object.freeze({
    deepseek: Object.freeze({
      apiBaseUrl: "https://api.deepseek.com",
      apiKeyUrl: "https://platform.deepseek.com/api_keys",
      defaultModel: "deepseek-v4-flash",
      id: "deepseek",
      label: "DeepSeek"
    }),
    openai: Object.freeze({
      apiBaseUrl: "https://api.openai.com/v1",
      apiKeyUrl: "https://platform.openai.com/api-keys",
      defaultModel: "gpt-5.6-luna",
      id: "openai",
      label: "OpenAI"
    })
  });

  function normalizeProvider(value) {
    return Object.hasOwn(PROVIDERS, value) ? value : "deepseek";
  }

  function normalizeModel(value, fallback) {
    const model = String(value ?? "").trim();
    return /^[a-z0-9._:-]{1,100}$/iu.test(model) ? model : fallback;
  }

  function normalizeProviderModels(value, legacyModel = "") {
    const models = value && typeof value === "object" ? value : {};
    return Object.fromEntries(Object.entries(PROVIDERS).map(([provider, definition]) => [
      provider,
      normalizeModel(
        models[provider] || (provider === "deepseek" ? legacyModel : ""),
        definition.defaultModel
      )
    ]));
  }

  function getSelectedModel(settings) {
    const provider = normalizeProvider(settings?.provider);
    return normalizeProviderModels(settings?.providerModels, settings?.model)[provider];
  }

  function isCompatibleModel(provider, model) {
    const id = String(model || "").trim().toLowerCase();

    if (!id) {
      return false;
    }

    if (provider === "deepseek") {
      return id.startsWith("deepseek-");
    }

    return /^(?:gpt-|o\d)/u.test(id)
      && !/(?:audio|codex|computer-use|dall-e|deep-research|embedding|image|moderation|realtime|search|sora|transcrib|tts|whisper)/u.test(id)
      && !/(?:^|[-.])pro(?:[-.]|$)/u.test(id);
  }

  function modelRank(provider, model) {
    const id = model.toLowerCase();
    const preferred = provider === "deepseek"
      ? ["flash", "chat", "pro", "reasoner"]
      : ["luna", "nano", "mini", "terra", "sol"];
    const rank = preferred.findIndex((part) => id.includes(part));
    return rank < 0 ? preferred.length : rank;
  }

  function filterProviderModels(providerValue, values) {
    const provider = normalizeProvider(providerValue);
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => normalizeModel(value, ""))
      .filter((value) => isCompatibleModel(provider, value)))]
      .sort((left, right) => modelRank(provider, left) - modelRank(provider, right)
        || left.localeCompare(right, "en", { numeric: true }));
  }

  function buildProviderRequest(providerValue, { maxTokens, messages, model }) {
    const provider = normalizeProvider(providerValue);
    const definition = PROVIDERS[provider];
    const body = {
      messages,
      model: normalizeModel(model, definition.defaultModel),
      response_format: { type: "json_object" },
      stream: false
    };

    if (provider === "deepseek") {
      body.max_tokens = maxTokens;
      body.temperature = 0.1;
      body.thinking = { type: "disabled" };
    } else {
      body.max_completion_tokens = maxTokens;

      if (/^gpt-5\./u.test(body.model)) {
        body.reasoning_effort = "none";
      }
    }

    return {
      body,
      url: `${definition.apiBaseUrl}/chat/completions`
    };
  }

  function getModelsUrl(providerValue) {
    return `${PROVIDERS[normalizeProvider(providerValue)].apiBaseUrl}/models`;
  }

  return Object.freeze({
    PROVIDERS,
    buildProviderRequest,
    filterProviderModels,
    getModelsUrl,
    getSelectedModel,
    isCompatibleModel,
    normalizeModel,
    normalizeProvider,
    normalizeProviderModels
  });
});
