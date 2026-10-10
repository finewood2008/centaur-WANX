import { operationRegistry as baselineOperations, moduleRegistry as baselineModules } from "./generated/registry.js";
import { applicationOperationRegistry, applicationModuleRegistry } from "./generated/applications-registry.js";
/** Frozen 457-operation platform baseline plus explicit management protocol v1. */
import { brainstormOperationRegistry, brainstormModuleRegistry } from "./brainstorm-registry.js";
export const operationRegistry = [...baselineOperations, ...applicationOperationRegistry, ...brainstormOperationRegistry] as const;
export const moduleRegistry = { ...baselineModules, applications: applicationModuleRegistry, brainstorm: brainstormModuleRegistry } as const;
