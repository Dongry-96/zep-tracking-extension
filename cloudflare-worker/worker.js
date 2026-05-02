export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && !url.searchParams.get("action")) {
      return new Response("success", {
        status: 200,
        headers: responseHeaders_("text/plain; charset=utf-8"),
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders_() });
    }

    if (!env.APPS_SCRIPT_URL) {
      return new Response("APPS_SCRIPT_URL is not configured.", {
        status: 500,
        headers: responseHeaders_("text/plain; charset=utf-8"),
      });
    }

    const target = new URL(env.APPS_SCRIPT_URL);
    url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

    if (request.method === "GET") {
      const response = await fetch(target.toString());
      const text = await response.text();
      const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
      return new Response(text, {
        status: response.ok ? 200 : response.status,
        headers: responseHeaders_(contentType),
      });
    }

    if (request.method !== "POST") {
      return new Response("success", {
        status: 200,
        headers: responseHeaders_("text/plain; charset=utf-8"),
      });
    }

    const body = await request.text();

    const forwardRequest = fetch(target.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    if (url.searchParams.get("action")) {
      const response = await forwardRequest;
      const text = await response.text();
      const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
      return new Response(text, {
        status: response.ok ? 200 : response.status,
        headers: responseHeaders_(contentType),
      });
    } else {
      ctx.waitUntil(forwardRequest.catch(error => {
        console.error("Failed to forward ZEP webhook", error);
      }));
    }

    return new Response("success", {
      status: 200,
      headers: responseHeaders_("text/plain; charset=utf-8"),
    });
  },
};

function responseHeaders_(contentType = "text/plain; charset=utf-8") {
  return {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
