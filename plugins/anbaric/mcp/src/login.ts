import {randomUUID} from "node:crypto";
import {CliConfig, PRODUCTION_PLATFORM_URL, platformUrlForEnvironment} from "./platform/CliConfig";
import {KeyRequest} from "./platform/KeyRequest";
import {openBrowser} from "./platform/BrowserOpener";

const PING_TIMEOUT_MS = 1500;
const REACHABLE_ATTEMPTS = 10;
const REACHABLE_RETRY_MS = 3000;
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 300;
const POLL_INTERVAL_MS = 1000;

type LoginInput = {
    environment? : string,
    platformUrl? : string,
    tenant? : string,
    requestId? : string,
    waitSeconds? : number,
};

type LoginResult =
    | { status : "authorized", platformUrl : string, clientName : string, tenant? : string, tenantReachable? : boolean, next : string }
    | { status : "open", platformUrl : string, next : string }
    | { status : "pending", requestId : string, authorizeUrl : string, platformUrl : string, next : string };

/* The same browser handshake `anbaric login` runs, cut into calls an agent can
   make. The first call makes a key request, opens the browser to it and
   waits a little; if the person is still in the browser it answers pending
   with the request id, and calling again with that id picks the wait up
   where it left off rather than opening a second browser tab. A first-time
   sign-up subscribes and provisions an environment before the key is issued,
   so pending is the normal answer for a while. */
const pending = new Map<string, { id : string, request : KeyRequest, platformUrl : string, tenant? : string }>();

// Unlike the terminal, an agent cannot see that nothing answered, so a
// platform that does not respond is an error rather than one with no login.
const requiresAuthentication = async (platformUrl : string) : Promise<boolean> => {
    let response : Response;
    try {
        response = await fetch(`${platformUrl}/api/v2/whoami`, { redirect: "manual", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    } catch {
        throw new Error(`Nothing answered at ${platformUrl} - check the address, or that the platform is running`);
    }
    return response.status !== 404;
};

const pingTenant = async (platformUrl : string, tenant : string) : Promise<boolean> => {
    try {
        const response = await fetch(`${platformUrl}/ping`, { headers: { "x-anbaric-tenant": tenant }, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        const body = await response.json();
        return response.ok && body.tenant === tenant;
    } catch {
        return false;
    }
};

/* The key is issued the moment the browser finishes, which for a new tenant
   is a few seconds before the edge routes to it: the first ping after a
   sign-up tends to miss even though the browser already shows the console.
   So the question is asked for a while before the answer is taken as no. */
const tenantReachable = async (platformUrl : string, tenant : string) : Promise<boolean> => {
    for (let attempt = 1; attempt <= REACHABLE_ATTEMPTS; attempt++) {
        if (await pingTenant(platformUrl, tenant)) return true;
        if (attempt < REACHABLE_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, REACHABLE_RETRY_MS));
    }
    return false;
};

const pollOnce = async (request : KeyRequest) => {
    const response = await fetch(`${request.authorizeUrl}/poll`);
    return response.status === 200 ? await response.json() : undefined;
};

const login = async (input : LoginInput) : Promise<LoginResult> => {
    const waitMs = Math.min(Math.max(input.waitSeconds ?? DEFAULT_WAIT_S, 1), MAX_WAIT_S) * 1000;

    let held = input.requestId ? pending.get(input.requestId) : undefined;
    if (input.requestId && ! held) {
        throw new Error(`No sign-in in progress with id "${input.requestId}" - call anbaric_login without one to start again`);
    }

    if (! held) {
        const platformUrl = input.platformUrl ?? platformUrlForEnvironment(input.environment ?? "production");

        if (! await requiresAuthentication(platformUrl)) {
            const path = await CliConfig.save({ platformUrl, tenant: input.tenant });
            return { status: "open", platformUrl, next: `This platform has authentication disabled; ${platformUrl} is saved to ${path} and the other tools will use it.` };
        }

        const id = randomUUID();
        const request = new KeyRequest(platformUrl, id);
        held = { id, request, platformUrl, tenant: input.tenant };
        pending.set(id, held);
        openBrowser(request.authorizeUrl);
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        const issued = await pollOnce(held.request);
        if (issued) {
            pending.delete(held.id);
            const key = {
                platformUrl: held.platformUrl, keyId: issued.keyId, clientName: issued.clientName,
                publicKey: issued.publicKey, privateKey: issued.privateKey, tenant: issued.tenant,
            };
            await CliConfig.saveKey(key);
            const tenant = key.tenant ?? held.tenant;
            await CliConfig.save({ platformUrl: held.platformUrl, tenant });

            const reachable = tenant ? await tenantReachable(held.platformUrl, tenant) : undefined;
            return {
                status: "authorized", platformUrl: held.platformUrl, clientName: key.clientName, tenant, tenantReachable: reachable,
                next: reachable === false
                    ? `Signed in, but tenant "${tenant}" did not answer in the last half minute. If the browser shows it running it is still `
                        + `coming up - call anbaric_whoami again in a moment. If it was never set up, finish that at ${held.platformUrl}/subscribe.`
                    : "Signed in. The other anbaric_* tools now work against this platform and tenant.",
            };
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return {
        status: "pending",
        requestId: held.id,
        authorizeUrl: held.request.authorizeUrl,
        platformUrl: held.platformUrl,
        next: `The browser has been opened to ${held.request.authorizeUrl}; if it did not open, give the developer that link. `
            + `Ask them to sign in and, if this is their first time, choose "Build apps" and finish setting up their environment. `
            + `Then call anbaric_login again with requestId "${held.id}" to pick up the wait.`,
    };
};

export { login, PRODUCTION_PLATFORM_URL };
export type { LoginInput, LoginResult };
