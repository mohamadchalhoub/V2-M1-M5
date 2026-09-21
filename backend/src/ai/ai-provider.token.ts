/** DI token for the selected AiProvider implementation — ai.module.ts's factory picks the concrete class by AI_PROVIDER; nothing else in the codebase references a provider class by name (AI_INTEGRATION_SPEC.md §2, Phase 0 §10 Req. 11). */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
