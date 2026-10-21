import {
  DYNAMIC_MCP_SERVER_PREFIX,
  type PermissionRule,
} from "./opencode-requests.ts";

/**
 * VK required session policy (a feature of our BB core fork), enforced here
 * through OpenCode's native session permission rules.
 *
 * Core hands the runtime half of a policy to every bridge as the
 * `vkSessionPolicy` provider option (with `vkRequiredSessionPolicy: 1` when it
 * is required). It has already narrowed BB plugins and BB skills; what is left
 * for this bridge is OpenCode's own skills and MCP servers:
 *
 * - skills: a `skill` deny rule removes the skill from the model's request.
 * - MCP servers: a deny on the `<server>_*` tool actions hides the server's
 *   tools and refuses calls to them, also through Code Mode.
 *
 * `nativePlugins` and `projectInstructions: false` are not enforceable per
 * session (OpenCode loads them in one shared service), so core refuses a
 * required policy that asks for them and this bridge never claims them.
 */

export type VkPolicyClause = { mode: "allow" | "deny"; names: string[] };
export type VkPolicyFilter = VkPolicyClause & { allOf?: VkPolicyClause[] };

export type VkSessionPolicy = {
  required: boolean;
  bbSkillsDenied: string[];
  skills?: VkPolicyFilter;
  mcpServers?: VkPolicyFilter;
};

/** The resource lists a policy is evaluated against. */
export type VkPolicyInventory = {
  /** Skill names OpenCode discovered; needed only for mixed allow clauses. */
  skills?: readonly string[];
  /** MCP server names OpenCode knows for the session's location. */
  mcpServers?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseClause(value: unknown): VkPolicyClause | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode !== "allow" && value.mode !== "deny") return undefined;
  if (
    !Array.isArray(value.names) ||
    !value.names.every((name) => typeof name === "string" && name.length > 0)
  )
    return undefined;
  return { mode: value.mode, names: value.names as string[] };
}

function parseFilter(value: unknown): VkPolicyFilter | undefined {
  const clause = parseClause(value);
  if (!clause || !isRecord(value)) return undefined;
  if (value.allOf === undefined) return clause;
  if (!Array.isArray(value.allOf)) return undefined;
  const allOf = value.allOf.map(parseClause);
  if (allOf.some((entry) => entry === undefined)) return undefined;
  return { ...clause, allOf: allOf as VkPolicyClause[] };
}

/**
 * Read the policy out of a turn's provider options. Returns null when there is
 * none. A required policy that arrives malformed or without its payload throws,
 * so a required policy is never silently dropped on the way to OpenCode.
 */
