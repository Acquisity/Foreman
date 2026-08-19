import { FACTORY_BRAIN_PREFIX, REPOSITORY_KNOWLEDGE_PREFIX } from "./blob.js";
import { repositoryHash } from "./repository.js";

export const MAX_REPOSITORY_KNOWLEDGE_LENGTH = 40_000;

export const repositoryKnowledgeKey = (repository: string): string =>
  `${REPOSITORY_KNOWLEDGE_PREFIX}${repositoryHash(repository)}.md`;

export const legacyFactoryBrainKey = (repository: string): string =>
  `${FACTORY_BRAIN_PREFIX}${repositoryHash(repository)}.md`;
