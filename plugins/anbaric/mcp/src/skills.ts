import {anbaricClient} from "./client";
import {Tool} from "./tools";

type TenantSkill = { id : string, title : string, usageHints : string, body : string };

const CACHE_MS = 30_000;
const TOOL_NAME_LIMIT = 64;
const PREFIX = "anbaric_skill_";

const noInput = { type: "object", properties: {}, additionalProperties: false };

let cached : { at : number, tools : Array<Tool> } | undefined;

/* The tenant's skills, as tools. A skill's usage hints become the tool's
   description - what the agent reads to decide whether it applies - and its
   body is what the tool answers once called. Fetched from the tenant when the
   tools are listed, so a skill written in the console is offered without a
   new release of anything; cached briefly so repeated listings cost nothing.
   Nothing here is allowed to fail the listing: not signed in, a platform too
   old to serve skills, or no platform at all each mean simply no skill tools. */
const tenantSkillTools = async () : Promise<Array<Tool>> => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.tools;

    let tools : Array<Tool> = [];
    try {
        const skills = await (await anbaricClient()).get("/skills") as Array<TenantSkill>;
        tools = toolsFor(Array.isArray(skills) ? skills : []);
    } catch {
        tools = [];
    }
    cached = { at: Date.now(), tools };
    return tools;
};

// After a sign-in, or whenever the tenant may have changed under us.
const invalidateSkillTools = () : void => {
    cached = undefined;
};

const toolsFor = (skills : Array<TenantSkill>) : Array<Tool> => {
    const seen = new Set<string>();
    const tools : Array<Tool> = [];
    for (const skill of skills) {
        const name = `${PREFIX}${skill.id.replace(/-/g, "_")}`;
        if (name.length > TOOL_NAME_LIMIT || seen.has(name)) continue;
        seen.add(name);
        tools.push({
            name,
            description: `Tenant-authored skill "${skill.title}": ${skill.usageHints}`,
            inputSchema: noInput,
            run: async () => skill.body,
        });
    }
    return tools;
};

export { tenantSkillTools, invalidateSkillTools, toolsFor };
export type { TenantSkill };
