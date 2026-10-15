import {Server} from "@modelcontextprotocol/sdk/server/index.js";

/* The one server, in a module of its own so that a tool can reach it - the
   sign-in tool tells it the tool list has changed, since a tenant's skills
   only become visible once there is a tenant. */
const server = new Server(
    { name: "anbaric", version: "1.27.0" },
    { capabilities: { tools: { listChanged: true } } },
);

export { server };
