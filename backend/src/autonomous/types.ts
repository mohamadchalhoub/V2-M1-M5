/** String-compatible with the Prisma `AutonomousLevelType` enum on purpose — named differently here to avoid an import collision with that generated type. Lives in its own file so both `level-confirmation.ts` and `autonomous-rule-engine.service.ts` can import it without creating a cycle between them. */
export type RuleLevelType = 'SUPPORT' | 'RESISTANCE';
