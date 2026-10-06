import {PlatformClient} from "./platform/PlatformClient";
import {actorName, anbaricClient} from "./client";
import {deployApp} from "./deploy";
import {UX_GUIDANCE} from "./guidance";

type Tool = {
    name : string,
    description : string,
    inputSchema : Record<string, any>,
    run : (args : Record<string, any>) => Promise<unknown>,
};

const noInput = { type: "object", properties: {}, additionalProperties: false };

const object = (properties : Record<string, any>, required : Array<string> = []) =>
    ({ type: "object", properties, required, additionalProperties: false });

const resolveAppId = async (client : PlatformClient, workflowId : string) : Promise<string | undefined> => {
    const machines = await client.get("/state-machines") as Array<{ appId? : string, workflowId : string }>;
    const matches = machines.filter(machine => machine.workflowId === workflowId);
    if (matches.length > 1) {
        throw new Error(`Workflow "${workflowId}" exists in more than one app (${matches.map(match => match.appId ?? "—").join(", ")}); it cannot be addressed by workflow id alone.`);
    }
    return matches[0]?.appId;
};

const enqueue = async (client : PlatformClient, jobId : string, appId : string | undefined, workflowId? : string) : Promise<boolean> => {
    if (!workflowId) return false;
    await client.post("/queue/enqueue", { jobId, appId, workflowId });
    return true;
};

const fetchLogs = async (client : PlatformClient, appName : string, lines : number) : Promise<Array<string>> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let buffer = "";
    try {
        await client.stream(`/apps/${encodeURIComponent(appName)}/logs`, text => {
            buffer += text;
            if (buffer.split("\n").length > lines) controller.abort();
        }, controller.signal);
    } catch (error) {
        if (!controller.signal.aborted) throw error;
    } finally {
        clearTimeout(timeout);
    }
    return buffer.split("\n").filter(row => row.length > 0).slice(-lines);
};

