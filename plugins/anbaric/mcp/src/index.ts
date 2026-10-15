import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {server} from "./server";
import {tenantSkillTools} from "./skills";
import {tools} from "./tools";

// The platform's own tools, and then whatever skills the tenant has written.
const allTools = async () => [...tools, ...(await tenantSkillTools())];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await allTools()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = (await allTools()).find(candidate => candidate.name === request.params.name);
    if (!tool) throw new Error(`No such tool "${request.params.name}"`);

    try {
        const result = await tool.run(request.params.arguments ?? {});
        // A tool that already answers in prose is passed straight through;
        // stringifying it would hand back an escaped blob to read.
        const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
        return { content: [{ type: "text", text }] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
    }
});

const main = async () => {
    await server.connect(new StdioServerTransport());
};

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
