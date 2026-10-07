export async function POST(request) {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("multipart/form-data")) {
    return Response.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const upstream = await fetch("https://pump.fun/api/ipfs", {
    method: "POST",
    headers: { "content-type": contentType },
    body: await request.arrayBuffer(),
  });
  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}
