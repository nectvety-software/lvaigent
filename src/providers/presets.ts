import type { Provider } from "../types";

/** Ready-made providers for the Settings dialog; duck.ai stays the default. */
export const API_PRESETS: Omit<Provider, "status" | "models">[] = [
  {
    id: "provider_openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiFormat: "openai",
  },
  {
    id: "provider_anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    apiFormat: "anthropic",
  },
  {
    id: "provider_openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    apiFormat: "openai",
  },
  {
    id: "provider_groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "",
    apiFormat: "openai",
  },
  {
    id: "provider_ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    apiFormat: "openai",
  },
];

export function makeProvider(preset: Omit<Provider, "status" | "models">): Provider {
  return { ...preset, models: [], status: "unknown" };
}
