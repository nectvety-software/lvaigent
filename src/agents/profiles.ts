import type { AgentProfile } from "../types";

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: "coding",
    name: "Coding",
    description: "AI coding assistant for software development tasks",
    systemPrompt: "You are an expert software developer. Help with coding, debugging, architecture, and best practices. Write clean, efficient code.",
    icon: "Code2",
  },
  {
    id: "pentest",
    name: "Pentest Agent",
    description: "Security testing and vulnerability assessment",
    systemPrompt: "You are a cybersecurity expert. Help with penetration testing, vulnerability assessment, and security hardening.",
    icon: "Shield",
  },
  {
    id: "content",
    name: "Content Ops",
    description: "Multi-platform content creation and management",
    systemPrompt: "You are a content operations expert. Help with content creation, editing, and multi-platform publishing.",
    icon: "FileText",
  },
  {
    id: "compose",
    name: "Compose Agent",
    description: "Specs -> Plans -> Build -> Report workflow",
    systemPrompt: "You are a project composer. Help break down requirements into specs, create plans, build solutions, and generate reports.",
    icon: "Layout",
  },
];