const tools : Array<Tool> = [
    {
        name: "anbaric_ux_guidance",
        description: "Read this BEFORE building any human-facing UI for an Anbaric app. Anbaric apps are asynchronous - submitting a form hands work to a state machine rather than completing it - so a UI that neither acknowledges the submission nor follows the job afterwards reads as broken even when it is working. Returns the platform's UX practices: acknowledging an update immediately, polling the job until it settles (at most once per second), surfacing failed jobs, and optional styling guidance.",
        inputSchema: noInput,
        run: async () => UX_GUIDANCE,
    },
    {
        name: "anbaric_whoami",
        description: "Report the platform URL, tenant and identity this session is authenticated as. Use it to confirm the developer is signed in before deploying or driving jobs.",
        inputSchema: noInput,
        run: async () => (await anbaricClient()).get("/whoami"),
    },
    {
        name: "anbaric_apps",
        description: "List the apps deployed to the current tenant, with their status and port.",
        inputSchema: noInput,
        run: async () => (await anbaricClient()).get("/apps"),
    },
    {
        name: "anbaric_app_status",
        description: "Get one app's deploy state (building / draining / running / failed / stopped), port and recent build log. "
            + "\"draining\" means the running version has been told to stop taking on jobs and is finishing the steps it has in hand "
            + "(`draining.inFlight`, five minutes at most) before it is replaced or removed.",
        inputSchema: object({ name: { type: "string", description: "The app name" } }, ["name"]),
        run: async (args) => (await anbaricClient()).get(`/apps/${encodeURIComponent(args.name)}`),
    },
    {
        name: "anbaric_app_logs",
        description: "Fetch the most recent runtime log lines for a deployed app (bounded snapshot, not a live tail).",
        inputSchema: object({
            name: { type: "string", description: "The app name" },
            lines: { type: "number", description: "How many recent lines to return (default 200)" },
        }, ["name"]),
        run: async (args) => fetchLogs(await anbaricClient(), args.name, args.lines ?? 200),
    },
    {
        name: "anbaric_deploy",
        description: "Package a local Anbaric app directory (its .anbaric/app-config.json supplies name and port), upload it and wait for the build to go live. "
            + "A running version is drained first - it finishes the steps it has in hand, up to five minutes - so a redeploy never loses in-flight work; "
            + "the wait covers that. Returns the final status and URL. The developer must be signed in (`anbaric login`).",
        inputSchema: object({
            directory: { type: "string", description: "Path to the app project root (the folder containing .anbaric/app-config.json)" },
        }, ["directory"]),
        run: async (args) => deployApp(await anbaricClient(), args.directory),
    },
    {
        name: "anbaric_state_machines",
        description: "List the state machines registered across deployed apps, with their app and workflow ids.",
        inputSchema: noInput,
        run: async () => (await anbaricClient()).get("/state-machines"),
    },
    {
        name: "anbaric_jobs_list",
        description: "List jobs on the tenant, one page at a time, newest first by default. "
            + "The platform holds every job across all apps and state machines; this returns a page of `pageSize` "
            + "(default 100) at page `page` (from 0), so there is no cap - keep asking for the next page while `hasMore` "
            + "is true. Filters (workflowId, appId, state, status, killed) narrow the set on the platform before paging, "
            + "so they see every job, not just one page.",
        inputSchema: object({
            workflowId: { type: "string", description: "Only jobs of this state machine (workflow) id" },
            appId: { type: "string", description: "Only jobs belonging to this app" },
            state: { type: "string", description: "Only jobs currently in this state" },
            status: { type: "string", description: "Only jobs with this status: \"active\", \"Awaiting input\" or \"Failed\"" },
            killed: { type: "boolean", description: "true for killed jobs only, false to leave them out" },
            page: { type: "integer", minimum: 0, description: "Which page, from 0 (default 0)" },
            pageSize: { type: "integer", minimum: 1, maximum: 500, description: "Jobs per page (default 100)" },
            order: { type: "string", enum: ["newest", "oldest"], description: "By when the job was started (default newest)" },
        }),
        run: async (args) => {
            const page = args.page ?? 0;
            const pageSize = args.pageSize ?? 100;
            const parameters = new URLSearchParams({ page: String(page), pageSize: String(pageSize), order: args.order ?? "newest" });
            for (const name of ["workflowId", "appId", "state", "status", "killed"]) {
                if (args[name] !== undefined) parameters.set(name, String(args[name]));
            }
            const jobs = await (await anbaricClient()).get(`/jobs?${parameters}`) as Array<unknown>;
            return { page, pageSize, count: jobs.length, hasMore: jobs.length === pageSize, jobs };
        },
    },
    {
        name: "anbaric_job_get",
        description: "Fetch one job by id, including its state, properties and transition history.",
        inputSchema: object({ jobId: { type: "string" } }, ["jobId"]),
        run: async (args) => (await anbaricClient()).get(`/jobs/${encodeURIComponent(args.jobId)}`),
    },
    {
        name: "anbaric_jobs_stats",
        description: "Get job counts per state and the current queue size.",
        inputSchema: noInput,
        run: async () => {
            const client = await anbaricClient();
            const { states } = await client.get("/jobs/stats") as { states : unknown };
            const { size } = await client.get("/queue/size") as { size : number };
            return { states, queueSize: size };
        },
    },
    {
        name: "anbaric_job_create",
        description: "Create a job in a workflow at a start state with the given properties, and queue it for processing.",
        inputSchema: object({
            workflowId: { type: "string", description: "The state machine id to create the job in" },
            startState: { type: "string", description: "The state id the job starts in" },
            properties: { type: "object", description: "Initial job properties", additionalProperties: true },
        }, ["workflowId", "startState"]),
        run: async (args) => {
            const client = await anbaricClient();
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const appId = await resolveAppId(client, args.workflowId);
            await client.put(`/jobs/${encodeURIComponent(id)}`, {
                id,
                state: args.startState,
                properties: args.properties ?? {},
                workflowId: args.workflowId,
                appId,
                startedBy: await actorName(),
                startedAt: now,
                lastUpdated: now,
            });
            const queued = await enqueue(client, id, appId, args.workflowId);
            return { id, state: args.startState, workflowId: args.workflowId, queued };
        },
    },
    {
        name: "anbaric_job_update",
        description: "Merge properties into a job and re-queue it for processing.",
        inputSchema: object({
            jobId: { type: "string" },
            properties: { type: "object", description: "Properties to set (merged over existing)", additionalProperties: true },
        }, ["jobId", "properties"]),
        run: async (args) => {
            const client = await anbaricClient();
            const job = await client.get(`/jobs/${encodeURIComponent(args.jobId)}`);
            job.properties = { ...(job.properties ?? {}), ...args.properties };
            job.lastUpdated = new Date().toISOString();
            await client.put(`/jobs/${encodeURIComponent(args.jobId)}`, job);
            const queued = await enqueue(client, args.jobId, job.appId, job.workflowId);
            return { id: args.jobId, properties: job.properties, queued };
        },
    },
    {
        name: "anbaric_job_set_state",
        description: "Move a job to a state, record the transition and re-queue it for processing.",
        inputSchema: object({
            jobId: { type: "string" },
            state: { type: "string", description: "The state id to move the job to" },
        }, ["jobId", "state"]),
        run: async (args) => {
            const client = await anbaricClient();
            const job = await client.get(`/jobs/${encodeURIComponent(args.jobId)}`);
            const previousState = job.state;
            job.state = args.state;
            job.transitions = [...(job.transitions ?? []), { from: previousState, to: args.state, actor: await actorName() }];
            job.lastUpdated = new Date().toISOString();
            await client.put(`/jobs/${encodeURIComponent(args.jobId)}`, job);
            const queued = await enqueue(client, args.jobId, job.appId, job.workflowId);
            return { id: args.jobId, from: previousState, to: args.state, queued };
        },
    },
    {
        name: "anbaric_job_kill",
        description: "Kill a job so it stops progressing through its state machine.",
        inputSchema: object({ jobId: { type: "string" } }, ["jobId"]),
        run: async (args) => {
            await (await anbaricClient()).post(`/jobs/${encodeURIComponent(args.jobId)}/kill`, {});
            return { id: args.jobId, killed: true };
        },
    },
    {
        name: "anbaric_secrets_list",
        description: "List the names of the secrets a deployed app holds (API keys and other credentials it reads with SecretStoreFactory.instance().retrieve(name)). "
            + "Values are never returned - they can only be set or replaced.",
        inputSchema: object({ app: { type: "string", description: "The app name" } }, ["app"]),
        run: async (args) => (await anbaricClient()).get("/secrets", { "x-anbaric-app": args.app }),
    },
    {
        name: "anbaric_secret_set",
        description: "Set or replace a secret for a deployed app, so the app can read it with `secrets.retrieve(name)`. Use this to give a deployed app "
            + "a model API key or other credential: locally the app falls back to the environment (`openai-key` reads OPENAI_KEY), but a deployed app "
            + "only has what is set here. Ask the developer for the value rather than guessing it, and never echo it back.",
        inputSchema: object({
            app: { type: "string", description: "The app name" },
            name: { type: "string", description: "The secret's name, e.g. openai-key" },
            value: { type: "string", description: "The secret value" },
        }, ["app", "name", "value"]),
        run: async (args) => {
            await (await anbaricClient()).put(`/secrets/${encodeURIComponent(args.name)}`, { value: args.value }, { "x-anbaric-app": args.app });
            return { app: args.app, name: args.name, set: true };
        },
    },
    {
        name: "anbaric_secret_delete",
        description: "Remove a secret from a deployed app.",
        inputSchema: object({ app: { type: "string", description: "The app name" }, name: { type: "string" } }, ["app", "name"]),
        run: async (args) => {
            await (await anbaricClient()).delete(`/secrets/${encodeURIComponent(args.name)}`, { "x-anbaric-app": args.app });
            return { app: args.app, name: args.name, deleted: true };
        },
    },
];

export {tools};
export type {Tool};