export function readVkSessionPolicy(
  providerOptions: unknown,
): VkSessionPolicy | null {
  if (!isRecord(providerOptions)) return null;
  const marker = providerOptions.vkRequiredSessionPolicy;
  const required = marker !== undefined;
  if (required && marker !== 1)
    throw new Error("vk_required_session_policy_unsupported_version");
  const raw = providerOptions.vkSessionPolicy;
  if (raw === undefined || raw === null) {
    if (required) throw new Error("vk_required_session_policy_dropped");
    return null;
  }
  const invalid = () => {
    if (required) throw new Error("vk_required_session_policy_invalid");
    return null;
  };
  if (!isRecord(raw) || raw.version !== 1) return invalid();
  if (required && raw.required !== true) return invalid();
  const skills = raw.skills === undefined ? undefined : parseFilter(raw.skills);
  const mcpServers =
    raw.mcpServers === undefined ? undefined : parseFilter(raw.mcpServers);
  if (
    (raw.skills !== undefined && !skills) ||
    (raw.mcpServers !== undefined && !mcpServers)
  )
    return invalid();
  const denied = raw.bbSkillsDenied;
  if (
    denied !== undefined &&
    (!Array.isArray(denied) ||
      !denied.every((name) => typeof name === "string"))
  )
    return invalid();
  return {
    required,
    bbSkillsDenied: (denied as string[] | undefined) ?? [],
    ...(skills ? { skills } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
}

function nameMatches(pattern: string, name: string) {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : pattern === name;
}

function clauseAllows(clause: VkPolicyClause, name: string) {
  const listed = clause.names.some((pattern) => nameMatches(pattern, name));
  return clause.mode === "allow" ? listed : !listed;
}

/** Whether the filter lets `name` through (every clause must). */
export function vkFilterAllows(filter: VkPolicyFilter, name: string) {
  return [filter, ...(filter.allOf ?? [])].every((clause) =>
    clauseAllows(clause, name),
  );
}

const deny = (action: string, resource: string): PermissionRule => ({
  action,
  resource,
  effect: "deny",
});

/**
 * `skill` rules for a filter. A single allow clause becomes `deny *` plus an
 * allow per listed pattern, so a skill OpenCode discovers later is hidden too.
 * Deny clauses become one deny per pattern. Several clauses with an allow list
 * cannot be written as patterns, so they are evaluated against the discovered
 * skills (`known`); without that list the rules cannot be built (undefined).
 */
function skillRules(
  filter: VkPolicyFilter,
  known: readonly string[] | undefined,
): PermissionRule[] | undefined {
  const clauses = [filter, ...(filter.allOf ?? [])];
  const allows = clauses.filter((clause) => clause.mode === "allow");
  const patterns = (list: VkPolicyClause[]) => [
    ...new Set(list.flatMap((clause) => clause.names)),
  ];
  if (allows.length === 0)
    return patterns(clauses).map((name) => deny("skill", name));
  if (clauses.length === 1)
    return [
      deny("skill", "*"),
      ...patterns(allows).map((name): PermissionRule => ({
        action: "skill",
        resource: name,
        effect: "allow",
      })),
    ];
  if (!known) return undefined;
  return [
    deny("skill", "*"),
    ...known
      .filter((name) => vkFilterAllows(filter, name))
      .map((name): PermissionRule => ({
        action: "skill",
        resource: name,
        effect: "allow",
      })),
  ];
}

/** Which resource lists a policy needs before its rules can be built. */
export function vkPolicyNeeds(policy: VkSessionPolicy) {
  const clauses = policy.skills
    ? [policy.skills, ...(policy.skills.allOf ?? [])]
    : [];
  return {
    skillList:
      clauses.length > 1 && clauses.some((clause) => clause.mode === "allow"),
    mcpList: policy.mcpServers !== undefined,
  };
}

/**
 * The permission rules a policy adds. They go after the permission-mode rules
 * (a mode may end with `* allow`, and the last matching rule wins). BB's own
 * tool servers (`bb_opencode2_*`) are never touched here: the existing rules
 * already hide other sessions' servers and allow this session's own.
 *
 * A required policy whose rules cannot be built throws instead of dropping a
 * restriction; an advisory one skips the group it could not resolve.
 */
export function vkPolicyRules(
  policy: VkSessionPolicy,
  inventory: VkPolicyInventory,
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  const unresolved = (what: string) => {
    if (policy.required)
      throw new Error(`vk_required_session_policy_unenforceable_${what}`);
  };
  if (policy.skills) {
    const built = skillRules(policy.skills, inventory.skills);
    if (built) rules.push(...built);
    else unresolved("skills");
  }
  // BB skills core dropped from the session must not come back through
  // OpenCode's own discovery under the same name.
  for (const name of policy.bbSkillsDenied) rules.push(deny("skill", name));
  if (policy.mcpServers) {
    const filter = policy.mcpServers;
    if (inventory.mcpServers) {
      for (const server of inventory.mcpServers) {
        if (server.startsWith(DYNAMIC_MCP_SERVER_PREFIX)) continue;
        if (!vkFilterAllows(filter, server))
          rules.push(deny(`${server}_*`, "*"));
      }
    } else unresolved("mcp_servers");
  }
  return rules;
}
